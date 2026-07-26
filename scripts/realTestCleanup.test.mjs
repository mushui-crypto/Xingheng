import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CleanupTransactionStore } from "./cleanupTransactionStore.mjs";
import {
  PRODUCTION_PROTECTED_VOLUMES,
  REAL_TEST_RESET_VOLUMES,
  runCleanup,
  validateBackupEvidence,
  validateCleanupEvidence,
  validateCleanupTargets,
} from "./realTestCleanup.mjs";

const REVISION = "a".repeat(40);
const HASH = "b".repeat(64);
const SQLITE_FILE = "trading-20260726T000000Z.sqlite";
const RWA_FILE = "rwa-automation-20260726T000000Z.rwa.enc.json";
const STRATEGY_FILE = "strategy-20260726T000000Z.tar.gz";
const NOW = new Date("2026-07-26T00:00:00.000Z");

test("cleanup target set is exact and excludes every production volume", () => {
  assert.equal(validateCleanupTargets([...REAL_TEST_RESET_VOLUMES]), true);
  for (const protectedVolume of PRODUCTION_PROTECTED_VOLUMES) {
    assert.throws(
      () => validateCleanupTargets([protectedVolume, ...REAL_TEST_RESET_VOLUMES.slice(1)]),
      /allowlist mismatch/u,
    );
  }
  assert.throws(
    () => validateCleanupTargets([...REAL_TEST_RESET_VOLUMES, "extra"]),
    /allowlist mismatch/u,
  );
});

test("backup evidence binds all three exact artifacts, schema and digest", () => {
  const value = backupEvidence();
  assert.equal(
    validateBackupEvidence(value, SQLITE_FILE, RWA_FILE, STRATEGY_FILE),
    true,
  );
  for (const mutation of [
    (copy) => { copy.sqlite.nlink = 2; },
    (copy) => { copy.rwa.schemaVerified = false; },
    (copy) => { copy.strategy.fileName = "strategy-20260726T000001Z.tar.gz"; },
  ]) {
    const copy = structuredClone(value);
    mutation(copy);
    assert.throws(
      () => validateBackupEvidence(copy, SQLITE_FILE, RWA_FILE, STRATEGY_FILE),
      /backup evidence is invalid/u,
    );
  }
});

test("dry-run prepares verified backups and a bound expiring receipt without deleting data", () => {
  withFixture(({ store, calls, dependencies }) => {
    const result = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    assert.equal(result.dryRun, true);
    assert.match(result.operationId, /^[0-9a-f-]{36}$/u);
    assert.match(result.receiptSha256, /^[a-f0-9]{64}$/u);
    assert.match(result.confirmation, new RegExp(`${result.operationId}:${result.receiptSha256}$`, "u"));
    assert.equal(Object.keys(result.backups).sort().join(","), "rwa,sqlite,strategy");
    assert.equal(calls.some(isVolumeRemoval), false);
    assert.equal(calls.some(isStrategyBackup), true);
    assert.equal(store.readJournal(result.operationId).phase, "prepared");
  });
});

test("execute claims one receipt, resets exact volumes and is idempotent", () => {
  withFixture(({ store, calls, dependencies }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    const result = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    });
    assert.equal(result.outcome, "completed");
    assert.deepEqual(
      calls.filter(isVolumeRemoval).map(([, args]) => args[2]),
      REAL_TEST_RESET_VOLUMES,
    );
    assert.equal(calls.some(isVolumeInitialize), true);
    assert.equal(store.readJournal(prepared.operationId).phase, "completed");
    const replay = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "completed");
    assert.equal(calls.filter(isVolumeRemoval).length, REAL_TEST_RESET_VOLUMES.length);
  });
});

test("forged, expired, or production-drifted receipts fail before deletion", () => {
  withFixture(({ store, calls, dependencies, setEvidence }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    assert.throws(
      () => runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: "forged",
        transactionStore: store,
        ...dependencies,
      }),
      /does not bind/u,
    );
    setEvidence({ ...productionEvidence(), productionCaddy: "f".repeat(64) });
    assert.throws(
      () => runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: prepared.confirmation,
        transactionStore: store,
        ...dependencies,
      }),
      /production evidence changed|prepared production snapshot changed/u,
    );
    assert.equal(calls.some(isVolumeRemoval), false);
  });

  withFixture(({ store, dependencies }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    assert.throws(
      () => runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: prepared.confirmation,
        transactionStore: store,
        now: () => new Date(NOW.getTime() + 16 * 60 * 1000),
        ...withoutNow(dependencies),
      }),
      /expired/u,
    );
  });
});

test("every destructive phase failure restores SQLite, RWA and strategy before restart", () => {
  for (const failure of [
    "down",
    "remove:sqlite",
    "remove:strategy",
    "remove:rwa",
    "create:sqlite",
    "create:strategy",
    "create:rwa",
    "initialize",
    "start",
    "verify",
  ]) {
    withFixture(({ store, calls, dependencies, setFailure }) => {
      const prepared = runCleanup({
        mode: "prepare",
        transactionStore: store,
        ...dependencies,
      });
      setFailure(failure);
      assert.throws(() => runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: prepared.confirmation,
        transactionStore: store,
        ...dependencies,
      }));
      assert.equal(calls.some(isSqliteRestore), true, failure);
      assert.equal(calls.some(isRwaRestore), true, failure);
      assert.equal(calls.some(isStrategyRestore), true, failure);
      assert.equal(store.readJournal(prepared.operationId).phase, "restored");
    });
  }
});

test("every durable destructive intent resumes only through verified three-volume restore", () => {
  for (const phase of [
    "stopping",
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
    "restore_required",
    "restoring",
    "incident_restore_failed",
  ]) {
    withFixture(({ store, calls, dependencies }) => {
      const prepared = runCleanup({
        mode: "prepare",
        transactionStore: store,
        ...dependencies,
      });
      const claimed = store.claim(prepared.operationId, prepared.confirmation, NOW);
      store.writeJournal(prepared.operationId, {
        ...claimed,
        phase,
        sequence: claimed.sequence + 1,
      });
      const resumed = runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: prepared.confirmation,
        transactionStore: store,
        ...dependencies,
      });
      assert.equal(resumed.outcome, "restored", phase);
      assert.equal(calls.some(isSqliteRestore), true, phase);
      assert.equal(calls.some(isRwaRestore), true, phase);
      assert.equal(calls.some(isStrategyRestore), true, phase);
    });
  }
});

test("backup failures restart the unchanged test runtime and never create a receipt", () => {
  for (const failure of ["backup:sqlite", "backup:rwa", "backup:strategy"]) {
    withFixture(({ store, calls, dependencies, setFailure }) => {
      setFailure(failure);
      assert.throws(() => runCleanup({
        mode: "prepare",
        transactionStore: store,
        ...dependencies,
      }));
      assert.equal(calls.some(isVolumeRemoval), false, failure);
      assert.equal(
        calls.some(([command, args]) =>
          command === "scripts/real-test-compose.sh"
          && args[0] === "up"),
        true,
        failure,
      );
    });
  }
});

test("a journal publication failure after deletion restores and remains replay-safe", () => {
  withFixture(({ store, dependencies }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    const original = store.writeJournal.bind(store);
    let injected = false;
    store.writeJournal = (operationId, value, options) => {
      if (!injected && value.phase === "volumes_removed") {
        injected = true;
        throw new Error("fixture journal fsync failure");
      }
      return original(operationId, value, options);
    };
    assert.throws(() => runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    }), /journal fsync failure/u);
    assert.equal(store.readJournal(prepared.operationId).phase, "restored");
    const replay = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "restored");
  });

  withFixture(({ store, dependencies }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    const claimed = store.claim(prepared.operationId, prepared.confirmation, NOW);
    store.writeJournal(prepared.operationId, {
      ...claimed,
      phase: "stopping",
      sequence: claimed.sequence + 1,
    });
    const original = store.writeJournal.bind(store);
    let injected = false;
    store.writeJournal = (operationId, value, options) => {
      if (!injected && value.phase === "restored") {
        injected = true;
        throw new Error("fixture SIGKILL after restored audit fsync");
      }
      return original(operationId, value, options);
    };
    assert.throws(
      () => runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: prepared.confirmation,
        transactionStore: store,
        ...dependencies,
      }),
      /terminal audit is pending.*SIGKILL after restored audit fsync/u,
    );
    assert.equal(store.readJournal(prepared.operationId).phase, "restoring");
    const replay = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      now: () => new Date(NOW.getTime() + 60_000),
      ...withoutNow(dependencies),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "restored");
  });
});

test("post-commit journal failure preserves completed audit and never enters restore", () => {
  withFixture(({ store, calls, dependencies }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    const original = store.writeJournal.bind(store);
    let injected = false;
    store.writeJournal = (operationId, value, options) => {
      if (!injected && value.phase === "completed") {
        injected = true;
        original(operationId, value, options);
        throw new Error("fixture SIGKILL after audit fsync");
      }
      return original(operationId, value, options);
    };
    const completed = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    });
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.replayed, true);
    assert.equal(store.readJournal(prepared.operationId).phase, "completed");
    assert.equal(calls.some(isSqliteRestore), false);
    assert.equal(calls.some(isRwaRestore), false);
    assert.equal(calls.some(isStrategyRestore), false);
    const auditPath = join(
      store.root,
      `operation-${prepared.operationId}`,
      "audit.json",
    );
    const firstAudit = readFileSync(auditPath);
    const resumed = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      now: () => new Date(NOW.getTime() + 60_000),
      ...withoutNow(dependencies),
    });
    assert.equal(resumed.outcome, "completed");
    assert.equal(resumed.replayed, true);
    assert.deepEqual(readFileSync(auditPath), firstAudit);
    assert.equal(calls.some(isSqliteRestore), false);
    assert.equal(calls.some(isRwaRestore), false);
    assert.equal(calls.some(isStrategyRestore), false);
  });
});

test("restore failure leaves real-test stopped with a durable incident", () => {
  withFixture(({ store, calls, dependencies, setFailure }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    setFailure("start+restore");
    assert.throws(
      () => runCleanup({
        mode: "execute",
        operationId: prepared.operationId,
        confirmation: prepared.confirmation,
        transactionStore: store,
        ...dependencies,
      }),
      /restore failed; services remain stopped/u,
    );
    assert.equal(store.readJournal(prepared.operationId).phase, "incident_restore_failed");
    const composeCalls = calls.filter(([command]) => command === "scripts/real-test-compose.sh");
    assert.deepEqual(composeCalls.at(-1)[1], ["down", "--remove-orphans"]);
  });
});

test("a durable restore incident can be retried only with the same operation", () => {
  withFixture(({ store, dependencies, setFailure }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    setFailure("start+restore");
    assert.throws(() => runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    }), /restore failed/u);
    setFailure(null);
    const recovered = runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    });
    assert.equal(recovered.outcome, "restored");
  });
});

test("production drift after destructive work never reports restored or unchanged", () => {
  withFixture(({ store, dependencies, setFailure }) => {
    const prepared = runCleanup({
      mode: "prepare",
      transactionStore: store,
      ...dependencies,
    });
    setFailure("production-drift");
    assert.throws(() => runCleanup({
      mode: "execute",
      operationId: prepared.operationId,
      confirmation: prepared.confirmation,
      transactionStore: store,
      ...dependencies,
    }), /restore failed; services remain stopped/u);
    assert.equal(store.readJournal(prepared.operationId).phase, "incident_restore_failed");
  });
});

test("expanded dual-environment evidence detects every protected evidence family", () => {
  const baseline = productionEvidence();
  for (const key of [
    "productionContainers",
    "productionVolumes",
    "productionNetworks",
    "productionSqlite",
    "productionRwa",
    "productionStrategy",
    "productionCaddy",
    "realTestRuntimeContract",
  ]) {
    assert.throws(
      () => validateCleanupEvidence(baseline, { ...baseline, [key]: "f".repeat(64) }),
      /changed|invalid/u,
      key,
    );
  }
  for (const key of [
    "realTestContainers",
    "realTestVolumes",
    "realTestNetworks",
  ]) {
    assert.throws(
      () => validateCleanupEvidence(baseline, { ...baseline, [key]: "not-a-sha256" }),
      /invalid/u,
      key,
    );
  }
  for (const mutation of [
    { realTestRevision: "c".repeat(40) },
    { realTestHealthy: false },
    { productionRevision: "c".repeat(40) },
    { productionHealthy: false },
  ]) {
    assert.throws(
      () => validateCleanupEvidence(baseline, { ...baseline, ...mutation }),
      /changed/u,
      JSON.stringify(mutation),
    );
  }
});

test("stopped Docker container references block volume removal until exact removal", {
  timeout: 30_000,
}, (t) => {
  const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8" });
  const image = "xingheng-api:03bdbb354f225ae0a0999a355df1e70784d7d163";
  const imageInfo = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
  if (dockerInfo.status !== 0 || imageInfo.status !== 0) {
    t.skip("local Docker fixture image is unavailable");
    return;
  }
  const suffix = randomBytes(6).toString("hex");
  const resetVolume = `xingheng-real-test-fixture-reset-${suffix}`;
  const protectedVolume = `xingheng-production-fixture-protected-${suffix}`;
  const container = `xingheng-real-test-fixture-stopped-${suffix}`;
  try {
    docker(["volume", "create", resetVolume]);
    docker(["volume", "create", protectedVolume]);
    docker([
      "run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "sh",
      "-v", `${protectedVolume}:/fixture`, image, "-c", "printf stable-production > /fixture/state",
    ]);
    const before = docker([
      "run", "--rm", "--network", "none", "--entrypoint", "sha256sum",
      "-v", `${protectedVolume}:/fixture:ro`, image, "/fixture/state",
    ]).split(/\s+/u)[0];
    docker([
      "create", "--name", container, "--network", "none", "--entrypoint", "/bin/true",
      "-v", `${resetVolume}:/fixture`, image,
    ]);
    assert.notEqual(spawnSync("docker", ["volume", "rm", resetVolume]).status, 0);
    docker(["container", "rm", container]);
    docker(["volume", "rm", resetVolume]);
    const after = docker([
      "run", "--rm", "--network", "none", "--entrypoint", "sha256sum",
      "-v", `${protectedVolume}:/fixture:ro`, image, "/fixture/state",
    ]).split(/\s+/u)[0];
    assert.equal(after, before);
  } finally {
    spawnSync("docker", ["container", "rm", "-f", container]);
    spawnSync("docker", ["volume", "rm", "-f", resetVolume, protectedVolume]);
  }
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "xingheng-cleanup-fixture-"));
  try {
    const store = new CleanupTransactionStore(join(parent, "audit"), { testMode: true });
    const calls = [];
    let evidence = productionEvidence();
    let failure = null;
    let destructive = false;
    let restoring = false;
    let failedOnce = false;
    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "scripts/real-test-compose.sh") {
        if (args.includes("sqlite-backup")) {
          if (failure === "backup:sqlite") throw new Error("fixture SQLite backup failed");
          return `/backups/${SQLITE_FILE}\n`;
        }
        if (args.includes("rwa-automation-backup")) {
          if (failure === "backup:rwa") throw new Error("fixture RWA backup failed");
          return `${RWA_FILE}\n`;
        }
        if (args.includes("strategy-backup")) {
          if (failure === "backup:strategy") throw new Error("fixture strategy backup failed");
          return `${STRATEGY_FILE}\n`;
        }
        if (args.includes("strategy-restore") && failure?.includes("restore")) {
          throw new Error("fixture restore failed");
        }
        if (args.includes("sqlite-restore") || args.includes("rwa-automation-restore")
          || args.includes("strategy-restore")) restoring = true;
        if (isVolumeInitialize([command, args]) && failure === "initialize" && !failedOnce) {
          failedOnce = true;
          throw new Error("fixture initialize failed");
        }
        if (
          args[0] === "down"
          && failure === "down"
          && !failedOnce
        ) {
          failedOnce = true;
          throw new Error("fixture down failed");
        }
        if (
          args[0] === "up"
          && destructive
          && !restoring
          && failure?.includes("start")
          && !failedOnce
        ) {
          failedOnce = true;
          throw new Error("fixture start failed");
        }
        return "";
      }
      if (command === "node") return "";
      if (command !== "docker") throw new Error(`unexpected command ${command}`);
      if (args[0] === "ps") return "";
      if (args[0] === "volume" && args[1] === "rm") {
        destructive = true;
        const failureTarget = failure === "remove:rwa"
          ? "rwa_automation_data"
          : `${failure?.slice("remove:".length)}_data`;
        if (
          failure?.startsWith("remove:")
          && args[2].endsWith(failureTarget)
          && !failedOnce
        ) {
          failedOnce = true;
          throw new Error("fixture remove failed");
        }
        return "";
      }
      if (args[0] === "volume" && args[1] === "create") {
        const failureTarget = failure === "create:rwa"
          ? "rwa_automation_data"
          : `${failure?.slice("create:".length)}_data`;
        if (
          failure?.startsWith("create:")
          && args[2].endsWith(failureTarget)
          && !failedOnce
        ) {
          failedOnce = true;
          throw new Error("fixture create failed");
        }
        return `${args[2]}\n`;
      }
      throw new Error(`unexpected docker args ${args.join(" ")}`);
    };
    const baseStore = store.publishAudit.bind(store);
    store.publishAudit = (operationId, audit) => {
      if (failure === "audit" && audit.outcome === "completed" && !failedOnce) {
        failedOnce = true;
        throw new Error("fixture audit failure");
      }
      return baseStore(operationId, audit);
    };
    const dependencies = {
      run,
      now: () => new Date(NOW),
      acquireLocks: () => ({ close() {} }),
      inspectArtifact: fakeArtifactInspector,
      captureEvidence: () => {
        if (failure === "production-drift" && destructive) {
          return {
            ...structuredClone(evidence),
            productionCaddy: "f".repeat(64),
          };
        }
        if (failure === "verify" && destructive && !restoring && !failedOnce) {
          failedOnce = true;
          throw new Error("fixture verification failed");
        }
        return structuredClone(evidence);
      },
      captureDaemon: () => ({
        id: "fixture-daemon",
        rootDir: "/var/lib/docker",
        serverVersion: "27.0.0",
        storageDriver: "overlay2",
      }),
      verifyRuntime: () => {},
    };
    callback({
      store,
      calls,
      dependencies,
      setFailure(value) { failure = value; },
      setEvidence(value) { evidence = value; },
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function withoutNow(value) {
  const { now: _now, ...remaining } = value;
  return remaining;
}

function artifact(fileName, volume, inode) {
  return {
    fileName,
    volume,
    artifactPath: `/var/lib/docker/volumes/${volume}/_data/${fileName}`,
    device: 1,
    inode,
    size: 128,
    mode: 0o600,
    uid: 20001,
    gid: 20001,
    nlink: 1,
    sha256: HASH,
    schemaVerified: true,
    integrityVerified: true,
  };
}

function backupEvidence() {
  return {
    sqlite: artifact(SQLITE_FILE, "xingheng-real-test_sqlite_backups", 10),
    rwa: artifact(RWA_FILE, "xingheng-real-test_rwa_automation_backups", 11),
    strategy: artifact(STRATEGY_FILE, "xingheng-real-test_sqlite_backups", 12),
  };
}

function fakeArtifactInspector(_run, volume, fileName) {
  const values = backupEvidence();
  return Object.values(values).find((value) =>
    value.volume === volume && value.fileName === fileName);
}

function productionEvidence() {
  return {
    productionContainers: HASH,
    productionVolumes: HASH,
    productionNetworks: HASH,
    productionRevision: REVISION,
    productionHealthy: true,
    productionSqlite: HASH,
    productionRwa: HASH,
    productionStrategy: HASH,
    productionCaddy: HASH,
    realTestContainers: HASH,
    realTestVolumes: HASH,
    realTestNetworks: HASH,
    realTestRuntimeContract: HASH,
    realTestRevision: REVISION,
    realTestHealthy: true,
  };
}

function isVolumeRemoval([command, args]) {
  return command === "docker" && args[0] === "volume" && args[1] === "rm";
}

function isStrategyBackup([command, args]) {
  return command === "scripts/real-test-compose.sh" && args.includes("strategy-backup");
}

function isVolumeInitialize([command, args]) {
  return command === "scripts/real-test-compose.sh" && args.includes("volume-initialize");
}

function isSqliteRestore([command, args]) {
  return command === "scripts/real-test-compose.sh" && args.includes("sqlite-restore");
}

function isRwaRestore([command, args]) {
  return command === "scripts/real-test-compose.sh" && args.includes("rwa-automation-restore");
}

function isStrategyRestore([command, args]) {
  return command === "scripts/real-test-compose.sh" && args.includes("strategy-restore");
}

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
