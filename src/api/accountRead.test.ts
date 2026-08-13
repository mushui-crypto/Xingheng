import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "./httpClient";
import {
  AccountReadRequestError,
  fetchAccountRead,
  presentAccountReadError,
  requireAccountReadSnapshot,
} from "./accountRead";

test("account read requests the selected venue through the common boundary", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return Response.json(accountSnapshot());
  };
  try {
    const snapshot = await fetchAccountRead("binance");
    assert.equal(requested, "/api/account-read/binance");
    assert.equal(snapshot.venue, "binance");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account read response keeps only display-safe fields", () => {
  const snapshot = requireAccountReadSnapshot({
    ...accountSnapshot(),
    uidHash: "raw-uid-must-not-survive",
    apiKey: "api-key-must-not-survive",
    apiSecret: "secret-must-not-survive",
    credential: { apiSecret: "nested-secret" },
  }, "binance");

  assert.equal("uidHash" in snapshot, false);
  assert.equal("apiKey" in snapshot, false);
  assert.equal("apiSecret" in snapshot, false);
  assert.equal("credential" in snapshot, false);
  assert.equal(snapshot.accountId, "binance:account-hash");
});

test("account read errors map categories to stable Chinese states", () => {
  for (const [category, status, kind, message] of [
    ["credential_not_configured", 409, "missing_credential", "尚未配置账户凭证"],
    ["credential_validation_failed", 502, "validation_failed", "账户凭证验证失败"],
    ["provider_read_failed", 502, "provider_failed", "交易所账户读取失败"],
  ] as const) {
    const error = new HttpRequestError("raw provider message", new Response(null, { status }), category);
    const presented = presentAccountReadError(error);
    assert.ok(presented instanceof AccountReadRequestError);
    assert.equal(presented.kind, kind);
    assert.equal(presented.message, message);
    assert.doesNotMatch(presented.message, /raw provider message/u);
  }
});

function accountSnapshot() {
  return {
    venue: "binance",
    accountId: "binance:account-hash",
    accountFingerprint: "fingerprint-hash",
    accountTypes: ["spot", "derivatives"],
    accountMode: "multi_assets_hedge",
    connection: { status: "connected", checkedAt: 1_800_000_000_000 },
    credentialValidation: { status: "validated", checkedAt: 1_800_000_000_000 },
    balances: [{
      asset: "BTC",
      accountType: "spot",
      total: 0.002,
      available: null,
      locked: 0.001,
      estimatedValueUsdt: null,
      valuationStatus: "UNAVAILABLE",
    }],
    permissions: {
      read: "ENABLED",
      spotTrade: "UNKNOWN",
      derivativesTrade: "UNKNOWN",
      withdraw: "DISABLED",
      ipRestricted: "UNKNOWN",
    },
    latestSyncAt: 1_800_000_000_000,
    estimatedTotalValueUsdt: null,
    valuationCoverage: "UNAVAILABLE",
  };
}
