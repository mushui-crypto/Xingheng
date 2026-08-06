import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const CAPITAL_TEST_WINDOW_EXECUTION_MODE = "single_connectivity_smoke";
export const CAPITAL_TEST_WINDOW_HOST_ROOT = "/var/lib/xingheng/capital-test-window";
export const CAPITAL_TEST_WINDOW_RUNTIME_ROOT = "/run/xingheng/capital-test-window";
export const CAPITAL_TEST_WINDOW_MAX_DURATION_MS = 30 * 60_000;
export const CAPITAL_TEST_WINDOW_LEASE_MS = 5_000;

const RECEIPT_KEYS = Object.freeze([
  "accountBindingSha256",
  "apiImageDigest",
  "authorizationManifestSha256",
  "digest",
  "executionMode",
  "hardEndAt",
  "leaseSequence",
  "leaseValidUntil",
  "operationId",
  "ownerUserIdSha256",
  "permitDigest",
  "releaseManifestSha256",
  "releaseRevision",
  "releaseTreeSha256",
  "schemaVersion",
  "startAt",
  "state",
  "terminalAt",
  "terminalReason",
  "trustedOperationsReceiptSha256",
  "webImageDigest",
  "windowId",
]);

const TERMINAL_REASONS = new Set(["completed", "controller_error", "expired", "signal"]);

export function createActiveCapitalTestWindowReceipt(input) {
  const startAt = strictUtc(input.startAt, "Capital Test window start time is invalid");
  const hardEndAt = strictUtc(input.hardEndAt, "Capital Test window end time is invalid");
  const startMs = Date.parse(startAt);
  const hardEndMs = Date.parse(hardEndAt);
  if (hardEndMs <= startMs || hardEndMs - startMs > CAPITAL_TEST_WINDOW_MAX_DURATION_MS) {
    throw new Error("Capital Test window duration is invalid");
  }
  const leaseValidUntil = new Date(Math.min(
    hardEndMs,
    startMs + CAPITAL_TEST_WINDOW_LEASE_MS,
  )).toISOString();
  return withReceiptDigest({
    schemaVersion: 1,
    state: "active",
    operationId: exactHex(input.operationId, 32, "Capital Test window operation is invalid"),
    windowId: exactHex(input.windowId, 32, "Capital Test window identity is invalid"),
    executionMode: exactExecutionMode(input.executionMode),
    ownerUserIdSha256: exactHex(input.ownerUserIdSha256, 64, "Capital Test window owner is invalid"),
    permitDigest: exactHex(input.permitDigest, 64, "Capital Test window Permit is invalid"),
    authorizationManifestSha256: exactHex(
      input.authorizationManifestSha256,
      64,
      "Capital Test window authorization is invalid",
    ),
    accountBindingSha256: exactHex(
      input.accountBindingSha256,
      64,
      "Capital Test window Binding is invalid",
    ),
    releaseRevision: exactHex(input.releaseRevision, 40, "Capital Test window release is invalid"),
    releaseTreeSha256: exactHex(input.releaseTreeSha256, 64, "Capital Test window release tree is invalid"),
    releaseManifestSha256: exactHex(
      input.releaseManifestSha256,
      64,
      "Capital Test window manifest is invalid",
    ),
    apiImageDigest: exactImage(input.apiImageDigest),
    webImageDigest: exactImage(input.webImageDigest),
    trustedOperationsReceiptSha256: exactHex(
      input.trustedOperationsReceiptSha256,
      64,
      "Capital Test trusted operation identity is invalid",
    ),
    startAt,
    hardEndAt,
    leaseSequence: 1,
    leaseValidUntil,
    terminalAt: null,
    terminalReason: null,
  });
}

export function advanceCapitalTestWindowLease(receipt, now = new Date()) {
  const current = validateCapitalTestWindowReceipt(receipt);
  const nowAt = strictUtc(now, "Capital Test window controller time is invalid");
  const nowMs = Date.parse(nowAt);
  const hardEndMs = Date.parse(current.hardEndAt);
  const previousLeaseMs = Date.parse(current.leaseValidUntil);
  if (current.state !== "active" || nowMs < Date.parse(current.startAt) || nowMs >= hardEndMs) {
    throw new Error("Capital Test window cannot advance its lease");
  }
  if (nowMs + CAPITAL_TEST_WINDOW_LEASE_MS < previousLeaseMs) {
    throw new Error("Capital Test window controller time moved backwards");
  }
  return withReceiptDigest({
    ...withoutDigest(current),
    leaseSequence: current.leaseSequence + 1,
    leaseValidUntil: new Date(Math.min(hardEndMs, nowMs + CAPITAL_TEST_WINDOW_LEASE_MS)).toISOString(),
  });
}

export function terminateCapitalTestWindowReceipt(receipt, state, reason, now = new Date()) {
  const current = validateCapitalTestWindowReceipt(receipt);
  if (current.state !== "active" || !["closed", "unknown"].includes(state) || !TERMINAL_REASONS.has(reason)) {
    throw new Error("Capital Test window terminal transition is invalid");
  }
  const terminalAt = strictUtc(now, "Capital Test window terminal time is invalid");
  const terminalMs = Date.parse(terminalAt);
  if (terminalMs < Date.parse(current.startAt)) {
    throw new Error("Capital Test window terminal time is invalid");
  }
  return withReceiptDigest({
    ...withoutDigest(current),
    state,
    leaseValidUntil: new Date(Math.min(terminalMs, Date.parse(current.hardEndAt))).toISOString(),
    terminalAt,
    terminalReason: reason,
  });
}

export function assertCapitalTestWindowAllowsNewRisk(permit, options = {}) {
  const receipt = readCapitalTestWindowReceipt(
    options.path ?? resolve(CAPITAL_TEST_WINDOW_RUNTIME_ROOT, "current.json"),
    options,
  );
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowAt = strictUtc(now, "Capital Test window runtime time is invalid");
  const nowMs = Date.parse(nowAt);
  if (
    receipt.state !== "active"
    || receipt.executionMode !== CAPITAL_TEST_WINDOW_EXECUTION_MODE
    || permit?.executionMode !== CAPITAL_TEST_WINDOW_EXECUTION_MODE
    || receipt.permitDigest !== permit?.digest
    || receipt.authorizationManifestSha256 !== permit?.authorizationDigest
    || receipt.accountBindingSha256 !== permit?.accountBindingSha256
    || receipt.ownerUserIdSha256 !== sha256(String(permit?.ownerUserId ?? ""))
    || receipt.releaseRevision !== permit?.revision
    || nowMs < Date.parse(receipt.startAt)
    || nowMs >= Date.parse(receipt.hardEndAt)
    || nowMs >= Date.parse(receipt.leaseValidUntil)
  ) throw new Error("Capital Test window is closed");
  return receipt;
}

export function readCapitalTestWindowReceipt(path, options = {}) {
  const resolvedPath = resolve(path);
  const root = resolve(options.rootPath ?? dirname(resolvedPath));
  if (resolvedPath !== resolve(root, "current.json")) {
    throw new Error("Capital Test window receipt path is invalid");
  }
  assertCapitalTestWindowStateRoot(root, options);
  const before = lstatSync(resolvedPath);
  assertWindowFile(before, options);
  const fd = openSync(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw new Error("Capital Test window receipt changed while opening");
    const bytes = readFileSync(fd);
    try {
      const after = fstatSync(fd);
      if (!sameFile(opened, after)) throw new Error("Capital Test window receipt changed while reading");
      return validateCapitalTestWindowReceipt(JSON.parse(bytes.toString("utf8")));
    } finally {
      bytes.fill(0);
    }
  } finally {
    closeSync(fd);
  }
}

export function validateCapitalTestWindowReceipt(value) {
  const receipt = exactObject(value, RECEIPT_KEYS, "Capital Test window receipt is invalid");
  if (
    receipt.schemaVersion !== 1
    || !["active", "closed", "unknown"].includes(receipt.state)
    || !/^[a-f0-9]{32}$/u.test(receipt.operationId ?? "")
    || !/^[a-f0-9]{32}$/u.test(receipt.windowId ?? "")
    || receipt.executionMode !== CAPITAL_TEST_WINDOW_EXECUTION_MODE
    || !/^[a-f0-9]{64}$/u.test(receipt.ownerUserIdSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.permitDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.authorizationManifestSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.accountBindingSha256 ?? "")
    || !/^[a-f0-9]{40}$/u.test(receipt.releaseRevision ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.releaseTreeSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.releaseManifestSha256 ?? "")
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.apiImageDigest ?? "")
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.webImageDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.trustedOperationsReceiptSha256 ?? "")
    || !isStrictUtc(receipt.startAt)
    || !isStrictUtc(receipt.hardEndAt)
    || !Number.isSafeInteger(receipt.leaseSequence)
    || receipt.leaseSequence < 1
    || !isStrictUtc(receipt.leaseValidUntil)
    || !/^[a-f0-9]{64}$/u.test(receipt.digest ?? "")
    || receipt.digest !== capitalTestWindowReceiptDigest(receipt)
  ) throw new Error("Capital Test window receipt is invalid");
  const startMs = Date.parse(receipt.startAt);
  const hardEndMs = Date.parse(receipt.hardEndAt);
  const leaseMs = Date.parse(receipt.leaseValidUntil);
  if (
    hardEndMs <= startMs
    || hardEndMs - startMs > CAPITAL_TEST_WINDOW_MAX_DURATION_MS
    || leaseMs < startMs
    || leaseMs > hardEndMs
  ) throw new Error("Capital Test window receipt timeline is invalid");
  if (receipt.state === "active") {
    if (receipt.terminalAt !== null || receipt.terminalReason !== null) {
      throw new Error("Capital Test active window has terminal evidence");
    }
  } else if (!isStrictUtc(receipt.terminalAt) || !TERMINAL_REASONS.has(receipt.terminalReason)) {
    throw new Error("Capital Test terminal window evidence is invalid");
  }
  return Object.freeze({ ...receipt });
}

export function capitalTestWindowReceiptDigest(receipt) {
  return sha256(canonicalJson(withoutDigest(receipt)));
}

export function assertCapitalTestWindowStateRoot(rootPath, options = {}) {
  const root = lstatSync(resolve(rootPath));
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  if (
    !root.isDirectory()
    || root.isSymbolicLink()
    || root.uid !== expectedUid
    || root.gid !== expectedGid
    || (root.mode & 0o777) !== 0o555
  ) throw new Error("Capital Test window state root boundary is invalid");
}

function assertWindowFile(metadata, options) {
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== expectedUid
    || metadata.gid !== expectedGid
    || (metadata.mode & 0o777) !== 0o444
    || metadata.size < 2
    || metadata.size > 64 * 1024
  ) throw new Error("Capital Test window receipt boundary is invalid");
}

function sameFile(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (left.mode & 0o777) === (right.mode & 0o777);
}

function withReceiptDigest(value) {
  return validateCapitalTestWindowReceipt({
    ...value,
    digest: capitalTestWindowReceiptDigest(value),
  });
}

function withoutDigest(value) {
  const { digest: _digest, ...body } = value;
  return body;
}

function exactObject(value, keys, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(message);
  return value;
}

function exactHex(value, length, message) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) {
    throw new Error(message);
  }
  return value;
}

function exactImage(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Capital Test window image identity is invalid");
  }
  return value;
}

function exactExecutionMode(value) {
  if (value !== CAPITAL_TEST_WINDOW_EXECUTION_MODE) {
    throw new Error("Capital Test window execution mode is invalid");
  }
  return value;
}

function strictUtc(value, message) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isSafeInteger(date.getTime())) throw new Error(message);
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) throw new Error(message);
  return canonical;
}

function isStrictUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString() === value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
