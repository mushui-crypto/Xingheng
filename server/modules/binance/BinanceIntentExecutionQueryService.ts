import {
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";

export type BinanceIntentExecutionQueryServiceBinding = Pick<
  BinancePersonalTradingService,
  "ordersState"
>;

export class BinanceIntentExecutionQueryService {
  constructor(
    private readonly service: BinanceIntentExecutionQueryServiceBinding,
    private readonly clock: () => number = Date.now,
  ) {}

  async query(record: ExecutionRecord): Promise<ExecutionQueryObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    const idempotencyKey = binanceExecutionIdempotencyKeyFor(record);
    const stored = this.service.ordersState().orders.find((order) => order.idempotencyKey === idempotencyKey);
    return stored ? observationFor(stored, this.now()) : binanceUnknownExecutionObservation(this.now());
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
    filledBaseQuantity: numberToDecimal(order.filledQuantityXaut),
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

function numberToDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Binance filled quantity is invalid.");
  const text = String(value);
  if (!/[eE]/u.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer!.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}
