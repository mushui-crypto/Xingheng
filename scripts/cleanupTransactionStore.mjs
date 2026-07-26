import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_REVISION = /^[a-f0-9]{40}$/u;
const PHASES = new Set([
  "prepared",
  "claimed",
  "stopping",
  "stopped",
  "removing_containers",
  "containers_removed",
  "removing_volumes",
  "volumes_removed",
  "creating_volumes",
  "volumes_created",
  "initializing_volumes",
  "volumes_initialized",
  "starting_empty_runtime",
  "empty_runtime_started",
  "verifying_empty_runtime",
  "audit_pending",
  "completed",
  "restore_required",
  "restoring",
  "restored",
  "incident_restore_failed",
]);

export class CleanupTransactionStore {
  constructor(root = "/var/lib/xingheng-real-test/reset-audit", options = {}) {
    this.root = root;
    this.testMode = options.testMode === true;
    this.uid = this.testMode ? (process.getuid?.() ?? -1) : 0;
    this.gid = this.testMode ? (process.getgid?.() ?? -1) : 0;
    if (!this.testMode && (process.getuid?.() !== 0 || process.getgid?.() !== 0)) {
      throw new Error("cleanup transaction store requires the controlled root operator");
    }
    if (!this.testMode) validateTrustedParentChain(dirname(root));
    secureDirectoryChain(root, this.uid, this.gid);
  }

  createPrepared({ revision, daemon, targets, before, backups, now, ttlMs = 15 * 60 * 1000 }) {
    const operationId = randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const core = {
      schemaVersion: 1,
      operationId,
      operation: "xingheng-real-test-data-reset",
      project: "xingheng-real-test",
      revision,
      daemon,
      targets,
      before,
      backups,
      createdAt,
      expiresAt,
    };
    validateReceiptCore(core);
    const receiptSha256 = digestCanonical(core);
    const receipt = Object.freeze({ ...core, receiptSha256 });
    const directory = this.#operationDirectory(operationId, true);
    writeImmutableJson(join(directory, "receipt.json"), receipt, this.uid, this.gid);
    this.writeJournal(operationId, {
      phase: "prepared",
      sequence: 0,
      receiptSha256,
      updatedAt: createdAt,
      failure: null,
    }, { create: true });
    return receipt;
  }

  readReceipt(operationId) {
    validateOperationId(operationId);
    const value = readStableJson(join(this.#operationDirectory(operationId), "receipt.json"), this.uid, this.gid, 0o400);
    validateReceipt(value);
    return value;
  }

  claim(operationId, confirmation, now) {
    const receipt = this.readReceipt(operationId);
    if (confirmation !== confirmationFor(receipt)) {
      throw new Error("real-test cleanup confirmation does not bind the prepared receipt");
    }
    const current = this.readJournal(operationId);
    const claimPath = join(this.#operationDirectory(operationId), "claim.json");
    const preparedJournal = initialJournal(receipt);
    if (current.receiptSha256 !== receipt.receiptSha256) {
      throw new Error("real-test cleanup journal identity mismatch");
    }
    if (current.phase !== "prepared") {
      const existing = readStableJson(claimPath, this.uid, this.gid, 0o400);
      validateClaimForReceipt(existing, receipt, preparedJournal);
      return current;
    }
    if (digestCanonical(current) !== digestCanonical(preparedJournal)) {
      throw new Error("real-test cleanup prepared journal identity mismatch");
    }
    let claim;
    if (exists(claimPath)) {
      claim = readStableJson(claimPath, this.uid, this.gid, 0o400);
      validateClaimForReceipt(claim, receipt, preparedJournal);
    } else {
      if (
        now.getTime() < Date.parse(receipt.createdAt)
        || Date.parse(receipt.expiresAt) < now.getTime()
      ) {
        throw new Error("real-test cleanup receipt expired");
      }
      claim = claimFor(receipt, preparedJournal, now);
      writeImmutableJson(claimPath, claim, this.uid, this.gid);
    }
    return this.writeJournal(operationId, {
      ...current,
      phase: "claimed",
      sequence: current.sequence + 1,
      updatedAt: claim.claimedAt,
    });
  }

  readJournal(operationId) {
    validateOperationId(operationId);
    const value = readStableJson(
      join(this.#operationDirectory(operationId), "journal.json"),
      this.uid,
      this.gid,
      0o600,
    );
    validateJournal(value);
    return value;
  }

  writeJournal(operationId, value, options = {}) {
    validateOperationId(operationId);
    validateJournal(value);
    const path = join(this.#operationDirectory(operationId), "journal.json");
    writeReplaceJson(path, value, this.uid, this.gid, options.create === true);
    return value;
  }

  publishAudit(operationId, audit) {
    return this.#publishAudit(operationId, audit, false);
  }

  publishRecoveryAudit(operationId, audit) {
    if (audit.outcome !== "restored") {
      throw new Error("cleanup recovery audit outcome is invalid");
    }
    return this.#publishAudit(operationId, audit, true);
  }

  readPublishedAudit(operationId, options = {}) {
    validateOperationId(operationId);
    const directory = this.#operationDirectory(operationId);
    const recovery = options.recovery === true;
    const auditName = recovery ? "recovery-audit.json" : "audit.json";
    const sumsName = recovery ? "RECOVERY_SHA256SUMS" : "SHA256SUMS";
    const auditPath = join(directory, auditName);
    const sumsPath = join(directory, sumsName);
    if (!exists(auditPath) && !exists(sumsPath)) return null;
    if (!exists(auditPath)) {
      throw new Error("cleanup published audit set is incomplete");
    }
    const serialized = readStableBytes(auditPath, this.uid, this.gid, 0o400);
    const audit = JSON.parse(serialized.toString("utf8"));
    validateAudit(audit);
    if (recovery && audit.outcome !== "restored") {
      throw new Error("cleanup recovery audit outcome is invalid");
    }
    const digest = createHash("sha256").update(serialized).digest("hex");
    const sums = Buffer.from(`${digest}  ${auditName}\n`, "ascii");
    if (
      exists(sumsPath)
      && !readStableBytes(sumsPath, this.uid, this.gid, 0o400).equals(sums)
    ) {
      throw new Error("cleanup published audit checksum mismatch");
    }
    return Object.freeze({
      audit,
      auditSha256: digest,
      checksumPublished: exists(sumsPath),
      directory,
    });
  }

  #publishAudit(operationId, audit, recovery) {
    validateOperationId(operationId);
    validateAudit(audit);
    const directory = this.#operationDirectory(operationId);
    const auditName = recovery ? "recovery-audit.json" : "audit.json";
    const sumsName = recovery ? "RECOVERY_SHA256SUMS" : "SHA256SUMS";
    const auditPath = join(directory, auditName);
    const sumsPath = join(directory, sumsName);
    let publishedAudit = audit;
    let serialized = canonicalBytes(audit);
    if (exists(auditPath)) {
      const existingBytes = readStableBytes(auditPath, this.uid, this.gid, 0o400);
      const existing = JSON.parse(existingBytes.toString("utf8"));
      validateAudit(existing);
      if (
        (recovery && existing.outcome !== "restored")
        || digestAuditIdentity(existing) !== digestAuditIdentity(audit)
      ) {
        throw new Error(
          recovery
            ? "cleanup published recovery audit identity mismatch"
            : "cleanup published audit identity mismatch",
        );
      }
      publishedAudit = existing;
      serialized = existingBytes;
    } else {
      if (exists(sumsPath)) throw new Error("cleanup published audit set is incomplete");
      writeImmutableBytes(auditPath, serialized, this.uid, this.gid, 0o400);
    }
    const digest = createHash("sha256").update(serialized).digest("hex");
    const sums = Buffer.from(`${digest}  ${auditName}\n`, "ascii");
    if (exists(sumsPath)) {
      if (!readStableBytes(sumsPath, this.uid, this.gid, 0o400).equals(sums)) {
        throw new Error("cleanup published audit checksum mismatch");
      }
    } else {
      writeImmutableBytes(sumsPath, sums, this.uid, this.gid, 0o400);
    }
    fsyncDirectory(directory);
    return Object.freeze({ audit: publishedAudit, auditSha256: digest, directory });
  }

  #operationDirectory(operationId, create = false) {
    validateOperationId(operationId);
    const path = join(this.root, `operation-${operationId}`);
    if (create) {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(this.root);
    }
    assertDirectory(path, this.uid, this.gid, 0o700);
    return path;
  }
}

export function confirmationFor(receipt) {
  validateReceipt(receipt);
  return `DELETE-XINGHENG-REAL-TEST-DATA:${receipt.operationId}:${receipt.receiptSha256}`;
}

export function digestCanonical(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function validateReceipt(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "backups", "before", "createdAt", "daemon", "expiresAt", "operation", "operationId",
      "project", "receiptSha256", "revision", "schemaVersion", "targets",
    ].sort().join(",")
  ) throw new Error("cleanup receipt schema is invalid");
  const { receiptSha256, ...core } = value;
  validateReceiptCore(core);
  if (!SHA256.test(receiptSha256) || digestCanonical(core) !== receiptSha256) {
    throw new Error("cleanup receipt digest is invalid");
  }
  return true;
}

function validateReceiptCore(value) {
  if (
    value.schemaVersion !== 1
    || value.operation !== "xingheng-real-test-data-reset"
    || value.project !== "xingheng-real-test"
    || !OPERATION_ID.test(value.operationId ?? "")
    || !FULL_REVISION.test(value.revision ?? "")
    || !Array.isArray(value.targets)
    || value.targets.length !== 3
    || typeof value.daemon !== "object"
    || value.daemon === null
    || typeof value.before !== "object"
    || value.before === null
    || typeof value.backups !== "object"
    || value.backups === null
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
  ) throw new Error("cleanup receipt schema is invalid");
}

function validateJournal(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "failure", "phase", "receiptSha256", "sequence", "updatedAt",
    ].sort().join(",")
    || !PHASES.has(value.phase)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || !SHA256.test(value.receiptSha256 ?? "")
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !(value.failure === null || (
      typeof value.failure === "string"
      && value.failure.length > 0
      && value.failure.length <= 160
      && /^[\x20-\x7e]+$/u.test(value.failure)
    ))
  ) throw new Error("cleanup journal schema is invalid");
}

function validateClaim(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "backupsSha256", "beforeSha256", "claimedAt", "daemonSha256", "operationId",
      "preparedJournalSha256", "receiptCreatedAt", "receiptExpiresAt", "receiptSha256",
      "revision", "schemaVersion", "targetsSha256",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || !OPERATION_ID.test(value.operationId ?? "")
    || !SHA256.test(value.receiptSha256 ?? "")
    || !FULL_REVISION.test(value.revision ?? "")
    || !SHA256.test(value.daemonSha256 ?? "")
    || !SHA256.test(value.targetsSha256 ?? "")
    || !SHA256.test(value.beforeSha256 ?? "")
    || !SHA256.test(value.backupsSha256 ?? "")
    || !SHA256.test(value.preparedJournalSha256 ?? "")
    || !Number.isFinite(Date.parse(value.receiptCreatedAt))
    || !Number.isFinite(Date.parse(value.receiptExpiresAt))
    || !Number.isFinite(Date.parse(value.claimedAt))
  ) throw new Error("cleanup claim schema is invalid");
}

function validateAudit(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "after", "backups", "before", "failureCategory", "occurredAt", "operation",
      "operationId", "outcome", "productionUnchanged", "project", "receiptSha256",
      "revision", "schemaVersion", "sourceJournal", "targets",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || value.operation !== "xingheng-real-test-data-reset"
    || !OPERATION_ID.test(value.operationId ?? "")
    || !["completed", "restored", "incident_restore_failed"].includes(value.outcome)
    || !SHA256.test(value.receiptSha256 ?? "")
    || !Number.isFinite(Date.parse(value.occurredAt))
  ) throw new Error("cleanup audit schema is invalid");
  validateJournal(value.sourceJournal);
}

function initialJournal(receipt) {
  return {
    phase: "prepared",
    sequence: 0,
    receiptSha256: receipt.receiptSha256,
    updatedAt: receipt.createdAt,
    failure: null,
  };
}

function claimFor(receipt, preparedJournal, now) {
  return {
    schemaVersion: 1,
    operationId: receipt.operationId,
    receiptSha256: receipt.receiptSha256,
    revision: receipt.revision,
    daemonSha256: digestCanonical(receipt.daemon),
    targetsSha256: digestCanonical(receipt.targets),
    beforeSha256: digestCanonical(receipt.before),
    backupsSha256: digestCanonical(receipt.backups),
    receiptCreatedAt: receipt.createdAt,
    receiptExpiresAt: receipt.expiresAt,
    preparedJournalSha256: digestCanonical(preparedJournal),
    claimedAt: now.toISOString(),
  };
}

function validateClaimForReceipt(value, receipt, preparedJournal) {
  validateClaim(value);
  const expected = claimFor(receipt, preparedJournal, new Date(value.claimedAt));
  if (
    digestCanonical(value) !== digestCanonical(expected)
    || Date.parse(value.claimedAt) < Date.parse(receipt.createdAt)
    || Date.parse(value.claimedAt) > Date.parse(receipt.expiresAt)
  ) {
    throw new Error("real-test cleanup claim identity mismatch");
  }
}

function digestAuditIdentity(value) {
  const { occurredAt: _occurredAt, ...identity } = value;
  return digestCanonical(identity);
}

function validateOperationId(value) {
  if (!OPERATION_ID.test(value ?? "")) throw new Error("cleanup operation ID is invalid");
}

function secureDirectoryChain(path, uid, gid) {
  const parent = dirname(path);
  if (parent !== path && !exists(parent)) secureDirectoryChain(parent, uid, gid);
  if (!exists(path)) {
    mkdirSync(path, { mode: 0o700 });
    if (parent !== path) fsyncDirectory(parent);
  }
  assertDirectory(path, uid, gid, 0o700);
}

function assertDirectory(path, uid, gid, mode) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.gid !== gid
    || (metadata.mode & 0o777) !== mode
  ) throw new Error("cleanup transaction directory boundary is invalid");
}

function writeImmutableJson(path, value, uid, gid) {
  writeImmutableBytes(path, canonicalBytes(value), uid, gid, 0o400);
}

function writeImmutableBytes(path, bytes, uid, gid, finalMode) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    validateOpenFile(fd, uid, gid, 0o600);
    fchmodSync(fd, finalMode);
    const frozen = fstatSync(fd);
    if ((frozen.mode & 0o777) !== finalMode) throw new Error("cleanup immutable file mode failed");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function writeReplaceJson(path, value, uid, gid, create) {
  const pending = `${path}.pending`;
  if (exists(pending)) {
    const metadata = lstatSync(pending);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.uid !== uid
      || metadata.gid !== gid
      || (metadata.mode & 0o777) !== 0o600
    ) throw new Error("cleanup pending journal boundary is invalid");
    unlinkSync(pending);
    fsyncDirectory(dirname(path));
  }
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, canonicalBytes(value));
    fsyncSync(fd);
    validateOpenFile(fd, uid, gid, 0o600);
  } finally {
    closeSync(fd);
  }
  if (create && exists(path)) throw new Error("cleanup journal already exists");
  renameSync(pending, path);
  fsyncDirectory(dirname(path));
  readStableJson(path, uid, gid, 0o600);
}

function readStableJson(path, uid, gid, mode) {
  return JSON.parse(readStableBytes(path, uid, gid, mode).toString("utf8"));
}

function readStableBytes(path, uid, gid, mode) {
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== uid
    || before.gid !== gid
    || (before.mode & 0o777) !== mode
    || before.size < 2
    || before.size > 1024 * 1024
  ) throw new Error("cleanup transaction file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || opened.nlink !== 1
    ) throw new Error("cleanup transaction file changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("cleanup transaction file changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function validateTrustedParentChain(start) {
  let current = start;
  while (true) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o022) !== 0
    ) throw new Error("cleanup transaction parent directory boundary is invalid");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateOpenFile(fd, uid, gid, mode) {
  const metadata = fstatSync(fd);
  if (
    !metadata.isFile()
    || metadata.nlink !== 1
    || metadata.uid !== uid
    || metadata.gid !== gid
    || (metadata.mode & 0o777) !== mode
  ) throw new Error("cleanup transaction file boundary is invalid");
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortDeep(item)]),
    );
  }
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
