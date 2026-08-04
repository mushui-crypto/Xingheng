import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const OWNER = "USR-CAPITALTEST";
const SCRIPT = fileURLToPath(new URL("./verify-production-self-test-permit-state.mjs", import.meta.url));

test("state verifier accepts only fail-closed unconsumed state", () => {
  withState({}, ({ root }) => {
    const result = verify(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "permit-state-safe\n");
  });
});

for (const [name, override, pattern] of [
  ["missing tombstone collection", { productionSelfTestPermitConsumptions: undefined }, /already been consumed/u],
  ["existing consumption", { productionSelfTestPermitConsumptions: [{ permitId: "a" }] }, /already been consumed/u],
  ["existing confirmation", { confirmation: { permitId: "a" } }, /switches must remain fail-closed/u],
  ["unfinished smoke", { connectivitySmokes: [{ stage: "reserved" }] }, /unfinished connectivity smoke/u],
]) {
  test(`state verifier rejects ${name}`, () => {
    withState(override, ({ root }) => {
      const result = verify(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    });
  });
}

test("state verifier rejects a symlinked generation pointer", () => {
  withState({}, ({ root, current }) => {
    rmSync(current);
    const alternate = resolve(root, "alternate.json");
    writePrivate(alternate, { version: 1, generation: "generation-initial" });
    symlinkSync(alternate, current);
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /state boundary is invalid/u);
  });
});

test("runtime verifier proves the API process loaded the exact Permit identity", () => {
  withState({}, ({ root }) => {
    const permit = runtimePermitEnvironment();
    const result = verify(root, {
      mode: "runtime",
      digest: permit.digest,
      environment: permit.environment,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "permit-runtime-safe\n");
  });
});

test("runtime verifier rejects a different process Permit despite safe persistent state", () => {
  withState({}, ({ root }) => {
    const permit = runtimePermitEnvironment();
    const result = verify(root, {
      mode: "runtime",
      digest: permit.digest,
      environment: {
        ...permit.environment,
        RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: "f".repeat(32),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Runtime Permit identity mismatch/u);
  });
});

function withState(override, run) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-permit-state-"));
  try {
    const generation = resolve(root, "generation-initial");
    mkdirSync(generation, { mode: 0o700 });
    const current = resolve(root, "current.json");
    writePrivate(current, { version: 1, generation: "generation-initial" });
    const domain = createHash("sha256").update(`rwa-user:${OWNER}`).digest("hex").slice(0, 16);
    const state = {
      version: 1,
      config: {
        killSwitchActive: true,
        globalExecutionEnabled: false,
        strategyEnabled: false,
        productionSelfTestPermitConfirmation: override.confirmation ?? null,
      },
      connectivitySmokes: override.connectivitySmokes ?? [],
      productionSelfTestPermitConsumptions: Object.hasOwn(override, "productionSelfTestPermitConsumptions")
        ? override.productionSelfTestPermitConsumptions
        : [],
    };
    if (state.productionSelfTestPermitConsumptions === undefined) {
      delete state.productionSelfTestPermitConsumptions;
    }
    writePrivate(resolve(generation, `${domain}-binance-state.json`), state);
    run({ root, current });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verify(root, runtime = null) {
  const expiresAt = "2026-08-04T09:00:00.000Z";
  const revision = "6efe18eb943b8a57750eeeb06700f101bd676414";
  const authorization = "d".repeat(64);
  const args = runtime === null
    ? [SCRIPT, OWNER]
    : [SCRIPT, OWNER, runtime.mode, runtime.digest, revision, authorization, expiresAt];
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
      RWA_AUTOMATION_DATA_DIR: root,
      ...(runtime?.environment ?? {}),
    },
  });
}

function runtimePermitEnvironment() {
  const permitId = "a".repeat(32);
  const accountBindingSha256 = "c".repeat(64);
  const authorization = "d".repeat(64);
  const revision = "6efe18eb943b8a57750eeeb06700f101bd676414";
  const expiresAt = "2026-08-04T09:00:00.000Z";
  const digest = createHash("sha256").update([
    "production", "binance", "xaut", permitId, OWNER, accountBindingSha256,
    "READ", "TRADE", authorization, "40", revision, expiresAt,
  ].join(":"), "utf8").digest("hex");
  return {
    digest,
    environment: {
      RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED: "true",
      RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID: permitId,
      RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID: OWNER,
      RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256: accountBindingSha256,
      RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE: '["READ","TRADE"]',
      RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST: authorization,
      RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD: "40",
      RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT: expiresAt,
      XINGHENG_EXPECTED_REVISION: revision,
    },
  };
}

function writePrivate(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
