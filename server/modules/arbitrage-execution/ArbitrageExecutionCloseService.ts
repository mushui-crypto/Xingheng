import { createHash } from "node:crypto";
import {
  compareUnsignedDecimals,
  activeManagedQuantity,
  subtractUnsignedDecimals,
  type ArbitrageExecutionReference,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitrageCommandFingerprint } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { createVerifiedExecutionProviderIdentity } from "../cex/ExecutionMutationSafetyGuard";
import { ExecutionQuantityPlanner, type ExecutionQuantityPlan } from "../cex/ExecutionQuantityPlanner";
import type { ArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";
import type { ArbitrageExecutionPlanningContext } from "./ArbitrageExecutionPlanningContext";
import type { SpotCloseAvailableBalanceSource } from "./BinanceSpotCloseBalanceSource";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";
import type {
  ArbitrageLegExecutionConfirmation,
} from "./ArbitrageExecutionCommandService";
import type {
  FormalExecutionDiagnostic,
  FormalManagedCloseExecutionContext,
  FormalExecutionMutationDisposition,
  FormalExecutionRuntimeResult,
} from "./FormalExecutionRuntime";
import { createVerifiedManagedCloseNativeExecutionRules } from "./FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistryError,
  type FormalExecutionRuntimeResolver,
} from "./FormalExecutionRuntimeRegistry";
import {
  ArbitrageCloseSafetyEvaluator,
  type ArbitrageCloseSafetyResult,
} from "./ArbitrageCloseSafetyEvaluator";
import {
  processProviderMutationSerializer,
  type ProviderMutationSerializer,
} from "./ProviderMutationSerializer";
import {
  canonicalCommandDecimal,
  createArbitrageCommandPayloadFingerprint,
} from "./ArbitrageCommandFingerprint";

type InstanceStore = Pick<
  ArbitrageInstanceStore,
  "get" | "claimExecutionReference" | "linkExecutionRecord" | "applyExecutionResult" | "readCommandReplay"
>;
type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify"> &
  Partial<Pick<ArbitragePositionVerificationService, "verifyLeg">>;
type SpotSource<T> = T | Partial<Record<ExecutionIntent["venue"], T>>;

export class ArbitrageExecutionCloseError extends Error {
  constructor(
    readonly category:
      | "invalid_close_confirmation"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "close_capability_unavailable"
      | "instrument_rules_unavailable"
      | "instrument_not_tradable"
      | "instrument_rules_invalid"
      | "position_verification_unavailable"
      | "close_quantity_unavailable"
      | "execution_state_unknown"
      | "idempotency_conflict",
    message: string,
  ) {
    super(message);
  }
}

export class ArbitrageExecutionCloseService {
  private readonly closeSafety: ArbitrageCloseSafetyEvaluator;

  constructor(
    private readonly instances: InstanceStore,
    private readonly positions: PositionVerifier,
    private readonly planningContexts: ArbitrageExecutionPlanningContextSource,
    private readonly spotBalances: SpotSource<SpotCloseAvailableBalanceSource>,
    private readonly spotAttributions: SpotSource<SpotOpeningAttributionSource>,
    private readonly runtimes: FormalExecutionRuntimeResolver,
    private readonly options: Readonly<{
      clock?: () => number;
      createIntentId?: (userId: string, arbitrageId: string, legId: string, commandId: string) => string;
      intentTtlMs?: number;
      mutationSerializer?: ProviderMutationSerializer;
    }> = {},
  ) {
    this.closeSafety = new ArbitrageCloseSafetyEvaluator(
      positions,
      planningContexts,
      spotBalances,
      spotAttributions,
      () => this.now(),
      "readSpotOpeningAttributionEvidence" in instances
        ? instances as unknown as Pick<ArbitrageInstanceStore, "readSpotOpeningAttributionEvidence">
        : undefined,
    );
  }

  async evaluateCloseSafety(
    authenticatedUserId: string,
    arbitrageIdInput: string,
    legIdInput: string,
  ): Promise<ArbitrageCloseSafetyResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const arbitrageId = identifier(arbitrageIdInput, "arbitrageId");
    const legId = identifier(legIdInput, "legId");
    const instance = this.instances.get(userId, arbitrageId);
    if (!instance) throw closeError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === legId);
    if (!leg) throw closeError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");
    return (await this.closeSafety.evaluate(userId, instance, leg)).result;
  }

  async closeLeg(authenticatedUserId: string, input: unknown): Promise<ArbitrageLegExecutionConfirmation> {
    return this.closeLegWithinDeadline(authenticatedUserId, input, null);
  }

  /** Exit-only boundary: a fresh read that finishes after its continuation budget may not mutate. */
  async closeLegForExit(
    authenticatedUserId: string,
    input: unknown,
    mutationDeadline: number,
  ): Promise<ArbitrageLegExecutionConfirmation> {
    if (!Number.isSafeInteger(mutationDeadline) || mutationDeadline < 0) {
      throw closeError("position_verification_unavailable", "退出仓位核验时限无效，不能提交退出。");
    }
    return this.closeLegWithinDeadline(authenticatedUserId, input, mutationDeadline);
  }

  private async closeLegWithinDeadline(
    authenticatedUserId: string,
    input: unknown,
    mutationDeadline: number | null,
  ) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseCloseRequest(input);
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw closeError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw closeError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");
    return (this.options.mutationSerializer ?? processProviderMutationSerializer).runExclusive({
      userId,
      venue: leg.venue,
      accountId: leg.accountId,
      canonicalInstrumentId: leg.instrumentId,
    }, () => this.closeLegOnce(userId, request, mutationDeadline));
  }

  private async closeLegOnce(
    userId: string,
    request: CloseRequest,
    mutationDeadline: number | null,
  ): Promise<ArbitrageLegExecutionConfirmation> {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw closeError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw closeError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");

    const intentId = this.options.createIntentId?.(userId, instance.arbitrageId, leg.legId, request.commandId)
      ?? deterministicId("close-intent", userId, instance.arbitrageId, leg.legId, request.commandId);
    const commandFingerprint = closeCommandFingerprint(userId, request, instance, leg, intentId);
    const replayReferenceId = this.readCommandReplay(commandFingerprint);
    if (replayReferenceId !== null) return closeResultFromCommandReplay(instance, replayReferenceId);
    if (instance.executionReferences.some((reference) => reference.executionIntentId === intentId)) {
      throw closeError("execution_state_unknown", "退出引用缺少可验证的 command fingerprint，请勿重复提交。");
    }

    assertCloseCapability(instance);
    const runtime = this.resolveRuntime(leg.venue);
    if (!runtime.executeManagedClose) {
      throw closeError("close_capability_unavailable", "当前执行运行时不支持可信的管理仓位退出。");
    }
    assertNoUnresolvedClose(instance, leg.legId);
    const managedQuantity = activeManagedQuantity(instance, leg);
    if (managedQuantity === "0") throw closeError("close_quantity_unavailable", "该套利腿当前没有可退出的管理数量。");
    if (compareUnsignedDecimals(request.quantity, managedQuantity) > 0) {
      throw closeError("close_quantity_unavailable", "退出数量不能超过当前可减少的真实仓位。");
    }
    const safety = await withinMutationDeadline(
      () => this.closeSafety.evaluate(userId, instance, leg),
      mutationDeadline,
      () => this.now(),
    );
    assertMutationDeadline(this.now(), mutationDeadline);
    assertCloseSafetyAvailable(safety.result);
    const context = safety.context;
    const planner = safety.planner;
    if (!context || !planner || safety.market === null) {
      throw closeError("close_capability_unavailable", "当前交易品种或交易规则不可用。");
    }
    const spot = safety.market === "SPOT";
    const perpetual = safety.market === "PERPETUAL";
    const now = this.now();
    // The request remains the ownership ceiling. Venue rules may only reduce
    // that quantity to the nearest legal provider quantity.
    const side = safety.side;
    const planned = await planner.plan({
      instrumentId: leg.instrumentId,
      side,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: request.quantity },
      quantityAlignment: "FLOOR",
      quote: context.quote,
    });
    if (!planned.ok) {
      throw closeError("close_quantity_unavailable", "退出数量无法按当前交易规则合法化。");
    }
    const closeQuantity = planned.plan.plannedAssetQuantity.quantity;
    if (compareUnsignedDecimals(closeQuantity, safety.result.safeClosableQuantity) > 0) {
      throw closeError("close_quantity_unavailable", "当前真实仓位不足以安全执行该退出数量。");
    }
    let acceptedResidualQuantity: string | undefined;
    if (spot) {
      const remainingQuantity = subtractUnsignedDecimals(managedQuantity, closeQuantity);
      if (remainingQuantity !== "0" && await isNonTradableSpotResidual(
        remainingQuantity,
        leg.instrumentId,
        context.tradingRules.quantityStep,
        context.quote,
        planner,
      )) {
        acceptedResidualQuantity = remainingQuantity;
      }
    }
    // Every perpetual close is a hard reduce-only mutation. Account Reality
    // has already proved that the requested managed slice cannot cross flat.
    const reduceOnly = perpetual;

    const intent = createExecutionIntent({
      intentId,
      arbitrageId: instance.arbitrageId,
      legId: leg.legId,
      userId,
      venue: leg.venue,
      accountId: leg.accountId,
      instrumentId: leg.instrumentId,
      side,
      ...(perpetual ? { positionDirection: leg.role } : {}),
      quantity: planned.plan.plannedAssetQuantity,
      orderConstraints: { reduceOnly },
      executionMode: request.executionMode,
      createdAt: now,
      expiresAt: now + (this.options.intentTtlMs ?? 30_000),
    });
    assertMutationDeadline(this.now(), mutationDeadline);
    try {
      this.instances.claimExecutionReference(userId, instance.arbitrageId, {
        legId: leg.legId,
        phase: "CLOSING",
        quantityEffect: "DECREASE",
        executionIntentId: intent.intentId,
        requestedQuantity: intent.quantity.quantity,
        commandId: request.commandId,
        operationType: "EXECUTION_CLOSE",
        businessPayloadFingerprint: commandFingerprint.businessPayloadFingerprint,
        ...(acceptedResidualQuantity === undefined ? {} : { acceptedResidualQuantity }),
        createdAt: now,
      });
    } catch (error) {
      const raced = this.instances.get(userId, instance.arbitrageId);
      const replayId = this.readCommandReplay(commandFingerprint);
      if (!raced || replayId === null) throw error;
      return closeResultFromCommandReplay(raced, replayId);
    }

    let runtimeResult: FormalExecutionRuntimeResult;
    const providerDispatchStartedAt = this.now();
    try {
      const executionContext: FormalManagedCloseExecutionContext | undefined = perpetual
        ? verifiedPerpetualCloseContext(
          safety.result,
          intent,
          managedQuantity,
          closeQuantity,
          context,
          planned.plan,
        )
        : undefined;
      runtimeResult = await runtime.executeManagedClose(intent, executionContext);
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
      ...(runtimeResult.mutationDisposition === "NOT_DISPATCHED"
        ? { mutationDisposition: runtimeResult.mutationDisposition }
        : {}),
      updatedAt: runtimeResult.executionRecord.updatedAt,
    });
    const reference = updated.executionReferences.find((candidate) => candidate.executionIntentId === intent.intentId)!;
    return closeResult(
      updated,
      reference,
      false,
      attributableStatus,
      providerDispatchStartedAt,
      runtimeResult.diagnostic,
      runtimeResult.mutationDisposition,
    );
  }

  private now() {
    const value = this.options.clock?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Close execution clock is invalid.");
    return value;
  }

  private resolveRuntime(venue: ExecutionIntent["venue"]) {
    try {
      return this.runtimes.resolve(venue);
    } catch (error) {
      if (error instanceof FormalExecutionRuntimeRegistryError
        && error.category === "runtime_not_registered") {
        throw closeError("close_capability_unavailable", "该交易所尚未接入正式退出能力。");
      }
      throw error;
    }
  }

  private readCommandReplay(fingerprint: ArbitrageCommandFingerprint) {
    try {
      return this.instances.readCommandReplay(fingerprint);
    } catch {
      throw closeError("idempotency_conflict", "commandId 已用于不同的退出业务请求。");
    }
  }
}

function verifiedPerpetualCloseContext(
  safety: ArbitrageCloseSafetyResult,
  intent: ExecutionIntent,
  managedQuantityCeiling: string,
  legalizedCloseQuantity: string,
  planningContext: ArbitrageExecutionPlanningContext,
  plan: ExecutionQuantityPlan,
): FormalManagedCloseExecutionContext {
  if (safety.positionMode === null || intent.positionDirection === undefined
    || !intent.orderConstraints.reduceOnly) {
    throw closeError("position_verification_unavailable", "永续退出缺少可靠的持仓模式或 CLOSE_ONLY 语义。");
  }
  return Object.freeze({
    verifiedAt: safety.checkedAt,
    positionMode: safety.positionMode,
    side: intent.side,
    positionDirection: intent.positionDirection,
    actualSignedNetQuantity: safety.actualSignedNetQuantity,
    actualLongQuantity: safety.actualLongQuantity,
    actualShortQuantity: safety.actualShortQuantity,
    safeClosableQuantity: safety.safeClosableQuantity,
    managedQuantityCeiling,
    legalizedCloseQuantity,
    reduceOnly: true,
    ...(intent.venue !== "okx" ? {} : {
      verifiedNativeExecutionRules: verifiedOkxNativeExecutionRules(
        safety,
        intent,
        planningContext,
        plan,
      ),
    }),
    ...(safety.verifiedAccountId !== intent.accountId ? {} : {
      verifiedProviderIdentity: createVerifiedExecutionProviderIdentity({
        userId: intent.userId,
        venue: intent.venue,
        accountId: intent.accountId,
        executionIntentId: intent.intentId,
        verifiedAt: safety.checkedAt,
      }),
    }),
  });
}

function verifiedOkxNativeExecutionRules(
  safety: ArbitrageCloseSafetyResult,
  intent: ExecutionIntent,
  planningContext: ArbitrageExecutionPlanningContext,
  plan: ExecutionQuantityPlan,
) {
  const rules = planningContext.nativeExecutionRules;
  if (!rules || rules.venue !== "okx" || rules.canonicalInstrumentId !== intent.instrumentId
    || rules.providerInstrumentId !== plan.providerSymbol
    || rules.instrumentState !== "live" || rules.contractType !== "linear"
    || rules.settlementAsset !== "USDT" || plan.plannedVenueQuantity === undefined
    || planningContext.tradingRules.contractSize !== rules.contractValue
    || planningContext.tradingRules.quantityStep !== rules.lotSize
    || planningContext.tradingRules.minQuantity !== rules.minimumSize) {
    throw closeError("close_capability_unavailable", "OKX永续退出缺少可靠的原生合约规则。");
  }
  return createVerifiedManagedCloseNativeExecutionRules({
    userId: intent.userId,
    accountId: intent.accountId,
    venue: intent.venue,
    canonicalInstrumentId: intent.instrumentId,
    providerInstrumentId: rules.providerInstrumentId,
    executionIntentId: intent.intentId,
    instrumentState: rules.instrumentState,
    contractType: rules.contractType,
    contractValueCurrency: rules.contractValueCurrency,
    settlementAsset: rules.settlementAsset,
    contractValue: rules.contractValue,
    lotSize: rules.lotSize,
    minimumSize: rules.minimumSize,
    canonicalSafeCloseQuantity: safety.safeClosableQuantity,
    legalizedCanonicalCloseQuantity: plan.plannedAssetQuantity.quantity,
    providerNativeQuantity: plan.plannedVenueQuantity,
    verifiedAt: Math.max(safety.checkedAt, rules.verifiedAt, plan.generatedAt),
  });
}

function assertMutationDeadline(now: number, deadline: number | null) {
  if (deadline !== null && now > deadline) {
    throw closeError("position_verification_unavailable", "退出仓位核验已超过本次安全时限，未提交订单。");
  }
}

async function withinMutationDeadline<T>(operation: () => Promise<T>, deadline: number | null, now: () => number) {
  if (deadline === null) return operation();
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw closeError("position_verification_unavailable", "退出仓位核验已超过本次安全时限，未提交订单。");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(closeError(
          "position_verification_unavailable",
          "退出仓位核验已超过本次安全时限，未提交订单。",
        )), remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function isNonTradableSpotResidual(
  residualQuantity: string,
  instrumentId: string,
  quantityStep: string,
  quote: Parameters<ExecutionQuantityPlanner["plan"]>[0]["quote"],
  planner: ExecutionQuantityPlanner,
) {
  const alignedQuantity = floorToStep(residualQuantity, quantityStep);
  if (alignedQuantity === "0") return true;
  const result = await planner.plan({
    instrumentId,
    side: "sell",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: alignedQuantity },
    quote,
  });
  if (result.ok) return false;
  if (result.error.code === "QUANTITY_ROUNDED_TO_ZERO"
    || result.error.code === "QUANTITY_BELOW_MINIMUM"
    || result.error.code === "NOTIONAL_BELOW_MINIMUM") {
    return true;
  }
  throw closeError("close_quantity_unavailable", "现货残余数量无法通过当前交易规则可靠判定。");
}

function floorToStep(quantity: string, step: string) {
  const scale = Math.max(decimalPlaces(quantity), decimalPlaces(step));
  const quantityValue = decimalInteger(quantity, scale);
  const stepValue = decimalInteger(step, scale);
  if (stepValue <= 0n) throw closeError("close_quantity_unavailable", "现货交易步长无效。");
  return decimalFromInteger((quantityValue / stepValue) * stepValue, scale);
}

function decimalInteger(value: string, scale: number) {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(`${integer}${fraction.padEnd(scale, "0")}`);
}

function decimalFromInteger(value: bigint, scale: number) {
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, "0");
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}

function decimalPlaces(value: string) {
  return value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
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

function assertCloseCapability(instance: ArbitrageInstance) {
  if (instance.status === "CLOSED" || instance.status === "FAILED") {
    throw closeError("close_capability_unavailable", "已结束的套利实例不能再次退出。");
  }
}

function assertNoUnresolvedClose(instance: ArbitrageInstance, legId: string) {
  const unresolved = instance.executionReferences.some((reference) => reference.legId === legId
    && reference.phase === "CLOSING"
    && (reference.status === "CLAIMED" || reference.status === "LINKED"
      || reference.status === "PENDING_CONFIRMATION" || reference.status === "UNKNOWN"));
  if (unresolved) throw closeError("execution_state_unknown", "该套利腿已有未完成的退出执行，请先重新核验。");
}

function assertCloseSafetyAvailable(safety: ArbitrageCloseSafetyResult) {
  if (safety.reason === "PROVIDER_REALITY_UNAVAILABLE") {
    throw closeError("position_verification_unavailable", "当前真实仓位无法可靠确认，不能提交退出。");
  }
  if (safety.reason === "CLOSE_CAPABILITY_UNAVAILABLE" || safety.reason === "SPOT_ROLE_UNSUPPORTED") {
    throw closeError("close_capability_unavailable", "当前交易品种不支持安全退出。");
  }
  if (safety.reason === "INSTRUMENT_RULES_UNAVAILABLE") {
    throw closeError("instrument_rules_unavailable", "当前交易规则暂时无法可靠读取，不能提交退出。");
  }
  if (safety.reason === "INSTRUMENT_NOT_TRADABLE") {
    throw closeError("instrument_not_tradable", "当前交易品种不可交易，不能提交退出。");
  }
  if (safety.reason === "INSTRUMENT_RULES_INVALID") {
    throw closeError("instrument_rules_invalid", "当前交易规则无效，不能提交退出。");
  }
  if (safety.reason === "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE") {
    throw closeError("position_verification_unavailable", "现货开仓成交与手续费无法可靠归因，不能提交退出。");
  }
  if (safety.reason === "SPOT_AVAILABLE_BALANCE_UNAVAILABLE") {
    throw closeError("position_verification_unavailable", "当前现货可用余额无法可靠确认，不能提交退出。");
  }
  if (safety.safeClosableQuantity === "0") {
    throw closeError("close_quantity_unavailable", "当前真实仓位不足以安全执行该退出数量。");
  }
}

function closeResult(
  instance: ArbitrageInstance,
  reference: ArbitrageExecutionReference,
  idempotentReplay: boolean,
  recordStatus?: ExecutionRecord["status"],
  providerDispatchStartedAt?: number,
  diagnostic?: FormalExecutionDiagnostic,
  mutationDisposition?: FormalExecutionMutationDisposition,
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
    ...(providerDispatchStartedAt === undefined ? {} : { providerDispatchStartedAt }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(mutationDisposition === undefined ? {} : { mutationDisposition }),
    ...(diagnostic?.failureStage === undefined ? {} : { failureStage: diagnostic.failureStage }),
  });
}

function closeCommandFingerprint(
  userId: string,
  request: CloseRequest,
  instance: ArbitrageInstance,
  leg: ArbitrageInstance["legs"][number],
  referenceId: string,
): ArbitrageCommandFingerprint {
  return Object.freeze({
    commandId: request.commandId,
    operationType: "EXECUTION_CLOSE",
    requestedByUserId: userId,
    arbitrageId: instance.arbitrageId,
    legId: leg.legId,
    referenceId,
    businessPayloadFingerprint: createArbitrageCommandPayloadFingerprint([
      "EXECUTION_CLOSE",
      userId,
      instance.arbitrageId,
      leg.legId,
      canonicalCommandDecimal(request.quantity),
      request.executionMode,
      "CONFIRMED_TRUE",
      leg.role,
      leg.venue,
      leg.accountId,
      leg.instrumentId,
    ]),
  });
}

function closeResultFromCommandReplay(instance: ArbitrageInstance, referenceId: string) {
  const reference = instance.executionReferences.find(
    (candidate) => candidate.executionIntentId === referenceId,
  );
  if (!reference) {
    throw closeError("execution_state_unknown", "command fingerprint 存在但退出引用不可用，请先核验。");
  }
  return closeResult(instance, reference, true);
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
