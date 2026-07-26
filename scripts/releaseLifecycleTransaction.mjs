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
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseManifest } from "./deploymentRevision.mjs";
import {
  openTrustedDockerRuntime,
  verifyTrustedDockerRuntime,
} from "./trustedDockerRuntime.mjs";

const PRODUCTION_ROOT = "/var/lib/xingheng/release-lifecycle";
const PRODUCTION_RELEASE_ROOT = "/opt/xingheng-release/code";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FULL_REVISION = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INCIDENT = /^[a-z][a-z0-9_]{2,63}$/u;
const JOURNAL_PHASES = new Set(["prepared", "incident_stopped", "active", "rolled_back"]);

export class ReleaseLifecycleTransactionStore {
  constructor(root = PRODUCTION_ROOT, options = {}) {
    this.root = root;
    this.testMode = options.testMode === true;
    this.uid = this.testMode ? (process.getuid?.() ?? -1) : 0;
    this.gid = this.testMode ? (process.getgid?.() ?? -1) : 0;
    if (!this.testMode && (process.getuid?.() !== 0 || process.getgid?.() !== 0)) {
      throw new Error("release lifecycle transaction requires controlled root");
    }
    secureDirectory(root, this.uid, this.gid);
    secureDirectory(join(root, "operations"), this.uid, this.gid);
    secureDirectory(join(root, "environment-snapshots"), this.uid, this.gid);
  }

  establish(manifestPath, environmentPath, daemon, now = new Date()) {
    if (existsNoFollow(this.currentPath)) {
      throw new Error("verified release pointer is already established");
    }
    const candidate = captureCandidate(
      manifestPath,
      environmentPath,
      this.testMode,
      this.uid,
      this.gid,
    );
    validateDaemon(daemon);
    const environmentArtifact = this.snapshotEnvironment(candidate);
    const pointer = {
      schemaVersion: 1,
      revision: candidate.revision,
      images: candidate.images,
      manifestSha256: candidate.manifest.sha256,
      environmentSha256: candidate.environment.sha256,
      environmentArtifact,
      daemon,
      establishedAt: now.toISOString(),
      operationId: null,
    };
    validatePointer(pointer);
    writeReplaceJson(this.currentPath, pointer, this.uid, this.gid, true);
    return pointer;
  }

  removeUnmarkedEstablishment(revision) {
    if (!FULL_REVISION.test(revision)) {
      throw new Error("verified release unestablish revision is invalid");
    }
    const pointer = this.readCurrent();
    if (pointer.operationId !== null || pointer.revision !== revision) {
      throw new Error("verified release pointer cannot be unestablished");
    }
    unlinkSync(this.currentPath);
    fsyncDirectory(dirname(this.currentPath));
  }

  prepare(manifestPath, environmentPath, daemon, now = new Date()) {
    this.assertNoOpenOperation();
    validateDaemon(daemon);
    const previous = this.readCurrent();
    if (canonical(previous.daemon) !== canonical(daemon)) {
      throw new Error("release lifecycle Docker daemon identity changed");
    }
    const candidate = captureCandidate(
      manifestPath,
      environmentPath,
      this.testMode,
      this.uid,
      this.gid,
    );
    if (candidate.revision === previous.revision) {
      throw new Error("release lifecycle candidate is already active");
    }
    const operationId = randomUUID();
    const operationDirectory = join(this.root, "operations", `operation-${operationId}`);
    secureDirectory(operationDirectory, this.uid, this.gid, true);
    const intent = {
      schemaVersion: 1,
      operationId,
      operation: "verified-release-upgrade",
      createdAt: now.toISOString(),
      daemon,
      previous,
      candidate,
    };
    validateIntent(intent);
    writeImmutableJson(join(operationDirectory, "intent.json"), intent, this.uid, this.gid);
    writeReplaceJson(join(operationDirectory, "journal.json"), {
      schemaVersion: 1,
      operationId,
      phase: "prepared",
      sequence: 0,
      updatedAt: now.toISOString(),
      incidentCategory: null,
    }, this.uid, this.gid, true);
    return intent;
  }

  markIncident(operationId, category, now = new Date()) {
    if (!INCIDENT.test(category)) throw new Error("release lifecycle incident category is invalid");
    const { intent, journal, directory } = this.readOperation(operationId);
    if (journal.phase === "active" || journal.phase === "rolled_back") {
      throw new Error("completed release lifecycle cannot become an incident");
    }
    const next = {
      ...journal,
      phase: "incident_stopped",
      sequence: journal.sequence + 1,
      updatedAt: now.toISOString(),
      incidentCategory: category,
    };
    writeReplaceJson(join(directory, "journal.json"), next, this.uid, this.gid);
    return { intent, journal: next };
  }

  complete(operationId, manifestPath, environmentPath, daemon, now = new Date()) {
    const { intent, journal, directory } = this.readOperation(operationId);
    if (journal.phase !== "prepared") {
      throw new Error("release lifecycle completion phase is invalid");
    }
    validateDaemon(daemon);
    if (canonical(daemon) !== canonical(intent.daemon)) {
      throw new Error("release lifecycle Docker daemon identity changed");
    }
    const candidate = captureCandidate(
      manifestPath,
      environmentPath,
      this.testMode,
      this.uid,
      this.gid,
    );
    if (canonical(candidate) !== canonical(intent.candidate)) {
      throw new Error("release lifecycle candidate identity changed");
    }
    const pointer = {
      schemaVersion: 1,
      revision: candidate.revision,
      images: candidate.images,
      manifestSha256: candidate.manifest.sha256,
      environmentSha256: candidate.environment.sha256,
      environmentArtifact: this.snapshotEnvironment(candidate),
      daemon,
      establishedAt: now.toISOString(),
      operationId,
    };
    validatePointer(pointer);
    writeReplaceJson(this.currentPath, pointer, this.uid, this.gid);
    writeReplaceJson(join(directory, "journal.json"), {
      ...journal,
      phase: "active",
      sequence: journal.sequence + 1,
      updatedAt: now.toISOString(),
      incidentCategory: null,
    }, this.uid, this.gid);
    return pointer;
  }

  rollbackValues(operationId) {
    const { intent, journal } = this.readOperation(operationId);
    if (journal.phase !== "incident_stopped") {
      throw new Error("release lifecycle rollback is not permitted");
    }
    return {
      revision: intent.previous.revision,
      images: intent.previous.images,
      daemon: intent.daemon,
      environmentSha256: intent.previous.environmentSha256,
      environmentArtifact: intent.previous.environmentArtifact,
    };
  }

  markRolledBack(operationId, daemon, now = new Date()) {
    const { intent, journal, directory } = this.readOperation(operationId);
    if (journal.phase !== "incident_stopped") {
      throw new Error("release lifecycle rollback completion phase is invalid");
    }
    validateDaemon(daemon);
    if (canonical(daemon) !== canonical(intent.daemon)) {
      throw new Error("release lifecycle Docker daemon identity changed");
    }
    writeReplaceJson(this.currentPath, intent.previous, this.uid, this.gid);
    writeReplaceJson(join(directory, "journal.json"), {
      ...journal,
      phase: "rolled_back",
      sequence: journal.sequence + 1,
      updatedAt: now.toISOString(),
    }, this.uid, this.gid);
    return intent.previous;
  }

  restoreEnvironment(operationId, targetPath) {
    const { intent, journal } = this.readOperation(operationId);
    if (journal.phase !== "incident_stopped") {
      throw new Error("release lifecycle environment restore is not permitted");
    }
    const target = resolve(targetPath);
    if (!this.testMode && target !== `${PRODUCTION_RELEASE_ROOT}/.env.production`) {
      throw new Error("release lifecycle environment restore target is not canonical");
    }
    const artifact = intent.previous.environmentArtifact;
    const source = join(this.root, "environment-snapshots", artifact.fileName);
    const opened = secureFile(source, this.uid, this.gid, 0o400);
    try {
      if (opened.sha256 !== artifact.sha256 || opened.size !== artifact.size) {
        throw new Error("release lifecycle environment snapshot identity mismatch");
      }
      writeAtomicBytes(target, opened.bytes, this.uid, this.gid, 0o600);
    } finally {
      opened.bytes.fill(0);
    }
    const restored = secureFile(target, this.uid, this.gid, 0o600);
    try {
      if (restored.sha256 !== artifact.sha256 || restored.size !== artifact.size) {
        throw new Error("release lifecycle environment restore verification failed");
      }
    } finally {
      restored.bytes.fill(0);
    }
    return artifact.sha256;
  }

  readCurrent() {
    const value = readStableJson(this.currentPath, this.uid, this.gid, 0o600);
    validatePointer(value);
    return value;
  }

  readOperation(operationId) {
    if (!OPERATION_ID.test(operationId)) throw new Error("release lifecycle operation ID is invalid");
    const directory = join(this.root, "operations", `operation-${operationId}`);
    assertDirectory(directory, this.uid, this.gid);
    const intent = readStableJson(join(directory, "intent.json"), this.uid, this.gid, 0o400);
    const journal = readStableJson(join(directory, "journal.json"), this.uid, this.gid, 0o600);
    validateIntent(intent);
    validateJournal(journal);
    if (intent.operationId !== operationId || journal.operationId !== operationId) {
      throw new Error("release lifecycle operation identity mismatch");
    }
    return { intent, journal, directory };
  }

  assertNoOpenOperation() {
    const root = join(this.root, "operations");
    for (const name of readdirSync(root).sort()) {
      const match = /^operation-([0-9a-f-]{36})$/u.exec(name);
      if (!match || !OPERATION_ID.test(match[1])) {
        throw new Error("release lifecycle operation directory set is invalid");
      }
      const journal = readStableJson(join(root, name, "journal.json"), this.uid, this.gid, 0o600);
      validateJournal(journal);
      if (journal.phase === "prepared" || journal.phase === "incident_stopped") {
        throw new Error("release lifecycle has an unresolved operation");
      }
    }
  }

  snapshotEnvironment(candidate) {
    const opened = secureFile(candidate.environment.path, this.uid, this.gid, 0o600);
    try {
      if (
        opened.dev !== candidate.environment.dev
        || opened.ino !== candidate.environment.ino
        || opened.size !== candidate.environment.size
        || opened.mtimeMs !== candidate.environment.mtimeMs
        || opened.ctimeMs !== candidate.environment.ctimeMs
        || opened.sha256 !== candidate.environment.sha256
      ) throw new Error("release lifecycle environment changed before snapshot");
      const fileName = `environment-${candidate.revision}-${opened.sha256}.env`;
      const path = join(this.root, "environment-snapshots", fileName);
      if (!existsNoFollow(path)) {
        writeImmutableBytes(path, opened.bytes, this.uid, this.gid, 0o400);
      }
      const verified = secureFile(path, this.uid, this.gid, 0o400);
      try {
        if (verified.sha256 !== opened.sha256 || verified.size !== opened.size) {
          throw new Error("release lifecycle environment snapshot verification failed");
        }
      } finally {
        verified.bytes.fill(0);
      }
      return {
        fileName,
        sha256: opened.sha256,
        size: opened.size,
      };
    } finally {
      opened.bytes.fill(0);
    }
  }

  get currentPath() {
    return join(this.root, "current.json");
  }
}

export function validateRollbackRuntimeEvidence(expected, evidence) {
  validateImages(expected.images);
  if (
    !expected
    || !FULL_REVISION.test(expected.revision ?? "")
    || !evidence
    || typeof evidence !== "object"
    || Object.keys(evidence).sort().join(",") !== "api,web"
  ) throw new Error("release rollback runtime evidence is invalid");
  for (const [service, imageKey] of [["api", "api"], ["web", "web"]]) {
    const item = evidence[service];
    if (
      !item
      || typeof item !== "object"
      || Object.keys(item).sort().join(",") !== [
        "builtRevision", "containerId", "healthy", "imageDigest", "restartCount",
        "runtimeRevision",
      ].sort().join(",")
      || !/^[a-f0-9]{12,64}$/u.test(item.containerId ?? "")
      || item.imageDigest !== expected.images[imageKey]
      || item.builtRevision !== expected.revision
      || item.runtimeRevision !== expected.revision
      || item.healthy !== true
      || !Number.isSafeInteger(item.restartCount)
      || item.restartCount < 0
    ) throw new Error("release rollback runtime identity mismatch");
  }
  return true;
}

function inspectRollbackRuntime(expected) {
  const evidence = {};
  for (const [service, imageKey] of [["api", "api"], ["web", "web"]]) {
    const all = dockerText([
      "ps", "-a",
      "--filter", "label=com.docker.compose.project=xingheng",
      "--filter", `label=com.docker.compose.service=${service}`,
      "--format", "{{.ID}}",
    ]).split(/\r?\n/u).filter(Boolean);
    const running = dockerText([
      "ps",
      "--filter", "label=com.docker.compose.project=xingheng",
      "--filter", `label=com.docker.compose.service=${service}`,
      "--format", "{{.ID}}",
    ]).split(/\r?\n/u).filter(Boolean);
    if (all.length !== 1 || running.length !== 1 || all[0] !== running[0]) {
      throw new Error("release rollback container set is invalid");
    }
    const inspected = JSON.parse(dockerText(["container", "inspect", all[0]]));
    if (!Array.isArray(inspected) || inspected.length !== 1) {
      throw new Error("release rollback container inspection is invalid");
    }
    const container = inspected[0];
    const labels = container?.Config?.Labels ?? {};
    const runtimeRevision = String(
      (container?.Config?.Env ?? [])
        .find((entry) => entry.startsWith("XINGHENG_EXPECTED_REVISION="))
        ?.slice("XINGHENG_EXPECTED_REVISION=".length) ?? "",
    );
    evidence[service] = {
      containerId: all[0],
      imageDigest: String(container?.Image ?? ""),
      builtRevision: String(labels["org.opencontainers.image.revision"] ?? ""),
      runtimeRevision,
      healthy: container?.State?.Running === true
        && container?.State?.Health?.Status === "healthy",
      restartCount: Number(container?.RestartCount),
    };
    if (evidence[service].imageDigest !== expected.images[imageKey]) {
      throw new Error("release rollback image digest mismatch");
    }
  }
  validateRollbackRuntimeEvidence(expected, evidence);
  return evidence;
}

function dockerText(args) {
  return execTrustedDockerSync(args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function captureCandidate(path, environmentPath, testMode, uid, gid) {
  const manifestPath = resolve(path);
  const envPath = resolve(environmentPath);
  if (!testMode) {
    if (manifestPath !== `${PRODUCTION_RELEASE_ROOT}/deploy/release-manifest.json`) {
      throw new Error("release lifecycle manifest path is not canonical");
    }
    if (envPath !== `${PRODUCTION_RELEASE_ROOT}/.env.production`) {
      throw new Error("release lifecycle environment path is not canonical");
    }
  }
  const manifest = secureFile(manifestPath, uid, gid, testMode ? null : 0o444);
  const environment = secureFile(envPath, uid, gid, 0o600);
  const parsed = validateReleaseManifest(JSON.parse(manifest.bytes.toString("utf8")));
  manifest.bytes.fill(0);
  environment.bytes.fill(0);
  return {
    revision: parsed.revision,
    images: {
      api: parsed.images.api,
      web: parsed.images.web,
      strategyTools: parsed.images.strategyTools,
    },
    manifest: receiptWithoutBytes(manifest),
    environment: receiptWithoutBytes(environment),
  };
}

function secureFile(path, uid, gid, exactMode) {
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== uid
    || before.gid !== gid
    || before.size < 1
    || before.size > 16 * 1024 * 1024
    || (exactMode === null ? (before.mode & 0o022) !== 0 : (before.mode & 0o777) !== exactMode)
  ) throw new Error("release lifecycle file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== uid
      || opened.gid !== gid
      || opened.nlink !== 1
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) throw new Error("release lifecycle file changed while opening");
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("release lifecycle file was truncated");
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("release lifecycle file changed while reading");
    return {
      path,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

function receiptWithoutBytes(value) {
  const { bytes: _bytes, ...receipt } = value;
  return receipt;
}

function validatePointer(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "daemon", "environmentArtifact", "environmentSha256", "establishedAt", "images", "manifestSha256",
      "operationId", "revision", "schemaVersion",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || !FULL_REVISION.test(value.revision ?? "")
    || !SHA256.test(value.manifestSha256 ?? "")
    || !SHA256.test(value.environmentSha256 ?? "")
    || (value.operationId !== null && !OPERATION_ID.test(value.operationId ?? ""))
    || !validDate(value.establishedAt)
  ) throw new Error("verified release pointer schema is invalid");
  validateImages(value.images);
  validateDaemon(value.daemon);
  validateEnvironmentArtifact(value.environmentArtifact);
}

function validateEnvironmentArtifact(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "fileName,sha256,size"
    || !/^environment-[a-f0-9]{40}-[a-f0-9]{64}\.env$/u.test(value.fileName ?? "")
    || !SHA256.test(value.sha256 ?? "")
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || value.size > 16 * 1024 * 1024
  ) throw new Error("release lifecycle environment artifact schema is invalid");
}

function validateIntent(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "candidate", "createdAt", "daemon", "operation", "operationId", "previous", "schemaVersion",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || value.operation !== "verified-release-upgrade"
    || !OPERATION_ID.test(value.operationId ?? "")
    || !validDate(value.createdAt)
  ) throw new Error("release lifecycle intent schema is invalid");
  validatePointer(value.previous);
  validateCandidate(value.candidate);
  validateDaemon(value.daemon);
}

function validateCandidate(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "environment,images,manifest,revision"
    || !FULL_REVISION.test(value.revision ?? "")
  ) throw new Error("release lifecycle candidate schema is invalid");
  validateImages(value.images);
  validateFileReceipt(value.manifest);
  validateFileReceipt(value.environment);
}

function validateFileReceipt(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "ctimeMs", "dev", "ino", "mode", "mtimeMs", "path", "sha256", "size",
    ].sort().join(",")
    || !Number.isSafeInteger(value.dev)
    || !Number.isSafeInteger(value.ino)
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || !Number.isSafeInteger(value.mode)
    || !Number.isFinite(value.mtimeMs)
    || !Number.isFinite(value.ctimeMs)
    || !SHA256.test(value.sha256 ?? "")
  ) throw new Error("release lifecycle file receipt schema is invalid");
}

function validateImages(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "api,strategyTools,web"
    || !Object.values(value).every((item) => /^sha256:[a-f0-9]{64}$/u.test(item))
  ) throw new Error("release lifecycle image set is invalid");
}

function validateDaemon(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "id,rootDir,serverVersion,storageDriver"
    || typeof value.id !== "string"
    || value.id.length < 8
    || typeof value.rootDir !== "string"
    || !value.rootDir.startsWith("/")
    || typeof value.serverVersion !== "string"
    || value.serverVersion.length < 1
    || typeof value.storageDriver !== "string"
    || value.storageDriver.length < 1
  ) throw new Error("release lifecycle Docker daemon identity is invalid");
}

function validateJournal(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "incidentCategory", "operationId", "phase", "schemaVersion", "sequence", "updatedAt",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || !OPERATION_ID.test(value.operationId ?? "")
    || !JOURNAL_PHASES.has(value.phase)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || !validDate(value.updatedAt)
    || (value.incidentCategory !== null && !INCIDENT.test(value.incidentCategory ?? ""))
  ) throw new Error("release lifecycle journal schema is invalid");
}

function secureDirectory(path, uid, gid, create = false) {
  if (create) mkdirSync(path, { mode: 0o700 });
  else {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  assertDirectory(path, uid, gid);
  fsyncDirectory(dirname(path));
}

function assertDirectory(path, uid, gid) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.gid !== gid
    || (metadata.mode & 0o777) !== 0o700
  ) throw new Error("release lifecycle directory boundary is invalid");
}

function readStableJson(path, uid, gid, mode) {
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
  ) throw new Error("release lifecycle state boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) throw new Error("release lifecycle state changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("release lifecycle state changed while reading");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function writeImmutableJson(path, value, uid, gid) {
  const bytes = Buffer.from(`${canonical(value)}\n`, "utf8");
  writeImmutableBytes(path, bytes, uid, gid, 0o400);
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
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== uid
      || metadata.gid !== gid
    ) throw new Error("release lifecycle immutable state boundary is invalid");
    fchmodSync(fd, finalMode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function writeAtomicBytes(path, bytes, uid, gid, mode) {
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`;
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== uid
      || metadata.gid !== gid
      || (metadata.mode & 0o777) !== mode
    ) throw new Error("release lifecycle restored environment boundary is invalid");
  } finally {
    closeSync(fd);
  }
  renameSync(pending, path);
  fsyncDirectory(dirname(path));
}

function writeReplaceJson(path, value, uid, gid, createOnly = false) {
  if (createOnly && existsNoFollow(path)) {
    throw new Error("release lifecycle state already exists");
  }
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`;
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${canonical(value)}\n`, "utf8");
    fsyncSync(fd);
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== uid
      || metadata.gid !== gid
      || (metadata.mode & 0o777) !== 0o600
    ) throw new Error("release lifecycle pending state boundary is invalid");
  } finally {
    closeSync(fd);
  }
  renameSync(pending, path);
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function productionDaemon() {
  const runtime = openTrustedDockerRuntime("docker", process.env);
  try {
    if (!runtime.daemon) throw new Error("trusted Docker daemon identity is unavailable");
    verifyTrustedDockerRuntime(runtime);
    return runtime.daemon;
  } finally {
    runtime.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const testMode = process.env.NODE_ENV === "test" && process.env.NODE_TEST_CONTEXT !== undefined;
  if (!testMode && process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production") {
    throw new Error("release lifecycle mutation requires the trusted production operation lock");
  }
  const root = testMode && process.env.XINGHENG_TEST_RELEASE_LIFECYCLE_ROOT
    ? process.env.XINGHENG_TEST_RELEASE_LIFECYCLE_ROOT
    : PRODUCTION_ROOT;
  const store = new ReleaseLifecycleTransactionStore(root, { testMode });
  const daemon = testMode
    ? JSON.parse(process.env.XINGHENG_TEST_DAEMON_IDENTITY ?? "null")
    : productionDaemon();
  if (command === "establish" && args.length === 2) {
    const pointer = store.establish(args[0], args[1], daemon);
    console.log(pointer.revision);
    return;
  }
  if (command === "prepare" && args.length === 2) {
    const intent = store.prepare(args[0], args[1], daemon);
    console.log(intent.operationId);
    return;
  }
  if (command === "unestablish" && args.length === 1) {
    store.removeUnmarkedEstablishment(args[0]);
    console.log("unestablished");
    return;
  }
  if (command === "complete" && args.length === 3) {
    const pointer = store.complete(args[0], args[1], args[2], daemon);
    console.log(pointer.revision);
    return;
  }
  if (command === "incident" && args.length === 2) {
    store.markIncident(args[0], args[1]);
    console.log("incident_stopped");
    return;
  }
  if (command === "rollback-values" && args.length === 1) {
    const value = store.rollbackValues(args[0]);
    console.log([
      value.revision,
      value.images.api,
      value.images.web,
      value.images.strategyTools,
      value.environmentSha256,
    ].join("\n"));
    return;
  }
  if (command === "restore-environment" && args.length === 2) {
    console.log(store.restoreEnvironment(args[0], args[1]));
    return;
  }
  if (command === "verify-rollback-runtime" && args.length === 1) {
    const expected = store.rollbackValues(args[0]);
    validateDaemon(daemon);
    if (canonical(daemon) !== canonical(expected.daemon)) {
      throw new Error("release lifecycle Docker daemon identity changed");
    }
    inspectRollbackRuntime(expected);
    console.log(expected.revision);
    return;
  }
  if (command === "rolled-back" && args.length === 1) {
    console.log(store.markRolledBack(args[0], daemon).revision);
    return;
  }
  throw new Error(
    "usage: releaseLifecycleTransaction.mjs establish MANIFEST ENV"
    + " | unestablish REVISION | prepare MANIFEST ENV | complete OPERATION MANIFEST ENV"
    + " | incident OPERATION CATEGORY | rollback-values OPERATION"
    + " | restore-environment OPERATION ENV | verify-rollback-runtime OPERATION"
    + " | rolled-back OPERATION",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "release lifecycle transaction failed");
    process.exit(1);
  });
}
