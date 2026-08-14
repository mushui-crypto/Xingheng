import type { ExecutionReconciliationObservation } from "../cex/ExecutionReconciliationCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import {
  binanceExecutionObservationForOrder,
  binanceUnknownExecutionObservation,
} from "./BinanceIntentExecutionQueryService";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import { assertBinanceProviderOrderIdentity } from "./BinanceProviderOrderIdentity";

export type BinanceIntentExecutionReconciliationServiceBinding = Pick<
  BinancePersonalTradingService,
  "ordersState" | "findExecutionOrderByClientOrderId"
>;

export class BinanceIntentExecutionReconciliationService {
  constructor(
    private readonly service: BinanceIntentExecutionReconciliationServiceBinding,
    private readonly clock: () => number = Date.now,
  ) {}

  async reconcile(record: ExecutionRecord): Promise<ExecutionReconciliationObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    const stored = this.service.ordersState().orders.find(
      (order) => order.idempotencyKey === binanceExecutionIdempotencyKeyFor(record),
    );
    const observedAt = this.now();
    if (!stored) return binanceUnknownExecutionObservation(observedAt);

    try {
      const order = await this.service.findExecutionOrderByClientOrderId(
        stored.category,
        stored.symbol,
        stored.clientOrderId,
      );
      if (!order) return binanceUnknownExecutionObservation(observedAt);
      assertBinanceProviderOrderIdentity(order, {
        symbol: stored.symbol,
        clientOrderId: stored.clientOrderId,
        providerOrderId: stored.providerOrderId,
      });
      return binanceExecutionObservationForOrder(order, observedAt);
    } catch {
      return binanceUnknownExecutionObservation(observedAt);
    }
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Binance execution reconciliation clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}
