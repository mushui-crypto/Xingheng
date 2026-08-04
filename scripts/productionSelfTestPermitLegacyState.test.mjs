import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  LEGACY_FAILED_AUTHORIZATION_SHA256,
  LEGACY_FAILED_OPERATION_ID,
  LEGACY_FAILED_RECEIPT_SHA256,
  LEGACY_FAILED_REVISION,
  LEGACY_PERMIT_STATE,
  classifyLegacyPermitState,
  migrateLegacyPermitState,
  readLegacyMigrationReceipt,
  validateLegacyFailedReceiptBinding,
} from "./productionSelfTestPermitLegacyState.mjs";

const OWNER = "USR-CAPITALTEST";
const MIGRATION_REVISION = "b".repeat(40);
const NOW = new Date("2026-08-04T10:00:00.000Z");

test("pure legacy failed receipt binding validation accepts one exact isolated tuple", () => {
  const actualReceiptSha256 = sha256(Buffer.from("isolated failed receipt test vector"));
  const expected = {
    authorizationManifestSha256: LEGACY_FAILED_AUTHORIZATION_SHA256,
    operationId: LEGACY_FAILED_OPERATION_ID,
    receiptSha256: actualReceiptSha256,
    revision: LEGACY_FAILED_REVISION,
  };
  const receipt = {
    operationId: expected.operationId,
    request: {
      releaseRevision: expected.revision,
      authorizationManifestSha256: expected.authorizationManifestSha256,
    },
  };
  assert.doesNotThrow(() =>
    validateLegacyFailedReceiptBinding(receipt, actualReceiptSha256, expected));

  for (const [mutateReceipt, actual] of [
    [(value) => { value.operationId = "0".repeat(32); }, actualReceiptSha256],
    [() => {}, "0".repeat(64)],
    [(value) => { value.request.releaseRevision = "0".repeat(40); }, actualReceiptSha256],
    [(value) => { value.request.authorizationManifestSha256 = "0".repeat(64); }, actualReceiptSha256],
  ]) {
    const invalid = structuredClone(receipt);
    mutateReceipt(invalid);
    assert.throws(() => validateLegacyFailedReceiptBinding(invalid, actual, expected));
  }
});

test("pure legacy failed receipt binding validation rejects incomplete or malformed inputs", () => {
  const digest = "1".repeat(64);
  const receipt = {
    operationId: "2".repeat(32),
    request: { releaseRevision: "3".repeat(40), authorizationManifestSha256: "4".repeat(64) },
  };
  const expected = {
    authorizationManifestSha256: receipt.request.authorizationManifestSha256,
    operationId: receipt.operationId,
    receiptSha256: digest,
    revision: receipt.request.releaseRevision,
  };
  for (const invalid of [
    null,
    {},
    { ...expected, extra: true },
    { ...expected, operationId: "bad" },
    { ...expected, receiptSha256: "bad" },
    { ...expected, revision: "bad" },
    { ...expected, authorizationManifestSha256: "bad" },
  ]) assert.throws(() => validateLegacyFailedReceiptBinding(receipt, digest, invalid));
  for (const invalidReceipt of [null, {}, { operationId: receipt.operationId }, {
    operationId: receipt.operationId, request: {},
  }]) assert.throws(() => validateLegacyFailedReceiptBinding(invalidReceipt, digest, expected));
  assert.throws(() => validateLegacyFailedReceiptBinding(receipt, "bad", expected));
});

test("legacy Permit state classifier distinguishes all compatibility states", () => {
  assert.equal(classifyLegacyPermitState(state()).state, LEGACY_PERMIT_STATE.ABSENT);
  assert.equal(classifyLegacyPermitState(state({ consumptions: [] })).state, LEGACY_PERMIT_STATE.EMPTY);
  const consumed = classifyLegacyPermitState(state({ consumptions: [consumption()] }), "a".repeat(32));
  assert.equal(consumed.state, LEGACY_PERMIT_STATE.CONSUMED);
  assert.equal(consumed.matchingConsumption, true);
  assert.equal(classifyLegacyPermitState(state({ consumptions: {} })).state, LEGACY_PERMIT_STATE.CORRUPT);
  assert.equal(classifyLegacyPermitState(state({ consumptions: [{ permitId: "bad" }] })).state, LEGACY_PERMIT_STATE.CORRUPT);
});

test("one-time legacy migration adds only an empty tombstone collection and writes a bound receipt", () => {
  withFixture((fixture) => {
    const before = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    const receipt = migrateLegacyPermitState(fixture.input, fixture.options());
    const after = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.deepEqual(after, { ...before, productionSelfTestPermitConsumptions: [] });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.failedOperationId, LEGACY_FAILED_OPERATION_ID);
    assert.equal(receipt.failedReceiptSha256, LEGACY_FAILED_RECEIPT_SHA256);
    assert.equal(receipt.stateBeforeSha256, sha256(fixture.stateBefore));
    assert.equal(receipt.stateAfterSha256, sha256(readFileSync(fixture.statePath)));
    assert.deepEqual(readLegacyMigrationReceipt(fixture.receiptPath, fixture.options()), receipt);
  });
});

test("repeated migration is rejected without changing state or receipt", () => {
  withFixture((fixture) => {
    migrateLegacyPermitState(fixture.input, fixture.options());
    const stateAfter = readFileSync(fixture.statePath);
    const receiptAfter = readFileSync(fixture.receiptPath);
    assert.throws(
      () => migrateLegacyPermitState(fixture.input, fixture.options()),
      /already been attempted/u,
    );
    assert.deepEqual(readFileSync(fixture.statePath), stateAfter);
    assert.deepEqual(readFileSync(fixture.receiptPath), receiptAfter);
  });
});

test("migration rejects an existing or malformed field before creating a receipt", () => {
  for (const consumptions of [[], {}, [consumption()]]) {
    withFixture((fixture) => {
      writeSecure(fixture.statePath, stateBytes({ consumptions }), 0o600);
      assert.throws(() => migrateLegacyPermitState(fixture.input, fixture.options()));
      assert.throws(() => readFileSync(fixture.receiptPath), /ENOENT/u);
    });
  }
});

test("migration failure restores the legacy state and leaves only a fail-closed receipt", () => {
  withFixture((fixture) => {
    assert.throws(() => migrateLegacyPermitState(fixture.input, fixture.options({
      operations: {
        beforeRename(fallback, path) {
          if (path === fixture.statePath) throw new Error("injected state replacement failure");
          return fallback();
        },
      },
    })), /injected state replacement failure/u);
    assert.deepEqual(readFileSync(fixture.statePath), fixture.stateBefore);
    const terminal = readLegacyMigrationReceipt(fixture.receiptPath, fixture.options());
    assert.equal(terminal.status, "unknown");
  });
});

test("migration receipt persistence failure leaves no prepared state or state mutation", () => {
  withFixture((fixture) => {
    let injected = false;
    assert.throws(() => migrateLegacyPermitState(fixture.input, fixture.options({
      operations: {
        fileFsync(fallback) {
          if (!injected) {
            injected = true;
            throw new Error("injected receipt persistence failure");
          }
          return fallback();
        },
      },
    })), /injected receipt persistence failure/u);
    assert.deepEqual(readFileSync(fixture.statePath), fixture.stateBefore);
    assert.equal(readLegacyMigrationReceipt(fixture.receiptPath, fixture.options()).status, "unknown");
  });
});

test("generation pointer race fails closed without replacing the latest state", () => {
  withFixture((fixture) => {
    assert.throws(() => migrateLegacyPermitState(fixture.input, fixture.options({
      operations: {
        beforeRename(fallback, path) {
          if (path === fixture.statePath) {
            writeSecure(fixture.pointerPath, Buffer.from(`${JSON.stringify({
              version: 1,
              generation: "generation-20260804T100000Z-abcdef123456",
              rollbackGeneration: "generation-initial",
            })}\n`), 0o600);
          }
          return fallback();
        },
      },
    })), /changed before migration/u);
    assert.deepEqual(readFileSync(fixture.statePath), fixture.stateBefore);
    assert.equal(readLegacyMigrationReceipt(fixture.receiptPath, fixture.options()).status, "unknown");
  });
});

test("migration terminal receipt failure preserves the latest migrated safe state", () => {
  withFixture((fixture) => {
    let injected = false;
    assert.throws(() => migrateLegacyPermitState(fixture.input, fixture.options({
      operations: {
        beforeRename(fallback, path) {
          if (path === fixture.receiptPath && !injected) {
            injected = true;
            throw new Error("injected terminal receipt failure");
          }
          return fallback();
        },
      },
    })), /injected terminal receipt failure/u);
    assert.notDeepEqual(readFileSync(fixture.statePath), fixture.stateBefore);
    assert.deepEqual(
      JSON.parse(readFileSync(fixture.statePath, "utf8")).productionSelfTestPermitConsumptions,
      [],
    );
    assert.equal(readLegacyMigrationReceipt(fixture.receiptPath, fixture.options()).status, "unknown");
  });
});

for (const defect of ["mode", "owner", "group"]) {
  test(`migration rejects a state file ${defect} defect before creating a receipt`, {
    skip: ["owner", "group"].includes(defect)
      && (process.platform !== "linux" || process.getuid?.() !== 0)
      ? "requires real Linux root ownership semantics"
      : false,
  }, () => {
    withFixture((fixture) => {
      if (defect === "mode") chmodSync(fixture.statePath, 0o644);
      else chownSync(fixture.statePath, defect === "owner" ? 1 : 0, defect === "group" ? 1 : 0);
      assert.throws(
        () => migrateLegacyPermitState(fixture.input, fixture.options()),
        /file boundary is invalid/u,
      );
      assert.throws(() => readFileSync(fixture.receiptPath), /ENOENT/u);
    });
  });
}

test("migration never modifies the preserved failed receipt evidence", () => {
  withFixture((fixture) => {
    const oldReceipt = resolve(fixture.root, "old-failed-receipt.json");
    writeSecure(oldReceipt, Buffer.from('{"status":"failed"}\n'), 0o400);
    const before = readFileSync(oldReceipt);
    migrateLegacyPermitState(fixture.input, fixture.options());
    assert.deepEqual(readFileSync(oldReceipt), before);
  });
});

test("install wrapper checks compatibility before prepare and every install side effect", () => {
  const source = readFileSync(new URL("./install-production-self-test-permit.sh", import.meta.url), "utf8");
  const compatibility = source.indexOf("verify-production-self-test-permit-state.mjs");
  const prepare = source.indexOf("productionSelfTestPermitInstall.mjs prepare");
  const runtimeBefore = source.indexOf("runtime-before");
  const restart = source.indexOf("up -d api");
  assert.ok(compatibility > 0);
  assert.ok(compatibility < prepare);
  assert.ok(prepare < runtimeBefore);
  assert.ok(runtimeBefore < restart);
});

test("legacy migration wrapper is offline, lock-bound, and has no API exec path", () => {
  const source = readFileSync(
    new URL("./migrate-production-self-test-permit-legacy-state.sh", import.meta.url),
    "utf8",
  );
  assert.match(source, /production_compose stop api/u);
  assert.match(source, /\[ "\$#" -eq 0 \]/u);
  const verifiedOwner = source.indexOf("legacy_failure=\"$(node scripts/productionSelfTestPermitLegacyState.mjs verify-failure)\"");
  const migrationCall = source.indexOf("productionSelfTestPermitLegacyState.mjs migrate");
  assert.ok(verifiedOwner > 0 && verifiedOwner < migrationCall);
  assert.match(source, /ps --status running -q api/u);
  assert.match(source, /flock -n -x \/app\/rwa-automation-lock\/operation\.lock/u);
  assert.doesNotMatch(source, /exec -T api/u);
  assert.doesNotMatch(source, /productionSelfTestPermitLegacyState\.mjs migrate[\s\S]*\$\{/u);
});

test("production Compose allowlist permits only the fixed offline legacy migration shape", () => {
  const source = readFileSync(
    new URL("./verify-compose-environment-file.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /"exec", "-T", "api", "node",[\s\S]{0,120}productionSelfTestPermitLegacyState/u);
  assert.match(source, /args\.length === 18/u);
  assert.match(source, /process\.env\.XINGHENG_TRUSTED_OPERATION_ENTRY[\s\S]{0,80}=== "migrate-production-self-test-permit-legacy-state\.sh"/u);
  assert.match(source, /XINGHENG_TRUSTED_OPERATION_ENTRY=migrate-production-self-test-permit-legacy-state\.sh/u);
  assert.match(source, /XINGHENG_OPERATION_LOCK_CONTEXT=production/u);
  assert.match(source, /"rwa-automation-restore", "flock", "-n", "-x"/u);
  assert.match(source, /\/app\/rwa-automation-lock\/operation\.lock/u);
  assert.match(source, /args\[16\] === "e0c3703b9a008ae5bcdfa56f413a6f36"/u);
  assert.match(source, /args\[17\] === "e6392afb1072288986778143b54a48ac9ef4c4e69e418987a2e64b31f9bd04a1"/u);

  const composeWrapper = readFileSync(
    new URL("./production-compose.sh", import.meta.url),
    "utf8",
  );
  assert.match(composeWrapper, /XINGHENG_TRUSTED_OPERATION_ENTRY="\$\{XINGHENG_TRUSTED_OPERATION_ENTRY:-\}"/u);
  const launcher = readFileSync(
    new URL("./trusted-operation-launcher.mjs", import.meta.url),
    "utf8",
  );
  const childEnvironment = launcher.slice(
    launcher.indexOf("const childEnvironment ="),
    launcher.indexOf("const result = spawnSync"),
  );
  assert.doesNotMatch(childEnvironment, /XINGHENG_TRUSTED_OPERATION_ENTRY/u);
  assert.match(source, /args\[4\] === "XINGHENG_TRUSTED_OPERATION_ENTRY=migrate-production-self-test-permit-legacy-state\.sh"/u);
});

function withFixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-legacy-permit-"));
  try {
    const generation = "generation-initial";
    const generationRoot = resolve(root, generation);
    mkdirSync(generationRoot, { mode: 0o700 });
    const stateFile = "0123456789abcdef-binance-state.json";
    const statePath = resolve(generationRoot, stateFile);
    const receiptPath = resolve(root, ".production-self-test-permit-legacy-migration.json");
    const pointerPath = resolve(root, "current.json");
    const stateBefore = stateBytes();
    writeSecure(statePath, stateBefore, 0o600);
    writeSecure(pointerPath, Buffer.from(`${JSON.stringify({
      version: 1,
      generation,
      rollbackGeneration: null,
    })}\n`), 0o600);
    const fixture = {
      root,
      statePath,
      pointerPath,
      receiptPath,
      stateBefore,
      input: {
        ownerUserId: OWNER,
        failedOperationId: LEGACY_FAILED_OPERATION_ID,
        failedReceiptSha256: LEGACY_FAILED_RECEIPT_SHA256,
        migrationRevision: MIGRATION_REVISION,
        generation,
        stateFile,
        statePath,
        pointerPath,
        receiptPath,
      },
      options(overrides = {}) {
        return {
          testMode: true,
          now: NOW,
          migrationId: "c".repeat(32),
          ...overrides,
        };
      },
    };
    run(fixture);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function state({ consumptions } = {}) {
  const value = {
    version: 1,
    config: {
      killSwitchActive: true,
      globalExecutionEnabled: false,
      strategyEnabled: false,
      productionSelfTestPermitConfirmation: null,
    },
    connectivitySmokes: [],
  };
  if (arguments[0] && Object.hasOwn(arguments[0], "consumptions")) {
    value.productionSelfTestPermitConsumptions = consumptions;
  }
  return value;
}

function stateBytes(options) { return Buffer.from(`${JSON.stringify(state(options))}\n`); }
function consumption() {
  return {
    permitId: "a".repeat(32),
    digest: "d".repeat(64),
    consumedAt: Date.parse("2026-08-04T08:00:00.000Z"),
  };
}
function writeSecure(path, bytes, mode) {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
