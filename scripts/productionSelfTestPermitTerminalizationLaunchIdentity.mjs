import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertCapitalTestWindowLaunchIdentity } from "./capitalTestWindowLaunchIdentity.mjs";
import { assertPromotionStateAllowsProduction } from "./releasePromotionTransaction.mjs";

export const PERMIT_TERMINALIZATION_ROOT =
  "/var/lib/xingheng/production-self-test-permit-terminalization";

const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;

export function assertPermitTerminalizationLaunchIdentity(input, options = {}) {
  const operationId = exact(input?.operationId, HEX_32, "Permit terminalization operation ID is invalid");
  const sourceReceiptSha256 = exact(
    input?.sourceReceiptSha256,
    HEX_64,
    "Permit terminalization source SHA256 is invalid",
  );
  const prepared = readPreparedIfPresent(
    options.rootPath ?? PERMIT_TERMINIZATION_ROOT,
    operationId,
    sourceReceiptSha256,
    options,
  );
  try {
    const active = (options.verifyActiveTransition ?? assertCapitalTestWindowLaunchIdentity)();
    if (prepared?.completed === true) throw new Error("Permit terminalization has already completed");
    return Object.freeze({ state: "permit_active", promotion: active, prepared: prepared !== null });
  } catch (activeError) {
    let baseline;
    try {
      baseline = (options.verifyPromotionBaseline ?? assertPromotionStateAllowsProduction)();
    } catch {
      throw activeError;
    }
    if (prepared === null || prepared.completed) {
      throw new Error("Permit terminalization resume journal is missing or terminal");
    }
    return Object.freeze({ state: "baseline_restored", promotion: baseline, prepared: true });
  }
}

function readPreparedIfPresent(rootPath, operationId, sourceReceiptSha256, options) {
  const root = resolve(rootPath);
  if (!exists(root)) return null;
  assertDirectory(root, options);
  const entries = readdirSync(root).sort();
  if (entries.length !== 1 || entries[0] !== operationId) {
    throw new Error("Permit terminalization operation set is invalid");
  }
  const operationRoot = resolve(root, operationId);
  assertDirectory(operationRoot, options);
  const names = readdirSync(operationRoot).sort();
  const phaseNames = names.filter((name) => !/^(?:prepared|environment-restored|api-restarted|terminal-receipt)\.json\.[0-9]+\.[a-f0-9]{16}\.tmp$/u.test(name));
  if (!phaseNames.includes("prepared.json")
    || phaseNames.some((name) => ![
      "api-restarted.json",
      "environment-restored.json",
      "prepared.json",
      "terminal-receipt.json",
    ].includes(name))) {
    throw new Error("Permit terminalization journal set is invalid");
  }
  const prepared = readSecureJson(resolve(operationRoot, "prepared.json"), options);
  const preparedKeys = [
    "apiImageDigest", "envAfterSha256", "envBeforeSha256", "environmentBeforeIdentity",
    "environmentProposedIdentity", "expiresAt", "kind", "operationId", "permitDigestSha256",
    "preRuntime", "releaseRevision", "schemaVersion", "sourceAttemptIdentity",
    "sourceAttemptReceiptSha256", "sourceReceiptIdentity", "sourceReceiptSha256", "startedAt", "state",
  ];
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)
    || Object.keys(prepared).sort().join(",") !== preparedKeys.sort().join(",")
    || prepared.schemaVersion !== 1
    || prepared.kind !== "expired_success_permit_terminalization"
    || prepared.state !== "prepared"
    || prepared.operationId !== operationId
    || prepared.sourceReceiptSha256 !== sourceReceiptSha256) {
    throw new Error("Permit terminalization prepared identity mismatch");
  }
  return { completed: phaseNames.includes("terminal-receipt.json") };
}

function readSecureJson(path, options) {
  const before = lstatSync(path);
  const owner = expectedOwner(options);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== owner.uid || before.gid !== owner.gid
    || (before.mode & 0o777) !== 0o400 || before.size < 2 || before.size > 64 * 1024) {
    throw new Error("Permit terminalization launch journal boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) {
      throw new Error("Permit terminalization launch journal changed while opening");
    }
    const value = JSON.parse(readFileSync(fd, "utf8"));
    const after = fstatSync(fd);
    if (!sameFile(opened, after)) {
      throw new Error("Permit terminalization launch journal changed while reading");
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

function assertDirectory(path, options) {
  const value = lstatSync(path);
  const owner = expectedOwner(options);
  if (!value.isDirectory() || value.isSymbolicLink()
    || value.uid !== owner.uid || value.gid !== owner.gid || (value.mode & 0o777) !== 0o700) {
    throw new Error("Permit terminalization launch journal directory is invalid");
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && (left.mode & 0o777) === (right.mode & 0o777);
}

function expectedOwner(options) {
  return options.testMode === true
    ? { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }
    : { uid: 0, gid: 0 };
}

function exact(value, pattern, message) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(message);
  return value;
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
