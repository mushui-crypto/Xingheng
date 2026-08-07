import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { preparePermitInstallation } from "./productionSelfTestPermitInstall.mjs";
import {
  assertCompletedPermitRecovery,
  recoverHistoricalFailedPermitReceipt,
} from "./productionSelfTestPermitRecovery.mjs";

const LEGACY_OPERATION = "a".repeat(32);
const RECOVERY_OPERATION = "b".repeat(32);
const SECOND_LEGACY_OPERATION = "d".repeat(32);
const SECOND_RECOVERY_OPERATION = "e".repeat(32);
const OWNER = "USR-RECOVERY1";
const REVISION = "c".repeat(40);
const ACTIVATED_AT = new Date("2026-08-06T01:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-06T02:00:00.000Z");

test("failed schema v1 receipt is archived without changing its file identity", () => {
  withFixture((fixture) => {
    const source = lstatSync(fixture.receiptPath);
    const result = recoverHistoricalFailedPermitReceipt(fixture.options());
    assert.equal(result.operationId, RECOVERY_OPERATION);
    assert.equal(result.sourceReceiptSha256, fixture.receiptSha256);
    assert.equal(assertCompletedPermitRecovery(fixture.options()), true);
    assert.equal(exists(fixture.receiptPath), false);
    assert.deepEqual(readDir(fixture.attemptsRoot), []);

    const archived = resolve(
      fixture.recoveryRoot,
      "operations",
      RECOVERY_OPERATION,
      "legacy-receipt.json",
    );
    const archivedStat = lstatSync(archived);
    assert.equal(archivedStat.dev, source.dev);
    assert.equal(archivedStat.ino, source.ino);
    assert.equal(sha256(readFileSync(archived)), fixture.receiptSha256);
    assert.deepEqual(readDir(resolve(fixture.recoveryRoot, "operations", RECOVERY_OPERATION)), [
      "journal.json",
      "legacy-attempt",
      "legacy-receipt.json",
      "terminal-receipt.json",
    ]);
  });
});

test("failed schema v2 receipt and attempt are archived with their original identities", () => {
  withFixture((fixture) => {
    const sourceReceipt = lstatSync(fixture.receiptPath);
    const sourceAttempt = lstatSync(resolve(fixture.attemptsRoot, LEGACY_OPERATION));
    const sourceAttemptReceiptSha256 = sha256(readFileSync(resolve(
      fixture.attemptsRoot,
      LEGACY_OPERATION,
      "attempt-receipt.json",
    )));

    const result = recoverHistoricalFailedPermitReceipt(fixture.options());
    assert.equal(result.sourceReceiptSha256, fixture.receiptSha256);
    assert.equal(assertCompletedPermitRecovery(fixture.options()), true);

    const operationRoot = resolve(fixture.recoveryRoot, "operations", RECOVERY_OPERATION);
    const archivedReceipt = resolve(operationRoot, "legacy-receipt.json");
    const archivedAttempt = resolve(operationRoot, "legacy-attempt");
    assert.equal(lstatSync(archivedReceipt).ino, sourceReceipt.ino);
    assert.equal(lstatSync(archivedAttempt).ino, sourceAttempt.ino);
    assert.equal(sha256(readFileSync(archivedReceipt)), fixture.receiptSha256);
    assert.equal(
      sha256(readFileSync(resolve(archivedAttempt, "attempt-receipt.json"))),
      sourceAttemptReceiptSha256,
    );
    assert.deepEqual(readDir(fixture.stateRoot), ["attempts", "recovery"]);
  }, { schemaVersion: 2 });
});

test("schema v2 recovery rejects invalid terminal, mode, digest, and runtime identity", () => {
  const cases = [
    [(receipt) => { receipt.status = "success"; }, /exact failed terminal/u],
    [(receipt) => { receipt.request.schemaVersion = 1; }, /exact failed terminal/u],
    [(receipt) => { receipt.request.executionMode = "single_funding_rate_arbitrage_round"; }, /exact failed terminal/u],
    [(receipt) => { receipt.permit.digest = "0".repeat(64); }, /digest is invalid/u],
    [(receipt) => { receipt.runtimeBefore.api.revision = "9".repeat(40); }, /runtime identity does not match/u],
    [(receipt) => { receipt.receiptType = "failed"; }, /receipt is invalid/u],
  ];
  for (const [mutation, expected] of cases) {
    withFixture((fixture) => {
      fixture.rewriteReceipt(mutation);
      assert.throws(
        () => recoverHistoricalFailedPermitReceipt(fixture.options()),
        expected,
      );
      assert.equal(exists(fixture.recoveryRoot), false);
    }, { schemaVersion: 2, runtimeBefore: true });
  }
});

test("schema v2 recovery binds the exact source receipt SHA256", () => {
  withFixture((fixture) => {
    assert.throws(
      () => recoverHistoricalFailedPermitReceipt(fixture.options({
        expectedReceiptSha256: "f".repeat(64),
      })),
      /source receipt SHA256 mismatch/u,
    );
    assert.equal(exists(fixture.recoveryRoot), false);
  }, { schemaVersion: 2 });
});

test("schema v2 recovery rejects mismatched attempt content", () => {
  withFixture((fixture) => {
    fixture.rewriteAttempt((attempt) => { attempt.schemaVersion = 1; });
    assert.throws(
      () => recoverHistoricalFailedPermitReceipt(fixture.options()),
      /attempt receipt does not match terminal receipt/u,
    );
    assert.equal(exists(fixture.recoveryRoot), false);
  }, { schemaVersion: 2 });
});

test("unsupported recovery receipt schema fails closed before creating recovery state", () => {
  withFixture((fixture) => {
    fixture.rewriteReceipt((receipt) => { receipt.schemaVersion = 3; });
    assert.throws(
      () => recoverHistoricalFailedPermitReceipt(fixture.options()),
      /receipt schema is unsupported/u,
    );
    assert.equal(exists(fixture.recoveryRoot), false);
  }, { schemaVersion: 2 });
});

test("completed recovery allows one new schema v2 installation attempt", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const current = preparePermitInstallation(fixture.v2InstallOptions());
    assert.equal(current.schemaVersion, 2);
    assert.equal(current.status, "prepared");
    assert.throws(() => preparePermitInstallation(fixture.v2InstallOptions()), /already been attempted/u);
  });
});

test("installer schema v2 output shape remains compatible with recovery schema v2", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const archived = JSON.parse(readFileSync(resolve(
      fixture.recoveryRoot,
      "operations",
      RECOVERY_OPERATION,
      "legacy-receipt.json",
    ), "utf8"));
    const installer = preparePermitInstallation(fixture.v2InstallOptions());

    assert.equal(installer.schemaVersion, 2);
    assert.equal(archived.schemaVersion, 2);
    assert.deepEqual(sortedKeys(installer), sortedKeys(archived));
    assert.deepEqual(sortedKeys(installer.request), sortedKeys(archived.request));
    assert.deepEqual(sortedKeys(installer.permit), sortedKeys(archived.permit));
    assert.deepEqual(sortedKeys(installer.releaseIdentity), sortedKeys(archived.releaseIdentity));
    assert.equal(installer.request.executionMode, archived.request.executionMode);
    assert.equal(installer.permit.executionMode, archived.permit.executionMode);
  }, { schemaVersion: 2 });
});

for (const hook of [
  "afterJournalPrepared",
  "afterReceiptArchived",
  "afterAttemptArchived",
  "afterTerminalWritten",
]) {
  test(`recovery resumes after ${hook} interruption`, () => {
    withFixture((fixture) => {
      assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options({
        hooks: { [hook]: () => { throw new Error(`injected ${hook}`); } },
      })), new RegExp(`injected ${hook}`, "u"));
      const result = recoverHistoricalFailedPermitReceipt(fixture.options());
      assert.equal(result.operationId, RECOVERY_OPERATION);
      assert.equal(assertCompletedPermitRecovery(fixture.options()), true);
    });
  });
}

test("completed recovery is archived before a unique new recovery starts", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const oldOperation = resolve(fixture.recoveryRoot, "operations", RECOVERY_OPERATION);
    const oldEvidenceSha256 = operationEvidenceSha256(oldOperation);
    const second = fixture.stageSecondFailedReceipt();
    const result = recoverHistoricalFailedPermitReceipt(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
    }));

    assert.equal(result.operationId, SECOND_RECOVERY_OPERATION);
    const archived = resolve(fixture.recoveryRoot, "completed", RECOVERY_OPERATION);
    assert.deepEqual(operationEvidenceSha256(archived), oldEvidenceSha256);
    assert.deepEqual(readDir(resolve(fixture.recoveryRoot, "operations")), [SECOND_RECOVERY_OPERATION]);
    assert.equal(assertCompletedPermitRecovery(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
    })), true);
  }, { schemaVersion: 2 });
});

test("completed recovery archive is crash-resumable", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const second = fixture.stageSecondFailedReceipt();
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
      hooks: { afterCompletedOperationArchived: () => { throw new Error("stop after completed archive"); } },
    })), /stop after completed archive/u);
    assert.equal(recoverHistoricalFailedPermitReceipt(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
    })).operationId, SECOND_RECOVERY_OPERATION);
  }, { schemaVersion: 2 });
});

test("completed recovery terminal guard rejects replay of the same operation", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    assert.throws(
      () => recoverHistoricalFailedPermitReceipt(fixture.options()),
      /already completed/u,
    );
  });
});

test("active recovery operation still blocks a different operation", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const second = fixture.stageSecondFailedReceipt();
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
      hooks: { afterJournalPrepared: () => { throw new Error("stop"); } },
    })), /stop/u);
    assert.throws(
      () => recoverHistoricalFailedPermitReceipt(fixture.options({
        operationId: "f".repeat(32),
        expectedReceiptSha256: second.receiptSha256,
      })),
      /different Permit recovery operation/u,
    );
  }, { schemaVersion: 2 });
});

test("tampered completed recovery evidence blocks archival and new recovery", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const terminalPath = resolve(
      fixture.recoveryRoot,
      "operations",
      RECOVERY_OPERATION,
      "terminal-receipt.json",
    );
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    terminal.completedAt = "2026-08-06T02:00:01.000Z";
    chmodSync(terminalPath, 0o600);
    writeSecure(terminalPath, jsonBytes(terminal), 0o400);
    const second = fixture.stageSecondFailedReceipt();
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
    })), /terminal (?:receipt|identity) (?:is invalid|mismatch)/u);
    assert.equal(exists(resolve(fixture.recoveryRoot, "completed")), false);
    assert.equal(exists(fixture.receiptPath), true);
  }, { schemaVersion: 2 });
});

test("tampered archived recovery evidence blocks the current completed recovery", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const second = fixture.stageSecondFailedReceipt();
    recoverHistoricalFailedPermitReceipt(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
    }));
    const archivedTerminalPath = resolve(
      fixture.recoveryRoot,
      "completed",
      RECOVERY_OPERATION,
      "terminal-receipt.json",
    );
    const terminal = JSON.parse(readFileSync(archivedTerminalPath, "utf8"));
    terminal.completedAt = "2026-08-06T02:00:01.000Z";
    chmodSync(archivedTerminalPath, 0o600);
    writeSecure(archivedTerminalPath, jsonBytes(terminal), 0o400);
    assert.throws(() => assertCompletedPermitRecovery(fixture.options({
      operationId: SECOND_RECOVERY_OPERATION,
      expectedReceiptSha256: second.receiptSha256,
    })), /terminal (?:receipt|identity) (?:is invalid|mismatch)/u);
  }, { schemaVersion: 2 });
});

test("success, unsupported schema, malformed, and closed-state violations are rejected", () => {
  for (const mutation of [
    (receipt) => { receipt.status = "success"; },
    (receipt) => { receipt.schemaVersion = 3; },
    (receipt) => { receipt.unknown = true; },
  ]) {
    withFixture((fixture) => {
      fixture.rewriteReceipt(mutation);
      assert.throws(
        () => recoverHistoricalFailedPermitReceipt(fixture.options({
          expectedReceiptSha256: sha256(readFileSync(fixture.receiptPath)),
        })),
        /(?:Legacy Permit|receipt schema is unsupported)/u,
      );
      assert.equal(exists(fixture.recoveryRoot), false);
    });
  }
  withFixture((fixture) => {
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options({
      closedState: { ...fixture.closedState, runtimePermitAbsent: false },
    })), /closed state/u);
    assert.equal(exists(fixture.recoveryRoot), false);
  });
});

test("partial attempt state and incomplete recovery journals block progress", () => {
  withFixture((fixture) => {
    rmSync(resolve(fixture.attemptsRoot, LEGACY_OPERATION, "environment.proposed"));
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options()), /attempt directory is incomplete/u);
  });
  withFixture((fixture) => {
    mkdirSync(resolve(fixture.attemptsRoot, "f".repeat(32)), { mode: 0o700 });
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options()), /attempt set is invalid/u);
    assert.equal(exists(fixture.receiptPath), true);
    assert.equal(exists(fixture.recoveryRoot), false);
  });
  withFixture((fixture) => {
    assert.throws(() => recoverHistoricalFailedPermitReceipt(fixture.options({
      hooks: { afterJournalPrepared: () => { throw new Error("stop"); } },
    })), /stop/u);
    assert.throws(() => assertCompletedPermitRecovery(fixture.options()), /journal is incomplete/u);
    assert.throws(() => preparePermitInstallation(fixture.v2InstallOptions()), /Permit recovery|Permit install (?:receipt|request)/u);
  });
});

test("empty initialization directories and partial journal temp files are crash-resumable", () => {
  withFixture((fixture) => {
    mkdirSync(fixture.recoveryRoot, { mode: 0o700 });
    assert.equal(recoverHistoricalFailedPermitReceipt(fixture.options()).operationId, RECOVERY_OPERATION);
  });
  withFixture((fixture) => {
    const operations = resolve(fixture.recoveryRoot, "operations");
    const operation = resolve(operations, RECOVERY_OPERATION);
    mkdirSync(fixture.recoveryRoot, { mode: 0o700 });
    mkdirSync(operations, { mode: 0o700 });
    mkdirSync(operation, { mode: 0o700 });
    writeSecure(resolve(operation, "journal.json.123.0123456789abcdef.tmp"), Buffer.alloc(0), 0o400);
    assert.equal(recoverHistoricalFailedPermitReceipt(fixture.options()).operationId, RECOVERY_OPERATION);
    assert.equal(assertCompletedPermitRecovery(fixture.options()), true);
  });
});

test("tampered terminal recovery evidence keeps the installer blocked", () => {
  withFixture((fixture) => {
    recoverHistoricalFailedPermitReceipt(fixture.options());
    const terminalPath = resolve(
      fixture.recoveryRoot,
      "operations",
      RECOVERY_OPERATION,
      "terminal-receipt.json",
    );
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    terminal.completedAt = "2026-08-06T02:00:01.000Z";
    chmodSync(terminalPath, 0o600);
    writeSecure(terminalPath, jsonBytes(terminal), 0o400);
    assert.throws(() => assertCompletedPermitRecovery(fixture.options()), /terminal (?:receipt|identity) (?:is invalid|mismatch)/u);
    assert.throws(() => preparePermitInstallation(fixture.v2InstallOptions()), /terminal (?:receipt|identity) (?:is invalid|mismatch)/u);
  });
});

test("direct recovery entry is rejected before touching state", () => {
  const result = spawnSync(process.execPath, [
    new URL("./productionSelfTestPermitRecovery.mjs", import.meta.url).pathname,
    "run",
    RECOVERY_OPERATION,
    "e".repeat(64),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /controlled Linux root|trusted wrapper context/u);
});

test("recovery wrapper preserves caller arguments across release manifest loading", () => {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-permit-recovery-wrapper-"));
  try {
    const scripts = resolve(root, "scripts");
    const bin = resolve(root, "bin");
    mkdirSync(scripts);
    mkdirSync(bin);
    cpSync(
      new URL("./recover-production-self-test-permit.sh", import.meta.url),
      resolve(scripts, "recover-production-self-test-permit.sh"),
    );
    cpSync(
      new URL("./load-release-manifest.sh", import.meta.url),
      resolve(scripts, "load-release-manifest.sh"),
    );
    writeExecutable(resolve(scripts, "trusted-operation-preamble.sh"), "#!/bin/sh\n");
    const generatedOperation = "9".repeat(32);
    writeExecutable(resolve(bin, "node"), `#!/bin/sh
case "$1:$2" in
  scripts/verify-deployment-revision.mjs:manifest-values)
    printf '${REVISION}\\nsha256:%064d\\nsha256:%064d\\nsha256:%064d\\n' 1 2 3
    ;;
  scripts/verify-deployment-revision.mjs:*) ;;
  -e:*) printf '${generatedOperation}' ;;
  scripts/productionSelfTestPermitRecovery.mjs:run)
    printf 'RECOVERY_CALL=%s|%s\\n' "$3" "$4"
    ;;
  *) exit 1 ;;
esac
`);
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const receiptSha256 = "8".repeat(64);
    for (const [arguments_, expectedOperation] of [
      [[receiptSha256], generatedOperation],
      [[receiptSha256, RECOVERY_OPERATION], RECOVERY_OPERATION],
    ]) {
      const result = spawnSync("sh", [
        "scripts/recover-production-self-test-permit.sh",
        ...arguments_,
      ], { cwd: root, env: environment, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        new RegExp(`RECOVERY_CALL=${expectedOperation}\\|${receiptSha256}`, "u"),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function withFixture(run, { schemaVersion = 1, runtimeBefore = false } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-permit-recovery-"));
  try {
    const stateRoot = resolve(root, "state");
    const receiptPath = resolve(stateRoot, "install.json");
    const attemptsRoot = resolve(stateRoot, "attempts");
    const attemptRoot = resolve(attemptsRoot, LEGACY_OPERATION);
    const recoveryRoot = resolve(stateRoot, "recovery");
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(attemptsRoot, { mode: 0o700 });
    mkdirSync(attemptRoot, { mode: 0o700 });

    const environmentBefore = Buffer.from(`NODE_ENV=production\nRWA_AUTOMATION_SERVER_KILL_SWITCH=true\n`);
    const environmentProposed = Buffer.from(`${environmentBefore.toString("utf8")}RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED=true\n`);
    writeSecure(resolve(attemptRoot, "environment.before"), environmentBefore, 0o600);
    writeSecure(resolve(attemptRoot, "environment.proposed"), environmentProposed, 0o600);

    const request = schemaVersion === 1 ? legacyRequest() : currentRequest();
    const receipt = failedReceipt(request, environmentBefore, environmentProposed, runtimeBefore);
    const attempt = { ...receipt };
    delete attempt.attemptReceiptSha256;
    attempt.status = "prepared";
    attempt.runtimeBefore = null;
    attempt.runtimeAfter = null;
    attempt.updatedAt = receipt.activatedAt;
    const attemptBytes = jsonBytes(attempt);
    writeSecure(resolve(attemptRoot, "attempt-receipt.json"), attemptBytes, 0o400);
    receipt.attemptReceiptSha256 = sha256(attemptBytes);
    const receiptBytes = jsonBytes(receipt);
    writeSecure(receiptPath, receiptBytes, 0o400);

    const closedState = {
      serverKillSwitchOn: true,
      hostPermitAbsent: true,
      runtimePermitAbsent: true,
      windowClosed: true,
      releaseRevision: "f".repeat(40),
      releaseTreeSha256: "1".repeat(64),
      releaseManifestSha256: "2".repeat(64),
      apiImageDigest: `sha256:${"3".repeat(64)}`,
      lifecycleOperationId: "12345678-1234-4123-8123-123456789abc",
    };

    const fixture = {
      root,
      stateRoot,
      receiptPath,
      attemptsRoot,
      recoveryRoot,
      receiptSha256: sha256(receiptBytes),
      closedState,
      options(overrides = {}) {
        return {
          operationId: RECOVERY_OPERATION,
          expectedReceiptSha256: overrides.expectedReceiptSha256
            ?? sha256(readFileSync(receiptPathIfPresent(receiptPath, recoveryRoot))),
          receiptPath,
          attemptsRoot,
          recoveryRoot,
          closedState,
          now: COMPLETED_AT,
          testMode: true,
          ...overrides,
        };
      },
      rewriteReceipt(mutation) {
        const value = JSON.parse(readFileSync(receiptPath, "utf8"));
        mutation(value);
        chmodSync(receiptPath, 0o600);
        writeSecure(receiptPath, jsonBytes(value), 0o400);
      },
      rewriteAttempt(mutation) {
        const attemptPath = resolve(attemptRoot, "attempt-receipt.json");
        const value = JSON.parse(readFileSync(attemptPath, "utf8"));
        mutation(value);
        chmodSync(attemptPath, 0o600);
        const bytes = jsonBytes(value);
        writeSecure(attemptPath, bytes, 0o400);
        const terminal = JSON.parse(readFileSync(receiptPath, "utf8"));
        terminal.attemptReceiptSha256 = sha256(bytes);
        chmodSync(receiptPath, 0o600);
        writeSecure(receiptPath, jsonBytes(terminal), 0o400);
      },
      stageSecondFailedReceipt() {
        const secondAttemptRoot = resolve(attemptsRoot, SECOND_LEGACY_OPERATION);
        mkdirSync(secondAttemptRoot, { mode: 0o700 });
        const before = Buffer.from("NODE_ENV=production\nRWA_AUTOMATION_SERVER_KILL_SWITCH=true\n");
        const proposed = Buffer.from(`${before.toString("utf8")}RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED=true\n`);
        writeSecure(resolve(secondAttemptRoot, "environment.before"), before, 0o600);
        writeSecure(resolve(secondAttemptRoot, "environment.proposed"), proposed, 0o600);
        const secondReceipt = failedReceipt(
          currentRequest(),
          before,
          proposed,
          false,
          SECOND_LEGACY_OPERATION,
        );
        const secondAttempt = { ...secondReceipt };
        delete secondAttempt.attemptReceiptSha256;
        secondAttempt.status = "prepared";
        secondAttempt.runtimeBefore = null;
        secondAttempt.runtimeAfter = null;
        secondAttempt.updatedAt = secondReceipt.activatedAt;
        const secondAttemptBytes = jsonBytes(secondAttempt);
        writeSecure(resolve(secondAttemptRoot, "attempt-receipt.json"), secondAttemptBytes, 0o400);
        secondReceipt.attemptReceiptSha256 = sha256(secondAttemptBytes);
        const secondReceiptBytes = jsonBytes(secondReceipt);
        writeSecure(receiptPath, secondReceiptBytes, 0o400);
        return { receiptSha256: sha256(secondReceiptBytes) };
      },
      v2InstallOptions() {
        const releaseManifestPath = resolve(root, "release-manifest.json");
        const authorizationManifestPath = resolve(root, "authorization.json");
        const environmentPath = resolve(root, ".env.production");
        const releaseManifestBytes = jsonBytes({
          schemaVersion: 1,
          revision: REVISION,
          images: {
            api: `sha256:${"4".repeat(64)}`,
            web: `sha256:${"5".repeat(64)}`,
            strategyTools: `sha256:${"6".repeat(64)}`,
          },
        });
        writeSecureIfAbsent(releaseManifestPath, releaseManifestBytes, 0o444);
        writeSecureIfAbsent(environmentPath, Buffer.from("NODE_ENV=production\n"), 0o600);
        const authorization = {
          schemaVersion: 2,
          permitId: "7".repeat(32),
          ownerUserId: OWNER,
          accountBindingSha256: "8".repeat(64),
          actionScope: ["READ", "TRADE"],
          approvedCapitalUsd: 40,
          leverage: 1,
          executionMode: "single_connectivity_smoke",
          maximumDurationMinutes: 60,
          maximumExecutionDurationMinutes: 30,
          releaseRevision: REVISION,
          gitTreeSha: "9".repeat(40),
          releaseTreeSha256: "a".repeat(64),
          releaseManifestSha256: sha256(releaseManifestBytes),
          apiImageDigest: `sha256:${"4".repeat(64)}`,
          webImageDigest: `sha256:${"5".repeat(64)}`,
        };
        const authorizationBytes = jsonBytes(authorization);
        writeSecureIfAbsent(authorizationManifestPath, authorizationBytes, 0o400);
        const request = { ...authorization, authorizationManifestSha256: sha256(authorizationBytes) };
        return {
          request,
          receiptPath,
          attemptsRoot,
          recoveryRoot,
          authorizationManifestPath,
          environmentPath,
          releaseManifestPath,
          releaseIdentity: {
            releaseRevision: REVISION,
            gitTreeSha: request.gitTreeSha,
            releaseTreeSha256: request.releaseTreeSha256,
            releaseManifestSha256: request.releaseManifestSha256,
            apiImageDigest: request.apiImageDigest,
            webImageDigest: request.webImageDigest,
            lifecycleEstablishedAt: ACTIVATED_AT.toISOString(),
            lifecycleOperationId: closedState.lifecycleOperationId,
          },
          now: ACTIVATED_AT,
          testMode: true,
        };
      },
    };
    run(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function legacyRequest() {
  return {
    schemaVersion: 1,
    permitId: "d".repeat(32),
    ownerUserId: OWNER,
    accountBindingSha256: "e".repeat(64),
    actionScope: ["READ", "TRADE"],
    approvedCapitalUsd: 40,
    leverage: 1,
    executionMode: "single_funding_rate_arbitrage_round",
    maximumDurationMinutes: 60,
    maximumExecutionDurationMinutes: 30,
    releaseRevision: REVISION,
    gitTreeSha: "1".repeat(40),
    releaseTreeSha256: "2".repeat(64),
    releaseManifestSha256: "3".repeat(64),
    apiImageDigest: `sha256:${"4".repeat(64)}`,
    webImageDigest: `sha256:${"5".repeat(64)}`,
    authorizationManifestSha256: "6".repeat(64),
  };
}

function currentRequest() {
  return {
    ...legacyRequest(),
    schemaVersion: 2,
    executionMode: "single_connectivity_smoke",
  };
}

function failedReceipt(
  request,
  before,
  proposed,
  withRuntimeBefore = false,
  operationId = LEGACY_OPERATION,
) {
  const expiresAt = new Date(ACTIVATED_AT.getTime() + 60 * 60_000).toISOString();
  const permit = {
    permitId: request.permitId,
    ownerUserId: request.ownerUserId,
    accountBindingSha256: request.accountBindingSha256,
    actionScope: ["READ", "TRADE"],
    authorizationDigest: request.authorizationManifestSha256,
    approvedCapitalUsd: 40,
    expiresAt,
    revision: request.releaseRevision,
  };
  if (request.schemaVersion === 2) permit.executionMode = request.executionMode;
  permit.digest = request.schemaVersion === 1 ? legacyDigest(permit) : currentDigest(permit);
  return {
    schemaVersion: request.schemaVersion,
    operationId,
    status: "failed",
    request,
    permit,
    releaseIdentity: {
      releaseRevision: request.releaseRevision,
      gitTreeSha: request.gitTreeSha,
      releaseTreeSha256: request.releaseTreeSha256,
      releaseManifestSha256: request.releaseManifestSha256,
      apiImageDigest: request.apiImageDigest,
      webImageDigest: request.webImageDigest,
      lifecycleEstablishedAt: ACTIVATED_AT.toISOString(),
      lifecycleOperationId: "12345678-1234-4123-8123-123456789abc",
    },
    runtimeBefore: withRuntimeBefore ? runtimeSnapshot(request) : null,
    runtimeAfter: null,
    activatedAt: ACTIVATED_AT.toISOString(),
    expiresAt,
    envBeforeSha256: sha256(before),
    envAfterSha256: sha256(proposed),
    updatedAt: COMPLETED_AT.toISOString(),
    attemptReceiptSha256: "0".repeat(64),
  };
}

function legacyDigest(input) {
  return sha256(Buffer.from([
    "production", "binance", "xaut", input.permitId, input.ownerUserId,
    input.accountBindingSha256, "READ", "TRADE", input.authorizationDigest,
    String(input.approvedCapitalUsd), input.revision, input.expiresAt,
  ].join(":")));
}

function currentDigest(input) {
  return sha256(Buffer.from([
    "production", "binance", "xaut", input.permitId, input.ownerUserId,
    input.accountBindingSha256, "READ", "TRADE", input.executionMode, input.authorizationDigest,
    String(input.approvedCapitalUsd), input.revision, input.expiresAt,
  ].join(":")));
}

function runtimeSnapshot(request) {
  return {
    capturedAt: ACTIVATED_AT.toISOString(),
    api: {
      containerId: "a".repeat(64),
      imageDigest: request.apiImageDigest,
      revision: request.releaseRevision,
      startedAt: ACTIVATED_AT.toISOString(),
      running: true,
      health: "healthy",
    },
    web: {
      containerId: "b".repeat(64),
      imageDigest: request.webImageDigest,
      revision: request.releaseRevision,
      startedAt: ACTIVATED_AT.toISOString(),
      running: true,
      health: "healthy",
    },
  };
}

function receiptPathIfPresent(receiptPath, recoveryRoot) {
  if (exists(receiptPath)) return receiptPath;
  return resolve(recoveryRoot, "operations", RECOVERY_OPERATION, "legacy-receipt.json");
}

function writeSecure(path, bytes, mode) {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function writeSecureIfAbsent(path, bytes, mode) {
  if (!exists(path)) writeSecure(path, bytes, mode);
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function readDir(path) { return exists(path) ? readdirSync(path).sort() : []; }
function operationEvidenceSha256(root) {
  return Object.fromEntries([
    "journal.json",
    "legacy-receipt.json",
    "terminal-receipt.json",
    "legacy-attempt/attempt-receipt.json",
    "legacy-attempt/environment.before",
    "legacy-attempt/environment.proposed",
  ].map((path) => [path, sha256(readFileSync(resolve(root, path)))]));
}
function sortedKeys(value) { return Object.keys(value).sort(); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
