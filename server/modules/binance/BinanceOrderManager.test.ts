import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BinanceClientAdapter } from "./BinanceTypes";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { BinanceOrderManager } from "./BinanceOrderManager";
import { BinanceOrderStore } from "./BinanceOrderStore";
import { BinanceRiskGuard } from "./BinanceRiskGuard";
import { BinanceProviderError } from "./BinanceClient";
import { snapshotFixture, tradingConfigFixture } from "./binanceTestFixtures";

test("order manager persists one provider write for duplicate idempotency keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-order-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let writes = 0;
  const order: BinanceProviderOrder = {
    orderId: "provider-1", orderLinkId: "", status: "Filled", requestedQuantityXaut: 0.01,
    filledQuantityXaut: 0.01, averagePrice: 1_000, feeUsd: 0.01, updatedAt: Date.now(),
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
    quantityXaut: 0.01, limitPrice: 1_000, reduceOnly: false,
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

test("partially filled orders are cancelled before completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-personal-partial-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let reads = 0;
  let cancellations = 0;
  const partial: BinanceProviderOrder = {
    orderId: "provider-partial", orderLinkId: "", status: "PartiallyFilled", requestedQuantityXaut: 0.01,
    filledQuantityXaut: 0.005, averagePrice: 1_000, feeUsd: 0.01, updatedAt: Date.now(),
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
      quantityXaut: 0.01, limitPrice: 1_000, reduceOnly: false,
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
  const providerOrder = (): BinanceProviderOrder => ({
    orderId: "gtc-1", orderLinkId: clientOrderId, status: cancelled ? "Cancelled" : "New",
    requestedQuantityXaut: 0.01, filledQuantityXaut: 0, averagePrice: null, feeUsd: 0, updatedAt: Date.now(),
  });
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeTestOrder: async (request: { orderLinkId: string }) => {
      writes += 1;
      clientOrderId = request.orderLinkId;
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
    side: "Buy" as const, quantityXaut: 0.01, limitPrice: 900, reduceOnly: false,
  };
  try {
    assert.equal((await manager.placeTestOrder(input)).status, "New");
    assert.equal((await manager.placeTestOrder(input)).status, "New");
    assert.equal(writes, 1);
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
      orderId, orderLinkId: "", status: "Filled", requestedQuantityXaut: 0.01,
      filledQuantityXaut: 0.01, averagePrice: 1_000, feeUsd: 0, updatedAt: Date.now(),
    }),
    cancelOrder: async () => undefined,
    findOrderByClientOrderId: async () => null,
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    const first = manager.place({ idempotencyKey: "lock-1", category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.01, limitPrice: 1_000, reduceOnly: false });
    const second = manager.place({ idempotencyKey: "lock-2", category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.01, limitPrice: 1_000, reduceOnly: false });
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
      clientOrderId: `client-${index}`, category: "spot", executionMode: "production_ioc",
    });
  }
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    findOrderByClientOrderId: async (_category: string, clientOrderId: string) => ({
      orderId: clientOrderId, orderLinkId: clientOrderId, status: "Filled", requestedQuantityXaut: 0.01,
      filledQuantityXaut: 0.01, averagePrice: 1_000, feeUsd: 0, updatedAt: Date.now(),
    }),
  } as unknown as BinanceClientAdapter;
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(client, new BinanceRiskGuard(config), store, config);
  try {
    const result = await manager.reconcile();
    assert.equal(result.reconciled.length, 101);
    assert.equal(result.orders.length, 101);
    assert.equal(store.listProcessing().length, 0);
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
    category: "spot", executionMode: "production_ioc",
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
      quantityXaut: 0.01, limitPrice: 1_000, reduceOnly: false,
    }), /timeout/u);
    assert.equal(manager.listOrders()[0]?.status, "processing");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
