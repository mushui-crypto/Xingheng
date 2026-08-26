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
import type { ExecutionStatus } from "../cex/ExecutionState";
import {
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
  type ExecutionMutationEffect,
  type ExecutionProviderIdentityValidator,
} from "../cex/ExecutionMutationSafetyGuard";
import { OkxInstrumentMappingAdapter, type OkxInstrumentResolution } from "./OkxInstrumentMapping";
import { okxClientOrderIdFor, type OkxExecutionOrderLookup, type OkxExecutionQueryResult, type OkxIntentExecutionClient, type OkxIntentExecutionResult } from "./OkxIntentExecutionService";
import {
  loadOkxSpotQuantityRules,
  okxBaseQuantityToSpotSize,
  okxSpotSizeToBase,
  type OkxSpotQuantityRulesSource,
} from "./OkxSpotQuantitySemantics";
import type { OkxCancelOrderRequest, OkxPlaceOrderRequest, OkxProviderOrder } from "./OkxTypes";

export type OkxSpotIntentExecutionServiceOptions = Readonly<{
  instrumentMapping?: OkxInstrumentMappingAdapter;
  quantityRulesSource?: OkxSpotQuantityRulesSource;
  quantityRulesMaxAgeMs?: number;
  clock?: () => number;
  mutationSafetyGuard?: ExecutionMutationSafetyGuard;
  mutationEffect?: ExecutionMutationEffect;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (reference: Readonly<{
    instId: string;
    clOrdId: string;
    expectedProviderQuantity: string;
    expectedSide: "buy" | "sell";
  }>) => Promise<void> | void;
}>;

/** OKX-owned Spot adapter. All provider quantity units remain inside this module. */
export class OkxSpotIntentExecutionService {
  private readonly instruments: OkxInstrumentMappingAdapter;
  private readonly mutationSafetyGuard: ExecutionMutationSafetyGuard;
  private readonly clock: () => number;

  constructor(
    private readonly client: OkxIntentExecutionClient,
    private readonly options: OkxSpotIntentExecutionServiceOptions = {},
  ) {
    this.instruments = options.instrumentMapping ?? new OkxInstrumentMappingAdapter();
    this.mutationSafetyGuard = options.mutationSafetyGuard ?? new ExecutionMutationSafetyGuard();
    this.clock = options.clock ?? Date.now;
  }

  async execute(intent: ExecutionIntent): Promise<OkxIntentExecutionResult> {
    if (intent.venue !== "okx") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    const prepared = await runExecutionPreMutationPhase(async () => {
      const value = await this.prepare(intent);
      const persistRecoveryReference = this.options.persistRecoveryReference;
      if (persistRecoveryReference === undefined) {
        throw new Error("OKX Spot recovery reference persistence is required before mutation.");
      }
      await this.mutationSafetyGuard.assertAllowed({
        venue: "okx", operation: "placeOrder", userId: intent.userId, accountId: intent.accountId,
        instrumentId: intent.instrumentId, providerInstrumentId: value.instId,
        ...(this.options.mutationEffect === undefined ? {} : { mutationEffect: this.options.mutationEffect }),
      }, this.options.validateProviderIdentity);
      await persistRecoveryReference({
        instId: value.instId,
        clOrdId: value.clOrdId,
        expectedProviderQuantity: value.quantity,
        expectedSide: value.side,
      });
      return value;
    });
    const accepted = await this.client.placeOrder(prepared);
    if (accepted.instId !== prepared.instId || accepted.clOrdId !== prepared.clOrdId) {
      throw new Error("OKX Spot submit response identity does not match the exact execution order.");
    }
    return Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: accepted.ordId,
      clientOrderId: accepted.clOrdId,
      instId: accepted.instId,
      orderIdentity: Object.freeze({ instId: accepted.instId, ordId: accepted.ordId, clOrdId: accepted.clOrdId }),
      state: "SUBMITTED",
      confirmedQuantity: "0",
      statusReason: null,
      expectedProviderQuantity: prepared.quantity,
      expectedSide: prepared.side,
    });
  }

  async query(lookup: OkxExecutionOrderLookup): Promise<OkxExecutionQueryResult> {
    const instrument = this.instruments.resolve(lookup.instrumentId);
    assertSpotInstrument(instrument);
    if (instrument.venueInstrument.instId !== lookup.instId) throw new Error("OKX Spot order lookup instrument identity does not match the mapped instrument.");
    const rules = await loadOkxSpotQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      () => this.now(),
      this.options.quantityRulesMaxAgeMs,
    );
    const observedAt = this.now();
    const order = await this.client.getOrder({
      instId: lookup.instId,
      ...(lookup.ordId === undefined ? {} : { ordId: lookup.ordId }),
      clOrdId: lookup.clOrdId,
    });
    if (order.instId !== lookup.instId) throw new Error("OKX Spot order response instrument identity does not match the execution order.");
    const result = observationForSpotOrder(order, lookup, rules);
    return Object.freeze({
      observation: createExecutionQueryObservation({
        state: result.state,
        filledBaseQuantity: result.filledBaseQuantity,
        observedAt: order.updatedAt === null ? observedAt : Math.max(observedAt, order.updatedAt),
      }),
      orderIdentity: Object.freeze({ instId: order.instId, ordId: order.ordId, clOrdId: order.clOrdId }),
      fee: order.fee,
      statusReason: result.statusReason ?? order.statusReason,
    });
  }

  async cancel(
    lookup: OkxExecutionOrderLookup,
    context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & { providerInstrumentId?: string },
  ): Promise<ExecutionCancelObservation> {
    await this.mutationSafetyGuard.assertAllowed({
      venue: "okx", operation: "cancelOrder", userId: context.userId, accountId: context.accountId,
      instrumentId: context.instrumentId, providerInstrumentId: context.providerInstrumentId ?? lookup.instId,
    }, this.options.validateProviderIdentity);
    const request: OkxCancelOrderRequest = {
      instId: lookup.instId,
      ...(lookup.ordId === undefined ? {} : { ordId: lookup.ordId }),
      clOrdId: lookup.clOrdId,
    };
    await this.client.cancelOrder(request);
    return createExecutionCancelObservation({ state: "CANCEL_REQUESTED", observedAt: this.now() });
  }

  resolveLookup(record: ExecutionRecord): OkxExecutionOrderLookup {
    if (record.venue !== "okx") throw new Error(`Unsupported execution venue: ${record.venue}.`);
    const instrument = this.instruments.resolve(record.instrumentId);
    assertSpotInstrument(instrument);
    return Object.freeze({
      instrumentId: record.instrumentId,
      instId: instrument.venueInstrument.instId,
      ...(record.remoteOrderId === undefined ? {} : { ordId: record.remoteOrderId }),
      clOrdId: okxClientOrderIdFor(record),
    });
  }

  private async prepare(intent: ExecutionIntent): Promise<OkxPlaceOrderRequest> {
    const instrument = this.instruments.resolve(intent.instrumentId);
    assertSpotInstrument(instrument);
    if (intent.quantity.asset.symbol !== instrument.canonicalInstrument.baseAsset) {
      throw new Error("OKX Spot intent quantity asset does not match the canonical instrument base asset.");
    }
    if (intent.orderConstraints.reduceOnly) throw new Error("OKX Spot execution must not use reduceOnly.");
    const rules = await loadOkxSpotQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      () => this.now(),
      this.options.quantityRulesMaxAgeMs,
    );
    const base: OkxPlaceOrderRequest = {
      instId: instrument.venueInstrument.instId,
      tdMode: "cash",
      side: intent.side,
      ordType: intent.executionMode === "EXECUTION_PRIORITY" ? "market" : "limit",
      quantity: okxBaseQuantityToSpotSize(intent.quantity.quantity, rules),
      clOrdId: okxClientOrderIdFor(intent),
      ...(intent.side === "buy" && intent.executionMode === "EXECUTION_PRIORITY" ? { targetCurrency: "base_ccy" as const } : {}),
    };
    if (base.ordType === "limit") throw new Error("OKX Spot PRICE_PRIORITY requires an explicit limit price resolver.");
    return Object.freeze(base);
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("OKX Spot execution clock must return a non-negative integer timestamp.");
    return value;
  }
}

function assertSpotInstrument(instrument: OkxInstrumentResolution) {
  if (instrument.canonicalInstrument.contractType !== "spot" || instrument.venueInstrument.contractType !== "spot") {
    throw new Error("OKX Spot execution requires a canonical Spot instrument.");
  }
}

function observationForSpotOrder(
  order: OkxProviderOrder,
  lookup: OkxExecutionOrderLookup,
  rules: Parameters<typeof okxSpotSizeToBase>[1],
) {
  if (!lookup.expectedProviderQuantity || lookup.expectedSide === undefined) {
    return unknownSpotOrder("OKX Spot expected order facts are missing.");
  }
  if (lookup.expectedSide !== "buy" && lookup.expectedSide !== "sell") {
    return unknownSpotOrder("OKX Spot expected order side is invalid.");
  }
  if (!positiveUnsignedDecimal(lookup.expectedProviderQuantity)) {
    return unknownSpotOrder("OKX Spot expected provider quantity is invalid.");
  }
  if (order.side !== lookup.expectedSide) {
    return unknownSpotOrder("OKX Spot Provider side does not match the expected execution side.");
  }
  if (!positiveUnsignedDecimal(order.requestedQuantity)
    || !decimalEquals(order.requestedQuantity, lookup.expectedProviderQuantity)) {
    return unknownSpotOrder("OKX Spot Provider quantity does not match the expected execution quantity.");
  }
  const filledBaseQuantity = safeSpotBaseQuantity(order.filledQuantity, rules);
  if (filledBaseQuantity === null) return unknownSpotOrder("OKX Spot cumulative fill does not satisfy quantity rules.");
  if (compareDecimal(order.filledQuantity, lookup.expectedProviderQuantity) > 0) {
    return unknownSpotOrder("OKX Spot cumulative fill exceeds the expected execution quantity.", filledBaseQuantity);
  }
  if ((lookup.ordId !== undefined && order.ordId !== lookup.ordId) || order.clOrdId !== lookup.clOrdId) {
    return unknownSpotOrder("OKX Spot order identity does not match the execution reference.", filledBaseQuantity);
  }
  if (!validFee(order, rules.baseCcy, rules.quoteCcy)) {
    return unknownSpotOrder("OKX Spot fee evidence is invalid or cannot be attributed.", filledBaseQuantity);
  }
  if (order.status === "UNKNOWN") return unknownSpotOrder("OKX Spot Provider order state is unknown.", filledBaseQuantity);

  const hasFill = !isZeroDecimal(filledBaseQuantity);
  if (!hasFill) {
    if (order.status === "CONFIRMED" || order.averagePrice !== null || !isZeroDecimal(order.fee)) {
      return unknownSpotOrder("OKX Spot order state conflicts with its cumulative fill.");
    }
    return Object.freeze({ state: order.status === "FAILED" ? "FAILED" as const : "PENDING_CONFIRMATION" as const, filledBaseQuantity, statusReason: null });
  }
  if (order.status === "CONFIRMED") {
    if (!positiveDecimal(order.averagePrice)) {
      return unknownSpotOrder("OKX Spot cumulative fill requires a positive average price.", filledBaseQuantity);
    }
    if (order.rawState !== "filled" || !decimalEquals(order.filledQuantity, lookup.expectedProviderQuantity)) {
      return unknownSpotOrder("OKX Spot filled quantity does not complete the submitted order.", filledBaseQuantity);
    }
    return Object.freeze({ state: "CONFIRMED" as const, filledBaseQuantity, statusReason: null });
  }
  if (order.status === "FAILED") {
    if (order.rawState !== "canceled" && order.rawState !== "cancelled" && order.rawState !== "rejected") {
      return unknownSpotOrder("OKX Spot failed order state is not attributable to cancellation or rejection.", filledBaseQuantity);
    }
    return Object.freeze({ state: "FAILED" as const, filledBaseQuantity, statusReason: null });
  }
  if (!positiveDecimal(order.averagePrice)) {
    return unknownSpotOrder("OKX Spot cumulative fill requires a positive average price.", filledBaseQuantity);
  }
  return Object.freeze({
    state: "PENDING_CONFIRMATION" as const,
    filledBaseQuantity,
    statusReason: null,
  });
}

function unknownSpotOrder(statusReason: string, filledBaseQuantity = "0") {
  return Object.freeze({ state: "UNKNOWN" as const, filledBaseQuantity, statusReason });
}

function validFee(order: OkxProviderOrder, baseAsset: string, quoteAsset: string) {
  if (!signedDecimal(order.fee)) return false;
  const feeCcy = order.feeCcy;
  if (feeCcy !== undefined && feeCcy !== null && !/^[A-Z0-9]{2,12}$/u.test(feeCcy)) return false;
  if (feeCcy !== undefined && feeCcy !== null && feeCcy !== baseAsset && feeCcy !== quoteAsset) return false;
  return isZeroDecimal(order.fee) || feeCcy !== undefined && feeCcy !== null;
}

function positiveDecimal(value: string | null) {
  return value !== null && signedDecimal(value) && !isZeroDecimal(value) && !value.startsWith("-");
}

function positiveUnsignedDecimal(value: string) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && !isZeroDecimal(value);
}

function signedDecimal(value: string) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
}

function isZeroDecimal(value: string) {
  if (!signedDecimal(value)) return false;
  return BigInt(value.replace("-", "").replace(".", "")) === 0n;
}

function decimalEquals(left: string, right: string) {
  return canonicalDecimal(left) === canonicalDecimal(right);
}

function compareDecimal(left: string, right: string) {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(`${leftInteger}${leftFraction.padEnd(scale, "0")}`);
  const rightValue = BigInt(`${rightInteger}${rightFraction.padEnd(scale, "0")}`);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

function canonicalDecimal(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const normalizedInteger = integer.replace(/^0+(?=\d)/u, "");
  if (`${normalizedInteger}.${normalizedFraction}`.replace(/[.0]/gu, "") === "") return "0";
  return `${negative ? "-" : ""}${normalizedInteger}${normalizedFraction ? `.${normalizedFraction}` : ""}`;
}

function safeSpotBaseQuantity(
  quantity: string,
  rules: Parameters<typeof okxSpotSizeToBase>[1],
) {
  try {
    return okxSpotSizeToBase(quantity, rules);
  } catch {
    return null;
  }
}
