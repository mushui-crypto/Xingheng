import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireOperationLocks } from "./operationLocks.mjs";

test("operation locks enforce global then environment exclusion", (t) => {
  if (!existsSync("/usr/bin/flock")) {
    t.skip("util-linux flock is unavailable on this host");
    return;
  }
  const parent = mkdtempSync(join(tmpdir(), "xingheng-operation-locks-"));
  const root = join(parent, "locks");
  try {
    mkdirSync(root, { mode: 0o700 });
    const first = acquireOperationLocks("production", { testMode: true, lockRoot: root });
    try {
      assert.deepEqual(first.receipts.map((item) => item.path.split("/").at(-1)), [
        "release-global.lock",
        "production.lock",
      ]);
      assert.throws(
        () => acquireOperationLocks("production", { testMode: true, lockRoot: root }),
        /already held/u,
      );
      assert.throws(
        () => acquireOperationLocks("release-build", { testMode: true, lockRoot: root }),
        /already held/u,
      );
      assert.throws(
        () => acquireOperationLocks("candidate-verify", { testMode: true, lockRoot: root }),
        /already held/u,
      );
      assert.throws(
        () => acquireOperationLocks("promotion", { testMode: true, lockRoot: root }),
        /already held/u,
      );
    } finally {
      first.close();
    }
    const second = acquireOperationLocks("production", { testMode: true, lockRoot: root });
    second.close();
    const build = acquireOperationLocks("release-build", { testMode: true, lockRoot: root });
    assert.deepEqual(build.receipts.map((item) => item.path.split("/").at(-1)), [
      "release-global.lock",
      "release-build.lock",
    ]);
    build.close();
    const verify = acquireOperationLocks("candidate-verify", { testMode: true, lockRoot: root });
    assert.deepEqual(verify.receipts.map((item) => item.path.split("/").at(-1)), [
      "release-global.lock",
      "production.lock",
    ]);
    verify.close();
    const promotion = acquireOperationLocks("promotion", { testMode: true, lockRoot: root });
    assert.deepEqual(promotion.receipts.map((item) => item.path.split("/").at(-1)), [
      "release-global.lock",
      "production.lock",
    ]);
    assert.throws(
      () => acquireOperationLocks("production", { testMode: true, lockRoot: root }),
      /already held/u,
    );
    promotion.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("operation locks reject symlinked, hardlinked, or permissive objects", () => {
  for (const kind of ["symlink", "hardlink", "mode"]) {
    const parent = mkdtempSync(join(tmpdir(), `xingheng-operation-lock-${kind}-`));
    const root = join(parent, "locks");
    try {
      mkdirSync(root, { mode: 0o700 });
      const target = join(parent, "target");
      writeFileSync(target, "", { mode: 0o600 });
      const lock = join(root, "release-global.lock");
      if (kind === "symlink") symlinkSync(target, lock);
      if (kind === "hardlink") linkSync(target, lock);
      if (kind === "mode") writeFileSync(lock, "", { mode: 0o666 });
      assert.throws(
        () => acquireOperationLocks("production", { testMode: true, lockRoot: root }),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
