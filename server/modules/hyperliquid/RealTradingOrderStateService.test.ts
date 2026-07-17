import assert from "node:assert/strict";
import test from "node:test";
import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import { RealTradingOrderStateService } from "./RealTradingOrderStateService";

const address = "0x1111111111111111111111111111111111111111";

test("order state starts with a snapshot and emits only authoritative incremental changes", async () => {
  const source = new MutableInfo();
  source.openOrders = [openOrder(1)];
  const service = new RealTradingOrderStateService(source as unknown as HyperliquidInfoClient);
  const first = await service.read(address);
  assert.equal(first.mode, "snapshot");
  assert.equal(first.sequence, 1);
  assert.equal(first.authoritative, true);

  source.openOrders = [];
  source.orders = [{ ...openOrder(1), status: "filled", statusTimestamp: 2 }];
  source.fills = [{ hash: "0xfill", coin: "BTC", side: "buy", timestamp: 2, price: 10, size: 1 }];
  const second = await service.read(address, first.sequence);
  assert.equal(second.mode, "incremental");
  if (second.mode !== "incremental") return;
  assert.deepEqual(second.openOrders.removedOrderIds, ["1"]);
  assert.equal(second.terminalOrders.length, 1);
  assert.equal(second.fills.length, 1);
});

test("order state marks cached data stale and requires a recovery snapshot after disconnect", async () => {
  const source = new MutableInfo();
  const service = new RealTradingOrderStateService(source as unknown as HyperliquidInfoClient);
  const first = await service.read(address);
  source.fail = true;
  const stale = await service.read(address, first.sequence);
  assert.equal(stale.mode, "snapshot");
  assert.equal(stale.stale, true);
  assert.equal(stale.reconnecting, true);
  assert.equal(stale.status, "reconnecting");

  source.fail = false;
  const recovered = await service.read(address, stale.sequence);
  assert.equal(recovered.mode, "snapshot");
  assert.equal(recovered.status, "connected");
  assert.equal(recovered.stale, false);
});

test("an initial provider outage returns an empty reconnecting snapshot, never inferred state", async () => {
  const source = new MutableInfo();
  source.fail = true;
  const state = await new RealTradingOrderStateService(source as unknown as HyperliquidInfoClient).read(address);
  assert.equal(state.mode, "snapshot");
  assert.equal(state.sequence, 0);
  assert.equal(state.stale, true);
  assert.deepEqual(state.openOrders, []);
  assert.deepEqual(state.orders, []);
  assert.deepEqual(state.fills, []);
});

class MutableInfo {
  fail = false;
  openOrders: any[] = [];
  orders: any[] = [];
  fills: any[] = [];

  async getOpenOrders() {
    if (this.fail) throw new Error("offline");
    return this.openOrders;
  }

  async getOrderHistory() {
    if (this.fail) throw new Error("offline");
    return { orders: this.orders, fills: this.fills, nextCursor: null, warnings: [] };
  }
}

function openOrder(oid: number) {
  return {
    oid,
    cloid: null,
    coin: "BTC",
    symbol: "BTCUSDT",
    side: "buy" as const,
    price: 10,
    size: 1,
    timestamp: 1,
    status: "open",
    limitPx: 10,
    sz: 1,
    reduceOnly: false,
    isPositionTpsl: false,
    isTrigger: false,
    orderType: "Limit",
    origSz: 1,
    triggerCondition: null,
    triggerPx: null,
    network: "hyperliquid-testnet" as const,
  };
}
