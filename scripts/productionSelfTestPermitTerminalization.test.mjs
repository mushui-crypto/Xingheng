import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { terminalizeExpiredSuccessfulPermit } from "./productionSelfTestPermitTerminalization.mjs";

const INSTALL_OPERATION = "a".repeat(32);
const TERMINAL_OPERATION = "b".repeat(32);
const REVISION = "c".repeat(40);
const OWNER = "USR-TERMINAL1";
const ACTIVATED_AT = new Date("2026-08-06T01:00:00.000Z");
const EXPIRED_AT = new Date("2026-08-06T02:00:00.000Z");
const NOW = new Date("2026-08-06T03:00:00.000Z");
const PROMOTION_OPERATION = "12345678-1234-4123-8123-123456789abc";

test("expired successful Permit terminalizes without changing source evidence", () => {
  withFixture((fixture) => {
    const receiptBefore = identity(fixture.receiptPath);
    const attemptBefore = evidenceIdentity(fixture.attemptRoot);
    const result = terminalizeExpiredSuccessfulPermit(fixture.options());

    assert.equal(result.operationId, TERMINAL_OPERATION);
    assert.match(result.terminalReceiptSha256, /^[a-f0-9]{64}$/u);
    assert.equal(sha256(readFileSync(fixture.environmentPath)), fixture.envBeforeSha256);
    assert.deepEqual(identity(fixture.receiptPath), receiptBefore);
    assert.deepEqual(evidenceIdentity(fixture.attemptRoot), attemptBefore);
    assert.equal(fixture.restartCount(), 1);
    assert.deepEqual(readdirSync(resolve(fixture.terminalRoot, TERMINAL_OPERATION)).sort(), [
      "api-restarted.json",
      "environment-restored.json",
      "prepared.json",
      "terminal-receipt.json",
    ]);
    const terminal = JSON.parse(readFileSync(resolve(
      fixture.terminalRoot,
      TERMINAL_OPERATION,
      "terminal-receipt.json",
    ), "utf8"));
    assert.equal(terminal.state, "completed");
    assert.equal(terminal.promotionBaselineVerified, true);
    assert.equal(terminal.promotionOperationId, PROMOTION_OPERATION);
  });
});

test("terminal journal files and directories use the controlled owner and modes", () => {
  withFixture((fixture) => {
    terminalizeExpiredSuccessfulPermit(fixture.options());
    const expectedUid = process.getuid?.() ?? -1;
    const expectedGid = process.getgid?.() ?? -1;
    for (const path of [fixture.terminalRoot, resolve(fixture.terminalRoot, TERMINAL_OPERATION)]) {
      const value = lstatSync(path);
      assert.equal(value.uid, expectedUid);
      assert.equal(value.gid, expectedGid);
      assert.equal(value.mode & 0o777, 0o700);
    }
    for (const name of [
      "prepared.json", "environment-restored.json", "api-restarted.json", "terminal-receipt.json",
    ]) {
      const value = lstatSync(resolve(fixture.terminalRoot, TERMINAL_OPERATION, name));
      assert.equal(value.uid, expectedUid);
      assert.equal(value.gid, expectedGid);
      assert.equal(value.mode & 0o777, 0o400);
      assert.equal(value.nlink, 1);
    }
  });
});

test("terminalization rejects non-success, unsupported mode, unexpired, and SHA mismatch", () => {
  const cases = [
    [(fixture) => fixture.rewriteReceipt((value) => { value.status = "failed"; }), /receipt|snapshot/u],
    [(fixture) => fixture.rewriteReceipt((value) => {
      value.request.executionMode = "single_funding_rate_arbitrage_round";
    }), /request|receipt/u],
    [(fixture) => { fixture.now = new Date(EXPIRED_AT.getTime() - 1); }, /has not expired/u],
    [(fixture) => { fixture.expectedReceiptSha256 = "f".repeat(64); }, /source SHA256 mismatch/u],
  ];
  for (const [mutate, expected] of cases) {
    withFixture((fixture) => {
      mutate(fixture);
      assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options()), expected);
      assert.equal(exists(fixture.terminalRoot), false);
      assert.equal(sha256(readFileSync(fixture.environmentPath)), fixture.envAfterSha256);
      assert.equal(fixture.restartCount(), 0);
    });
  }
});

test("terminalization binds receipt, attempt, and exact environment transition identities", () => {
  const cases = [
    [(fixture) => fixture.rewriteReceipt((value) => { value.updatedAt = NOW.toISOString(); }, false), /source SHA256 mismatch/u],
    [(fixture) => fixture.rewriteAttempt((value) => { value.schemaVersion = 1; }), /attempt|receipt/u],
    [(fixture) => fixture.rewriteProposed(Buffer.from("NODE_ENV=production\nRWA_AUTOMATION_SERVER_KILL_SWITCH=true\nRWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED=true\nEXTRA=1\n")), /attempt identity|attempt receipt|transition/u],
    [(fixture) => fixture.replaceEnvironment(Buffer.from("NODE_ENV=production\nRWA_AUTOMATION_SERVER_KILL_SWITCH=true\nDRIFT=1\n")), /environment CAS mismatch/u],
  ];
  for (const [mutate, expected] of cases) {
    withFixture((fixture) => {
      mutate(fixture);
      assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options()), expected);
      assert.equal(exists(fixture.terminalRoot), false);
      assert.equal(fixture.restartCount(), 0);
    });
  }
});

test("environment target race is rejected before atomic replacement", () => {
  withFixture((fixture) => {
    const drift = Buffer.alloc(readFileSync(fixture.environmentPath).length, 0x58);
    assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options({
      hooks: {
        beforeEnvironmentTargetRevalidate: () => fixture.replaceEnvironment(drift),
      },
    })), /environment changed before atomic replacement/u);
    assert.notEqual(sha256(readFileSync(fixture.environmentPath)), fixture.envBeforeSha256);
    assert.equal(fixture.restartCount(), 0);
  });
});

test("terminalization rejects symlinked and hardlinked source receipt", () => {
  withFixture((fixture) => {
    const original = `${fixture.receiptPath}.original`;
    renameSync(fixture.receiptPath, original);
    symlinkSync(original, fixture.receiptPath);
    assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options()), /file boundary/u);
  });
  withFixture((fixture) => {
    linkSync(fixture.receiptPath, `${fixture.receiptPath}.hardlink`);
    assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options()), /file boundary/u);
  });
});

test("terminalization rejects Window evidence, unsafe state, and runtime identity drift", () => {
  withFixture((fixture) => {
    mkdirSync(fixture.windowRoot, { mode: 0o700 });
    writeSecure(resolve(fixture.windowRoot, "current.json"), Buffer.from("{}\n"), 0o444);
    chmodSync(fixture.windowRoot, 0o555);
    assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options()), /no Window receipt or lease/u);
  });
  for (const mutate of [
    (runtime) => { runtime.killSwitchOn = false; },
    (runtime) => { runtime.persistedStateSafe = false; },
    (runtime) => { runtime.imageDigest = `sha256:${"9".repeat(64)}`; },
    (runtime) => { runtime.permitEnvironment = {}; },
  ]) {
    withFixture((fixture) => {
      mutate(fixture.activeRuntime);
      assert.throws(
        () => terminalizeExpiredSuccessfulPermit(fixture.options()),
        /active runtime precondition/u,
      );
      assert.equal(sha256(readFileSync(fixture.environmentPath)), fixture.envAfterSha256);
    });
  }
});

for (const hook of [
  "afterPrepared",
  "afterEnvironmentRename",
  "afterEnvironmentRestored",
  "afterApiRestart",
  "afterApiRestartedRecorded",
]) {
  test(`terminalization resumes after ${hook} interruption`, () => {
    withFixture((fixture) => {
      assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options({
        hooks: { [hook]: () => { throw new Error(`injected ${hook}`); } },
      })), new RegExp(`injected ${hook}`, "u"));
      const result = terminalizeExpiredSuccessfulPermit(fixture.options());
      assert.equal(result.operationId, TERMINAL_OPERATION);
      assert.equal(sha256(readFileSync(fixture.environmentPath)), fixture.envBeforeSha256);
      assert.ok(fixture.restartCount() <= 1);
    });
  });
}

test("completed terminalization rejects replay and a competing operation", () => {
  withFixture((fixture) => {
    terminalizeExpiredSuccessfulPermit(fixture.options());
    assert.throws(
      () => terminalizeExpiredSuccessfulPermit(fixture.options()),
      /already completed/u,
    );
    assert.throws(
      () => terminalizeExpiredSuccessfulPermit(fixture.options({ operationId: "d".repeat(32) })),
      /operation set is invalid/u,
    );
  });
});

test("tampered terminal evidence fails closed", () => {
  withFixture((fixture) => {
    terminalizeExpiredSuccessfulPermit(fixture.options());
    const terminalPath = resolve(
      fixture.terminalRoot,
      TERMINAL_OPERATION,
      "terminal-receipt.json",
    );
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    terminal.promotionBaselineVerified = false;
    rewriteSecure(terminalPath, jsonBytes(terminal), 0o400);
    assert.throws(
      () => terminalizeExpiredSuccessfulPermit(fixture.options()),
      /terminal receipt is invalid/u,
    );
  });
});

test("promotion baseline failure leaves resumable evidence without a terminal receipt", () => {
  withFixture((fixture) => {
    assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options({
      verifyPromotionBaseline: () => { throw new Error("baseline rejected"); },
    })), /baseline rejected/u);
    const operationRoot = resolve(fixture.terminalRoot, TERMINAL_OPERATION);
    assert.deepEqual(readdirSync(operationRoot).sort(), [
      "api-restarted.json",
      "environment-restored.json",
      "prepared.json",
    ]);
    const result = terminalizeExpiredSuccessfulPermit(fixture.options());
    assert.equal(result.operationId, TERMINAL_OPERATION);
    assert.equal(fixture.restartCount(), 1);
  });
});

test("file and parent fsync failures are fail-closed and resumable", () => {
  for (const failure of ["fileFsync", "directoryFsync"]) {
    withFixture((fixture) => {
      let injected = false;
      assert.throws(() => terminalizeExpiredSuccessfulPermit(fixture.options({
        operations: {
          [failure]: (operation) => {
            operation();
            if (!injected) { injected = true; throw new Error(`injected ${failure}`); }
          },
        },
      })), new RegExp(`injected ${failure}`, "u"));
      const environmentSha = sha256(readFileSync(fixture.environmentPath));
      assert.ok([fixture.envBeforeSha256, fixture.envAfterSha256].includes(environmentSha));
      const result = terminalizeExpiredSuccessfulPermit(fixture.options());
      assert.equal(result.operationId, TERMINAL_OPERATION);
    });
  }
});

test("direct terminalization CLI is rejected before state access", () => {
  const result = spawnSync(process.execPath, [
    new URL("./productionSelfTestPermitTerminalization.mjs", import.meta.url).pathname,
    "terminalize-success",
    "a".repeat(64),
    "b".repeat(32),
  ], { encoding: "utf8", env: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /controlled Linux root|trusted wrapper context/u);
});

function withFixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-permit-terminalization-"));
  try {
    const stateRoot = resolve(root, "state");
    const receiptPath = resolve(stateRoot, "install.json");
    const attemptsRoot = resolve(stateRoot, "attempts");
    const attemptRoot = resolve(attemptsRoot, INSTALL_OPERATION);
    const terminalRoot = resolve(stateRoot, "terminalization");
    const environmentPath = resolve(root, ".env.production");
    const windowRoot = resolve(root, "window");
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(attemptsRoot, { mode: 0o700 });
    mkdirSync(attemptRoot, { mode: 0o700 });

    const before = Buffer.from("NODE_ENV=production\nRWA_AUTOMATION_SERVER_KILL_SWITCH=true\n");
    const request = installRequest();
    const permit = permitFor(request);
    const proposed = Buffer.from(`${before.toString("utf8")}${permitLines(permit)}\n`);
    const receipt = successReceipt(request, permit, before, proposed);
    const attempt = { ...receipt };
    delete attempt.attemptReceiptSha256;
    attempt.status = "prepared";
    attempt.runtimeBefore = null;
    attempt.runtimeAfter = null;
    attempt.updatedAt = receipt.activatedAt;
    const attemptBytes = jsonBytes(attempt);
    receipt.attemptReceiptSha256 = sha256(attemptBytes);
    const receiptBytes = jsonBytes(receipt);

    writeSecure(resolve(attemptRoot, "environment.before"), before, 0o600);
    writeSecure(resolve(attemptRoot, "environment.proposed"), proposed, 0o600);
    writeSecure(resolve(attemptRoot, "attempt-receipt.json"), attemptBytes, 0o400);
    writeSecure(receiptPath, receiptBytes, 0o400);
    writeSecure(environmentPath, proposed, 0o600);

    let runtime = runtimeEvidence(receipt, true);
    let restarts = 0;
    const fixture = {
      root,
      receiptPath,
      attemptsRoot,
      attemptRoot,
      terminalRoot,
      environmentPath,
      windowRoot,
      envBeforeSha256: sha256(before),
      envAfterSha256: sha256(proposed),
      expectedReceiptSha256: sha256(receiptBytes),
      now: NOW,
      activeRuntime: runtime,
      restartCount: () => restarts,
      options(overrides = {}) {
        return {
          operationId: overrides.operationId ?? TERMINAL_OPERATION,
          expectedReceiptSha256: fixture.expectedReceiptSha256,
          receiptPath,
          attemptsRoot,
          rootPath: terminalRoot,
          environmentPath,
          windowRoot,
          now: fixture.now,
          testMode: true,
          verifyActiveTransition: () => ({ state: "PROMOTION_COMPLETED" }),
          verifyPromotionBaseline: () => ({ operationId: PROMOTION_OPERATION }),
          captureRuntime: ({ activeTransition }) => activeTransition ? fixture.activeRuntime : runtime,
          restartApi: () => { restarts += 1; runtime = runtimeEvidence(receipt, false); },
          ...overrides,
        };
      },
      rewriteReceipt(mutation, updateExpected = true) {
        const value = JSON.parse(readFileSync(receiptPath, "utf8"));
        mutation(value);
        rewriteSecure(receiptPath, jsonBytes(value), 0o400);
        if (updateExpected) fixture.expectedReceiptSha256 = sha256(readFileSync(receiptPath));
      },
      rewriteAttempt(mutation) {
        const path = resolve(attemptRoot, "attempt-receipt.json");
        const value = JSON.parse(readFileSync(path, "utf8"));
        mutation(value);
        const bytes = jsonBytes(value);
        rewriteSecure(path, bytes, 0o400);
        const current = JSON.parse(readFileSync(receiptPath, "utf8"));
        current.attemptReceiptSha256 = sha256(bytes);
        rewriteSecure(receiptPath, jsonBytes(current), 0o400);
        fixture.expectedReceiptSha256 = sha256(readFileSync(receiptPath));
      },
      rewriteProposed(bytes) {
        rewriteSecure(resolve(attemptRoot, "environment.proposed"), bytes, 0o600);
        const current = JSON.parse(readFileSync(receiptPath, "utf8"));
        current.envAfterSha256 = sha256(bytes);
        rewriteSecure(receiptPath, jsonBytes(current), 0o400);
        fixture.expectedReceiptSha256 = sha256(readFileSync(receiptPath));
      },
      replaceEnvironment(bytes) { rewriteSecure(environmentPath, bytes, 0o600); },
    };
    run(fixture);
  } finally {
    try { chmodSync(resolve(root, "window"), 0o700); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

function installRequest() {
  return {
    schemaVersion: 2,
    permitId: "d".repeat(32),
    ownerUserId: OWNER,
    accountBindingSha256: "e".repeat(64),
    actionScope: ["READ", "TRADE"],
    approvedCapitalUsd: 40,
    leverage: 1,
    executionMode: "single_connectivity_smoke",
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

function permitFor(request) {
  const permit = {
    permitId: request.permitId,
    ownerUserId: request.ownerUserId,
    accountBindingSha256: request.accountBindingSha256,
    actionScope: ["READ", "TRADE"],
    executionMode: request.executionMode,
    authorizationDigest: request.authorizationManifestSha256,
    approvedCapitalUsd: 40,
    expiresAt: EXPIRED_AT.toISOString(),
    revision: request.releaseRevision,
  };
  permit.digest = sha256(Buffer.from([
    "production", "binance", "xaut", permit.permitId, permit.ownerUserId,
    permit.accountBindingSha256, "READ", "TRADE", permit.executionMode,
    permit.authorizationDigest, "40", permit.revision, permit.expiresAt,
  ].join(":")));
  return permit;
}

function successReceipt(request, permit, before, proposed) {
  return {
    schemaVersion: 2,
    operationId: INSTALL_OPERATION,
    status: "success",
    request,
    permit,
    releaseIdentity: {
      releaseRevision: REVISION,
      gitTreeSha: request.gitTreeSha,
      releaseTreeSha256: request.releaseTreeSha256,
      releaseManifestSha256: request.releaseManifestSha256,
      apiImageDigest: request.apiImageDigest,
      webImageDigest: request.webImageDigest,
      lifecycleEstablishedAt: ACTIVATED_AT.toISOString(),
      lifecycleOperationId: PROMOTION_OPERATION,
    },
    runtimeBefore: runtimeSnapshot(request, "7", "8"),
    runtimeAfter: runtimeSnapshot(request, "9", "8"),
    activatedAt: ACTIVATED_AT.toISOString(),
    expiresAt: EXPIRED_AT.toISOString(),
    envBeforeSha256: sha256(before),
    envAfterSha256: sha256(proposed),
    updatedAt: EXPIRED_AT.toISOString(),
    attemptReceiptSha256: "0".repeat(64),
  };
}

function runtimeSnapshot(request, api, web) {
  return {
    capturedAt: ACTIVATED_AT.toISOString(),
    api: component(request.apiImageDigest, api, request.releaseRevision),
    web: component(request.webImageDigest, web, request.releaseRevision),
  };
}

function component(imageDigest, id, revision) {
  return {
    containerId: id.repeat(64),
    imageDigest,
    revision,
    startedAt: ACTIVATED_AT.toISOString(),
    running: true,
    health: "healthy",
  };
}

function runtimeEvidence(receipt, active) {
  return {
    containerId: (active ? "9" : "f").repeat(64),
    expectedOriginalContainer: "9".repeat(64),
    imageDigest: receipt.releaseIdentity.apiImageDigest,
    revision: receipt.releaseIdentity.releaseRevision,
    running: true,
    health: "healthy",
    killSwitchOn: true,
    permitEnvironment: active ? Object.fromEntries(permitEntries(receipt.permit)) : {},
    persistedStateSafe: true,
  };
}

function permitLines(permit) {
  return permitEntries(permit).map(([key, value]) => `${key}=${value}`).join("\n");
}

function permitEntries(permit) {
  return [
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED", "true"],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID", permit.permitId],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID", permit.ownerUserId],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256", permit.accountBindingSha256],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE", '["READ","TRADE"]'],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE", permit.executionMode],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST", permit.authorizationDigest],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_DIGEST", permit.digest],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD", "40"],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT", permit.expiresAt],
  ];
}

function evidenceIdentity(root) {
  return Object.fromEntries([
    "attempt-receipt.json", "environment.before", "environment.proposed",
  ].map((name) => [name, identity(resolve(root, name))]));
}

function identity(path) {
  const value = lstatSync(path);
  return { dev: value.dev, ino: value.ino, size: value.size, mode: value.mode & 0o777 };
}

function writeSecure(path, bytes, mode) {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function rewriteSecure(path, bytes, mode) {
  chmodSync(path, 0o600);
  writeFileSync(path, bytes);
  chmodSync(path, mode);
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
