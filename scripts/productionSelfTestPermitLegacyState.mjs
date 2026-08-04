#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LEGACY_PERMIT_STATE = Object.freeze({
  ABSENT: "LEGACY_FIELD_ABSENT",
  EMPTY: "PRESENT_EMPTY",
  CONSUMED: "PRESENT_CONSUMED",
  CORRUPT: "MALFORMED_OR_CORRUPT",
});

export const LEGACY_FAILED_OPERATION_ID = "e0c3703b9a008ae5bcdfa56f413a6f36";
export const LEGACY_FAILED_RECEIPT_SHA256 =
  "e6392afb1072288986778143b54a48ac9ef4c4e69e418987a2e64b31f9bd04a1";
export const LEGACY_FAILED_AUTHORIZATION_SHA256 =
  "f1a275d2882d7c1e6aa080ade394d90fd9251054bfa69a08c875acb6ca9bd5d6";
export const LEGACY_FAILED_REVISION = "a2b3d6474b49f78bff94d5c53073c8be740564e7";
export const LEGACY_FAILED_RECEIPT =
  "/var/lib/xingheng/production-self-test-permit-install.json";
export const LEGACY_MIGRATION_RECEIPT_NAME =
  ".production-self-test-permit-legacy-migration.json";

const SHA256 = /^[a-f0-9]{64}$/u;
const PERMIT_ID = /^[a-f0-9]{32}$/u;
const OWNER = /^USR-[A-Z0-9]+$/u;
const REVISION = /^[a-f0-9]{40}$/u;

export function classifyLegacyPermitState(state, expectedPermitId = null) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== 1) {
    return Object.freeze({ state: LEGACY_PERMIT_STATE.CORRUPT, matchingConsumption: false });
  }
  if (!Object.hasOwn(state, "productionSelfTestPermitConsumptions")) {
    return Object.freeze({ state: LEGACY_PERMIT_STATE.ABSENT, matchingConsumption: false });
  }
  const values = state.productionSelfTestPermitConsumptions;
  if (!Array.isArray(values) || values.some((value) =>
    !validProductionSelfTestPermitConsumption(value))) {
    return Object.freeze({ state: LEGACY_PERMIT_STATE.CORRUPT, matchingConsumption: false });
  }
  if (
    new Set(values.map((value) => value.permitId)).size !== values.length
    || new Set(values.map((value) => value.digest)).size !== values.length
  ) {
    return Object.freeze({ state: LEGACY_PERMIT_STATE.CORRUPT, matchingConsumption: false });
  }
  if (values.length === 0) {
    return Object.freeze({ state: LEGACY_PERMIT_STATE.EMPTY, matchingConsumption: false });
  }
  return Object.freeze({
    state: LEGACY_PERMIT_STATE.CONSUMED,
    matchingConsumption: PERMIT_ID.test(expectedPermitId ?? "")
      && values.some((value) => value.permitId === expectedPermitId),
  });
}

export function legacyPermitStateError(classification) {
  if (classification.state === LEGACY_PERMIT_STATE.ABSENT) {
    return new Error("LEGACY_PERMIT_STATE_MIGRATION_REQUIRED: legacy Permit consumption field is absent");
  }
  if (classification.state === LEGACY_PERMIT_STATE.CONSUMED) {
    return new Error(classification.matchingConsumption
      ? "PRODUCTION_SELF_TEST_PERMIT_ALREADY_CONSUMED: matching Permit consumption exists"
      : "PRODUCTION_SELF_TEST_PERMIT_CONSUMPTION_HISTORY_PRESENT: Permit consumption history exists");
  }
  if (classification.state === LEGACY_PERMIT_STATE.CORRUPT) {
    return new Error("PRODUCTION_SELF_TEST_PERMIT_STATE_CORRUPT: Permit consumption state is malformed");
  }
  return null;
}

export function verifyLegacyFailedReceipt(path = LEGACY_FAILED_RECEIPT, options = {}) {
  const receipt = secureJson(path, 64 * 1024, 0o400, { ...options, rootOwner: true });
  try {
    validateLegacyFailedReceiptBinding(receipt.value, receipt.sha256, {
      operationId: LEGACY_FAILED_OPERATION_ID,
      receiptSha256: LEGACY_FAILED_RECEIPT_SHA256,
      revision: LEGACY_FAILED_REVISION,
      authorizationManifestSha256: LEGACY_FAILED_AUTHORIZATION_SHA256,
    });
    if (
      receipt.value?.status !== "failed"
      || receipt.value?.runtimeBefore !== null
      || receipt.value?.runtimeAfter !== null
    ) {
      throw new Error("legacy failed Permit receipt identity is invalid");
    }
    const ownerUserId = receipt.value?.request?.ownerUserId;
    if (!OWNER.test(ownerUserId ?? "")) {
      throw new Error("legacy failed Permit receipt owner is invalid");
    }
    return Object.freeze({ ownerUserId, receiptSha256: receipt.sha256 });
  } finally {
    receipt.bytes.fill(0);
  }
}

export function validateLegacyFailedReceiptBinding(receiptValue, actualReceiptSha256, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)
    || Object.keys(expected).sort().join(",") !== [
      "authorizationManifestSha256", "operationId", "receiptSha256", "revision",
    ].join(",")
    || !PERMIT_ID.test(expected.operationId ?? "")
    || !SHA256.test(expected.receiptSha256 ?? "")
    || !REVISION.test(expected.revision ?? "")
    || !SHA256.test(expected.authorizationManifestSha256 ?? "")
    || !SHA256.test(actualReceiptSha256 ?? "")
    || !receiptValue || typeof receiptValue !== "object" || Array.isArray(receiptValue)
    || !receiptValue.request || typeof receiptValue.request !== "object"
    || Array.isArray(receiptValue.request)
    || receiptValue.operationId !== expected.operationId
    || actualReceiptSha256 !== expected.receiptSha256
    || receiptValue.request.releaseRevision !== expected.revision
    || receiptValue.request.authorizationManifestSha256
      !== expected.authorizationManifestSha256) {
    throw new Error("legacy failed Permit receipt identity is invalid");
  }
}

export function migrateLegacyPermitState(input, options = {}) {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("legacy Permit migration time is invalid");
  }
  if (
    !OWNER.test(input.ownerUserId ?? "")
    || input.failedOperationId !== LEGACY_FAILED_OPERATION_ID
    || input.failedReceiptSha256 !== LEGACY_FAILED_RECEIPT_SHA256
    || !REVISION.test(input.migrationRevision ?? "")
    || input.migrationRevision === LEGACY_FAILED_REVISION
  ) {
    throw new Error("legacy Permit migration binding is invalid");
  }
  const statePath = resolve(input.statePath);
  const pointerPath = resolve(input.pointerPath ?? resolve(dirname(dirname(statePath)), "current.json"));
  const receiptPath = resolve(input.receiptPath
    ?? resolve(dirname(dirname(statePath)), LEGACY_MIGRATION_RECEIPT_NAME));
  assertSecureDirectory(dirname(statePath), options);
  assertSecureDirectory(dirname(receiptPath), options);
  assertPathAbsent(receiptPath);
  const pointer = secureJson(pointerPath, 64 * 1024, 0o600, options);
  const state = secureJson(statePath, 10 * 1024 * 1024, 0o600, options);
  let prepared = null;
  try {
    const classification = classifyLegacyPermitState(state.value);
    assertGenerationPointer(pointer.value, input.generation);
    if (classification.state !== LEGACY_PERMIT_STATE.ABSENT) {
      throw legacyPermitStateError(classification)
        ?? new Error("legacy Permit state migration is not eligible");
    }
    assertFailClosedState(state.value);
    const migrated = {
      ...state.value,
      productionSelfTestPermitConsumptions: [],
    };
    const migratedBytes = Buffer.from(`${JSON.stringify(migrated)}\n`);
    const migrationId = options.migrationId ?? randomBytes(16).toString("hex");
    if (!PERMIT_ID.test(migrationId)) throw new Error("legacy Permit migration ID is invalid");
    const createdAt = now.toISOString();
    prepared = {
      schemaVersion: 1,
      migrationId,
      status: "prepared",
      ownerUserId: input.ownerUserId,
      failedOperationId: input.failedOperationId,
      failedReceiptSha256: input.failedReceiptSha256,
      failedReceiptStatus: "failed",
      legacyAuthorizationSha256: LEGACY_FAILED_AUTHORIZATION_SHA256,
      legacyRevision: LEGACY_FAILED_REVISION,
      migrationRevision: input.migrationRevision,
      generation: input.generation,
      stateFile: input.stateFile,
      stateBeforeSha256: state.sha256,
      stateAfterSha256: sha256(migratedBytes),
      createdAt,
      updatedAt: createdAt,
    };
    validateMigrationReceipt(prepared);
    try {
      writeExclusive(receiptPath, jsonBytes(prepared), 0o400, options);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("legacy Permit migration has already been attempted");
      }
      const unknown = { ...prepared, status: "unknown", updatedAt: now.toISOString() };
      try { replaceCurrent(receiptPath, jsonBytes(unknown), 0o400, options); } catch {}
      throw error;
    }
    let stateChanged = false;
    try {
      replaceExact(statePath, migratedBytes, 0o600, state, options, () => {
        revalidateExact(pointerPath, pointer, 0o600, 64 * 1024, options);
      });
      stateChanged = true;
      const success = { ...prepared, status: "success", updatedAt: now.toISOString() };
      replaceCurrent(receiptPath, jsonBytes(success), 0o400, options);
      return Object.freeze(success);
    } catch (error) {
      const unknown = { ...prepared, status: "unknown", updatedAt: now.toISOString() };
      try { replaceCurrent(receiptPath, jsonBytes(unknown), 0o400, options); } catch {}
      throw error;
    }
  } finally {
    pointer.bytes.fill(0);
    state.bytes.fill(0);
  }
}

function assertGenerationPointer(value, generation) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "generation,rollbackGeneration,version"
    || value.version !== 1 || value.generation !== generation
    || !(value.rollbackGeneration === null
      || /^generation-(?:initial|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/u.test(value.rollbackGeneration))) {
    throw new Error("legacy Permit migration generation pointer is invalid");
  }
}

export function readLegacyMigrationReceipt(path, options = {}) {
  const receipt = secureJson(path, 64 * 1024, 0o400, options);
  try {
    validateMigrationReceipt(receipt.value);
    return receipt.value;
  } finally {
    receipt.bytes.fill(0);
  }
}

function assertFailClosedState(state) {
  if (
    state.config?.killSwitchActive !== true
    || state.config?.globalExecutionEnabled !== false
    || state.config?.strategyEnabled !== false
    || state.config?.productionSelfTestPermitConfirmation !== null
    || !Array.isArray(state.connectivitySmokes)
    || state.connectivitySmokes.some((smoke) =>
      !["flat", "failed", "manual_intervention"].includes(smoke?.stage))
  ) {
    throw new Error("legacy Permit migration requires fail-closed execution state");
  }
}

function validateMigrationReceipt(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "createdAt", "failedOperationId", "failedReceiptSha256", "failedReceiptStatus",
      "generation", "legacyAuthorizationSha256", "legacyRevision", "migrationId",
      "migrationRevision", "ownerUserId", "schemaVersion", "stateAfterSha256",
      "stateBeforeSha256", "stateFile", "status", "updatedAt",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || !PERMIT_ID.test(value.migrationId ?? "")
    || !["prepared", "success", "unknown"].includes(value.status)
    || !OWNER.test(value.ownerUserId ?? "")
    || value.failedOperationId !== LEGACY_FAILED_OPERATION_ID
    || value.failedReceiptSha256 !== LEGACY_FAILED_RECEIPT_SHA256
    || value.failedReceiptStatus !== "failed"
    || value.legacyAuthorizationSha256 !== LEGACY_FAILED_AUTHORIZATION_SHA256
    || value.legacyRevision !== LEGACY_FAILED_REVISION
    || !REVISION.test(value.migrationRevision ?? "")
    || value.migrationRevision === LEGACY_FAILED_REVISION
    || !/^generation-(?:initial|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/u.test(value.generation ?? "")
    || !/^[a-f0-9]{16}-binance-state\.json$/u.test(value.stateFile ?? "")
    || !SHA256.test(value.stateBeforeSha256 ?? "")
    || !SHA256.test(value.stateAfterSha256 ?? "")
    || !isUtc(value.createdAt) || !isUtc(value.updatedAt)
  ) throw new Error("legacy Permit migration receipt is invalid");
}

function validProductionSelfTestPermitConsumption(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === ["consumedAt", "digest", "permitId"].sort().join(",")
    && PERMIT_ID.test(value.permitId ?? "")
    && SHA256.test(value.digest ?? "")
    && Number.isSafeInteger(value.consumedAt) && value.consumedAt > 0;
}

function secureJson(path, maximum, mode, options) {
  const receipt = secureFile(path, maximum, mode, options);
  try {
    return { ...receipt, value: JSON.parse(receipt.bytes.toString("utf8")) };
  } catch (error) {
    receipt.bytes.fill(0);
    throw error;
  }
}

function secureFile(path, maximum, mode, options = {}) {
  const expected = expectedOwner(options);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== expected.uid || before.gid !== expected.gid
    || (before.mode & 0o777) !== mode || before.size < 2 || before.size > maximum) {
    throw new Error("legacy Permit migration file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.uid !== expected.uid || opened.gid !== expected.gid || opened.nlink !== 1
      || (opened.mode & 0o777) !== mode) {
      throw new Error("legacy Permit migration file changed while opening");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      bytes.fill(0);
      throw new Error("legacy Permit migration file changed while reading");
    }
    return {
      bytes,
      sha256: sha256(bytes),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
  } finally { closeSync(fd); }
}

function assertSecureDirectory(path, options = {}) {
  const expected = expectedOwner(options);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== expected.uid || metadata.gid !== expected.gid
    || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("legacy Permit migration directory boundary is invalid");
  }
}

function assertPathAbsent(path) {
  try {
    lstatSync(path);
    throw new Error("legacy Permit migration has already been attempted");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function writeExclusive(path, bytes, mode, options = {}) {
  const expected = expectedOwner(options);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    fchownSync(fd, expected.uid, expected.gid);
    fchmodSync(fd, mode);
    invoke(options, "fileFsync", () => fsyncSync(fd));
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(path), options);
}

function replaceExact(path, bytes, mode, expected, options, additionalGuard = () => undefined) {
  revalidateExact(path, expected, mode, 10 * 1024 * 1024, options);
  replaceCurrent(path, bytes, mode, options, () => {
    revalidateExact(path, expected, mode, 10 * 1024 * 1024, options);
    additionalGuard();
  });
}

function revalidateExact(path, expected, mode, maximum, options) {
  const current = secureFile(path, maximum, mode, options);
  try {
    if (
      current.dev !== expected.dev || current.ino !== expected.ino
      || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs
      || current.ctimeMs !== expected.ctimeMs || current.sha256 !== expected.sha256
    ) throw new Error("legacy Permit state changed before migration");
  } finally { current.bytes.fill(0); }
}

function replaceCurrent(path, bytes, mode, options = {}, finalGuard = () => undefined) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeExclusive(temporary, bytes, mode, options);
    invoke(options, "beforeRename", () => undefined, path);
    finalGuard();
    renameSync(temporary, path);
    fsyncDirectory(dirname(path), options);
    const verified = secureFile(path, Math.max(bytes.length, 2), mode, options);
    try {
      if (verified.sha256 !== sha256(bytes)) {
        throw new Error("legacy Permit migration replacement verification failed");
      }
    } finally { verified.bytes.fill(0); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function fsyncDirectory(path, options) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { invoke(options, "directoryFsync", () => fsyncSync(fd)); } finally { closeSync(fd); }
}

function invoke(options, name, fallback, ...args) {
  const replacement = options.operations?.[name];
  return replacement ? replacement(fallback, ...args) : fallback();
}

function expectedOwner(options) {
  if (options.testMode === true) {
    return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
  }
  return options.rootOwner === true ? { uid: 0, gid: 0 } : { uid: 20001, gid: 20001 };
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isUtc(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function main() {
  const command = process.argv[2];
  if (command === "verify-failure") {
    if (
      process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0
      || process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
      || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY
        !== "migrate-production-self-test-permit-legacy-state.sh"
    ) throw new Error("legacy Permit migration requires the trusted production wrapper");
    const receipt = verifyLegacyFailedReceipt();
    process.stdout.write(`${receipt.ownerUserId} ${receipt.receiptSha256}\n`);
    return;
  }
  if (command === "migrate") {
    const ownerUserId = process.argv[3] ?? "";
    const failedOperationId = process.argv[4] ?? "";
    const failedReceiptSha256 = process.argv[5] ?? "";
    const migrationRevision = process.env.XINGHENG_EXPECTED_REVISION ?? "";
    if (
      process.env.NODE_ENV !== "production"
      || process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "true"
      || process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
      || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY
        !== "migrate-production-self-test-permit-legacy-state.sh"
      || process.getuid?.() !== 20001 || process.getgid?.() !== 20001
    ) throw new Error("legacy Permit migration runtime boundary is invalid");
    const root = resolve(process.env.RWA_AUTOMATION_DATA_DIR ?? "/app/rwa-automation-data");
    const pointer = secureJson(resolve(root, "current.json"), 64 * 1024, 0o600, {});
    let generation;
    try {
      generation = pointer.value?.generation;
      if (pointer.value?.version !== 1
        || !/^generation-(?:initial|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/u.test(generation ?? "")) {
        throw new Error("legacy Permit migration generation pointer is invalid");
      }
    } finally { pointer.bytes.fill(0); }
    const domain = createHash("sha256").update(`rwa-user:${ownerUserId}`).digest("hex").slice(0, 16);
    const stateFile = `${domain}-binance-state.json`;
    const receipt = migrateLegacyPermitState({
      ownerUserId,
      failedOperationId,
      failedReceiptSha256,
      migrationRevision,
      generation,
      stateFile,
      statePath: resolve(root, generation, stateFile),
      pointerPath: resolve(root, "current.json"),
      receiptPath: resolve(root, LEGACY_MIGRATION_RECEIPT_NAME),
    });
    process.stdout.write(`legacy Permit state migrated; migration=${receipt.migrationId}\n`);
    return;
  }
  throw new Error("usage: productionSelfTestPermitLegacyState.mjs verify-failure|migrate");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "legacy Permit migration failed");
    process.exitCode = 1;
  }
}
