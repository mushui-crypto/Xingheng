import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProviderIdentityReceipts,
  validateProviderIdentityReceipt,
} from "./providerIdentityReceipts.mjs";

const NOW = new Date("2026-07-26T00:05:00.000Z");
const REVISION = "a".repeat(40);

test("accepts two fresh environment-bound receipts for different authoritative accounts", () => {
  const result = compareProviderIdentityReceipts(
    receipt("production", "1".repeat(64)),
    receipt("real-test", "2".repeat(64)),
    NOW,
  );
  assert.equal(result.authoritativeAccountsDistinct, true);
  assert.equal(result.revision, REVISION);
});

test("same actual UID is rejected even when environment credential bindings differ", () => {
  assert.throws(
    () => compareProviderIdentityReceipts(
      receipt("production", "1".repeat(64), "3".repeat(64)),
      receipt("real-test", "1".repeat(64), "4".repeat(64)),
      NOW,
    ),
    /same authoritative provider account/u,
  );
});

test("missing, crossed, stale, future and revision-drifted receipts fail closed", () => {
  assert.throws(
    () => validateProviderIdentityReceipt(
      { ...receipt("production", "1".repeat(64)), composeProject: "xingheng-real-test" },
      "production",
      NOW,
    ),
    /schema/u,
  );
  assert.throws(
    () => validateProviderIdentityReceipt(
      { ...receipt("production", "1".repeat(64)), verifiedAt: "2026-07-25T23:00:00.000Z" },
      "production",
      NOW,
    ),
    /stale/u,
  );
  assert.throws(
    () => compareProviderIdentityReceipts(
      receipt("production", "1".repeat(64)),
      { ...receipt("real-test", "2".repeat(64)), revision: "b".repeat(40) },
      NOW,
    ),
    /revision mismatch/u,
  );
});

function receipt(environment, identity, binding = "3".repeat(64)) {
  return {
    schemaVersion: 1,
    provider: "binance",
    deploymentEnvironment: environment,
    composeProject: environment === "production" ? "xingheng" : "xingheng-real-test",
    revision: REVISION,
    accountIdentitySha256: identity,
    credentialBindingSha256: binding,
    verifiedAt: "2026-07-26T00:00:00.000Z",
    readOnly: true,
  };
}
