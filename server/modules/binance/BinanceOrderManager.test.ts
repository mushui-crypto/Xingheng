import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BinanceClientAdapter } from "./BinanceTypes";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { BinanceOrderManager } from "./BinanceOrderManager";
import { BinanceOrderStore } from "./BinanceOrderStore";
import { BinanceRiskError, BinanceRiskGuard } from "./BinanceRiskGuard";
import { BinanceProviderError } from "./BinanceClient";
import { snapshotFixture, tradingConfigFixture } from "./binanceTestFixtures";

test("order manager persists one provider write for duplicate idempotency keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-order-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let writes = 0;
  const order: BinanceProviderOrder = {
    orderId: "provider-1", orderLinkId: "", status: "Filled", requestedQuantity: 0.01,
    filledQuantity: 0.01, averagePrice: 1_000, feeUsd: 0.01, updatedAt: Date.now(),
  };
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeOrder: async (request: { orderLinkId: string }) => {
      writes += 1;
      order.orderLinkId = request.orderLinkId;
      return { orderId: order.orderId, orderLinkId: request.orderLinkId };
    },
    awaitOrder: async () => order,
    cancelOrder: async () => undefined,
    findOrderByClientOrderId: async () => order,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  const input = {
    idempotencyKey: "entry-1", category: "spot" as const, symbol: "XAUTUSDT" as const, side: "Buy" as const,
    quantity: "0.01", limitPrice: "1000", reduceOnly: false,
  };
  try {
    const first = await manager.place(input);
    const second = await manager.place(input);
    assert.equal(first.orderId, "provider-1");
    assert.equal(second.orderId, "provider-1");
    assert.equal(writes, 1);
    assert.equal(manager.listOrders()[0]?.status, "completed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider mutation guard runs after risk refresh and immediately before provider submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-expiry-guard-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  const events: string[] = [];
  const client = {
    readPreflightSnapshot: async () => {
      events.push("risk-refresh");
      return snapshotFixture();
    },
    placeOrder: async () => {
      events.push("provider-mutation");
      return { orderId: "must-not-submit", orderLinkId: "must-not-submit" };
    },
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    await assert.rejects(
      () => manager.place({
        idempotencyKey: "expired-before-provider-mutation",
        category: "spot",
        symbol: "XAUTUSDT",
        side: "Buy",
        quantity: "0.01",
        limitPrice: "1000",
        reduceOnly: false,
      }, () => {
        events.push("expiry-guard");
        throw new Error("Capital Test intent expired before provider mutation.");
      }),
      /expired before provider mutation/u,
    );
    assert.deepEqual(events, ["risk-refresh", "expiry-guard"]);
    assert.equal(manager.listOrders()[0]?.status, "failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic symbols use instrument-scoped private risk state without reading the XAUT snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-generic-risk-boundary-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let writes = 0;
  let legacyReads = 0;
  const riskReads: Array<Record<string, unknown>> = [];
  const filled: BinanceProviderOrder = {
    orderId: "btc-filled", orderLinkId: "", status: "Filled", requestedQuantity: 0.001,
    filledQuantity: 0.001, averagePrice: 65_000, feeUsd: 0, updatedAt: Date.now(),
  };
  const client = {
    readPreflightSnapshot: async () => { legacyReads += 1; return snapshotFixture(); },
    readGenericRiskSnapshot: async (request: Record<string, unknown>) => {
      riskReads.push(request);
      return genericRiskSnapshot({ symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "65" });
    },
    placeOrder: async (request: { orderLinkId: string }) => {
      writes += 1;
      filled.orderLinkId = request.orderLinkId;
      return { orderId: filled.orderId, orderLinkId: request.orderLinkId };
    },
    awaitOrder: async () => filled,
    findOrderByClientOrderId: async () => filled,
    cancelOrder: async () => undefined,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    await manager.place({
      idempotencyKey: "btc-risk-boundary",
      category: "spot",
      symbol: "BTCUSDT",
      side: "Buy",
      quantity: "0.001",
      limitPrice: "65000",
      reduceOnly: false,
    }, undefined, genericRiskContext());
    assert.equal(writes, 1);
    assert.equal(legacyReads, 0);
    assert.deepEqual(riskReads, [{ category: "spot", symbol: "BTCUSDT", baseAsset: "BTC" }]);
    assert.equal(store.find("btc-risk-boundary")?.symbol, "BTCUSDT");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("partially filled orders are cancelled before completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-partial-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let reads = 0;
  let cancellations = 0;
  const partial: BinanceProviderOrder = {
    orderId: "provider-partial", orderLinkId: "", status: "PartiallyFilled", requestedQuantity: 0.01,
    filledQuantity: 0.005, averagePrice: 1_000, feeUsd: 0.01, updatedAt: Date.now(),
  };
  const cancelled: BinanceProviderOrder = { ...partial, status: "Cancelled" };
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeOrder: async (request: { orderLinkId: string }) => ({ orderId: partial.orderId, orderLinkId: request.orderLinkId }),
    awaitOrder: async () => (++reads === 1 ? partial : cancelled),
    cancelOrder: async () => { cancellations += 1; },
    findOrderByClientOrderId: async () => partial,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    const result = await manager.place({
      idempotencyKey: "partial-1", category: "spot", symbol: "XAUTUSDT", side: "Buy",
      quantity: "0.01", limitPrice: "1000", reduceOnly: false,
    });
    assert.equal(result.status, "Cancelled");
    assert.equal(cancellations, 1);
    assert.equal(manager.listOrders()[0]?.status, "failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GTC test order remains processing until explicit cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-gtc-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let writes = 0;
  let cancelled = false;
  let clientOrderId = "";
  let submittedMode: string | undefined;
  const providerOrder = (): BinanceProviderOrder => ({
    orderId: "gtc-1", orderLinkId: clientOrderId, status: cancelled ? "Cancelled" : "New",
    requestedQuantity: 0.01, filledQuantity: 0, averagePrice: null, feeUsd: 0, updatedAt: Date.now(),
  });
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeTestOrder: async (request: { orderLinkId: string; executionPriceMode?: string }) => {
      writes += 1;
      clientOrderId = request.orderLinkId;
      submittedMode = request.executionPriceMode;
      return { orderId: "gtc-1", orderLinkId: request.orderLinkId };
    },
    findOrderByClientOrderId: async () => providerOrder(),
    cancelOrder: async () => { cancelled = true; },
    awaitOrder: async () => providerOrder(),
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  const input = {
    idempotencyKey: "gtc-test-1", category: "spot" as const, symbol: "XAUTUSDT" as const,
    side: "Buy" as const, quantity: "0.01", limitPrice: "900", reduceOnly: false,
  };
  try {
    assert.equal((await manager.placeTestOrder(input)).status, "New");
    assert.equal((await manager.placeTestOrder(input)).status, "New");
    assert.equal(writes, 1);
    assert.equal(submittedMode, "IOC_LIMIT");
    assert.equal(manager.listOrders()[0]?.status, "processing");
    assert.equal((await manager.cancel(input.idempotencyKey)).status, "Cancelled");
    assert.equal(manager.listOrders()[0]?.status, "failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("risk refresh and provider submission are serialized across orders", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-lock-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let snapshotReads = 0;
  let writes = 0;
  let releaseFirst!: () => void;
  const firstSubmitted = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstBlocked = true;
  const client = {
    readPreflightSnapshot: async () => { snapshotReads += 1; return snapshotFixture(); },
    placeOrder: async (request: { orderLinkId: string }) => {
      writes += 1;
      if (firstBlocked) {
        firstBlocked = false;
        await firstSubmitted;
      }
      return { orderId: `provider-${writes}`, orderLinkId: request.orderLinkId };
    },
    awaitOrder: async (_category: string, orderId: string) => ({
      orderId, orderLinkId: "", status: "Filled", requestedQuantity: 0.01,
      filledQuantity: 0.01, averagePrice: 1_000, feeUsd: 0, updatedAt: Date.now(),
    }),
    cancelOrder: async () => undefined,
    findOrderByClientOrderId: async () => null,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    const first = manager.place({ idempotencyKey: "lock-1", category: "spot", symbol: "XAUTUSDT", side: "Buy", quantity: "0.01", limitPrice: "1000", reduceOnly: false });
    const second = manager.place({ idempotencyKey: "lock-2", category: "spot", symbol: "XAUTUSDT", side: "Buy", quantity: "0.01", limitPrice: "1000", reduceOnly: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshotReads, 1);
    assert.equal(writes, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(writes, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation scans every processing order without a 100 row limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-reconcile-all-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  for (let index = 0; index < 101; index += 1) {
    store.reserve({
      idempotencyKey: `pending-${index}`, requestFingerprint: `fingerprint-${index}`,
      clientOrderId: `client-${index}`, category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
    });
  }
  const queriedSymbols: string[] = [];
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    findOrderByClientOrderId: async (_category: string, symbol: string, clientOrderId: string) => {
      queriedSymbols.push(symbol);
      return ({
      orderId: clientOrderId, orderLinkId: clientOrderId, status: "Filled", requestedQuantity: 0.01,
      filledQuantity: 0.01, averagePrice: 1_000, feeUsd: 0, updatedAt: Date.now(),
      });
    },
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    const result = await manager.reconcile();
    assert.equal(result.reconciled.length, 101);
    assert.equal(result.orders.length, 101);
    assert.equal(store.listProcessing().length, 0);
    assert.deepEqual(new Set(queriedSymbols), new Set(["BTCUSDT"]));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy XAUT Spot SELL cannot reach the provider while risk gates are closed", async () => {
  for (const config of [
    tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: false }),
    tradingConfigFixture({ liveTradingEnabled: true, killSwitchActive: true }),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "binance-legacy-spot-close-gate-"));
    const store = new BinanceOrderStore(join(root, "orders.sqlite"));
    let providerWrites = 0;
    const client = {
      readPreflightSnapshot: async () => snapshotFixture(),
      placeOrder: async () => {
        providerWrites += 1;
        return { orderId: "must-not-submit", orderLinkId: "must-not-submit" };
      },
    } as unknown as BinanceClientAdapter;
    const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
    try {
      await assert.rejects(
        () => manager.place({
          idempotencyKey: `legacy-spot-close-${String(config.liveTradingEnabled)}-${String(config.killSwitchActive)}`,
          category: "spot",
          symbol: "XAUTUSDT",
          side: "Sell",
          quantity: "0.01",
          limitPrice: "1000",
          reduceOnly: false,
        }),
        (error: unknown) => error instanceof BinanceRiskError
          && ["live_trading_disabled", "kill_switch_active"].includes(error.category),
      );
      assert.equal(providerWrites, 0);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cancel uses the persisted generic provider symbol", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-generic-cancel-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  store.reserve({
    idempotencyKey: "generic-cancel",
    requestFingerprint: "generic-cancel-fingerprint",
    clientOrderId: "generic-client-order",
    category: "linear",
    symbol: "DOGEUSDT",
    executionMode: "production_ioc",
  });
  store.recordProviderOrder("generic-cancel", "generic-provider-order");
  const symbols: string[] = [];
  const cancelled: BinanceProviderOrder = {
    orderId: "generic-provider-order",
    orderLinkId: "generic-client-order",
    status: "Cancelled",
    requestedQuantity: 12,
    filledQuantity: 0,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: Date.now(),
  };
  const active = { ...cancelled, status: "New" as const };
  let legacyReads = 0;
  const client = {
    readPreflightSnapshot: async () => { legacyReads += 1; return snapshotFixture(); },
    findOrderByClientOrderId: async (_category: string, symbol: string) => {
      symbols.push(symbol);
      return active;
    },
    cancelOrder: async (_category: string, symbol: string) => { symbols.push(symbol); },
    awaitOrder: async (_category: string, symbol: string) => {
      symbols.push(symbol);
      return cancelled;
    },
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    assert.equal((await manager.cancel("generic-cancel")).status, "Cancelled");
    assert.ok(symbols.length >= 3);
    assert.ok(symbols.every((symbol) => symbol === "DOGEUSDT"));
    assert.equal(legacyReads, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel fails closed without a StellaX-known persisted order identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-unknown-cancel-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let providerMutations = 0;
  const client = {
    cancelOrder: async () => { providerMutations += 1; },
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: true });
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    await assert.rejects(() => manager.cancel("unknown-order"), /not found/u);
    assert.equal(providerMutations, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated cancel after an ambiguous provider response never repeats the provider mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-cancel-idempotency-"));
  const dbPath = join(root, "orders.sqlite");
  let store = new BinanceOrderStore(dbPath);
  store.reserve({
    idempotencyKey: "cancel-once",
    requestFingerprint: "cancel-once-fingerprint",
    clientOrderId: "cancel-once-client",
    category: "spot",
    symbol: "BTCUSDT",
    executionMode: "production_ioc",
  });
  store.recordProviderOrder("cancel-once", "cancel-once-provider");
  const active: BinanceProviderOrder = {
    orderId: "cancel-once-provider",
    orderLinkId: "cancel-once-client",
    status: "New",
    requestedQuantity: 0.001,
    filledQuantity: 0,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: Date.now(),
  };
  let providerCancels = 0;
  const client = {
    findOrderByClientOrderId: async () => active,
    cancelOrder: async (_category: string, _symbol: string, _orderId: string, onDispatch?: () => void) => {
      providerCancels += 1;
      onDispatch?.();
      throw new Error("ambiguous cancel");
    },
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: true });
  try {
    let manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
    assert.equal((await manager.cancel("cancel-once")).status, "New");
    assert.equal(providerCancels, 1);
    store.close();

    store = new BinanceOrderStore(dbPath);
    manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
    assert.equal((await manager.cancel("cancel-once")).status, "New");
    assert.equal(providerCancels, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart after claim but before dispatch can cancel an active provider order exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-cancel-before-dispatch-"));
  const dbPath = join(root, "orders.sqlite");
  let store = new BinanceOrderStore(dbPath);
  store.reserve({
    idempotencyKey: "cancel-recover", requestFingerprint: "fingerprint", clientOrderId: "client",
    category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
  });
  store.recordProviderOrder("cancel-recover", "provider");
  store.claimCancellation("cancel-recover");
  store.close();

  const active: BinanceProviderOrder = {
    orderId: "provider", orderLinkId: "client", status: "New",
    requestedQuantity: 0.001, filledQuantity: 0,
    requestedBaseQuantity: "0.001", filledBaseQuantity: "0",
    averagePrice: null, feeUsd: 0, updatedAt: Date.now(),
  };
  const cancelled = { ...active, status: "Cancelled" as const };
  let providerCancels = 0;
  const client = {
    findOrderByClientOrderId: async () => active,
    cancelOrder: async (_category: string, _symbol: string, _orderId: string, onDispatch?: () => void) => {
      providerCancels += 1;
      onDispatch?.();
    },
    awaitOrder: async () => cancelled,
  } as unknown as BinanceClientAdapter;
  store = new BinanceOrderStore(dbPath);
  const config = tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: true });
  try {
    const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
    assert.equal((await manager.cancel("cancel-recover")).status, "Cancelled");
    assert.equal(providerCancels, 1);
    assert.equal(store.find("cancel-recover")?.cancelDispatchState, "TERMINAL_CONFIRMED");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch evidence plus a terminal provider query never repeats cancel after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-cancel-after-dispatch-"));
  const dbPath = join(root, "orders.sqlite");
  let store = new BinanceOrderStore(dbPath);
  store.reserve({
    idempotencyKey: "cancel-terminal", requestFingerprint: "fingerprint", clientOrderId: "client",
    category: "linear", symbol: "ETHUSDT", executionMode: "production_ioc",
  });
  store.recordProviderOrder("cancel-terminal", "provider");
  store.claimCancellation("cancel-terminal");
  store.markCancellationDispatched("cancel-terminal");
  store.close();

  let providerCancels = 0;
  const terminal: BinanceProviderOrder = {
    orderId: "provider", orderLinkId: "client", status: "Cancelled",
    requestedQuantity: 0.02, filledQuantity: 0.007,
    requestedBaseQuantity: "0.02", filledBaseQuantity: "0.007",
    averagePrice: null, feeUsd: 0, updatedAt: Date.now(),
  };
  const client = {
    findOrderByClientOrderId: async () => terminal,
    cancelOrder: async () => { providerCancels += 1; },
  } as unknown as BinanceClientAdapter;
  store = new BinanceOrderStore(dbPath);
  try {
    const manager = new BinanceOrderManager(client, new BinanceRiskGuard(tradingConfigFixture()), store, tradingConfigFixture());
    const result = await manager.cancel("cancel-terminal");
    assert.equal(result.filledBaseQuantity, "0.007");
    assert.equal(providerCancels, 0);
    assert.equal(store.find("cancel-terminal")?.cancelDispatchState, "TERMINAL_CONFIRMED");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure before dispatch remains safely retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-cancel-pre-dispatch-failure-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  store.reserve({
    idempotencyKey: "cancel-retry", requestFingerprint: "fingerprint", clientOrderId: "client",
    category: "spot", symbol: "DOGEUSDT", executionMode: "production_ioc",
  });
  store.recordProviderOrder("cancel-retry", "provider");
  const active: BinanceProviderOrder = {
    orderId: "provider", orderLinkId: "client", status: "New",
    requestedQuantity: 72, filledQuantity: 0,
    requestedBaseQuantity: "72", filledBaseQuantity: "0",
    averagePrice: null, feeUsd: 0, updatedAt: Date.now(),
  };
  const cancelled = { ...active, status: "Cancelled" as const };
  let attempts = 0;
  const client = {
    findOrderByClientOrderId: async () => active,
    cancelOrder: async (_category: string, _symbol: string, _orderId: string, onDispatch?: () => void) => {
      attempts += 1;
      if (attempts === 1) throw new Error("failed before dispatch");
      onDispatch?.();
    },
    awaitOrder: async () => cancelled,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: true });
  try {
    const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
    assert.equal((await manager.cancel("cancel-retry")).status, "New");
    assert.equal(store.find("cancel-retry")?.cancelDispatchState, "CLAIMED_NOT_DISPATCHED");
    assert.equal((await manager.cancel("cancel-retry")).status, "Cancelled");
    assert.equal(attempts, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart keeps BTC, ETH, and DOGE symbols authoritative for cancel and reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-generic-symbol-restart-"));
  const dbPath = join(root, "orders.sqlite");
  let store = new BinanceOrderStore(dbPath);
  for (const symbol of ["BTCUSDT", "ETHUSDT", "DOGEUSDT"]) {
    const category = symbol === "DOGEUSDT" ? "linear" as const : "spot" as const;
    for (const operation of ["cancel", "reconcile"] as const) {
      store.reserve({
        idempotencyKey: `${operation}-${symbol}`,
        requestFingerprint: `${operation}-fingerprint-${symbol}`,
        clientOrderId: `${operation}-client-${symbol}`,
        category,
        symbol,
        executionMode: "production_ioc",
      });
      if (operation === "cancel") store.recordProviderOrder(`${operation}-${symbol}`, `${operation}-provider-${symbol}`);
    }
  }
  store.close();

  store = new BinanceOrderStore(dbPath);
  const queries: Array<{ operation: string; symbol: string }> = [];
  const cancellations: string[] = [];
  const awaits: string[] = [];
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    findOrderByClientOrderId: async (_category: string, symbol: string, clientOrderId: string) => {
      const operation = clientOrderId.startsWith("cancel-") ? "cancel" : "reconcile";
      queries.push({ operation, symbol });
      return {
        orderId: `${operation}-provider-${symbol}`,
        orderLinkId: clientOrderId,
        status: operation === "cancel" ? "New" : "Filled",
        requestedQuantity: 1,
        filledQuantity: operation === "cancel" ? 0 : 1,
        averagePrice: operation === "cancel" ? null : 1,
        feeUsd: 0,
        updatedAt: Date.now(),
      } satisfies BinanceProviderOrder;
    },
    cancelOrder: async (_category: string, symbol: string) => { cancellations.push(symbol); },
    awaitOrder: async (_category: string, symbol: string, orderId: string) => {
      awaits.push(symbol);
      return {
        orderId,
        orderLinkId: `cancel-client-${symbol}`,
        status: "Cancelled",
        requestedQuantity: 1,
        filledQuantity: 0,
        averagePrice: null,
        feeUsd: 0,
        updatedAt: Date.now(),
      } satisfies BinanceProviderOrder;
    },
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "DOGEUSDT"]) {
      assert.equal((await manager.cancel(`cancel-${symbol}`)).status, "Cancelled");
    }
    const result = await manager.reconcile();
    assert.equal(result.reconciled.length, 3);
    assert.deepEqual(
      new Set(queries.filter((query) => query.operation === "reconcile").map((query) => query.symbol)),
      new Set(["BTCUSDT", "ETHUSDT", "DOGEUSDT"]),
    );
    assert.deepEqual(new Set(cancellations), new Set(["BTCUSDT", "ETHUSDT", "DOGEUSDT"]));
    assert.deepEqual(new Set(awaits), new Set(["BTCUSDT", "ETHUSDT", "DOGEUSDT"]));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("processing timeout fails an order authoritatively absent from Binance", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-processing-timeout-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  store.reserve({
    idempotencyKey: "missing-1", requestFingerprint: "missing-fingerprint", clientOrderId: "missing-client",
    category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
  });
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    findOrderByClientOrderId: async () => null,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture({ processingTimeoutMs: 1 });
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.reconcile();
    assert.equal(store.find("missing-1")?.status, "failed");
    assert.match(store.find("missing-1")?.error ?? "", /Processing timeout/u);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous provider submission remains pending reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-timeout-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeOrder: async () => { throw new BinanceProviderError("provider_timeout", "timeout"); },
    findOrderByClientOrderId: async () => null,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    await assert.rejects(() => manager.place({
      idempotencyKey: "timeout-1", category: "spot", symbol: "XAUTUSDT", side: "Buy",
      quantity: "0.01", limitPrice: "1000", reduceOnly: false,
    }), /timeout/u);
    assert.equal(manager.listOrders()[0]?.status, "processing");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("market fills preserve authoritative FILLED with missing or volatile averagePrice", async (t) => {
  for (const averagePrice of [null, 1_500]) {
    await t.test(String(averagePrice), async () => {
      const root = mkdtempSync(join(tmpdir(), "binance-market-fact-"));
      const store = new BinanceOrderStore(join(root, "orders.sqlite"));
      const order: BinanceProviderOrder = {
        orderId: `market-${String(averagePrice)}`,
        orderLinkId: "",
        status: "Filled",
        requestedQuantity: 0.01,
        filledQuantity: 0.01,
        averagePrice,
        feeUsd: 0,
        updatedAt: Date.now(),
      };
      const submitted: Array<Record<string, unknown>> = [];
      const client = {
        readPreflightSnapshot: async () => snapshotFixture(),
        placeOrder: async (request: Record<string, unknown>) => {
          submitted.push(request);
          order.orderLinkId = String(request.orderLinkId);
          return { orderId: order.orderId, orderLinkId: order.orderLinkId };
        },
        awaitOrder: async () => order,
      } as unknown as BinanceClientAdapter;
      const config = tradingConfigFixture();
      const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
      try {
        const result = await manager.place({
          idempotencyKey: `market-fact-${String(averagePrice)}`,
          category: "spot",
          symbol: "XAUTUSDT",
          side: "Buy",
          quantity: "0.01",
          executionPriceMode: "MARKET",
          reduceOnly: false,
        });
        assert.equal(result.status, "Filled");
        assert.equal(result.averagePrice, averagePrice);
        assert.equal(Object.hasOwn(submitted[0] ?? {}, "limitPrice"), false);
        assert.equal(store.find(`market-fact-${String(averagePrice)}`)?.status, "completed");
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("MARKET linear Sell valuation conservatively enforces max order and position limits", async (t) => {
  for (const scenario of [
    { name: "max order", maxOrderUsd: 25, maxPositionUsd: 100, existingSpotQuantityXaut: 0, error: /MAX_ORDER_USD/u },
    { name: "max position", maxOrderUsd: 100, maxPositionUsd: 30, existingSpotQuantityXaut: 0.005, error: /MAX_POSITION_USD/u },
  ]) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), "binance-market-short-risk-"));
      const store = new BinanceOrderStore(join(root, "orders.sqlite"));
      let providerWrites = 0;
      const snapshot = snapshotFixture({
        existingSpotQuantityXaut: scenario.existingSpotQuantityXaut,
        perpetual: {
          ...snapshotFixture().perpetual,
          bid: 990,
          ask: 1_000,
          mark: 1_002,
          priceTick: 0.1,
        },
      });
      const client = {
        readPreflightSnapshot: async () => snapshot,
        placeOrder: async () => {
          providerWrites += 1;
          return { orderId: "must-not-submit", orderLinkId: "must-not-submit" };
        },
      } as unknown as BinanceClientAdapter;
      const config = tradingConfigFixture({
        maxOrderUsd: scenario.maxOrderUsd,
        maxPositionUsd: scenario.maxPositionUsd,
      });
      const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
      try {
        await assert.rejects(() => manager.place({
          idempotencyKey: `market-short-${scenario.name}`,
          category: "linear",
          symbol: "XAUTUSDT",
          side: "Sell",
          quantity: "0.02491",
          executionPriceMode: "MARKET",
          reduceOnly: false,
        }), scenario.error);
        assert.equal(providerWrites, 0);
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

function genericRiskContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-a",
    accountId: "binance:test",
    instrumentId: "BTC-USDT-SPOT",
    category: "spot" as const,
    providerSymbol: "BTCUSDT",
    baseAsset: "BTC",
    instrumentStatus: "trading" as const,
    valuationPrice: "65000",
    quoteFetchedAt: Date.now(),
    ...overrides,
  } as any;
}

function genericRiskSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "binance:test",
    accountFingerprint: "test",
    fetchedAt: Date.now(),
    accountMode: "single_asset_one_way" as const,
    permissions: {
      read: true, spotTrade: true, contractTrade: true, withdraw: false, ipRestricted: true,
      spotAccount: true, futuresAccount: true, positionModeSupported: true,
    },
    category: "spot" as const,
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    availableUsdt: "1000",
    availableBaseAsset: "1",
    openOrderCount: 0,
    position: null,
    ...overrides,
  } as any;
}
