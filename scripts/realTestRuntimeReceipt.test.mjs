import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REAL_TEST_RUNTIME_ENV_KEYS,
  parseRealTestRuntimeEnvironment,
  readRealTestRuntimeContext,
  validateRealTestRuntimeChecksums,
  validateRealTestRuntimeManifest,
  validateRealTestRuntimeReceipt,
} from "./realTestRuntimeReceipt.mjs";
import { installRealTestRuntime } from "./installRealTestRuntime.mjs";

const REVISION = "a".repeat(40);

test("single-revision runtime receipt is exact and contains no secret identity", () => {
  const receipt = receiptFixture();
  const value = validateRealTestRuntimeReceipt(receipt);
  assert.equal(value.revision, REVISION);
  assert.equal(Object.isFrozen(value.images), true);
  assert.equal("runtimeEnvSha256" in value, false);
  assert.equal("serviceAccount" in value, false);
  assert.equal("kmsKey" in value, false);
  for (const mutate of [
    (copy) => { copy.extra = true; },
    (copy) => { copy.revision = "a".repeat(7); },
    (copy) => {
      copy.candidateRoot = `/opt/xingheng-release/candidates/${REVISION}`;
    },
    (copy) => { copy.images.api = `xingheng-api:${REVISION}`; },
    (copy) => { copy.envPath = "/tmp/runtime.env"; },
    (copy) => { copy.candidateReceiptSha256 = "invalid"; },
    (copy) => { copy.socket = "/tmp/docker.sock"; },
  ]) {
    const copy = structuredClone(receipt);
    mutate(copy);
    assert.throws(
      () => validateRealTestRuntimeReceipt(copy),
      /schema is invalid|identity is invalid/u,
    );
  }
});

test("runtime environment rejects unknown, provider-write and credential controls", () => {
  const source = environmentSource();
  const value = parseRealTestRuntimeEnvironment(source, REVISION);
  assert.equal(value.XINGHENG_REVISION, REVISION);
  assert.equal(value.RWA_GCP_KMS_AUTH_MODE, "gce_attached_service_account");
  for (const changed of [
    `${source}UNKNOWN=value\n`,
    source.replace("ADMIN_EMAIL=1\n", ""),
    source.replace("ADMIN_EMAIL=1\n", "ADMIN_EMAIL=1\nADMIN_EMAIL=2\n"),
    source.replace(`XINGHENG_REVISION=${REVISION}`, `XINGHENG_REVISION=${"b".repeat(40)}`),
    `${source}GOOGLE_APPLICATION_CREDENTIALS=\n`,
    `${source}CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=\n`,
    `${source}GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=\n`,
    `${source}RWA_GCP_WIF_AUDIENCE=\n`,
    `${source}DOCKER_HOST=\n`,
    `${source}COMPOSE_FILE=\n`,
    `${source}BINANCE_API_KEY=\n`,
    `${source}RWA_AUTOMATION_EXECUTION_ENABLED=true\n`,
    `${source}BSC_TESTNET_PRIVATE_KEY=\n`,
  ]) {
    assert.throws(
      () => parseRealTestRuntimeEnvironment(changed, REVISION),
      /schema is invalid|forbidden key|identity is invalid/u,
    );
  }
});

test("manifest and checksums reject tags, extra fields and mixed candidate identity", () => {
  const receipt = receiptFixture();
  const manifest = {
    schemaVersion: 1,
    revision: REVISION,
    images: { ...receipt.images },
  };
  assert.deepEqual(validateRealTestRuntimeManifest(manifest), manifest);
  for (const mutate of [
    (copy) => { copy.extra = true; },
    (copy) => { copy.revision = "a".repeat(7); },
    (copy) => { copy.images.api = `xingheng-api:${REVISION}`; },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(
      () => validateRealTestRuntimeManifest(copy),
      /manifest schema is invalid/u,
    );
  }
  const manifestSha = "4".repeat(64);
  const checksums = [
    `${receipt.sourceArchiveSha256}  code.tar`,
    `${receipt.candidateReceiptSha256}  candidate-build-receipt.json`,
    `${manifestSha}  release-manifest.json`,
  ].join("\n");
  const candidateReceipt = {
    sourceArchive: { sha256: receipt.sourceArchiveSha256 },
    receiptSha256: receipt.candidateReceiptSha256,
  };
  assert.doesNotThrow(
    () => validateRealTestRuntimeChecksums(checksums, candidateReceipt, manifestSha),
  );
  for (const changed of [
    checksums.replace(receipt.sourceArchiveSha256, "f".repeat(64)),
    `${checksums}\n${"e".repeat(64)}  release-manifest.json`,
    checksums.replace("release-manifest.json", "../release-manifest.json"),
  ]) {
    assert.throws(
      () => validateRealTestRuntimeChecksums(changed, candidateReceipt, manifestSha),
      /checksums schema is invalid|checksums identity mismatch/u,
    );
  }
});

test("install publishes immutable selector/env once and rolls back partial publication", () => {
  const original = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), "xingheng-runtime-install-"));
  try {
    setInstallContext();
    const paths = installPaths(root);
    const bytes = Buffer.from(environmentSource());
    installRealTestRuntime(REVISION, "/candidate/code", bytes, {
      ...paths,
      testOnlyPaths: true,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      deriveReceipt: () => receiptFixture(),
      inspectImages: () => {},
      verifyPublished: () => {},
    });
    assert.equal(lstatSync(paths.selectorPath).mode & 0o777, 0o400);
    assert.equal(lstatSync(paths.envPath).mode & 0o777, 0o400);
    assert.deepEqual(
      JSON.parse(readFileSync(paths.selectorPath, "utf8")),
      receiptFixture(),
    );
    assert.throws(
      () => installRealTestRuntime(REVISION, "/candidate/code", bytes, {
        ...paths,
        testOnlyPaths: true,
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
        deriveReceipt: () => receiptFixture(),
        inspectImages: () => {},
        verifyPublished: () => {},
      }),
      /not MISSING/u,
    );

    const rollbackRoot = mkdtempSync(join(tmpdir(), "xingheng-runtime-rollback-"));
    try {
      const rollback = installPaths(rollbackRoot);
      assert.throws(
        () => installRealTestRuntime(REVISION, "/candidate/code", bytes, {
          ...rollback,
          testOnlyPaths: true,
          expectedUid: process.getuid(),
          expectedGid: process.getgid(),
          deriveReceipt: () => receiptFixture(),
          inspectImages: () => {},
          verifyPublished: () => {},
          beforeSelectorPublish: () => { throw new Error("injected publish failure"); },
        }),
        /injected publish failure/u,
      );
      assert.equal(exists(rollback.selectorPath), false);
      assert.equal(exists(rollback.envPath), false);
    } finally {
      rmSync(rollbackRoot, { recursive: true, force: true });
    }
  } finally {
    restoreEnvironment(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("install validates all identity before creating files", () => {
  const original = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), "xingheng-runtime-reject-"));
  try {
    setInstallContext();
    const paths = installPaths(root);
    assert.throws(
      () => installRealTestRuntime(
        REVISION,
        "/candidate/code",
        Buffer.from(`${environmentSource()}UNKNOWN=1\n`),
        {
          ...paths,
          testOnlyPaths: true,
          expectedUid: process.getuid(),
          expectedGid: process.getgid(),
          deriveReceipt: () => receiptFixture(),
          inspectImages: () => assert.fail("image inspection must not run"),
        },
      ),
      /schema is invalid|identity is invalid/u,
    );
    assert.equal(exists(paths.selectorPath), false);
    assert.equal(exists(paths.envPath), false);
    assert.throws(
      () => installRealTestRuntime(
        REVISION,
        "/candidate/code",
        Buffer.from(environmentSource()),
        {
          ...paths,
          testOnlyPaths: true,
          expectedUid: process.getuid(),
          expectedGid: process.getgid(),
          deriveReceipt: () => receiptFixture(),
          inspectImages: () => {
            throw new Error("old image revision mismatch");
          },
        },
      ),
      /old image revision mismatch/u,
    );
    assert.equal(exists(paths.selectorPath), false);
    assert.equal(exists(paths.envPath), false);
  } finally {
    restoreEnvironment(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime final paths reject symlink and mutable file boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-runtime-boundary-"));
  try {
    const target = join(root, "runtime-release.json");
    const linked = join(root, "linked");
    writeFileSync(target, `${JSON.stringify(receiptFixture())}\n`, { mode: 0o400 });
    symlinkSync(target, linked);
    const options = {
      selectorPath: linked,
      envPath: join(root, "runtime.env"),
      testOnlyPaths: true,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    };
    assert.throws(
      () => readRealTestRuntimeContext("/candidate/code", options),
      /file boundary is invalid/u,
    );
    chmodSync(target, 0o600);
    assert.throws(
      () => readRealTestRuntimeContext("/candidate/code", {
        ...options,
        selectorPath: target,
      }),
      /file boundary is invalid/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function receiptFixture() {
  const candidateRoot = `/opt/xingheng-real-test-release/candidates/${REVISION}`;
  return {
    schemaVersion: 1,
    environment: "real-test",
    revision: REVISION,
    candidateRoot,
    codeRoot: `${candidateRoot}/code`,
    candidateReceiptSha256: "1".repeat(64),
    sourceArchiveSha256: "2".repeat(64),
    candidateTreeSha256: "3".repeat(64),
    manifestPath: `${candidateRoot}/release-manifest.json`,
    manifestSha256: "4".repeat(64),
    checksumsPath: `${candidateRoot}/RELEASE_SHA256SUMS`,
    checksumsSha256: "5".repeat(64),
    images: {
      api: `sha256:${"6".repeat(64)}`,
      web: `sha256:${"7".repeat(64)}`,
      strategyTools: `sha256:${"8".repeat(64)}`,
    },
    socket: "/var/run/docker.sock",
    binaries: Object.fromEntries(
      ["compose", "docker", "findmnt", "flock", "git", "node", "sh", "sha256sum", "tar"]
        .map((name) => [name, { path: `/usr/bin/${name}`, sha256: "9".repeat(64) }]),
    ),
    daemon: {
      id: "fixture-daemon-id",
      rootDir: "/var/lib/docker",
      serverVersion: "29.0.0",
      storageDriver: "overlay2",
    },
    envPath: "/etc/xingheng-real-test/runtime.env",
  };
}

function environmentSource() {
  const values = Object.fromEntries(REAL_TEST_RUNTIME_ENV_KEYS.map((key) => [key, "1"]));
  Object.assign(values, {
    XINGHENG_REVISION: REVISION,
    RWA_CREDENTIAL_KEY_PROVIDER: "gcp-kms",
    RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
    RWA_GCP_KMS_KEY_NAME:
      "projects/xingheng-real-test/locations/asia-southeast1/keyRings/r/cryptoKeys/k",
    RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL:
      "runtime@xingheng-real-test.iam.gserviceaccount.com",
    RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
    RWA_AUTOMATION_EXECUTION_MODE: "single-host",
    RWA_AUTOMATION_INSTANCE_COUNT: "1",
    WEB_CONCURRENCY: "1",
  });
  return `${REAL_TEST_RUNTIME_ENV_KEYS.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
}

function installPaths(root) {
  return {
    parentPath: root,
    selectorPath: join(root, "runtime-release.json"),
    envPath: join(root, "runtime.env"),
  };
}

function setInstallContext() {
  process.env.XINGHENG_OPERATION_LOCK_CONTEXT = "real-test-runtime-install";
  process.env.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT = "real-test";
  process.env.XINGHENG_RELEASE_CANDIDATE_REVISION = REVISION;
}

function restoreEnvironment(original) {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
