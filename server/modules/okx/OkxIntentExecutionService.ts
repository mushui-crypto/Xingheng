import { createHash } from "node:crypto";
import {
  createExecutionCancelObservation,
  type ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import { runExecutionPreMutationPhase } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import {
  isTrustedVerifiedManagedCloseNativeExecutionRules,
  type FormalManagedCloseExecutionContext,
  type VerifiedManagedCloseNativeExecutionRules,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { ExecutionStatus } from "../cex/ExecutionState";
import {
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
  type ExecutionMutationEffect,
  type ExecutionProviderIdentityValidator,
} from "../cex/ExecutionMutationSafetyGuard";
import {
  OkxInstrumentMappingAdapter,
  type OkxInstrumentResolution,
} from "./OkxInstrumentMapping";
import {
  loadOkxQuantityRules,
  OKX_QUANTITY_RULES_MAX_AGE_MS,
  okxBaseQuantityToContracts,
  okxContractQuantityToBase,
  type OkxQuantityRulesSource,
} from "./OkxQuantitySemantics";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxOrderIdentity,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const VERIFIED_MANAGED_CLOSE_RULES_MAX_AGE_MS = 15_000;

export type OkxIntentExecutionClient = Readonly<{
  readPositionMode?(): Promise<"ONE_WAY" | "HEDGE">;
  placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult>;
  getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder>;
  cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult>;
}>;

export type OkxLimitPriceResolver = (
  intent: ExecutionIntent,
  instrument: OkxInstrumentResolution,
) => Promise<string> | string;

export type OkxIntentExecutionServiceOptions = Readonly<{
  tdMode?: "cross" | "isolated";
  instrumentMapping?: OkxInstrumentMappingAdapter;
  limitPriceResolver?: OkxLimitPriceResolver;
  quantityRulesSource?: OkxQuantityRulesSource;
  quantityRulesMaxAgeMs?: number;
  clock?: () => number;
  mutationSafetyGuard?: ExecutionMutationSafetyGuard;
  mutationEffect?: ExecutionMutationEffect;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (
    reference: Readonly<{
      instId: string;
      clOrdId: string;
      expectedProviderQuantity: string;
      expectedSide: "buy" | "sell";
      positionMode?: "ONE_WAY" | "HEDGE";
      positionDirection?: "LONG" | "SHORT";
      posSide?: "long" | "short";
    }>,
  ) => Promise<void> | void;
  verifiedCloseContext?: FormalManagedCloseExecutionContext;
}>;

export type OkxExecutionOrderIdentity = Readonly<OkxOrderIdentity>;

export type OkxIntentExecutionResult = Readonly<{
  executionAttemptId: string;
  providerOrderId: string;
  clientOrderId: string;
  instId: string;
  orderIdentity: OkxExecutionOrderIdentity;
  state: ExecutionStatus;
  confirmedQuantity: string;
  statusReason: string | null;
  expectedProviderQuantity?: string;
  expectedSide?: "buy" | "sell";
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  posSide?: "long" | "short";
}>;

export type OkxExecutionQueryResult = Readonly<{
  observation: ExecutionQueryObservation;
  orderIdentity: OkxExecutionOrderIdentity;
  fee: string;
  statusReason: string | null;
}>;

export type OkxExecutionOrderLookup = Readonly<{
  instrumentId: string;
  instId: string;
  ordId?: string;
  clOrdId: string;
  expectedProviderQuantity?: string;
  expectedSide?: "buy" | "sell";
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  posSide?: "long" | "short";
}>;

export class OkxIntentExecutionService {
  private readonly tdMode: "cross" | "isolated";
  private readonly instrumentMapping: OkxInstrumentMappingAdapter;
  private readonly clock: () => number;
  private readonly mutationSafetyGuard: ExecutionMutationSafetyGuard;

  constructor(
    private readonly client: OkxIntentExecutionClient,
    private readonly options: OkxIntentExecutionServiceOptions = {},
  ) {
    this.tdMode = options.tdMode ?? "cross";
    this.instrumentMapping = options.instrumentMapping ?? new OkxInstrumentMappingAdapter();
    this.clock = options.clock ?? Date.now;
    this.mutationSafetyGuard = options.mutationSafetyGuard ?? new ExecutionMutationSafetyGuard();
  }

  async execute(intent: ExecutionIntent): Promise<OkxIntentExecutionResult> {
    if (intent.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }
    const prepared = await runExecutionPreMutationPhase(async () => {
      const value = await this.prepare(intent);
      await this.mutationSafetyGuard.assertAllowed({
        venue: intent.venue,
        operation: "placeOrder",
        userId: intent.userId,
        accountId: intent.accountId,
        instrumentId: intent.instrumentId,
        providerInstrumentId: value.instId,
        executionIntentId: intent.intentId,
        mutationPreparedAt: this.clock(),
        ...(this.options.verifiedCloseContext === undefined ? {} : {
          verifiedProviderIdentity: this.options.verifiedCloseContext.verifiedProviderIdentity,
        }),
        ...(this.options.mutationEffect === undefined ? {} : { mutationEffect: this.options.mutationEffect }),
      }, this.options.validateProviderIdentity);
      await this.options.persistRecoveryReference?.({
        instId: value.instId,
        clOrdId: value.clOrdId,
        expectedProviderQuantity: value.quantity,
        expectedSide: value.side,
        positionMode: value.positionMode,
        positionDirection: intent.positionDirection,
        posSide: value.posSide,
      });
      return value;
    });
    const accepted = await this.client.placeOrder(prepared);
    assertAcceptedIdentity(accepted, prepared);
    return Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: accepted.ordId,
      clientOrderId: accepted.clOrdId,
      instId: accepted.instId,
      orderIdentity: Object.freeze({
        instId: accepted.instId,
        ordId: accepted.ordId,
        clOrdId: accepted.clOrdId,
      }),
      state: "SUBMITTED",
      confirmedQuantity: "0",
      statusReason: null,
      expectedProviderQuantity: prepared.quantity,
      expectedSide: prepared.side,
      ...(prepared.positionMode === undefined ? {} : { positionMode: prepared.positionMode }),
      ...(intent.positionDirection === undefined ? {} : { positionDirection: intent.positionDirection }),
      ...(prepared.posSide === undefined ? {} : { posSide: prepared.posSide }),
    });
  }

  async query(lookup: OkxExecutionOrderLookup): Promise<OkxExecutionQueryResult> {
    const instrument = this.instrumentMapping.resolve(lookup.instrumentId);
    if (instrument.venueInstrument.instId !== lookup.instId) {
      throw new Error("OKX order lookup instrument identity does not match the mapped instrument.");
    }
    const rules = await loadOkxQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      () => this.now(),
      this.options.quantityRulesMaxAgeMs ?? OKX_QUANTITY_RULES_MAX_AGE_MS,
    );
    const observedAt = this.now();
    const order = await this.client.getOrder({
      instId: lookup.instId,
      ...(lookup.ordId === undefined ? {} : { ordId: lookup.ordId }),
      clOrdId: lookup.clOrdId,
    });
    if (order.instId !== lookup.instId) {
      throw new Error("OKX order response instrument identity does not match the execution order.");
    }
    const verified = observationForOrder(order, lookup, rules, observedAt, this.tdMode);
    return Object.freeze({
      observation: verified.observation,
      orderIdentity: Object.freeze({
        instId: order.instId,
        ordId: order.ordId,
        clOrdId: order.clOrdId,
      }),
      fee: order.fee,
      statusReason: verified.statusReason,
    });
  }

  async cancel(
    lookup: OkxExecutionOrderLookup,
    context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & {
      providerInstrumentId?: string;
    },
  ): Promise<ExecutionCancelObservation> {
    await this.mutationSafetyGuard.assertAllowed({
      venue: "okx",
      operation: "cancelOrder",
      userId: context.userId,
      accountId: context.accountId,
      instrumentId: context.instrumentId,
      providerInstrumentId: context.providerInstrumentId ?? lookup.instId,
    }, this.options.validateProviderIdentity);
    await this.client.cancelOrder({
      instId: lookup.instId,
      ...(lookup.ordId === undefined ? {} : { ordId: lookup.ordId }),
      clOrdId: lookup.clOrdId,
    });
    return createExecutionCancelObservation({
      state: "CANCEL_REQUESTED",
      observedAt: this.now(),
    });
  }

  resolveLookup(record: ExecutionRecord): OkxExecutionOrderLookup {
    if (record.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    const instrument = this.instrumentMapping.resolve(record.instrumentId);
    return Object.freeze({
      instrumentId: record.instrumentId,
      instId: instrument.venueInstrument.instId,
      ...(record.remoteOrderId === undefined ? {} : { ordId: record.remoteOrderId }),
      clOrdId: okxClientOrderIdFor(record),
    });
  }

  private async prepare(intent: ExecutionIntent): Promise<OkxPlaceOrderRequest> {
    const instrument = this.instrumentMapping.resolve(intent.instrumentId);
    assertIntentMatchesInstrument(intent, instrument);
    const verifiedNativeRules = this.verifiedNativeRulesFor(intent, instrument);
    const rules = verifiedNativeRules === null
      ? await loadOkxQuantityRules(
        this.options.quantityRulesSource,
        instrument,
        () => this.now(),
        this.options.quantityRulesMaxAgeMs ?? OKX_QUANTITY_RULES_MAX_AGE_MS,
      )
      : null;
    let positionMode: "ONE_WAY" | "HEDGE" | undefined;
    if (instrument.venueInstrument.contractType !== "spot") {
      positionMode = await this.positionModeFor(intent);
    }
    if (positionMode === "HEDGE" && intent.positionDirection === undefined) {
      throw new Error("OKX HEDGE execution requires positionDirection.");
    }
    if (positionMode === "HEDGE" && intent.orderConstraints.reduceOnly
      && ((intent.positionDirection === "LONG" && intent.side !== "sell")
        || (intent.positionDirection === "SHORT" && intent.side !== "buy"))) {
      throw new Error("OKX HEDGE close side does not reduce the selected position bucket.");
    }
    const base = {
      instId: instrument.venueInstrument.instId,
      tdMode: this.tdMode,
      side: intent.side,
      quantity: verifiedNativeRules?.providerNativeQuantity
        ?? okxBaseQuantityToContracts(intent.quantity.quantity, rules!),
      clOrdId: okxClientOrderIdFor(intent),
      ...(positionMode === "HEDGE"
        ? { posSide: intent.positionDirection === "LONG" ? "long" as const : "short" as const }
        : { reduceOnly: intent.orderConstraints.reduceOnly }),
    } as const;
    if (intent.executionMode === "EXECUTION_PRIORITY") {
      return attachPositionMode({ ...base, ordType: "market" }, positionMode);
    }
    if (!this.options.limitPriceResolver) {
      throw new Error("OKX PRICE_PRIORITY execution requires an explicit limit price resolver.");
    }
    return attachPositionMode({
      ...base,
      ordType: "limit",
      price: decimalQuantity(await this.options.limitPriceResolver(intent, instrument)),
    }, positionMode);
  }

  private verifiedNativeRulesFor(
    intent: ExecutionIntent,
    instrument: OkxInstrumentResolution,
  ): VerifiedManagedCloseNativeExecutionRules | null {
    const close = this.options.verifiedCloseContext;
    if (close === undefined) return null;
    const rules = close.verifiedNativeExecutionRules;
    const now = this.now();
    if (rules === undefined
      || !isTrustedVerifiedManagedCloseNativeExecutionRules(rules)
      || rules.source !== "MUTATION_TIME_AUTHORITATIVE_CLOSE_SAFETY"
      || rules.userId !== intent.userId
      || rules.accountId !== intent.accountId
      || rules.venue !== intent.venue
      || rules.canonicalInstrumentId !== intent.instrumentId
      || rules.providerInstrumentId !== instrument.venueInstrument.instId
      || rules.executionIntentId !== intent.intentId
      || rules.instrumentState !== "live"
      || rules.contractType !== "linear"
      || rules.contractValueCurrency !== instrument.canonicalInstrument.baseAsset
      || rules.settlementAsset !== instrument.canonicalInstrument.quoteAsset
      || rules.canonicalSafeCloseQuantity !== close.safeClosableQuantity
      || rules.legalizedCanonicalCloseQuantity !== close.legalizedCloseQuantity
      || rules.legalizedCanonicalCloseQuantity !== intent.quantity.quantity
      || rules.verifiedAt > now
      || now - rules.verifiedAt > VERIFIED_MANAGED_CLOSE_RULES_MAX_AGE_MS) {
      throw preparationError(
        "instrument_rules_invalid",
        "OKX verified native execution rules are invalid, stale, or outside this mutation attempt.",
      );
    }
    const recomputed = okxBaseQuantityToContracts(intent.quantity.quantity, {
      instType: "SWAP",
      instId: rules.providerInstrumentId,
      uly: `${instrument.canonicalInstrument.baseAsset}-${instrument.canonicalInstrument.quoteAsset}`,
      ctType: "linear",
      ctValCcy: rules.contractValueCurrency,
      settleCcy: rules.settlementAsset,
      lotSz: rules.lotSize,
      minSz: rules.minimumSize,
      ctVal: rules.contractValue,
      state: "live",
      fetchedAt: rules.verifiedAt,
    });
    if (recomputed !== rules.providerNativeQuantity) {
      throw preparationError(
        "instrument_rules_invalid",
        "OKX verified native quantity does not match the canonical close quantity.",
      );
    }
    return rules;
  }

  private async positionModeFor(intent: ExecutionIntent): Promise<"ONE_WAY" | "HEDGE"> {
    const verified = this.options.verifiedCloseContext;
    if (verified !== undefined) {
      if (!intent.orderConstraints.reduceOnly
        || verified.reduceOnly !== true
        || verified.side !== intent.side
        || verified.positionDirection !== intent.positionDirection
        || verified.legalizedCloseQuantity !== intent.quantity.quantity) {
        throw preparationError(
          "verified_close_context_invalid",
          "OKX verified close context does not match the execution intent.",
        );
      }
      return verified.positionMode;
    }
    if (typeof this.client.readPositionMode !== "function") {
      throw preparationError("position_mode_unavailable", "OKX authoritative position mode is unavailable.");
    }
    try {
      return await this.client.readPositionMode();
    } catch (error) {
      const category = providerErrorCategory(error);
      if (category === "credential_validation_failed" || category === "provider_permission_error") throw error;
      throw preparationError(
        "position_mode_unavailable",
        "OKX authoritative position mode is temporarily unavailable.",
        providerErrorCode(error),
      );
    }
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("OKX execution clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}

class OkxExecutionPreparationError extends Error {
  constructor(
    readonly category: string,
    message: string,
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = "OkxExecutionPreparationError";
  }
}

function preparationError(category: string, message: string, providerCode: string | null = null) {
  return new OkxExecutionPreparationError(category, message, providerCode);
}

function providerErrorCategory(error: unknown) {
  return error && typeof error === "object" && "category" in error
    && typeof (error as { category?: unknown }).category === "string"
    ? (error as { category: string }).category
    : null;
}

function providerErrorCode(error: unknown) {
  const value = error && typeof error === "object" && "providerCode" in error
    ? (error as { providerCode?: unknown }).providerCode
    : null;
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/u.test(value)
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : null;
}

function attachPositionMode<T extends object>(order: T, mode: "ONE_WAY" | "HEDGE" | undefined): T & { positionMode?: "ONE_WAY" | "HEDGE" } {
  if (mode === undefined) return Object.freeze(order) as T & { positionMode?: "ONE_WAY" | "HEDGE" };
  Object.defineProperty(order, "positionMode", { value: mode, enumerable: false, writable: false });
  return Object.freeze(order) as T & { positionMode?: "ONE_WAY" | "HEDGE" };
}

export function okxClientOrderIdFor(
  intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId" | "positionDirection">,
) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}\u0000${intent.positionDirection ?? "LEGACY_ONE_WAY"}`;
  return `sxokx${createHash("sha256").update(identity).digest("hex").slice(0, 27)}`;
}

function assertIntentMatchesInstrument(intent: ExecutionIntent, instrument: OkxInstrumentResolution) {
  if (intent.quantity.asset.symbol !== instrument.canonicalInstrument.baseAsset) {
    throw new Error("OKX intent quantity asset does not match the canonical instrument base asset.");
  }
  if (instrument.canonicalInstrument.contractType !== "perpetual") {
    throw new Error("OKX execution supports USDT linear perpetual instruments only.");
  }
}

function assertAcceptedIdentity(accepted: OkxCancelOrderResult, prepared: OkxPlaceOrderRequest) {
  if (
    accepted.instId !== prepared.instId
    || accepted.clOrdId !== prepared.clOrdId
  ) {
    throw new Error("OKX submit response identity does not match the exact execution order.");
  }
}

function observationForOrder(
  order: OkxProviderOrder,
  lookup: OkxExecutionOrderLookup,
  rules: Awaited<ReturnType<typeof loadOkxQuantityRules>>,
  observedAt: number,
  expectedTdMode: "cross" | "isolated",
): Readonly<{ observation: ExecutionQueryObservation; statusReason: string | null }> {
  const finalObservedAt = order.updatedAt === null ? observedAt : Math.max(order.updatedAt, observedAt);
  if (lookup.expectedSide !== undefined && order.side !== lookup.expectedSide) {
    return unknown("OKX Provider side does not match the execution reference.", finalObservedAt);
  }
  if (lookup.expectedProviderQuantity !== undefined
    && !decimalEquals(order.requestedQuantity, lookup.expectedProviderQuantity)) {
    return unknown("OKX Provider quantity does not match the execution reference.", finalObservedAt);
  }
  if (lookup.positionMode === "HEDGE" && order.posSide !== lookup.posSide) {
    return unknown("OKX Provider posSide does not match the execution bucket.", finalObservedAt);
  }
  if (lookup.positionMode === "ONE_WAY" && order.posSide !== "net") {
    return unknown("OKX Provider posSide does not confirm ONE_WAY net mode.", finalObservedAt);
  }
  if (order.tdMode !== undefined && order.tdMode !== expectedTdMode) {
    return unknown("OKX Provider tdMode does not match the execution reference.", finalObservedAt);
  }
  const expectedReduceOnly = reduceOnlySemantic(lookup);
  if (lookup.positionMode === "ONE_WAY" && (expectedReduceOnly === null || order.reduceOnly !== expectedReduceOnly)) {
    return unknown("OKX Provider reduceOnly does not match the execution semantic.", finalObservedAt);
  }
  let filledBaseQuantity: string;
  try {
    filledBaseQuantity = okxContractQuantityToBase(order.filledQuantity, rules);
    if (lookup.expectedProviderQuantity !== undefined) {
      const requestedBaseQuantity = okxContractQuantityToBase(lookup.expectedProviderQuantity, rules);
      if (compareDecimal(filledBaseQuantity, requestedBaseQuantity) > 0) {
        return unknown("OKX cumulative fill exceeds the canonical execution quantity.", finalObservedAt);
      }
    }
  } catch {
    return unknown("OKX cumulative fill cannot be converted to canonical base quantity.", finalObservedAt);
  }
  if (order.status === "CONFIRMED" && lookup.expectedProviderQuantity !== undefined
    && !decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)) {
    return unknown("OKX filled order does not complete the submitted quantity.", finalObservedAt);
  }
  const state = order.status === "FAILED" && order.rawState === "canceled"
    && lookup.expectedProviderQuantity !== undefined
    && decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)
    ? "CONFIRMED" as const
    : queryStateFor(order.status);
  return Object.freeze({ observation: createExecutionQueryObservation({
    state,
    filledBaseQuantity,
    observedAt: finalObservedAt,
  }), statusReason: order.statusReason });
}

function reduceOnlySemantic(lookup: OkxExecutionOrderLookup) {
  if (!lookup.expectedSide) return null;
  if (!lookup.positionDirection) return false;
  return lookup.positionDirection === "LONG" ? lookup.expectedSide === "sell" : lookup.expectedSide === "buy";
}

function unknown(statusReason: string, observedAt: number) {
  return Object.freeze({
    observation: createExecutionQueryObservation({ state: "UNKNOWN", filledBaseQuantity: "0", observedAt }),
    statusReason,
  });
}

function queryStateFor(status: OkxProviderOrder["status"]): ExecutionQueryObservation["state"] {
  if (status === "CONFIRMED") return "CONFIRMED";
  if (status === "SUBMITTED" || status === "PENDING_CONFIRMATION") return "PENDING_CONFIRMATION";
  if (status === "FAILED") return "FAILED";
  return "UNKNOWN";
}

function decimalQuantity(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new Error("OKX Decimal quantity or price must be an unsigned positive decimal string.");
  }
  return value;
}

function decimalEquals(left: string, right: string) {
  return canonicalDecimal(left) === canonicalDecimal(right);
}

function compareDecimal(left: string, right: string) {
  const [li, lf = ""] = canonicalDecimal(left).split(".");
  const [ri, rf = ""] = canonicalDecimal(right).split(".");
  const scale = Math.max(lf.length, rf.length);
  const a = BigInt(`${li}${lf.padEnd(scale, "0")}`);
  const b = BigInt(`${ri}${rf.padEnd(scale, "0")}`);
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalDecimal(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const normalized = fraction.replace(/0+$/u, "");
  return normalized ? `${integer}.${normalized}` : integer!;
}
