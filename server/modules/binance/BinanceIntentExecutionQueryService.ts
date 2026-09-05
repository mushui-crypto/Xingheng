import {
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import {
  BinanceStoredOrderManualReconciliationError,
  type BinanceStoredOrder,
  type BinanceStoredOrderLookup,
} from "./BinanceOrderStore";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { binanceFilledBaseQuantity } from "./BinanceTypes";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import { assertBinanceProviderOrderIdentity } from "./BinanceProviderOrderIdentity";
import { createExecutionAccountingEvidence } from "../cex/ExecutionAccountingEvidence";

export type BinanceIntentExecutionQueryServiceBinding = Pick<
  BinancePersonalTradingService,
  "executionOrderState"
>;

export class BinanceIntentExecutionQueryService {
  constructor(
    private readonly service: BinanceIntentExecutionQueryServiceBinding,
    private readonly clock: () => number = Date.now,
  ) {}

  async query(
    record: ExecutionRecord,
    localState?: BinanceStoredOrderLookup,
  ): Promise<ExecutionQueryObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    const idempotencyKey = binanceExecutionIdempotencyKeyFor(record);
    const stored = localState ?? this.service.executionOrderState(idempotencyKey);
    if (stored.kind === "isolated") {
      throw new BinanceStoredOrderManualReconciliationError(stored.isolation);
    }
    return stored.kind === "found"
      ? observationFor(stored.order, this.now())
      : binanceUnknownExecutionObservation(this.now());
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Binance execution query clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}

function observationFor(stored: BinanceStoredOrder, fallbackObservedAt: number): ExecutionQueryObservation {
  if (!stored.order) {
    return createExecutionQueryObservation({
      state: "UNKNOWN",
      filledBaseQuantity: "0",
      observedAt: Math.max(stored.updatedAt, fallbackObservedAt),
    });
  }
  const order = stored.order;
  if (stored.expectedSide === undefined || stored.expectedBaseQuantity === undefined
    || order.side === undefined || order.requestedBaseQuantity === undefined
    || (stored.category === "linear" && (stored.expectedReduceOnly === undefined || order.reduceOnly === undefined))) {
    return binanceUnknownExecutionObservation(Math.max(stored.updatedAt, fallbackObservedAt));
  }
  try {
    assertBinanceProviderOrderIdentity(order, {
      symbol: stored.symbol,
      clientOrderId: stored.clientOrderId,
      providerOrderId: stored.providerOrderId,
      positionSide: stored.positionSide,
      side: stored.expectedSide,
      requestedBaseQuantity: stored.expectedBaseQuantity,
      reduceOnly: stored.expectedReduceOnly,
    });
  } catch {
    return binanceUnknownExecutionObservation(Math.max(stored.updatedAt, fallbackObservedAt));
  }
  return binanceExecutionObservationForOrder(
    order,
    Math.max(order.updatedAt, stored.updatedAt, fallbackObservedAt),
  );
}

export function binanceExecutionObservationForOrder(
  order: NonNullable<BinanceStoredOrder["order"]>,
  observedAt: number,
): ExecutionQueryObservation {
  const filledBaseQuantity = binanceFilledBaseQuantity(order);
  const averageFillPrice = positiveNumberDecimal(order.averagePrice);
  return createExecutionQueryObservation({
    state: stateForOrder(order),
    filledBaseQuantity,
    observedAt,
    accountingEvidence: createExecutionAccountingEvidence({
      providerOrderId: order.orderId,
      filledQuantity: filledBaseQuantity,
      averageFillPrice,
      feeAmountProvider: null,
      feeAsset: null,
      tradingFeeNetCostUsdt: null,
      confirmedAt: observedAt,
      completeness: "INCOMPLETE",
    }),
  });
}

function positiveNumberDecimal(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const text = String(value);
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text) ? text : null;
}

function stateForOrder(order: NonNullable<BinanceStoredOrder["order"]>): ExecutionQueryObservation["state"] {
  if ((order.status === "Cancelled" || order.status === "Expired")
    && order.requestedBaseQuantity !== undefined && order.filledBaseQuantity !== undefined
    && decimalEquals(order.requestedBaseQuantity, order.filledBaseQuantity)) return "CONFIRMED";
  return stateFor(order.status);
}

function decimalEquals(left: string, right: string) {
  const normalize = (value: string) => {
    const [integer, fraction = ""] = value.split(".");
    const trimmed = fraction.replace(/0+$/u, "");
    return trimmed ? `${integer}.${trimmed}` : integer;
  };
  return normalize(left) === normalize(right);
}

export function binanceUnknownExecutionObservation(observedAt: number): ExecutionQueryObservation {
  return createExecutionQueryObservation({
    state: "UNKNOWN",
    filledBaseQuantity: "0",
    observedAt,
  });
}

function stateFor(status: NonNullable<BinanceStoredOrder["order"]>["status"]): ExecutionQueryObservation["state"] {
  if (status === "Filled") return "CONFIRMED";
  if (status === "New" || status === "PartiallyFilled") return "PENDING_CONFIRMATION";
  if (status === "Cancelled" || status === "Rejected" || status === "Expired") return "FAILED";
  return "UNKNOWN";
}
