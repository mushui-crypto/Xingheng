import { createHash } from "node:crypto";
import { BinanceProviderError } from "./BinanceClient";
import { BinanceOrderStore, type BinanceStoredOrder } from "./BinanceOrderStore";
import { BinanceRiskGuard } from "./BinanceRiskGuard";
import type {
  BinanceClientAdapter,
  BinanceOrderExecutionMode,
  BinanceOrderRequest,
  BinanceProviderOrder,
} from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export type BinanceOrderInput = Omit<BinanceOrderRequest, "orderLinkId"> & {
  idempotencyKey: string;
};

export class BinanceOrderManager {
  private readonly orderLock = new AsyncLock();

  constructor(
    private readonly client: BinanceClientAdapter,
    private readonly risk: BinanceRiskGuard,
    private readonly store: BinanceOrderStore,
    private readonly config: BinanceTradingConfig,
  ) {}

  place(input: BinanceOrderInput) {
    return this.placeWithMode(input, "production_ioc");
  }

  placeTestOrder(input: BinanceOrderInput) {
    return this.placeWithMode(input, "test_gtc");
  }

  private async placeWithMode(input: BinanceOrderInput, executionMode: BinanceOrderExecutionMode) {
    const request = normalizeRequest(input);
    const requestFingerprint = fingerprint(request, executionMode);
    const reservation = this.store.reserve({
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      clientOrderId: request.orderLinkId,
      category: request.category,
      executionMode,
    });
    if (reservation.kind === "conflict") {
      throw new Error("Idempotency key is already used for a different Binance order.");
    }

    return this.orderLock.run(async () => {
      if (reservation.kind === "existing") {
        return this.resolveExisting(input.idempotencyKey);
      }

      let providerOrderId: string | null = null;
      let submissionStarted = false;
      try {
        const snapshot = await this.syncPositions();
        this.risk.assertOrderAllowed(request, snapshot);
        submissionStarted = true;
        const accepted = executionMode === "test_gtc"
          ? await this.client.placeTestOrder(request)
          : await this.client.placeOrder(request);
        providerOrderId = accepted.orderId;
        this.store.recordProviderOrder(input.idempotencyKey, accepted.orderId);

        if (executionMode === "test_gtc") {
          const observed = await this.findByClientOrderId(request.category, request.orderLinkId);
          if (!observed) throw new Error("Binance GTC test order is pending provider reconciliation.");
          return this.persistProviderState(input.idempotencyKey, observed);
        }

        const order = await this.settleOrder(request.category, accepted.orderId);
        this.persistProviderState(input.idempotencyKey, order);
        await this.syncPositions();
        return order;
      } catch (error) {
        if (!submissionStarted) {
          this.store.fail(input.idempotencyKey, errorMessage(error));
          throw error;
        }

        const recovered = await this.findByClientOrderId(request.category, request.orderLinkId).catch(() => null);
        if (recovered) {
          if (executionMode === "test_gtc") {
            return this.persistProviderState(input.idempotencyKey, recovered);
          }
          const settled = await this.settleOrder(request.category, recovered.orderId).catch(() => null);
          if (settled) {
            this.persistProviderState(input.idempotencyKey, settled);
            await this.syncPositions().catch(() => undefined);
            return settled;
          }
        }

        const message = errorMessage(error);
        if (providerOrderId || isAmbiguousProviderWrite(error)) {
          this.store.markProcessingError(input.idempotencyKey, message);
        } else {
          this.store.fail(input.idempotencyKey, message);
        }
        throw error;
      }
    });
  }

  async cancel(idempotencyKey: string) {
    return this.orderLock.run(async () => {
      const stored = this.store.find(idempotencyKey);
      if (!stored) throw new Error("Binance order was not found.");
      if (stored.status !== "processing") {
        if (stored.order) return stored.order;
        throw new Error(stored.error ?? "Binance order is already terminal.");
      }

      const found = await this.findByClientOrderId(stored.category, stored.clientOrderId);
      const providerOrderId = stored.providerOrderId ?? found?.orderId;
      if (!providerOrderId) throw new Error("Binance provider order is not available for cancellation.");

      try {
        await this.client.cancelOrder(stored.category, providerOrderId);
      } catch (error) {
        const recovered = await this.findByClientOrderId(stored.category, stored.clientOrderId).catch(() => null);
        if (!recovered) throw error;
        return this.persistProviderState(idempotencyKey, recovered);
      }

      const order = await this.client.awaitOrder(
        stored.category,
        providerOrderId,
        Date.now() + this.config.orderTimeoutMs,
      );
      const result = this.persistProviderState(idempotencyKey, order);
      await this.syncPositions();
      return result;
    });
  }

  async reconcile() {
    return this.orderLock.run(async () => {
      const reconciled: BinanceProviderOrder[] = [];
      for (const stored of this.store.listProcessing()) {
        let order: BinanceProviderOrder | null;
        try {
          order = await this.findByClientOrderId(stored.category, stored.clientOrderId);
        } catch (error) {
          this.store.markProcessingError(stored.idempotencyKey, errorMessage(error));
          continue;
        }

        if (!order) {
          if (this.processingExpired(stored)) {
            this.store.fail(stored.idempotencyKey, "Processing timeout: Binance order was not found by clientOrderId.");
          }
          continue;
        }

        if (isNonTerminalProviderState(order) && this.processingExpired(stored)) {
          try {
            await this.client.cancelOrder(stored.category, order.orderId);
            order = await this.client.awaitOrder(
              stored.category,
              order.orderId,
              Date.now() + this.config.orderTimeoutMs,
            );
          } catch (error) {
            this.store.markProcessingError(stored.idempotencyKey, `Processing timeout cancellation failed: ${errorMessage(error)}`);
            continue;
          }
        }

        const before = stored.status;
        this.persistProviderState(stored.idempotencyKey, order);
        const after = this.store.find(stored.idempotencyKey)?.status;
        if (before === "processing" && after !== "processing") reconciled.push(order);
      }
      const snapshot = await this.syncPositions();
      return { reconciled, snapshot, orders: this.store.listAll() };
    });
  }

  listOrders() {
    return this.store.list();
  }

  async syncPositions() {
    const snapshot = await this.client.readPreflightSnapshot();
    this.store.savePositionSnapshot(snapshot);
    return snapshot;
  }

  private async resolveExisting(idempotencyKey: string) {
    const stored = this.store.find(idempotencyKey);
    if (!stored) throw new Error("Binance idempotency reservation disappeared.");
    if (stored.status === "completed" && stored.order?.status === "Filled") return stored.order;
    if (stored.status === "failed") {
      if (stored.order) return stored.order;
      throw new Error(stored.error ?? "Previous Binance order attempt failed.");
    }

    const recovered = await this.findByClientOrderId(stored.category, stored.clientOrderId);
    if (!recovered) {
      if (this.processingExpired(stored)) {
        this.store.fail(idempotencyKey, "Processing timeout: Binance order was not found by clientOrderId.");
      }
      throw new Error("Binance order is still pending reconciliation.");
    }

    if (stored.executionMode === "production_ioc" && isNonTerminalProviderState(recovered)) {
      const settled = await this.settleOrder(stored.category, recovered.orderId).catch(() => null);
      if (!settled) {
        this.store.recordProcessingOrder(idempotencyKey, recovered);
        throw new Error("Binance order is still pending reconciliation.");
      }
      return this.persistProviderState(idempotencyKey, settled);
    }
    return this.persistProviderState(idempotencyKey, recovered);
  }

  private persistProviderState(idempotencyKey: string, order: BinanceProviderOrder) {
    if (order.status === "Filled") {
      this.store.complete(idempotencyKey, order);
    } else if (isFailedProviderState(order)) {
      this.store.failWithOrder(idempotencyKey, order, `Binance order ended with ${order.status}.`);
    } else {
      this.store.recordProcessingOrder(idempotencyKey, order);
    }
    return order;
  }

  private async findByClientOrderId(category: "spot" | "linear", clientOrderId: string) {
    return this.client.findOrderByClientOrderId(category, clientOrderId);
  }

  private async settleOrder(category: "spot" | "linear", orderId: string) {
    let order = await this.client.awaitOrder(category, orderId, Date.now() + this.config.orderTimeoutMs);
    if (isNonTerminalProviderState(order)) {
      await this.client.cancelOrder(category, orderId);
      order = await this.client.awaitOrder(category, orderId, Date.now() + this.config.orderTimeoutMs);
    }
    if (isNonTerminalProviderState(order)) {
      throw new Error("Binance order remains non-terminal and requires reconciliation.");
    }
    return order;
  }

  private processingExpired(order: BinanceStoredOrder) {
    return Date.now() - order.createdAt >= this.config.processingTimeoutMs;
  }
}

function normalizeRequest(input: BinanceOrderInput): BinanceOrderRequest {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) throw new Error("A valid idempotencyKey is required.");
  return {
    category: input.category,
    symbol: "XAUTUSDT",
    side: input.side,
    quantityXaut: input.quantityXaut,
    limitPrice: input.limitPrice,
    reduceOnly: input.reduceOnly,
    orderLinkId: `ptm${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 30)}`,
  };
}

function fingerprint(request: BinanceOrderRequest, executionMode: BinanceOrderExecutionMode) {
  return createHash("sha256").update(JSON.stringify({ request, executionMode })).digest("hex");
}

function isNonTerminalProviderState(order: BinanceProviderOrder) {
  return order.status === "New" || order.status === "PartiallyFilled" || order.status === "Unknown";
}

function isFailedProviderState(order: BinanceProviderOrder) {
  return order.status === "Cancelled" || order.status === "Rejected" || order.status === "Expired";
}

function isAmbiguousProviderWrite(error: unknown) {
  return error instanceof BinanceProviderError
    && (error.category === "provider_timeout" || error.category === "provider_transport_error");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Binance order failed.";
}

class AsyncLock {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
