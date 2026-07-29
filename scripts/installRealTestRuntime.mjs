import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  REAL_TEST_RUNTIME_ENV,
  REAL_TEST_RUNTIME_PARENT,
  REAL_TEST_RUNTIME_SELECTOR,
  assertRuntimeParent,
  closeRealTestRuntimeContext,
  deriveRealTestRuntimeReceipt,
  parseRealTestRuntimeEnvironment,
  readRealTestRuntimeContext,
} from "./realTestRuntimeReceipt.mjs";
import { execTrustedDockerSync } from "./trustedDockerRuntime.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;

export function installRealTestRuntime(
  revision,
  controlRoot,
  environmentBytes,
  options = {},
) {
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "real-test-runtime-install"
    || process.env.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT !== "real-test"
    || process.env.XINGHENG_RELEASE_CANDIDATE_REVISION !== revision
  ) throw new Error("real-test runtime install context is invalid");
  if (!Buffer.isBuffer(environmentBytes) || environmentBytes.length > MAX_INPUT_BYTES) {
    throw new Error("real-test runtime install input is invalid");
  }
  const environment = parseRealTestRuntimeEnvironment(
    environmentBytes.toString("utf8"),
    revision,
  );
  const derive = options.deriveReceipt ?? deriveRealTestRuntimeReceipt;
  const receipt = derive(revision, controlRoot, options.contextOptions);
  const inspect = options.inspectImages ?? inspectRuntimeImages;
  inspect(receipt);
  if (
    environment.XINGHENG_REVISION !== receipt.revision
    || receipt.envPath !== REAL_TEST_RUNTIME_ENV
  ) throw new Error("real-test runtime install identity mismatch");

  const paths = resolveRealTestRuntimeInstallPaths(options);
  const parent = ensureParent(paths.parentPath, options);
  const selectorPath = paths.selectorPath;
  const envPath = paths.envPath;
  if (exists(selectorPath) || exists(envPath)) {
    throw new Error("real-test runtime final state is not MISSING");
  }
  const envPending = join(parent, ".runtime.env.pending");
  const selectorPending = join(parent, ".runtime-release.json.pending");
  if (exists(envPending) || exists(selectorPending)) {
    throw new Error("real-test runtime pending state already exists");
  }
  const selectorBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  let envFile;
  let selectorFile;
  let envPublished;
  let selectorPublished;
  try {
    const expectedUid = options.expectedUid ?? 0;
    const expectedGid = options.expectedGid ?? 0;
    envFile = writePending(envPending, environmentBytes, expectedUid, expectedGid);
    selectorFile = writePending(
      selectorPending,
      selectorBytes,
      expectedUid,
      expectedGid,
    );
    envPublished = publishExclusive(envPending, envPath, envFile);
    options.beforeSelectorPublish?.();
    selectorPublished = publishExclusive(selectorPending, selectorPath, selectorFile);
    fsyncDirectory(parent);
    const verifyPublished = options.verifyPublished ?? verifyPublishedRuntime;
    verifyPublished(controlRoot, options);
    return receipt;
  } catch (error) {
    cleanupOwned(selectorPath, selectorPublished);
    cleanupOwned(envPath, envPublished);
    cleanupOwned(selectorPending, selectorFile);
    cleanupOwned(envPending, envFile);
    fsyncDirectory(parent);
    throw error;
  } finally {
    if (envFile) closeSync(envFile.fd);
    if (selectorFile) closeSync(selectorFile.fd);
    selectorBytes.fill(0);
  }
}

function verifyPublishedRuntime(controlRoot, options) {
  const context = readRealTestRuntimeContext(controlRoot, {
    ...options.contextOptions,
    selectorPath: options.selectorPath,
    envPath: options.envPath,
    testOnlyPaths: options.testOnlyPaths,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
  });
  closeRealTestRuntimeContext(context);
}

export function readBoundedRuntimeEnvironment(fd = 0) {
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      total += count;
      if (total > MAX_INPUT_BYTES) {
        chunk.fill(0);
        throw new Error("real-test runtime install input is too large");
      }
      chunks.push(chunk.subarray(0, count));
    }
    if (total < 2) throw new Error("real-test runtime install input is empty");
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function inspectRuntimeImages(receipt) {
  for (const digest of Object.values(receipt.images)) {
    const inspected = JSON.parse(execTrustedDockerSync([
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      digest,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    }));
    if (
      inspected?.Id !== digest
      || inspected?.Os !== "linux"
      || inspected?.Architecture !== "amd64"
      || inspected?.Config?.Labels?.["org.opencontainers.image.revision"]
        !== receipt.revision
    ) throw new Error("real-test runtime image identity mismatch");
  }
}

export function resolveRealTestRuntimeInstallPaths(options = {}) {
  return Object.freeze({
    parentPath: pathFor(options.parentPath, REAL_TEST_RUNTIME_PARENT, options),
    selectorPath: pathFor(options.selectorPath, REAL_TEST_RUNTIME_SELECTOR, options),
    envPath: pathFor(options.envPath, REAL_TEST_RUNTIME_ENV, options),
  });
}

function ensureParent(parent, options) {
  try {
    mkdirSync(parent, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return assertRuntimeParent({
    ...options,
    parentPath: parent,
  });
}

function writePending(path, bytes, expectedUid, expectedGid) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    fchmodSync(fd, 0o400);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    fsyncSync(fd);
    const value = fstatSync(fd);
    if (
      !value.isFile()
      || value.nlink !== 1
      || value.uid !== expectedUid
      || value.gid !== expectedGid
      || (value.mode & 0o777) !== 0o400
    ) throw new Error("real-test runtime pending boundary is invalid");
    return { fd, dev: value.dev, ino: value.ino };
  } catch (error) {
    const opened = fstatSync(fd);
    closeSync(fd);
    cleanupOwned(path, { dev: opened.dev, ino: opened.ino });
    throw error;
  }
}

function publishExclusive(pending, finalPath, receipt) {
  let linked = false;
  try {
    linkSync(pending, finalPath);
    linked = true;
    const final = lstatSync(finalPath);
    if (final.dev !== receipt.dev || final.ino !== receipt.ino || final.nlink !== 2) {
      throw new Error("real-test runtime publication identity mismatch");
    }
    unlinkSync(pending);
    const published = lstatSync(finalPath);
    if (
      published.dev !== receipt.dev
      || published.ino !== receipt.ino
      || published.nlink !== 1
      || (published.mode & 0o777) !== 0o400
    ) throw new Error("real-test runtime publication boundary is invalid");
    return { dev: published.dev, ino: published.ino };
  } catch (error) {
    if (linked) cleanupOwned(finalPath, receipt);
    throw error;
  }
}

function cleanupOwned(path, receipt) {
  if (!receipt) return;
  try {
    const value = lstatSync(path);
    if (value.dev === receipt.dev && value.ino === receipt.ino) unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

function pathFor(value, expected, options) {
  if (value === undefined) return expected;
  if (value === expected) return expected;
  if (
    process.env.NODE_TEST_CONTEXT === undefined
    || options.testOnlyPaths !== true
    || typeof value !== "string"
    || !value.startsWith("/")
  ) throw new Error("real-test runtime install path override is not allowed");
  return value;
}
