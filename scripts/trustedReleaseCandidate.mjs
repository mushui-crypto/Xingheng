import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export const PRODUCTION_RELEASE_CANDIDATES_ROOT = "/opt/xingheng-release/candidates";
export const REAL_TEST_RELEASE_CANDIDATES_ROOT =
  "/opt/xingheng-real-test-release/candidates";
export const CANDIDATE_RECEIPT_NAME = "candidate-build-receipt.json";
export const CANDIDATE_ARCHIVE_NAME = "code.tar";
export const CANDIDATE_MANIFEST_NAME = "release-manifest.json";
export const CANDIDATE_CHECKSUMS_NAME = "RELEASE_SHA256SUMS";

const FULL_REVISION = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SOURCE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;

export function releaseCandidatePaths(revision, deploymentEnvironment, options = {}) {
  assertRevision(revision);
  const candidatesRoot = trustedReleaseCandidatesRoot(deploymentEnvironment, options);
  const candidateRoot = join(candidatesRoot, revision);
  return Object.freeze({
    candidatesRoot,
    candidateRoot,
    codeRoot: join(candidateRoot, "code"),
    archive: join(candidateRoot, CANDIDATE_ARCHIVE_NAME),
    receipt: join(candidateRoot, CANDIDATE_RECEIPT_NAME),
    manifest: join(candidateRoot, CANDIDATE_MANIFEST_NAME),
    checksums: join(candidateRoot, CANDIDATE_CHECKSUMS_NAME),
    incomingArchive: join(candidatesRoot, `.incoming-${revision}.tar`),
  });
}

export function trustedReleaseCandidatesRoot(deploymentEnvironment, options = {}) {
  if (deploymentEnvironment !== "production" && deploymentEnvironment !== "real-test") {
    throw new Error("trusted candidate deployment environment is invalid");
  }
  if (options.candidatesRoot !== undefined) {
    if (
      process.env.NODE_TEST_CONTEXT === undefined
      || options.testOnlyCandidatesRoot !== true
      || typeof options.candidatesRoot !== "string"
      || !options.candidatesRoot.startsWith("/")
    ) {
      throw new Error("trusted candidate root override is not allowed");
    }
    return options.candidatesRoot;
  }
  return deploymentEnvironment === "production"
    ? PRODUCTION_RELEASE_CANDIDATES_ROOT
    : REAL_TEST_RELEASE_CANDIDATES_ROOT;
}

export function captureTrustedCandidateTree(root, options = {}) {
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const canonicalRoot = resolve(root);
  const entries = [];
  walk(canonicalRoot, ".", entries, expectedUid, expectedGid);
  if (entries.length < 20 || entries.length > MAX_TREE_ENTRIES) {
    throw new Error("trusted candidate tree entry count is invalid");
  }
  const fileCount = entries.filter((entry) => entry.type === "file").length;
  const directoryCount = entries.length - fileCount;
  const byteCount = entries.reduce(
    (total, entry) => total + (entry.type === "file" ? entry.size : 0),
    0,
  );
  const sha256 = createHash("sha256")
    .update(`${JSON.stringify(entries)}\n`, "utf8")
    .digest("hex");
  return Object.freeze({
    schemaVersion: 1,
    entryCount: entries.length,
    fileCount,
    directoryCount,
    byteCount,
    sha256,
  });
}

export function readTrustedReleaseCandidateReceipt(revision, deploymentEnvironment, options = {}) {
  const paths = releaseCandidatePaths(revision, deploymentEnvironment, options);
  validateCandidateDirectoryBoundary(paths, options);
  const receipt = readSecureFile(paths.receipt, 0o400, options);
  if (receipt.bytes.length < 2 || receipt.bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error("trusted candidate receipt size is invalid");
  }
  const value = validateCandidateReceipt(
    JSON.parse(receipt.bytes.toString("utf8")),
    revision,
    paths,
    options,
  );
  const archive = secureArtifactReceipt(paths.archive, 0o400, options);
  if (canonicalJson(archive) !== canonicalJson(value.sourceArchive)) {
    throw new Error("trusted candidate source archive identity mismatch");
  }
  const tree = captureTrustedCandidateTree(paths.codeRoot, options);
  if (canonicalJson(tree) !== canonicalJson(value.candidateTree)) {
    throw new Error("trusted candidate tree identity mismatch");
  }
  return Object.freeze({
    ...value,
    receiptSha256: createHash("sha256").update(receipt.bytes).digest("hex"),
  });
}

export function assertTrustedReleaseCandidateRoot(
  currentRoot,
  revision,
  deploymentEnvironment,
  options = {},
) {
  const paths = releaseCandidatePaths(revision, deploymentEnvironment, options);
  const actual = resolve(currentRoot);
  if (actual !== paths.codeRoot || basename(dirname(actual)) !== revision) {
    throw new Error("trusted candidate release root identity mismatch");
  }
  const receipt = readTrustedReleaseCandidateReceipt(revision, deploymentEnvironment, options);
  if (receipt.codeRoot !== actual) {
    throw new Error("trusted candidate release root receipt mismatch");
  }
  return Object.freeze({ root: actual, receipt, paths });
}

export function secureArtifactReceipt(path, expectedMode, options = {}) {
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
    || before.size < 1
    || before.size > MAX_SOURCE_FILE_BYTES
  ) {
    throw new Error("trusted candidate artifact boundary is invalid");
  }
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
      || (opened.mode & 0o777) !== expectedMode
    ) {
      throw new Error("trusted candidate artifact changed while opening");
    }
    const receipt = Object.freeze({
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      uid: opened.uid,
      gid: opened.gid,
      nlink: opened.nlink,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: sha256Descriptor(fd, opened.size),
    });
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("trusted candidate artifact changed while reading");
    }
    return receipt;
  } finally {
    closeSync(fd);
  }
}

export function validateCandidateReceipt(value, revision, paths, options = {}) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "binaries",
      "candidateRoot",
      "candidateTree",
      "codeRoot",
      "daemon",
      "revision",
      "schemaVersion",
      "socket",
      "sourceArchive",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || value.revision !== revision
    || value.candidateRoot !== paths.candidateRoot
    || value.codeRoot !== paths.codeRoot
    || value.socket !== "/var/run/docker.sock"
  ) {
    throw new Error("trusted candidate receipt schema is invalid");
  }
  validateTreeReceipt(value.candidateTree);
  validateArtifactReceipt(
    value.sourceArchive,
    options.expectedUid ?? 0,
    options.expectedGid ?? 0,
  );
  if (
    !value.binaries
    || typeof value.binaries !== "object"
    || Array.isArray(value.binaries)
    || Object.keys(value.binaries).sort().join(",") !== [
      "compose", "docker", "findmnt", "flock", "git", "node", "sh", "sha256sum", "tar",
    ].sort().join(",")
  ) {
    throw new Error("trusted candidate binary receipt set is invalid");
  }
  for (const item of Object.values(value.binaries)) {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "path,sha256"
      || typeof item.path !== "string"
      || !item.path.startsWith("/")
      || !SHA256.test(item.sha256 ?? "")
    ) {
      throw new Error("trusted candidate binary receipt is invalid");
    }
  }
  const daemon = value.daemon;
  if (
    !daemon
    || typeof daemon !== "object"
    || Array.isArray(daemon)
    || Object.keys(daemon).sort().join(",") !== "id,rootDir,serverVersion,storageDriver"
    || !/^[A-Za-z0-9:+._-]{8,128}$/u.test(daemon.id ?? "")
    || typeof daemon.rootDir !== "string"
    || !daemon.rootDir.startsWith("/")
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]*)?$/u.test(daemon.serverVersion ?? "")
    || !/^[A-Za-z0-9._-]{2,64}$/u.test(daemon.storageDriver ?? "")
  ) {
    throw new Error("trusted candidate Docker daemon receipt is invalid");
  }
  return value;
}

function walk(root, relativePath, entries, expectedUid, expectedGid) {
  const path = relativePath === "." ? root : join(root, relativePath);
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink()
    || metadata.uid !== expectedUid
    || metadata.gid !== expectedGid
    || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("trusted candidate tree boundary is invalid");
  }
  if (metadata.isDirectory()) {
    entries.push(directoryEntry(relativePath, metadata));
    const names = readdirSync(path).sort();
    for (const name of names) {
      if (name === "." || name === ".." || name.includes("/")) {
        throw new Error("trusted candidate tree path is invalid");
      }
      const child = relativePath === "." ? name : join(relativePath, name);
      walk(root, child, entries, expectedUid, expectedGid);
    }
    return;
  }
  if (
    !metadata.isFile()
    || metadata.nlink !== 1
    || metadata.size < 1
    || metadata.size > MAX_SOURCE_FILE_BYTES
  ) {
    throw new Error("trusted candidate source file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
      || opened.uid !== expectedUid
      || opened.gid !== expectedGid
      || opened.mtimeMs !== metadata.mtimeMs
      || opened.ctimeMs !== metadata.ctimeMs
      || (opened.mode & 0o777) !== (metadata.mode & 0o777)
    ) {
      throw new Error("trusted candidate source file changed while opening");
    }
    entries.push({
      type: "file",
      path: relativePath,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      uid: opened.uid,
      gid: opened.gid,
      nlink: opened.nlink,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: sha256Descriptor(fd, opened.size),
    });
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("trusted candidate source file changed while reading");
    }
  } finally {
    closeSync(fd);
  }
}

function directoryEntry(path, metadata) {
  return {
    type: "directory",
    path,
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

function readSecureFile(path, expectedMode, options) {
  const receipt = secureArtifactReceipt(path, expectedMode, options);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== receipt.dev
      || opened.ino !== receipt.ino
      || opened.size !== receipt.size
    ) {
      throw new Error("trusted candidate receipt changed while reopening");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256
    ) {
      throw new Error("trusted candidate receipt changed while being read");
    }
    return { receipt, bytes };
  } finally {
    closeSync(fd);
  }
}

function validateCandidateDirectoryBoundary(paths, options) {
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const fixedModes = new Map([
    [paths.candidatesRoot, 0o700],
    [paths.candidateRoot, 0o700],
    [paths.codeRoot, 0o700],
  ]);
  for (const [path, mode] of fixedModes) {
    const metadata = lstatSync(path);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== expectedUid
      || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== mode
    ) {
      throw new Error("trusted candidate directory boundary is invalid");
    }
  }
  if (options.skipParentChain === true) return;
  let current = dirname(paths.candidatesRoot);
  while (true) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== expectedUid
      || (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("trusted candidate parent directory boundary is invalid");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validateTreeReceipt(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "byteCount", "directoryCount", "entryCount", "fileCount", "schemaVersion", "sha256",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.entryCount)
    || value.entryCount < 20
    || value.entryCount > MAX_TREE_ENTRIES
    || !Number.isSafeInteger(value.fileCount)
    || !Number.isSafeInteger(value.directoryCount)
    || value.fileCount + value.directoryCount !== value.entryCount
    || !Number.isSafeInteger(value.byteCount)
    || value.byteCount < 1
    || !SHA256.test(value.sha256 ?? "")
  ) {
    throw new Error("trusted candidate tree receipt schema is invalid");
  }
}

function validateArtifactReceipt(value, expectedUid, expectedGid) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "ctimeMs", "dev", "gid", "ino", "mode", "mtimeMs", "nlink",
      "sha256", "size", "uid",
    ].sort().join(",")
    || !Number.isSafeInteger(value.dev)
    || !Number.isSafeInteger(value.ino)
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || value.size > MAX_SOURCE_FILE_BYTES
    || value.uid !== expectedUid
    || value.gid !== expectedGid
    || value.nlink !== 1
    || value.mode !== 0o400
    || !Number.isFinite(value.mtimeMs)
    || !Number.isFinite(value.ctimeMs)
    || !SHA256.test(value.sha256 ?? "")
  ) {
    throw new Error("trusted candidate source archive receipt is invalid");
  }
}

function assertRevision(value) {
  if (!FULL_REVISION.test(value ?? "")) {
    throw new Error("trusted candidate revision must be a full lowercase Git commit");
  }
}

function sha256Descriptor(fd, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  try {
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) throw new Error("trusted candidate artifact was truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
