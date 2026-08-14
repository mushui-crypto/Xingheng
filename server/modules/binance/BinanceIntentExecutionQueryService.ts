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
  try {
    assertBinanceProviderOrderIdentity(order, {
      symbol: stored.symbol,
      clientOrderId: stored.clientOrderId,
      providerOrderId: stored.providerOrderId,
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
  return createExecutionQueryObservation({
    state: stateFor(order.status),
    filledBaseQuantity: binanceFilledBaseQuantity(order),
    observedAt,
  });
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
