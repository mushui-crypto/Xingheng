import { createHash } from "node:crypto";
import { createExecutionCancelObservation, type ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import { runExecutionPreMutationPhase } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionQueryObservation, type ExecutionQueryObservation } from "../cex/ExecutionQueryCapability";
import type { ExecutionStatus } from "../cex/ExecutionState";
import {
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
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
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (reference: Readonly<{
    category: "spot" | "linear";
    symbol: string;
    orderLinkId: string;
    expectedProviderQuantity: string;
    expectedSide: BybitOrderSide;
    marketUnit?: BybitMarketUnit;
    positionIdx?: BybitPositionIdx;
  }>) => Promise<void> | void;
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
      }, this.options.validateProviderIdentity);
      await persistRecoveryReference({
        category: value.category,
        symbol: value.symbol,
        orderLinkId: value.orderLinkId,
        expectedProviderQuantity: value.qty,
        expectedSide: value.side,
        ...(value.marketUnit === undefined ? {} : { marketUnit: value.marketUnit }),
        ...(value.positionIdx === undefined ? {} : { positionIdx: value.positionIdx }),
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
    const rules = await loadBybitQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      () => this.now(),
      this.options.quantityRulesMaxAgeMs ?? BYBIT_QUANTITY_RULES_MAX_AGE_MS,
    );
    const category = instrument.venueInstrument.category;
    const base = {
      category,
      symbol: instrument.venueInstrument.symbol,
      side: intent.side === "buy" ? "Buy" as const : "Sell" as const,
      qty: bybitBaseQuantityToProvider(intent.quantity.quantity, rules),
      orderLinkId: bybitOrderLinkIdFor(intent),
      ...(category === "linear" ? {
        reduceOnly: intent.orderConstraints.reduceOnly,
        positionIdx: await this.client.getLinearPositionIdx(instrument.venueInstrument.symbol),
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
}

export function bybitOrderLinkIdFor(intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId">) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}`;
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
  if (lookup.category === "linear" && (lookup.positionIdx !== 0 || lookup.marketUnit !== undefined)) {
    throw new Error("Bybit Linear order lookup requires positionIdx=0.");
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
    return unknown("Bybit Provider order identity does not match the execution reference.", observedAt, filled);
  }
  if (order.side !== lookup.expectedSide) return unknown("Bybit Provider side does not match the expected execution side.", observedAt, filled);
  if (!decimalEquals(order.requestedQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bybit Provider quantity does not match the expected execution quantity.", observedAt, filled);
  }
  if (compareDecimal(order.filledQuantity, lookup.expectedProviderQuantity) > 0) {
    return unknown("Bybit cumulative fill exceeds the expected execution quantity.", observedAt, filled);
  }
  if (lookup.category === "linear" && order.positionIdx !== 0) {
    return unknown("Bybit Provider positionIdx does not match one-way execution.", observedAt, filled);
  }
  if (order.marketUnit !== undefined && order.marketUnit !== lookup.marketUnit) {
    return unknown("Bybit Provider marketUnit does not match the execution reference.", observedAt, filled);
  }
  const finalObservedAt = order.updatedAt === null ? observedAt : Math.max(observedAt, order.updatedAt);
  if (order.status === "UNKNOWN") return unknown("Bybit Provider order state is unknown.", finalObservedAt, filled);
  if (order.status === "CONFIRMED" && !decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bybit filled order does not complete the submitted quantity.", finalObservedAt, filled);
  }
  const observation = createExecutionQueryObservation({
    state: order.status === "SUBMITTED" ? "PENDING_CONFIRMATION" : order.status,
    filledBaseQuantity: filled,
    observedAt: finalObservedAt,
  });
  return Object.freeze({ observation, statusReason: null as string | null });
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
