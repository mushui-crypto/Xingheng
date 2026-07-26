import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const IMAGE = process.env.XINGHENG_LINUX_VOLUME_FIXTURE_IMAGE ?? "";
const ENABLED = process.platform === "linux"
  && process.getuid?.() === 0
  && process.env.XINGHENG_LINUX_TRUST_FIXTURE === "1"
  && /^xingheng-volume-fixture:[a-z0-9._-]+$/u.test(IMAGE);
const PREFIX = `xingheng-fixture-volume-${process.pid}`;
const VOLUMES = Object.freeze({
  sqlite: `${PREFIX}-sqlite`,
  backups: `${PREFIX}-backups`,
  strategy: `${PREFIX}-strategy`,
  rwa: `${PREFIX}-rwa`,
});
const STOPPED_CONTAINER = `${PREFIX}-stopped-reference`;

test("SQLite restore scripts keep read-only backups immutable", () => {
  for (const name of [
    "sqlite-restore-production.sh",
    "sqlite-restore-real-test.sh",
  ]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.match(source, /backup_uri="file:\$backup\?immutable=1"/u);
    assert.match(source, /sqlite3 "\$backup_uri" 'PRAGMA integrity_check;'/u);
    assert.match(source, /sqlite3 "\$backup_uri" "VACUUM INTO/u);
    assert.doesNotMatch(source, /\.restore '\$backup'/u);
  }
});

test("real Linux volumes initialize, back up, restore, and reject stopped references", {
  skip: !ENABLED && "requires explicit root Linux volume fixture image",
  timeout: 120_000,
}, () => {
  try {
    for (const volume of Object.values(VOLUMES)) docker(["volume", "create", volume]);
    runContainer([
      "--user", "0:0",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "-v", `${VOLUMES.strategy}:/app/strategy-data`,
      "-v", `${VOLUMES.rwa}:/app/rwa-automation-data`,
      "--entrypoint", "/app/scripts/initialize-real-test-volumes.sh",
    ]);
    const initialized = runContainer([
      "--user", "0:0",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "-v", `${VOLUMES.strategy}:/app/strategy-data`,
      "-v", `${VOLUMES.rwa}:/app/rwa-automation-data`,
      "--entrypoint", "/bin/sh",
    ], [
      "-c",
      "stat -c '%F:%a:%u:%g' /app/data /app/strategy-data /app/rwa-automation-data"
        + " /app/rwa-automation-data/generation-initial"
        + " /app/rwa-automation-data/current.json",
    ]);
    assert.deepEqual(initialized.trim().split("\n"), [
      "directory:700:20001:20001",
      "directory:700:20001:20001",
      "directory:700:20001:20001",
      "directory:700:20001:20001",
      "regular file:600:20001:20001",
    ]);
    const identities = runContainer([
      "--user", "0:0",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "-v", `${VOLUMES.strategy}:/app/strategy-data`,
      "-v", `${VOLUMES.rwa}:/app/rwa-automation-data`,
      "--entrypoint", "/bin/sh",
    ], [
      "-c",
      "stat -c '%F:%a:%u:%g:%h' /app/data/.xingheng-volume-identity.json"
        + " /app/strategy-data/.xingheng-volume-identity.json"
        + " /app/rwa-automation-data/.xingheng-volume-identity.json",
    ]);
    assert.deepEqual(identities.trim().split("\n"), [
      "regular file:400:0:0:1",
      "regular file:400:0:0:1",
      "regular file:400:0:0:1",
    ]);

    runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "--entrypoint", "sqlite3",
    ], [
      "/app/data/trading.sqlite",
      "PRAGMA journal_mode=WAL;"
        + "CREATE TABLE fixture(value TEXT NOT NULL);"
        + "INSERT INTO fixture VALUES('wal-backed');",
    ]);
    const sqliteBackup = runContainer([
      "--user", "20001:20001",
      "-e", "TRADING_DB_PATH=/app/data/trading.sqlite",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "-v", `${VOLUMES.backups}:/backups`,
      "--entrypoint", "/app/scripts/sqlite-backup.sh",
    ]).trim().split("/").at(-1);
    assert.match(sqliteBackup, /^trading-[0-9]{8}T[0-9]{6}Z\.sqlite$/u);
    runContainer([
      "--user", "20001:20001",
      "-e", `REAL_TEST_SQLITE_BACKUP_FILE=${sqliteBackup}`,
      "-e", "TRADING_DB_PATH=/app/data/trading.sqlite",
      "-v", `${VOLUMES.backups}:/backups:ro`,
      "--entrypoint", "/app/scripts/sqlite-restore-real-test.sh",
    ], ["verify"]);
    runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "--entrypoint", "/bin/sh",
    ], ["-c", "rm -f /app/data/trading.sqlite*"]);
    runContainer([
      "--user", "20001:20001",
      "-e", `REAL_TEST_SQLITE_BACKUP_FILE=${sqliteBackup}`,
      "-e", "TRADING_DB_PATH=/app/data/trading.sqlite",
      "-v", `${VOLUMES.sqlite}:/app/data`,
      "-v", `${VOLUMES.backups}:/backups:ro`,
      "--entrypoint", "/app/scripts/sqlite-restore-real-test.sh",
    ], ["restore"]);
    const sqliteResult = runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.sqlite}:/app/data:ro`,
      "--entrypoint", "sqlite3",
    ], [
      "file:/app/data/trading.sqlite?immutable=1",
      "PRAGMA integrity_check;SELECT value FROM fixture;",
    ]);
    assert.equal(sqliteResult.trim(), "ok\nwal-backed");

    runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.strategy}:/app/strategy-data`,
      "--entrypoint", "/bin/sh",
    ], ["-c", "printf '%s\\n' fixture-strategy > /app/strategy-data/report.json"]);
    const strategyBackup = runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.strategy}:/app/strategy-data:ro`,
      "-v", `${VOLUMES.backups}:/backups`,
      "--entrypoint", "/app/scripts/strategy-data-backup-real-test.sh",
    ], ["create"]).trim();
    assert.match(strategyBackup, /^strategy-[0-9]{8}T[0-9]{6}Z\.tar\.gz$/u);
    runContainer([
      "--user", "20001:20001",
      "-e", `REAL_TEST_STRATEGY_BACKUP_FILE=${strategyBackup}`,
      "-v", `${VOLUMES.backups}:/backups:ro`,
      "--entrypoint", "/app/scripts/strategy-data-backup-real-test.sh",
    ], ["verify"]);
    runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.strategy}:/app/strategy-data`,
      "--entrypoint", "/bin/sh",
    ], ["-c", "rm -f /app/strategy-data/report.json"]);
    runContainer([
      "--user", "20001:20001",
      "-e", `REAL_TEST_STRATEGY_BACKUP_FILE=${strategyBackup}`,
      "-v", `${VOLUMES.strategy}:/app/strategy-data`,
      "-v", `${VOLUMES.backups}:/backups:ro`,
      "--entrypoint", "/app/scripts/strategy-data-backup-real-test.sh",
    ], ["restore"]);
    const strategyResult = runContainer([
      "--user", "20001:20001",
      "-v", `${VOLUMES.strategy}:/app/strategy-data:ro`,
      "--entrypoint", "/bin/sh",
    ], ["-c", "cat /app/strategy-data/report.json"]);
    assert.equal(strategyResult.trim(), "fixture-strategy");

    docker([
      "create", "--name", STOPPED_CONTAINER,
      "-v", `${VOLUMES.sqlite}:/data`,
      IMAGE,
    ]);
    assert.notEqual(dockerResult(["volume", "rm", VOLUMES.sqlite]).status, 0);
    docker(["container", "rm", STOPPED_CONTAINER]);
  } finally {
    dockerResult(["container", "rm", "-f", STOPPED_CONTAINER]);
    for (const volume of Object.values(VOLUMES)) {
      dockerResult(["volume", "rm", "-f", volume]);
    }
  }
});

function runContainer(options, command = []) {
  return docker([
    "run", "--rm", "--network", "none",
    ...options,
    IMAGE,
    ...command,
  ]);
}

function docker(args) {
  const result = dockerResult(args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function dockerResult(args) {
  return spawnSync("/usr/bin/docker", args, {
    encoding: "utf8",
    env: {
      HOME: "/root",
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}
