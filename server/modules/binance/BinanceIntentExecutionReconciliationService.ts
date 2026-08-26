import type { ExecutionReconciliationObservation } from "../cex/ExecutionReconciliationCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import {
  BinanceStoredOrderManualReconciliationError,
  type BinanceStoredOrderLookup,
} from "./BinanceOrderStore";
import {
  binanceExecutionObservationForOrder,
  binanceUnknownExecutionObservation,
} from "./BinanceIntentExecutionQueryService";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import { assertBinanceProviderOrderIdentity } from "./BinanceProviderOrderIdentity";

export type BinanceIntentExecutionReconciliationServiceBinding = Pick<
  BinancePersonalTradingService,
  "executionOrderState" | "findExecutionOrderByClientOrderId"
>;

export class BinanceIntentExecutionReconciliationService {
  constructor(
    private readonly service: BinanceIntentExecutionReconciliationServiceBinding,
    private readonly clock: () => number = Date.now,
  ) {}

  async reconcile(
    record: ExecutionRecord,
    localState?: BinanceStoredOrderLookup,
  ): Promise<ExecutionReconciliationObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    const stored = localState
      ?? this.service.executionOrderState(binanceExecutionIdempotencyKeyFor(record));
    const observedAt = this.now();
    if (stored.kind === "isolated") {
      throw new BinanceStoredOrderManualReconciliationError(stored.isolation);
    }
    if (stored.kind === "missing") return binanceUnknownExecutionObservation(observedAt);

    try {
      const order = await this.service.findExecutionOrderByClientOrderId(
        stored.order.category,
        stored.order.symbol,
        stored.order.clientOrderId,
      );
      if (!order) return binanceUnknownExecutionObservation(observedAt);
      assertBinanceProviderOrderIdentity(order, {
        symbol: stored.order.symbol,
        clientOrderId: stored.order.clientOrderId,
        providerOrderId: stored.order.providerOrderId,
        positionSide: stored.order.positionSide,
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
