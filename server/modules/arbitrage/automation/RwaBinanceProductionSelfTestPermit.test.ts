import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  binanceCredentialBindingSha256,
  loadRwaBinanceProductionSelfTestPermit,
  productionSelfTestPermitDigest,
  RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN,
  validProductionSelfTestPermitConsumption,
  validProductionSelfTestPermitConfirmation,
} from "./RwaBinanceProductionSelfTestPermit";

const revision = "a".repeat(40);
const permitId = "b".repeat(32);
const accountBindingSha256 = "c".repeat(64);
const authorizationDigest = "d".repeat(64);
const expiresAt = Date.parse("2026-08-01T00:00:00.000Z");

test("production self-test permit accepts only the exact server-controlled schema", () => {
  const environment = {
    RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "true",
    RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: permitId,
    RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: "USR-MOSS1",
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: accountBindingSha256,
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","TRADE"]',
    RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST: authorizationDigest,
    RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "30",
    RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT: "2026-08-01T00:00:00.000Z",
    XINGHENG_EXPECTED_REVISION: revision,
  };
  const parsed = loadRwaBinanceProductionSelfTestPermit(environment);
  assert.ok(parsed);
  assert.equal(parsed.expiresAt, expiresAt);
  assert.deepEqual(parsed.actionScope, ["READ", "TRADE"]);
  assert.equal(parsed.authorizationDigest, authorizationDigest);
  assert.equal(parsed.digest, productionSelfTestPermitDigest(parsed));
  const binding = {
    userId: "USR-MOSS1",
    venue: "binance" as const,
    bindingVersion: 1,
    uidSnapshot: "f".repeat(64),
  };
  const bindingDigest = binanceCredentialBindingSha256(binding);
  assert.match(bindingDigest, /^[a-f0-9]{64}$/u);
  assert.equal(bindingDigest, createHash("sha256").update([
    RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN,
    binding.userId,
    binding.venue,
    String(binding.bindingVersion),
    binding.uidSnapshot,
  ].join("\0")).digest("hex"));
  assert.notEqual(
    binanceCredentialBindingSha256(binding),
    binanceCredentialBindingSha256({ ...binding, bindingVersion: 2 }),
  );
  assert.notEqual(
    binanceCredentialBindingSha256(binding),
    binanceCredentialBindingSha256({ ...binding, userId: "USR-MOSS2" }),
  );
  const renamedBinding = { ...binding, credentialNote: "renamed" };
  assert.equal(
    binanceCredentialBindingSha256(binding),
    binanceCredentialBindingSha256(renamedBinding),
  );
  const {
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: _missingActionScope,
    ...withoutActionScope
  } = environment;
  const {
    RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST: _missingAuthorizationDigest,
    ...withoutAuthorizationDigest
  } = environment;
  assert.equal(loadRwaBinanceProductionSelfTestPermit(withoutActionScope), null);
  assert.equal(loadRwaBinanceProductionSelfTestPermit(withoutAuthorizationDigest), null);

  for (const mutation of [
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "false" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: "B".repeat(32) },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: "user-a" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: "c".repeat(63) },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["TRADE","READ"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","READ"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","WITHDRAW"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ", "TRADE"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","TRADE","READ"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","trade"]' },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST: "D".repeat(64) },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "0" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "40.01" },
    { RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT: "2026-08-01T00:00:00Z" },
    { XINGHENG_EXPECTED_REVISION: "main" },
  ]) {
    assert.equal(loadRwaBinanceProductionSelfTestPermit({ ...environment, ...mutation }), null);
  }
});

test("production self-test binding identity rejects malformed snapshots and unsupported venues", () => {
  const binding = {
    userId: "USR-MOSS1",
    venue: "binance" as const,
    bindingVersion: 1,
    uidSnapshot: "f".repeat(64),
  };
  for (const invalid of [
    { ...binding, userId: "" },
    { ...binding, venue: "bybit" },
    { ...binding, bindingVersion: 0 },
    { ...binding, bindingVersion: 1.5 },
    { ...binding, uidSnapshot: "f".repeat(16) },
    { ...binding, uidSnapshot: "F".repeat(64) },
  ]) {
    assert.throws(
      () => binanceCredentialBindingSha256(invalid as typeof binding),
      /Binding identity is invalid/u,
    );
  }
});

test("production self-test confirmation rejects missing, legacy, and extra fields", () => {
  const permit = loadRwaBinanceProductionSelfTestPermit({
    RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "true",
    RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: permitId,
    RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: "USR-MOSS1",
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: accountBindingSha256,
    RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","TRADE"]',
    RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST: authorizationDigest,
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
  assert.equal(validProductionSelfTestPermitConfirmation({
    ...permit,
    actionScope: ["TRADE", "READ"],
    confirmedAt: 1,
  }), false);
  assert.equal(validProductionSelfTestPermitConfirmation({
    ...permit,
    authorizationDigest: "D".repeat(64),
    confirmedAt: 1,
  }), false);
  const { actionScope: _actionScope, ...withoutActionScope } = permit;
  const { authorizationDigest: _authorizationDigest, ...withoutAuthorizationDigest } = permit;
  assert.equal(validProductionSelfTestPermitConfirmation({
    ...withoutActionScope,
    confirmedAt: 1,
  }), false);
  assert.equal(validProductionSelfTestPermitConfirmation({
    ...withoutAuthorizationDigest,
    confirmedAt: 1,
  }), false);
});

test("production self-test consumption accepts only exact unique-record fields", () => {
  const consumption = { permitId, digest: "e".repeat(64), consumedAt: 1 };
  assert.equal(validProductionSelfTestPermitConsumption(consumption), true);
  assert.equal(validProductionSelfTestPermitConsumption({ ...consumption, extra: true }), false);
  assert.equal(validProductionSelfTestPermitConsumption({ ...consumption, permitId: "B".repeat(32) }), false);
  assert.equal(validProductionSelfTestPermitConsumption({ ...consumption, digest: "E".repeat(64) }), false);
  assert.equal(validProductionSelfTestPermitConsumption({ ...consumption, consumedAt: 0 }), false);
});
