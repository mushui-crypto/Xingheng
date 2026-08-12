import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "./httpClient";
import { normalizeExchangeCredentialSummary, presentExchangeCredentialError, saveExchangeCredential } from "./exchangeCredentials";

test("credential responses are reduced to the public summary field whitelist", () => {
  const summary = normalizeExchangeCredentialSummary({
    venue: "binance",
    configured: true,
    implemented: true,
    accountId: "account",
    accountFingerprint: "fingerprint",
    maskedApiKey: "abc...xyz",
    permissions: { read: true, withdraw: false, ignored: "not-boolean" },
    lastVerifiedAt: 42,
    message: null,
    apiKey: "must-not-survive",
    apiSecret: "must-not-survive",
    passphrase: "must-not-survive",
  });

  assert.deepEqual(summary, {
    venue: "binance",
    configured: true,
    implemented: true,
    accountId: "account",
    accountFingerprint: "fingerprint",
    maskedApiKey: "abc...xyz",
    permissions: { read: true, withdraw: false },
    lastVerifiedAt: 42,
    message: null,
  });
  assert.equal("apiSecret" in (summary ?? {}), false);
});

test("invalid venues are rejected instead of being shown as configured", () => {
  assert.equal(normalizeExchangeCredentialSummary({ venue: "unknown", configured: true }), null);
});

test("credential-only exchange summaries preserve fail-closed capability metadata", () => {
  const summary = normalizeExchangeCredentialSummary({
    venue: "okx",
    configured: true,
    implemented: true,
    accountId: "okx:credential-only:abc",
    accountFingerprint: "OKX-ABC",
    maskedApiKey: "okx-...-001",
    permissions: { read: false, executionEnabled: false, providerVerified: false },
    lastVerifiedAt: 42,
    message: "OKX API credential is encrypted and saved. Private provider validation and execution are not enabled for this venue.",
  });

  assert.equal(summary?.configured, true);
  assert.equal(summary?.implemented, true);
  assert.equal(summary?.permissions.executionEnabled, false);
  assert.match(summary?.message ?? "", /execution are not enabled/u);
});

test("KMS credential key errors are presented as service recovery actions, not exchange key failures", () => {
  const response = new Response(JSON.stringify({
    category: "credential_key_provider_unavailable",
    message: "GCP KMS is unavailable, unauthorized, or the key version is disabled.",
  }), { status: 503 });
  const error = new HttpRequestError(
    "GCP KMS is unavailable, unauthorized, or the key version is disabled.",
    response,
    "credential_key_provider_unavailable",
  );

  assert.equal(
    presentExchangeCredentialError(error).message,
    "凭证加密服务当前不可用，请等待 KMS/WIF 恢复后重试；无需在交易所重新创建 API Key。",
  );
});

test("saveExchangeCredential sends OKX passphrase and reduces the response to public metadata", async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    captured.push({ input, init });
    return new Response(JSON.stringify({
      venue: "okx",
      configured: true,
      implemented: true,
      accountId: "okx:credential-only:abc",
      accountFingerprint: "OKX-ABC",
      maskedApiKey: "okx-...-001",
      permissions: { executionEnabled: false, providerVerified: false },
      lastVerifiedAt: 42,
      message: "OKX API credential is encrypted and saved. Private provider validation and execution are not enabled for this venue.",
      apiSecret: "must-not-survive",
      passphrase: "must-not-survive",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const summary = await saveExchangeCredential("okx", {
      apiKey: "okx-api-key",
      apiSecret: "okx-secret",
      passphrase: "okx-passphrase",
    });
    assert.equal(captured[0]?.input, "/api/exchange-credentials/okx");
    assert.equal(captured[0]?.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(captured[0]?.init?.body)), {
      apiKey: "okx-api-key",
      apiSecret: "okx-secret",
      passphrase: "okx-passphrase",
    });
    assert.equal(summary.venue, "okx");
    assert.equal(summary.configured, true);
    assert.equal(summary.permissions.executionEnabled, false);
    assert.equal("apiSecret" in summary, false);
    assert.equal("passphrase" in summary, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saveExchangeCredential maps KMS failures to the credential service recovery message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    category: "credential_key_provider_unavailable",
    message: "GCP KMS is unavailable, unauthorized, or the key version is disabled.",
  }), { status: 503, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      saveExchangeCredential("bitget", {
        apiKey: "bitget-api-key",
        apiSecret: "bitget-secret",
        passphrase: "bitget-passphrase",
      }),
      /凭证加密服务当前不可用，请等待 KMS\/WIF 恢复后重试；无需在交易所重新创建 API Key。/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
