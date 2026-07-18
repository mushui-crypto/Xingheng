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

test("approveAgent rejects a missing Hyperliquid Testnet master account before forwarding", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 });
  };
  const audit = new AuditSpy();
  const verifier: RealTradingSignatureVerifier = {
    verify: () => ({
      kind: "master",
      masterAddress: "0x1111111111111111111111111111111111111111",
      signerAddress: "0x1111111111111111111111111111111111111111",
      agentAddress: "0x2222222222222222222222222222222222222222",
    }),
  };
  const roles = { getUserRole: async () => "missing" };
  const proxy = new HyperliquidExchangeProxy("https://example.test", undefined, audit, verifier, roles);

  await assert.rejects(
    () => proxy.forward(approveAgentPayload(), context),
    (error: unknown) => {
      assert.ok(error instanceof RealTradingExchangeSubmissionError);
      assert.equal(error.httpStatus, 409);
      assert.equal(error.receipt.errorCode, "RT_ACCOUNT_NOT_ACTIVATED");
      assert.equal(error.receipt.message, "该钱包尚未激活 Hyperliquid Testnet 交易账户，请先完成 Testnet 账户激活后再授权 Agent。");
      assert.equal(error.receipt.outcome, "rejected");
      return true;
    },
  );
  assert.equal(fetchCount, 0);
  assert.equal(audit.records[0]?.errorCategory, "account_not_activated");
  assert.equal(audit.records[0]?.message, "Hyperliquid Testnet 账户未激活。");
  assert.doesNotMatch(JSON.stringify(audit.records[0]), /signature|privateKey|mnemonic|rawPayload/i);
});

test("approveAgent forwards normally when Hyperliquid Testnet userRole is active", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 });
  };
  const store = new BindingAuditSpy();
  const verifier: RealTradingSignatureVerifier = {
    verify: () => ({
      kind: "master",
      masterAddress: "0x1111111111111111111111111111111111111111",
      signerAddress: "0x1111111111111111111111111111111111111111",
      agentAddress: "0x2222222222222222222222222222222222222222",
    }),
  };
  const roles = { getUserRole: async () => "user" };
  const receipt = await new HyperliquidExchangeProxy("https://example.test", undefined, store, verifier, roles)
    .forward(approveAgentPayload(), context);

  assert.equal(fetchCount, 1);
  assert.equal(receipt.outcome, "accepted");
  assert.equal(store.binding?.agentAddress, "0x2222222222222222222222222222222222222222");
});

test("approveAgent userRole network failure does not masquerade as a missing account", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ status: "err", response: { type: "error" } }), { status: 400 });
  };
  const verifier: RealTradingSignatureVerifier = {
    verify: () => ({
      kind: "master",
      masterAddress: "0x1111111111111111111111111111111111111111",
      signerAddress: "0x1111111111111111111111111111111111111111",
      agentAddress: "0x2222222222222222222222222222222222222222",
    }),
  };
  const roles = { getUserRole: async () => { throw new Error("ECONNRESET https://example.test/info privateKey=abc /tmp/userRole.json"); } };
  const receipt = await new HyperliquidExchangeProxy("https://example.test", undefined, undefined, verifier, roles)
    .forward(approveAgentPayload(), context);

  assert.equal(fetchCount, 1);
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.errorCode, "RT_PROVIDER_REJECTED");
  assert.equal(receipt.message, "Hyperliquid Testnet 拒绝了交易请求。");
  const warningText = JSON.stringify(warnings);
  assert.doesNotMatch(warningText, /privateKey|abc|\/tmp\/userRole\.json|https:\/\/example\.test/);
  assert.match(warningText, /upstream_check_unavailable/);
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

test("local signature validation errors return actionable safe messages without sensitive-field false positives", async () => {
  const cases = [
    {
      error: "approveAgent 仅允许 Hyperliquid Testnet signatureChainId。",
      expected: "请切换钱包网络到 Arbitrum Sepolia 后重新授权。",
      httpStatus: 403,
    },
    {
      error: "approveAgent 签名账户与 masterAddress 不一致。",
      expected: "签名钱包与声明的主账户不一致，请切换到对应主钱包后重试。",
    },
    {
      error: "当前用户尚未授权此 Hyperliquid API wallet。",
      expected: "当前账户尚未完成 Hyperliquid API wallet 授权，请先完成 Agent 授权。",
    },
    {
      error: "exchange 签名不是当前用户已授权的 API wallet。",
      expected: "签名使用的 API wallet 与当前账户已授权 Agent 不一致，请重新授权或切换钱包。",
    },
    {
      error: "exchange signature 格式不正确。",
      expected: "真实交易签名格式不正确，请重新签名后重试。",
    },
  ];
  for (const item of cases) {
    const verifier: RealTradingSignatureVerifier = { verify: () => { throw new Error(item.error); } };
    await assert.rejects(
      () => new HyperliquidExchangeProxy("https://example.test", undefined, undefined, verifier).forward(approveAgentPayload(), context),
      (error: unknown) => {
        assert.ok(error instanceof RealTradingExchangeSubmissionError);
        assert.equal(error.httpStatus, item.httpStatus ?? 400);
        assert.equal(error.receipt.message, item.expected);
        assert.doesNotMatch(error.receipt.message ?? "", /包含禁止的敏感字段/);
        assert.doesNotMatch(JSON.stringify(error.receipt), /private.?key|mnemonic|raw.?payload/i);
        return true;
      },
    );
  }
});

test("approveAgent rejects Mainnet action semantics locally", async () => {
  await assert.rejects(
    () => new HyperliquidExchangeProxy("https://example.test").forward({
      ...approveAgentPayload(),
      action: { ...approveAgentPayload().action, hyperliquidChain: "Mainnet" },
    }, context),
    (error: unknown) => {
      assert.ok(error instanceof RealTradingExchangeSubmissionError);
      assert.equal(error.httpStatus, 403);
      assert.equal(error.receipt.errorCode, "RT_ACTION_NOT_ALLOWED");
      assert.equal(error.receipt.actionType, "approveAgent");
      assert.match(error.receipt.message ?? "", /Testnet/);
      return true;
    },
  );
});

test("unknown local signature errors are redacted before reaching receipts", async () => {
  const verifier: RealTradingSignatureVerifier = {
    verify: () => {
      throw new Error("bad signature r=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa s=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb v=27 payload=/tmp/raw.json privateKey=abc mnemonic=seed https://example.test?token=secret");
    },
  };
  await assert.rejects(
    () => new HyperliquidExchangeProxy("https://example.test", undefined, undefined, verifier).forward(approveAgentPayload(), context),
    (error: unknown) => {
      assert.ok(error instanceof RealTradingExchangeSubmissionError);
      const message = error.receipt.message ?? "";
      assert.equal(message, "真实交易请求校验失败，请重新授权或签名后重试。");
      assert.doesNotMatch(message, /0xaaaaaaaa|0xbbbbbbbb|v=27|\/tmp\/raw\.json|privateKey=abc|mnemonic=seed|token=secret/);
      assert.doesNotMatch(JSON.stringify(error.receipt), /privateKey=abc|mnemonic=seed|raw\.json/);
      return true;
    },
  );
});

test("unknown local signature errors redact space-delimited sensitive fields", async () => {
  const verifier: RealTradingSignatureVerifier = {
    verify: () => {
      throw new Error("signature failure v 27 privateKey abc mnemonic twelve_words token bearer-secret authorization BearerSecret payload raw-body r 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa s 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    },
  };
  await assert.rejects(
    () => new HyperliquidExchangeProxy("https://example.test", undefined, undefined, verifier).forward(approveAgentPayload(), context),
    (error: unknown) => {
      assert.ok(error instanceof RealTradingExchangeSubmissionError);
      const message = error.receipt.message ?? "";
      assert.equal(message, "真实交易请求校验失败，请重新授权或签名后重试。");
      assert.doesNotMatch(message, /v 27|privateKey abc|mnemonic twelve_words|token bearer-secret|authorization BearerSecret|payload raw-body|0xaaaaaaaa|0xbbbbbbbb/);
      assert.doesNotMatch(JSON.stringify(error.receipt), /v 27|privateKey abc|mnemonic twelve_words|token bearer-secret|authorization BearerSecret|payload raw-body/);
      return true;
    },
  );
});

test("unknown local signature errors never expose authorization bearer or JSON secrets", async () => {
  const verifier: RealTradingSignatureVerifier = {
    verify: () => {
      throw new Error('provider verifier failed Authorization: Bearer auth-secret bearer bearer-secret {"privateKey":"json-pk","mnemonic":"json-words","token":"json-token","v":27}');
    },
  };
  await assert.rejects(
    () => new HyperliquidExchangeProxy("https://example.test", undefined, undefined, verifier).forward(approveAgentPayload(), context),
    (error: unknown) => {
      assert.ok(error instanceof RealTradingExchangeSubmissionError);
      const message = error.receipt.message ?? "";
      assert.equal(message, "真实交易请求校验失败，请重新授权或签名后重试。");
      assert.doesNotMatch(JSON.stringify(error.receipt), /auth-secret|bearer-secret|json-pk|json-words|json-token|"v":27|Authorization|privateKey|mnemonic/i);
      return true;
    },
  );
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

test("updateLeverage greater than the removed platform ceiling is forwarded and provider rejections stay rejected", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let forwardedBody = "";
  globalThis.fetch = async (_input, init) => {
    forwardedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ status: "err", response: { type: "error", error: "leverage too high" } }), { status: 400 });
  };
  const receipt = await new HyperliquidExchangeProxy("https://example.test").forward({
    ...validPayload(),
    action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 100 },
  }, context);
  assert.match(forwardedBody, /updateLeverage/);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.errorCode, "RT_PROVIDER_REJECTED");
  assert.equal(receipt.message, "Hyperliquid Testnet 拒绝了交易请求。");
});

test("updateLeverage still rejects invalid local contract fields before forwarding", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 });
  };
  const invalidActions = [
    { type: "updateLeverage", asset: -1, isCross: true, leverage: 1 },
    { type: "updateLeverage", asset: 0.5, isCross: true, leverage: 1 },
    { type: "updateLeverage", asset: 0, isCross: "true", leverage: 1 },
    { type: "updateLeverage", asset: 0, isCross: true, leverage: 0 },
    { type: "updateLeverage", asset: 0, isCross: true, leverage: 1.5 },
  ];
  for (const action of invalidActions) {
    await assert.rejects(
      () => new HyperliquidExchangeProxy("https://example.test").forward({ ...validPayload(), action }, context),
      (error: unknown) => error instanceof RealTradingExchangeSubmissionError
        && error.receipt.outcome === "rejected"
        && error.receipt.errorCode === "RT_INVALID_REQUEST",
    );
  }
  assert.equal(fetchCount, 0);
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

function approveAgentPayload() {
  return {
    ...validPayload(),
    action: {
      type: "approveAgent",
      hyperliquidChain: "Testnet",
      signatureChainId: "0x66eee",
      agentAddress: "0x2222222222222222222222222222222222222222",
      nonce: 1,
    },
  };
}
