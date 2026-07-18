import assert from "node:assert/strict";
import test from "node:test";
import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import { RealTradingRiskGuard } from "./RealTradingRiskGuard";
import type { RealTradingExchangeRequest } from "./hyperliquidTypes";

const limits = {
  maxSnapshotAgeMs: 10_000,
};

test("risk guard no longer enforces a platform leverage ceiling or reads account state for updateLeverage", async () => {
  let reads = 0;
  const info = {
    async getAccountSummary() { reads += 1; throw new Error("account summary unavailable"); },
    async getPositions() { reads += 1; throw new Error("positions unavailable"); },
    async getOpenOrders() { reads += 1; throw new Error("open orders unavailable"); },
    async getSymbols() { reads += 1; throw new Error("symbols unavailable"); },
  } as unknown as HyperliquidInfoClient;
  const guard = new RealTradingRiskGuard(info, limits);

  await guard.assertAllowed(request({ type: "updateLeverage", asset: 0, isCross: true, leverage: 1 }));
  await guard.assertAllowed(request({ type: "updateLeverage", asset: 0, isCross: false, leverage: 100 }));
  assert.equal(reads, 0);
});

test("risk guard no longer blocks large opening notional, aggregate exposure, existing high leverage, or more than 20 open orders", async () => {
  const reads: string[] = [];
  const guard = new RealTradingRiskGuard(stubInfo({
    accountValue: 0,
    positionNotional: 10_000_000,
    positionLeverage: 100,
    openOrders: 99,
  }, reads), limits);

  await guard.assertAllowed(orderRequest([{ p: "1000000000", s: "1000", r: false }]));
  assert.deepEqual(reads, ["getSymbols", "getAccountSummary", "getSummary:BTCUSDT"]);
});

test("risk guard fails closed for opening risk when account or market snapshots are stale", async () => {
  const staleAccount = new RealTradingRiskGuard(stubInfo({ staleAccount: true }), limits);
  await assert.rejects(() => staleAccount.assertAllowed(orderRequest([{ p: "1", s: "1", r: false }])), /快照已过期/);
  const staleMarket = new RealTradingRiskGuard(stubInfo({ staleMarket: true }), limits);
  await assert.rejects(() => staleMarket.assertAllowed(orderRequest([{ p: "1", s: "1", r: false }])), /行情已过期/);
});

test("risk guard validates opening order shape but delegates notional and leverage limits to Hyperliquid", async () => {
  const guard = new RealTradingRiskGuard(stubInfo(), limits);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "0", s: "1", r: false }])), /价格和数量/);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "1", s: "-1", r: false }])), /价格和数量/);
});

test("risk guard allows cancel without account reads and preserves reduce-only anti-reversal checks", async () => {
  const cancelReads: string[] = [];
  const cancelGuard = new RealTradingRiskGuard(stubInfo({}, cancelReads), limits);
  await cancelGuard.assertAllowed(request({ type: "cancel", cancels: [{ a: 0, o: 1 }] }));
  assert.deepEqual(cancelReads, []);

  const reads: string[] = [];
  const guard = new RealTradingRiskGuard(stubInfo({ positionNotional: 10 }, reads), limits);
  await guard.assertAllowed(orderRequest([{ p: "1", s: "1", r: true, b: false }]));
  assert.deepEqual(reads, ["getSymbols", "getPositions"]);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "1", s: "1", r: true, b: true }])), /方向/);
  await assert.rejects(() => guard.assertAllowed(orderRequest([{ p: "1", s: "11", r: true, b: false }])), /超过可平持仓/);
});

test("risk guard health marks removed platform limits as provider-enforced instead of exposing stale defaults", () => {
  const health = new RealTradingRiskGuard({} as HyperliquidInfoClient, limits).getHealth();
  assert.deepEqual(health.limits, { maxSnapshotAgeMs: 10_000 });
  assert.equal(health.removedPlatformLimits.maxLeverage, "provider_enforced");
  assert.equal(health.removedPlatformLimits.maxOrderNotionalEquityRatio, "provider_enforced");
  assert.equal(health.removedPlatformLimits.maxTotalNotionalEquityRatio, "provider_enforced");
  assert.equal(health.removedPlatformLimits.maxOpenOrders, "provider_enforced");
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
    accountValue?: number | null;
    positionNotional?: number;
    openOrders?: number;
    openOrderNotional?: number;
    positionLeverage?: number;
    staleAccount?: boolean;
    staleMarket?: boolean;
  } = {},
  reads: string[] = [],
) {
  return {
    async getAccountSummary() {
      reads.push("getAccountSummary");
      return {
        accountValue: values.accountValue ?? 100,
        status: values.staleAccount ? "stale" : "connected",
        timestamp: values.staleAccount ? Date.now() - 20_000 : Date.now(),
      };
    },
    async getPositions() {
      reads.push("getPositions");
      return values.positionNotional ? [{
        symbol: "BTCUSDT",
        side: "long",
        size: values.positionNotional,
        positionValue: values.positionNotional,
        leverage: values.positionLeverage ?? 10,
      }] : [];
    },
    async getOpenOrders() {
      reads.push("getOpenOrders");
      return Array.from({ length: values.openOrders ?? 0 }, (_, oid) => ({
        oid,
        reduceOnly: false,
        price: values.openOrderNotional ? values.openOrderNotional / (values.openOrders ?? 1) : 0.1,
        size: 1,
      }));
    },
    async getSymbols() {
      reads.push("getSymbols");
      return [{ assetId: 0, symbol: "BTCUSDT", status: "active" }];
    },
    async getSummary(symbol: string) {
      reads.push(`getSummary:${symbol}`);
      return { status: values.staleMarket ? "stale" : "connected", timestamp: values.staleMarket ? Date.now() - 20_000 : Date.now() };
    },
  } as unknown as HyperliquidInfoClient;
}
