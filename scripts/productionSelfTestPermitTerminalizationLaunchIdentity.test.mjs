import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assertPermitTerminalizationLaunchIdentity } from "./productionSelfTestPermitTerminalizationLaunchIdentity.mjs";

const OPERATION = "a".repeat(32);
const SOURCE = "b".repeat(64);

test("first terminalization launch requires the active Permit transition", () => {
  const result = assertPermitTerminalizationLaunchIdentity(
    { operationId: OPERATION, sourceReceiptSha256: SOURCE },
    {
      rootPath: "/does-not-exist",
      testMode: true,
      verifyActiveTransition: () => ({ state: "PROMOTION_COMPLETED" }),
      verifyPromotionBaseline: () => { throw new Error("baseline must not be used"); },
    },
  );
  assert.equal(result.state, "permit_active");
  assert.equal(result.prepared, false);
});

test("restored baseline launch requires an exact incomplete journal", () => {
  withJournal((root) => {
    const result = assertPermitTerminalizationLaunchIdentity(
      { operationId: OPERATION, sourceReceiptSha256: SOURCE },
      options(root, {
        verifyActiveTransition: () => { throw new Error("not active"); },
        verifyPromotionBaseline: () => ({ state: "PROMOTION_COMPLETED" }),
      }),
    );
    assert.equal(result.state, "baseline_restored");

    assert.throws(() => assertPermitTerminalizationLaunchIdentity(
      { operationId: OPERATION, sourceReceiptSha256: "c".repeat(64) },
      options(root),
    ), /prepared identity mismatch/u);
  });
});

test("missing, malformed, and completed journals cannot authorize baseline resume", () => {
  assert.throws(() => assertPermitTerminalizationLaunchIdentity(
    { operationId: OPERATION, sourceReceiptSha256: SOURCE },
    options("/does-not-exist"),
  ), /resume journal is missing/u);

  withJournal((root, operationRoot) => {
    writeSecure(resolve(operationRoot, "terminal-receipt.json"), Buffer.from("{}\n"));
    assert.throws(() => assertPermitTerminalizationLaunchIdentity(
      { operationId: OPERATION, sourceReceiptSha256: SOURCE },
      options(root, { verifyActiveTransition: () => ({}) }),
    ), /missing or terminal/u);
  });
});

function withJournal(run) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-terminalization-launch-"));
  try {
    const operationRoot = resolve(root, OPERATION);
    mkdirSync(operationRoot, { mode: 0o700 });
    writeSecure(resolve(operationRoot, "prepared.json"), Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      kind: "expired_success_permit_terminalization",
      state: "prepared",
      operationId: OPERATION,
      sourceReceiptSha256: SOURCE,
      sourceReceiptIdentity: {},
      sourceAttemptIdentity: {},
      sourceAttemptReceiptSha256: "c".repeat(64),
      environmentBeforeIdentity: {},
      environmentProposedIdentity: {},
      envBeforeSha256: "d".repeat(64),
      envAfterSha256: "e".repeat(64),
      permitDigestSha256: "f".repeat(64),
      expiresAt: "2026-08-06T02:00:00.000Z",
      releaseRevision: "1".repeat(40),
      apiImageDigest: `sha256:${"2".repeat(64)}`,
      preRuntime: {},
      startedAt: "2026-08-06T03:00:00.000Z",
    })}\n`));
    run(root, operationRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function options(root, overrides = {}) {
  return {
    rootPath: root,
    testMode: true,
    verifyActiveTransition: () => { throw new Error("not active"); },
    verifyPromotionBaseline: () => ({ state: "PROMOTION_COMPLETED" }),
    ...overrides,
  };
}

function writeSecure(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o400 });
  chmodSync(path, 0o400);
}
