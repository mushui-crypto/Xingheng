import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  advanceCapitalTestWindowLease,
  assertCapitalTestWindowAllowsNewRisk,
  createActiveCapitalTestWindowReceipt,
  terminateCapitalTestWindowReceipt,
  validateCapitalTestWindowReceipt,
} from "./capitalTestWindowReceipt.mjs";

const start = new Date("2026-08-06T00:00:00.000Z");
const ownerUserId = "USR-MOSS1";

test("Capital Test window is closed without a canonical receipt", () => {
  withRoot(({ root, current, boundary }) => {
    assert.throws(
      () => assertCapitalTestWindowAllowsNewRisk(permit(), {
        path: current,
        rootPath: root,
        now: start,
        ...boundary,
      }),
      /ENOENT/u,
    );
  });
});

test("direct controller entry fails before creating window state", () => {
  const result = spawnSync(process.execPath, [
    new URL("./capitalTestWindowController.mjs", import.meta.url).pathname,
    "run",
    "a".repeat(32),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /controlled Linux root|trusted wrapper context/u);
});

test("active receipt survives reread and binds exact Permit identity", () => {
  withReceipt(({ root, current, receipt, boundary }) => {
    const now = new Date(start.getTime() + 1_000);
    assert.equal(assertCapitalTestWindowAllowsNewRisk(permit(), {
      path: current, rootPath: root, now, ...boundary,
    }).digest, receipt.digest);
    assert.equal(assertCapitalTestWindowAllowsNewRisk(permit(), {
      path: current, rootPath: root, now, ...boundary,
    }).digest, receipt.digest);
    for (const changed of [
      { digest: "0".repeat(64) },
      { authorizationDigest: "0".repeat(64) },
      { accountBindingSha256: "0".repeat(64) },
      { ownerUserId: "USR-MOSS2" },
      { revision: "0".repeat(40) },
    ]) {
      assert.throws(() => assertCapitalTestWindowAllowsNewRisk({ ...permit(), ...changed }, {
        path: current, rootPath: root, now, ...boundary,
      }), /window is closed/u);
    }
  });
});

test("lease loss, hard deadline, terminal state, and legacy mode fail closed", () => {
  withReceipt(({ root, current, receipt, boundary, install }) => {
    assert.throws(() => assertCapitalTestWindowAllowsNewRisk(permit(), {
      path: current,
      rootPath: root,
      now: new Date(start.getTime() + 5_000),
      ...boundary,
    }), /window is closed/u);

    const advanced = advanceCapitalTestWindowLease(receipt, new Date(start.getTime() + 1_000));
    assert.equal(advanced.hardEndAt, receipt.hardEndAt);
    install(advanced);
    assert.throws(() => assertCapitalTestWindowAllowsNewRisk(permit(), {
      path: current,
      rootPath: root,
      now: new Date(start.getTime() + 30 * 60_000),
      ...boundary,
    }), /window is closed/u);

    const terminal = terminateCapitalTestWindowReceipt(advanced, "closed", "signal", new Date(start.getTime() + 2_000));
    install(terminal);
    assert.throws(() => assertCapitalTestWindowAllowsNewRisk(permit(), {
      path: current,
      rootPath: root,
      now: new Date(start.getTime() + 2_000),
      ...boundary,
    }), /window is closed/u);
    assert.throws(() => createActiveCapitalTestWindowReceipt({
      ...receiptInput(),
      executionMode: "single_funding_rate_arbitrage_round",
    }), /execution mode is invalid/u);
  });
});

test("receipt digest, exact schema, and immutable hardEnd fail closed", () => {
  const receipt = activeReceipt();
  assert.throws(() => validateCapitalTestWindowReceipt({ ...receipt, hardEndAt: "2026-08-06T00:31:00.000Z" }), /receipt is invalid/u);
  assert.throws(() => validateCapitalTestWindowReceipt({ ...receipt, extra: true }), /receipt is invalid/u);
  assert.throws(() => advanceCapitalTestWindowLease(receipt, new Date(start.getTime() - 1)), /cannot advance/u);
  assert.equal(
    advanceCapitalTestWindowLease(receipt, new Date(start.getTime() + 1_000)).hardEndAt,
    receipt.hardEndAt,
  );
});

for (const defect of ["mode", "symlink", "hardlink"]) {
  test(`receipt ${defect} boundary fails closed`, () => {
    withRoot(({ root, current, boundary }) => {
      const alternate = resolve(root, "alternate.json");
      chmodSync(root, 0o755);
      writeFileSync(alternate, `${JSON.stringify(activeReceipt())}\n`, { mode: 0o444 });
      if (defect === "mode") {
        writeFileSync(current, `${JSON.stringify(activeReceipt())}\n`, { mode: 0o600 });
      } else if (defect === "symlink") {
        symlinkSync(alternate, current);
      } else {
        linkSync(alternate, current);
      }
      chmodSync(root, 0o555);
      assert.throws(() => assertCapitalTestWindowAllowsNewRisk(permit(), {
        path: current,
        rootPath: root,
        now: new Date(start.getTime() + 1_000),
        ...boundary,
      }), /boundary is invalid/u);
    });
  });
}

function permit() {
  return {
    ownerUserId,
    accountBindingSha256: "3".repeat(64),
    authorizationDigest: "2".repeat(64),
    executionMode: "single_connectivity_smoke",
    revision: "4".repeat(40),
    digest: "1".repeat(64),
  };
}

function receiptInput() {
  return {
    operationId: "a".repeat(32),
    windowId: "b".repeat(32),
    executionMode: "single_connectivity_smoke",
    ownerUserIdSha256: createHash("sha256").update(ownerUserId).digest("hex"),
    permitDigest: permit().digest,
    authorizationManifestSha256: permit().authorizationDigest,
    accountBindingSha256: permit().accountBindingSha256,
    releaseRevision: permit().revision,
    releaseTreeSha256: "5".repeat(64),
    releaseManifestSha256: "6".repeat(64),
    apiImageDigest: `sha256:${"7".repeat(64)}`,
    webImageDigest: `sha256:${"8".repeat(64)}`,
    trustedOperationsReceiptSha256: "9".repeat(64),
    startAt: start,
    hardEndAt: new Date(start.getTime() + 30 * 60_000),
  };
}

function activeReceipt() {
  return createActiveCapitalTestWindowReceipt(receiptInput());
}

function withRoot(run) {
  const parent = mkdtempSync(resolve(tmpdir(), "capital-test-window-"));
  const root = resolve(parent, "state");
  mkdirSync(root, { mode: 0o755 });
  chmodSync(root, 0o555);
  const boundary = { expectedUid: process.getuid(), expectedGid: process.getgid() };
  try {
    run({ root, current: resolve(root, "current.json"), boundary });
  } finally {
    chmodSync(root, 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
}

function withReceipt(run) {
  withRoot(({ root, current, boundary }) => {
    const receipt = activeReceipt();
    const install = (value) => {
      chmodSync(root, 0o755);
      try { chmodSync(current, 0o600); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      writeFileSync(current, `${JSON.stringify(value)}\n`, { mode: 0o444 });
      chmodSync(current, 0o444);
      chmodSync(root, 0o555);
    };
    install(receipt);
    run({ root, current, receipt, boundary, install });
  });
}
