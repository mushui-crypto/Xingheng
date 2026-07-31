import assert from "node:assert/strict";
import test from "node:test";
import {
  binanceAccountBindingSha256,
  loadRwaBinanceProductionSelfTestPermit,
  productionSelfTestPermitDigest,
  validProductionSelfTestPermitConfirmation,
} from "./RwaBinanceProductionSelfTestPermit";

const revision = "a".repeat(40);
const permitId = "b".repeat(32);
const accountBindingSha256 = "c".repeat(64);
const expiresAt = Date.parse("2026-08-01T00:00:00.000Z");

test("production self-test permit accepts only the exact server-controlled schema", () => {
  const environment = {
    RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "true",
    RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: permitId,
    RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: "USR-MOSS1",
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: accountBindingSha256,
    RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "30",
    RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT: "2026-08-01T00:00:00.000Z",
    XINGHENG_EXPECTED_REVISION: revision,
  };
  const parsed = loadRwaBinanceProductionSelfTestPermit(environment);
  assert.ok(parsed);
  assert.equal(parsed.expiresAt, expiresAt);
  assert.equal(parsed.digest, productionSelfTestPermitDigest(parsed));
  assert.match(binanceAccountBindingSha256("account", "fingerprint"), /^[a-f0-9]{64}$/u);

  for (const mutation of [
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "false" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: "B".repeat(32) },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: "user-a" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: "c".repeat(63) },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "0" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT: "2026-08-01T00:00:00Z" },
    { XINGHENG_EXPECTED_REVISION: "main" },
  ]) {
    assert.equal(loadRwaBinanceProductionSelfTestPermit({ ...environment, ...mutation }), null);
  }
});

test("production self-test confirmation rejects missing, legacy, and extra fields", () => {
  const permit = loadRwaBinanceProductionSelfTestPermit({
    RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "true",
    RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: permitId,
    RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: "USR-MOSS1",
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: accountBindingSha256,
    RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "30",
    RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT: "2026-08-01T00:00:00.000Z",
    XINGHENG_EXPECTED_REVISION: revision,
  })!;
  assert.equal(validProductionSelfTestPermitConfirmation({
    ...permit,
    confirmedAt: expiresAt - 1,
  }), true);
  assert.equal(validProductionSelfTestPermitConfirmation(null), false);
  assert.equal(validProductionSelfTestPermitConfirmation({ ...permit, confirmedAt: 1, extra: true }), false);
});
