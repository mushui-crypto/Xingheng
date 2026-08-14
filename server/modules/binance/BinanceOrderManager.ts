import { createHash } from "node:crypto";
import { BinanceProviderError } from "./BinanceClient";
import { BinanceOrderStore, type BinanceStoredOrder } from "./BinanceOrderStore";
import { BinanceRiskGuard } from "./BinanceRiskGuard";
import type {
  BinanceClientAdapter,
  BinanceExecutionOrderRequest,
  BinanceGenericRiskContext,
  BinanceOrderExecutionMode,
  BinanceOrderRequest,
  BinancePreflightSnapshot,
  BinanceProviderOrder,
} from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export type BinanceOrderInput = BinanceExecutionOrderRequest extends infer Request
  ? Request extends BinanceExecutionOrderRequest
    ? Omit<Request, "orderLinkId"> & { idempotencyKey: string }
    : never
  : never;

export type BinanceProviderMutationGuard = (riskValuationPrice: number) => void | Promise<void>;

export class BinanceOrderManager {
  private readonly orderLock = new AsyncLock();

  constructor(
    private readonly client: BinanceClientAdapter,
    private readonly risk: BinanceRiskGuard,
    private readonly store: BinanceOrderStore,
    private readonly config: BinanceTradingConfig,
  ) {}

  place(
    input: BinanceOrderInput,
    beforeProviderMutation?: BinanceProviderMutationGuard,
    genericRiskContext?: BinanceGenericRiskContext,
  ) {
    return this.placeWithMode(input, "production_ioc", beforeProviderMutation, genericRiskContext);
  }

  placeTestOrder(input: BinanceOrderInput) {
    if (input.limitPrice === undefined) {
      throw new Error("Binance GTC test order requires an explicit Decimal limit price.");
    }
    return this.placeWithMode({ ...input, executionPriceMode: "IOC_LIMIT", limitPrice: input.limitPrice }, "test_gtc");
  }

  private async placeWithMode(
    input: BinanceOrderInput,
    executionMode: BinanceOrderExecutionMode,
    beforeProviderMutation?: BinanceProviderMutationGuard,
    genericRiskContext?: BinanceGenericRiskContext,
  ) {
    const request = normalizeRequest(input);
    const requestFingerprint = fingerprint(request, executionMode);
    const reservation = this.store.reserve({
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      clientOrderId: request.orderLinkId,
      category: request.category,
      symbol: request.symbol,
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
      const legacyXaut = request.symbol === "XAUTUSDT";
      try {
        if (legacyXaut) {
          const snapshot = await this.syncPositions();
          const legacyRiskRequest = toLegacyRiskRequest(request, snapshot, this.config.maxSlippageBps);
          this.risk.assertOrderAllowed(legacyRiskRequest, snapshot);
          await beforeProviderMutation?.(legacyRiskRequest.limitPrice);
        } else {
          if (beforeProviderMutation) {
            throw new Error("Binance legacy Capital Test guard cannot be used for generic instruments.");
          }
          if (!genericRiskContext) {
            throw new Error("Binance generic execution risk context is required.");
          }
          const readRiskSnapshot = this.client.readGenericRiskSnapshot;
          if (!readRiskSnapshot) {
            throw new Error("Binance generic private risk read capability is unavailable.");
          }
          const snapshot = await readRiskSnapshot.call(this.client, {
            category: request.category,
            symbol: request.symbol,
            baseAsset: genericRiskContext.baseAsset,
          });
          this.risk.assertGenericOrderAllowed(request, genericRiskContext, snapshot);
        }
        submissionStarted = true;
        const accepted = executionMode === "test_gtc"
          ? await this.client.placeTestOrder(request)
          : await this.client.placeOrder(request);
        providerOrderId = accepted.orderId;
        this.store.recordProviderOrder(input.idempotencyKey, accepted.orderId);

        if (executionMode === "test_gtc") {
          const observed = await this.findByClientOrderId(request.category, request.symbol, request.orderLinkId);
          if (!observed) throw new Error("Binance GTC test order is pending provider reconciliation.");
          return this.persistProviderState(input.idempotencyKey, observed);
        }

        const order = await this.settleOrder(request.category, request.symbol, accepted.orderId);
        this.persistProviderState(input.idempotencyKey, order);
        if (legacyXaut) await this.syncPositions();
        return order;
      } catch (error) {
        if (!submissionStarted) {
          this.store.fail(input.idempotencyKey, errorMessage(error));
          throw error;
        }

        const recovered = await this.findByClientOrderId(request.category, request.symbol, request.orderLinkId).catch(() => null);
        if (recovered) {
          if (executionMode === "test_gtc") {
            return this.persistProviderState(input.idempotencyKey, recovered);
          }
          const settled = await this.settleOrder(request.category, request.symbol, recovered.orderId).catch(() => null);
          if (settled) {
            this.persistProviderState(input.idempotencyKey, settled);
            if (legacyXaut) await this.syncPositions().catch(() => undefined);
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

      const found = await this.findByClientOrderId(stored.category, stored.symbol, stored.clientOrderId);
      const providerOrderId = stored.providerOrderId ?? found?.orderId;
      if (!providerOrderId) throw new Error("Binance provider order is not available for cancellation.");

      // Persist the cancel claim immediately before the provider mutation. A repeated request or
      // restarted process may query/reconcile this known order, but must not submit cancel twice.
      if (!this.store.claimCancellation(idempotencyKey)) {
        if (!found) throw new Error("Binance cancellation is pending reconciliation.");
        return this.persistProviderState(idempotencyKey, found);
      }

      try {
        await this.client.cancelOrder(stored.category, stored.symbol, providerOrderId);
      } catch (error) {
        const recovered = await this.findByClientOrderId(stored.category, stored.symbol, stored.clientOrderId).catch(() => null);
        if (!recovered) throw error;
        return this.persistProviderState(idempotencyKey, recovered);
      }

      const order = await this.client.awaitOrder(
        stored.category,
        stored.symbol,
        providerOrderId,
        Date.now() + this.config.orderTimeoutMs,
      );
      const result = this.persistProviderState(idempotencyKey, order);
      if (stored.symbol === "XAUTUSDT") await this.syncPositions();
      return result;
    });
  }

  async reconcile() {
    return this.orderLock.run(async () => {
      const reconciled: BinanceProviderOrder[] = [];
      for (const stored of this.store.listProcessing()) {
        let order: BinanceProviderOrder | null;
        try {
          order = await this.findByClientOrderId(stored.category, stored.symbol, stored.clientOrderId);
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
            await this.client.cancelOrder(stored.category, stored.symbol, order.orderId);
            order = await this.client.awaitOrder(
              stored.category,
              stored.symbol,
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

    const recovered = await this.findByClientOrderId(stored.category, stored.symbol, stored.clientOrderId);
    if (!recovered) {
      if (this.processingExpired(stored)) {
        this.store.fail(idempotencyKey, "Processing timeout: Binance order was not found by clientOrderId.");
      }
      throw new Error("Binance order is still pending reconciliation.");
    }

    if (stored.executionMode === "production_ioc" && isNonTerminalProviderState(recovered)) {
      const settled = await this.settleOrder(stored.category, stored.symbol, recovered.orderId).catch(() => null);
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

  private async findByClientOrderId(category: "spot" | "linear", symbol: string, clientOrderId: string) {
    return this.client.findOrderByClientOrderId(category, symbol, clientOrderId);
  }

  private async settleOrder(category: "spot" | "linear", symbol: string, orderId: string) {
    let order = await this.client.awaitOrder(category, symbol, orderId, Date.now() + this.config.orderTimeoutMs);
    if (isNonTerminalProviderState(order)) {
      await this.client.cancelOrder(category, symbol, orderId);
      order = await this.client.awaitOrder(category, symbol, orderId, Date.now() + this.config.orderTimeoutMs);
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

function normalizeRequest(input: BinanceOrderInput): BinanceExecutionOrderRequest {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) throw new Error("A valid idempotencyKey is required.");
  const executionPriceMode = input.executionPriceMode ?? "IOC_LIMIT";
  const request = {
    category: input.category,
    symbol: providerSymbol(input.symbol),
    side: input.side,
    quantity: decimalQuantity(input.quantity),
    executionPriceMode,
    reduceOnly: input.reduceOnly,
    orderLinkId: `ptm${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 30)}`,
  };
  if (executionPriceMode === "MARKET") {
    if (input.limitPrice !== undefined) throw new Error("Binance MARKET order must not include a limit price.");
    return { ...request, executionPriceMode };
  }
  return { ...request, executionPriceMode, limitPrice: decimalPrice(input.limitPrice) };
}

function mutationSnapshotRiskValuationPrice(
  request: BinanceExecutionOrderRequest,
  snapshot: BinancePreflightSnapshot,
  maxSlippageBps: number,
): number {
  const instrument = request.category === "spot" ? snapshot.spot : snapshot.perpetual;
  const referencePrice = request.category === "linear"
    ? Math.max(instrument.ask, snapshot.perpetual.mark)
    : instrument.ask;
  const unrounded = referencePrice * (1 + maxSlippageBps / 10_000);
  const limitPrice = Math.ceil((unrounded - 1e-12) / instrument.priceTick) * instrument.priceTick;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0
    || !Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw new Error("Market risk valuation requires a valid mutation-time price snapshot.");
  }
  return limitPrice;
}

function fingerprint(request: BinanceExecutionOrderRequest, executionMode: BinanceOrderExecutionMode) {
  return createHash("sha256").update(JSON.stringify({ request, executionMode })).digest("hex");
}

function toLegacyRiskRequest(
  request: BinanceExecutionOrderRequest,
  snapshot: BinancePreflightSnapshot,
  maxSlippageBps: number,
): BinanceOrderRequest {
  if (request.symbol !== "XAUTUSDT") {
    throw new Error("Binance generic execution remains blocked until RiskGuard instrument scope is generalized.");
  }
  const limitPrice = request.executionPriceMode === "MARKET"
    ? mutationSnapshotRiskValuationPrice(request, snapshot, maxSlippageBps)
    : legacyDecimalNumber(request.limitPrice, "limitPrice");
  const quantityXaut = Number(request.quantity);
  if (!Number.isFinite(quantityXaut) || quantityXaut <= 0) {
    throw new Error("Binance order quantity is not representable by the legacy RiskGuard.");
  }
  return {
    category: request.category,
    symbol: "XAUTUSDT",
    side: request.side,
    quantityXaut,
    limitPrice,
    executionPriceMode: request.executionPriceMode,
    reduceOnly: request.reduceOnly,
    orderLinkId: request.orderLinkId,
  };
}

function providerSymbol(value: string) {
  if (!/^[A-Z0-9]{4,30}$/u.test(value)) throw new Error("Binance provider symbol is invalid.");
  return value;
}

function decimalQuantity(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new Error("Binance order quantity must be a positive decimal string.");
  }
  return value;
}

function decimalPrice(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new Error("Binance IOC limit price must be a positive decimal string.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
}

function legacyDecimalNumber(value: string, name: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`Binance legacy ${name} is not representable as a number.`);
  }
  return result;
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
