import assert from "node:assert/strict";
import test from "node:test";
import { HyperliquidExchangeProxy, RealTradingExchangeSubmissionError } from "./HyperliquidExchangeProxy";
import type { RealTradingAuditRecord } from "./realTradingAuditTypes";
import type { RealTradingSignatureVerifier } from "./HyperliquidSignatureVerifier";

const context = { requestId: "req-1", userId: "USR-test", submittedAt: 100 };

test("exchange receipt appends trace fields and audit excludes replayable material", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let forwardedBody = "";
  globalThis.fetch = async (_input, init) => {
    forwardedBody = String(init?.body);
    return new Response(JSON.stringify({
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] }, privateKey: "SENTINEL", message: "mnemonic=SENTINEL" },
      signature: "SENTINEL",
      rawPayload: "SENTINEL",
    }), { status: 200 });
  };
  const audit = new AuditSpy();
  const receipt = await new HyperliquidExchangeProxy("https://example.test", undefined, audit).forward(validPayload(), context);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.requestId, "req-1");
  assert.equal(receipt.actionType, "cancel");
  assert.equal(receipt.submittedAt, 100);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.rejected, false);
  assert.doesNotMatch(JSON.stringify(receipt), /SENTINEL|privateKey|signature|mnemonic|rawPayload/i);
  assert.match(forwardedBody, /signature/);
  const persisted = JSON.stringify(audit.records[0]);
  assert.doesNotMatch(persisted, /signature|nonce|private|mnemonic|payload/i);
});

test("provider rejection remains traceable and is never reported as accepted", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok",
    response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } },
  }), { status: 200 });
  const receipt = await new HyperliquidExchangeProxy("https://example.test").forward(validPayload(), context);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.rejected, true);
  assert.equal(receipt.message, "Hyperliquid Testnet 拒绝了交易请求。");
  assert.equal(receipt.requestId, "req-1");
});

test("batch response preserves per-order partial status", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok",
    response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }, { error: "bad order" }] } },
  }), { status: 200 });
  const store = new IdempotencySpy();
  const receipt = await new HyperliquidExchangeProxy("https://example.test", undefined, store).forward(orderPayload([
    "0x11111111111111111111111111111111",
    "0x22222222222222222222222222222222",
  ]), context);
  assert.equal(receipt.outcome, "partial");
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.rejected, true);
  assert.equal(receipt.needsReconciliation, true);
  assert.deepEqual(receipt.orderStatuses?.map((item) => item.status), ["accepted", "rejected"]);
});

test("same cloid is atomically deduplicated and never forwarded twice", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 9 } }] } } }), { status: 200 });
  };
  const store = new IdempotencySpy();
  const proxy = new HyperliquidExchangeProxy("https://example.test", undefined, store);
  const payload = orderPayload(["0x11111111111111111111111111111111"]);
  const first = await proxy.forward(payload, context);
  const duplicate = await proxy.forward(payload, { ...context, requestId: "req-2" });
  assert.equal(fetchCount, 1);
  assert.equal(duplicate.requestId, first.requestId);
  assert.equal(duplicate.outcome, "accepted");
});

test("ambiguous transport failure is pending reconciliation, redacted, and not blindly retried", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("privateKey=SENTINEL signature=SENTINEL mnemonic=SENTINEL raw payload=SENTINEL");
  };
  const store = new IdempotencySpy();
  const proxy = new HyperliquidExchangeProxy("https://example.test", undefined, store);
  const payload = orderPayload(["0x11111111111111111111111111111111"]);
  await assert.rejects(() => proxy.forward(payload, context), (error: unknown) => {
    assert.ok(error instanceof RealTradingExchangeSubmissionError);
    assert.equal(error.receipt.outcome, "pending_reconciliation");
    assert.equal(error.receipt.accepted, false);
    assert.equal(error.receipt.rejected, false);
    assert.doesNotMatch(JSON.stringify(error.receipt), /SENTINEL|privateKey|signature|mnemonic|raw payload/i);
    return true;
  });
  await assert.rejects(() => proxy.forward(payload, { ...context, requestId: "req-2" }), (error: unknown) => {
    assert.ok(error instanceof RealTradingExchangeSubmissionError);
    assert.equal(error.httpStatus, 409);
    return true;
  });
  assert.equal(fetchCount, 1);
  assert.doesNotMatch(JSON.stringify(store.records), /SENTINEL|privateKey|signature|mnemonic|raw payload/i);
});

test("local validation errors carry the same trace receipt and are audited", async () => {
  const audit = new AuditSpy();
  const proxy = new HyperliquidExchangeProxy("https://example.test", undefined, audit);
  await assert.rejects(
    () => proxy.forward({ ...validPayload(), network: "mainnet", signature: { secret: "never-store" } }, context),
    (error: unknown) => {
      assert.ok(error instanceof RealTradingExchangeSubmissionError);
      assert.equal(error.httpStatus, 400);
      assert.equal(error.receipt.requestId, "req-1");
      assert.equal(error.receipt.rejected, true);
      return true;
    },
  );
  assert.equal(audit.records[0]?.outcome, "rejected");
  assert.doesNotMatch(JSON.stringify(audit.records[0]), /never-store/);
});

test("accepted approveAgent binds the verified API wallet to the authenticated user", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 });
  const store = new BindingAuditSpy();
  const verifier: RealTradingSignatureVerifier = {
    verify: () => ({
      kind: "master",
      masterAddress: "0x1111111111111111111111111111111111111111",
      signerAddress: "0x1111111111111111111111111111111111111111",
      agentAddress: "0x2222222222222222222222222222222222222222",
    }),
  };
  const proxy = new HyperliquidExchangeProxy("https://example.test", undefined, store, verifier);
  const payload = {
    ...validPayload(),
    action: {
      type: "approveAgent",
      hyperliquidChain: "Testnet",
      signatureChainId: "0x66eee",
      agentAddress: "0x2222222222222222222222222222222222222222",
      nonce: 1,
    },
  };

  await proxy.forward(payload, context);
  assert.equal(store.binding?.userId, context.userId);
  assert.equal(store.binding?.agentAddress, "0x2222222222222222222222222222222222222222");
});

test("vaultAddress is rejected locally and an ambiguous transport timeout is 504", async (t) => {
  const proxy = new HyperliquidExchangeProxy("https://example.test");
  await assert.rejects(
    () => proxy.forward({ ...validPayload(), vaultAddress: "0x2222222222222222222222222222222222222222" }, context),
    (error: unknown) => error instanceof RealTradingExchangeSubmissionError
      && error.httpStatus === 403
      && error.receipt.errorCode === "RT_ACTION_NOT_ALLOWED",
  );
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
  await assert.rejects(
    () => new HyperliquidExchangeProxy("https://example.test").forward(validPayload(), context),
    (error: unknown) => error instanceof RealTradingExchangeSubmissionError
      && error.httpStatus === 504
      && error.receipt.errorCode === "RT_UPSTREAM_TIMEOUT"
      && error.receipt.reconcileRequired === true,
  );
});

test("malformed HTTP 200 approveAgent response never creates a binding", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  const store = new BindingAuditSpy();
  const verifier: RealTradingSignatureVerifier = { verify: () => ({
    kind: "master",
    masterAddress: "0x1111111111111111111111111111111111111111",
    signerAddress: "0x1111111111111111111111111111111111111111",
    agentAddress: "0x2222222222222222222222222222222222222222",
  }) };
  const receipt = await new HyperliquidExchangeProxy("https://example.test", undefined, store, verifier).forward({
    ...validPayload(),
    action: { type: "approveAgent", hyperliquidChain: "Testnet", agentAddress: "0x2222222222222222222222222222222222222222" },
  }, context);
  assert.equal(receipt.ok, false);
  assert.equal(store.binding, undefined);
});

test("cancel item error is rejected instead of reported as accepted", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok",
    response: { type: "cancel", data: { statuses: [{ error: "order not found" }] } },
  }), { status: 200 });
  const receipt = await new HyperliquidExchangeProxy("https://example.test").forward({
    ...validPayload(),
    action: { type: "cancel", cancels: [{ a: 0, o: 42 }] },
  }, context);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.orderStatuses?.[0]?.status, "rejected");
});

test("cancel success requires a matching per-item provider status", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "ok",
    response: { type: "cancel", data: { statuses: ["success"] } },
  }), { status: 200 });
  const receipt = await new HyperliquidExchangeProxy("https://example.test").forward({
    ...validPayload(),
    action: { type: "cancel", cancels: [{ a: 0, o: 42 }] },
  }, context);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, "accepted");
});

class AuditSpy {
  records: RealTradingAuditRecord[] = [];
  saveRealTradingAudit(record: RealTradingAuditRecord) {
    this.records.push(record);
  }
}

class IdempotencySpy extends AuditSpy {
  private readonly rows = new Map<string, { requestId: string; state: any; submittedAt: number; receiptJson: string | null }>();
  reserveRealTradingOrderRequest(input: any) {
    const existing = this.rows.get(input.clientOrderIds[0]);
    if (existing) return { kind: "existing" as const, ...existing };
    input.clientOrderIds.forEach((cloid: string) => this.rows.set(cloid, {
      requestId: input.requestId,
      state: "processing",
      submittedAt: input.submittedAt,
      receiptJson: null,
    }));
    return { kind: "reserved" as const };
  }
  completeRealTradingOrderRequest(requestId: string, state: any, receiptJson: string) {
    for (const [cloid, row] of this.rows) {
      if (row.requestId === requestId) this.rows.set(cloid, { ...row, state, receiptJson });
    }
  }
}

class BindingAuditSpy extends AuditSpy {
  binding?: {
    userId: string;
    masterAddress: string;
    agentAddress: string;
    approvedAt: number;
    updatedAt: number;
  };
  findRealTradingAgentBinding() {
    return this.binding;
  }
  upsertRealTradingAgentBinding(binding: NonNullable<BindingAuditSpy["binding"]>) {
    this.binding = binding;
  }
}

function validPayload() {
  return {
    masterAddress: "0x1111111111111111111111111111111111111111",
    network: "hyperliquid-testnet",
    action: { type: "cancel", cancels: [{ a: 0, o: 1 }] },
    nonce: 1,
    signature: { r: "0x1", s: "0x2", v: 27 },
    vaultAddress: null,
  };
}

function orderPayload(clientOrderIds: string[]) {
  return {
    ...validPayload(),
    action: {
      type: "order",
      grouping: "na",
      orders: clientOrderIds.map((c) => ({ a: 0, b: true, p: "10", s: "1", r: false, c, t: { limit: { tif: "Gtc" } } })),
    },
  };
}
