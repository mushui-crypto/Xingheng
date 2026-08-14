import { createHash } from "node:crypto";
import {
  compareUnsignedDecimals,
  managedCurrentQuantity,
  type ArbitrageExecutionReference,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { ExecutionQuantityPlanner } from "../cex/ExecutionQuantityPlanner";
import type { ArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";
import type {
  ArbitrageLegExecutionConfirmation,
  FormalArbitrageExecutionRuntime,
  FormalArbitrageExecutionRuntimeResult,
} from "./ArbitrageExecutionCommandService";

type InstanceStore = Pick<
  ArbitrageInstanceStore,
  "get" | "claimExecutionReference" | "linkExecutionRecord" | "applyExecutionResult"
>;
type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;

export class ArbitrageExecutionCloseError extends Error {
  constructor(
    readonly category:
      | "invalid_close_confirmation"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "close_capability_unavailable"
      | "spot_close_not_yet_wired"
      | "position_verification_unavailable"
      | "close_quantity_unavailable"
      | "execution_state_unknown",
    message: string,
  ) {
    super(message);
  }
}

export class ArbitrageExecutionCloseService {
  constructor(
    private readonly instances: InstanceStore,
    private readonly positions: PositionVerifier,
    private readonly planningContexts: ArbitrageExecutionPlanningContextSource,
    private readonly runtime: FormalArbitrageExecutionRuntime,
    private readonly options: Readonly<{
      clock?: () => number;
      createIntentId?: (userId: string, arbitrageId: string, legId: string, commandId: string) => string;
      intentTtlMs?: number;
    }> = {},
  ) {}

  async closeLeg(authenticatedUserId: string, input: unknown): Promise<ArbitrageLegExecutionConfirmation> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseCloseRequest(input);
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw closeError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw closeError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");

    const intentId = this.options.createIntentId?.(userId, instance.arbitrageId, leg.legId, request.commandId)
      ?? deterministicId("close-intent", userId, instance.arbitrageId, leg.legId, request.commandId);
    const replay = instance.executionReferences.find((reference) => reference.executionIntentId === intentId);
    if (replay) return closeResult(instance, replay, true);

    assertCloseCapability(instance, leg);
    assertNoUnresolvedClose(instance, leg.legId);
    const managedQuantity = managedCurrentQuantity(leg);
    if (managedQuantity === "0") throw closeError("close_quantity_unavailable", "该套利腿当前没有可退出的管理数量。");

    const verification = await this.positions.verify(userId, instance.arbitrageId);
    const verifiedLeg = verification?.legs.find((candidate) => candidate.legId === leg.legId);
    if (!verifiedLeg || verifiedLeg.verificationStatus !== "MATCHED" || verifiedLeg.actualQuantity === null) {
      throw closeError("position_verification_unavailable", "当前真实仓位无法可靠确认，不能提交退出。");
    }
    if (verifiedLeg.expectedManagedQuantity !== managedQuantity || verifiedLeg.actualQuantity === "0") {
      throw closeError("position_verification_unavailable", "当前真实仓位与套利实例管理数量不一致。");
    }
    if (compareUnsignedDecimals(request.quantity, managedQuantity) > 0
      || compareUnsignedDecimals(request.quantity, verifiedLeg.actualQuantity) > 0) {
      throw closeError("close_quantity_unavailable", "退出数量不能超过当前可减少的真实仓位。");
    }

    const context = await loadContext(this.planningContexts, leg.venue, leg.instrumentId);
    if (context.instrument.marketType !== "perpetual"
      || context.instrument.contractType !== "linear_perpetual"
      || context.instrument.quoteAsset !== "USDT"
      || context.instrument.settlementAsset !== "USDT") {
      throw closeError("close_capability_unavailable", "当前只支持 USDT 线性永续套利腿退出。");
    }
    const side = leg.role === "LONG" ? "sell" as const : "buy" as const;
    const now = this.now();
    const planner = new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === leg.instrumentId ? context.instrument : null },
      { getTradingRules: async () => context.tradingRules },
      { now: () => now },
    );
    const planned = await planner.plan({
      instrumentId: leg.instrumentId,
      side,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: request.quantity },
      quote: context.quote,
    });
    if (!planned.ok || planned.plan.plannedAssetQuantity.quantity !== request.quantity) {
      throw closeError("close_quantity_unavailable", "退出数量不符合当前交易规则。");
    }

    const intent = createExecutionIntent({
      intentId,
      arbitrageId: instance.arbitrageId,
      legId: leg.legId,
      userId,
      venue: leg.venue,
      accountId: leg.accountId,
      instrumentId: leg.instrumentId,
      side,
      quantity: planned.plan.plannedAssetQuantity,
      orderConstraints: { reduceOnly: true },
      executionMode: request.executionMode,
      createdAt: now,
      expiresAt: now + (this.options.intentTtlMs ?? 30_000),
    });
    try {
      this.instances.claimExecutionReference(userId, instance.arbitrageId, {
        legId: leg.legId,
        phase: "CLOSING",
        quantityEffect: "DECREASE",
        executionIntentId: intent.intentId,
        requestedQuantity: intent.quantity.quantity,
        createdAt: now,
      });
    } catch (error) {
      const raced = this.instances.get(userId, instance.arbitrageId);
      const reference = raced?.executionReferences.find((candidate) => candidate.executionIntentId === intent.intentId);
      if (!raced || !reference) throw error;
      return closeResult(raced, reference, true);
    }

    let runtimeResult: FormalArbitrageExecutionRuntimeResult;
    try {
      runtimeResult = await this.runtime.execute(intent);
    } catch {
      throw closeError("execution_state_unknown", "退出状态暂时无法确认；执行引用已保留，请勿重复提交。");
    }
    assertRuntimeIdentity(runtimeResult.executionRecord, intent);
    this.instances.linkExecutionRecord(
      userId,
      instance.arbitrageId,
      intent.intentId,
      runtimeResult.executionRecord.executionId,
      runtimeResult.executionRecord.updatedAt,
    );
    const linked = this.instances.get(userId, instance.arbitrageId);
    const linkedReference = linked?.executionReferences.find((candidate) => candidate.executionIntentId === intent.intentId);
    if (!linkedReference) throw closeError("execution_state_unknown", "退出执行引用状态暂时无法确认。");
    const attributableStatus = runtimeResult.confirmedQuantity === null
      ? "UNKNOWN" as const
      : referenceStatus(runtimeResult.executionRecord.status);
    const updated = this.instances.applyExecutionResult(userId, instance.arbitrageId, {
      executionIntentId: intent.intentId,
      status: attributableStatus,
      confirmedQuantity: runtimeResult.confirmedQuantity ?? linkedReference.confirmedQuantity,
      updatedAt: runtimeResult.executionRecord.updatedAt,
    });
    const reference = updated.executionReferences.find((candidate) => candidate.executionIntentId === intent.intentId)!;
    return closeResult(updated, reference, false, attributableStatus);
  }

  private now() {
    const value = this.options.clock?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Close execution clock is invalid.");
    return value;
  }
}

type CloseRequest = Readonly<{
  arbitrageId: string;
  legId: string;
  commandId: string;
  quantity: string;
  executionMode: ExecutionIntent["executionMode"];
  confirmed: true;
}>;

function parseCloseRequest(input: unknown): CloseRequest {
  const value = object(input);
  exactKeys(value, ["arbitrageId", "legId", "commandId", "quantity", "executionMode", "confirmed"]);
  if (value.confirmed !== true) throw closeError("invalid_close_confirmation", "需要用户明确确认退出。");
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw closeError("invalid_close_confirmation", "executionMode 无效。");
  }
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    commandId: identifier(value.commandId, "commandId"),
    quantity: decimal(value.quantity, "quantity"),
    executionMode: value.executionMode,
    confirmed: true,
  });
}

function assertCloseCapability(instance: ArbitrageInstance, leg: ArbitrageInstance["legs"][number]) {
  if (instance.status === "CLOSED" || instance.status === "FAILED") {
    throw closeError("close_capability_unavailable", "已结束的套利实例不能再次退出。");
  }
  if (leg.venue !== "binance") {
    throw closeError("close_capability_unavailable", "该交易所尚未接入正式退出能力。");
  }
  if (!leg.instrumentId.endsWith("-PERP")) {
    throw closeError("spot_close_not_yet_wired", "现货套利腿退出能力尚未接入。");
  }
}

function assertNoUnresolvedClose(instance: ArbitrageInstance, legId: string) {
  const unresolved = instance.executionReferences.some((reference) => reference.legId === legId
    && reference.phase === "CLOSING"
    && (reference.status === "CLAIMED" || reference.status === "LINKED"
      || reference.status === "PENDING_CONFIRMATION" || reference.status === "UNKNOWN"));
  if (unresolved) throw closeError("execution_state_unknown", "该套利腿已有未完成的退出执行，请先重新核验。");
}

async function loadContext(
  source: ArbitrageExecutionPlanningContextSource,
  venue: ArbitrageInstance["legs"][number]["venue"],
  instrumentId: string,
) {
  try {
    return await source.load(venue, instrumentId);
  } catch {
    throw closeError("close_capability_unavailable", "当前交易品种或交易规则不可用。");
  }
}

function closeResult(
  instance: ArbitrageInstance,
  reference: ArbitrageExecutionReference,
  idempotentReplay: boolean,
  recordStatus?: ExecutionRecord["status"],
): ArbitrageLegExecutionConfirmation {
  return Object.freeze({
    instance,
    executionRecord: Object.freeze({
      executionId: reference.executionRecordId,
      intentId: reference.executionIntentId,
      status: recordStatus ?? recordStatusFromReference(reference.status),
      plannedQuantity: reference.requestedQuantity,
      confirmedQuantity: reference.confirmedQuantity,
      verifiedAt: reference.updatedAt,
    }),
    idempotentReplay,
    secondLegAllowed: false,
  });
}

function referenceStatus(status: ExecutionRecord["status"]) {
  if (status === "CONFIRMED" || status === "FAILED" || status === "UNKNOWN" || status === "PENDING_CONFIRMATION") return status;
  return "PENDING_CONFIRMATION" as const;
}

function recordStatusFromReference(status: ArbitrageExecutionReference["status"]): ExecutionRecord["status"] | "CREATED" {
  if (status === "CLAIMED" || status === "LINKED") return "UNKNOWN";
  return status;
}

function assertRuntimeIdentity(record: ExecutionRecord, intent: ExecutionIntent) {
  if (record.intentId !== intent.intentId || record.userId !== intent.userId
    || record.accountId !== intent.accountId || record.venue !== intent.venue
    || record.instrumentId !== intent.instrumentId) {
    throw closeError("execution_state_unknown", "退出执行记录身份与执行意图不一致。");
  }
}

function deterministicId(prefix: string, ...parts: string[]) {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw closeError("invalid_close_confirmation", "退出确认必须为对象。");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw closeError("invalid_close_confirmation", `请求包含不允许的字段：${unknown}。`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw closeError("invalid_close_confirmation", `请求缺少字段：${missing}。`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw closeError("invalid_close_confirmation", `${name} 无效。`);
  }
  return value.trim();
}

function decimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw closeError("invalid_close_confirmation", `${name} 必须为正十进制字符串。`);
  }
  return value;
}

function closeError(category: ArbitrageExecutionCloseError["category"], message: string) {
  return new ArbitrageExecutionCloseError(category, message);
}
