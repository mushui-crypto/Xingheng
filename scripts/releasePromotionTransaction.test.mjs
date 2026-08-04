import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReleasePromotionTransaction,
  assertPromotionStateAllowsProduction,
  validateTrustedPromotionArguments,
} from "./releasePromotionTransaction.mjs";
import {
  captureTrustedCandidateTree,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";
import { readValidatedPromotionHelperReceipt } from "./trustedDockerRuntime.mjs";

const OLD_REVISION = "1".repeat(40);
const NEW_REVISION = "2".repeat(40);
const OPERATION_ID = "12345678-1234-4123-8123-123456789abc";

test("promotion publishes one completed record with embedded success receipt", () => {
  withFixture((fixture) => {
    const result = fixture.transaction.promote(fixture.expected);
    assert.equal(result.state, "PROMOTION_COMPLETED");
    assert.equal(result.success.operationId, OPERATION_ID);
    assert.equal(result.success.newCanonical.revision, NEW_REVISION);
    assert.equal(readManifest(fixture.canonicalRoot).revision, NEW_REVISION);
    assert.equal(readManifest(fixture.stagingPath).revision, OLD_REVISION);
    assert.equal(readFileSync(join(fixture.canonicalRoot, ".env.production"), "utf8"), "A=1\n");
    assert.equal(readFileSync(fixture.lifecyclePointer, "utf8"), fixture.lifecycleBytes);
    assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).state, "PROMOTION_COMPLETED");
    assert.throws(() => fixture.transaction.promote(fixture.expected), /already completed/u);
  });
});

test("every candidate identity mismatch becomes UNKNOWN without exchange", () => {
  for (const mutate of [
    (value) => { value.revision = "3".repeat(40); },
    (value) => { value.sourceSha256 = "3".repeat(64); },
    (value) => { value.treeSha256 = "3".repeat(64); },
    (value) => { value.manifestSha256 = "3".repeat(64); },
    (value) => { value.images.api = image("3"); },
    (value) => { value.images.web = image("3"); },
    (value) => { value.images.strategyTools = image("3"); },
  ]) {
    withFixture((fixture) => {
      const expected = structuredClone(fixture.expected);
      mutate(expected);
      assert.throws(() => fixture.transaction.promote(expected));
      assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
      if (exists(fixture.statePath)) {
        assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).state, "PROMOTION_UNKNOWN");
      }
    });
  }
});

test("canonical drift after STARTED and post-exchange trust failure become UNKNOWN", () => {
  for (const stage of ["before-exchange", "after-exchange"]) {
    withFixture((fixture) => {
      if (stage === "before-exchange") {
        fixture.transaction.exchange = () => { throw new Error("exchange unavailable"); };
      } else {
        fixture.transaction.installTrust = () => { throw new Error("trust failed"); };
      }
      assert.throws(() => fixture.transaction.promote(fixture.expected));
      const record = JSON.parse(readFileSync(fixture.statePath, "utf8"));
      assert.equal(record.state, "PROMOTION_UNKNOWN");
      assert.equal(record.success, null);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions), /blocked/u);
    });
  }
});

test("all nonterminal and malformed states block production; absent state preserves IDLE", () => {
  withFixture((fixture) => {
    replaceFixtureFile(fixture.helperReceipt, "malformed\n", 0o400);
    assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).state, "IDLE");
    fixture.transaction.exchange = () => { throw new Error("stop after STARTED"); };
    assert.throws(() => fixture.transaction.promote(fixture.expected));
    const unknown = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    for (const state of ["PROMOTION_STARTED", "PROMOTION_EXCHANGED", "PROMOTION_UNKNOWN"]) {
      const value = { ...unknown, state, failureStage: state === "PROMOTION_UNKNOWN"
        ? "manual_terminalization" : null };
      replaceFixtureFile(fixture.statePath, `${canonical(value)}\n`, 0o400);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
    }
    replaceFixtureFile(fixture.statePath, "{}\n", 0o400);
    assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
  });
});

test("COMPLETED requires exact record, canonical and trust identity", () => {
  withFixture((fixture) => {
    fixture.transaction.promote(fixture.expected);
    for (const mutation of [
      () => writeManifest(join(fixture.canonicalRoot, "deploy/release-manifest.json"), "4".repeat(40)),
      () => replaceFixtureFile(fixture.trustReceipt, "{}\n", 0o400),
      () => replaceFixtureFile(fixture.lifecyclePointer, "changed\n", 0o600),
      () => replaceFixtureFile(fixture.helperReceipt, "{}\n", 0o400),
      () => replaceFixtureFile(fixture.helperPath, "changed\n", 0o500),
      () => mutateJson(fixture.trustReceipt, (value) => { value.socket = "wrong"; }),
      () => mutateJson(fixture.trustReceipt, (value) => { value.daemon.id = "wrong"; }),
      () => mutateJson(fixture.trustReceipt, (value) => { value.extra = true; }),
      () => mutateJson(fixture.trustReceipt, (value) => { delete value.binaries; }),
    ]) {
      const restore = snapshot(fixture);
      mutation();
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
      restore();
    }
  });
});

test("independent helper receipt reopens the exact descriptor and rejects tampering", () => {
  withFixture((fixture) => {
    const opened = readValidatedPromotionHelperReceipt({ testMode: true,
      helperPath: fixture.helperPath, receiptPath: fixture.helperReceipt });
    closeSync(opened.opened.fd);
    const receiptBytes = readFileSync(fixture.helperReceipt);
    mutateJson(fixture.helperReceipt, (value) => { value.helper.sha256 = "0".repeat(64); });
    assert.throws(() => readValidatedPromotionHelperReceipt({ testMode: true,
      helperPath: fixture.helperPath, receiptPath: fixture.helperReceipt }));
    replaceFixtureFile(fixture.helperReceipt, receiptBytes, 0o400);
    chmodSync(fixture.helperPath, 0o700);
    assert.throws(() => readValidatedPromotionHelperReceipt({ testMode: true,
      helperPath: fixture.helperPath, receiptPath: fixture.helperReceipt }));
  });
});

test("STARTED binds staging content, not only the directory inode", () => {
  withFixture((fixture) => {
    fixture.transaction.fault = (stage) => {
      if (stage === "after_started_publish") {
        writeManifest(join(fixture.stagingPath, "deploy/release-manifest.json"), "3".repeat(40));
      }
    };
    assert.throws(() => fixture.transaction.promote(fixture.expected), /staging identity changed/u);
    assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).state, "PROMOTION_UNKNOWN");
  });
});

test("trusted promotion arguments are a strict command, payload and environment closure", () => {
  const environment = { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" };
  const value = { revision: NEW_REVISION, sourceSha256: "a".repeat(64),
    treeSha256: "b".repeat(64), manifestSha256: "c".repeat(64),
    images: manifest(NEW_REVISION).images, operationId: OPERATION_ID };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.equal(validateTrustedPromotionArguments(["--promotion-json", payload], environment).command,
    "promote");
  assert.equal(validateTrustedPromotionArguments(["--terminalize-unknown", OPERATION_ID], environment)
    .command, "terminalize-unknown");
  for (const args of [
    ["--generate", payload], ["--promotion-json", payload, "extra"],
    ["--promotion-json", "../payload"], ["scripts/other.sh", payload],
  ]) assert.throws(() => validateTrustedPromotionArguments(args, environment));
  assert.throws(() => validateTrustedPromotionArguments(["--promotion-json", payload],
    { ...environment, NODE_OPTIONS: "--require=/tmp/caller.cjs" }));
});

test("promotion wrapper process rejects trusted direct, legacy and polluted callers", () => {
  const wrapper = new URL("./release-promote.sh", import.meta.url).pathname;
  const payload = "A".repeat(120);
  const environment = { HOME: tmpdir(), PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" };
  const root = mkdtempSync(join(tmpdir(), "promotion-wrapper-process-"));
  try {
    const candidateScripts = join(root, "opt/xingheng-release/candidates", NEW_REVISION,
      "code/scripts");
    mkdirSync(candidateScripts, { recursive: true });
    const candidateWrapper = join(candidateScripts, "release-promote.sh");
    cpSync(wrapper, candidateWrapper);
    chmodSync(candidateWrapper, 0o755);
    const trustedEnvironment = { ...environment,
      XINGHENG_OPERATION_LOCK_CONTEXT: "promotion" };
    for (const invocation of [
      { command: "/bin/sh", args: ["release-promote.sh", "--generate", "legacy"],
        cwd: candidateScripts, env: trustedEnvironment },
      { command: "release-promote.sh", args: ["--generate", "legacy"], cwd: candidateScripts,
        env: { ...trustedEnvironment, PATH: `${candidateScripts}:${environment.PATH}` } },
      { command: "/bin/sh", args: [candidateWrapper, "--promotion-json", payload, "extra"],
        cwd: candidateScripts, env: trustedEnvironment },
      { command: "/bin/sh", args: [candidateWrapper, "--promotion-json", payload],
        cwd: candidateScripts, env: environment },
      { command: "/bin/sh", args: [candidateWrapper, "--promotion-json", payload],
        cwd: candidateScripts, env: { ...trustedEnvironment, NODE_OPTIONS: "--no-warnings" } },
    ]) {
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /production gate PASS|PROMOTION_COMPLETED/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual terminalization can only move matching STARTED or EXCHANGED to UNKNOWN", () => {
  withFixture((fixture) => {
    fixture.transaction.exchange = () => { throw new Error("exchange stopped"); };
    assert.throws(() => fixture.transaction.promote(fixture.expected));
    const value = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    value.state = "PROMOTION_STARTED";
    value.failureStage = null;
    replaceFixtureFile(fixture.statePath, `${canonical(value)}\n`, 0o400);
    assert.equal(fixture.transaction.terminalizeUnknown(OPERATION_ID).state, "PROMOTION_UNKNOWN");
    assert.throws(() => fixture.transaction.terminalizeUnknown(OPERATION_ID));
  });
});

test("fault injection never publishes partial success", () => {
  for (const stage of [
    "staging_prepared",
    "before_started_publish",
    "after_exchange",
    "after_exchanged_publish",
    "after_trust_install",
    "before_completed_publish",
  ]) {
    withFixture((fixture) => {
      fixture.transaction.fault = (point) => {
        if (point === stage) throw new Error(`injected ${stage}`);
      };
      assert.throws(() => fixture.transaction.promote(fixture.expected));
      if (!exists(fixture.statePath)) {
        assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
        return;
      }
      const record = JSON.parse(readFileSync(fixture.statePath, "utf8"));
      assert.equal(record.state, "PROMOTION_UNKNOWN");
      assert.equal(record.success, null);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
      assert.ok([OLD_REVISION, NEW_REVISION].includes(readManifest(fixture.canonicalRoot).revision));
    });
  }
});

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-promotion-"));
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const releaseParent = join(root, "release");
    const canonicalRoot = join(releaseParent, "code");
    const candidatesRoot = join(releaseParent, "candidates");
    const candidateRoot = join(candidatesRoot, NEW_REVISION);
    const candidateCode = join(candidateRoot, "code");
    const stateRoot = join(root, "state");
    const statePath = join(stateRoot, "current.json");
    const trustReceipt = join(root, "trusted-operations.json");
    const helperPath = join(root, "helper");
    const helperReceipt = join(root, "helper-receipt.json");
    const lifecyclePointer = join(root, "lifecycle.json");
    const stagingPath = join(releaseParent, `.promotion-staging-${OPERATION_ID}`);
    for (const path of [releaseParent, canonicalRoot, candidatesRoot, candidateRoot, candidateCode]) {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    makeCodeTree(canonicalRoot, OLD_REVISION);
    makeCodeTree(candidateCode, NEW_REVISION, false);
    writeFileSync(join(canonicalRoot, ".env.production"), "A=1\n", { mode: 0o600 });
    chmodSync(join(canonicalRoot, ".env.production"), 0o600);
    const lifecycleBytes = `${JSON.stringify({ revision: OLD_REVISION })}\n`;
    writeFileSync(lifecyclePointer, lifecycleBytes, { mode: 0o600 });
    chmodSync(lifecyclePointer, 0o600);
    writeFileSync(helperPath, "fixture-helper\n", { mode: 0o500 });
    chmodSync(helperPath, 0o500);
    writeHelperReceipt(helperReceipt, helperPath);
    const archive = join(candidateRoot, "code.tar");
    writeFileSync(archive, "archive\n", { mode: 0o400 });
    chmodSync(archive, 0o400);
    const candidateManifest = join(candidateRoot, "release-manifest.json");
    writeManifest(candidateManifest, NEW_REVISION);
    const tree = captureTrustedCandidateTree(candidateCode, { expectedUid: uid, expectedGid: gid });
    const sourceArchive = secureArtifactReceipt(archive, 0o400, { expectedUid: uid, expectedGid: gid });
    const receipt = {
      schemaVersion: 1,
      revision: NEW_REVISION,
      candidateRoot,
      codeRoot: candidateCode,
      sourceArchive,
      candidateTree: tree,
      socket: "/var/run/docker.sock",
      binaries: Object.fromEntries([
        "compose", "docker", "findmnt", "flock", "git", "node", "sh", "sha256sum", "tar",
      ].map((name) => [name, { path: `/usr/bin/${name}`, sha256: "a".repeat(64) }])),
      daemon: { id: "fixture-daemon", rootDir: "/var/lib/docker", serverVersion: "1.2.3",
        storageDriver: "overlay2" },
    };
    writeFileSync(join(candidateRoot, "candidate-build-receipt.json"),
      `${JSON.stringify(receipt)}\n`, { mode: 0o400 });
    chmodSync(join(candidateRoot, "candidate-build-receipt.json"), 0o400);
    const expected = {
      revision: NEW_REVISION,
      sourceSha256: sourceArchive.sha256,
      treeSha256: tree.sha256,
      manifestSha256: sha256(readFileSync(candidateManifest)),
      images: manifest(NEW_REVISION).images,
      operationId: OPERATION_ID,
    };
    const paths = { releaseParent, canonicalRoot, candidatesRoot, stateRoot, statePath,
      trustReceipt, lifecyclePointer, helperPath, helperReceipt };
    const exchange = () => {
      const parked = join(releaseParent, ".unit-exchange");
      renameSync(canonicalRoot, parked);
      renameSync(stagingPath, canonicalRoot);
      renameSync(parked, stagingPath);
    };
    const installTrust = () => {
      const releaseTreeSha256 = sha256(readFileSync(join(canonicalRoot, "deploy/release-manifest.json")));
      const value = { schemaVersion: 1, releaseRoot: canonicalRoot,
        releaseTree: { sha256: releaseTreeSha256 }, socket: "fixture-socket",
        binaries: { node: { path: "/usr/bin/node", sha256: "a".repeat(64) } },
        daemon: { id: "fixture-daemon", rootDir: "/var/lib/docker",
          serverVersion: "1.2.3", storageDriver: "overlay2" } };
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      writeFileSync(trustReceipt, bytes, { mode: 0o400 });
      chmodSync(trustReceipt, 0o400);
      return sha256(bytes);
    };
    const validateMainTrust = () => validateMainTrustFixture(trustReceipt, canonicalRoot);
    const validateHelper = () => validateHelperFixture(helperReceipt, helperPath);
    const transaction = new ReleasePromotionTransaction({ ...paths, testMode: true, exchange,
      installTrust, validateMainTrust, validateHelper,
      now: () => new Date("2026-08-05T00:00:00.000Z") });
    callback({ root, ...paths, transaction, expected, stagingPath, lifecycleBytes,
      guardOptions: { ...paths, expectedUid: uid, expectedGid: gid,
        validateMainTrust, validateHelper } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeCodeTree(root, revision, includeManifest = true) {
  mkdirSync(join(root, "deploy"), { mode: 0o700 });
  mkdirSync(join(root, "scripts"), { mode: 0o700 });
  if (includeManifest) writeManifest(join(root, "deploy/release-manifest.json"), revision);
  for (let index = 0; index < 22; index += 1) {
    writeFileSync(join(root, "scripts", `fixture-${index}.mjs`), `export default ${index};\n`, { mode: 0o500 });
  }
}

function writeManifest(path, revision) {
  replaceFixtureFile(path, `${JSON.stringify(manifest(revision), null, 2)}\n`, 0o444);
}

function manifest(revision) {
  return { schemaVersion: 1, revision, images: {
    api: image("a"), web: image("b"), strategyTools: image("c"),
  } };
}

function image(character) { return `sha256:${character.repeat(64)}`; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readManifest(root) { return JSON.parse(readFileSync(join(root, "deploy/release-manifest.json"), "utf8")); }
function exists(path) { try { readFileSync(path); return true; } catch { return false; } }

function snapshot(fixture) {
  const files = [
    [join(fixture.canonicalRoot, "deploy/release-manifest.json"), 0o444],
    [fixture.trustReceipt, 0o400],
    [fixture.lifecyclePointer, 0o600],
    [fixture.helperReceipt, 0o400],
    [fixture.helperPath, 0o500],
  ].map(([path, mode]) => [path, readFileSync(path), mode]);
  return () => {
    for (const [path, bytes, mode] of files) {
      replaceFixtureFile(path, bytes, mode);
    }
  };
}

function writeHelperReceipt(path, helperPath) {
  const metadata = lstatSync(helperPath);
  const value = { schemaVersion: 1, helper: { path: helperPath,
    sha256: sha256(readFileSync(helperPath)), dev: metadata.dev, ino: metadata.ino,
    size: metadata.size, uid: metadata.uid, gid: metadata.gid, nlink: metadata.nlink,
    mode: metadata.mode & 0o777 } };
  replaceFixtureFile(path, `${JSON.stringify(value)}\n`, 0o400);
}

function validateHelperFixture(receiptPath, helperPath) {
  const value = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (Object.keys(value).sort().join(",") !== "helper,schemaVersion"
    || value.schemaVersion !== 1 || value.helper.path !== helperPath
    || value.helper.sha256 !== sha256(readFileSync(helperPath))) {
    throw new Error("fixture helper receipt invalid");
  }
  return { receiptSha256: sha256(readFileSync(receiptPath)) };
}

function validateMainTrustFixture(path, canonicalRoot) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (Object.keys(value).sort().join(",") !== [
    "binaries", "daemon", "releaseRoot", "releaseTree", "schemaVersion", "socket",
  ].sort().join(",") || value.schemaVersion !== 1 || value.releaseRoot !== canonicalRoot
    || value.socket !== "fixture-socket"
    || Object.keys(value.binaries).join(",") !== "node"
    || value.daemon.id !== "fixture-daemon") throw new Error("fixture main trust receipt invalid");
  return { ...value, receiptSha256: sha256(readFileSync(path)) };
}

function replaceFixtureFile(path, bytes, mode) {
  try { chmodSync(path, 0o600); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function mutateJson(path, mutation) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutation(value);
  replaceFixtureFile(path, `${JSON.stringify(value)}\n`, 0o400);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
