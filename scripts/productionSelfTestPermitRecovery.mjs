#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseManifest } from "./deploymentRevision.mjs";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import {
  assertCapitalTestWindowStateRoot,
  readCapitalTestWindowReceipt,
} from "./capitalTestWindowReceipt.mjs";
import {
  assertTrustedProductionReleaseRoot,
  execTrustedDockerSync,
} from "./trustedDockerRuntime.mjs";

export const PERMIT_RECOVERY_ROOT = "/var/lib/xingheng/production-self-test-permit-recovery";
export const PERMIT_RECOVERY_WRAPPER = "/opt/xingheng-release/code/scripts/recover-production-self-test-permit.sh";

const PERMIT_RECEIPT = "/var/lib/xingheng/production-self-test-permit-install.json";
const PERMIT_ATTEMPTS = "/var/lib/xingheng/production-self-test-permit-attempts";
const PRODUCTION_ENVIRONMENT = "/opt/xingheng-release/code/.env.production";
const RELEASE_MANIFEST = "/opt/xingheng-release/code/deploy/release-manifest.json";
const LIFECYCLE_POINTER = "/var/lib/xingheng/release-lifecycle/current.json";
const LIFECYCLE_OPERATIONS = "/var/lib/xingheng/release-lifecycle/operations";
const WINDOW_ROOT = "/var/lib/xingheng/capital-test-window";
const TRUSTED_LAUNCHER = "/opt/xingheng-release/code/scripts/trusted-operation-launcher.mjs";
const OPERATIONS_DIRECTORY = "operations";
const JOURNAL_FILE = "journal.json";
const TERMINAL_FILE = "terminal-receipt.json";
const ARCHIVED_RECEIPT = "legacy-receipt.json";
const ARCHIVED_ATTEMPT = "legacy-attempt";
const PERMIT_PREFIX = "RWA_BINANCE_PRODUCTION_SELF_TEST_";
const LEGACY_EXECUTION_MODE = "single_funding_rate_arbitrage_round";
const CURRENT_EXECUTION_MODE = "single_connectivity_smoke";
const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_40 = /^[a-f0-9]{40}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const REQUEST_KEYS = [
  "accountBindingSha256", "actionScope", "approvedCapitalUsd",
  "apiImageDigest", "authorizationManifestSha256", "executionMode", "gitTreeSha",
  "leverage", "maximumDurationMinutes", "maximumExecutionDurationMinutes", "ownerUserId",
  "permitId", "releaseManifestSha256", "releaseRevision", "releaseTreeSha256",
  "schemaVersion", "webImageDigest",
];
const RECEIPT_KEYS = [
  "activatedAt", "attemptReceiptSha256", "envAfterSha256", "envBeforeSha256",
  "expiresAt", "operationId", "permit", "releaseIdentity", "request", "runtimeAfter",
  "runtimeBefore", "schemaVersion", "status", "updatedAt",
];
const ATTEMPT_KEYS = RECEIPT_KEYS.filter((key) => key !== "attemptReceiptSha256");
const LEGACY_PERMIT_KEYS = [
  "accountBindingSha256", "actionScope", "approvedCapitalUsd", "authorizationDigest",
  "digest", "expiresAt", "ownerUserId", "permitId", "revision",
];
const CURRENT_PERMIT_KEYS = [
  "accountBindingSha256", "actionScope", "approvedCapitalUsd", "authorizationDigest",
  "digest", "executionMode", "expiresAt", "ownerUserId", "permitId", "revision",
];
const RELEASE_IDENTITY_KEYS = [
  "apiImageDigest", "gitTreeSha", "lifecycleEstablishedAt", "lifecycleOperationId",
  "releaseManifestSha256", "releaseRevision", "releaseTreeSha256", "webImageDigest",
];
const RUNTIME_KEYS = ["api", "capturedAt", "web"];
const RUNTIME_COMPONENT_KEYS = [
  "containerId", "health", "imageDigest", "revision", "running", "startedAt",
];
const IDENTITY_KEYS = ["dev", "gid", "ino", "mode", "size", "uid"];
const CLOSED_STATE_KEYS = [
  "apiImageDigest", "hostPermitAbsent", "lifecycleOperationId", "releaseManifestSha256",
  "releaseRevision", "releaseTreeSha256", "runtimePermitAbsent", "serverKillSwitchOn",
  "windowClosed",
];
const JOURNAL_KEYS = [
  "closedState", "legacyAttemptReceiptSha256", "legacyOperationId", "operationId",
  "sourceAttemptIdentity", "sourceReceiptIdentity", "sourceReceiptSha256", "startedAt",
  "state", "terminalReceiptSha256", "updatedAt", "schemaVersion",
];
const TERMINAL_KEYS = [
  "archivedAttemptIdentity", "archivedReceiptIdentity", "closedState", "completedAt",
  "digest", "legacyAttemptReceiptSha256", "legacyOperationId", "operationId",
  "sourceAttemptIdentity", "sourceReceiptIdentity", "sourceReceiptSha256", "startedAt",
  "status", "schemaVersion",
];

export function recoverHistoricalFailedPermitReceipt(options = {}) {
  if (options.closedState !== undefined && options.testMode !== true) {
    throw new Error("Permit recovery closed-state override is test-only");
  }
  const operationId = exactHex(options.operationId, 32, "Permit recovery operation ID is invalid");
  const expectedReceiptSha256 = exactHex(
    options.expectedReceiptSha256,
    64,
    "Permit recovery source SHA256 is invalid",
  );
  const paths = recoveryPaths(options);
  const owner = expectedOwner(options);
  const existingOperation = findRecoveryOperation(paths, owner, options);
  if (existingOperation && existingOperation.operationId !== operationId) {
    throw new Error("A different Permit recovery operation already exists");
  }

  let journal = existingOperation?.journal ?? null;
  if (journal?.state === "completed") {
    throw new Error("Permit recovery has already completed");
  }
  if (journal && journal.sourceReceiptSha256 !== expectedReceiptSha256) {
    throw new Error("Permit recovery source identity mismatch");
  }

  const operationRoot = resolve(paths.operationsRoot, operationId);
  const archivedReceiptPath = resolve(operationRoot, ARCHIVED_RECEIPT);
  const archivedAttemptPath = resolve(operationRoot, ARCHIVED_ATTEMPT);
  const sourceReceiptPath = exists(paths.receiptPath) ? paths.receiptPath : archivedReceiptPath;
  const sourceAttemptPath = exists(resolve(paths.attemptsRoot, journal?.legacyOperationId ?? ""))
    ? resolve(paths.attemptsRoot, journal?.legacyOperationId ?? "")
    : archivedAttemptPath;
  const legacy = readFailedReceipt(sourceReceiptPath, {
    ...options,
    expectedSha256: expectedReceiptSha256,
    attemptPath: journal ? sourceAttemptPath : undefined,
  });
  const legacyAttemptPath = exists(resolve(paths.attemptsRoot, legacy.receipt.operationId))
    ? resolve(paths.attemptsRoot, legacy.receipt.operationId)
    : archivedAttemptPath;
  assertLegacyAttemptSet(paths.attemptsRoot, legacy.receipt.operationId, legacyAttemptPath === archivedAttemptPath);
  const sourceAttemptIdentity = directoryIdentity(legacyAttemptPath, 0o700, options);
  validateAttemptDirectory(legacyAttemptPath, legacy.receipt, options);
  const closedState = validateClosedState(
    options.closedState ?? captureProductionClosedState(legacy.receipt.request.ownerUserId, paths, options),
  );

  if (!journal) {
    ensureDirectory(paths.recoveryRoot, 0o700, options);
    ensureDirectory(paths.operationsRoot, 0o700, options);
    ensureDirectory(operationRoot, 0o700, options);
    const now = strictUtc(options.now ?? new Date(), "Permit recovery time is invalid");
    journal = validateJournal({
      schemaVersion: 1,
      operationId,
      state: "prepared",
      sourceReceiptSha256: expectedReceiptSha256,
      sourceReceiptIdentity: legacy.identity,
      sourceAttemptIdentity,
      legacyOperationId: legacy.receipt.operationId,
      legacyAttemptReceiptSha256: legacy.receipt.attemptReceiptSha256,
      closedState,
      startedAt: now,
      updatedAt: now,
      terminalReceiptSha256: null,
    });
    atomicCreate(resolve(operationRoot, JOURNAL_FILE), jsonBytes(journal), 0o400, options);
    options.hooks?.afterJournalPrepared?.();
  } else {
    assertRecoveryResumeIdentity(journal, legacy, sourceAttemptIdentity, closedState);
  }

  if (!exists(archivedReceiptPath)) {
    assertSameFileIdentity(paths.receiptPath, journal.sourceReceiptIdentity, 0o400, options);
    renameWithinFilesystem(paths.receiptPath, archivedReceiptPath, options);
    options.hooks?.afterReceiptArchived?.();
  }
  const archivedReceipt = readFailedReceipt(archivedReceiptPath, {
    ...options,
    expectedSha256: journal.sourceReceiptSha256,
    attemptPath: legacyAttemptPath,
  });
  if (!sameIdentity(archivedReceipt.identity, journal.sourceReceiptIdentity)) {
    throw new Error("Archived Permit receipt identity mismatch");
  }
  if (journal.state === "prepared") {
    journal = updateJournal(operationRoot, journal, "receipt_archived", null, options);
  }

  const currentAttemptPath = resolve(paths.attemptsRoot, journal.legacyOperationId);
  if (!exists(archivedAttemptPath)) {
    assertSameDirectoryIdentity(currentAttemptPath, journal.sourceAttemptIdentity, 0o700, options);
    renameWithinFilesystem(currentAttemptPath, archivedAttemptPath, options);
    options.hooks?.afterAttemptArchived?.();
  }
  validateAttemptDirectory(archivedAttemptPath, legacy.receipt, options);
  const archivedAttemptIdentity = directoryIdentity(archivedAttemptPath, 0o700, options);
  if (!sameIdentity(archivedAttemptIdentity, journal.sourceAttemptIdentity)) {
    throw new Error("Archived Permit attempt identity mismatch");
  }
  assertAttemptsRootEmpty(paths.attemptsRoot);
  if (journal.state === "receipt_archived") {
    journal = updateJournal(operationRoot, journal, "attempt_archived", null, options);
  }

  const terminalPath = resolve(operationRoot, TERMINAL_FILE);
  let terminalBytes;
  if (!exists(terminalPath)) {
    if (journal.state !== "attempt_archived") throw new Error("Permit recovery journal is incomplete");
    const terminal = withTerminalDigest({
      schemaVersion: 1,
      operationId,
      status: "completed",
      sourceReceiptSha256: journal.sourceReceiptSha256,
      sourceReceiptIdentity: journal.sourceReceiptIdentity,
      archivedReceiptIdentity: archivedReceipt.identity,
      sourceAttemptIdentity: journal.sourceAttemptIdentity,
      archivedAttemptIdentity,
      legacyOperationId: journal.legacyOperationId,
      legacyAttemptReceiptSha256: journal.legacyAttemptReceiptSha256,
      closedState: journal.closedState,
      startedAt: journal.startedAt,
      completedAt: strictUtc(options.now ?? new Date(), "Permit recovery time is invalid"),
    });
    terminalBytes = jsonBytes(terminal);
    atomicCreate(terminalPath, terminalBytes, 0o400, options);
    options.hooks?.afterTerminalWritten?.();
  } else {
    terminalBytes = secureFile(terminalPath, 64 * 1024, 0o400, options).bytes;
    validateTerminal(JSON.parse(terminalBytes.toString("utf8")), journal);
  }
  const terminalSha256 = sha256(terminalBytes);
  terminalBytes.fill(0);
  if (journal.state === "attempt_archived") {
    journal = updateJournal(operationRoot, journal, "completed", terminalSha256, options);
  }
  assertCompletedPermitRecovery({ ...options, recoveryRoot: paths.recoveryRoot });
  return Object.freeze({
    operationId,
    sourceReceiptSha256: journal.sourceReceiptSha256,
    terminalReceiptSha256: journal.terminalReceiptSha256,
  });
}

export function assertCompletedPermitRecovery(options = {}) {
  const paths = recoveryPaths(options);
  const owner = expectedOwner(options);
  const operation = findRecoveryOperation(paths, owner, options);
  if (!operation) return false;
  const { operationRoot, journal } = operation;
  if (!journal) throw new Error("Permit recovery journal is incomplete");
  if (journal.state !== "completed" || !HEX_64.test(journal.terminalReceiptSha256 ?? "")) {
    throw new Error("Permit recovery journal is incomplete");
  }
  const expectedEntries = [ARCHIVED_ATTEMPT, ARCHIVED_RECEIPT, JOURNAL_FILE, TERMINAL_FILE];
  if (readdirSync(operationRoot).sort().join(",") !== expectedEntries.sort().join(",")) {
    throw new Error("Permit recovery archive contains unknown files");
  }
  if (exists(paths.receiptPath)) throw new Error("Permit recovery left the legacy receipt active");
  assertAttemptsRootEmpty(paths.attemptsRoot);
  const terminalFile = secureFile(resolve(operationRoot, TERMINAL_FILE), 64 * 1024, 0o400, options);
  try {
    if (terminalFile.sha256 !== journal.terminalReceiptSha256) {
      throw new Error("Permit recovery terminal identity mismatch");
    }
    const terminal = validateTerminal(JSON.parse(terminalFile.bytes.toString("utf8")), journal);
    const archived = readFailedReceipt(resolve(operationRoot, ARCHIVED_RECEIPT), {
      ...options,
      expectedSha256: journal.sourceReceiptSha256,
      attemptPath: resolve(operationRoot, ARCHIVED_ATTEMPT),
    });
    if (!sameIdentity(archived.identity, terminal.archivedReceiptIdentity)) {
      throw new Error("Permit recovery archived receipt identity mismatch");
    }
    validateAttemptDirectory(resolve(operationRoot, ARCHIVED_ATTEMPT), archived.receipt, options);
    const archivedAttempt = directoryIdentity(resolve(operationRoot, ARCHIVED_ATTEMPT), 0o700, options);
    if (!sameIdentity(archivedAttempt, terminal.archivedAttemptIdentity)) {
      throw new Error("Permit recovery archived attempt identity mismatch");
    }
    return true;
  } finally {
    terminalFile.bytes.fill(0);
  }
}

function readFailedReceipt(path, options = {}) {
  const file = secureFile(path, 64 * 1024, 0o400, options);
  try {
    if (options.expectedSha256 && file.sha256 !== options.expectedSha256) {
      throw new Error("Permit recovery source receipt SHA256 mismatch");
    }
    const receipt = parseFailedReceipt(JSON.parse(file.bytes.toString("utf8")));
    const attemptPath = options.attemptPath
      ?? resolve(options.attemptsRoot ?? PERMIT_ATTEMPTS, receipt.operationId);
    validateAttemptDirectory(attemptPath, receipt, options);
    return { receipt, identity: fileIdentity(file) };
  } finally {
    file.bytes.fill(0);
  }
}

function parseFailedReceipt(value) {
  if (value?.schemaVersion === 1) return parseLegacyReceipt(value);
  if (value?.schemaVersion === 2) return parseCurrentReceipt(value);
  throw new Error("Permit recovery receipt schema is unsupported");
}

function parseLegacyReceipt(value) {
  const receipt = exactObject(value, RECEIPT_KEYS, "Legacy Permit receipt is invalid");
  const request = exactObject(receipt.request, REQUEST_KEYS, "Legacy Permit request is invalid");
  if (
    receipt.schemaVersion !== 1 || request.schemaVersion !== 1 || receipt.status !== "failed"
    || !HEX_32.test(receipt.operationId ?? "") || !HEX_32.test(request.permitId ?? "")
    || !/^USR-[A-Z0-9]+$/u.test(request.ownerUserId ?? "")
    || !HEX_64.test(request.accountBindingSha256 ?? "")
    || !exactScope(request.actionScope) || request.approvedCapitalUsd !== 40 || request.leverage !== 1
    || request.executionMode !== LEGACY_EXECUTION_MODE || request.maximumDurationMinutes !== 60
    || request.maximumExecutionDurationMinutes !== 30 || !HEX_40.test(request.releaseRevision ?? "")
    || !HEX_40.test(request.gitTreeSha ?? "") || !HEX_64.test(request.releaseTreeSha256 ?? "")
    || !HEX_64.test(request.releaseManifestSha256 ?? "")
    || !IMAGE.test(request.apiImageDigest ?? "") || !IMAGE.test(request.webImageDigest ?? "")
    || !HEX_64.test(request.authorizationManifestSha256 ?? "")
    || !strictUtcString(receipt.activatedAt) || !strictUtcString(receipt.expiresAt)
    || Date.parse(receipt.expiresAt) - Date.parse(receipt.activatedAt) !== 60 * 60_000
    || !strictUtcString(receipt.updatedAt) || !HEX_64.test(receipt.attemptReceiptSha256 ?? "")
    || !HEX_64.test(receipt.envBeforeSha256 ?? "") || !HEX_64.test(receipt.envAfterSha256 ?? "")
    || receipt.runtimeAfter !== null || Date.parse(receipt.updatedAt) < Date.parse(receipt.activatedAt)
  ) throw new Error("Legacy Permit receipt is not an exact failed schema v1 terminal");
  validateReleaseIdentity(receipt.releaseIdentity, request);
  validateRuntime(receipt.runtimeBefore, true);
  if (receipt.runtimeBefore !== null) {
    if (receipt.runtimeBefore.api.revision !== receipt.releaseIdentity.releaseRevision
      || receipt.runtimeBefore.web.revision !== receipt.releaseIdentity.releaseRevision
      || receipt.runtimeBefore.api.imageDigest !== receipt.releaseIdentity.apiImageDigest
      || receipt.runtimeBefore.web.imageDigest !== receipt.releaseIdentity.webImageDigest) {
      throw new Error("Legacy Permit runtime identity does not match its release");
    }
  }
  const permit = exactObject(receipt.permit, LEGACY_PERMIT_KEYS, "Legacy Permit is invalid");
  if (
    permit.permitId !== request.permitId || permit.ownerUserId !== request.ownerUserId
    || permit.accountBindingSha256 !== request.accountBindingSha256 || !exactScope(permit.actionScope)
    || permit.authorizationDigest !== request.authorizationManifestSha256
    || permit.approvedCapitalUsd !== 40 || permit.expiresAt !== receipt.expiresAt
    || permit.revision !== request.releaseRevision || !HEX_64.test(permit.digest ?? "")
    || permit.digest !== legacyPermitDigest(permit)
  ) throw new Error("Legacy Permit receipt digest is invalid");
  return receipt;
}

function parseCurrentReceipt(value) {
  const receipt = exactObject(value, RECEIPT_KEYS, "Schema v2 Permit receipt is invalid");
  const request = exactObject(receipt.request, REQUEST_KEYS, "Schema v2 Permit request is invalid");
  if (
    receipt.schemaVersion !== 2 || request.schemaVersion !== 2 || receipt.status !== "failed"
    || !HEX_32.test(receipt.operationId ?? "") || !HEX_32.test(request.permitId ?? "")
    || !/^USR-[A-Z0-9]+$/u.test(request.ownerUserId ?? "")
    || !HEX_64.test(request.accountBindingSha256 ?? "")
    || !exactScope(request.actionScope) || request.approvedCapitalUsd !== 40 || request.leverage !== 1
    || request.executionMode !== CURRENT_EXECUTION_MODE || request.maximumDurationMinutes !== 60
    || request.maximumExecutionDurationMinutes !== 30 || !HEX_40.test(request.releaseRevision ?? "")
    || !HEX_40.test(request.gitTreeSha ?? "") || !HEX_64.test(request.releaseTreeSha256 ?? "")
    || !HEX_64.test(request.releaseManifestSha256 ?? "")
    || !IMAGE.test(request.apiImageDigest ?? "") || !IMAGE.test(request.webImageDigest ?? "")
    || !HEX_64.test(request.authorizationManifestSha256 ?? "")
    || !strictUtcString(receipt.activatedAt) || !strictUtcString(receipt.expiresAt)
    || Date.parse(receipt.expiresAt) - Date.parse(receipt.activatedAt) !== 60 * 60_000
    || !strictUtcString(receipt.updatedAt) || !HEX_64.test(receipt.attemptReceiptSha256 ?? "")
    || !HEX_64.test(receipt.envBeforeSha256 ?? "") || !HEX_64.test(receipt.envAfterSha256 ?? "")
    || receipt.runtimeAfter !== null || Date.parse(receipt.updatedAt) < Date.parse(receipt.activatedAt)
  ) throw new Error("Schema v2 Permit receipt is not an exact failed terminal");
  validateReleaseIdentity(receipt.releaseIdentity, request);
  validateRuntime(receipt.runtimeBefore, true);
  if (receipt.runtimeBefore !== null) {
    if (receipt.runtimeBefore.api.revision !== receipt.releaseIdentity.releaseRevision
      || receipt.runtimeBefore.web.revision !== receipt.releaseIdentity.releaseRevision
      || receipt.runtimeBefore.api.imageDigest !== receipt.releaseIdentity.apiImageDigest
      || receipt.runtimeBefore.web.imageDigest !== receipt.releaseIdentity.webImageDigest) {
      throw new Error("Schema v2 Permit runtime identity does not match its release");
    }
  }
  const permit = exactObject(receipt.permit, CURRENT_PERMIT_KEYS, "Schema v2 Permit is invalid");
  if (
    permit.permitId !== request.permitId || permit.ownerUserId !== request.ownerUserId
    || permit.accountBindingSha256 !== request.accountBindingSha256 || !exactScope(permit.actionScope)
    || permit.executionMode !== CURRENT_EXECUTION_MODE || permit.executionMode !== request.executionMode
    || permit.authorizationDigest !== request.authorizationManifestSha256
    || permit.approvedCapitalUsd !== 40 || permit.expiresAt !== receipt.expiresAt
    || permit.revision !== request.releaseRevision || !HEX_64.test(permit.digest ?? "")
    || permit.digest !== currentPermitDigest(permit)
  ) throw new Error("Schema v2 Permit receipt digest is invalid");
  return receipt;
}

function validateAttemptDirectory(path, receipt, options = {}) {
  directoryIdentity(path, 0o700, options);
  const entries = readdirSync(path).sort();
  if (entries.join(",") !== ["attempt-receipt.json", "environment.before", "environment.proposed"].join(",")) {
    throw new Error("Permit recovery attempt directory is incomplete");
  }
  const before = secureFile(resolve(path, "environment.before"), 1024 * 1024, 0o600, options);
  const proposed = secureFile(resolve(path, "environment.proposed"), 1024 * 1024, 0o600, options);
  const attempt = secureFile(resolve(path, "attempt-receipt.json"), 64 * 1024, 0o400, options);
  try {
    if (before.sha256 !== receipt.envBeforeSha256 || proposed.sha256 !== receipt.envAfterSha256
      || attempt.sha256 !== receipt.attemptReceiptSha256) {
      throw new Error("Permit recovery attempt artifact identity mismatch");
    }
    const parsed = exactObject(JSON.parse(attempt.bytes.toString("utf8")), ATTEMPT_KEYS, "Permit recovery attempt receipt is invalid");
    const expected = { ...receipt };
    delete expected.attemptReceiptSha256;
    expected.status = "prepared";
    expected.runtimeBefore = null;
    expected.runtimeAfter = null;
    expected.updatedAt = receipt.activatedAt;
    if (canonicalJson(parsed) !== canonicalJson(expected)) {
      throw new Error("Permit recovery attempt receipt does not match terminal receipt");
    }
  } finally {
    before.bytes.fill(0);
    proposed.bytes.fill(0);
    attempt.bytes.fill(0);
  }
}

function captureProductionClosedState(ownerUserId, paths, options) {
  if (options.testMode === true) throw new Error("Permit recovery test must supply closed state evidence");
  const trusted = assertTrustedProductionReleaseRoot("/opt/xingheng-release/code");
  const manifestFile = secureFile(paths.releaseManifestPath, 16 * 1024, 0o444, options);
  const environmentFile = secureFile(paths.environmentPath, 1024 * 1024, 0o600, options);
  const lifecycleFile = secureFile(paths.lifecyclePointerPath, 1024 * 1024, 0o600, options);
  try {
    const manifest = validateReleaseManifest(JSON.parse(manifestFile.bytes.toString("utf8")));
    const environment = environmentEntries(environmentFile.bytes);
    if (environment.get("RWA_AUTOMATION_SERVER_KILL_SWITCH") !== "true"
      || [...environment.keys()].some((key) => key.startsWith(PERMIT_PREFIX))) {
      throw new Error("Host Permit recovery closed state is invalid");
    }
    const lifecycle = JSON.parse(lifecycleFile.bytes.toString("utf8"));
    if (lifecycle?.schemaVersion !== 1 || lifecycle.revision !== manifest.revision
      || lifecycle.manifestSha256 !== manifestFile.sha256 || lifecycle.images?.api !== manifest.images.api
      || (lifecycle.operationId !== null && !UUID.test(lifecycle.operationId ?? ""))) {
      throw new Error("Permit recovery lifecycle identity is invalid");
    }
    if (lifecycle.operationId !== null) {
      const journal = secureFile(
        resolve(paths.lifecycleOperationsRoot, `operation-${lifecycle.operationId}`, "journal.json"),
        1024 * 1024,
        0o600,
        options,
      );
      try {
        const value = JSON.parse(journal.bytes.toString("utf8"));
        if (value?.operationId !== lifecycle.operationId || value?.phase !== "active") {
          throw new Error("Permit recovery lifecycle journal is invalid");
        }
      } finally { journal.bytes.fill(0); }
    }
    const api = inspectSingleApiContainer(options.docker ?? productionDocker);
    const runtimeEnvironment = new Map((api.Config?.Env ?? []).map(splitEnvironmentEntry));
    if (api.Image !== manifest.images.api
      || api.Config?.Labels?.["org.opencontainers.image.revision"] !== manifest.revision
      || runtimeEnvironment.get("RWA_AUTOMATION_SERVER_KILL_SWITCH") !== "true"
      || [...runtimeEnvironment.keys()].some((key) => key.startsWith(PERMIT_PREFIX))) {
      throw new Error("Runtime Permit recovery closed state is invalid");
    }
    const persisted = (options.docker ?? productionDocker)([
      "exec", api.Id, "node", "/app/scripts/verify-production-self-test-permit-state.mjs", ownerUserId,
    ]).trim();
    if (persisted !== "permit-state-safe") throw new Error("Persisted Permit state is not closed");
    assertWindowClosed(paths.windowRoot, options);
    return {
      serverKillSwitchOn: true,
      hostPermitAbsent: true,
      runtimePermitAbsent: true,
      windowClosed: true,
      releaseRevision: manifest.revision,
      releaseTreeSha256: trusted.releaseTree.sha256,
      releaseManifestSha256: manifestFile.sha256,
      apiImageDigest: manifest.images.api,
      lifecycleOperationId: lifecycle.operationId,
    };
  } finally {
    manifestFile.bytes.fill(0);
    environmentFile.bytes.fill(0);
    lifecycleFile.bytes.fill(0);
  }
}

function assertWindowClosed(root, options) {
  const current = resolve(root, "current.json");
  if (!exists(current)) {
    if (!exists(root)) return;
    assertCapitalTestWindowStateRoot(root, {
      expectedUid: expectedOwner(options).uid,
      expectedGid: expectedOwner(options).gid,
    });
    return;
  }
  const receipt = readCapitalTestWindowReceipt(current, {
    rootPath: root,
    expectedUid: expectedOwner(options).uid,
    expectedGid: expectedOwner(options).gid,
  });
  if (receipt.state !== "closed") throw new Error("Capital Test window is not closed");
}

function inspectSingleApiContainer(docker) {
  const ids = docker([
    "ps", "-a", "--filter", "label=com.docker.compose.project=xingheng",
    "--filter", "label=com.docker.compose.service=api", "--format", "{{.ID}}",
  ]).trim().split(/\s+/u).filter(Boolean);
  if (ids.length !== 1) throw new Error("Permit recovery API container set is invalid");
  const inspected = JSON.parse(docker(["container", "inspect", ids[0]]));
  if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0]?.State?.Running !== true) {
    throw new Error("Permit recovery API runtime identity is invalid");
  }
  return inspected[0];
}

function productionDocker(args) {
  return execTrustedDockerSync(args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function findRecoveryOperation(paths, owner, options) {
  if (!exists(paths.recoveryRoot)) return null;
  validateDirectory(paths.recoveryRoot, 0o700, owner);
  const entries = readdirSync(paths.recoveryRoot).sort();
  if (entries.length === 0) return null;
  if (entries.join(",") !== OPERATIONS_DIRECTORY) throw new Error("Permit recovery root contains unknown files");
  validateDirectory(paths.operationsRoot, 0o700, owner);
  const operations = readdirSync(paths.operationsRoot).sort();
  if (operations.length === 0) return null;
  if (operations.length !== 1 || !HEX_32.test(operations[0] ?? "")) {
    throw new Error("Permit recovery operation set is invalid");
  }
  const operationRoot = resolve(paths.operationsRoot, operations[0]);
  validateDirectory(operationRoot, 0o700, owner);
  removeStaleRecoveryTemps(operationRoot, options);
  if (readdirSync(operationRoot).length === 0) {
    return { operationId: operations[0], operationRoot, journal: null };
  }
  const journalFile = secureFile(resolve(operationRoot, JOURNAL_FILE), 64 * 1024, 0o400, options);
  try {
    const journal = validateJournal(JSON.parse(journalFile.bytes.toString("utf8")));
    if (journal.operationId !== operations[0]) throw new Error("Permit recovery journal identity mismatch");
    validateOperationEntries(operationRoot, journal.state);
    return { operationId: operations[0], operationRoot, journal };
  } finally { journalFile.bytes.fill(0); }
}

function updateJournal(operationRoot, journal, state, terminalReceiptSha256, options) {
  const next = validateJournal({
    ...journal,
    state,
    terminalReceiptSha256,
    updatedAt: strictUtc(options.now ?? new Date(), "Permit recovery time is invalid"),
  });
  atomicReplace(resolve(operationRoot, JOURNAL_FILE), jsonBytes(next), 0o400, options);
  return next;
}

function validateJournal(value) {
  const journal = exactObject(value, JOURNAL_KEYS, "Permit recovery journal is invalid");
  if (journal.schemaVersion !== 1 || !HEX_32.test(journal.operationId ?? "")
    || !["prepared", "receipt_archived", "attempt_archived", "completed"].includes(journal.state)
    || !HEX_64.test(journal.sourceReceiptSha256 ?? "") || !HEX_32.test(journal.legacyOperationId ?? "")
    || !HEX_64.test(journal.legacyAttemptReceiptSha256 ?? "")
    || !strictUtcString(journal.startedAt) || !strictUtcString(journal.updatedAt)
    || Date.parse(journal.updatedAt) < Date.parse(journal.startedAt)
    || (journal.state === "completed") !== HEX_64.test(journal.terminalReceiptSha256 ?? "")) {
    throw new Error("Permit recovery journal is invalid");
  }
  validateIdentity(journal.sourceReceiptIdentity);
  validateIdentity(journal.sourceAttemptIdentity);
  validateClosedState(journal.closedState);
  return journal;
}

function validateTerminal(value, journal) {
  const terminal = exactObject(value, TERMINAL_KEYS, "Permit recovery terminal receipt is invalid");
  if (terminal.schemaVersion !== 1 || terminal.status !== "completed"
    || terminal.operationId !== journal.operationId
    || terminal.sourceReceiptSha256 !== journal.sourceReceiptSha256
    || terminal.legacyOperationId !== journal.legacyOperationId
    || terminal.legacyAttemptReceiptSha256 !== journal.legacyAttemptReceiptSha256
    || terminal.startedAt !== journal.startedAt || !strictUtcString(terminal.completedAt)
    || Date.parse(terminal.completedAt) < Date.parse(terminal.startedAt)
    || !HEX_64.test(terminal.digest ?? "") || terminal.digest !== terminalDigest(terminal)) {
    throw new Error("Permit recovery terminal receipt is invalid");
  }
  for (const key of ["sourceReceiptIdentity", "archivedReceiptIdentity", "sourceAttemptIdentity", "archivedAttemptIdentity"]) {
    validateIdentity(terminal[key]);
  }
  if (!sameIdentity(terminal.sourceReceiptIdentity, journal.sourceReceiptIdentity)
    || !sameIdentity(terminal.archivedReceiptIdentity, journal.sourceReceiptIdentity)
    || !sameIdentity(terminal.sourceAttemptIdentity, journal.sourceAttemptIdentity)
    || !sameIdentity(terminal.archivedAttemptIdentity, journal.sourceAttemptIdentity)
    || canonicalJson(terminal.closedState) !== canonicalJson(journal.closedState)) {
    throw new Error("Permit recovery terminal evidence mismatch");
  }
  return terminal;
}

function withTerminalDigest(value) {
  return validateTerminal({ ...value, digest: sha256(Buffer.from(canonicalJson(value))) }, {
    operationId: value.operationId,
    sourceReceiptSha256: value.sourceReceiptSha256,
    legacyOperationId: value.legacyOperationId,
    legacyAttemptReceiptSha256: value.legacyAttemptReceiptSha256,
    startedAt: value.startedAt,
    sourceReceiptIdentity: value.sourceReceiptIdentity,
    sourceAttemptIdentity: value.sourceAttemptIdentity,
    closedState: value.closedState,
  });
}

function terminalDigest(value) {
  const copy = { ...value };
  delete copy.digest;
  return sha256(Buffer.from(canonicalJson(copy)));
}

function assertRecoveryResumeIdentity(journal, legacy, sourceAttemptIdentity, closedState) {
  if (journal.legacyOperationId !== legacy.receipt.operationId
    || journal.legacyAttemptReceiptSha256 !== legacy.receipt.attemptReceiptSha256
    || !sameIdentity(journal.sourceReceiptIdentity, legacy.identity)
    || !sameIdentity(journal.sourceAttemptIdentity, sourceAttemptIdentity)
    || canonicalJson(journal.closedState) !== canonicalJson(closedState)) {
    throw new Error("Permit recovery resume identity mismatch");
  }
}

function renameWithinFilesystem(source, target, options) {
  const sourceMetadata = lstatSync(source);
  const targetParent = lstatSync(dirname(target));
  if (sourceMetadata.dev !== targetParent.dev) throw new Error("Permit recovery archive must remain on one filesystem");
  invokeFs(options, "rename", () => renameSync(source, target));
  fsyncDirectory(dirname(source), options);
  fsyncDirectory(dirname(target), options);
}

function atomicWrite(path, bytes, mode, options) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    const owner = expectedOwner(options);
    fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
    invokeFs(options, "fileFsync", () => fsyncSync(fd));
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(path), options);
  const verified = secureFile(path, Math.max(bytes.length, 1), mode, options);
  try {
    if (verified.sha256 !== sha256(bytes)) throw new Error("Permit recovery file verification failed");
  } finally { verified.bytes.fill(0); }
}

function atomicCreate(path, bytes, mode, options) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    atomicWrite(temporary, bytes, mode, options);
    if (exists(path)) throw new Error("Permit recovery file already exists");
    invokeFs(options, "rename", () => renameSync(temporary, path));
    fsyncDirectory(dirname(path), options);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function atomicReplace(path, bytes, mode, options) {
  const current = secureFile(path, 64 * 1024, mode, options);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    atomicWrite(temporary, bytes, mode, options);
    assertSameFileIdentity(path, fileIdentity(current), mode, options);
    invokeFs(options, "rename", () => renameSync(temporary, path));
    fsyncDirectory(dirname(path), options);
  } finally {
    current.bytes.fill(0);
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function secureFile(path, maximum, mode, options = {}) {
  const before = lstatSync(path);
  const owner = expectedOwner(options);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== owner.uid || before.gid !== owner.gid || (before.mode & 0o777) !== mode
    || before.size < 1 || before.size > maximum) throw new Error("Permit recovery file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameStat(before, opened)) throw new Error("Permit recovery file changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameStat(opened, after)) {
      bytes.fill(0);
      throw new Error("Permit recovery file changed while reading");
    }
    return { ...opened, bytes, sha256: sha256(bytes) };
  } finally { closeSync(fd); }
}

function ensureDirectory(path, mode, options) {
  if (exists(path)) {
    validateDirectory(path, mode, expectedOwner(options));
    return;
  }
  validateSecureParent(dirname(path), expectedOwner(options));
  mkdirSync(path, { mode, recursive: false });
  validateDirectory(path, mode, expectedOwner(options));
  fsyncDirectory(dirname(path), options);
}

function validateDirectory(path, mode, owner) {
  const value = lstatSync(path);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== owner.uid
    || value.gid !== owner.gid || (value.mode & 0o777) !== mode) {
    throw new Error("Permit recovery directory boundary is invalid");
  }
}

function validateSecureParent(path, owner) {
  const value = lstatSync(path);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== owner.uid
    || value.gid !== owner.gid || (value.mode & 0o022) !== 0) {
    throw new Error("Permit recovery parent boundary is invalid");
  }
}

function directoryIdentity(path, mode, options) {
  validateDirectory(path, mode, expectedOwner(options));
  return statIdentity(lstatSync(path));
}

function assertSameFileIdentity(path, identity, mode, options) {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1
    || (value.mode & 0o777) !== mode || !sameIdentity(statIdentity(value), identity)) {
    throw new Error("Permit recovery source file identity changed");
  }
  const owner = expectedOwner(options);
  if (value.uid !== owner.uid || value.gid !== owner.gid) throw new Error("Permit recovery source owner changed");
}

function assertSameDirectoryIdentity(path, identity, mode, options) {
  const value = lstatSync(path);
  if (!value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o777) !== mode
    || !sameIdentity(statIdentity(value), identity)) throw new Error("Permit recovery attempt identity changed");
  const owner = expectedOwner(options);
  if (value.uid !== owner.uid || value.gid !== owner.gid) throw new Error("Permit recovery attempt owner changed");
}

function assertAttemptsRootEmpty(path) {
  if (!exists(path)) return;
  if (readdirSync(path).length !== 0) throw new Error("Permit recovery attempt root is not empty");
}

function assertLegacyAttemptSet(attemptsRoot, operationId, archived) {
  const entries = readdirSync(attemptsRoot).sort();
  const expected = archived ? [] : [operationId];
  if (entries.join(",") !== expected.join(",")) {
    throw new Error("Legacy Permit attempt set is invalid");
  }
}

function validateOperationEntries(operationRoot, state) {
  const actual = readdirSync(operationRoot).sort();
  const required = state === "prepared"
    ? [JOURNAL_FILE]
    : state === "receipt_archived"
      ? [ARCHIVED_RECEIPT, JOURNAL_FILE]
      : state === "attempt_archived"
        ? [ARCHIVED_ATTEMPT, ARCHIVED_RECEIPT, JOURNAL_FILE]
        : [ARCHIVED_ATTEMPT, ARCHIVED_RECEIPT, JOURNAL_FILE, TERMINAL_FILE];
  const allowed = state === "prepared"
    ? [...required, ARCHIVED_RECEIPT]
    : state === "receipt_archived"
      ? [...required, ARCHIVED_ATTEMPT]
      : state === "attempt_archived"
        ? [...required, TERMINAL_FILE]
        : required;
  if (actual.some((name) => !allowed.includes(name))
    || required.some((name) => !actual.includes(name))) {
    throw new Error("Permit recovery operation state is incomplete");
  }
}

function removeStaleRecoveryTemps(operationRoot, options) {
  for (const name of readdirSync(operationRoot)) {
    if (!/^(?:journal|terminal-receipt)\.json\.[0-9]+\.[a-f0-9]{16}\.tmp$/u.test(name)) continue;
    const path = resolve(operationRoot, name);
    const file = lstatSync(path);
    const owner = expectedOwner(options);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1
      || file.uid !== owner.uid || file.gid !== owner.gid || (file.mode & 0o777) !== 0o400) {
      throw new Error("Permit recovery temporary file boundary is invalid");
    }
    unlinkSync(path);
    fsyncDirectory(operationRoot, options);
  }
}

function validateClosedState(value) {
  const state = exactObject(value, CLOSED_STATE_KEYS, "Permit recovery closed state is invalid");
  if (state.serverKillSwitchOn !== true || state.hostPermitAbsent !== true
    || state.runtimePermitAbsent !== true || state.windowClosed !== true
    || !HEX_40.test(state.releaseRevision ?? "") || !HEX_64.test(state.releaseTreeSha256 ?? "")
    || !HEX_64.test(state.releaseManifestSha256 ?? "") || !IMAGE.test(state.apiImageDigest ?? "")
    || (state.lifecycleOperationId !== null && !UUID.test(state.lifecycleOperationId ?? ""))) {
    throw new Error("Permit recovery closed state is invalid");
  }
  return state;
}

function validateIdentity(value) {
  const identity = exactObject(value, IDENTITY_KEYS, "Permit recovery file identity is invalid");
  if (![identity.dev, identity.ino, identity.size, identity.uid, identity.gid].every(Number.isSafeInteger)
    || identity.size < 1 || !Number.isSafeInteger(identity.mode) || identity.mode < 0 || identity.mode > 0o777) {
    throw new Error("Permit recovery file identity is invalid");
  }
  return identity;
}

function validateReleaseIdentity(value, request) {
  const identity = exactObject(value, RELEASE_IDENTITY_KEYS, "Legacy Permit release identity is invalid");
  if (identity.releaseRevision !== request.releaseRevision || identity.gitTreeSha !== request.gitTreeSha
    || identity.releaseTreeSha256 !== request.releaseTreeSha256
    || identity.releaseManifestSha256 !== request.releaseManifestSha256
    || identity.apiImageDigest !== request.apiImageDigest || identity.webImageDigest !== request.webImageDigest
    || !strictUtcString(identity.lifecycleEstablishedAt)
    || (identity.lifecycleOperationId !== null && !UUID.test(identity.lifecycleOperationId ?? ""))) {
    throw new Error("Legacy Permit release identity is invalid");
  }
}

function validateRuntime(value, nullable) {
  if (nullable && value === null) return;
  const runtime = exactObject(value, RUNTIME_KEYS, "Legacy Permit runtime identity is invalid");
  if (!strictUtcString(runtime.capturedAt)) throw new Error("Legacy Permit runtime identity is invalid");
  for (const name of ["api", "web"]) {
    const component = exactObject(runtime[name], RUNTIME_COMPONENT_KEYS, "Legacy Permit runtime identity is invalid");
    if (!/^[a-f0-9]{12,64}$/u.test(component.containerId ?? "") || !IMAGE.test(component.imageDigest ?? "")
      || !HEX_40.test(component.revision ?? "") || !strictUtcString(component.startedAt)
      || component.running !== true || component.health !== "healthy") {
      throw new Error("Legacy Permit runtime identity is invalid");
    }
  }
}

function recoveryPaths(options) {
  const recoveryRoot = resolve(options.recoveryRoot ?? PERMIT_RECOVERY_ROOT);
  return {
    recoveryRoot,
    operationsRoot: resolve(recoveryRoot, OPERATIONS_DIRECTORY),
    receiptPath: resolve(options.receiptPath ?? PERMIT_RECEIPT),
    attemptsRoot: resolve(options.attemptsRoot ?? PERMIT_ATTEMPTS),
    environmentPath: resolve(options.environmentPath ?? PRODUCTION_ENVIRONMENT),
    releaseManifestPath: resolve(options.releaseManifestPath ?? RELEASE_MANIFEST),
    lifecyclePointerPath: resolve(options.lifecyclePointerPath ?? LIFECYCLE_POINTER),
    lifecycleOperationsRoot: resolve(options.lifecycleOperationsRoot ?? LIFECYCLE_OPERATIONS),
    windowRoot: resolve(options.windowRoot ?? WINDOW_ROOT),
  };
}

function legacyPermitDigest(input) {
  return sha256(Buffer.from([
    "production", "binance", "xaut", input.permitId, input.ownerUserId,
    input.accountBindingSha256, "READ", "TRADE", input.authorizationDigest,
    String(input.approvedCapitalUsd), input.revision, input.expiresAt,
  ].join(":")));
}

function currentPermitDigest(input) {
  return sha256(Buffer.from([
    "production", "binance", "xaut", input.permitId, input.ownerUserId,
    input.accountBindingSha256, "READ", "TRADE", input.executionMode, input.authorizationDigest,
    String(input.approvedCapitalUsd), input.revision, input.expiresAt,
  ].join(":")));
}

function environmentEntries(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return new Map(text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/u.exec(line.trim());
    if (!match) return [line, ""];
    return [match[1], match[2]];
  }));
}

function splitEnvironmentEntry(entry) {
  const offset = entry.indexOf("=");
  return offset < 1 ? [entry, ""] : [entry.slice(0, offset), entry.slice(offset + 1)];
}

function expectedOwner(options) {
  return options.testMode === true
    ? { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }
    : { uid: 0, gid: 0 };
}

function statIdentity(value) {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode & 0o777,
  };
}

function fileIdentity(value) { return statIdentity(value); }
function sameIdentity(left, right) { return canonicalJson(left) === canonicalJson(right); }
function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && (left.mode & 0o777) === (right.mode & 0o777);
}
function exactScope(value) { return Array.isArray(value) && value.length === 2 && value[0] === "READ" && value[1] === "TRADE"; }
function exactHex(value, length, message) { if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/u.test(value)) throw new Error(message); return value; }
function exactObject(value, keys, message) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(message); return value; }
function strictUtcString(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value; }
function strictUtc(value, message) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(message); return value.toISOString(); }
function canonicalJson(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function invokeFs(options, name, operation) { return options.operations?.[name] ? options.operations[name](operation) : operation(); }
function fsyncDirectory(path, options) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { invokeFs(options, "directoryFsync", () => fsyncSync(fd)); } finally { closeSync(fd); } }

function assertTrustedRecoveryContext(operationId) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("Permit recovery requires controlled Linux root");
  }
  if (process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
    || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY !== "recover-production-self-test-permit.sh"
    || process.env.XINGHENG_PERMIT_RECOVERY_OPERATION_ID !== operationId || !HEX_32.test(operationId)) {
    throw new Error("Permit recovery trusted wrapper context is invalid");
  }
  inheritedOperationLocks("production");
  for (const [path, fd] of [[PERMIT_RECOVERY_WRAPPER, 6], [TRUSTED_LAUNCHER, 7]]) {
    const metadata = lstatSync(path);
    const descriptor = fstatSync(fd);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o022) !== 0
      || (metadata.mode & 0o111) === 0 || descriptor.dev !== metadata.dev
      || descriptor.ino !== metadata.ino || descriptor.size !== metadata.size
      || descriptor.uid !== 0 || descriptor.gid !== 0 || descriptor.nlink !== 1) {
      throw new Error("Permit recovery trusted descriptor is invalid");
    }
  }
}

async function main() {
  if (process.argv[2] !== "run") throw new Error("usage: productionSelfTestPermitRecovery.mjs run OPERATION_ID SOURCE_SHA256");
  const operationId = process.argv[3] ?? "";
  assertTrustedRecoveryContext(operationId);
  const result = recoverHistoricalFailedPermitReceipt({
    operationId,
    expectedReceiptSha256: process.argv[4] ?? "",
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Permit recovery failed");
    process.exitCode = 1;
  });
}
