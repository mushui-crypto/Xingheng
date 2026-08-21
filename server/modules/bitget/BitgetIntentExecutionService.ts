import { createHash } from "node:crypto";
import { createExecutionCancelObservation, type ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import { runExecutionPreMutationPhase } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionQueryObservation, type ExecutionQueryObservation } from "../cex/ExecutionQueryCapability";
import type { ExecutionStatus } from "../cex/ExecutionState";
import { ExecutionMutationSafetyGuard, type ExecutionMutationContext, type ExecutionProviderIdentityValidator } from "../cex/ExecutionMutationSafetyGuard";
import { BitgetInstrumentMappingAdapter, type BitgetInstrumentResolution } from "./BitgetInstrumentMapping";
import {
  BITGET_QUANTITY_RULES_MAX_AGE_MS,
  bitgetBaseQuantityToProvider,
  bitgetProviderQuantityToBase,
  loadBitgetQuantityRules,
  type BitgetQuantityRulesSource,
} from "./BitgetQuantitySemantics";
import type {
  BitgetCancelOrderRequest,
  BitgetGetOrderRequest,
  BitgetOrderIdentity,
  BitgetOrderSide,
  BitgetPlaceOrderRequest,
  BitgetPlaceOrderResult,
  BitgetProviderOrder,
} from "./BitgetTypes";

export type BitgetIntentExecutionClient = Readonly<{
  assertOneWayMode(): Promise<void>;
  placeOrder(request: BitgetPlaceOrderRequest): Promise<BitgetPlaceOrderResult>;
  getOrder(request: BitgetGetOrderRequest): Promise<BitgetProviderOrder>;
  cancelOrder(request: BitgetCancelOrderRequest): Promise<BitgetOrderIdentity>;
}>;

export type BitgetLimitPriceResolver = (
  intent: ExecutionIntent,
  instrument: BitgetInstrumentResolution,
) => Promise<string> | string;

export type BitgetIntentExecutionServiceOptions = Readonly<{
  instrumentMapping?: BitgetInstrumentMappingAdapter;
  limitPriceResolver?: BitgetLimitPriceResolver;
  quantityRulesSource?: BitgetQuantityRulesSource;
  quantityRulesMaxAgeMs?: number;
  clock?: () => number;
  mutationSafetyGuard?: ExecutionMutationSafetyGuard;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (reference: Readonly<{
    category: "SPOT" | "USDT-FUTURES";
    symbol: string;
    clientOid: string;
    expectedProviderQuantity: string;
    expectedSide: BitgetOrderSide;
  }>) => Promise<void> | void;
}>;

export type BitgetIntentExecutionResult = Readonly<{
  executionAttemptId: string;
  providerOrderId: string;
  clientOrderId: string;
  category: "SPOT" | "USDT-FUTURES";
  symbol: string;
  orderIdentity: BitgetOrderIdentity;
  state: ExecutionStatus;
  confirmedQuantity: string;
  statusReason: string | null;
  expectedProviderQuantity: string;
  expectedSide: BitgetOrderSide;
}>;

export type BitgetExecutionQueryResult = Readonly<{
  observation: ExecutionQueryObservation;
  orderIdentity: BitgetOrderIdentity;
  fee: string;
  feeCurrency: string | null;
  statusReason: string | null;
}>;

export type BitgetExecutionOrderLookup = Readonly<{
  instrumentId: string;
  category: "SPOT" | "USDT-FUTURES";
  symbol: string;
  orderId?: string;
  clientOid: string;
  expectedProviderQuantity: string;
  expectedSide: BitgetOrderSide;
}>;

export class BitgetIntentExecutionService {
  private readonly instruments: BitgetInstrumentMappingAdapter;
  private readonly clock: () => number;
  private readonly mutationSafetyGuard: ExecutionMutationSafetyGuard;

  constructor(private readonly client: BitgetIntentExecutionClient, private readonly options: BitgetIntentExecutionServiceOptions = {}) {
    this.instruments = options.instrumentMapping ?? new BitgetInstrumentMappingAdapter();
    this.clock = options.clock ?? Date.now;
    this.mutationSafetyGuard = options.mutationSafetyGuard ?? new ExecutionMutationSafetyGuard();
  }

  async execute(intent: ExecutionIntent): Promise<BitgetIntentExecutionResult> {
    if (intent.venue !== "bitget") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    const prepared = await runExecutionPreMutationPhase(async () => {
      const value = await this.prepare(intent);
      const validateProviderIdentity = this.requiredIdentityValidator();
      const persistRecoveryReference = this.options.persistRecoveryReference;
      if (!persistRecoveryReference) throw new Error("Bitget recovery reference persistence is required before mutation.");
      await this.mutationSafetyGuard.assertAllowed({
        venue: "bitget", operation: "placeOrder", userId: intent.userId, accountId: intent.accountId,
        instrumentId: intent.instrumentId, providerInstrumentId: value.symbol,
      }, validateProviderIdentity);
      await persistRecoveryReference({
        category: value.category, symbol: value.symbol, clientOid: value.clientOid,
        expectedProviderQuantity: value.qty, expectedSide: value.side,
      });
      return value;
    });
    const accepted = await this.client.placeOrder(prepared);
    assertAcceptedIdentity(accepted, prepared);
    return Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: accepted.orderId,
      clientOrderId: accepted.clientOid,
      category: accepted.category,
      symbol: accepted.symbol,
      orderIdentity: accepted,
      state: "SUBMITTED",
      confirmedQuantity: "0",
      statusReason: null,
      expectedProviderQuantity: prepared.qty,
      expectedSide: prepared.side,
    });
  }

  async query(lookup: BitgetExecutionOrderLookup): Promise<BitgetExecutionQueryResult> {
    const instrument = this.instruments.resolve(lookup.instrumentId);
    assertLookupInstrument(lookup, instrument);
    const rules = await loadBitgetQuantityRules(this.options.quantityRulesSource, instrument, () => this.now(),
      this.options.quantityRulesMaxAgeMs ?? BITGET_QUANTITY_RULES_MAX_AGE_MS);
    const observedAt = this.now();
    const order = await this.client.getOrder({
      category: lookup.category, symbol: lookup.symbol,
      ...(lookup.orderId === undefined ? {} : { orderId: lookup.orderId }), clientOid: lookup.clientOid,
    });
    const result = observationForOrder(order, lookup, rules, observedAt);
    return Object.freeze({
      observation: result.observation,
      orderIdentity: Object.freeze({ category: order.category, symbol: order.symbol, orderId: order.orderId, clientOid: order.clientOid }),
      fee: order.fee,
      feeCurrency: order.feeCurrency,
      statusReason: result.statusReason,
    });
  }

  async cancel(
    lookup: BitgetExecutionOrderLookup,
    context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & { providerInstrumentId?: string },
  ): Promise<ExecutionCancelObservation> {
    const instrument = this.instruments.resolve(lookup.instrumentId);
    assertLookupInstrument(lookup, instrument);
    if (lookup.category === "USDT-FUTURES") await this.client.assertOneWayMode();
    await this.mutationSafetyGuard.assertAllowed({
      venue: "bitget", operation: "cancelOrder", userId: context.userId, accountId: context.accountId,
      instrumentId: context.instrumentId, providerInstrumentId: context.providerInstrumentId ?? lookup.symbol,
    }, this.requiredIdentityValidator());
    const cancelled = await this.client.cancelOrder({
      category: lookup.category, symbol: lookup.symbol,
      ...(lookup.orderId === undefined ? {} : { orderId: lookup.orderId }), clientOid: lookup.clientOid,
    });
    if (cancelled.category !== lookup.category || cancelled.symbol !== lookup.symbol || cancelled.clientOid !== lookup.clientOid
      || (lookup.orderId !== undefined && cancelled.orderId !== lookup.orderId)) {
      throw new Error("Bitget cancel response identity does not match the execution order.");
    }
    return createExecutionCancelObservation({ state: "CANCEL_REQUESTED", observedAt: this.now() });
  }

  private async prepare(intent: ExecutionIntent): Promise<BitgetPlaceOrderRequest> {
    const instrument = this.instruments.resolve(intent.instrumentId);
    if (intent.quantity.asset.symbol !== instrument.canonicalInstrument.baseAsset) {
      throw new Error("Bitget intent quantity asset does not match the canonical instrument base asset.");
    }
    const category = instrument.venueInstrument.category;
    if (category === "SPOT" && intent.orderConstraints.reduceOnly) throw new Error("Bitget Spot execution must not use reduceOnly.");
    if (category === "USDT-FUTURES") await this.client.assertOneWayMode();
    const rules = await loadBitgetQuantityRules(this.options.quantityRulesSource, instrument, () => this.now(),
      this.options.quantityRulesMaxAgeMs ?? BITGET_QUANTITY_RULES_MAX_AGE_MS);
    const base = {
      category,
      symbol: instrument.venueInstrument.symbol,
      side: intent.side,
      qty: bitgetBaseQuantityToProvider(intent.quantity.quantity, rules),
      clientOid: bitgetClientOrderIdFor(intent),
      ...(category === "USDT-FUTURES" ? { reduceOnly: intent.orderConstraints.reduceOnly ? "yes" as const : "no" as const } : {}),
    };
    // Bitget UTA Spot market BUY qty is quote coin. IOC limit keeps the public
    // canonical contract in base quantity without a float conversion.
    if (intent.executionMode === "EXECUTION_PRIORITY" && !(category === "SPOT" && intent.side === "buy")) {
      return Object.freeze({ ...base, orderType: "market" as const });
    }
    if (!this.options.limitPriceResolver) {
      throw new Error("Bitget limit execution requires an explicit Decimal limit price resolver.");
    }
    return Object.freeze({
      ...base,
      orderType: "limit" as const,
      price: positiveDecimal(await this.options.limitPriceResolver(intent, instrument), "Bitget limit price"),
      force: intent.executionMode === "EXECUTION_PRIORITY" ? "ioc" as const : "gtc" as const,
    });
  }

  private requiredIdentityValidator() {
    if (!this.options.validateProviderIdentity) throw new Error("Bitget Provider credential identity validation is required before mutation.");
    return this.options.validateProviderIdentity;
  }
  private now() { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bitget execution clock is invalid."); return value; }
}

export function bitgetClientOrderIdFor(intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId">) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}`;
  return `sxbg${createHash("sha256").update(identity).digest("hex").slice(0, 28)}`;
}

function assertAcceptedIdentity(accepted: BitgetPlaceOrderResult, request: BitgetPlaceOrderRequest) {
  if (accepted.category !== request.category || accepted.symbol !== request.symbol || accepted.clientOid !== request.clientOid) {
    throw new Error("Bitget submit response identity does not match the exact execution order.");
  }
}
function assertLookupInstrument(lookup: BitgetExecutionOrderLookup, instrument: BitgetInstrumentResolution) {
  if (lookup.category !== instrument.venueInstrument.category || lookup.symbol !== instrument.venueInstrument.symbol) {
    throw new Error("Bitget order lookup instrument identity does not match the mapped instrument.");
  }
}
function observationForOrder(
  order: BitgetProviderOrder,
  lookup: BitgetExecutionOrderLookup,
  rules: Awaited<ReturnType<typeof loadBitgetQuantityRules>>,
  observedAt: number,
) {
  const filled = safeBaseQuantity(order.filledQuantity, rules);
  if (filled === null) return unknown("Bitget cumulative fill does not satisfy quantity rules.", observedAt);
  if (order.category !== lookup.category || order.symbol !== lookup.symbol || order.clientOid !== lookup.clientOid
    || (lookup.orderId !== undefined && order.orderId !== lookup.orderId)) {
    return unknown("Bitget Provider order identity does not match the execution reference.", observedAt, filled);
  }
  if (order.side !== lookup.expectedSide) return unknown("Bitget Provider side does not match the execution reference.", observedAt, filled);
  if (!decimalEquals(order.requestedQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bitget Provider quantity does not match the execution reference.", observedAt, filled);
  }
  if (compareDecimal(order.filledQuantity, lookup.expectedProviderQuantity) > 0) {
    return unknown("Bitget cumulative fill exceeds the expected execution quantity.", observedAt, filled);
  }
  const finalObservedAt = order.updatedAt === null ? observedAt : Math.max(observedAt, order.updatedAt);
  if (order.status === "UNKNOWN") return unknown("Bitget Provider order state is unknown.", finalObservedAt, filled);
  if (order.status === "CONFIRMED" && !decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bitget filled order does not complete the submitted quantity.", finalObservedAt, filled);
  }
  return Object.freeze({
    observation: createExecutionQueryObservation({ state: order.status, filledBaseQuantity: filled, observedAt: finalObservedAt }),
    statusReason: null as string | null,
  });
}
function unknown(statusReason: string, observedAt: number, filledBaseQuantity = "0") { return Object.freeze({
  observation: createExecutionQueryObservation({ state: "UNKNOWN", filledBaseQuantity, observedAt }), statusReason,
}); }
function safeBaseQuantity(quantity: string, rules: Parameters<typeof bitgetProviderQuantityToBase>[1]) {
  try { return bitgetProviderQuantityToBase(quantity, rules); } catch { return null; }
}
function positiveDecimal(value: string, label: string) { if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) throw new Error(`${label} is invalid.`); return value; }
function canonicalDecimal(value: string) { const [integer, fraction = ""] = value.split("."); const normalized = fraction.replace(/0+$/u, ""); return normalized ? `${integer}.${normalized}` : integer!; }
function decimalEquals(left: string, right: string) { return canonicalDecimal(left) === canonicalDecimal(right); }
function compareDecimal(left: string, right: string) { const [li, lf = ""] = left.split("."); const [ri, rf = ""] = right.split("."); const scale = Math.max(lf.length, rf.length); const a = BigInt(`${li}${lf.padEnd(scale, "0")}`); const b = BigInt(`${ri}${rf.padEnd(scale, "0")}`); return a < b ? -1 : a > b ? 1 : 0; }
