import {
  createExecutionCancelObservation,
  type ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";

export type BinanceIntentExecutionCancelServiceBinding = Pick<
  BinancePersonalTradingService,
  "cancelOrder"
>;

export class BinanceIntentExecutionCancelService {
  constructor(
    private readonly service: BinanceIntentExecutionCancelServiceBinding,
    private readonly clock: () => number = Date.now,
  ) {}

  async cancel(record: ExecutionRecord): Promise<ExecutionCancelObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    try {
      const order = await this.service.cancelOrder({
        idempotencyKey: binanceExecutionIdempotencyKeyFor(record),
      });
      return createExecutionCancelObservation({
        state: cancelStateFor(order.status),
        observedAt: this.now(),
      });
    } catch (error) {
      if (error instanceof ManualReconciliationRequiredError) throw error;
      return createExecutionCancelObservation({ state: "UNKNOWN", observedAt: this.now() });
    }
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Binance execution cancel clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}

function cancelStateFor(
  status: Awaited<ReturnType<BinancePersonalTradingService["cancelOrder"]>>["status"],
): ExecutionCancelObservation["state"] {
  if (status === "Cancelled" || status === "Expired") return "CANCELLED";
  if (status === "New" || status === "PartiallyFilled") return "CANCEL_REQUESTED";
  return "UNKNOWN";
}
