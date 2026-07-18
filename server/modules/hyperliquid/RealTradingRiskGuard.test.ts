import assert from "node:assert/strict";
import test from "node:test";
import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import { RealTradingRiskGuard } from "./RealTradingRiskGuard";
import type { RealTradingExchangeRequest } from "./hyperliquidTypes";

const limits = {
  maxLeverage: 20,
  maxOrderNotionalEquityRatio: 0.5,
  maxTotalNotionalEquityRatio: 2,
  maxOpenOrders: 20,
  maxSnapshotAgeMs: 10_000,
};

test("risk guard enforces the default leverage ceiling", async () => {
  const guard = new RealTradingRiskGuard({} as HyperliquidInfoClient, limits);
  await assert.rejects(() => guard.assertAllowed(request({ type: "updateLeverage", asset: 0, isCross: true, leverage: 21 })), /20x/);
  await guard.assertAllowed(request({ type: "updateLeverage", asset: 0, isCross: true, leverage: 20 }));
});

test("risk guard rejects oversized opening orders and aggregate exposure", async () => {
  const info = stubInfo({ equity: 100, positionNotional: 160, openOrders: 0 });
  const guard = new RealTradingRiskGuard(info, limits);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "51", s: "1", r: false }])), /50%/);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "41", s: "1", r: false }])), /200%/);
});

test("risk guard limits opening-order count but allows only a valid reduce-only close", async () => {
  let reads = 0;
  const info = stubInfo({ equity: 100, positionNotional: 10, openOrders: 20 }, () => { reads += 1; });
  const guard = new RealTradingRiskGuard(info, limits);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "1", s: "1", r: false }])), /20/);
  await guard.assertAllowed(orderRequest([{ p: "1", s: "1", r: true, b: false }]));
  assert.ok(reads > 0, "reduce-only is checked against authoritative positions");
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "1", s: "1", r: true, b: true }])), /方向/);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "1", s: "11", r: true, b: false }])), /超过可平持仓/);
});

test("risk guard atomically counts same-account in-flight exposure", async () => {
  const guard = new RealTradingRiskGuard(stubInfo({ equity: 100, positionNotional: 130, openOrders: 0 }), limits);
  const release = await guard.reserveAllowed(orderRequest([{ p: "40", s: "1", r: false }]));
  await assert.rejects(
    () => guard.reserveAllowed(orderRequest([{ p: "40", s: "1", r: false }])),
    /200%/,
  );
  release();
  const releaseAfter = await guard.reserveAllowed(orderRequest([{ p: "40", s: "1", r: false }]));
  releaseAfter();
});

test("risk guard includes existing opening orders and rejects excessive existing leverage", async () => {
  const withOrders = new RealTradingRiskGuard(stubInfo({
    equity: 100,
    positionNotional: 140,
    openOrders: 1,
    openOrderNotional: 20,
  }), limits);
  await assert.rejects(() => withOrders.assertAllowed(orderRequest([{ p: "41", s: "1", r: false }])), /200%/);

  const highLeverage = new RealTradingRiskGuard(stubInfo({
    equity: 100,
    positionNotional: 1,
    positionLeverage: 21,
    openOrders: 0,
  }), limits);
  await assert.rejects(() => highLeverage.assertAllowed(orderRequest([{ p: "1", s: "1", r: false }])), /20x/);
});

test("risk guard fails closed on stale account or market snapshots", async () => {
  const staleAccount = new RealTradingRiskGuard(stubInfo({ equity: 100, positionNotional: 0, openOrders: 0, staleAccount: true }), limits);
  await assert.rejects(() => staleAccount.assertAllowed(orderRequest([{ p: "1", s: "1", r: false }])), /快照已过期/);
  const staleMarket = new RealTradingRiskGuard(stubInfo({ equity: 100, positionNotional: 0, openOrders: 0, staleMarket: true }), limits);
  await assert.rejects(() => staleMarket.assertAllowed(orderRequest([{ p: "1", s: "1", r: false }])), /行情已过期/);
});

function request(action: Record<string, unknown>): RealTradingExchangeRequest {
  return {
    masterAddress: "0x1111111111111111111111111111111111111111",
    network: "hyperliquid-testnet",
    action,
    nonce: 1,
    signature: {},
  };
}

function orderRequest(orders: Array<Record<string, unknown>>) {
  return request({ type: "order", orders: orders.map((order) => ({ a: 0, ...order })), grouping: "na" });
}

function stubInfo(
  values: {
    equity: number;
    positionNotional: number;
    openOrders: number;
    openOrderNotional?: number;
    positionLeverage?: number;
    staleAccount?: boolean;
    staleMarket?: boolean;
  },
  onRead = () => {},
) {
  return {
    async getAccountSummary() {
      onRead();
      return {
        accountValue: values.equity,
        status: values.staleAccount ? "stale" : "connected",
        timestamp: values.staleAccount ? Date.now() - 20_000 : Date.now(),
      };
    },
    async getPositions() {
      onRead();
      return values.positionNotional ? [{
        symbol: "BTCUSDT",
        side: "long",
        size: values.positionNotional,
        positionValue: values.positionNotional,
        leverage: values.positionLeverage ?? 10,
      }] : [];
    },
    async getOpenOrders() {
      onRead();
      return Array.from({ length: values.openOrders }, (_, oid) => ({
        oid,
        reduceOnly: false,
        price: values.openOrderNotional ? values.openOrderNotional / values.openOrders : 0.1,
        size: 1,
      }));
    },
    async getSymbols() {
      onRead();
      return [{ assetId: 0, symbol: "BTCUSDT", status: "active" }];
    },
    async getSummary() {
      onRead();
      return { status: values.staleMarket ? "stale" : "connected", timestamp: values.staleMarket ? Date.now() - 20_000 : Date.now() };
    },
  } as unknown as HyperliquidInfoClient;
}
