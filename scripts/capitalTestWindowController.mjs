#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAPITAL_TEST_WINDOW_EXECUTION_MODE,
  CAPITAL_TEST_WINDOW_HOST_ROOT,
  CAPITAL_TEST_WINDOW_MAX_DURATION_MS,
  advanceCapitalTestWindowLease,
  assertCapitalTestWindowStateRoot,
  createActiveCapitalTestWindowReceipt,
  readCapitalTestWindowReceipt,
  terminateCapitalTestWindowReceipt,
  validateCapitalTestWindowReceipt,
} from "./capitalTestWindowReceipt.mjs";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import {
  PERMIT_INSTALL_RECEIPT,
  readInstallReceipt,
} from "./productionSelfTestPermitInstall.mjs";

const TRUSTED_OPERATIONS_RECEIPT = "/etc/xingheng/trusted-operations.json";
const WRAPPER = "/opt/xingheng-release/code/scripts/capital-test-window.sh";
const LAUNCHER = "/opt/xingheng-release/code/scripts/trusted-operation-launcher.mjs";
const COMPLETED_DIRECTORY = "completed";
const HEARTBEAT_INTERVAL_MS = 1_000;

export function initializeCapitalTestWindowStateRoot(options = {}) {
  const root = resolve(options.rootPath ?? CAPITAL_TEST_WINDOW_HOST_ROOT);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  assertSecureParent(dirname(root), expectedUid, expectedGid);
  createDirectory(root, 0o555);
  const completed = resolve(root, COMPLETED_DIRECTORY);
  createDirectory(completed, 0o555);
  assertCapitalTestWindowStateRoot(root, { expectedUid, expectedGid });
  assertDirectory(completed, expectedUid, expectedGid, 0o555);
  const rootEntries = readdirSync(root).sort();
  if (rootEntries.some((name) => !["current.json", COMPLETED_DIRECTORY].includes(name))) {
    throw new Error("Capital Test window state root contains unknown files");
  }
  if (rootEntries.includes("current.json")) {
    readCapitalTestWindowReceipt(resolve(root, "current.json"), {
      rootPath: root,
      expectedUid,
      expectedGid,
    });
  }
  for (const name of readdirSync(completed)) {
    if (!/^operation-[a-f0-9]{32}\.json$/u.test(name)) {
      throw new Error("Capital Test window archive contains unknown files");
    }
    const archivePath = resolve(completed, name);
    const metadata = lstatSync(archivePath);
    if (!secureReceiptFile(metadata, expectedUid, expectedGid)) {
      throw new Error("Capital Test window archive boundary is invalid");
    }
    const receipt = validateCapitalTestWindowReceipt(JSON.parse(
      readSecureReceiptFile(archivePath, expectedUid, expectedGid).toString("utf8"),
    ));
    if (receipt.state === "active" || name !== `operation-${receipt.operationId}.json`) {
      throw new Error("Capital Test window archive receipt is invalid");
    }
  }
  return root;
}

export async function runCapitalTestWindowController(options = {}) {
  const root = resolve(options.rootPath ?? CAPITAL_TEST_WINDOW_HOST_ROOT);
  const currentPath = resolve(root, "current.json");
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  initializeCapitalTestWindowStateRoot({ rootPath: root, expectedUid, expectedGid });
  if (exists(currentPath)) throw new Error("Capital Test window has already been attempted");

  const installReceipt = options.installReceipt
    ?? readInstallReceipt(options.permitReceiptPath ?? PERMIT_INSTALL_RECEIPT);
  if (
    installReceipt.status !== "success"
    || installReceipt.permit.executionMode !== CAPITAL_TEST_WINDOW_EXECUTION_MODE
    || installReceipt.request.executionMode !== CAPITAL_TEST_WINDOW_EXECUTION_MODE
  ) throw new Error("Capital Test Permit is not eligible for a window");

  const now = options.now ?? (() => new Date());
  const started = exactDate(now(), "Capital Test window controller time is invalid");
  const permitEndMs = Date.parse(installReceipt.expiresAt);
  if (permitEndMs <= started.getTime()) throw new Error("Capital Test Permit has expired");
  const hardEndAt = new Date(Math.min(
    permitEndMs,
    started.getTime() + CAPITAL_TEST_WINDOW_MAX_DURATION_MS,
  ));
  if (hardEndAt.getTime() <= started.getTime()) throw new Error("Capital Test window duration is invalid");

  const trustedOperationsReceiptSha256 = options.trustedOperationsReceiptSha256
    ?? sha256SecureRootFile(TRUSTED_OPERATIONS_RECEIPT);
  let receipt = createActiveCapitalTestWindowReceipt({
    operationId: options.operationId,
    windowId: options.windowId ?? randomBytes(16).toString("hex"),
    executionMode: installReceipt.permit.executionMode,
    ownerUserIdSha256: sha256Text(installReceipt.permit.ownerUserId),
    permitDigest: installReceipt.permit.digest,
    authorizationManifestSha256: installReceipt.request.authorizationManifestSha256,
    accountBindingSha256: installReceipt.permit.accountBindingSha256,
    releaseRevision: installReceipt.releaseIdentity.releaseRevision,
    releaseTreeSha256: installReceipt.releaseIdentity.releaseTreeSha256,
    releaseManifestSha256: installReceipt.releaseIdentity.releaseManifestSha256,
    apiImageDigest: installReceipt.releaseIdentity.apiImageDigest,
    webImageDigest: installReceipt.releaseIdentity.webImageDigest,
    trustedOperationsReceiptSha256,
    startAt: started,
    hardEndAt,
  });
  writeCurrentReceipt(currentPath, receipt, null, { expectedUid, expectedGid });

  let stopReason = null;
  let controllerError = null;
  const stopForSignal = () => { stopReason = "signal"; };
  if (options.manageSignals !== false) {
    process.once("SIGINT", stopForSignal);
    process.once("SIGTERM", stopForSignal);
    process.once("SIGHUP", stopForSignal);
  }
  try {
    while (stopReason === null) {
      const currentTime = exactDate(now(), "Capital Test window controller time is invalid");
      if (currentTime.getTime() >= Date.parse(receipt.hardEndAt)) {
        stopReason = "expired";
        break;
      }
      await (options.sleep ?? sleep)(HEARTBEAT_INTERVAL_MS);
      if (stopReason !== null) break;
      const nextTime = exactDate(now(), "Capital Test window controller time is invalid");
      if (nextTime.getTime() >= Date.parse(receipt.hardEndAt)) {
        stopReason = "expired";
        break;
      }
      const next = advanceCapitalTestWindowLease(receipt, nextTime);
      writeCurrentReceipt(currentPath, next, receipt.digest, { expectedUid, expectedGid });
      receipt = next;
      options.onLease?.(receipt);
    }
  } catch (error) {
    controllerError = error;
    stopReason = "controller_error";
  } finally {
    if (options.manageSignals !== false) {
      process.removeListener("SIGINT", stopForSignal);
      process.removeListener("SIGTERM", stopForSignal);
      process.removeListener("SIGHUP", stopForSignal);
    }
  }

  const terminalTime = exactDate(now(), "Capital Test window terminal time is invalid");
  const terminal = terminateCapitalTestWindowReceipt(
    receipt,
    stopReason === "controller_error" ? "unknown" : "closed",
    stopReason ?? "completed",
    terminalTime,
  );
  writeCurrentReceipt(currentPath, terminal, receipt.digest, { expectedUid, expectedGid });
  writeArchiveReceipt(root, terminal, { expectedUid, expectedGid });
  if (controllerError) throw controllerError;
  return terminal;
}

function writeCurrentReceipt(path, receipt, expectedDigest, options) {
  if (expectedDigest !== null) {
    const current = readCapitalTestWindowReceipt(path, {
      rootPath: dirname(path),
      expectedUid: options.expectedUid,
      expectedGid: options.expectedGid,
    });
    if (current.digest !== expectedDigest) throw new Error("Capital Test window receipt changed before update");
  } else if (exists(path)) {
    throw new Error("Capital Test window has already been attempted");
  }
  atomicWriteReceipt(path, receipt);
  const installed = readCapitalTestWindowReceipt(path, {
    rootPath: dirname(path),
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
  });
  if (installed.digest !== receipt.digest) throw new Error("Capital Test window receipt installation failed");
}

function writeArchiveReceipt(root, receipt, options) {
  const path = resolve(root, COMPLETED_DIRECTORY, `operation-${receipt.operationId}.json`);
  if (exists(path)) throw new Error("Capital Test window archive already exists");
  atomicWriteReceipt(path, receipt);
  const metadata = lstatSync(path);
  if (!secureReceiptFile(metadata, options.expectedUid, options.expectedGid)) {
    throw new Error("Capital Test window archive installation failed");
  }
}

function atomicWriteReceipt(path, receipt) {
  const validated = validateCapitalTestWindowReceipt(receipt);
  const directory = dirname(path);
  const pending = resolve(directory, `.pending-${process.pid}-${randomBytes(8).toString("hex")}`);
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(validated)}\n`, "utf8");
    fsyncSync(fd);
    fchmodSync(fd, 0o444);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(pending, path);
    fsyncDirectory(directory);
  } finally {
    rmSync(pending, { force: true });
  }
}

function assertTrustedMutationContext(operationId) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("Capital Test window requires controlled Linux root");
  }
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
    || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY !== "capital-test-window.sh"
    || process.env.XINGHENG_CAPITAL_TEST_WINDOW_OPERATION_ID !== operationId
    || !/^[a-f0-9]{32}$/u.test(operationId)
  ) throw new Error("Capital Test window trusted wrapper context is invalid");
  inheritedOperationLocks("production");
  assertTrustedDescriptor(WRAPPER, 6, "Capital Test window trusted wrapper descriptor is invalid");
  assertTrustedDescriptor(LAUNCHER, 7, "Capital Test window trusted launcher descriptor is invalid");
}

function assertTrustedDescriptor(path, descriptorNumber, message) {
  const pathMetadata = lstatSync(path);
  const descriptor = fstatSync(descriptorNumber);
  if (
    !pathMetadata.isFile()
    || pathMetadata.isSymbolicLink()
    || pathMetadata.nlink !== 1
    || pathMetadata.uid !== 0
    || pathMetadata.gid !== 0
    || (pathMetadata.mode & 0o022) !== 0
    || (pathMetadata.mode & 0o111) === 0
    || descriptor.dev !== pathMetadata.dev
    || descriptor.ino !== pathMetadata.ino
    || descriptor.size !== pathMetadata.size
    || descriptor.uid !== 0
    || descriptor.gid !== 0
    || descriptor.nlink !== 1
  ) throw new Error(message);
}

function createDirectory(path, mode) {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700, recursive: false });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created) chmodSync(path, mode);
}

function assertSecureParent(path, expectedUid, expectedGid) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== expectedUid
    || metadata.gid !== expectedGid
    || (metadata.mode & 0o022) !== 0
  ) throw new Error("Capital Test window parent boundary is invalid");
}

function assertDirectory(path, uid, gid, mode) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.gid !== gid
    || (metadata.mode & 0o777) !== mode
  ) throw new Error("Capital Test window directory boundary is invalid");
}

function secureReceiptFile(metadata, uid, gid) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && metadata.uid === uid
    && metadata.gid === gid
    && (metadata.mode & 0o777) === 0o444
    && metadata.size >= 2
    && metadata.size <= 64 * 1024;
}

function sha256SecureRootFile(path) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o777) !== 0o400
    || metadata.size < 2
    || metadata.size > 1024 * 1024
  ) throw new Error("Trusted operations receipt boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
      || opened.mtimeMs !== metadata.mtimeMs
      || opened.ctimeMs !== metadata.ctimeMs
    ) throw new Error("Trusted operations receipt changed while opening");
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function readSecureReceiptFile(path, uid, gid) {
  const before = lstatSync(path);
  if (!secureReceiptFile(before, uid, gid)) {
    throw new Error("Capital Test window archive boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) throw new Error("Capital Test window archive changed while opening");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function exactDate(value, message) {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw new Error(message);
  return value;
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

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function main() {
  if (process.argv[2] !== "run" || process.argv.length !== 4) {
    throw new Error("usage: capitalTestWindowController.mjs run OPERATION_ID");
  }
  const operationId = process.argv[3];
  assertTrustedMutationContext(operationId);
  const terminal = await runCapitalTestWindowController({ operationId });
  process.stdout.write(JSON.stringify({
    ok: true,
    state: terminal.state,
    operationId: terminal.operationId,
    receiptDigest: terminal.digest,
  }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Capital Test window failed");
    process.exitCode = 1;
  });
}
