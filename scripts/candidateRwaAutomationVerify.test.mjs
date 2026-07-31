import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidateVerifyDockerArguments,
  parseEnvironmentEntries,
  readCandidateIdentity,
  readProductionIdentity,
  readSecureFile,
  runCandidateRwaAutomationVerify,
  validateCandidateApiInspection,
  validateContainerReceipt,
} from "./candidateRwaAutomationVerify.mjs";
import {
  captureTrustedCandidateTree,
  releaseCandidatePaths,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";

const REVISION = "a".repeat(40);
const PRODUCTION_REVISION = "b".repeat(40);
const API_DIGEST = `sha256:${"1".repeat(64)}`;
const WEB_DIGEST = `sha256:${"2".repeat(64)}`;
const STRATEGY_DIGEST = `sha256:${"3".repeat(64)}`;
const BACKUP = "rwa-automation-20260801T120000Z.rwa.enc.json";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/xingheng-rwa-prod/providers/vultr-x509";
const DOMAIN = "trade.stellarx.example";

test("candidate verifier emits one stable receipt from exact identities", () => {
  withOperationEnvironment(() => {
    const candidate = candidateIdentity();
    const production = productionIdentity();
    const calls = [];
    const receipt = runCandidateRwaAutomationVerify(BACKUP, {
      candidateRoot: `/opt/xingheng-release/candidates/${REVISION}/code`,
      candidateRevision: REVISION,
      readCandidateIdentity: () => candidate,
      readProductionIdentity: () => production,
      execDocker(args, contract) {
        calls.push(args);
        if (args[0] === "image") return `${imageInspection(contract)}\n`;
        return `${JSON.stringify({
          schemaVersion: 1,
          operation: "verify",
          backupId: "20260801T120000Z",
          fileCount: 7,
          plaintextBytes: 4096,
          readOnly: true,
        })}\n`;
      },
    });
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      operation: "candidate-rwa-backup-verify",
      readOnly: true,
      candidateRevision: REVISION,
      candidateApiDigest: API_DIGEST,
      productionRevision: PRODUCTION_REVISION,
      backupId: "20260801T120000Z",
      fileCount: 7,
      plaintextBytes: 4096,
      candidateReceiptSha256: "4".repeat(64),
      candidateManifestSha256: "5".repeat(64),
      productionReceiptSha256: "8".repeat(64),
      productionEnvSha256: "9".repeat(64),
      productionManifestSha256: "c".repeat(64),
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1], candidateVerifyDockerArguments({
      candidateRevision: REVISION,
      apiDigest: API_DIGEST,
      backupName: BACKUP,
      domain: DOMAIN,
      wifAudience: AUDIENCE,
    }));
    assert.doesNotMatch(JSON.stringify(receipt), /iam\.googleapis|trade\.stellarx|RWA_|wrapped|ciphertext|daemon/u);
  });
});

test("candidate verifier fails closed on identity drift and raw output injection", () => {
  withOperationEnvironment(() => {
    let reads = 0;
    assert.throws(
      () => runCandidateRwaAutomationVerify(BACKUP, {
        candidateRoot: `/opt/xingheng-release/candidates/${REVISION}/code`,
        candidateRevision: REVISION,
        readCandidateIdentity: () => ({
          ...candidateIdentity(),
          manifestSha256: reads++ === 0 ? "5".repeat(64) : "6".repeat(64),
        }),
        readProductionIdentity: () => productionIdentity(),
        execDocker(args, contract) {
          if (args[0] === "image") return `${imageInspection(contract)}\n`;
          return `${JSON.stringify({
            schemaVersion: 1,
            operation: "verify",
            backupId: "20260801T120000Z",
            fileCount: 1,
            plaintextBytes: 1,
            readOnly: true,
          })}\n`;
        },
      }),
      /candidate_identity_invalid/u,
    );
    assert.throws(
      () => validateContainerReceipt(
        `${JSON.stringify(validContainerReceipt())}\nsecret-extra-line\n`,
        BACKUP,
      ),
      /output is invalid/u,
    );
    assert.throws(
      () => validateContainerReceipt(`\n${JSON.stringify(validContainerReceipt())}\n`, BACKUP),
      /output is invalid/u,
    );
  });
});

test("image and container receipts reject tag, revision, schema and basename drift", () => {
  const contract = {
    candidateRevision: REVISION,
    apiDigest: API_DIGEST,
    backupName: BACKUP,
    domain: DOMAIN,
    wifAudience: AUDIENCE,
  };
  assert.doesNotThrow(() => validateCandidateApiInspection(imageInspection(contract), contract));
  for (const value of [
    { ...JSON.parse(imageInspection(contract)), Id: `xingheng-api:${REVISION}` },
    {
      ...JSON.parse(imageInspection(contract)),
      Config: { Labels: { "org.opencontainers.image.revision": PRODUCTION_REVISION } },
    },
    { ...JSON.parse(imageInspection(contract)), Architecture: "arm64" },
  ]) {
    assert.throws(() => validateCandidateApiInspection(JSON.stringify(value), contract));
  }
  assert.doesNotThrow(() => validateContainerReceipt(JSON.stringify(validContainerReceipt()), BACKUP));
  for (const value of [
    { ...validContainerReceipt(), backupId: "20260801T120001Z" },
    { ...validContainerReceipt(), plaintext: "secret" },
    { ...validContainerReceipt(), fileCount: -1 },
    { ...validContainerReceipt(), plaintextBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => validateContainerReceipt(JSON.stringify(value), BACKUP));
});

test("production identity reads only canonical mappings and rejects duplicates or mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-candidate-verify-"));
  try {
    const envPath = join(root, ".env.production");
    const manifestPath = join(root, "release-manifest.json");
    const options = {
      envPath,
      manifestPath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      readTrustedProduction: () => ({
        releaseTree: { sha256: "7".repeat(64) },
        receiptSha256: "8".repeat(64),
      }),
    };
    writeFixture(envPath, productionEnvironment(), 0o600);
    writeFixture(manifestPath, `${JSON.stringify(productionIdentity().manifest)}\n`, 0o444);
    const identity = readProductionIdentity(options);
    assert.equal(identity.manifest.revision, PRODUCTION_REVISION);
    assert.equal(identity.wifAudience, AUDIENCE);
    assert.equal(identity.domain, DOMAIN);

    writeFixture(envPath, `${productionEnvironment()}XINGHENG_REVISION=${PRODUCTION_REVISION}\n`, 0o600);
    assert.throws(() => readProductionIdentity(options), /assignment is invalid/u);
    writeFixture(envPath, productionEnvironment().replace(API_DIGEST, WEB_DIGEST), 0o600);
    assert.throws(() => readProductionIdentity(options), /image identity mismatch/u);
    for (const invalid of [
      "", "localhost", "127.0.0.1", "https://trade.stellarx.example",
      "trade.stellarx.example/path", "trade.stellarx.example:443", " trade.stellarx.example ",
    ]) {
      writeFixture(
        envPath,
        productionEnvironment().replace(`DOMAIN=${DOMAIN}`, `DOMAIN='${invalid}'`),
        0o600,
      );
      assert.throws(() => readProductionIdentity(options), /domain identity mismatch|identity is incomplete/u);
    }
    writeFixture(envPath, productionEnvironment().replace(
      `DOMAIN=${DOMAIN}`,
      `DOMAIN=${DOMAIN} # comment`,
    ), 0o600);
    assert.throws(() => readProductionIdentity(options), /domain identity mismatch/u);
    writeFixture(envPath, productionEnvironment().replace(`DOMAIN=${DOMAIN}\n`, ""), 0o600);
    assert.throws(() => readProductionIdentity(options), /identity is incomplete/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate identity binds receipt, tree, manifest and exact checksum set", () => {
  withCandidateFixture(({ paths, options }) => {
    const identity = readCandidateIdentity(paths.codeRoot, REVISION, options);
    assert.equal(identity.manifest.images.api, API_DIGEST);
    assert.match(identity.manifestSha256, /^[a-f0-9]{64}$/u);

    chmodSync(paths.checksums, 0o644);
    assert.throws(
      () => readCandidateIdentity(paths.codeRoot, REVISION, options),
      /file boundary is invalid/u,
    );
  });
  withCandidateFixture(({ paths, options }) => {
    chmodSync(paths.checksums, 0o600);
    writeFileSync(paths.checksums, `${"0".repeat(64)}  code.tar\n`, { mode: 0o444 });
    chmodSync(paths.checksums, 0o444);
    assert.throws(
      () => readCandidateIdentity(paths.codeRoot, REVISION, options),
      /checksums identity mismatch/u,
    );
  });
  withCandidateFixture(({ paths, options }) => {
    chmodSync(paths.manifest, 0o600);
    writeFileSync(paths.manifest, `${JSON.stringify({
      ...candidateIdentity().manifest,
      revision: PRODUCTION_REVISION,
    })}\n`, { mode: 0o444 });
    chmodSync(paths.manifest, 0o444);
    writeCandidateChecksums(paths, options);
    assert.throws(
      () => readCandidateIdentity(paths.codeRoot, REVISION, options),
      /manifest revision mismatch/u,
    );
  });
});

test("secure verifier reads reject permissive modes and environment parser rejects controls", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-secure-verify-"));
  try {
    const path = join(root, "value");
    writeFixture(path, "{}\n", 0o444);
    assert.equal(readSecureFile(path, 0o444, 1024, {
      expectedUid: process.getuid(), expectedGid: process.getgid(),
    }).text, "{}\n");
    chmodSync(path, 0o666);
    assert.throws(() => readSecureFile(path, 0o444, 1024, {
      expectedUid: process.getuid(), expectedGid: process.getgid(),
    }), /boundary is invalid/u);
    assert.throws(() => parseEnvironmentEntries(Buffer.from("A=1\nA=2\n")), /assignment is invalid/u);
    assert.throws(() => parseEnvironmentEntries(Buffer.from([65, 61, 0, 10])), /encoding is invalid/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate wrapper rejects caller identity and credential environment", () => {
  const source = readFileSync(
    new URL("./candidate-rwa-automation-verify.sh", import.meta.url),
    "utf8",
  );
  assert.match(source, /DOMAIN=/u);
  assert.match(source, /XINGHENG_WIF_HOST_PATH=/u);
  assert.match(source, /RWA_/u);
  assert.match(source, /GOOGLE_/u);
  assert.match(source, /\/usr\/bin\/env -i/u);
  assert.doesNotMatch(source, /\.env\.production|--env-file/u);
});

function candidateIdentity() {
  return Object.freeze({
    revision: REVISION,
    receiptSha256: "4".repeat(64),
    treeSha256: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    manifest: Object.freeze({
      schemaVersion: 1,
      revision: REVISION,
      images: Object.freeze({ api: API_DIGEST, web: WEB_DIGEST, strategyTools: STRATEGY_DIGEST }),
    }),
    manifestSha256: "5".repeat(64),
    checksumsSha256: "6".repeat(64),
    manifestFileIdentity: Object.freeze({ dev: 1, ino: 2 }),
    checksumsFileIdentity: Object.freeze({ dev: 1, ino: 3 }),
  });
}

function productionIdentity() {
  return Object.freeze({
    releaseTreeSha256: "7".repeat(64),
    receiptSha256: "8".repeat(64),
    envSha256: "9".repeat(64),
    manifest: Object.freeze({
      schemaVersion: 1,
      revision: PRODUCTION_REVISION,
      images: Object.freeze({ api: API_DIGEST, web: WEB_DIGEST, strategyTools: STRATEGY_DIGEST }),
    }),
    manifestSha256: "c".repeat(64),
    wifAudience: AUDIENCE,
    domain: DOMAIN,
    envFileIdentity: Object.freeze({ dev: 1, ino: 4 }),
    manifestFileIdentity: Object.freeze({ dev: 1, ino: 5 }),
  });
}

function imageInspection(contract) {
  return JSON.stringify({
    Id: contract.apiDigest,
    Os: "linux",
    Architecture: "amd64",
    Comment: "buildkit.dockerfile.v0",
    Config: { Labels: { "org.opencontainers.image.revision": contract.candidateRevision } },
  });
}

function validContainerReceipt() {
  return {
    schemaVersion: 1,
    operation: "verify",
    backupId: "20260801T120000Z",
    fileCount: 1,
    plaintextBytes: 1,
    readOnly: true,
  };
}

function productionEnvironment() {
  return [
    `XINGHENG_REVISION=${PRODUCTION_REVISION}`,
    `XINGHENG_API_IMAGE=${API_DIGEST}`,
    `XINGHENG_WEB_IMAGE=${WEB_DIGEST}`,
    `XINGHENG_STRATEGY_TOOLS_IMAGE=${STRATEGY_DIGEST}`,
    `RWA_GCP_WIF_AUDIENCE=${AUDIENCE}`,
    `DOMAIN=${DOMAIN}`,
    "ADMIN_PASSWORD=must-not-escape",
    "",
  ].join("\n");
}

function writeFixture(path, value, mode) {
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
}

function withCandidateFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-candidate-identity-"));
  try {
    chmodSync(root, 0o700);
    const options = {
      candidatesRoot: join(root, "candidates"),
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      skipParentChain: true,
    };
    const paths = releaseCandidatePaths(REVISION, options);
    mkdirSync(paths.codeRoot, { recursive: true, mode: 0o700 });
    for (const path of [paths.candidatesRoot, paths.candidateRoot, paths.codeRoot]) {
      chmodSync(path, 0o700);
    }
    for (let index = 0; index < 24; index += 1) {
      writeFixture(
        join(paths.codeRoot, `source-${String(index).padStart(2, "0")}.txt`),
        `source-${index}\n`,
        0o600,
      );
    }
    writeFixture(paths.archive, "candidate archive\n", 0o400);
    const receipt = {
      schemaVersion: 1,
      revision: REVISION,
      candidateRoot: paths.candidateRoot,
      codeRoot: paths.codeRoot,
      sourceArchive: secureArtifactReceipt(paths.archive, 0o400, options),
      candidateTree: captureTrustedCandidateTree(paths.codeRoot, options),
      socket: "/var/run/docker.sock",
      binaries: Object.fromEntries(
        ["node", "sh", "flock", "findmnt", "git", "tar", "sha256sum", "docker", "compose"]
          .map((name) => [name, { path: `/usr/bin/${name}`, sha256: "1".repeat(64) }]),
      ),
      daemon: {
        id: "fixture-daemon-id",
        rootDir: "/var/lib/docker",
        serverVersion: "29.0.0",
        storageDriver: "overlay2",
      },
    };
    writeFixture(paths.receipt, `${JSON.stringify(receipt)}\n`, 0o400);
    writeFixture(paths.manifest, `${JSON.stringify(candidateIdentity().manifest)}\n`, 0o444);
    writeCandidateChecksums(paths, options);
    callback({ paths, options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeCandidateChecksums(paths, options) {
  const archiveSha = secureArtifactReceipt(paths.archive, 0o400, options).sha256;
  const receiptSha = secureArtifactReceipt(paths.receipt, 0o400, options).sha256;
  const manifestSha = readSecureFile(paths.manifest, 0o444, 64 * 1024, options).sha256;
  if (readFileExists(paths.checksums)) chmodSync(paths.checksums, 0o600);
  writeFixture(paths.checksums, [
    `${archiveSha}  code.tar`,
    `${receiptSha}  candidate-build-receipt.json`,
    `${manifestSha}  release-manifest.json`,
    "",
  ].join("\n"), 0o444);
}

function readFileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function withOperationEnvironment(callback) {
  const before = {
    context: process.env.XINGHENG_OPERATION_LOCK_CONTEXT,
    revision: process.env.XINGHENG_RELEASE_CANDIDATE_REVISION,
  };
  process.env.XINGHENG_OPERATION_LOCK_CONTEXT = "candidate-verify";
  process.env.XINGHENG_RELEASE_CANDIDATE_REVISION = REVISION;
  try {
    callback();
  } finally {
    if (before.context === undefined) delete process.env.XINGHENG_OPERATION_LOCK_CONTEXT;
    else process.env.XINGHENG_OPERATION_LOCK_CONTEXT = before.context;
    if (before.revision === undefined) delete process.env.XINGHENG_RELEASE_CANDIDATE_REVISION;
    else process.env.XINGHENG_RELEASE_CANDIDATE_REVISION = before.revision;
  }
}
