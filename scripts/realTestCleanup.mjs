import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  CleanupTransactionStore,
  confirmationFor,
  digestCanonical,
} from "./cleanupTransactionStore.mjs";
import { acquireOrUseOperationLocks } from "./operationLocks.mjs";
import { execTrustedDockerSync } from "./trustedDockerRuntime.mjs";

export const REAL_TEST_RESET_CONFIRMATION = "DELETE-XINGHENG-REAL-TEST-DATA";
export const REAL_TEST_RESET_VOLUMES = Object.freeze([
  "xingheng-real-test_sqlite_data",
  "xingheng-real-test_strategy_data",
  "xingheng-real-test_rwa_automation_data",
]);
export const PRODUCTION_PROTECTED_VOLUMES = Object.freeze([
  "xingheng_sqlite_data",
  "xingheng_strategy_data",
  "xingheng_sqlite_backups",
  "xingheng_rwa_automation_data",
  "xingheng_rwa_automation_backups",
  "xingheng_rwa_automation_lock",
  "xingheng_caddy_data",
  "xingheng_caddy_config",
]);

const MANIFEST = "deploy/release-manifest.json";
const PRODUCTION_ENV = ".env.production";
const REAL_TEST_ENV = ".env.real-test";
const AUDIT_ROOT = "/var/lib/xingheng-real-test/reset-audit";
const SQLITE_BACKUP_VOLUME = "xingheng-real-test_sqlite_backups";
const RWA_BACKUP_VOLUME = "xingheng-real-test_rwa_automation_backups";
const STRATEGY_BACKUP_VOLUME = SQLITE_BACKUP_VOLUME;
const GENERATION_PATTERN = /^generation-(?:initial|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/u;

export function validateCleanupTargets(targets) {
  if (
    !Array.isArray(targets)
    || targets.length !== REAL_TEST_RESET_VOLUMES.length
    || targets.some((value, index) => value !== REAL_TEST_RESET_VOLUMES[index])
    || targets.some((value) => PRODUCTION_PROTECTED_VOLUMES.includes(value))
  ) {
    throw new Error("real-test cleanup target allowlist mismatch");
  }
  return true;
}

export function validateCleanupEvidence(before, after) {
  const keys = [
    "productionContainers",
    "productionVolumes",
    "productionNetworks",
    "productionSqlite",
    "productionRwa",
    "productionStrategy",
    "productionCaddy",
  ];
  for (const key of keys) {
    if (!/^[a-f0-9]{64}$/u.test(before?.[key] ?? "") || after?.[key] !== before[key]) {
      throw new Error("production evidence changed during real-test cleanup");
    }
  }
  if (
    before.productionRevision !== after.productionRevision
    || !/^[a-f0-9]{40}$/u.test(before.productionRevision ?? "")
    || before.productionHealthy !== true
    || after.productionHealthy !== true
  ) {
    throw new Error("production runtime changed during real-test cleanup");
  }
  for (const key of [
    "realTestContainers",
    "realTestVolumes",
    "realTestNetworks",
    "realTestRuntimeContract",
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(before?.[key] ?? "")
      || !/^[a-f0-9]{64}$/u.test(after?.[key] ?? "")) {
      throw new Error("real-test runtime evidence is invalid");
    }
  }
  if (
    before.realTestRevision !== after.realTestRevision
    || !/^[a-f0-9]{40}$/u.test(before.realTestRevision ?? "")
    || before.realTestHealthy !== true
    || after.realTestHealthy !== true
    || before.realTestRuntimeContract !== after.realTestRuntimeContract
  ) {
    throw new Error("real-test runtime contract changed during cleanup");
  }
  return true;
}

export function runCleanup({
  mode,
  operationId,
  confirmation,
  run = runCommand,
  now = () => new Date(),
  transactionStore,
  acquireLocks = () => acquireOrUseOperationLocks("real-test"),
  inspectArtifact = secureBackupArtifactEvidence,
  captureEvidence = runtimeEvidence,
  captureDaemon = daemonEvidence,
  verifyRuntime = verifyDualRuntime,
}) {
  if (!["prepare", "execute"].includes(mode)) throw new Error("real-test cleanup mode is invalid");
  const locks = acquireLocks();
  try {
    const store = transactionStore ?? new CleanupTransactionStore(AUDIT_ROOT);
    return mode === "prepare"
      ? prepareCleanup({
        run, now, store, inspectArtifact, captureEvidence, captureDaemon, verifyRuntime,
      })
      : executeCleanup({
        operationId,
        confirmation,
        run,
        now,
        store,
        inspectArtifact,
        captureEvidence,
        captureDaemon,
        verifyRuntime,
      });
  } finally {
    locks.close();
  }
}

function prepareCleanup({
  run,
  now,
  store,
  inspectArtifact,
  captureEvidence,
  captureDaemon,
  verifyRuntime,
}) {
  validateCleanupTargets([...REAL_TEST_RESET_VOLUMES]);
  verifyRuntime(run);
  const before = captureEvidence(run);
  const daemon = captureDaemon(run);
  let stopped = false;
  try {
    run("scripts/real-test-compose.sh", ["stop", "api", "web"]);
    stopped = true;
    const backups = createAndVerifyBackups(run, inspectArtifact);
    run("scripts/real-test-compose.sh", ["up", "-d", "api", "web"]);
    stopped = false;
    verifyRuntime(run);
    validateCleanupEvidence(before, captureEvidence(run));
    const receipt = store.createPrepared({
      revision: before.productionRevision,
      daemon,
      targets: [...REAL_TEST_RESET_VOLUMES],
      before,
      backups,
      now: now(),
    });
    return {
      dryRun: true,
      operationId: receipt.operationId,
      receiptSha256: receipt.receiptSha256,
      expiresAt: receipt.expiresAt,
      confirmation: confirmationFor(receipt),
      targets: [...REAL_TEST_RESET_VOLUMES],
      before,
      backups,
    };
  } catch (error) {
    if (stopped) {
      try {
        run("scripts/real-test-compose.sh", ["up", "-d", "api", "web"]);
        verifyRuntime(run);
        validateCleanupEvidence(before, captureEvidence(run));
      } catch (restartError) {
        throw new Error(
          `real-test cleanup preparation failed and test runtime did not recover (${safeError(restartError)})`,
        );
      }
    }
    throw error;
  }
}

function executeCleanup({
  operationId,
  confirmation,
  run,
  now,
  store,
  inspectArtifact,
  captureEvidence,
  captureDaemon,
  verifyRuntime,
}) {
  const currentTime = now();
  const receipt = store.readReceipt(operationId);
  const journal = store.claim(operationId, confirmation, currentTime);
  if (journal.phase === "completed" || journal.phase === "restored") {
    return {
      dryRun: false,
      replayed: true,
      outcome: journal.phase,
      operationId,
      targets: [...REAL_TEST_RESET_VOLUMES],
    };
  }
  if (journal.phase === "audit_pending") {
    verifyRuntime(run);
    const after = captureEvidence(run);
    validateCleanupEvidence(receipt.before, after);
    const sourceJournal = store.readJournal(receipt.operationId);
    const published = store.publishAudit(
      receipt.operationId,
      cleanupAudit(receipt, "completed", sourceJournal, {
        after,
        productionUnchanged: true,
        failureCategory: null,
      }),
    );
    validatePublishedAudit(receipt, published.audit, ["completed"]);
    advanceFromStore(store, receipt, "completed", now);
    return {
      dryRun: false,
      replayed: true,
      outcome: "completed",
      operationId,
      targets: [...REAL_TEST_RESET_VOLUMES],
      after,
    };
  }
  if (journal.phase !== "claimed") {
    return resumeRestore({
      receipt, run, now, store, inspectArtifact, captureEvidence, verifyRuntime,
    });
  }
  verifyRuntime(run);
  const current = captureEvidence(run);
  validateCleanupEvidence(receipt.before, current);
  if (digestCanonical(receipt.before) !== digestCanonical(current)) {
    throw new Error("real-test cleanup prepared production snapshot changed");
  }
  if (digestCanonical(receipt.daemon) !== digestCanonical(captureDaemon(run))) {
    throw new Error("real-test cleanup Docker daemon identity changed");
  }
  assertPreparedBackups(run, receipt.backups, inspectArtifact);

  try {
    advance(store, receipt, journal, "stopping", now);
    run("scripts/real-test-compose.sh", ["down", "--remove-orphans"]);
    advanceFromStore(store, receipt, "containers_removed", now);
    assertNoResetVolumeReferences(run);
    advanceFromStore(store, receipt, "removing_volumes", now);
    for (const volume of REAL_TEST_RESET_VOLUMES) run("docker", ["volume", "rm", volume]);
    advanceFromStore(store, receipt, "volumes_removed", now);
    advanceFromStore(store, receipt, "creating_volumes", now);
    for (const volume of REAL_TEST_RESET_VOLUMES) run("docker", ["volume", "create", volume]);
    advanceFromStore(store, receipt, "volumes_created", now);
    advanceFromStore(store, receipt, "initializing_volumes", now);
    initializeRealTestVolumes(run);
    advanceFromStore(store, receipt, "volumes_initialized", now);
    advanceFromStore(store, receipt, "starting_empty_runtime", now);
    run("scripts/real-test-compose.sh", ["up", "-d", "api", "web"]);
    advanceFromStore(store, receipt, "empty_runtime_started", now);
    advanceFromStore(store, receipt, "verifying_empty_runtime", now);
    verifyRuntime(run);
    const after = captureEvidence(run);
    validateCleanupEvidence(receipt.before, after);
    advanceFromStore(store, receipt, "audit_pending", now);
    const sourceJournal = store.readJournal(receipt.operationId);
    const audit = cleanupAudit(receipt, "completed", sourceJournal, {
      after,
      productionUnchanged: true,
      failureCategory: null,
    });
    store.publishAudit(receipt.operationId, audit);
    advanceFromStore(store, receipt, "completed", now);
    return {
      dryRun: false,
      replayed: false,
      outcome: "completed",
      operationId: receipt.operationId,
      targets: [...REAL_TEST_RESET_VOLUMES],
      before: receipt.before,
      after,
    };
  } catch (error) {
    const durableJournal = store.readJournal(receipt.operationId);
    if (durableJournal.phase === "completed") {
      const existing = store.readPublishedAudit(receipt.operationId);
      if (!existing) throw new Error("real-test cleanup completed audit is missing");
      const published = store.publishAudit(receipt.operationId, existing.audit);
      validatePublishedAudit(receipt, published.audit, ["completed"]);
      requireCompletedAuditJournal(published.audit, durableJournal);
      return {
        dryRun: false,
        replayed: true,
        outcome: "completed",
        operationId: receipt.operationId,
        targets: [...REAL_TEST_RESET_VOLUMES],
        before: receipt.before,
        after: published.audit.after,
      };
    }
    if (durableJournal.phase === "audit_pending") {
      throw new Error(
        `real-test cleanup audit is pending; retry the same operation (${safeError(error)})`,
      );
    }
    try {
      advanceFromStore(store, receipt, "restore_required", now, safeError(error));
    } catch {
      // The last durable intent already identifies a recovery-only path.
    }
    const restored = resumeRestore({
      receipt, run, now, store, inspectArtifact, captureEvidence, verifyRuntime,
    });
    if (restored.outcome !== "restored") {
      throw new Error("real-test cleanup incident: restore failed; services remain stopped");
    }
    throw error;
  }
}

function resumeRestore({
  receipt,
  run,
  now,
  store,
  inspectArtifact,
  captureEvidence,
  verifyRuntime,
}) {
  let restoreFailure = null;
  let currentJournal = store.readJournal(receipt.operationId);
  const recoveryAudit = store.readPublishedAudit(receipt.operationId, { recovery: true });
  if (recoveryAudit) {
    const published = store.publishRecoveryAudit(receipt.operationId, recoveryAudit.audit);
    validatePublishedAudit(receipt, published.audit, ["restored"]);
    requireAuditSourceJournal(published.audit, currentJournal);
    advanceFromStore(store, receipt, "restored", now);
    return restoredResult(receipt);
  }
  const regularAudit = store.readPublishedAudit(receipt.operationId);
  let recoveryAfterIncident = currentJournal.phase === "incident_restore_failed";
  if (regularAudit) {
    const published = store.publishAudit(receipt.operationId, regularAudit.audit);
    validatePublishedAudit(
      receipt,
      published.audit,
      ["restored", "incident_restore_failed"],
    );
    if (published.audit.outcome === "restored") {
      requireAuditSourceJournal(published.audit, currentJournal);
      advanceFromStore(store, receipt, "restored", now);
      return restoredResult(receipt);
    }
    if (digestCanonical(published.audit.sourceJournal) === digestCanonical(currentJournal)) {
      advanceFromStore(
        store,
        receipt,
        "incident_restore_failed",
        now,
        published.audit.failureCategory,
      );
      throw new Error("real-test cleanup incident: restore failed; services remain stopped");
    }
    if (currentJournal.sequence <= published.audit.sourceJournal.sequence) {
      throw new Error("cleanup published incident journal identity mismatch");
    }
    recoveryAfterIncident = true;
  }
  let terminalAuditPublished = false;
  try {
    advanceFromStore(store, receipt, "restoring", now);
    assertPreparedBackups(run, receipt.backups, inspectArtifact);
    restoreRealTest(
      run,
      receipt.backups,
      receipt.before,
      inspectArtifact,
      captureEvidence,
      verifyRuntime,
    );
    const after = captureEvidence(run);
    validateCleanupEvidence(receipt.before, after);
    currentJournal = store.readJournal(receipt.operationId);
    const publish = recoveryAfterIncident
      ? store.publishRecoveryAudit.bind(store)
      : store.publishAudit.bind(store);
    const published = publish(
      receipt.operationId,
      cleanupAudit(receipt, "restored", currentJournal, {
        after,
        productionUnchanged: true,
        failureCategory: "cleanup_interrupted_or_failed",
      }),
    );
    validatePublishedAudit(receipt, published.audit, ["restored"]);
    terminalAuditPublished = true;
    advanceFromStore(store, receipt, "restored", now);
    return restoredResult(receipt);
  } catch (error) {
    if (terminalAuditPublished) {
      throw new Error(
        `real-test cleanup terminal audit is pending; retry the same operation (${safeError(error)})`,
      );
    }
    restoreFailure = error;
    try {
      run("scripts/real-test-compose.sh", ["down", "--remove-orphans"]);
    } catch {
      // A stable incident never attempts to restart an unverified test runtime.
    }
    let incidentAuditPublished = false;
    try {
      currentJournal = store.readJournal(receipt.operationId);
      const published = store.publishAudit(
        receipt.operationId,
        cleanupAudit(receipt, "incident_restore_failed", currentJournal, {
          after: null,
          productionUnchanged: false,
          failureCategory: safeError(error),
        }),
      );
      validatePublishedAudit(receipt, published.audit, ["incident_restore_failed"]);
      incidentAuditPublished = true;
    } catch {
      // The durable journal remains the authoritative incident marker.
    }
    try {
      advanceFromStore(store, receipt, "incident_restore_failed", now, safeError(error));
    } catch (journalError) {
      if (incidentAuditPublished) {
        throw new Error(
          `real-test cleanup incident audit is pending; retry the same operation (${safeError(journalError)})`,
        );
      }
      throw journalError;
    }
  }
  throw new Error(
    `real-test cleanup incident: restore failed; services remain stopped (${safeError(restoreFailure)})`,
  );
}

function advance(store, receipt, current, phase, now, failure = null) {
  return store.writeJournal(receipt.operationId, {
    phase,
    sequence: current.sequence + 1,
    receiptSha256: receipt.receiptSha256,
    updatedAt: now().toISOString(),
    failure,
  });
}

function advanceFromStore(store, receipt, phase, now, failure = null) {
  return advance(store, receipt, store.readJournal(receipt.operationId), phase, now, failure);
}

function cleanupAudit(receipt, outcome, sourceJournal, details) {
  return {
    schemaVersion: 1,
    operation: "xingheng-real-test-data-reset",
    operationId: receipt.operationId,
    receiptSha256: receipt.receiptSha256,
    occurredAt: sourceJournal.updatedAt,
    project: "xingheng-real-test",
    revision: receipt.revision,
    targets: receipt.targets,
    backups: receipt.backups,
    before: receipt.before,
    sourceJournal,
    outcome,
    ...details,
  };
}

function validatePublishedAudit(receipt, audit, allowedOutcomes) {
  if (
    !allowedOutcomes.includes(audit.outcome)
    || audit.operationId !== receipt.operationId
    || audit.receiptSha256 !== receipt.receiptSha256
    || audit.project !== "xingheng-real-test"
    || audit.revision !== receipt.revision
    || digestCanonical(audit.targets) !== digestCanonical(receipt.targets)
    || digestCanonical(audit.backups) !== digestCanonical(receipt.backups)
    || digestCanonical(audit.before) !== digestCanonical(receipt.before)
    || audit.sourceJournal.receiptSha256 !== receipt.receiptSha256
  ) {
    throw new Error("cleanup published audit receipt identity mismatch");
  }
  if (
    (audit.outcome === "completed"
      && (
        typeof audit.after !== "object"
        || audit.after === null
        || Array.isArray(audit.after)
        || audit.productionUnchanged !== true
        || audit.failureCategory !== null
      ))
    || (audit.outcome === "restored"
      && (
        typeof audit.after !== "object"
        || audit.after === null
        || Array.isArray(audit.after)
        || audit.productionUnchanged !== true
        || audit.failureCategory !== "cleanup_interrupted_or_failed"
      ))
    || (audit.outcome === "incident_restore_failed"
      && (
        audit.after !== null
        || audit.productionUnchanged !== false
        || typeof audit.failureCategory !== "string"
        || audit.failureCategory.length === 0
      ))
  ) {
    throw new Error("cleanup published audit outcome identity mismatch");
  }
}

function requireAuditSourceJournal(audit, currentJournal) {
  if (digestCanonical(audit.sourceJournal) !== digestCanonical(currentJournal)) {
    throw new Error("cleanup published audit journal identity mismatch");
  }
}

function requireCompletedAuditJournal(audit, journal) {
  if (
    audit.sourceJournal.phase !== "audit_pending"
    || journal.phase !== "completed"
    || journal.failure !== null
    || journal.receiptSha256 !== audit.sourceJournal.receiptSha256
    || journal.sequence !== audit.sourceJournal.sequence + 1
  ) {
    throw new Error("cleanup completed audit journal identity mismatch");
  }
}

function restoredResult(receipt) {
  return {
    dryRun: false,
    replayed: true,
    outcome: "restored",
    operationId: receipt.operationId,
    targets: [...REAL_TEST_RESET_VOLUMES],
  };
}

function assertNoResetVolumeReferences(run) {
  for (const volume of REAL_TEST_RESET_VOLUMES) {
    const ids = run("docker", [
      "ps", "-aq", "--filter", `volume=${volume}`,
    ]);
    if (ids.trim() !== "") {
      throw new Error("real-test cleanup volume is still mounted");
    }
  }
  for (const volume of PRODUCTION_PROTECTED_VOLUMES) {
    if (REAL_TEST_RESET_VOLUMES.includes(volume)) {
      throw new Error("production volume entered real-test cleanup set");
    }
  }
}

function verifyDualRuntime(run) {
  run("node", [
    "scripts/verify-deployment-revision.mjs",
    "dual-compose",
    MANIFEST,
    PRODUCTION_ENV,
    REAL_TEST_ENV,
  ]);
  verifyProductionRuntime(run);
  verifyRealTestRuntime(run);
}

function daemonEvidence(run) {
  const value = JSON.parse(run("docker", ["info", "--format", "{{json .}}"]));
  const evidence = {
    id: value?.ID,
    rootDir: value?.DockerRootDir,
    serverVersion: value?.ServerVersion,
    storageDriver: value?.Driver,
  };
  if (
    !/^[A-Za-z0-9:+._-]{8,128}$/u.test(evidence.id ?? "")
    || typeof evidence.rootDir !== "string"
    || !evidence.rootDir.startsWith("/")
    || typeof evidence.serverVersion !== "string"
    || typeof evidence.storageDriver !== "string"
  ) throw new Error("real-test cleanup Docker daemon evidence is invalid");
  return evidence;
}

function createAndVerifyBackups(run, inspectArtifact) {
  const sqliteFile = parseSqliteBackupName(run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup",
    "run", "--rm", "--no-deps", "sqlite-backup",
  ]));
  const rwaFile = parseRwaBackupName(run("scripts/real-test-compose.sh", [
    "--profile", "rwa-automation-ops",
    "run", "--rm", "--no-deps", "rwa-automation-backup",
  ]));
  const strategyFile = parseStrategyBackupName(run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup",
    "run", "--rm", "--no-deps", "strategy-backup", "create",
  ]));
  const identities = {
    sqlite: inspectArtifact(run, SQLITE_BACKUP_VOLUME, sqliteFile),
    rwa: inspectArtifact(run, RWA_BACKUP_VOLUME, rwaFile),
    strategy: inspectArtifact(run, STRATEGY_BACKUP_VOLUME, strategyFile),
  };
  verifySqliteBackup(run, sqliteFile);
  verifyRwaBackup(run, rwaFile);
  verifyStrategyBackup(run, strategyFile);
  const verified = {
    sqlite: inspectArtifact(run, SQLITE_BACKUP_VOLUME, sqliteFile),
    rwa: inspectArtifact(run, RWA_BACKUP_VOLUME, rwaFile),
    strategy: inspectArtifact(run, STRATEGY_BACKUP_VOLUME, strategyFile),
  };
  for (const kind of ["sqlite", "rwa", "strategy"]) {
    assertArtifactIdentityUnchanged(identities[kind], verified[kind]);
    verified[kind] = {
      ...verified[kind],
      schemaVerified: true,
      integrityVerified: true,
    };
  }
  validateBackupEvidence(verified, sqliteFile, rwaFile, strategyFile);
  return verified;
}

function assertPreparedBackups(run, backups, inspectArtifact) {
  validateBackupEvidence(
    backups,
    backups?.sqlite?.fileName,
    backups?.rwa?.fileName,
    backups?.strategy?.fileName,
  );
  for (const [kind, volume] of [
    ["sqlite", SQLITE_BACKUP_VOLUME],
    ["rwa", RWA_BACKUP_VOLUME],
    ["strategy", STRATEGY_BACKUP_VOLUME],
  ]) {
    assertArtifactIdentityUnchanged(
      backups[kind],
      inspectArtifact(run, volume, backups[kind].fileName),
    );
  }
  verifySqliteBackup(run, backups.sqlite.fileName);
  verifyRwaBackup(run, backups.rwa.fileName);
  verifyStrategyBackup(run, backups.strategy.fileName);
}

function verifyProductionRuntime(run) {
  run("node", ["scripts/verify-deployment-revision.mjs", "containers", MANIFEST]);
  run("node", ["scripts/verify-release-volume-boundaries.mjs", "runtime"]);
}

function verifyRealTestRuntime(run) {
  run("node", [
    "scripts/verify-deployment-revision.mjs",
    "containers-real-test",
    MANIFEST,
  ]);
  run("node", [
    "scripts/verify-release-volume-boundaries.mjs",
    "real-test",
    "runtime",
  ]);
}

function runtimeEvidence(run) {
  const containers = {};
  let revision = null;
  for (const service of ["api", "web"]) {
    const ids = run("docker", [
      "ps", "-a",
      "--filter", "label=com.docker.compose.project=xingheng",
      "--filter", `label=com.docker.compose.service=${service}`,
      "--format", "{{.ID}}",
    ]).trim().split(/\s+/u).filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(ids[0])) {
      throw new Error(`production ${service} runtime identity is invalid`);
    }
    const inspected = JSON.parse(run("docker", ["container", "inspect", ids[0]]))[0];
    const serviceRevision = inspected?.Config?.Labels?.["org.opencontainers.image.revision"];
    const runtimeEnvironment = envValue(inspected, "XINGHENG_DEPLOYMENT_ENVIRONMENT");
    const composeProject = envValue(inspected, "XINGHENG_COMPOSE_PROJECT");
    const runtimeRevision = envValue(inspected, "XINGHENG_EXPECTED_REVISION");
    const healthy = inspected?.State?.Health?.Status === "healthy";
    if (
      inspected?.State?.Running !== true
      || !healthy
      || inspected?.RestartCount !== 0
      || runtimeEnvironment !== "production"
      || composeProject !== "xingheng"
      || runtimeRevision !== serviceRevision
      || typeof inspected?.Image !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(inspected.Image)
      || !/^[a-f0-9]{40}$/u.test(serviceRevision ?? "")
    ) {
      throw new Error(`production ${service} runtime evidence is invalid`);
    }
    revision ??= serviceRevision;
    if (revision !== serviceRevision) throw new Error("production runtime revision mismatch");
    containers[service] = {
      id: ids[0],
      image: inspected.Image,
      revision: serviceRevision,
      runtimeRevision,
      runtimeEnvironment,
      composeProject,
      restartCount: inspected.RestartCount,
      healthy,
    };
  }
  const allProductionIds = run("docker", [
    "ps", "-aq",
    "--filter", "label=com.docker.compose.project=xingheng",
    "--format", "{{.ID}}",
  ]).trim().split(/\s+/u).filter(Boolean).sort();
  const expectedProductionIds = Object.values(containers).map((item) => item.id).sort();
  if (
    allProductionIds.length !== expectedProductionIds.length
    || allProductionIds.some((id, index) => id !== expectedProductionIds[index])
  ) {
    throw new Error("production project contains an orphan or one-off container");
  }
  run("docker", [
    "exec", containers.web.id, "sh", "-c",
    "wget -qO- --header \"Host: $DOMAIN\" http://127.0.0.1/api/health >/dev/null",
  ]);
  const apiId = containers.api.id;
  const sqlite = ["/app/data/trading.sqlite", "/app/data/trading.sqlite-wal", "/app/data/trading.sqlite-shm"]
    .map((path) => remoteNodeFileEvidence(
      run,
      apiId,
      path,
      path.endsWith("trading.sqlite"),
    ));
  const pointerCapture = remoteNodeFileEvidence(
    run,
    apiId,
    "/app/rwa-automation-data/current.json",
    true,
    "current.json",
    true,
  );
  const pointerValue = JSON.parse(
    Buffer.from(pointerCapture.contentBase64, "base64").toString("utf8"),
  );
  const { contentBase64: _pointerBytes, ...pointer } = pointerCapture;
  if (
    !pointerValue
    || Object.keys(pointerValue).sort().join(",") !== "generation,rollbackGeneration,version"
    || pointerValue.version !== 1
    || !GENERATION_PATTERN.test(pointerValue.generation)
    || !(pointerValue.rollbackGeneration === null
      || GENERATION_PATTERN.test(pointerValue.rollbackGeneration))
  ) {
    throw new Error("production RWA current pointer is invalid");
  }
  const generationRoot = `/app/rwa-automation-data/${pointerValue.generation}`;
  const treeEntries = run("docker", [
    "exec", apiId, "find", generationRoot, "-xdev", "-mindepth", "1", "-printf", "%y:%P\n",
  ]).trim().split("\n").filter(Boolean).sort();
  if (
    new Set(treeEntries).size !== treeEntries.length
    || treeEntries.some((entry) => {
      const [type, path] = [entry.slice(0, 1), entry.slice(2)];
      return !["d", "f"].includes(type)
        || entry[1] !== ":"
        || path.startsWith("/")
        || path.split("/").some((part) => !part || part === "." || part === "..");
    })
  ) {
    throw new Error("production RWA generation tree is invalid");
  }
  const generationFiles = treeEntries.filter((entry) => entry.startsWith("f:")).map((entry) => {
    const path = entry.slice(2);
    return (
    remoteNodeFileEvidence(run, apiId, `${generationRoot}/${path}`, true, path));
  });
  const volumes = productionVolumeEvidence(run, expectedProductionIds);
  const networks = productionNetworkEvidence(run, expectedProductionIds);
  const strategy = stableHostTreeEvidence(volumeMountpoint(volumes, "xingheng_strategy_data"));
  const sqliteBackups = stableHostTreeEvidence(
    volumeMountpoint(volumes, "xingheng_sqlite_backups"),
  );
  const rwaLock = stableHostTreeEvidence(
    volumeMountpoint(volumes, "xingheng_rwa_automation_lock"),
  );
  const rwaBackups = stableHostTreeEvidence(
    volumeMountpoint(volumes, "xingheng_rwa_automation_backups"),
  );
  const caddy = {
    data: stableHostTreeEvidence(volumeMountpoint(volumes, "xingheng_caddy_data")),
    config: stableHostTreeEvidence(volumeMountpoint(volumes, "xingheng_caddy_config")),
  };
  const realTest = realTestRuntimeEvidence(run);
  return {
    productionContainers: canonicalDigest(containers),
    productionVolumes: canonicalDigest(volumes),
    productionNetworks: canonicalDigest(networks),
    productionRevision: revision,
    productionHealthy: true,
    productionSqlite: canonicalDigest(sqlite),
    productionRwa: canonicalDigest({
      pointer,
      generation: pointerValue.generation,
      treeEntries,
      files: generationFiles,
      backups: rwaBackups,
      lock: rwaLock,
    }),
    productionStrategy: canonicalDigest({ strategy, sqliteBackups }),
    productionCaddy: canonicalDigest(caddy),
    realTestContainers: realTest.containers,
    realTestVolumes: realTest.volumes,
    realTestNetworks: realTest.networks,
    realTestRuntimeContract: realTest.contract,
    realTestRevision: realTest.revision,
    realTestHealthy: realTest.healthy,
  };
}

function realTestRuntimeEvidence(run) {
  const project = "xingheng-real-test";
  const containers = {};
  const contract = {};
  let revision = null;
  for (const service of ["api", "web"]) {
    const ids = run("docker", [
      "ps", "-a",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", `label=com.docker.compose.service=${service}`,
      "--format", "{{.ID}}",
    ]).trim().split(/\s+/u).filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(ids[0])) {
      throw new Error(`real-test ${service} runtime identity is invalid`);
    }
    const inspected = JSON.parse(run("docker", ["container", "inspect", ids[0]]))[0];
    const serviceRevision = inspected?.Config?.Labels?.["org.opencontainers.image.revision"];
    const environment = envValue(inspected, "XINGHENG_DEPLOYMENT_ENVIRONMENT");
    const composeProject = envValue(inspected, "XINGHENG_COMPOSE_PROJECT");
    const runtimeRevision = envValue(inspected, "XINGHENG_EXPECTED_REVISION");
    const healthy = inspected?.State?.Health?.Status === "healthy";
    const publishedPorts = Object.entries(inspected?.HostConfig?.PortBindings ?? {})
      .filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0);
    const networkIdentity = Object.entries(inspected?.NetworkSettings?.Networks ?? {})
      .map(([name, item]) => ({
        name,
        aliases: [...new Set(item?.Aliases ?? [])].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (
      inspected?.State?.Running !== true
      || !healthy
      || inspected?.RestartCount !== 0
      || environment !== "real-test"
      || composeProject !== project
      || runtimeRevision !== serviceRevision
      || !/^sha256:[a-f0-9]{64}$/u.test(inspected?.Image ?? "")
      || !/^[a-f0-9]{40}$/u.test(serviceRevision ?? "")
      || publishedPorts.length !== 0
      || !networkIdentity.some((item) => item.name === "xingheng-real-test_default")
      || (service === "web" && !networkIdentity.some((item) =>
        item.name === "xingheng-public-ingress"
        && item.aliases.includes("real-test-web")))
    ) {
      throw new Error(`real-test ${service} runtime evidence is invalid`);
    }
    revision ??= serviceRevision;
    if (revision !== serviceRevision) throw new Error("real-test runtime revision mismatch");
    containers[service] = {
      id: ids[0],
      image: inspected.Image,
      revision: serviceRevision,
      runtimeRevision,
      environment,
      composeProject,
      restartCount: inspected.RestartCount,
      healthy,
      networks: networkIdentity,
    };
    contract[service] = {
      image: inspected.Image,
      revision: serviceRevision,
      runtimeRevision,
      environment,
      composeProject,
      restartCount: inspected.RestartCount,
      healthy,
      publishedPorts: [],
      networks: networkIdentity,
    };
  }
  const allIds = run("docker", [
    "ps", "-aq",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--format", "{{.ID}}",
  ]).trim().split(/\s+/u).filter(Boolean).sort();
  const expectedIds = Object.values(containers).map((item) => item.id).sort();
  if (
    allIds.length !== expectedIds.length
    || allIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error("real-test project contains an orphan or one-off container");
  }
  const volumeNames = PRODUCTION_PROTECTED_VOLUMES
    .map((name) => name.replace(/^xingheng_/u, "xingheng-real-test_"));
  const volumes = volumeNames.map((name) => {
    const inspected = JSON.parse(run("docker", ["volume", "inspect", name]));
    if (!Array.isArray(inspected) || inspected.length !== 1) {
      throw new Error("real-test volume inspect result is invalid");
    }
    const value = inspected[0];
    const references = run("docker", [
      "ps", "-aq", "--filter", `volume=${name}`, "--format", "{{.ID}}",
    ]).trim().split(/\s+/u).filter(Boolean).sort();
    if (references.some((id) => !expectedIds.includes(id))) {
      throw new Error("real-test volume has an unexpected container reference");
    }
    if (
      value?.Name !== name
      || value?.Driver !== "local"
      || value?.Scope !== "local"
      || typeof value?.Mountpoint !== "string"
      || !value.Mountpoint.startsWith("/")
      || typeof value?.CreatedAt !== "string"
      || !Number.isFinite(Date.parse(value.CreatedAt))
    ) throw new Error("real-test volume identity is invalid");
    return {
      name,
      createdAt: value.CreatedAt,
      driver: value.Driver,
      scope: value.Scope,
      mountpoint: value.Mountpoint,
      labels: value.Labels ?? null,
      options: value.Options ?? null,
      references,
    };
  });
  const networks = productionNetworkEvidenceForProject(run, project, expectedIds);
  return {
    revision,
    healthy: true,
    containers: canonicalDigest(containers),
    volumes: canonicalDigest(volumes),
    networks: canonicalDigest(networks),
    contract: canonicalDigest(contract),
  };
}

function productionVolumeEvidence(run, productionContainerIds) {
  return PRODUCTION_PROTECTED_VOLUMES.map((name) => {
    const inspected = JSON.parse(run("docker", ["volume", "inspect", name]));
    if (!Array.isArray(inspected) || inspected.length !== 1) {
      throw new Error("production volume inspect result is invalid");
    }
    const value = inspected[0];
    const references = run("docker", [
      "ps", "-aq", "--filter", `volume=${name}`, "--format", "{{.ID}}",
    ]).trim().split(/\s+/u).filter(Boolean).sort();
    if (references.some((id) => !productionContainerIds.includes(id))) {
      throw new Error("production volume has an unexpected container reference");
    }
    if (
      value?.Name !== name
      || value?.Driver !== "local"
      || value?.Scope !== "local"
      || typeof value?.Mountpoint !== "string"
      || !value.Mountpoint.startsWith("/")
      || typeof value?.CreatedAt !== "string"
      || !Number.isFinite(Date.parse(value.CreatedAt))
    ) {
      throw new Error("production volume identity is invalid");
    }
    return {
      name,
      driver: value.Driver,
      scope: value.Scope,
      createdAt: value.CreatedAt,
      mountpoint: value.Mountpoint,
      labels: value.Labels ?? null,
      options: value.Options ?? null,
      references,
    };
  });
}

function productionNetworkEvidence(run, productionContainerIds) {
  const inspected = JSON.parse(run("docker", [
    "network", "inspect", "xingheng_default", "xingheng-public-ingress",
  ]));
  if (!Array.isArray(inspected) || inspected.length !== 2) {
    throw new Error("production network inspect result is invalid");
  }
  return inspected.map((network) => {
    if (
      !["xingheng_default", "xingheng-public-ingress"].includes(network?.Name)
      || typeof network?.Id !== "string"
      || network.Id.length < 12
      || network?.Driver !== "bridge"
      || network?.Scope !== "local"
    ) throw new Error("production network identity is invalid");
    const attachments = Object.entries(network.Containers ?? {})
      .filter(([id]) => productionContainerIds.some((candidate) => id.startsWith(candidate)))
      .map(([id, item]) => ({
        id,
        name: item.Name,
        ipv4: item.IPv4Address,
        ipv6: item.IPv6Address,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (attachments.length === 0) throw new Error("production network attachment is missing");
    return {
      id: network.Id,
      name: network.Name,
      driver: network.Driver,
      scope: network.Scope,
      internal: network.Internal === true,
      attachable: network.Attachable === true,
      ingress: network.Ingress === true,
      labels: network.Labels ?? null,
      attachments,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function productionNetworkEvidenceForProject(run, project, containerIds) {
  const names = [`${project}_default`, "xingheng-public-ingress"];
  const inspected = JSON.parse(run("docker", ["network", "inspect", ...names]));
  if (!Array.isArray(inspected) || inspected.length !== names.length) {
    throw new Error("deployment environment network inspect result is invalid");
  }
  return inspected.map((network) => {
    if (
      !names.includes(network?.Name)
      || typeof network?.Id !== "string"
      || network.Id.length < 12
      || network?.Driver !== "bridge"
      || network?.Scope !== "local"
    ) throw new Error("deployment environment network identity is invalid");
    const attachments = Object.entries(network.Containers ?? {})
      .filter(([id]) => containerIds.some((candidate) => id.startsWith(candidate)))
      .map(([id, item]) => ({
        id,
        name: item.Name,
        ipv4: item.IPv4Address,
        ipv6: item.IPv6Address,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (attachments.length === 0) {
      throw new Error("deployment environment network attachment is missing");
    }
    return {
      id: network.Id,
      name: network.Name,
      driver: network.Driver,
      scope: network.Scope,
      internal: network.Internal === true,
      attachable: network.Attachable === true,
      ingress: network.Ingress === true,
      labels: network.Labels ?? null,
      attachments,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function remoteTreeEvidence(run, containerId, root, nodeRuntime = false) {
  const entries = run("docker", [
    "exec", containerId, "find", root, "-xdev", "-mindepth", "1", "-printf", "%y:%P\n",
  ]).trim().split("\n").filter(Boolean).sort();
  if (
    entries.length > 10_000
    || new Set(entries).size !== entries.length
    || entries.some((entry) => !/^[df]:[A-Za-z0-9._/-]+$/u.test(entry)
      || entry.slice(2).split("/").some((part) => !part || part === "." || part === ".."))
  ) throw new Error("production evidence tree is invalid");
  const files = entries.filter((entry) => entry.startsWith("f:")).map((entry) => {
    const path = entry.slice(2);
    return nodeRuntime
      ? remoteNodeFileEvidence(run, containerId, `${root}/${path}`, true, path)
      : remoteFileEvidence(run, containerId, `${root}/${path}`, true, path);
  });
  return { root, entries, files };
}

function remoteNodeFileEvidence(
  run,
  containerId,
  path,
  required,
  label = basename(path),
  includeBytes = false,
) {
  const source = [
    "const fs=require('node:fs'),c=require('node:crypto');",
    "const p=process.argv[1],required=process.argv[2]==='1',include=process.argv[3]==='1';",
    "let before;try{before=fs.lstatSync(p)}catch(e){if(e.code==='ENOENT'&&!required){console.log('{\"exists\":false}');process.exit(0)}throw e}",
    "if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)process.exit(70);",
    "const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);",
    "try{const opened=fs.fstatSync(fd);",
    "if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1)process.exit(71);",
    "if(opened.size>134217728)process.exit(72);",
    "const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);",
    "if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)process.exit(73);",
    "console.log(JSON.stringify({exists:true,dev:opened.dev,ino:opened.ino,size:opened.size,mode:opened.mode&511,uid:opened.uid,gid:opened.gid,nlink:opened.nlink,mtimeMs:opened.mtimeMs,ctimeMs:opened.ctimeMs,sha256:c.createHash('sha256').update(bytes).digest('hex'),...(include?{contentBase64:bytes.toString('base64')}:{})}))",
    "}finally{fs.closeSync(fd)}",
  ].join("");
  const value = JSON.parse(run("docker", [
    "exec", containerId, "node", "-e", source,
    path, required ? "1" : "0", includeBytes ? "1" : "0",
  ]));
  if (value.exists === false) return { path: label, exists: false };
  if (
    value.exists !== true
    || !Number.isSafeInteger(value.dev)
    || !Number.isSafeInteger(value.ino)
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || value.nlink !== 1
    || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "")
    || (includeBytes && typeof value.contentBase64 !== "string")
  ) throw new Error("production evidence file descriptor receipt is invalid");
  return { path: label, ...value };
}

function hostTreeEvidence(root) {
  if (typeof root !== "string" || !root.startsWith("/")) {
    throw new Error("production host evidence root is invalid");
  }
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("production host evidence root boundary is invalid");
  }
  const entries = [];
  const walk = (directory, prefix) => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
        throw new Error("production host evidence member name is invalid");
      }
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error("production host evidence member type is invalid");
      }
      if (metadata.isDirectory()) {
        entries.push({
          type: "directory",
          path: relative,
          dev: metadata.dev,
          ino: metadata.ino,
          uid: metadata.uid,
          gid: metadata.gid,
          mode: metadata.mode & 0o777,
          nlink: metadata.nlink,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs,
        });
        walk(path, relative);
      } else {
        if (metadata.nlink !== 1 || metadata.size > 128 * 1024 * 1024) {
          throw new Error("production host evidence file boundary is invalid");
        }
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          const bytes = readFileSync(fd);
          const after = fstatSync(fd);
          if (
            opened.dev !== metadata.dev
            || opened.ino !== metadata.ino
            || opened.size !== metadata.size
            || after.dev !== opened.dev
            || after.ino !== opened.ino
            || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs
            || after.ctimeMs !== opened.ctimeMs
          ) throw new Error("production host evidence file changed while reading");
          entries.push({
            type: "file",
            path: relative,
            dev: opened.dev,
            ino: opened.ino,
            size: opened.size,
            mode: opened.mode & 0o777,
            uid: opened.uid,
            gid: opened.gid,
            nlink: opened.nlink,
            mtimeMs: opened.mtimeMs,
            ctimeMs: opened.ctimeMs,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        } finally {
          closeSync(fd);
        }
      }
      if (entries.length > 10_000) throw new Error("production host evidence tree is too large");
    }
  };
  walk(root, "");
  return {
    root,
    rootMetadata: {
      dev: rootMetadata.dev,
      ino: rootMetadata.ino,
      uid: rootMetadata.uid,
      gid: rootMetadata.gid,
      mode: rootMetadata.mode & 0o777,
      nlink: rootMetadata.nlink,
      mtimeMs: rootMetadata.mtimeMs,
      ctimeMs: rootMetadata.ctimeMs,
    },
    entries,
  };
}

function stableHostTreeEvidence(root) {
  const first = hostTreeEvidence(root);
  const second = hostTreeEvidence(root);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("production host evidence tree changed during stable reread");
  }
  return first;
}

function volumeMountpoint(volumes, name) {
  const matching = volumes.filter((item) => item.name === name);
  if (matching.length !== 1 || typeof matching[0].mountpoint !== "string") {
    throw new Error("production evidence volume mountpoint is unavailable");
  }
  return matching[0].mountpoint;
}

function envValue(inspected, key) {
  const prefix = `${key}=`;
  const entries = inspected?.Config?.Env?.filter((value) => value.startsWith(prefix)) ?? [];
  return entries.length === 1 ? entries[0].slice(prefix.length) : null;
}

function remoteFileEvidence(run, containerId, path, required, label = basename(path)) {
  const output = run("docker", [
    "exec", containerId, "sh", "-c",
    "if [ ! -e \"$1\" ]; then echo ABSENT; exit 0; fi; [ -f \"$1\" ] && [ ! -L \"$1\" ] || exit 70; stat -c '%s:%a:%u:%g:%h' \"$1\"; sha256sum \"$1\" | cut -d' ' -f1",
    "sh", path,
  ]).trim().split("\n");
  if (output.length === 1 && output[0] === "ABSENT") {
    if (required) throw new Error("required production evidence file is absent");
    return { path: label, exists: false };
  }
  if (output.length !== 2 || !/^[0-9]+:[0-7]{3,4}:[0-9]+:[0-9]+:1$/u.test(output[0])
    || !/^[a-f0-9]{64}$/u.test(output[1])) {
    throw new Error("production evidence file metadata is invalid");
  }
  return { path: label, exists: true, metadata: output[0], sha256: output[1] };
}

function canonicalDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseSqliteBackupName(output) {
  const value = basename(String(output).trim());
  if (!/^trading-[0-9]{8}T[0-9]{6}Z\.sqlite$/u.test(value)) {
    throw new Error("real-test SQLite backup output is invalid");
  }
  return value;
}

function parseRwaBackupName(output) {
  const value = basename(String(output).trim());
  if (!/^rwa-automation-[0-9]{8}T[0-9]{6}Z\.rwa\.enc\.json$/u.test(value)) {
    throw new Error("real-test RWA backup output is invalid");
  }
  return value;
}

function parseStrategyBackupName(output) {
  const value = basename(String(output).trim());
  if (!/^strategy-[0-9]{8}T[0-9]{6}Z\.tar\.gz$/u.test(value)) {
    throw new Error("real-test strategy backup output is invalid");
  }
  return value;
}

function verifySqliteBackup(run, fileName) {
  run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup", "run", "--rm", "--no-deps",
    "-e", `REAL_TEST_SQLITE_BACKUP_FILE=${fileName}`,
    "sqlite-verify", "verify",
  ]);
}

function verifyRwaBackup(run, fileName) {
  run("scripts/real-test-compose.sh", [
    "--profile", "rwa-automation-ops", "run", "--rm", "--no-deps",
    "-e", `RWA_AUTOMATION_RESTORE_FILE=${fileName}`,
    "rwa-automation-verify",
  ]);
}

function verifyStrategyBackup(run, fileName) {
  run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup", "run", "--rm", "--no-deps",
    "-e", `REAL_TEST_STRATEGY_BACKUP_FILE=${fileName}`,
    "strategy-verify", "verify",
  ]);
}

function initializeRealTestVolumes(run) {
  run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup",
    "run", "--rm", "--no-deps", "volume-initialize",
  ]);
}

function secureBackupArtifactEvidence(run, volume, fileName) {
  const mountpoint = run("docker", ["volume", "inspect", "--format", "{{.Mountpoint}}", volume]).trim();
  if (!mountpoint.startsWith("/")) throw new Error("real-test backup volume mountpoint is invalid");
  const mountMetadata = lstatSync(mountpoint);
  if (!mountMetadata.isDirectory() || mountMetadata.isSymbolicLink()) {
    throw new Error("real-test backup volume boundary is invalid");
  }
  const path = resolve(mountpoint, fileName);
  if (path !== join(mountpoint, fileName)) throw new Error("real-test backup path is invalid");
  const before = lstatSync(path);
  if (
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== 20001 || before.gid !== 20001 || (before.mode & 0o777) !== 0o600
    || before.size < 1
  ) throw new Error("real-test backup artifact boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.nlink !== 1 || opened.uid !== 20001 || opened.gid !== 20001
      || (opened.mode & 0o777) !== 0o600
    ) throw new Error("real-test backup artifact changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("real-test backup artifact changed while hashing");
    return {
      fileName,
      volume,
      artifactPath: path,
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      mode: opened.mode & 0o777,
      uid: opened.uid,
      gid: opened.gid,
      nlink: opened.nlink,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

export function validateBackupEvidence(backups, sqliteFile, rwaFile, strategyFile) {
  for (const [kind, expectedFile, expectedVolume] of [
    ["sqlite", sqliteFile, SQLITE_BACKUP_VOLUME],
    ["rwa", rwaFile, RWA_BACKUP_VOLUME],
    ["strategy", strategyFile, STRATEGY_BACKUP_VOLUME],
  ]) {
    const item = backups?.[kind];
    if (
      !item || item.fileName !== expectedFile || item.volume !== expectedVolume
      || typeof item.artifactPath !== "string" || !item.artifactPath.startsWith("/")
      || !Number.isSafeInteger(item.device) || !Number.isSafeInteger(item.inode)
      || !Number.isSafeInteger(item.size) || item.size < 1
      || item.mode !== 0o600 || item.uid !== 20001 || item.gid !== 20001 || item.nlink !== 1
      || !/^[a-f0-9]{64}$/u.test(item.sha256 ?? "")
      || item.schemaVerified !== true || item.integrityVerified !== true
    ) throw new Error("real-test backup evidence is invalid");
  }
  return true;
}

function restoreRealTest(
  run,
  backups,
  productionBefore,
  inspectArtifact,
  captureEvidence = runtimeEvidence,
  verifyRuntime = verifyDualRuntime,
) {
  if (!backups) throw new Error("real-test restore backups are unavailable");
  assertPreparedBackups(run, backups, inspectArtifact);
  run("scripts/real-test-compose.sh", ["down", "--remove-orphans"]);
  assertNoResetVolumeReferences(run);
  for (const volume of REAL_TEST_RESET_VOLUMES) {
    try {
      run("docker", ["volume", "rm", volume]);
    } catch {
      // Missing volumes are expected when resuming after an interrupted removal.
    }
  }
  for (const volume of REAL_TEST_RESET_VOLUMES) {
    run("docker", ["volume", "create", volume]);
  }
  initializeRealTestVolumes(run);
  run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup", "run", "--rm", "--no-deps",
    "-e", `REAL_TEST_SQLITE_BACKUP_FILE=${backups.sqlite.fileName}`,
    "sqlite-restore", "restore",
  ]);
  run("scripts/real-test-compose.sh", [
    "--profile", "rwa-automation-ops", "run", "--rm", "--no-deps",
    "-e", `RWA_AUTOMATION_RESTORE_FILE=${backups.rwa.fileName}`,
    "rwa-automation-restore",
  ]);
  run("scripts/real-test-compose.sh", [
    "--profile", "real-test-cleanup", "run", "--rm", "--no-deps",
    "-e", `REAL_TEST_STRATEGY_BACKUP_FILE=${backups.strategy.fileName}`,
    "strategy-restore", "restore",
  ]);
  run("scripts/real-test-compose.sh", ["up", "-d", "api", "web"]);
  verifyRuntime(run);
  validateCleanupEvidence(productionBefore, captureEvidence(run));
}

function assertArtifactIdentityUnchanged(before, after) {
  const fields = [
    "fileName", "volume", "artifactPath", "device", "inode", "size", "mode", "uid", "gid", "nlink", "sha256",
  ];
  if (fields.some((field) => before?.[field] !== after?.[field])) {
    throw new Error("real-test backup artifact changed after verification");
  }
}

function safeError(error) {
  return error instanceof Error ? error.message.replaceAll(/[^\x20-\x7e]/gu, "?").slice(0, 160) : "unknown";
}

function runCommand(command, args) {
  if (command === "docker") {
    return execTrustedDockerSync(args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  const inheritedLocks = process.env.XINGHENG_OPERATION_LOCK_CONTEXT === "real-test"
    ? [3, 4]
    : [];
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe", ...inheritedLocks],
  });
}

function usage() {
  throw new Error(
    "usage: real-test-cleanup.mjs dry-run | execute OPERATION_ID BOUND_CONFIRMATION",
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const result = args.length === 1 && args[0] === "dry-run"
      ? runCleanup({ mode: "prepare" })
      : args.length === 3 && args[0] === "execute"
        ? runCleanup({
          mode: "execute",
          operationId: args[1],
          confirmation: args[2],
        })
        : usage();
    console.log(JSON.stringify({
      ok: true,
      dryRun: result.dryRun,
      targetCount: result.targets.length,
      operationId: result.operationId,
      receiptSha256: result.receiptSha256 ?? null,
      expiresAt: result.expiresAt ?? null,
      confirmation: result.confirmation ?? null,
      outcome: result.outcome ?? null,
      productionUnchanged: result.after ? true : null,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "real-test cleanup failed");
    process.exit(1);
  }
}
