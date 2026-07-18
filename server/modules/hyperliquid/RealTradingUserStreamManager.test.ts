import assert from "node:assert/strict";
import test from "node:test";
import { RealTradingUserStreamManager, type RealTradingUserStreamEvent } from "./RealTradingUserStreamManager";

const address = "0x1111111111111111111111111111111111111111";

test("user stream start is single-flight and the shared upstream closes only after the last listener releases", async () => {
  const eventsA: RealTradingUserStreamEvent[] = [];
  const eventsB: RealTradingUserStreamEvent[] = [];
  const upstream = createFakeUpstream();
  const manager = new RealTradingUserStreamManager(fakeInfo() as any, fakeOrderState() as any, upstream.factory as any);

  const releaseA = await manager.acquire("USR-1", address, (event) => eventsA.push(event));
  const releaseB = await manager.acquire("USR-1", address, (event) => eventsB.push(event));
  await waitFor(() => upstream.createCount === 1 && upstream.subscribeCount === 4);

  assert.equal(upstream.createCount, 1);
  assert.ok(eventsA.some((event) => event.mode === "snapshot"));
  assert.ok(eventsB.some((event) => event.mode === "snapshot"));

  releaseA();
  await tick();
  assert.equal(upstream.closeCount, 0);
  assert.equal(upstream.unsubscribeCount, 0);

  releaseB();
  await waitFor(() => upstream.closeCount === 1 && upstream.unsubscribeCount === 4);
  await manager.stop();
});

test("clearinghouse events publish normalized account and positions without replayable signing material", async () => {
  const events: RealTradingUserStreamEvent[] = [];
  const upstream = createFakeUpstream();
  const manager = new RealTradingUserStreamManager(fakeInfo() as any, fakeOrderState() as any, upstream.factory as any);
  const release = await manager.acquire("USR-2", address, (event) => events.push(event));
  await waitFor(() => Boolean(upstream.clearinghouseListener));

  upstream.clearinghouseListener?.({
    clearinghouseState: {
      assetPositions: [{ position: { coin: "BTC", szi: "0.01", entryPx: "60000", positionValue: "600" } }],
      crossMaintenanceMarginUsed: "2",
      crossMarginSummary: { accountValue: "1000", totalMarginUsed: "10", totalNtlPos: "600" },
      marginSummary: { accountValue: "1000", totalMarginUsed: "10" },
      withdrawable: "990",
    },
    user: address,
    dex: "",
  });

  const accountEvent = [...events].reverse().find((event: RealTradingUserStreamEvent) => event.channel === "account");
  assert.ok(accountEvent);
  assert.equal((accountEvent.data as any).account.accountValue, 1000);
  assert.equal((accountEvent.data as any).positions[0].coin, "BTC");
  assert.doesNotMatch(JSON.stringify(accountEvent), /signature|private.?key|mnemonic|seed/i);

  release();
  await manager.stop();
});

test("revoking a disabled user closes the active upstream stream", async () => {
  const upstream = createFakeUpstream();
  const manager = new RealTradingUserStreamManager(fakeInfo() as any, fakeOrderState() as any, upstream.factory as any);
  await manager.acquire("USR-disabled", address, () => {});
  await waitFor(() => upstream.subscribeCount === 4);
  await manager.revokeUser("USR-disabled");
  assert.equal(upstream.closeCount, 1);
  assert.equal(upstream.unsubscribeCount, 4);
});

test("duplicate events are ignored and out-of-order provider order events trigger snapshot recovery", async () => {
  const events: RealTradingUserStreamEvent[] = [];
  const upstream = createFakeUpstream();
  const manager = new RealTradingUserStreamManager(fakeInfo() as any, fakeOrderState() as any, upstream.factory as any);
  await manager.acquire("USR-ordering", address, (event) => events.push(event));
  await waitFor(() => Boolean(upstream.orderListener));
  const snapshotsBefore = events.filter((event) => event.channel === "snapshot").length;
  const newest = { order: { coin: "BTC", oid: 7, side: "B", limitPx: "60000", sz: "0.01" }, status: "filled", statusTimestamp: 200 };
  upstream.orderListener?.([newest]);
  upstream.orderListener?.([newest]);
  upstream.orderListener?.([{ ...newest, status: "open", statusTimestamp: 100 }]);
  await waitFor(() => events.filter((event) => event.channel === "snapshot").length > snapshotsBefore);
  assert.equal(events.filter((event) => event.channel === "orders").length, 1);
  await manager.revokeUser("USR-ordering");
});

function fakeInfo() {
  return {
    async getAccountSummary() {
      return { address, accountValue: 1000, status: "connected", timestamp: Date.now(), network: "hyperliquid-testnet" };
    },
    async getPositions() {
      return [];
    },
  };
}

function fakeOrderState() {
  return {
    async read() {
      return {
        mode: "snapshot",
        sequence: 1,
        timestamp: Date.now(),
        status: "connected",
        stale: false,
        reconnecting: false,
        authoritative: true,
        openOrders: [],
        orders: [],
        fills: [],
        warnings: [],
      };
    },
  };
}

function createFakeUpstream() {
  const state = {
    clearinghouseListener: null as ((event: any) => void) | null,
    orderListener: null as ((event: any[]) => void) | null,
    closeCount: 0,
    createCount: 0,
    subscribeCount: 0,
    unsubscribeCount: 0,
    factory() {
      state.createCount += 1;
      const subscription = () => {
        state.subscribeCount += 1;
        return Promise.resolve({
          unsubscribe: async () => {
            state.unsubscribeCount += 1;
          },
        });
      };
      return {
        transport: {
          socket: { addEventListener() {} },
          async ready() {},
          close() { state.closeCount += 1; },
        },
        client: {
          clearinghouseState: async (_params: unknown, listener: (event: any) => void) => {
            state.clearinghouseListener = listener;
            return subscription();
          },
          openOrders: subscription,
          orderUpdates: async (_params: unknown, listener: (event: any[]) => void) => {
            state.orderListener = listener;
            return subscription();
          },
          userFills: subscription,
        },
      };
    },
  };
  return state;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for user stream state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
