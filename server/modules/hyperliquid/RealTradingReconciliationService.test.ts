import assert from "node:assert/strict";
import test from "node:test";
import { RealTradingReconciliationService, sanitizeReconciliationError, type RealTradingPendingReconciliation } from "./RealTradingReconciliationService";
import type { RealTradingHistoricalOrder } from "./hyperliquidTypes";

const address = "0x1111111111111111111111111111111111111111";
const cloidA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const cloidB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("reconciliation recovers a fully resolved pending order request without replaying the exchange payload", async () => {
  const store = new StoreStub([
    row("req-1", cloidA),
    row("req-1", cloidB),
  ]);
  const info = {
    async getOrderStatus(_address: string, cloid: string) {
      return {
        authoritative: true as const,
        cloid,
        network: "hyperliquid-testnet" as const,
        order: order(cloid),
        status: "order" as const,
        timestamp: Date.now(),
      };
    },
  };
  const service = new RealTradingReconciliationService(info as any, store, { autoStart: false });
  const result = await service.runOnce();

  assert.equal(result.recoveredRequests, 1);
  assert.deepEqual(store.completed, [{ requestId: "req-1", state: "accepted" }]);
  assert.equal(store.auditUpdates[0]?.providerStatus, "reconciled_order_status");
  assert.doesNotMatch(store.receipts[0] ?? "", /signature|private.?key|mnemonic|raw.?payload/i);
});

test("reconciliation leaves unknown cloids pending and records a bounded attempt", async () => {
  const store = new StoreStub([row("req-2", cloidA)]);
  const info = {
    async getOrderStatus(_address: string, cloid: string) {
      return {
        authoritative: true as const,
        cloid,
        network: "hyperliquid-testnet" as const,
        order: null,
        status: "unknown" as const,
        timestamp: Date.now(),
      };
    },
  };
  const service = new RealTradingReconciliationService(info as any, store, { autoStart: false });
  const result = await service.runOnce();
  const health = service.getHealth();

  assert.equal(result.recoveredRequests, 0);
  assert.equal(store.completed.length, 0);
  assert.equal(store.attempts[0]?.error, null);
  assert.ok(health.lastSuccessAt);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.lastError, null);
});

test("reconciliation is single-flight and sanitizes provider errors", async () => {
  const store = new StoreStub([row("req-3", cloidA)]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const info = {
    async getOrderStatus() {
      await gate;
      throw new Error("ECONNRESET /tmp/a file:///tmp/source.json https://example.test?token=secret 0x1111111111111111111111111111111111111111");
    },
  };
  const service = new RealTradingReconciliationService(info as any, store, { autoStart: false });
  const first = service.runOnce();
  const second = await service.runOnce();
  release();
  await first;

  assert.equal(second.skipped, true);
  assert.equal(store.completed.length, 0);
  assert.equal(store.attempts[0]?.error?.includes("/tmp/a"), false);
  assert.equal(store.attempts[0]?.error?.includes("file:///tmp/source.json"), false);
  assert.equal(store.attempts[0]?.error?.includes("0x1111111111111111111111111111111111111111"), false);
  assert.match(store.attempts[0]?.error ?? "", /ECONNRESET/);
});

test("reconciliation reports degraded health when every provider query throws", async () => {
  const store = new StoreStub([row("req-4", cloidA)]);
  const info = {
    async getOrderStatus() {
      throw new Error("ECONNRESET /tmp/a file:///tmp/source.json https://example.test?token=secret 0x1111111111111111111111111111111111111111");
    },
  };
  const service = new RealTradingReconciliationService(info as any, store, { autoStart: false });
  const result = await service.runOnce();
  const health = service.getHealth();

  assert.equal(result.recoveredRequests, 0);
  assert.equal((result as any).failedRequests, 1);
  assert.equal(health.lastSuccessAt, null);
  assert.equal(health.consecutiveFailures, 1);
  assert.match(health.lastError ?? "", /ECONNRESET/);
  assert.equal(store.completed.length, 0);
  assert.equal(store.attempts[0]?.error, health.lastError);
  assert.doesNotMatch(health.lastError ?? "", /\/tmp\/a|file:\/\/\/tmp\/source\.json|token=secret|0x1111111111111111111111111111111111111111/);
});

test("reconciliation keeps partial recoveries while preserving provider failure health", async () => {
  const store = new StoreStub([
    row("req-ok", cloidA),
    row("req-fail", cloidB),
  ]);
  const info = {
    async getOrderStatus(_address: string, cloid: string) {
      if (cloid === cloidA) {
        return {
          authoritative: true as const,
          cloid,
          network: "hyperliquid-testnet" as const,
          order: order(cloid),
          status: "order" as const,
          timestamp: Date.now(),
        };
      }
      throw new Error("timeout ./a /dev/null nonce=123 signature=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    },
  };
  const service = new RealTradingReconciliationService(info as any, store, { autoStart: false });
  const result = await service.runOnce();
  const health = service.getHealth();

  assert.equal(result.recoveredRequests, 1);
  assert.equal((result as any).failedRequests, 1);
  assert.deepEqual(store.completed, [{ requestId: "req-ok", state: "accepted" }]);
  assert.ok(health.lastCompletedAt);
  assert.equal(health.lastRecoveredRequests, 1);
  assert.equal(health.lastSuccessAt, null);
  assert.equal(health.consecutiveFailures, 1);
  assert.match(health.lastError ?? "", /timeout/);
  assert.doesNotMatch(health.lastError ?? "", /\.\/a|\/dev\/null|nonce=123|0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test("standalone reconciliation sanitizer masks short paths and addresses", () => {
  const value = sanitizeReconciliationError(new Error("rename ./a /dev/null file:///tmp/a 0x1111111111111111111111111111111111111111"));
  assert.doesNotMatch(value, /\/dev\/null|\.\/a|file:\/\/\/tmp\/a|0x1111111111111111111111111111111111111111/);
  assert.match(value, /\[path\]/);
  assert.match(value, /\[address\]/);
});

function row(requestId: string, cloid: string): RealTradingPendingReconciliation {
  return {
    userId: "USR-1",
    masterAddress: address,
    network: "hyperliquid-testnet",
    cloid,
    requestId,
    actionType: "order",
    state: "pending_reconciliation",
    submittedAt: 1_700_000_000_000,
  };
}

function order(cloid: string): RealTradingHistoricalOrder {
  return {
    coin: "BTC",
    symbol: "BTCUSDT",
    side: "buy",
    price: 60_000,
    size: 0.01,
    timestamp: 1_700_000_000_000,
    oid: 123,
    cloid,
    status: "open",
    statusTimestamp: 1_700_000_000_100,
    limitPx: 60_000,
    sz: 0.01,
    reduceOnly: false,
    triggerPx: null,
    triggerCondition: null,
    orderType: null,
    isTrigger: false,
    isPositionTpsl: false,
    origSz: null,
    network: "hyperliquid-testnet",
  };
}

class StoreStub {
  completed: Array<{ requestId: string; state: string }> = [];
  receipts: string[] = [];
  auditUpdates: Array<{ requestId: string; providerStatus: string | null }> = [];
  attempts: Array<{ requestId: string; error: string | null }> = [];

  constructor(private pending: RealTradingPendingReconciliation[]) {}

  listPendingRealTradingReconciliations() {
    return this.pending;
  }

  recordRealTradingReconciliationAttempt(requestId: string, _attemptedAt: number, error: string | null) {
    this.attempts.push({ requestId, error });
  }

  completeRealTradingOrderRequest(requestId: string, state: any, receiptJson: string) {
    this.completed.push({ requestId, state });
    this.receipts.push(receiptJson);
  }

  updateRealTradingAuditReconciliation(requestId: string, _outcome: any, input: { providerStatus: string | null }) {
    this.auditUpdates.push({ requestId, providerStatus: input.providerStatus });
  }
}
