import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT_FILES = Object.freeze([
  "Dockerfile",
  "compose.yaml",
  "package.json",
  "package-lock.json",
  "deploy/Caddyfile",
  "deploy/release-manifest.json",
  "deploy/rwa-automation-current.json",
]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export function captureTrustedReleaseTree(root, options = {}) {
  const canonicalRoot = resolve(root);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  validateDirectoryChain(canonicalRoot, expectedUid, expectedGid);
  const scriptDirectory = join(canonicalRoot, "scripts");
  validateDirectoryChain(scriptDirectory, expectedUid, expectedGid, canonicalRoot);
  const scriptFiles = readdirSync(scriptDirectory)
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|sh)$/u.test(name))
    .map((name) => `scripts/${name}`)
    .sort();
  const paths = [...ROOT_FILES, ...scriptFiles].sort();
  if (new Set(paths).size !== paths.length || scriptFiles.length < 20) {
    throw new Error("trusted release operational file set is invalid");
  }
  const files = paths.map((path) =>
    secureFileReceipt(canonicalRoot, path, expectedUid, expectedGid));
  const sha256 = createHash("sha256")
    .update(`${JSON.stringify(files)}\n`, "utf8")
    .digest("hex");
  return Object.freeze({
    schemaVersion: 1,
    fileCount: files.length,
    sha256,
    files: Object.freeze(files),
  });
}

export function validateTrustedReleaseTreeReceipt(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "fileCount,files,schemaVersion,sha256"
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.fileCount)
    || value.fileCount < 20
    || !SHA256.test(value.sha256 ?? "")
    || !Array.isArray(value.files)
    || value.files.length !== value.fileCount
  ) {
    throw new Error("trusted release tree receipt schema is invalid");
  }
  const paths = new Set();
  for (const item of value.files) {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== [
        "ctimeMs", "dev", "gid", "ino", "mode", "mtimeMs", "nlink",
        "path", "sha256", "size", "uid",
      ].sort().join(",")
      || !/^(?:Dockerfile|package(?:-lock)?\.json|compose\.yaml|deploy\/[A-Za-z0-9._-]+|scripts\/[A-Za-z0-9._-]+\.(?:mjs|sh))$/u
        .test(item.path ?? "")
      || paths.has(item.path)
      || !Number.isSafeInteger(item.dev)
      || !Number.isSafeInteger(item.ino)
      || !Number.isSafeInteger(item.size)
      || item.size < 1
      || item.size > MAX_FILE_BYTES
      || item.uid !== 0
      || item.gid !== 0
      || item.nlink !== 1
      || !Number.isSafeInteger(item.mode)
      || (item.mode & 0o022) !== 0
      || !Number.isFinite(item.mtimeMs)
      || !Number.isFinite(item.ctimeMs)
      || !SHA256.test(item.sha256 ?? "")
    ) {
      throw new Error("trusted release tree file receipt is invalid");
    }
    paths.add(item.path);
  }
  const digest = createHash("sha256")
    .update(`${JSON.stringify(value.files)}\n`, "utf8")
    .digest("hex");
  if (digest !== value.sha256) throw new Error("trusted release tree receipt digest is invalid");
  return value;
}

export function assertTrustedReleaseTree(root, expected) {
  validateTrustedReleaseTreeReceipt(expected);
  const current = captureTrustedReleaseTree(root);
  if (current.sha256 !== expected.sha256 || JSON.stringify(current.files) !== JSON.stringify(expected.files)) {
    throw new Error("trusted release tree identity mismatch");
  }
  return current;
}

function secureFileReceipt(root, relativePath, expectedUid, expectedGid) {
  const path = resolve(root, relativePath);
  if (relative(root, path).startsWith("..")) {
    throw new Error("trusted release file escaped the canonical root");
  }
  validateDirectoryChain(dirname(path), expectedUid, expectedGid, root);
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || before.gid !== expectedGid
    || before.size < 1
    || before.size > MAX_FILE_BYTES
    || (before.mode & 0o022) !== 0
  ) {
    throw new Error("trusted release operational file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== expectedUid
      || opened.gid !== expectedGid
      || opened.nlink !== 1
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || (opened.mode & 0o777) !== (before.mode & 0o777)
    ) {
      throw new Error("trusted release operational file changed while opening");
    }
    const sha256 = hashDescriptor(fd, opened.size);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("trusted release operational file changed while reading");
    }
    return Object.freeze({
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
      sha256,
    });
  } finally {
    closeSync(fd);
  }
}

function validateDirectoryChain(start, expectedUid, expectedGid, stop = "/") {
  let current = resolve(start);
  const boundary = resolve(stop);
  while (true) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== expectedUid
      || metadata.gid !== expectedGid
      || (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("trusted release directory chain is invalid");
    }
    if (current === boundary) return;
    const parent = dirname(current);
    if (
      parent === current
      || (boundary !== "/" && !current.startsWith(`${boundary}/`))
    ) {
      throw new Error("trusted release directory escaped the canonical root");
    }
    current = parent;
  }
}

function hashDescriptor(fd, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  try {
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) throw new Error("trusted release operational file was truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
  }
}
