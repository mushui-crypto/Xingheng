import { createHash } from "node:crypto";
import {
  isTrustedVerifiedManagedCloseNativeExecutionRules,
  type FormalManagedCloseExecutionContext,
  type VerifiedManagedCloseNativeExecutionRules,
} from "../arbitrage-execution/FormalExecutionRuntime";
import { createExecutionCancelObservation, type ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import { runExecutionPreMutationPhase } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionQueryObservation, type ExecutionQueryObservation } from "../cex/ExecutionQueryCapability";
import type { ExecutionStatus } from "../cex/ExecutionState";
import { ExecutionMutationSafetyGuard, type ExecutionMutationContext, type ExecutionMutationEffect, type ExecutionProviderIdentityValidator } from "../cex/ExecutionMutationSafetyGuard";
import { BitgetInstrumentMappingAdapter, type BitgetInstrumentResolution } from "./BitgetInstrumentMapping";
import {
  BITGET_QUANTITY_RULES_MAX_AGE_MS,
  bitgetBaseQuantityToProvider,
  bitgetProviderQuantityToBase,
  loadBitgetQuantityRules,
  type BitgetQuantityRulesSource,
  type BitgetQuantityRulesSnapshot,
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
  readPositionMode?(): Promise<"ONE_WAY" | "HEDGE">;
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
  mutationEffect?: ExecutionMutationEffect;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (reference: Readonly<{
    category: "SPOT" | "USDT-FUTURES";
    symbol: string;
    clientOid: string;
    expectedProviderQuantity: string;
    expectedSide: BitgetOrderSide;
    positionMode?: "ONE_WAY" | "HEDGE";
    positionDirection?: "LONG" | "SHORT";
    posSide?: "long" | "short";
  }>) => Promise<void> | void;
  verifiedCloseContext?: FormalManagedCloseExecutionContext;
}>;

const VERIFIED_MANAGED_CLOSE_RULES_MAX_AGE_MS = 15_000;

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
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  posSide?: "long" | "short";
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
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  posSide?: "long" | "short";
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
        executionIntentId: intent.intentId,
        mutationPreparedAt: this.now(),
        ...(this.options.verifiedCloseContext === undefined ? {} : {
          verifiedProviderIdentity: this.options.verifiedCloseContext.verifiedProviderIdentity,
        }),
        ...(this.options.mutationEffect === undefined ? {} : { mutationEffect: this.options.mutationEffect }),
      }, validateProviderIdentity);
      await persistRecoveryReference({
        category: value.category, symbol: value.symbol, clientOid: value.clientOid,
        expectedProviderQuantity: value.qty, expectedSide: value.side,
        positionMode: value.positionMode, positionDirection: intent.positionDirection, posSide: value.posSide,
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
      ...(prepared.positionMode === undefined ? {} : { positionMode: prepared.positionMode }),
      ...(prepared.positionDirection === undefined ? {} : { positionDirection: prepared.positionDirection }),
      ...(prepared.posSide === undefined ? {} : { posSide: prepared.posSide }),
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
    if (lookup.category === "USDT-FUTURES") await this.assertPositionMode();
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
    const verifiedNativeRules = category === "USDT-FUTURES"
      ? this.verifiedNativeRulesFor(intent, instrument)
      : null;
    const positionMode = category === "USDT-FUTURES" ? await this.positionModeFor(intent) : undefined;
    if (positionMode === "HEDGE" && intent.positionDirection === undefined) {
      throw new Error("Bitget HEDGE execution requires positionDirection.");
    }
    if (positionMode === "HEDGE" && intent.orderConstraints.reduceOnly
      && ((intent.positionDirection === "LONG" && intent.side !== "sell")
        || (intent.positionDirection === "SHORT" && intent.side !== "buy"))) {
      throw new Error("Bitget HEDGE close side does not reduce the selected position bucket.");
    }
    const rules = verifiedNativeRules === null
      ? await loadBitgetQuantityRules(this.options.quantityRulesSource, instrument, () => this.now(),
        this.options.quantityRulesMaxAgeMs ?? BITGET_QUANTITY_RULES_MAX_AGE_MS)
      : bitgetRulesFromVerifiedFacts(verifiedNativeRules, instrument);
    const providerQuantity = bitgetBaseQuantityToProvider(intent.quantity.quantity, rules);
    if (verifiedNativeRules !== null && providerQuantity !== verifiedNativeRules.providerNativeQuantity) {
      throw new Error("Bitget verified native quantity does not match the canonical close quantity.");
    }
    const base = {
      category,
      symbol: instrument.venueInstrument.symbol,
      side: intent.side,
      qty: verifiedNativeRules?.providerNativeQuantity ?? providerQuantity,
      clientOid: bitgetClientOrderIdFor(intent),
      // Bitget UTA HEDGE closes are expressed by side + posSide. reduceOnly is
      // a ONE_WAY-only field, so it is omitted for HEDGE requests.
      ...(category === "USDT-FUTURES"
        ? positionMode === "HEDGE" ? {} : { reduceOnly: intent.orderConstraints.reduceOnly ? "yes" as const : "no" as const }
        : {}),
      ...(positionMode === "HEDGE" ? { posSide: intent.positionDirection === "LONG" ? "long" as const : "short" as const } : {}),
      positionMode,
      positionDirection: intent.positionDirection,
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
  private verifiedNativeRulesFor(
    intent: ExecutionIntent,
    instrument: BitgetInstrumentResolution,
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
      || rules.venue !== "bitget"
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
      || rules.verifiedAt > now
      || now - rules.verifiedAt > VERIFIED_MANAGED_CLOSE_RULES_MAX_AGE_MS) {
      throw new Error("Bitget verified native execution rules are invalid, stale, or outside this mutation attempt.");
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
        throw new Error("Bitget verified close context does not match the execution intent.");
      }
      return verified.positionMode;
    }
    return this.readPositionMode();
  }
  private async readPositionMode(): Promise<"ONE_WAY" | "HEDGE"> {
    if (this.client.readPositionMode) return this.client.readPositionMode();
    await this.client.assertOneWayMode();
    return "ONE_WAY";
  }
  private async assertPositionMode() { await this.readPositionMode(); }
  private now() { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bitget execution clock is invalid."); return value; }
}

function bitgetRulesFromVerifiedFacts(
  rules: VerifiedManagedCloseNativeExecutionRules,
  instrument: BitgetInstrumentResolution,
): BitgetQuantityRulesSnapshot {
  return Object.freeze({
    category: instrument.venueInstrument.category,
    symbol: rules.providerInstrumentId,
    status: "online",
    baseCoin: rules.contractValueCurrency,
    quoteCoin: rules.settlementAsset,
    quantityStep: rules.lotSize,
    minOrderQty: rules.minimumSize,
    minNotional: rules.minimumNotional,
    contractSize: rules.contractValue,
    quantityUnit: "base",
    fetchedAt: rules.verifiedAt,
  });
}

export function bitgetClientOrderIdFor(intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId" | "positionDirection">) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}\u0000${intent.positionDirection ?? "LEGACY_ONE_WAY"}`;
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
    return unknown("Bitget Provider order identity does not match the execution reference.", observedAt);
  }
  if (order.side !== lookup.expectedSide) return unknown("Bitget Provider side does not match the execution reference.", observedAt);
  if (!decimalEquals(order.requestedQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bitget Provider quantity does not match the execution reference.", observedAt);
  }
  if (compareDecimal(order.filledQuantity, lookup.expectedProviderQuantity) > 0) {
    return unknown("Bitget cumulative fill exceeds the expected execution quantity.", observedAt);
  }
  if (lookup.positionMode === "HEDGE") {
    if (order.holdMode !== "hedge_mode") {
      return unknown("Bitget Provider holdMode does not confirm HEDGE mode.", observedAt);
    }
    if (order.posSide !== lookup.posSide) {
      return unknown("Bitget Provider posSide does not match the execution bucket.", observedAt);
    }
    const expectedTradeSide = lookup.posSide === "long"
      ? lookup.expectedSide === "buy" ? "open_long" : "close_long"
      : lookup.expectedSide === "sell" ? "open_short" : "close_short";
    if (order.tradeSide !== expectedTradeSide) {
      return unknown("Bitget Provider tradeSide does not match the execution semantic.", observedAt);
    }
  }
  if (lookup.positionMode === "ONE_WAY") {
    if (order.holdMode !== "one_way_mode") {
      return unknown("Bitget Provider holdMode does not confirm ONE_WAY mode.", observedAt);
    }
    const close = lookup.positionDirection === "LONG" ? lookup.expectedSide === "sell"
      : lookup.positionDirection === "SHORT" ? lookup.expectedSide === "buy" : false;
    if (order.reduceOnly !== (close ? "yes" : "no")
      || order.tradeSide !== (close ? "close" : "open")) {
      return unknown("Bitget Provider ONE_WAY open/close semantic does not match the execution reference.", observedAt);
    }
  }
  const finalObservedAt = order.updatedAt === null ? observedAt : Math.max(observedAt, order.updatedAt);
  if (order.status === "UNKNOWN") return unknown("Bitget Provider order state is unknown.", finalObservedAt, filled);
  if (order.status === "CONFIRMED" && !decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)) {
    return unknown("Bitget filled order does not complete the submitted quantity.", finalObservedAt, filled);
  }
  const normalizedStatus = order.status === "FAILED" && order.rawStatus.toLowerCase() === "cancelled"
    && decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)
    ? "CONFIRMED" as const
    : order.status;
  return Object.freeze({
    observation: createExecutionQueryObservation({ state: normalizedStatus, filledBaseQuantity: filled, observedAt: finalObservedAt }),
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
