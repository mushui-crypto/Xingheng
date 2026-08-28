import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitrageExecutionDraftService } from "./ArbitrageExecutionDraftService";
import {
  openingSetupSourcePlanId,
  type ArbitrageOpeningSetup,
} from "./ArbitrageOpeningSetup";

type InstanceSource = Pick<ArbitrageInstanceStore, "get" | "readUnstartedOpeningSetup">;
type DraftSource = Pick<ArbitrageExecutionDraftService, "preview">;

export class ArbitrageUnstartedResumeError extends Error {
  constructor(
    readonly category: "arbitrage_instance_not_found" | "arbitrage_resume_not_available" | "arbitrage_instance_mismatch",
    message: string,
  ) {
    super(message);
  }
}

export class ArbitrageUnstartedResumeService {
  constructor(
    private readonly instances: InstanceSource,
    private readonly drafts: DraftSource,
  ) {}

  async load(authenticatedUserId: string, arbitrageIdInput: string) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const arbitrageId = identifier(arbitrageIdInput, "arbitrageId");
    const instance = this.instances.get(userId, arbitrageId);
    if (!instance) {
      throw new ArbitrageUnstartedResumeError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    }
    const setup = this.instances.readUnstartedOpeningSetup(userId, arbitrageId);
    if (!setup) {
      throw new ArbitrageUnstartedResumeError(
        "arbitrage_resume_not_available",
        "该实例已存在执行事实，或缺少可验证的原始建仓设置，不能恢复未开始流程。",
      );
    }
    const draft = await this.drafts.preview(userId, setup);
    assertDraftMatchesInstance(userId, instance, setup, draft);
    return Object.freeze({ instance, setup, draft });
  }
}

function assertDraftMatchesInstance(
  userId: string,
  instance: ArbitrageInstance,
  setup: ArbitrageOpeningSetup,
  draft: Awaited<ReturnType<ArbitrageExecutionDraftService["preview"]>>,
) {
  const matches = instance.userId === userId
    && instance.sourcePlanId === openingSetupSourcePlanId(setup)
    && draft.opportunityId === setup.opportunityId
    && draft.horizonDays === setup.horizonDays
    && draft.executionMode === setup.executionMode
    && sameQuantityInput(draft.quantityInput, setup.quantityInput)
    && draft.strategyType === instance.strategyType
    && draft.legs.length === instance.legs.length
    && draft.legs.every((draftLeg) => instance.legs.some((leg) => leg.legId === draftLeg.legId
      && leg.role === draftLeg.role
      && draftLeg.side === (leg.role === "LONG" ? "buy" : "sell")
      && leg.venue === draftLeg.venue
      && leg.instrumentId === draftLeg.instrumentId));
  if (!matches) {
    throw new ArbitrageUnstartedResumeError(
      "arbitrage_instance_mismatch",
      "当前权威草案与原套利实例的腿身份不一致。",
    );
  }
}

function sameQuantityInput(
  current: ArbitrageOpeningSetup["quantityInput"] | undefined,
  original: ArbitrageOpeningSetup["quantityInput"],
) {
  if (!current || current.mode !== original.mode) return false;
  return current.mode === "NOTIONAL_USDT" && original.mode === "NOTIONAL_USDT"
    ? current.amountUsdt === original.amountUsdt
    : current.mode === "ASSET_QUANTITY" && original.mode === "ASSET_QUANTITY"
      && current.quantity === original.quantity;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw new ArbitrageUnstartedResumeError("arbitrage_resume_not_available", `${name} 无效。`);
  }
  return value.trim();
}
