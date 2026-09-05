import { createHash } from "node:crypto";
import { createExecutionCancelObservation, type ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import { runExecutionPreMutationPhase } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionQueryObservation, type ExecutionQueryObservation } from "../cex/ExecutionQueryCapability";
import type { ExecutionStatus } from "../cex/ExecutionState";
import { createExecutionAccountingEvidence } from "../cex/ExecutionAccountingEvidence";
import {
  isTrustedVerifiedManagedCloseNativeExecutionRules,
  type FormalManagedCloseExecutionContext,
  type VerifiedManagedCloseNativeExecutionRules,
} from "../arbitrage-execution/FormalExecutionRuntime";
import {
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
  type ExecutionMutationEffect,
  type ExecutionProviderIdentityValidator,
} from "../cex/ExecutionMutationSafetyGuard";
import { BybitInstrumentMappingAdapter, type BybitInstrumentResolution } from "./BybitInstrumentMapping";
import {
  BYBIT_QUANTITY_RULES_MAX_AGE_MS,
  bybitBaseQuantityToProvider,
  bybitProviderQuantityToBase,
  loadBybitQuantityRules,
  type BybitQuantityRulesSource,
} from "./BybitQuantitySemantics";
import type {
  BybitCancelOrderRequest,
  BybitGetOrderRequest,
  BybitMarketUnit,
  BybitOrderIdentity,
  BybitOrderSide,
  BybitPlaceOrderRequest,
  BybitPlaceOrderResult,
  BybitPositionIdx,
  BybitProviderOrder,
} from "./BybitTypes";

export type BybitIntentExecutionClient = Readonly<{
  getLinearPositionIdx(symbol: string): Promise<0>;
  readLinearPositionMode?(symbol: string): Promise<"ONE_WAY" | "HEDGE">;
  placeOrder(request: BybitPlaceOrderRequest): Promise<BybitPlaceOrderResult>;
  getOrder(request: BybitGetOrderRequest): Promise<BybitProviderOrder>;
  cancelOrder(request: BybitCancelOrderRequest): Promise<BybitOrderIdentity>;
}>;

export type BybitLimitPriceResolver = (
  intent: ExecutionIntent,
  instrument: BybitInstrumentResolution,
) => Promise<string> | string;

export type BybitIntentExecutionServiceOptions = Readonly<{
  instrumentMapping?: BybitInstrumentMappingAdapter;
  limitPriceResolver?: BybitLimitPriceResolver;
  quantityRulesSource?: BybitQuantityRulesSource;
  quantityRulesMaxAgeMs?: number;
  clock?: () => number;
  mutationSafetyGuard?: ExecutionMutationSafetyGuard;
  mutationEffect?: ExecutionMutationEffect;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (reference: Readonly<{
    category: "spot" | "linear";
    symbol: string;
    orderLinkId: string;
    expectedProviderQuantity: string;
    expectedSide: BybitOrderSide;
    marketUnit?: BybitMarketUnit;
    positionIdx?: BybitPositionIdx;
    positionMode?: "ONE_WAY" | "HEDGE";
    positionDirection?: "LONG" | "SHORT";
  }>) => Promise<void> | void;
  verifiedCloseContext?: FormalManagedCloseExecutionContext;
}>;

export type BybitExecutionOrderIdentity = Readonly<BybitOrderIdentity>;

export type BybitIntentExecutionResult = Readonly<{
  executionAttemptId: string;
  providerOrderId: string;
  clientOrderId: string;
  category: "spot" | "linear";
  symbol: string;
  orderIdentity: BybitExecutionOrderIdentity;
  state: ExecutionStatus;
  confirmedQuantity: string;
  statusReason: string | null;
  expectedProviderQuantity: string;
  expectedSide: BybitOrderSide;
  marketUnit?: BybitMarketUnit;
  positionIdx?: BybitPositionIdx;
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
}>;

export type BybitExecutionQueryResult = Readonly<{
  observation: ExecutionQueryObservation;
  orderIdentity: BybitExecutionOrderIdentity;
  fee: string;
  feeCurrency: string | null;
  statusReason: string | null;
}>;

export type BybitExecutionOrderLookup = Readonly<{
  instrumentId: string;
  category: "spot" | "linear";
  symbol: string;
  orderId?: string;
  orderLinkId: string;
  expectedProviderQuantity: string;
  expectedSide: BybitOrderSide;
  marketUnit?: BybitMarketUnit;
  positionIdx?: BybitPositionIdx;
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
}>;

export class BybitIntentExecutionService {
  private readonly instruments: BybitInstrumentMappingAdapter;
  private readonly clock: () => number;
  private readonly mutationSafetyGuard: ExecutionMutationSafetyGuard;

  constructor(
    private readonly client: BybitIntentExecutionClient,
    private readonly options: BybitIntentExecutionServiceOptions = {},
  ) {
    this.instruments = options.instrumentMapping ?? new BybitInstrumentMappingAdapter();
    this.clock = options.clock ?? Date.now;
    this.mutationSafetyGuard = options.mutationSafetyGuard ?? new ExecutionMutationSafetyGuard();
  }

  async execute(intent: ExecutionIntent): Promise<BybitIntentExecutionResult> {
    if (intent.venue !== "bybit") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    const prepared = await runExecutionPreMutationPhase(async () => {
      const value = await this.prepare(intent);
      const persistRecoveryReference = this.options.persistRecoveryReference;
      if (!persistRecoveryReference) throw new Error("Bybit recovery reference persistence is required before mutation.");
      await this.mutationSafetyGuard.assertAllowed({
        venue: "bybit",
        operation: "placeOrder",
        userId: intent.userId,
        accountId: intent.accountId,
        instrumentId: intent.instrumentId,
        providerInstrumentId: value.symbol,
        executionIntentId: intent.intentId,
        mutationPreparedAt: this.now(),
        ...(this.options.verifiedCloseContext === undefined ? {} : {
          verifiedProviderIdentity: this.options.verifiedCloseContext.verifiedProviderIdentity,
        }),
        ...(this.options.mutationEffect === undefined ? {} : { mutationEffect: this.options.mutationEffect }),
      }, this.options.validateProviderIdentity);
      await persistRecoveryReference({
        category: value.category,
        symbol: value.symbol,
        orderLinkId: value.orderLinkId,
        expectedProviderQuantity: value.qty,
        expectedSide: value.side,
        ...(value.marketUnit === undefined ? {} : { marketUnit: value.marketUnit }),
        ...(value.positionIdx === undefined ? {} : { positionIdx: value.positionIdx }),
        ...(value.positionMode === undefined ? {} : { positionMode: value.positionMode }),
        ...(value.positionDirection === undefined ? {} : { positionDirection: value.positionDirection }),
      });
      return value;
    });
    const accepted = await this.client.placeOrder(prepared);
    assertAcceptedIdentity(accepted, prepared);
    return Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: accepted.orderId,
      clientOrderId: accepted.orderLinkId,
      category: accepted.category,
      symbol: accepted.symbol,
      orderIdentity: accepted,
      state: "SUBMITTED",
      confirmedQuantity: "0",
      statusReason: null,
      expectedProviderQuantity: prepared.qty,
      expectedSide: prepared.side,
      ...(prepared.marketUnit === undefined ? {} : { marketUnit: prepared.marketUnit }),
      ...(prepared.positionIdx === undefined ? {} : { positionIdx: prepared.positionIdx }),
      ...(prepared.positionMode === undefined ? {} : { positionMode: prepared.positionMode }),
      ...(prepared.positionDirection === undefined ? {} : { positionDirection: prepared.positionDirection }),
    });
  }

  async query(lookup: BybitExecutionOrderLookup): Promise<BybitExecutionQueryResult> {
    const instrument = this.instruments.resolve(lookup.instrumentId);
    assertLookupInstrument(lookup, instrument);
    const rules = await loadBybitQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      () => this.now(),
      this.options.quantityRulesMaxAgeMs ?? BYBIT_QUANTITY_RULES_MAX_AGE_MS,
    );
    const observedAt = this.now();
    const order = await this.client.getOrder({
      category: lookup.category,
      symbol: lookup.symbol,
      ...(lookup.orderId === undefined ? {} : { orderId: lookup.orderId }),
      orderLinkId: lookup.orderLinkId,
    });
    const result = observationForOrder(order, lookup, rules, observedAt);
    return Object.freeze({
      observation: result.observation,
      orderIdentity: Object.freeze({
        category: order.category,
        symbol: order.symbol,
        orderId: order.orderId,
        orderLinkId: order.orderLinkId,
      }),
      fee: order.fee,
      feeCurrency: order.feeCurrency,
      statusReason: result.statusReason ?? order.statusReason,
    });
  }

  async cancel(
    lookup: BybitExecutionOrderLookup,
    context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & { providerInstrumentId?: string },
  ): Promise<ExecutionCancelObservation> {
    await this.mutationSafetyGuard.assertAllowed({
      venue: "bybit",
      operation: "cancelOrder",
      userId: context.userId,
      accountId: context.accountId,
      instrumentId: context.instrumentId,
      providerInstrumentId: context.providerInstrumentId ?? lookup.symbol,
    }, this.options.validateProviderIdentity);
    const cancelled = await this.client.cancelOrder({
      category: lookup.category,
      symbol: lookup.symbol,
      ...(lookup.orderId === undefined ? {} : { orderId: lookup.orderId }),
      orderLinkId: lookup.orderLinkId,
    });
    if (cancelled.category !== lookup.category || cancelled.symbol !== lookup.symbol
      || cancelled.orderLinkId !== lookup.orderLinkId
      || (lookup.orderId !== undefined && cancelled.orderId !== lookup.orderId)) {
      throw new Error("Bybit cancel response identity does not match the execution order.");
    }
    return createExecutionCancelObservation({ state: "CANCEL_REQUESTED", observedAt: this.now() });
  }

  private async prepare(intent: ExecutionIntent): Promise<BybitPlaceOrderRequest> {
    const instrument = this.instruments.resolve(intent.instrumentId);
    if (intent.quantity.asset.symbol !== instrument.canonicalInstrument.baseAsset) {
      throw new Error("Bybit intent quantity asset does not match the canonical instrument base asset.");
    }
    if (instrument.venueInstrument.category === "spot" && intent.orderConstraints.reduceOnly) {
      throw new Error("Bybit Spot execution must not use reduceOnly.");
    }
    const verifiedRules = this.verifiedNativeRulesFor(intent, instrument);
    const rules = verifiedRules === null
      ? await loadBybitQuantityRules(
        this.options.quantityRulesSource,
        instrument,
        () => this.now(),
        this.options.quantityRulesMaxAgeMs ?? BYBIT_QUANTITY_RULES_MAX_AGE_MS,
      )
      : bybitRulesFromVerifiedFacts(verifiedRules, instrument);
    const category = instrument.venueInstrument.category;
    const positionMode = category === "linear"
      ? await this.positionModeFor(intent, instrument.venueInstrument.symbol)
      : undefined;
    if (positionMode === "HEDGE" && intent.positionDirection === undefined) {
      throw new Error("Bybit HEDGE execution requires positionDirection.");
    }
    if (positionMode === "HEDGE" && intent.orderConstraints.reduceOnly
      && ((intent.positionDirection === "LONG" && intent.side !== "sell")
        || (intent.positionDirection === "SHORT" && intent.side !== "buy"))) {
      throw new Error("Bybit HEDGE close side does not reduce the selected position bucket.");
    }
    const base = {
      category,
      symbol: instrument.venueInstrument.symbol,
      side: intent.side === "buy" ? "Buy" as const : "Sell" as const,
      qty: bybitBaseQuantityToProvider(intent.quantity.quantity, rules),
      orderLinkId: bybitOrderLinkIdFor(intent),
      ...(category === "linear" ? {
        reduceOnly: intent.orderConstraints.reduceOnly,
        positionIdx: positionMode === "HEDGE"
          ? intent.positionDirection === "LONG" ? 1 as const : 2 as const
          : this.options.verifiedCloseContext === undefined
            ? await this.client.getLinearPositionIdx(instrument.venueInstrument.symbol)
            : 0 as const,
        positionMode,
        ...(positionMode === undefined ? {} : { positionDirection: intent.positionDirection }),
      } : {}),
    };
    if (intent.executionMode === "EXECUTION_PRIORITY") {
      return Object.freeze({
        ...base,
        orderType: "Market" as const,
        ...(category === "spot" ? { marketUnit: "baseCoin" as const } : {}),
      });
    }
    if (!this.options.limitPriceResolver) throw new Error("Bybit PRICE_PRIORITY execution requires an explicit limit price resolver.");
    return Object.freeze({
      ...base,
      orderType: "Limit" as const,
      price: positiveDecimal(await this.options.limitPriceResolver(intent, instrument), "Bybit limit price"),
    });
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bybit execution clock is invalid.");
    return value;
  }

  private async positionModeFor(intent: ExecutionIntent, symbol: string) {
    const verified = this.options.verifiedCloseContext;
    if (verified === undefined) {
      return this.client.readLinearPositionMode
        ? this.client.readLinearPositionMode(symbol)
        : undefined;
    }
    if (!intent.orderConstraints.reduceOnly
      || verified.reduceOnly !== true
      || verified.side !== intent.side
      || verified.positionDirection !== intent.positionDirection
      || verified.legalizedCloseQuantity !== intent.quantity.quantity) {
      throw new Error("Bybit verified close context does not match the execution intent.");
    }
    return verified.positionMode;
  }

  private verifiedNativeRulesFor(
    intent: ExecutionIntent,
    instrument: BybitInstrumentResolution,
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
      || rules.venue !== "bybit"
      || rules.canonicalInstrumentId !== intent.instrumentId
      || rules.providerInstrumentId !== instrument.venueInstrument.symbol
      || rules.executionIntentId !== intent.intentId
      || rules.instrumentState !== "live"
      || rules.contractType !== "linear"
      || rules.contractValueCurrency !== instrument.canonicalInstrument.baseAsset
      || rules.settlementAsset !== instrument.canonicalInstrument.quoteAsset
      || rules.contractValue !== "1"
      || rules.canonicalSafeCloseQuantity !== close.safeClosableQuantity
      || rules.legalizedCanonicalCloseQuantity !== close.legalizedCloseQuantity
      || rules.legalizedCanonicalCloseQuantity !== intent.quantity.quantity
      || rules.providerNativeQuantity !== intent.quantity.quantity
      || rules.verifiedAt > now
      || now - rules.verifiedAt > 15_000) {
      throw new Error("Bybit verified native execution rules are invalid, stale, or outside this mutation attempt.");
    }
    return rules;
  }
}

function bybitRulesFromVerifiedFacts(
  rules: VerifiedManagedCloseNativeExecutionRules,
  instrument: BybitInstrumentResolution,
) {
  return Object.freeze({
    category: instrument.venueInstrument.category,
    symbol: rules.providerInstrumentId,
    status: "Trading",
    baseCoin: rules.contractValueCurrency,
    quoteCoin: rules.settlementAsset,
    settleCoin: rules.settlementAsset,
    qtyStep: rules.lotSize,
    minOrderQty: rules.minimumSize,
    minNotionalValue: rules.minimumNotional,
    fetchedAt: rules.verifiedAt,
  });
}

export function bybitOrderLinkIdFor(intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId" | "positionDirection">) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}\u0000${intent.positionDirection ?? "LEGACY_ONE_WAY"}`;
  return `sxby${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function assertAcceptedIdentity(accepted: BybitPlaceOrderResult, request: BybitPlaceOrderRequest) {
  if (accepted.category !== request.category || accepted.symbol !== request.symbol || accepted.orderLinkId !== request.orderLinkId) {
    throw new Error("Bybit submit response identity does not match the exact execution order.");
  }
}

function assertLookupInstrument(lookup: BybitExecutionOrderLookup, instrument: BybitInstrumentResolution) {
  if (lookup.category !== instrument.venueInstrument.category || lookup.symbol !== instrument.venueInstrument.symbol) {
    throw new Error("Bybit order lookup instrument identity does not match the mapped instrument.");
  }
  if (lookup.category === "linear" && (lookup.marketUnit !== undefined
    || (lookup.positionMode === "ONE_WAY" && lookup.positionIdx !== 0)
    || (lookup.positionMode === "HEDGE" && lookup.positionIdx !== (lookup.positionDirection === "LONG" ? 1 : 2)))) {
    throw new Error("Bybit Linear order lookup position facts are inconsistent.");
  }
  if (lookup.category === "spot" && lookup.positionIdx !== undefined) {
    throw new Error("Bybit Spot order lookup must not contain positionIdx.");
  }
}

function observationForOrder(
  order: BybitProviderOrder,
  lookup: BybitExecutionOrderLookup,
  rules: Awaited<ReturnType<typeof loadBybitQuantityRules>>,
  observedAt: number,
) {
  const filled = safeBaseQuantity(order.filledQuantity, rules);
  if (filled === null) return unknown("Bybit cumulative fill does not satisfy quantity rules.", observedAt);
  if (order.category !== lookup.category || order.symbol !== lookup.symbol
    || order.orderLinkId !== lookup.orderLinkId
    || (lookup.orderId !== undefined && order.orderId !== lookup.orderId)) {
    return unknown("Bybit Provider order identity does not match the execution reference.", observedAt);
  }
  if (order.side !== lookup.expectedSide) return unknown("Bybit Provider side does not match the expected execution side.", observedAt);
  if (!decimalEquals(order.requestedQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bybit Provider quantity does not match the expected execution quantity.", observedAt);
  }
  if (compareDecimal(order.filledQuantity, lookup.expectedProviderQuantity) > 0) {
    return unknown("Bybit cumulative fill exceeds the expected execution quantity.", observedAt);
  }
  if (lookup.category === "linear" && order.positionIdx !== lookup.positionIdx) {
    return unknown("Bybit Provider positionIdx does not match the persisted execution bucket.", observedAt);
  }
  if (lookup.category === "linear") {
    const expectedReduceOnly = reduceOnlySemantic(lookup);
    if (expectedReduceOnly === null || order.reduceOnly !== expectedReduceOnly) {
      return unknown("Bybit Provider reduceOnly does not match the execution semantic.", observedAt);
    }
  }
  if (order.marketUnit !== undefined && order.marketUnit !== lookup.marketUnit) {
    return unknown("Bybit Provider marketUnit does not match the execution reference.", observedAt);
  }
  const finalObservedAt = order.updatedAt === null ? observedAt : Math.max(observedAt, order.updatedAt);
  if (order.status === "UNKNOWN") return unknown("Bybit Provider order state is unknown.", finalObservedAt, filled);
  if (order.status === "CONFIRMED" && !decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bybit filled order does not complete the submitted quantity.", finalObservedAt, filled);
  }
  const normalizedStatus = order.status === "FAILED"
    && (order.rawStatus === "Cancelled" || order.rawStatus === "PartiallyFilledCanceled")
    && decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)
    ? "CONFIRMED" as const
    : order.status;
  const observation = createExecutionQueryObservation({
    state: normalizedStatus === "SUBMITTED" ? "PENDING_CONFIRMATION" : normalizedStatus,
    filledBaseQuantity: filled,
    observedAt: finalObservedAt,
    accountingEvidence: createExecutionAccountingEvidence({
      providerOrderId: order.orderId,
      filledQuantity: filled,
      averageFillPrice: order.averagePrice,
      feeAmountProvider: order.fee,
      feeAsset: order.feeCurrency,
      tradingFeeNetCostUsdt: order.feeCurrency === "USDT" ? order.fee : null,
      confirmedAt: finalObservedAt,
      completeness: order.averagePrice !== null && order.feeCurrency === "USDT" ? "COMPLETE" : "INCOMPLETE",
    }),
  });
  return Object.freeze({ observation, statusReason: null as string | null });
}

function reduceOnlySemantic(lookup: BybitExecutionOrderLookup) {
  // Legacy/generic ONE_WAY opening references predate positionDirection. They
  // can prove only a non-reduce opening; a close still requires direction.
  if (!lookup.positionDirection) return false;
  return lookup.positionDirection === "LONG" ? lookup.expectedSide === "Sell" : lookup.expectedSide === "Buy";
}

function unknown(statusReason: string, observedAt: number, filledBaseQuantity = "0") {
  return Object.freeze({
    observation: createExecutionQueryObservation({ state: "UNKNOWN", filledBaseQuantity, observedAt }),
    statusReason,
  });
}

function safeBaseQuantity(quantity: string, rules: Parameters<typeof bybitProviderQuantityToBase>[1]) {
  try { return bybitProviderQuantityToBase(quantity, rules); } catch { return null; }
}

function positiveDecimal(value: string, label: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function decimalEquals(left: string, right: string) { return canonicalDecimal(left) === canonicalDecimal(right); }
function compareDecimal(left: string, right: string) {
  const [li, lf = ""] = left.split(".");
  const [ri, rf = ""] = right.split(".");
  const scale = Math.max(lf.length, rf.length);
  const lv = BigInt(`${li}${lf.padEnd(scale, "0")}`);
  const rv = BigInt(`${ri}${rf.padEnd(scale, "0")}`);
  return lv < rv ? -1 : lv > rv ? 1 : 0;
}
function canonicalDecimal(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const normalized = fraction.replace(/0+$/u, "");
  return normalized ? `${integer}.${normalized}` : integer!;
}
