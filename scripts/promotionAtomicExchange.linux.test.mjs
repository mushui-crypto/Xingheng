import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ENABLED = process.platform === "linux" && process.getuid?.() === 0
  && process.env.XINGHENG_PROMOTION_EXCHANGE_FIXTURE === "1";
const OPERATION_ID = "12345678-1234-4123-8123-123456789abc";

test("Linux helper atomically exchanges non-empty fixed directories and rejects boundary drift", {
  skip: !ENABLED && "requires the isolated Linux/root promotion exchange fixture",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-promotion-helper-"));
  try {
    const binary = join(root, "helper");
    const build = spawnSync("sh", ["scripts/build-promotion-atomic-exchange.sh",
      "--test-root", root, binary], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    for (const path of [join(root, "release"), join(root, "state"), join(root, "locks")]) {
      mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700);
    }
    const canonical = join(root, "release/code");
    const staging = join(root, `release/.promotion-staging-${OPERATION_ID}`);
    mkdirSync(canonical, { mode: 0o700 }); mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(canonical, "old"), "old\n", { mode: 0o400 });
    writeFileSync(join(staging, "new"), "new\n", { mode: 0o400 });
    const state = join(root, "state/current.json");
    writeFileSync(state,
      `${JSON.stringify({ state: "PROMOTION_STARTED", evidence: "x".repeat(256) })}\n`,
      { mode: 0o400 });
    chmodSync(state, 0o400);
    const locks = ["release-global.lock", "production.lock"].map((name) => {
      const path = join(root, "locks", name); writeFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600); return openSync(path, "r+");
    });
    const contextFd = openSync(state, "r");
    const before = [lstatSync(canonical), lstatSync(staging)];
    const contextSha = sha256(readFileSync(state));
    const result = spawnSync(binary, [OPERATION_ID, contextSha,
      String(before[0].dev), String(before[0].ino), String(before[1].dev), String(before[1].ino)], {
      encoding: "utf8",
      env: { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8", TZ: "UTC", XINGHENG_OPERATION_LOCK_CONTEXT: "promotion",
        XINGHENG_PROMOTION_CONTEXT_SHA256: contextSha },
      stdio: ["ignore", "pipe", "pipe", locks[0], locks[1], contextFd],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(canonical).ino, before[1].ino);
    assert.equal(lstatSync(staging).ino, before[0].ino);
    assert.equal(readFileSync(join(canonical, "new"), "utf8"), "new\n");
    const repeated = spawnSync(binary, [OPERATION_ID, contextSha,
      String(before[0].dev), String(before[0].ino), String(before[1].dev), String(before[1].ino)], {
      encoding: "utf8", env: { XINGHENG_OPERATION_LOCK_CONTEXT: "promotion",
        XINGHENG_PROMOTION_CONTEXT_SHA256: contextSha },
      stdio: ["ignore", "pipe", "pipe", locks[0], locks[1], contextFd],
    });
    assert.notEqual(repeated.status, 0);

    const current = [lstatSync(canonical), lstatSync(staging)];
    const invoke = (overrides = {}) => spawnSync(binary, [OPERATION_ID,
      overrides.contextSha ?? contextSha,
      String(overrides.canonicalDev ?? current[0].dev),
      String(overrides.canonicalIno ?? current[0].ino),
      String(overrides.stagingDev ?? current[1].dev),
      String(overrides.stagingIno ?? current[1].ino)], {
      encoding: "utf8",
      env: { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8", TZ: "UTC", XINGHENG_OPERATION_LOCK_CONTEXT: "promotion",
        XINGHENG_PROMOTION_CONTEXT_SHA256: overrides.contextSha ?? contextSha },
      stdio: ["ignore", "pipe", "pipe", locks[0], locks[1], contextFd],
    });
    assert.notEqual(invoke({ canonicalDev: Number(current[0].dev) + 1 }).status, 0);
    chmodSync(canonical, 0o770);
    assert.notEqual(invoke().status, 0);
    chmodSync(canonical, 0o700);
    chmodSync(state, 0o600);
    assert.notEqual(invoke().status, 0);
    chmodSync(state, 0o400);
    const stateLink = join(root, "state-link");
    linkSync(state, stateLink);
    assert.notEqual(invoke().status, 0);
    unlinkSync(stateLink);
    chmodSync(join(root, "locks/production.lock"), 0o660);
    assert.notEqual(invoke().status, 0);
    chmodSync(join(root, "locks/production.lock"), 0o600);
    const parked = `${staging}.parked`;
    renameSync(staging, parked);
    symlinkSync(parked, staging);
    assert.notEqual(invoke().status, 0);
    unlinkSync(staging);
    renameSync(parked, staging);
    if (exists("/usr/bin/setpriv")) {
      const nonroot = spawnSync("/usr/bin/setpriv", ["--reuid=65534", "--regid=65534",
        "--clear-groups", binary, OPERATION_ID, contextSha, String(current[0].dev),
        String(current[0].ino), String(current[1].dev), String(current[1].ino)], {
        encoding: "utf8",
        env: { XINGHENG_OPERATION_LOCK_CONTEXT: "promotion",
          XINGHENG_PROMOTION_CONTEXT_SHA256: contextSha },
        stdio: ["ignore", "pipe", "pipe", locks[0], locks[1], contextFd],
      });
      assert.notEqual(nonroot.status, 0);
    }
    const testDigest = sha256(readFileSync(binary));
    const installRoot = join(root, "install-fixture");
    mkdirSync(installRoot, { mode: 0o700 });
    const install = spawnSync("sh", ["scripts/install-promotion-atomic-exchange.sh",
      "--test-root", installRoot, binary, testDigest], { encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    const installed = join(installRoot, "installed/xingheng-promotion-atomic-exchange");
    const independentReceipt = join(installRoot, "receipt/promotion-atomic-exchange.json");
    const installedMetadata = lstatSync(installed);
    const receiptValue = JSON.parse(readFileSync(independentReceipt, "utf8"));
    assert.equal(receiptValue.helper.path, installed);
    assert.equal(receiptValue.helper.sha256, testDigest);
    assert.equal(receiptValue.helper.ino, installedMetadata.ino);
    assert.equal(receiptValue.helper.mode, 0o500);
    const receiptBeforeFailure = sha256(readFileSync(independentReceipt));
    const failedInstall = spawnSync("sh", ["scripts/install-promotion-atomic-exchange.sh",
      "--test-root", installRoot, binary, "0".repeat(64)], { encoding: "utf8" });
    assert.notEqual(failedInstall.status, 0);
    assert.equal(sha256(readFileSync(independentReceipt)), receiptBeforeFailure);
    const changedBinary = join(root, "changed-helper");
    writeFileSync(changedBinary,
      Buffer.concat([readFileSync(binary), Buffer.from("\ninterrupted replacement\n")]),
      { mode: 0o500 });
    chmodSync(changedBinary, 0o500);
    const interrupted = spawnSync("sh", ["scripts/install-promotion-atomic-exchange.sh",
      "--test-root", installRoot, changedBinary, sha256(readFileSync(changedBinary))], {
      encoding: "utf8", env: { ...process.env,
        XINGHENG_PROMOTION_INSTALL_TEST_FAULT: "after-helper" },
    });
    assert.equal(interrupted.status, 91);
    assert.equal(sha256(readFileSync(independentReceipt)), receiptBeforeFailure);
    assert.notEqual(sha256(readFileSync(installed)), receiptValue.helper.sha256);
    assert.equal(lstatSync(canonical).ino, current[0].ino);
    assert.equal(lstatSync(staging).ino, current[1].ino);
    closeSync(contextFd); locks.forEach(closeSync);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exists(path) { try { lstatSync(path); return true; } catch { return false; } }
