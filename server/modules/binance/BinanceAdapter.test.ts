import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
  BinanceAdapter,
} from "./BinanceAdapter";
import { BinanceOrderManager } from "./BinanceOrderManager";
import { BinanceOrderStore } from "./BinanceOrderStore";
import { BinanceRiskGuard } from "./BinanceRiskGuard";
import type { BinanceClientAdapter, BinanceExecutionOrderRequest, BinanceProviderOrder } from "./BinanceTypes";
import { snapshotFixture, tradingConfigFixture } from "./binanceTestFixtures";

test("adapter exposes no mutation-capable client surface", () => {
  const client = {
    placeOrder: async () => ({ orderId: "1004", orderLinkId: "forbidden" }),
    placeTestOrder: async () => ({ orderId: "1004", orderLinkId: "forbidden" }),
    cancelOrder: async () => undefined,
    setPerpetualLeverage: async () => undefined,
  } as unknown as BinanceClientAdapter;
  const adapter = new BinanceAdapter(client);

  assert.equal("compatibilityClient" in adapter, false);
  assertNoMutationSurface(adapter);
});

test("canonical read capabilities map the existing Binance snapshot without mutation", async () => {
  const snapshot = snapshotFixture();
  let snapshotReads = 0;
  const client = {
    readPreflightSnapshot: async () => {
      snapshotReads += 1;
      return snapshot;
    },
  } as unknown as BinanceClientAdapter;
  const adapter = new BinanceAdapter(client);

  const instruments = await adapter.instrumentCatalog.listInstruments();
  const spotBook = await adapter.marketData.getTopOfBook(BINANCE_SPOT_INSTRUMENT_ID);
  const funding = await adapter.fundingRate.getFundingRate(BINANCE_PERPETUAL_INSTRUMENT_ID);
  const account = await adapter.accountRead.getAccountSnapshot();

  assert.deepEqual(instruments.map((instrument) => instrument.instrumentId), [
    BINANCE_SPOT_INSTRUMENT_ID,
    BINANCE_PERPETUAL_INSTRUMENT_ID,
  ]);
  assert.equal(instruments[0]?.providerSymbol, "XAUTUSDT");
  assert.equal(instruments[1]?.providerLocator.scope, "futures");
  assert.equal(spotBook.bid, snapshot.spot.bid);
  assert.equal(funding.rate, snapshot.perpetual.fundingRate);
  assert.equal(funding.intervalHours, snapshot.perpetual.fundingIntervalHours);
  assert.equal(account.accountId, snapshot.accountId);
  assert.equal(account.openOrderCount, snapshot.openSpotOrderCount + snapshot.openPerpetualOrderCount);
  assert.equal(account.positions[1]?.marginMode, snapshot.perpetual.marginMode);
  assert.equal(snapshotReads, 4);
});

test("adapter exposes no direct mutation capability", () => {
  const adapter = new BinanceAdapter({} as BinanceClientAdapter);
  assert.equal("orderExecution" in adapter, false);

  const source = readFileSync(new URL("./BinanceAdapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /compatibilityClient/u);
  assert.doesNotMatch(source, /this\.client\.(?:placeOrder|placeTestOrder|cancelOrder)\s*\(/u);
  assert.doesNotMatch(source, /OrderExecutionPort/u);
});

test("read-only adapter does not change OrderManager idempotency and provider write count", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-adapter-manager-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let writes = 0;
  let orderLinkId = "";
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeOrder: async (request: BinanceExecutionOrderRequest) => {
      writes += 1;
      orderLinkId = request.orderLinkId;
      return { orderId: "1001", orderLinkId };
    },
    awaitOrder: async (): Promise<BinanceProviderOrder> => ({
      symbol: "XAUTUSDT",
      orderId: "1001",
      orderLinkId,
      status: "Filled",
      requestedQuantity: 0.01,
      filledQuantity: 0.01,
      averagePrice: 1_000,
      feeUsd: 0,
      updatedAt: Date.now(),
    }),
    findOrderByClientOrderId: async (): Promise<BinanceProviderOrder> => ({
      symbol: "XAUTUSDT",
      orderId: "1001",
      orderLinkId,
      status: "Filled",
      requestedQuantity: 0.01,
      filledQuantity: 0.01,
      averagePrice: 1_000,
      feeUsd: 0,
      updatedAt: Date.now(),
    }),
  } as unknown as BinanceClientAdapter;
  new BinanceAdapter(client);
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(
    client,
    new BinanceRiskGuard(config),
    store,
    config,
  );
  const input = {
    idempotencyKey: "adapter-entry-1",
    category: "spot" as const,
    symbol: "XAUTUSDT" as const,
    side: "Buy" as const,
    quantity: "0.01",
    limitPrice: "1000",
    reduceOnly: false,
  };

  try {
    const first = await manager.place(input);
    const second = await manager.place(input);
    assert.equal(first.orderId, "1001");
    assert.equal(second.orderId, "1001");
    assert.equal(writes, 1);
    assert.match(orderLinkId, /^ptm[0-9a-f]{30}$/u);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only adapter does not change OrderManager risk rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-adapter-risk-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let writes = 0;
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeOrder: async () => {
      writes += 1;
      return { orderId: "1003", orderLinkId: "unexpected" };
    },
  } as unknown as BinanceClientAdapter;
  new BinanceAdapter(client);
  const config = tradingConfigFixture({ killSwitchActive: true });
  const manager = new BinanceOrderManager(
    client,
    new BinanceRiskGuard(config),
    store,
    config,
  );

  try {
    await assert.rejects(() => manager.place({
      idempotencyKey: "adapter-risk-1",
      category: "spot",
      symbol: "XAUTUSDT",
      side: "Buy",
      quantity: "0.01",
      limitPrice: "1000",
      reduceOnly: false,
    }), /kill switch/u);
    assert.equal(writes, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only adapter does not change OrderManager UNKNOWN handling and reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-adapter-unknown-"));
  const store = new BinanceOrderStore(join(root, "orders.sqlite"));
  let status: BinanceProviderOrder["status"] = "Unknown";
  let writes = 0;
  let orderLinkId = "";
  const currentOrder = (): BinanceProviderOrder => ({
    symbol: "XAUTUSDT",
    orderId: "1002",
    orderLinkId,
    status,
    requestedQuantity: 0.01,
    filledQuantity: status === "Filled" ? 0.01 : 0,
    averagePrice: status === "Filled" ? 1_000 : null,
    feeUsd: 0,
    updatedAt: Date.now(),
  });
  const client = {
    readPreflightSnapshot: async () => snapshotFixture(),
    placeOrder: async (request: BinanceExecutionOrderRequest) => {
      writes += 1;
      orderLinkId = request.orderLinkId;
      return { orderId: "1002", orderLinkId };
    },
    awaitOrder: async () => currentOrder(),
    cancelOrder: async () => undefined,
    findOrderByClientOrderId: async () => currentOrder(),
  } as unknown as BinanceClientAdapter;
  new BinanceAdapter(client);
  const config = tradingConfigFixture();
  const manager = new BinanceOrderManager(
    client,
    new BinanceRiskGuard(config),
    store,
    config,
  );

  try {
    await assert.rejects(() => manager.place({
      idempotencyKey: "adapter-unknown-1",
      category: "spot",
      symbol: "XAUTUSDT",
      side: "Buy",
      quantity: "0.01",
      limitPrice: "1000",
      reduceOnly: false,
    }), /non-terminal/u);
    assert.equal(writes, 1);
    assert.equal(store.find("adapter-unknown-1")?.status, "processing");

    status = "Filled";
    const reconciliation = await manager.reconcile();
    assert.equal(reconciliation.reconciled.length, 1);
    assert.equal(store.find("adapter-unknown-1")?.status, "completed");
    assert.equal(writes, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function assertNoMutationSurface(value: object) {
  const forbidden = new Set(["placeOrder", "placeTestOrder", "cancelOrder", "setPerpetualLeverage"]);
  const pending: object[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const [key, exposed] of Object.entries(current)) {
      assert.equal(forbidden.has(key), false, `unexpected public Binance mutation surface: ${key}`);
      if (exposed && typeof exposed === "object") pending.push(exposed);
    }
  }
}
