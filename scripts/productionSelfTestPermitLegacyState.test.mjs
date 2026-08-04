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
  LEGACY_FAILED_OPERATION_ID,
  LEGACY_FAILED_RECEIPT_SHA256,
  LEGACY_PERMIT_STATE,
  classifyLegacyPermitState,
  migrateLegacyPermitState,
  readLegacyMigrationReceipt,
} from "./productionSelfTestPermitLegacyState.mjs";

const OWNER = "USR-CAPITALTEST";
const MIGRATION_REVISION = "b".repeat(40);
const NOW = new Date("2026-08-04T10:00:00.000Z");

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

test("migration terminal receipt failure rolls back the migrated state", () => {
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
    assert.deepEqual(readFileSync(fixture.statePath), fixture.stateBefore);
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

function withFixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-legacy-permit-"));
  try {
    const generation = "generation-initial";
    const generationRoot = resolve(root, generation);
    mkdirSync(generationRoot, { mode: 0o700 });
    const stateFile = "0123456789abcdef-binance-state.json";
    const statePath = resolve(generationRoot, stateFile);
    const receiptPath = resolve(root, ".production-self-test-permit-legacy-migration.json");
    const stateBefore = stateBytes();
    writeSecure(statePath, stateBefore, 0o600);
    const fixture = {
      root,
      statePath,
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
