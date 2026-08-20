import { createHash, randomUUID } from "node:crypto";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { absoluteDifference, compareUnsignedDecimals } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { createAssetQuantity } from "../cex/AssetQuantity";
import { createExecutionCanonicalAssetSource } from "../cex/CanonicalAssetSource";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordRecoveryStore } from "../cex/ExecutionRecordStore";
import { ExecutionQuantityPlanner } from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type { ArbitrageExecutionDraft, ArbitrageExecutionDraftLeg } from "./ArbitrageExecutionDraft";
import type { ArbitrageExecutionDraftService } from "./ArbitrageExecutionDraftService";
import type { ArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";
import type {
  FormalExecutionDiagnostic,
  FormalExecutionRuntime,
  FormalExecutionRuntimeResult,
} from "./FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistryError,
  type FormalExecutionRuntimeResolver,
} from "./FormalExecutionRuntimeRegistry";

type DraftService = Pick<ArbitrageExecutionDraftService, "createDraft" | "preview">;
type InstanceStore = Pick<
  ArbitrageInstanceStore,
  "create" | "get" | "claimExecutionReference" | "linkExecutionRecord" | "applyExecutionResult"
  | "prepareSecondLegHedge" | "readPreparedSecondLegHedge" | "failEmptyOpening"
>;
type CredentialSummaries = Pick<UserExchangeCredentialStore, "findSummary">;
type SpotAttributionSources = Partial<Record<ExecutionIntent["venue"], SpotOpeningAttributionSource>>;
type PlannedDraftLeg = ArbitrageExecutionDraftLeg & Readonly<{
  planning: Extract<ArbitrageExecutionDraftLeg["planning"], { status: "PLANNED" }>;
}>;
const canonicalAssets = createExecutionCanonicalAssetSource();

export type ArbitrageExecutionConfirmation = Readonly<{
  instance: ArbitrageInstance;
  created: boolean;
}>;

export type ArbitrageLegExecutionConfirmation = Readonly<{
  instance: ArbitrageInstance;
  executionRecord: Readonly<{
    executionId: string | null;
    intentId: string;
    status: ExecutionRecord["status"] | "CREATED";
    plannedQuantity: string;
    confirmedQuantity: string;
    verifiedAt: number;
  }>;
  diagnostic?: FormalExecutionDiagnostic;
  idempotentReplay: boolean;
  secondLegAllowed: boolean;
}>;

export class ArbitrageExecutionCommandError extends Error {
  constructor(
    readonly category:
      | "invalid_execution_confirmation"
      | "execution_capability_unavailable"
      | "arbitrage_instance_not_found"
      | "arbitrage_instance_mismatch"
      | "arbitrage_leg_not_found"
      | "arbitrage_execution_reference_not_found"
      | "execution_recovery_record_not_found"
      | "execution_recovery_identity_conflict"
      | "second_leg_not_allowed"
      | "execution_state_unknown"
      | "manual_reconciliation_required",
    message: string,
    readonly manualReconciliation?: Readonly<{
      manualReconciliationRequired: true;
      idempotencyKey: string;
      reason: string;
    }>,
  ) {
    super(message);
  }
}

export class ArbitrageExecutionCommandService {
  private readonly reconciliationInFlight = new Map<string, Promise<ArbitrageLegExecutionConfirmation>>();

  constructor(
    private readonly drafts: DraftService,
    private readonly instances: InstanceStore,
    private readonly credentials: CredentialSummaries,
    private readonly executionRecords: ExecutionRecordRecoveryStore,
    private readonly runtimes: FormalExecutionRuntimeResolver,
    private readonly hedgePlanning: Readonly<{
      contexts: ArbitrageExecutionPlanningContextSource;
      spotAttributions: SpotAttributionSources;
    }>,
    private readonly options: Readonly<{
      clock?: () => number;
      createArbitrageId?: (userId: string, confirmationId: string) => string;
      createIntentId?: (userId: string, arbitrageId: string, legId: string, commandId: string) => string;
      intentTtlMs?: number;
    }> = {},
  ) {}

  async confirm(authenticatedUserId: string, input: unknown): Promise<ArbitrageExecutionConfirmation> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseFinalConfirmation(input);
    const draft = await this.revalidateDraft(userId, request);
    const accounts = this.resolveAccounts(userId, draft);
    const arbitrageId = this.options.createArbitrageId?.(userId, request.confirmationId)
      ?? deterministicId("arbitrage", userId, request.confirmationId);
    const sourcePlanId = sourcePlanIdentity(request);
    const existing = this.instances.get(userId, arbitrageId);
    if (existing) {
      assertInstanceMatches(existing, draft, accounts, sourcePlanId);
      return Object.freeze({ instance: existing, created: false });
    }

    const planned = plannedLegs(draft);
    const createdAt = this.now();
    let instance: ArbitrageInstance;
    try {
      instance = this.instances.create({
        arbitrageId,
        userId,
        strategyType: draft.strategyType,
        sourcePlanId,
        maxResidualBaseQuantity: absoluteDifference(
          planned[0].plan.plannedAssetQuantity.quantity,
          planned[1].plan.plannedAssetQuantity.quantity,
        ),
        createdAt,
        legs: [
          newInstanceLeg(planned[0].leg, planned[0].plan.plannedAssetQuantity.quantity, accounts),
          newInstanceLeg(planned[1].leg, planned[1].plan.plannedAssetQuantity.quantity, accounts),
        ],
      });
    } catch (error) {
      const raced = this.instances.get(userId, arbitrageId);
      if (!raced) throw error;
      assertInstanceMatches(raced, draft, accounts, sourcePlanId);
      return Object.freeze({ instance: raced, created: false });
    }
    return Object.freeze({ instance, created: true });
  }

  async executeLeg(authenticatedUserId: string, input: unknown): Promise<ArbitrageLegExecutionConfirmation> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseLegConfirmation(input);
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw commandError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const selected = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!selected) throw commandError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");

    const intentId = this.options.createIntentId?.(userId, request.arbitrageId, request.legId, request.commandId)
      ?? deterministicId("intent", userId, request.arbitrageId, request.legId, request.commandId);
    const existingReference = instance.executionReferences.find((reference) => reference.executionIntentId === intentId);
    if (existingReference) return resultFromReference(instance, existingReference, true);

    const confirmedFirstLeg = assertLegCanExecute(instance, request.legId);
    let draft: ArbitrageExecutionDraft;
    try {
      draft = confirmedFirstLeg === null
        ? await this.revalidateDraft(userId, request)
        : await this.revalidateSecondLegDraft(userId, request);
    } catch (error) {
      if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
      throw error;
    }
    let accounts: ReadonlyMap<string, string>;
    try {
      accounts = this.resolveAccounts(userId, draft);
    } catch (error) {
      if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
      throw error;
    }
    let draftLeg: ArbitrageExecutionDraftLeg;
    let accountId: string;
    try {
      assertInstanceMatches(
        instance,
        draft,
        accounts,
        sourcePlanIdentity(request),
        confirmedFirstLeg === null,
      );
      const selectedDraftLeg = draft.legs.find((candidate) => candidate.legId === request.legId);
      if (!selectedDraftLeg || (confirmedFirstLeg === null && selectedDraftLeg.planning.status !== "PLANNED")) {
        throw commandError("arbitrage_instance_mismatch", "当前权威草案无法重新解析所选套利腿。");
      }
      const selectedAccountId = accounts.get(selectedDraftLeg.legId);
      if (!selectedAccountId || selectedAccountId !== selected.accountId) {
        throw commandError("arbitrage_instance_mismatch", "当前执行账户与套利实例绑定不一致。");
      }
      draftLeg = selectedDraftLeg;
      accountId = selectedAccountId;
      if (confirmedFirstLeg === null && draft.quantityInput?.mode === "NOTIONAL_USDT"
        && compareUnsignedDecimals(
          (draftLeg as PlannedDraftLeg).planning.plan.estimatedNotionalUsdt,
          draft.quantityInput.amountUsdt,
        ) > 0) {
        throw commandError("execution_capability_unavailable", "当前合法化数量将超过用户确认的名义金额预算。");
      }
    } catch (error) {
      if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
      throw error;
    }

    const preparedHedge = confirmedFirstLeg === null
      ? null
      : this.instances.readPreparedSecondLegHedge(
        userId,
        instance.arbitrageId,
        confirmedFirstLeg.executionIntentId,
        selected.legId,
      );
    const hedge = confirmedFirstLeg === null
      ? null
      : preparedHedge
        ? restorePreparedHedge(selected.instrumentId, preparedHedge)
        : await this.planSecondLegQuantity(userId, instance, selected, draft, draftLeg, confirmedFirstLeg);
    const quantity = hedge?.quantity ?? (draftLeg as PlannedDraftLeg).planning.plan.plannedAssetQuantity;
    let now: number;
    try {
      now = confirmedFirstLeg === null ? this.now() : nextTimestamp(this.now(), instance.updatedAt);
    } catch (error) {
      if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
      throw error;
    }
    if (hedge !== null && preparedHedge === null) {
      this.instances.prepareSecondLegHedge(userId, instance.arbitrageId, {
        firstExecutionIntentId: confirmedFirstLeg!.executionIntentId,
        secondLegId: selected.legId,
        targetBaseQuantity: hedge.targetBaseQuantity,
        executableBaseQuantity: quantity.quantity,
        updatedAt: now,
      });
    }
    let intent: ExecutionIntent;
    try {
      intent = createExecutionIntent({
        intentId,
        arbitrageId: instance.arbitrageId,
        legId: selected.legId,
        userId,
        venue: selected.venue,
        accountId,
        instrumentId: selected.instrumentId,
        side: draftLeg.side,
        quantity,
        orderConstraints: { reduceOnly: false },
        executionMode: request.executionMode,
        createdAt: now,
        expiresAt: now + (this.options.intentTtlMs ?? 30_000),
      });
    } catch (error) {
      if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
      throw error;
    }
    let runtime: FormalExecutionRuntime;
    try {
      runtime = this.resolveRuntime(intent.venue);
    } catch (error) {
      if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
      throw error;
    }
    try {
      this.instances.claimExecutionReference(userId, instance.arbitrageId, {
        legId: selected.legId,
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: intent.intentId,
        requestedQuantity: intent.quantity.quantity,
        createdAt: now,
      });
    } catch (error) {
      const raced = this.instances.get(userId, instance.arbitrageId);
      const reference = raced?.executionReferences.find((candidate) => candidate.executionIntentId === intent.intentId);
      if (!raced || !reference) {
        if (confirmedFirstLeg === null) this.failEmptyOpeningIfSafe(userId, instance.arbitrageId);
        throw error;
      }
      return resultFromReference(raced, reference, true);
    }

    let runtimeResult: FormalExecutionRuntimeResult;
    try {
      runtimeResult = await runtime.execute(intent);
    } catch (error) {
      if (error instanceof ManualReconciliationRequiredError) {
        throw manualReconciliationCommandError(error);
      }
      throw commandError(
        "execution_state_unknown",
        "执行状态暂时无法确认；套利实例和执行引用已保留，请勿重复提交。",
      );
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
    const linkedReference = linked?.executionReferences.find(
      (candidate) => candidate.executionIntentId === intent.intentId,
    );
    if (!linkedReference) {
      throw commandError("execution_state_unknown", "执行引用状态暂时无法确认，请勿重复提交。");
    }
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
    return resultFromReference(updated, reference, false, attributableStatus, runtimeResult.diagnostic);
  }

  async reconcileLeg(authenticatedUserId: string, input: unknown): Promise<ArbitrageLegExecutionConfirmation> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseReconciliationRequest(input);
    const key = `${userId}\u0000${request.arbitrageId}\u0000${request.legId}`;
    const existing = this.reconciliationInFlight.get(key);
    if (existing) return existing;
    const operation = this.reconcileLegOnce(userId, request);
    this.reconciliationInFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.reconciliationInFlight.get(key) === operation) this.reconciliationInFlight.delete(key);
    }
  }

  private async reconcileLegOnce(
    userId: string,
    request: Readonly<{ arbitrageId: string; legId: string }>,
  ): Promise<ArbitrageLegExecutionConfirmation> {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw commandError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw commandError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");
    const runtime = this.resolveRuntime(leg.venue);
    const references = instance.executionReferences.filter((reference) => reference.legId === request.legId);
    const reconcilable = references.filter((reference) => reference.status === "CLAIMED"
      || reference.status === "LINKED"
      || reference.status === "PENDING_CONFIRMATION"
      || reference.status === "UNKNOWN");
    const candidates = reconcilable.length > 0 ? reconcilable : references;
    if (candidates.length !== 1) {
      throw commandError("arbitrage_execution_reference_not_found", "该套利腿不存在唯一可核验的执行引用。");
    }
    let currentInstance = instance;
    let reference = candidates[0]!;
    if (!reference.executionRecordId) {
      const recovered = await this.recoverExecutionReference(userId, instance, leg, reference);
      currentInstance = recovered.instance;
      reference = recovered.reference;
    }
    if (reference.status === "CONFIRMED" || reference.status === "FAILED") {
      return resultFromReference(currentInstance, reference, true);
    }
    if (reference.status !== "LINKED"
      && reference.status !== "PENDING_CONFIRMATION"
      && reference.status !== "UNKNOWN") {
      throw commandError("execution_state_unknown", "该套利腿当前尚不能进行远端核验。");
    }
    const executionRecordId = reference.executionRecordId;
    if (!executionRecordId) {
      throw commandError("execution_state_unknown", "执行记录关联恢复结果不可用。");
    }

    let runtimeResult: FormalExecutionRuntimeResult;
    try {
      runtimeResult = await runtime.reconcile(userId, executionRecordId);
    } catch (error) {
      if (error instanceof ManualReconciliationRequiredError) {
        throw manualReconciliationCommandError(error);
      }
      throw commandError("execution_state_unknown", "执行状态核验暂不可用；未提交任何新订单。");
    }
    assertReconciliationIdentity(runtimeResult.executionRecord, userId, leg, reference);
    const attributableStatus = runtimeResult.confirmedQuantity === null
      ? "UNKNOWN" as const
      : referenceStatus(runtimeResult.executionRecord.status);
    const updated = this.instances.applyExecutionResult(userId, currentInstance.arbitrageId, {
      executionIntentId: reference.executionIntentId,
      status: attributableStatus,
      confirmedQuantity: runtimeResult.confirmedQuantity ?? reference.confirmedQuantity,
      updatedAt: runtimeResult.executionRecord.updatedAt,
    });
    const updatedReference = updated.executionReferences.find(
      (candidate) => candidate.executionIntentId === reference.executionIntentId,
    )!;
    return resultFromReference(updated, updatedReference, false, attributableStatus);
  }

  private async recoverExecutionReference(
    userId: string,
    instance: ArbitrageInstance,
    leg: ArbitrageInstance["legs"][number],
    reference: ArbitrageInstance["executionReferences"][number],
  ) {
    let records: readonly ExecutionRecord[];
    try {
      records = await this.executionRecords.findByIntentId(reference.executionIntentId);
    } catch {
      throw commandError("execution_state_unknown", "本地执行记录恢复暂不可用；未提交任何新订单。");
    }
    if (records.length === 0) {
      throw commandError(
        "execution_recovery_record_not_found",
        "未找到该执行引用对应的本地执行记录；未提交任何新订单。",
      );
    }
    if (records.length !== 1) {
      throw commandError(
        "execution_recovery_identity_conflict",
        "同一执行意图存在多条本地执行记录，无法安全恢复关联。",
      );
    }
    const record = records[0]!;
    assertRecoveryIdentity(record, userId, leg, reference);
    const linked = this.instances.linkExecutionRecord(
      userId,
      instance.arbitrageId,
      reference.executionIntentId,
      record.executionId,
      record.updatedAt,
    );
    const linkedReference = linked.executionReferences.find(
      (candidate) => candidate.executionIntentId === reference.executionIntentId,
    );
    if (!linkedReference || linkedReference.executionRecordId !== record.executionId) {
      throw commandError("execution_recovery_identity_conflict", "执行记录关联恢复结果不一致。");
    }
    return Object.freeze({ instance: linked, reference: linkedReference });
  }

  private async revalidateDraft(
    userId: string,
    request: Pick<FinalConfirmationRequest, "opportunityId" | "horizonDays" | "quantityInput">,
  ) {
    const draft = await this.drafts.preview(userId, {
      opportunityId: request.opportunityId,
      horizonDays: request.horizonDays,
      quantityInput: request.quantityInput,
    });
    if (!draft.allLegsExecutable || draft.legs.some((leg) => leg.planning.status !== "PLANNED")) {
      throw commandError(
        "execution_capability_unavailable",
        "两条腿当前未同时满足执行能力和数量规划条件，不能创建或继续执行套利。",
      );
    }
    return draft;
  }

  private async revalidateSecondLegDraft(
    userId: string,
    request: Pick<FinalConfirmationRequest, "opportunityId" | "horizonDays">,
  ) {
    const draft = await this.drafts.createDraft(userId, {
      opportunityId: request.opportunityId,
      horizonDays: request.horizonDays,
    });
    if (draft.legs.some((leg) => leg.capability.status !== "AVAILABLE" || leg.providerSymbol === null)) {
      throw commandError(
        "execution_capability_unavailable",
        "两条腿当前未同时满足执行能力和交易品种条件，不能继续执行套利。",
      );
    }
    return draft;
  }

  private resolveAccounts(userId: string, draft: ArbitrageExecutionDraft) {
    const accounts = new Map<string, string>();
    for (const leg of draft.legs) {
      const summary = this.credentials.findSummary(userId, leg.venue);
      if (!summary) throw commandError("execution_capability_unavailable", "交易所执行账户当前不可用。");
      accounts.set(leg.legId, summary.accountId);
    }
    return accounts;
  }

  private resolveRuntime(venue: ExecutionIntent["venue"]) {
    try {
      return this.runtimes.resolve(venue);
    } catch (error) {
      if (error instanceof FormalExecutionRuntimeRegistryError
        && error.category === "runtime_not_registered") {
        throw commandError("execution_capability_unavailable", "该交易所尚未接入正式执行能力。");
      }
      throw error;
    }
  }

  private failEmptyOpeningIfSafe(userId: string, arbitrageId: string) {
    // No execution reference means no intent/recovery anchor can be linked to this instance.
    // The store rechecks references and managed exposure atomically before marking FAILED.
    try {
      this.instances.failEmptyOpening(userId, arbitrageId, this.now());
    } catch {
      // Preserve the original command error; cleanup is a best-effort lifecycle repair.
    }
  }

  private async planSecondLegQuantity(
    userId: string,
    instance: ArbitrageInstance,
    selected: ArbitrageInstance["legs"][number],
    draft: ArbitrageExecutionDraft,
    draftLeg: ArbitrageExecutionDraftLeg,
    firstReference: ArbitrageInstance["executionReferences"][number],
  ) {
    const firstLeg = instance.legs.find((candidate) => candidate.legId === firstReference.legId);
    const firstDraftLeg = draft.legs.find((candidate) => candidate.legId === firstReference.legId);
    if (!firstLeg || !firstDraftLeg) {
      throw commandError("arbitrage_instance_mismatch", "第一腿执行事实无法映射到当前套利实例。");
    }
    const firstInstrument = canonicalInstrumentFromId(firstLeg.instrumentId);
    const targetBaseQuantity = firstDraftLeg.marketType === "spot"
      ? await this.readSpotExposure(userId, firstLeg, firstDraftLeg, firstInstrument.baseAsset, firstReference)
      : firstReference.confirmedQuantity;
    const context = await this.hedgePlanning.contexts.load(selected.venue, selected.instrumentId);
    if (context.instrument.instrumentId !== selected.instrumentId
      || context.instrument.providerSymbol !== draftLeg.providerSymbol
      || context.instrument.baseAsset.symbol !== firstInstrument.baseAsset) {
      throw commandError("arbitrage_instance_mismatch", "第二腿交易品种与第一腿实际敞口不一致。");
    }
    const planner = new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === selected.instrumentId ? context.instrument : null },
      { getTradingRules: async () => context.tradingRules },
      { now: () => this.now() },
    );
    const planned = await planner.plan({
      instrumentId: selected.instrumentId,
      side: draftLeg.side,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: targetBaseQuantity },
      quote: context.quote,
      quantityAlignment: "FLOOR",
    });
    if (!planned.ok) {
      throw commandError("execution_capability_unavailable", "第一腿实际敞口无法转换为第二腿最小合法数量。");
    }
    return Object.freeze({
      targetBaseQuantity,
      quantity: planned.plan.plannedAssetQuantity,
    });
  }

  private async readSpotExposure(
    userId: string,
    leg: ArbitrageInstance["legs"][number],
    draftLeg: ArbitrageExecutionDraftLeg,
    baseAsset: string,
    reference: ArbitrageInstance["executionReferences"][number],
  ) {
    const source = this.hedgePlanning.spotAttributions[leg.venue];
    if (!source || reference.executionRecordId === null || draftLeg.providerSymbol === null) {
      throw commandError("execution_state_unknown", "第一腿现货实际敞口无法可靠归因，不能执行第二腿。");
    }
    try {
      return await source.readAttributableBaseQuantity(userId, {
        accountId: leg.accountId,
        instrumentId: leg.instrumentId,
        providerSymbol: draftLeg.providerSymbol,
        baseAsset,
        executionIntentId: reference.executionIntentId,
        executionRecordId: reference.executionRecordId,
        grossConfirmedQuantity: reference.confirmedQuantity,
      });
    } catch {
      throw commandError("execution_state_unknown", "第一腿现货实际敞口无法可靠归因，不能执行第二腿。");
    }
  }

  private now() {
    const value = this.options.clock?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Execution confirmation clock is invalid.");
    return value;
  }
}

function restorePreparedHedge(
  instrumentId: string,
  prepared: Readonly<{ targetBaseQuantity: string; executableBaseQuantity: string }>,
) {
  const canonical = canonicalInstrumentFromId(instrumentId);
  const asset = canonicalAssets.getAsset(canonical.baseAsset);
  if (!asset) throw commandError("execution_capability_unavailable", "第二腿冻结数量的标准资产映射不可用。");
  return Object.freeze({
    targetBaseQuantity: prepared.targetBaseQuantity,
    quantity: createAssetQuantity({ asset, quantity: prepared.executableBaseQuantity }),
  });
}

function nextTimestamp(candidate: number, current: number) {
  const value = Math.max(candidate, current + 1);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Execution confirmation clock is invalid.");
  return value;
}

type FinalConfirmationRequest = Readonly<{
  confirmationId: string;
  opportunityId: string;
  horizonDays: 90 | 365;
  quantityInput: Readonly<{ mode: "NOTIONAL_USDT"; amountUsdt: string } | { mode: "ASSET_QUANTITY"; quantity: string }>;
  executionMode: ExecutionIntent["executionMode"];
  confirmed: true;
}>;

type LegConfirmationRequest = FinalConfirmationRequest & Readonly<{
  arbitrageId: string;
  legId: string;
  commandId: string;
}>;

type ReconciliationRequest = Readonly<{ arbitrageId: string; legId: string }>;

function parseFinalConfirmation(input: unknown): FinalConfirmationRequest {
  const value = object(input, "execution confirmation");
  exactKeys(value, ["confirmationId", "opportunityId", "horizonDays", "quantityInput", "executionMode", "confirmed"]);
  return commonConfirmation(value) as FinalConfirmationRequest;
}

function parseLegConfirmation(input: unknown): LegConfirmationRequest {
  const value = object(input, "leg execution confirmation");
  exactKeys(value, [
    "confirmationId", "opportunityId", "horizonDays", "quantityInput", "executionMode", "confirmed",
    "arbitrageId", "legId", "commandId",
  ]);
  return Object.freeze({
    ...commonConfirmation(value),
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    commandId: identifier(value.commandId, "commandId"),
  });
}

function parseReconciliationRequest(input: unknown): ReconciliationRequest {
  const value = object(input, "leg execution reconciliation");
  exactKeys(value, ["arbitrageId", "legId"]);
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
  });
}

function commonConfirmation(value: Record<string, unknown>) {
  if (value.confirmed !== true) throw invalid("需要用户明确确认。 ");
  if (value.horizonDays !== 90 && value.horizonDays !== 365) throw invalid("horizonDays 必须为 90 或 365。");
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw invalid("executionMode 无效。");
  }
  return Object.freeze({
    confirmationId: identifier(value.confirmationId, "confirmationId"),
    opportunityId: identifier(value.opportunityId, "opportunityId"),
    horizonDays: value.horizonDays,
    quantityInput: quantityInput(value.quantityInput),
    executionMode: value.executionMode,
    confirmed: true as const,
  });
}

function quantityInput(value: unknown): FinalConfirmationRequest["quantityInput"] {
  const input = object(value, "quantityInput");
  if (input.mode === "NOTIONAL_USDT") {
    exactKeys(input, ["mode", "amountUsdt"]);
    return Object.freeze({ mode: input.mode, amountUsdt: decimal(input.amountUsdt, "amountUsdt") });
  }
  if (input.mode === "ASSET_QUANTITY") {
    exactKeys(input, ["mode", "quantity"]);
    return Object.freeze({ mode: input.mode, quantity: decimal(input.quantity, "quantity") });
  }
  throw invalid("quantityInput.mode 无效。");
}

function plannedLegs(draft: ArbitrageExecutionDraft) {
  return draft.legs.map((leg) => {
    if (leg.planning.status !== "PLANNED") throw commandError("execution_capability_unavailable", "套利腿数量规划未通过。");
    return { leg, plan: leg.planning.plan };
  }) as [
    { leg: ArbitrageExecutionDraftLeg; plan: Extract<ArbitrageExecutionDraftLeg["planning"], { status: "PLANNED" }>["plan"] },
    { leg: ArbitrageExecutionDraftLeg; plan: Extract<ArbitrageExecutionDraftLeg["planning"], { status: "PLANNED" }>["plan"] },
  ];
}

function newInstanceLeg(
  leg: ArbitrageExecutionDraftLeg,
  plannedQuantity: string,
  accounts: ReadonlyMap<string, string>,
) {
  const accountId = accounts.get(leg.legId);
  if (!accountId) throw commandError("execution_capability_unavailable", "套利腿执行账户不可用。");
  return Object.freeze({
    legId: leg.legId,
    role: leg.role,
    venue: leg.venue,
    accountId,
    instrumentId: leg.instrumentId,
    plannedQuantity,
  });
}

function assertInstanceMatches(
  instance: ArbitrageInstance,
  draft: ArbitrageExecutionDraft,
  accounts: ReadonlyMap<string, string>,
  sourcePlanId: string | null,
  requirePlannedQuantities = true,
) {
  const identityMatches = sourcePlanId !== null
    && instance.sourcePlanId === sourcePlanId
    && instance.strategyType === draft.strategyType
    && draft.legs.every((leg) => instance.legs.some((candidate) => (
      candidate.legId === leg.legId
      && candidate.role === leg.role
      && leg.side === (candidate.role === "LONG" ? "buy" : "sell")
      && candidate.venue === leg.venue
      && candidate.accountId === accounts.get(leg.legId)
      && candidate.instrumentId === leg.instrumentId
    )));
  const quantitiesMatch = !requirePlannedQuantities
    || draft.quantityInput?.mode === "NOTIONAL_USDT"
    || plannedLegs(draft).every(({ leg, plan }) => instance.legs.some((candidate) => candidate.legId === leg.legId
      && candidate.plannedQuantity === plan.plannedAssetQuantity.quantity));
  if (!identityMatches || !quantitiesMatch) {
    throw commandError("arbitrage_instance_mismatch", "当前权威机会或数量计划与套利实例不一致。");
  }
}

function assertLegCanExecute(instance: ArbitrageInstance, selectedLegId: string) {
  const references = instance.executionReferences;
  if (references.length === 0) return null;
  const sameLeg = references.some((reference) => reference.legId === selectedLegId);
  if (sameLeg) throw commandError("second_leg_not_allowed", "该套利腿已经存在执行记录。");
  if (references.length !== 1) throw commandError("second_leg_not_allowed", "当前实例存在多条执行状态，不能继续自动推进。");
  const first = references[0]!;
  if (first.status !== "CONFIRMED" || first.confirmedQuantity !== first.requestedQuantity) {
    throw commandError("second_leg_not_allowed", "第一腿尚未完整确认，不能执行第二腿。");
  }
  return first;
}

function resultFromReference(
  instance: ArbitrageInstance,
  reference: ArbitrageInstance["executionReferences"][number],
  idempotentReplay: boolean,
  recordStatus?: ExecutionRecord["status"],
  diagnostic?: FormalExecutionDiagnostic,
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
    secondLegAllowed: instance.executionReferences.length === 1
      && reference.status === "CONFIRMED"
      && reference.confirmedQuantity === reference.requestedQuantity,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
}

function referenceStatus(status: ExecutionRecord["status"]) {
  if (status === "CONFIRMED" || status === "FAILED" || status === "UNKNOWN" || status === "PENDING_CONFIRMATION") return status;
  return "PENDING_CONFIRMATION" as const;
}

function recordStatusFromReference(status: ArbitrageInstance["executionReferences"][number]["status"]): ExecutionRecord["status"] | "CREATED" {
  if (status === "CLAIMED" || status === "LINKED") return "CREATED";
  return status;
}

function assertRuntimeIdentity(record: ExecutionRecord, intent: ExecutionIntent) {
  if (record.intentId !== intent.intentId || record.userId !== intent.userId
    || record.accountId !== intent.accountId || record.venue !== intent.venue
    || record.instrumentId !== intent.instrumentId) {
    throw commandError("execution_state_unknown", "执行记录身份与套利执行意图不一致。");
  }
}

function assertReconciliationIdentity(
  record: ExecutionRecord,
  userId: string,
  leg: ArbitrageInstance["legs"][number],
  reference: ArbitrageInstance["executionReferences"][number],
) {
  if (record.executionId !== reference.executionRecordId
    || record.intentId !== reference.executionIntentId
    || record.userId !== userId
    || record.accountId !== leg.accountId
    || record.venue !== leg.venue
    || record.instrumentId !== leg.instrumentId) {
    throw commandError("execution_state_unknown", "核验结果与套利实例的执行身份不一致。");
  }
}

function assertRecoveryIdentity(
  record: ExecutionRecord,
  userId: string,
  leg: ArbitrageInstance["legs"][number],
  reference: ArbitrageInstance["executionReferences"][number],
) {
  if (record.intentId !== reference.executionIntentId
    || record.userId !== userId
    || record.accountId !== leg.accountId
    || record.venue !== leg.venue
    || record.instrumentId !== leg.instrumentId) {
    throw commandError("execution_recovery_identity_conflict", "本地执行记录与套利执行引用身份不一致。");
  }
}

function sourcePlanIdentity(request: FinalConfirmationRequest) {
  return `execution-confirmation:${createHash("sha256").update(JSON.stringify({
    opportunityId: request.opportunityId,
    horizonDays: request.horizonDays,
    quantityInput: request.quantityInput,
    executionMode: request.executionMode,
  })).digest("hex")}`;
}

function deterministicId(prefix: string, ...parts: string[]) {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${name} 必须为对象。`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`请求包含不允许的字段：${unknown}。`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw invalid(`请求缺少字段：${missing}。`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) throw invalid(`${name} 无效。`);
  return value.trim();
}

function decimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw invalid(`${name} 必须为正十进制字符串。`);
  }
  return value;
}

function invalid(message: string) {
  return commandError("invalid_execution_confirmation", message);
}

function commandError(category: ArbitrageExecutionCommandError["category"], message: string) {
  return new ArbitrageExecutionCommandError(category, message);
}

function manualReconciliationCommandError(error: ManualReconciliationRequiredError) {
  return new ArbitrageExecutionCommandError(
    "manual_reconciliation_required",
    "本地订单记录无法安全解析，需要人工核账；未调用交易所执行接口。",
    {
      manualReconciliationRequired: true,
      idempotencyKey: error.idempotencyKey,
      reason: safeManualReconciliationReason(error.reason),
    },
  );
}

function safeManualReconciliationReason(reason: string) {
  return reason.length <= 200 && /^Stored Binance [A-Za-z0-9 ._-]+$/u.test(reason)
    ? reason
    : "Stored Binance order requires manual reconciliation.";
}
