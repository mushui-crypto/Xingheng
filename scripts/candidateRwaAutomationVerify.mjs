#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import {
  assertFullRevision,
  assertImageDigest,
  REVISION_LABEL,
  validateReleaseManifest,
} from "./deploymentRevision.mjs";
import {
  assertTrustedReleaseCandidateRoot,
  releaseCandidatePaths,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";
import {
  assertTrustedProductionReleaseRoot,
  CandidateRwaVerifyDockerError,
  candidateRwaVerifyDockerArguments,
  execCandidateRwaVerifyDockerSync,
} from "./trustedDockerRuntime.mjs";

const PRODUCTION_ROOT = "/opt/xingheng-release/code";
const PRODUCTION_ENV = `${PRODUCTION_ROOT}/.env.production`;
const PRODUCTION_MANIFEST = `${PRODUCTION_ROOT}/deploy/release-manifest.json`;
const BACKUP_NAME = /^rwa-automation-([0-9]{8}T[0-9]{6}Z)\.rwa\.enc\.json$/u;
const CANONICAL_WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]{5,19}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/u;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const HOST_FAILURES = Object.freeze({
  candidate_identity: Object.freeze(["candidate_identity_invalid"]),
  production_identity: Object.freeze(["production_identity_invalid"]),
  docker_identity: Object.freeze(["docker_identity_invalid"]),
  wif_identity: Object.freeze(["wif_identity_invalid"]),
  sts_exchange: Object.freeze(["sts_exchange_failed"]),
  kms_health: Object.freeze(["kms_health_failed"]),
  kms_decrypt: Object.freeze(["kms_decrypt_failed"]),
  backup_envelope: Object.freeze(["backup_envelope_invalid"]),
  backup_authentication: Object.freeze(["backup_authentication_failed"]),
  backup_content: Object.freeze(["backup_content_invalid"]),
  container_receipt: Object.freeze(["container_receipt_invalid", "docker_execution_unknown"]),
  post_identity: Object.freeze([
    "candidate_identity_drift", "production_identity_drift", "docker_identity_drift",
  ]),
});

export function runCandidateRwaAutomationVerify(backupName, dependencies = {}) {
  const candidateRoot = dependencies.candidateRoot
    ?? new URL("../", import.meta.url).pathname.replace(/\/$/u, "");
  const candidateRevision = dependencies.candidateRevision
    ?? process.env.XINGHENG_RELEASE_CANDIDATE_REVISION;
  const candidateReader = dependencies.readCandidateIdentity ?? readCandidateIdentity;
  const productionReader = dependencies.readProductionIdentity ?? readProductionIdentity;
  const docker = dependencies.execDocker ?? execCandidateRwaVerifyDockerSync;

  assertBackupName(backupName);
  assertFullRevision(candidateRevision, "candidate verify revision");
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "candidate-verify"
    || basename(dirname(resolve(candidateRoot))) !== candidateRevision
  ) throw categorized("candidate_identity", "candidate_identity_invalid");
  let candidate;
  try {
    candidate = candidateReader(candidateRoot, candidateRevision);
  } catch {
    throw categorized("candidate_identity", "candidate_identity_invalid");
  }
  let production;
  try {
    production = productionReader();
  } catch {
    throw categorized("production_identity", "production_identity_invalid");
  }

  const contract = Object.freeze({
    candidateRevision,
    apiDigest: candidate.manifest.images.api,
    backupName,
    domain: production.domain,
    wifAudience: production.wifAudience,
  });
  let inspected;
  try {
    inspected = docker(
      ["image", "inspect", "--format", "{{json .}}", contract.apiDigest],
      contract,
      { maxBuffer: MAX_JSON_BYTES },
    );
    validateCandidateApiInspection(inspected, contract);
  } catch {
    throw categorized("docker_identity", "docker_identity_invalid");
  }

  let containerReceipt;
  let output;
  try {
    output = docker(candidateVerifyDockerArguments(contract), contract, {
      maxBuffer: MAX_JSON_BYTES,
    });
  } catch (error) {
    if (error instanceof CandidateRwaVerifyDockerError) {
      throw categorized(error.failure.stage, error.failure.category);
    }
    throw categorized("container_receipt", "docker_execution_unknown");
  }
  try {
    containerReceipt = validateContainerReceipt(output, backupName);
  } catch {
    throw categorized("container_receipt", "container_receipt_invalid");
  }

  try {
    const afterCandidate = candidateReader(candidateRoot, candidateRevision);
    if (identityJson(afterCandidate) !== identityJson(candidate)) {
      throw new Error("candidate identity changed");
    }
  } catch {
    throw categorized("post_identity", "candidate_identity_drift");
  }
  try {
    const afterProduction = productionReader();
    if (identityJson(afterProduction) !== identityJson(production)) {
      throw new Error("production identity changed");
    }
  } catch {
    throw categorized("post_identity", "production_identity_drift");
  }
  try {
    const afterInspection = docker(
      ["image", "inspect", "--format", "{{json .}}", contract.apiDigest],
      contract,
      { maxBuffer: MAX_JSON_BYTES },
    );
    validateCandidateApiInspection(afterInspection, contract);
  } catch {
    throw categorized("post_identity", "docker_identity_drift");
  }

  return Object.freeze({
    schemaVersion: 1,
    operation: "candidate-rwa-backup-verify",
    readOnly: true,
    candidateRevision,
    candidateApiDigest: contract.apiDigest,
    productionRevision: production.manifest.revision,
    backupId: containerReceipt.backupId,
    fileCount: containerReceipt.fileCount,
    plaintextBytes: containerReceipt.plaintextBytes,
    candidateReceiptSha256: candidate.receiptSha256,
    candidateManifestSha256: candidate.manifestSha256,
    productionReceiptSha256: production.receiptSha256,
    productionEnvSha256: production.envSha256,
    productionManifestSha256: production.manifestSha256,
  });
}

export function readCandidateIdentity(candidateRoot, candidateRevision, options = {}) {
  const trusted = assertTrustedReleaseCandidateRoot(candidateRoot, candidateRevision, options);
  const paths = releaseCandidatePaths(candidateRevision, options);
  const manifestFile = readSecureFile(paths.manifest, 0o444, MAX_JSON_BYTES, options);
  const checksumsFile = readSecureFile(paths.checksums, 0o444, MAX_JSON_BYTES, options);
  const manifest = validateReleaseManifest(JSON.parse(manifestFile.text));
  if (manifest.revision !== candidateRevision) {
    throw new Error("candidate manifest revision mismatch");
  }
  const receiptFile = secureArtifactReceipt(paths.receipt, 0o400, options);
  const archiveFile = secureArtifactReceipt(paths.archive, 0o400, options);
  const expectedChecksums = [
    `${archiveFile.sha256}  code.tar`,
    `${receiptFile.sha256}  candidate-build-receipt.json`,
    `${manifestFile.sha256}  release-manifest.json`,
    "",
  ].join("\n");
  if (checksumsFile.text !== expectedChecksums) {
    throw new Error("candidate checksums identity mismatch");
  }
  if (
    archiveFile.sha256 !== trusted.receipt.sourceArchive.sha256
    || receiptFile.sha256 !== trusted.receipt.receiptSha256
  ) throw new Error("candidate artifact receipt mismatch");
  return Object.freeze({
    revision: candidateRevision,
    receiptSha256: receiptFile.sha256,
    treeSha256: trusted.receipt.candidateTree.sha256,
    archiveSha256: archiveFile.sha256,
    manifest,
    manifestSha256: manifestFile.sha256,
    checksumsSha256: checksumsFile.sha256,
    manifestFileIdentity: manifestFile.identity,
    checksumsFileIdentity: checksumsFile.identity,
  });
}

export function readProductionIdentity(options = {}) {
  const trusted = options.readTrustedProduction?.()
    ?? assertTrustedProductionReleaseRoot(PRODUCTION_ROOT);
  const envFile = readSecureFile(
    options.envPath ?? PRODUCTION_ENV,
    0o600,
    MAX_ENV_BYTES,
    options,
  );
  const manifestFile = readSecureFile(
    options.manifestPath ?? PRODUCTION_MANIFEST,
    0o444,
    MAX_JSON_BYTES,
    options,
  );
  const entries = parseEnvironmentEntries(envFile.bytes);
  const manifest = validateReleaseManifest(JSON.parse(manifestFile.text));
  const revision = requireEnvironment(entries, "XINGHENG_REVISION");
  assertFullRevision(revision, "production environment revision");
  const mappings = [
    ["XINGHENG_API_IMAGE", manifest.images.api],
    ["XINGHENG_WEB_IMAGE", manifest.images.web],
    ["XINGHENG_STRATEGY_TOOLS_IMAGE", manifest.images.strategyTools],
  ];
  if (revision !== manifest.revision) {
    throw new Error("production revision identity mismatch");
  }
  for (const [name, expected] of mappings) {
    const value = requireEnvironment(entries, name);
    assertImageDigest(value, `production ${name}`);
    if (value !== expected) throw new Error("production image identity mismatch");
  }
  const wifAudience = requireEnvironment(entries, "RWA_GCP_WIF_AUDIENCE");
  if (!CANONICAL_WIF_AUDIENCE.test(wifAudience)) {
    throw new Error("production WIF audience identity mismatch");
  }
  const domain = requireEnvironment(entries, "DOMAIN");
  if (!validProductionDomain(domain)) {
    throw new Error("production domain identity mismatch");
  }
  return Object.freeze({
    releaseTreeSha256: trusted.releaseTree.sha256,
    receiptSha256: trusted.receiptSha256,
    envSha256: envFile.sha256,
    manifest,
    manifestSha256: manifestFile.sha256,
    wifAudience,
    domain,
    envFileIdentity: envFile.identity,
    manifestFileIdentity: manifestFile.identity,
  });
}

export function candidateVerifyDockerArguments(contract) {
  return [...candidateRwaVerifyDockerArguments(contract)];
}

export function validateCandidateApiInspection(output, contract) {
  const value = parseSingleJsonLine(output);
  if (
    !value
    || typeof value !== "object"
    || value.Id !== contract.apiDigest
    || value.Os !== "linux"
    || value.Architecture !== "amd64"
    || value.Comment !== "buildkit.dockerfile.v0"
    || value.Config?.Labels?.[REVISION_LABEL] !== contract.candidateRevision
  ) throw new Error("candidate API image identity mismatch");
  return value;
}

export function validateContainerReceipt(output, backupName) {
  const value = parseSingleJsonLine(output);
  const backupId = BACKUP_NAME.exec(backupName)?.[1];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "backupId", "fileCount", "operation", "plaintextBytes", "readOnly", "schemaVersion",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || value.operation !== "verify"
    || value.readOnly !== true
    || value.backupId !== backupId
    || !nonnegativeSafeInteger(value.fileCount)
    || !nonnegativeSafeInteger(value.plaintextBytes)
  ) throw new Error("candidate backup verify receipt is invalid");
  return Object.freeze(value);
}

export function parseEnvironmentEntries(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) {
    throw new Error("production environment encoding is invalid");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("production environment encoding is invalid");
  }
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/u.exec(line);
    if (!match || entries.has(match[1])) {
      throw new Error("production environment assignment is invalid");
    }
    if (
      match[1].startsWith("DOCKER_")
      || match[1].startsWith("COMPOSE_")
      || match[1] === "XINGHENG_COMPOSE_ENV_FD"
    ) throw new Error("production environment contains Docker control input");
    const parsed = parseEnvironmentValue(match[2]);
    if (
      match[1] === "DOMAIN"
      && (
        ![parsed, `'${parsed}'`, `"${parsed}"`].includes(match[2])
        || parsed !== parsed.trim()
        || /\s/u.test(parsed)
      )
    ) throw new Error("production domain identity mismatch");
    entries.set(match[1], parsed);
  }
  if (entries.size === 0) throw new Error("production environment is empty");
  return entries;
}

export function readSecureFile(path, expectedMode, maxBytes, options = {}) {
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || before.gid !== expectedGid
    || (before.mode & 0o777) !== expectedMode
    || before.size < 2
    || before.size > maxBytes
  ) throw new Error("secure verifier file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== expectedUid
      || opened.gid !== expectedGid
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || (opened.mode & 0o777) !== expectedMode
    ) throw new Error("secure verifier file changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("secure verifier file changed while reading");
    return Object.freeze({
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: Object.freeze({
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        uid: opened.uid,
        gid: opened.gid,
        mode: opened.mode & 0o777,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
      }),
    });
  } finally {
    closeSync(fd);
  }
}

function assertBackupName(value) {
  if (typeof value !== "string" || !BACKUP_NAME.test(value)) {
    throw categorized("input_invalid");
  }
}

function requireEnvironment(entries, name) {
  const value = entries.get(name);
  if (typeof value !== "string" || value === "") {
    throw new Error("production environment identity is incomplete");
  }
  return value;
}

function parseEnvironmentValue(source) {
  const value = source.trim();
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new Error("production environment quote is invalid");
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw new Error("production environment quote is invalid");
    }
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\r", "\r");
  }
  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function parseSingleJsonLine(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_JSON_BYTES) {
    throw new Error("candidate verifier output is invalid");
  }
  const match = /^([^\r\n]+)(?:\r?\n)?$/u.exec(output);
  if (!match) throw new Error("candidate verifier output is invalid");
  return JSON.parse(match[1]);
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validProductionDomain(value) {
  return typeof value === "string"
    && value === value.trim()
    && !value.includes("://")
    && !value.includes("/")
    && !value.includes(":")
    && !value.includes("@")
    && !value.includes("*")
    && value !== "localhost"
    && !/^[0-9.]+$/u.test(value)
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(value);
}

function identityJson(value) {
  return JSON.stringify(value);
}

function categorized(stage, category) {
  const error = new Error(category);
  error.stage = stage;
  error.category = category;
  return error;
}

export function candidateRwaVerifyFailureReceipt(error) {
  const stage = error?.stage;
  const category = error?.category;
  const allowed = HOST_FAILURES[stage];
  if (!Array.isArray(allowed) || !allowed.includes(category)) {
    return candidateRwaVerifyFailureReceipt(categorized(
      "candidate_identity",
      "candidate_identity_invalid",
    ));
  }
  return {
    schemaVersion: 1,
    operation: "candidate-rwa-backup-verify",
    ok: false,
    readOnly: true,
    stage,
    category,
  };
}

async function main() {
  const backupName = process.argv[2];
  if (
    process.argv.length !== 3
    || process.platform !== "linux"
    || process.getuid?.() !== 0
    || process.getgid?.() !== 0
  ) {
    process.stdout.write(`${JSON.stringify(candidateRwaVerifyFailureReceipt(
      categorized("candidate_identity", "candidate_identity_invalid"),
    ))}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    inheritedOperationLocks("candidate-verify");
    const receipt = runCandidateRwaAutomationVerify(backupName);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(candidateRwaVerifyFailureReceipt(error))}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) await main();
