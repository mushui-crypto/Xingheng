import { createHash } from "node:crypto";
import {
  compareUnsignedDecimals,
  managedCurrentQuantity,
  managedSignedDelta,
  subtractUnsignedDecimals,
  type ArbitrageExecutionReference,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import { reduceOnlyEligible } from "../cex/position/PositionVerification";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { ExecutionQuantityPlanner } from "../cex/ExecutionQuantityPlanner";
import type { ArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";
import type { SpotCloseAvailableBalanceSource } from "./BinanceSpotCloseBalanceSource";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";
import type {
  ArbitrageLegExecutionConfirmation,
} from "./ArbitrageExecutionCommandService";
import type { FormalExecutionRuntimeResult } from "./FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistryError,
  type FormalExecutionRuntimeResolver,
} from "./FormalExecutionRuntimeRegistry";

type InstanceStore = Pick<
  ArbitrageInstanceStore,
  "get" | "claimExecutionReference" | "linkExecutionRecord" | "applyExecutionResult"
>;
type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;
type SpotSource<T> = T | Partial<Record<ExecutionIntent["venue"], T>>;

export class ArbitrageExecutionCloseError extends Error {
  constructor(
    readonly category:
      | "invalid_close_confirmation"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "close_capability_unavailable"
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
    private readonly spotBalances: SpotSource<SpotCloseAvailableBalanceSource>,
    private readonly spotAttributions: SpotSource<SpotOpeningAttributionSource>,
    private readonly runtimes: FormalExecutionRuntimeResolver,
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

    assertCloseCapability(instance);
    const runtime = this.resolveRuntime(leg.venue);
    assertNoUnresolvedClose(instance, leg.legId);
    const managedQuantity = managedCurrentQuantity(leg);
    const managedDelta = managedSignedDelta(leg);
    if (managedQuantity === "0") throw closeError("close_quantity_unavailable", "该套利腿当前没有可退出的管理数量。");

    const verification = await this.positions.verify(userId, instance.arbitrageId);
    const verifiedLeg = verification?.legs.find((candidate) => candidate.legId === leg.legId);
    if (!verifiedLeg || verifiedLeg.verificationStatus !== "MATCHED") {
      throw closeError("position_verification_unavailable", "当前真实仓位无法可靠确认，不能提交退出。");
    }
    if (compareUnsignedDecimals(request.quantity, managedQuantity) > 0) {
      throw closeError("close_quantity_unavailable", "退出数量不能超过当前可减少的真实仓位。");
    }

    const context = await loadContext(this.planningContexts, leg.venue, leg.instrumentId);
    const spot = context.instrument.marketType === "spot" && context.instrument.contractType === "spot";
    const perpetual = context.instrument.marketType === "perpetual"
      && context.instrument.contractType === "linear_perpetual"
      && context.instrument.settlementAsset === "USDT";
    if (context.instrument.quoteAsset !== "USDT" || (!spot && !perpetual)) {
      throw closeError("close_capability_unavailable", "当前只支持 USDT 现货与线性永续套利腿退出。");
    }
    if (perpetual && verifiedLeg.positionMode !== "HEDGE" && verifiedLeg.actualSignedNetQuantity == null) {
      throw closeError("position_verification_unavailable", "当前真实仓位无法可靠确认，不能提交退出。");
    }
    if (perpetual && verifiedLeg.positionMode === "HEDGE") {
      const bucketQuantity = leg.role === "LONG" ? verifiedLeg.actualLongQuantity : verifiedLeg.actualShortQuantity;
      if (bucketQuantity === null || compareUnsignedDecimals(request.quantity, bucketQuantity) > 0) {
        throw closeError("close_quantity_unavailable", "HEDGE 对应仓位桶不足，不能扩大或反向退出。");
      }
    }
    if (spot && leg.role !== "LONG") {
      throw closeError("close_capability_unavailable", "现货空头腿无法通过可用余额可靠退出。");
    }
    const now = this.now();
    const planner = new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === leg.instrumentId ? context.instrument : null },
      { getTradingRules: async () => context.tradingRules },
      { now: () => now },
    );
    // The request remains the ownership ceiling. Venue rules may only reduce
    // that quantity to the nearest legal provider quantity.
    const managedSliceToReverse = managedDelta.startsWith("-") ? `-${request.quantity}` : request.quantity;
    const reversalOrderDelta = managedSliceToReverse.startsWith("-")
      ? request.quantity
      : `-${request.quantity}`;
    const side = reversalOrderDelta.startsWith("-") ? "sell" as const : "buy" as const;
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
    let acceptedResidualQuantity: string | undefined;
    if (spot) {
      const opening = exactSpotOpeningReference(instance, leg.legId);
      let attributableBaseQuantity: string;
      try {
        attributableBaseQuantity = await this.spotAttributionFor(leg.venue).readAttributableBaseQuantity(userId, {
          accountId: leg.accountId,
          instrumentId: leg.instrumentId,
          providerSymbol: context.instrument.providerSymbol,
          baseAsset: context.instrument.baseAsset.symbol,
          executionIntentId: opening.executionIntentId,
          executionRecordId: opening.executionRecordId!,
          grossConfirmedQuantity: opening.confirmedQuantity,
        });
      } catch {
        throw closeError("position_verification_unavailable", "现货开仓成交与手续费无法可靠归因，不能提交退出。");
      }
      let availableQuantity: string;
      try {
        const balance = await this.spotBalanceFor(leg.venue).readAvailableBalance(userId, {
          accountId: leg.accountId,
          instrumentId: leg.instrumentId,
          providerSymbol: context.instrument.providerSymbol,
          baseAsset: context.instrument.baseAsset.symbol,
        });
        availableQuantity = balance.availableQuantity;
      } catch {
        throw closeError("position_verification_unavailable", "当前现货可用余额无法可靠确认，不能提交退出。");
      }
      const attributableAvailable = compareUnsignedDecimals(attributableBaseQuantity, availableQuantity) <= 0
        ? attributableBaseQuantity
        : availableQuantity;
      const maxCloseQuantity = floorToStep(attributableAvailable, context.tradingRules.quantityStep);
      if (maxCloseQuantity === "0" || compareUnsignedDecimals(closeQuantity, maxCloseQuantity) > 0) {
        throw closeError("close_quantity_unavailable", "退出数量超过当前实例可归因且可用的现货数量。");
      }
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
    // This is the legal managed slice reversed by this order, not the full
    // account position or the unaligned request ceiling.
    const legalManagedSlice = managedDelta.startsWith("-") ? `-${closeQuantity}` : closeQuantity;
    const reduceOnly = perpetual
      && (verifiedLeg.positionMode === "HEDGE"
        ? true
        : reduceOnlyEligible(verifiedLeg.actualSignedNetQuantity!, legalManagedSlice));

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
    try {
      this.instances.claimExecutionReference(userId, instance.arbitrageId, {
        legId: leg.legId,
        phase: "CLOSING",
        quantityEffect: "DECREASE",
        executionIntentId: intent.intentId,
        requestedQuantity: intent.quantity.quantity,
        ...(acceptedResidualQuantity === undefined ? {} : { acceptedResidualQuantity }),
        createdAt: now,
      });
    } catch (error) {
      const raced = this.instances.get(userId, instance.arbitrageId);
      const reference = raced?.executionReferences.find((candidate) => candidate.executionIntentId === intent.intentId);
      if (!raced || !reference) throw error;
      return closeResult(raced, reference, true);
    }

    let runtimeResult: FormalExecutionRuntimeResult;
    try {
      runtimeResult = await runtime.execute(intent);
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

  private spotBalanceFor(venue: ExecutionIntent["venue"]): SpotCloseAvailableBalanceSource {
    return resolveSpotSource(this.spotBalances, venue, "balance");
  }

  private spotAttributionFor(venue: ExecutionIntent["venue"]): SpotOpeningAttributionSource {
    return resolveSpotSource(this.spotAttributions, venue, "attribution");
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
}

function resolveSpotSource<T extends object>(source: SpotSource<T>, venue: ExecutionIntent["venue"], kind: string): T {
  if (kind === "balance" && "readAvailableBalance" in source) return source as T;
  if (kind === "attribution" && "readAttributableBaseQuantity" in source) return source as T;
  const selected = (source as Partial<Record<ExecutionIntent["venue"], T>>)[venue];
  if (!selected) throw new Error(`Spot ${kind} source is not configured for ${venue}.`);
  return selected;
}

function exactSpotOpeningReference(instance: ArbitrageInstance, legId: string) {
  const openings = instance.executionReferences.filter((reference) => reference.legId === legId
    && reference.phase === "OPENING"
    && reference.quantityEffect === "INCREASE"
    && reference.status === "CONFIRMED"
    && reference.executionRecordId !== null);
  if (openings.length !== 1) {
    throw closeError("position_verification_unavailable", "现货开仓执行引用无法唯一归因。");
  }
  return openings[0]!;
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
