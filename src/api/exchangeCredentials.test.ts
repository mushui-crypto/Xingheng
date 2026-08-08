import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExchangeCredentialSummary } from "./exchangeCredentials";

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
