import { createHash } from "node:crypto";
import { executionPreMutationFailure } from "../cex/ExecutionCapability";
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
import {
  assertBinanceProviderOrderIdentity,
  assertBinanceSubmissionIdentity,
  BinanceProviderOrderIdentityError,
} from "./BinanceProviderOrderIdentity";

export type BinanceOrderInput = BinanceExecutionOrderRequest extends infer Request
  ? Request extends BinanceExecutionOrderRequest
    ? Omit<Request, "orderLinkId"> & { idempotencyKey: string }
    : never
  : never;

export type BinanceProviderMutationGuard = (riskValuationPrice: number) => void | Promise<void>;

export type BinanceOrderRiskRouting = "generic" | "legacy";

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
    riskRouting: BinanceOrderRiskRouting = "legacy",
  ) {
    return this.placeWithMode(input, "production_ioc", beforeProviderMutation, genericRiskContext, riskRouting);
  }

  placeTestOrder(input: BinanceOrderInput) {
    if (input.limitPrice === undefined) {
      throw new Error("Binance GTC test order requires an explicit Decimal limit price.");
    }
    return this.placeWithMode(
      { ...input, executionPriceMode: "IOC_LIMIT", limitPrice: input.limitPrice },
      "test_gtc",
      undefined,
      undefined,
      "legacy",
    );
  }

  private async placeWithMode(
    input: BinanceOrderInput,
    executionMode: BinanceOrderExecutionMode,
    beforeProviderMutation: BinanceProviderMutationGuard | undefined,
    genericRiskContext: BinanceGenericRiskContext | undefined,
    riskRouting: BinanceOrderRiskRouting,
  ) {
    const request = normalizeRequest(input);
    const requestFingerprint = fingerprint(input, executionMode);
    const reservation = this.store.reserve({
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      clientOrderId: request.orderLinkId,
      category: request.category,
      symbol: request.symbol,
      executionMode,
      ...(request.positionMode === undefined ? {} : { positionMode: request.positionMode }),
      ...(request.positionDirection === undefined ? {} : { positionDirection: request.positionDirection }),
      ...(request.positionSide === undefined ? {} : { positionSide: request.positionSide }),
      expectedSide: request.side,
      expectedBaseQuantity: request.quantity,
      ...(request.category === "linear" ? { expectedReduceOnly: request.reduceOnly } : {}),
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
      const legacyRiskRouting = riskRouting === "legacy";
      try {
        if (legacyRiskRouting) {
          const snapshot = await this.syncPositions();
          const legacyRiskRequest = toLegacyRiskRequest(request, snapshot, this.config.maxSlippageBps);
          this.risk.assertOrderAllowed(legacyRiskRequest, snapshot);
          await beforeProviderMutation?.(legacyRiskRequest.limitPrice);
        } else {
          if (beforeProviderMutation) {
            throw new Error("Binance legacy Capital Test guard cannot be used for generic execution.");
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
            ...(request.positionSide === undefined ? {} : { positionSide: request.positionSide }),
            ...(genericRiskContext.verifiedManagedClose === undefined ? {} : {
              verifiedManagedClose: genericRiskContext.verifiedManagedClose,
            }),
          });
          this.risk.assertGenericOrderAllowed(request, genericRiskContext, snapshot);
        }
        submissionStarted = true;
        const accepted = executionMode === "test_gtc"
          ? await this.client.placeTestOrder(request)
          : await this.client.placeOrder(request);
        const acceptedIdentity = assertBinanceSubmissionIdentity(accepted, {
          symbol: request.symbol,
          clientOrderId: request.orderLinkId,
        });
        providerOrderId = acceptedIdentity.orderId;
        this.store.recordProviderOrder(input.idempotencyKey, acceptedIdentity.orderId);

        if (executionMode === "test_gtc") {
          const observed = await this.findByClientOrderId(
            request.category,
            request.symbol,
            request.orderLinkId,
            acceptedIdentity.orderId,
            request.positionSide,
          );
          if (!observed) throw new Error("Binance GTC test order is pending provider reconciliation.");
          return this.persistProviderState(input.idempotencyKey, observed);
        }

        const order = await this.settleOrder(
          request.category,
          request.symbol,
          acceptedIdentity.orderId,
          request.orderLinkId,
          request.positionSide,
          providerFacts(request),
        );
        this.persistProviderState(input.idempotencyKey, order);
        if (legacyRiskRouting) await this.syncPositions();
        return order;
      } catch (error) {
        if (!submissionStarted) {
          this.store.fail(input.idempotencyKey, errorMessage(error));
          throw executionPreMutationFailure(error);
        }

        if (error instanceof BinanceProviderOrderIdentityError
          || (error instanceof BinanceProviderError && error.category === "provider_response_invalid")) {
          this.store.markProcessingError(input.idempotencyKey, error.message);
          throw error;
        }
        const recovered = await this.findByClientOrderId(
          request.category,
          request.symbol,
          request.orderLinkId,
          providerOrderId,
          request.positionSide,
        ).catch(() => null);
        if (recovered) {
          if (executionMode === "test_gtc") {
            return this.persistProviderState(input.idempotencyKey, recovered);
          }
          const settled = await this.settleOrder(
            request.category,
            request.symbol,
            recovered.orderId,
            request.orderLinkId,
            request.positionSide,
            providerFacts(request),
          ).catch(() => null);
          if (settled) {
            this.persistProviderState(input.idempotencyKey, settled);
            if (legacyRiskRouting) await this.syncPositions().catch(() => undefined);
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
      let stored = this.store.find(idempotencyKey);
      if (!stored) throw new Error("Binance order was not found.");
      if (stored.status !== "processing") {
        if (stored.order) return stored.order;
        throw new Error(stored.error ?? "Binance order is already terminal.");
      }

      const found = await this.findByClientOrderId(
        stored.category,
        stored.symbol,
        stored.clientOrderId,
        stored.providerOrderId,
        stored.positionSide,
        storedProviderFacts(stored),
      );
      if (!found) throw new Error("Binance provider order state is unavailable for cancellation.");
      if (stored.providerOrderId && stored.providerOrderId !== found.orderId) {
        throw new Error("Binance provider order identity conflicts with the persisted order.");
      }
      if (isTerminalProviderState(found)) return this.persistProviderState(idempotencyKey, found);
      if (!isActiveProviderState(found)) return this.persistProviderState(idempotencyKey, found);

      if (stored.cancelDispatchState === null) {
        this.store.claimCancellation(idempotencyKey);
        stored = this.store.find(idempotencyKey);
        if (!stored) throw new Error("Binance cancellation claim disappeared.");
      }
      if (stored.cancelDispatchState === "LEGACY_UNKNOWN") {
        this.persistProviderState(idempotencyKey, found);
        throw new Error("Legacy Binance cancellation dispatch state is ambiguous and requires manual reconciliation.");
      }
      if (stored.cancelDispatchState === "DISPATCHED_UNKNOWN") {
        return this.persistProviderState(idempotencyKey, found);
      }
      if (stored.cancelDispatchState !== "CLAIMED_NOT_DISPATCHED") {
        throw new Error("Binance cancellation dispatch state conflicts with the active provider order.");
      }

      let dispatchRecorded = false;
      const recordDispatch = () => {
        if (dispatchRecorded) return;
        if (!this.store.markCancellationDispatched(idempotencyKey)) {
          throw new Error("Binance cancellation dispatch could not be persisted.");
        }
        dispatchRecorded = true;
      };
      try {
        await this.client.cancelOrder(stored.category, stored.symbol, found.orderId, recordDispatch);
        // A successful adapter return is also authoritative dispatch evidence for compatible clients
        // that do not expose the transport-start callback.
        recordDispatch();
      } catch (error) {
        const recovered = await this.findByClientOrderId(
          stored.category,
          stored.symbol,
          stored.clientOrderId,
          stored.providerOrderId,
          stored.positionSide,
        ).catch(() => null);
        if (!recovered) throw error;
        return this.persistProviderState(idempotencyKey, recovered);
      }

      const order = await this.client.awaitOrder(
        stored.category,
        stored.symbol,
        found.orderId,
        Date.now() + this.config.orderTimeoutMs,
        stored.clientOrderId,
      );
      const result = this.persistProviderState(idempotencyKey, order);
      if (stored.symbol === "XAUTUSDT") await this.syncPositions();
      return result;
    });
  }

  async reconcile() {
    return this.orderLock.run(async () => {
      const reconciled: BinanceProviderOrder[] = [];
      const processing = this.store.listProcessingWithIsolation();
      for (const stored of processing.orders) {
        let order: BinanceProviderOrder | null;
        try {
          order = await this.findByClientOrderId(
            stored.category,
            stored.symbol,
            stored.clientOrderId,
            stored.providerOrderId,
            stored.positionSide,
          );
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
              stored.clientOrderId,
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
      const all = this.store.listAllWithIsolation();
      const isolatedOrders = [...new Map(
        [...processing.isolatedOrders, ...all.isolatedOrders]
          .map((order) => [order.idempotencyKey, order]),
      ).values()];
      return { reconciled, snapshot, orders: all.orders, isolatedOrders };
    });
  }

  listOrders() {
    return this.store.list();
  }

  ordersState() {
    return this.store.listAllWithIsolation();
  }

  orderState(idempotencyKey: string) {
    return this.store.lookup(idempotencyKey);
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

    const recovered = await this.findByClientOrderId(
      stored.category,
      stored.symbol,
      stored.clientOrderId,
      stored.providerOrderId,
      stored.positionSide,
    );
    if (!recovered) {
      if (this.processingExpired(stored)) {
        this.store.fail(idempotencyKey, "Processing timeout: Binance order was not found by clientOrderId.");
      }
      throw new Error("Binance order is still pending reconciliation.");
    }

    if (stored.executionMode === "production_ioc" && isNonTerminalProviderState(recovered)) {
      const settled = await this.settleOrder(
        stored.category,
        stored.symbol,
        recovered.orderId,
        stored.clientOrderId,
        stored.positionSide,
        storedProviderFacts(stored),
      ).catch(() => null);
      if (!settled) {
        this.store.recordProcessingOrder(idempotencyKey, recovered);
        throw new Error("Binance order is still pending reconciliation.");
      }
      return this.persistProviderState(idempotencyKey, settled);
    }
    return this.persistProviderState(idempotencyKey, recovered);
  }

  private persistProviderState(idempotencyKey: string, order: BinanceProviderOrder) {
    const stored = this.store.find(idempotencyKey);
    if (!stored) throw new Error("Binance order identity reservation disappeared.");
    assertBinanceProviderOrderIdentity(order, {
      symbol: stored.symbol,
      clientOrderId: stored.clientOrderId,
      providerOrderId: stored.providerOrderId,
      positionSide: stored.positionSide,
      side: stored.expectedSide,
      requestedBaseQuantity: stored.expectedBaseQuantity,
      reduceOnly: stored.expectedReduceOnly,
    });
    if (order.status === "Filled") {
      this.store.complete(idempotencyKey, order);
    } else if (isFailedProviderState(order)) {
      this.store.failWithOrder(idempotencyKey, order, `Binance order ended with ${order.status}.`);
    } else {
      this.store.recordProcessingOrder(idempotencyKey, order);
    }
    return order;
  }

  private async findByClientOrderId(
    category: "spot" | "linear",
    symbol: string,
    clientOrderId: string,
    providerOrderId?: string | null,
    positionSide?: "BOTH" | "LONG" | "SHORT",
    facts: Readonly<{ side?: "Buy" | "Sell"; requestedBaseQuantity?: string; reduceOnly?: boolean }> = {},
  ) {
    const order = await this.client.findOrderByClientOrderId(category, symbol, clientOrderId);
    return order
      ? assertBinanceProviderOrderIdentity(order, { symbol, clientOrderId, providerOrderId, positionSide, ...facts })
      : null;
  }

  private async settleOrder(
    category: "spot" | "linear",
    symbol: string,
    orderId: string,
    clientOrderId: string,
    positionSide?: "BOTH" | "LONG" | "SHORT",
    facts: Readonly<{ side?: "Buy" | "Sell"; requestedBaseQuantity?: string; reduceOnly?: boolean }> = {},
  ) {
    let order = assertBinanceProviderOrderIdentity(
      await this.client.awaitOrder(category, symbol, orderId, Date.now() + this.config.orderTimeoutMs, clientOrderId),
      { symbol, clientOrderId, providerOrderId: orderId, positionSide, ...facts },
    );
    if (isNonTerminalProviderState(order)) {
      await this.client.cancelOrder(category, symbol, orderId);
      order = assertBinanceProviderOrderIdentity(
        await this.client.awaitOrder(category, symbol, orderId, Date.now() + this.config.orderTimeoutMs, clientOrderId),
        { symbol, clientOrderId, providerOrderId: orderId, positionSide, ...facts },
      );
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
    ...(input.positionDirection === undefined ? {} : { positionDirection: input.positionDirection }),
    ...(input.positionSide === undefined ? {} : { positionSide: input.positionSide }),
    ...(input.positionMode === undefined ? {} : { positionMode: input.positionMode }),
    orderLinkId: `ptm${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 30)}`,
  };
  if (executionPriceMode === "MARKET") {
    if (input.limitPrice !== undefined) throw new Error("Binance MARKET order must not include a limit price.");
    return { ...request, executionPriceMode };
  }
  return { ...request, executionPriceMode, limitPrice: decimalPrice(input.limitPrice) };
}

function providerFacts(request: BinanceExecutionOrderRequest) {
  return Object.freeze({
    side: request.side,
    requestedBaseQuantity: request.quantity,
    ...(request.category === "linear" ? { reduceOnly: request.reduceOnly } : {}),
  });
}

function storedProviderFacts(stored: BinanceStoredOrder) {
  return Object.freeze({
    side: stored.expectedSide,
    requestedBaseQuantity: stored.expectedBaseQuantity,
    reduceOnly: stored.expectedReduceOnly,
  });
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

function fingerprint(request: BinanceOrderInput, executionMode: BinanceOrderExecutionMode) {
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

function isActiveProviderState(order: BinanceProviderOrder) {
  return order.status === "New" || order.status === "PartiallyFilled";
}

function isTerminalProviderState(order: BinanceProviderOrder) {
  return order.status === "Filled" || isFailedProviderState(order);
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
