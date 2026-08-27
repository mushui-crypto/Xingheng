import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const backupEntry = source("./backup.sh");
const backup = source("./sqlite-backup.sh");
const restore = source("./sqlite-restore-production.sh");
const compose = source("../compose.yaml");

test("backup stops API and captures all execution recovery data", () => {
  assert.ok(backupEntry.indexOf("docker compose -p xingheng stop api") < backupEntry.indexOf("sqlite-backup"));
  assert.match(backupEntry, /docker compose -p xingheng up -d --wait api web/u);
  assert.match(backup, /sqlite3 "file:\$source_path\?mode=ro"/u);
  assert.match(backup, /\.backup '\$destination_path'/u);
  assert.match(backup, /PRAGMA integrity_check/u);
  assert.match(backup, /"\$user_order_dir"\/\*\.sqlite/u);
  assert.match(backup, /"\$user_order_dir"\/\*\.jsonl/u);
  assert.match(backup, /SHA256SUMS/u);
  assert.match(backup, /chmod 0600/u);
});

test("restore verifies and stages trading, user order, and receipt evidence", () => {
  assert.match(restore, /sha256sum -c SHA256SUMS/u);
  assert.match(restore, /PRAGMA integrity_check/u);
  assert.match(restore, /\.stellax-restore-pending/u);
  assert.match(restore, /trading\.sqlite/u);
  assert.match(restore, /binance-users/u);
  assert.match(restore, /\*\.jsonl/u);
  assert.match(restore, /chmod 0600/u);
});

test("production composition keeps recovery data on the SQLite volume with private creation mode", () => {
  assert.match(compose, /BINANCE_USER_ORDER_DB_DIR: \/app\/data\/binance-users/u);
  assert.match(compose, /sqlite-backup:[\s\S]*?- sqlite_data:\/app\/data(?:\r?\n)/u);
  assert.doesNotMatch(compose, /sqlite_data:\/app\/data:ro/u);
  assert.match(compose, /umask 077; exec node dist-server\/index\.js/u);
});

test("backup and restore scripts contain no provider or trading operation", () => {
  for (const script of [backupEntry, backup, restore]) {
    assert.doesNotMatch(script, /BinanceClient|placeOrder|cancelOrder|ExecutionRuntime|retry|scheduler|worker/iu);
  }
});

test("the project SQLite .backup mechanism includes committed data that exists only in an uncheckpointed WAL", () => {
  const root = mkdtempSync(join(tmpdir(), "stellax-wal-backup-"));
  const sourcePath = join(root, "trading.sqlite");
  const snapshotPath = join(root, "snapshot.sqlite");
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.prepare("INSERT INTO facts (id, value) VALUES (?, ?)").run("latest", "committed-in-wal");
    assert.equal(writer.prepare("SELECT value FROM facts WHERE id = 'latest'").get()?.value, "committed-in-wal");
    assert.equal(existsSync(`${sourcePath}-wal`), true);
    assert.ok(statSync(`${sourcePath}-wal`).size > 0);
    assert.equal(existsSync(`${sourcePath}-shm`), true);
    assert.ok(statSync(`${sourcePath}-shm`).size > 0);

    execFileSync("sqlite3", [
      `file:${sourcePath}?mode=ro`,
      ".timeout 10000",
      `.backup '${snapshotPath}'`,
    ]);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(snapshot.prepare("SELECT value FROM facts WHERE id = 'latest'").get()?.value, "committed-in-wal");
    } finally {
      snapshot.close();
    }
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore validation rejects unsafe artifacts before swap and traps every ordinary swap failure", () => {
  assert.match(restore, /snapshot is invalid/u);
  assert.match(restore, /sha256sum -c SHA256SUMS/u);
  assert.match(restore, /integrity_check/u);
  assert.match(restore, /\[ ! -L "\$snapshot" \]/u);
  assert.match(restore, /stat -c '%h:%a:%u:%g'/u);
  assert.match(restore, /VACUUM INTO '\$pending\/trading\.sqlite'/u);
  assert.ok(restore.indexOf("swap_started=true") < restore.indexOf('mv "$pending/trading.sqlite"'));
  assert.match(restore, /trap cleanup EXIT HUP INT TERM/u);
  assert.match(restore, /rm -f "\$TRADING_DB_PATH" "\$TRADING_DB_PATH-wal" "\$TRADING_DB_PATH-shm"/u);
  assert.match(restore, /mv "\$previous\/trading\.sqlite" "\$TRADING_DB_PATH"/u);
  assert.match(restore, /mv "\$previous\/binance-users" "\$BINANCE_USER_ORDER_DB_DIR"/u);
});

for (const failure of ["CHECKSUM", "INTEGRITY", "SYMLINK", "HARDLINK", "VACUUM", "SWAP_MAIN", "SWAP_USERS"] as const) {
  test(`production restore script preserves both old artifacts after injected ${failure} failure`, () => {
    withRestoreFixture(({ run, oldMain, oldUser, snapshotMain, rewriteManifest }) => {
      if (failure === "CHECKSUM") writeFileSync(`${snapshotMain}.tamper`, "checksum mismatch");
      if (failure === "CHECKSUM") writeFileSync(snapshotMain, "not the checksummed database");
      if (failure === "INTEGRITY") {
        writeFileSync(snapshotMain, "not sqlite");
        rewriteManifest();
      }
      if (failure === "SYMLINK") {
        rmSync(snapshotMain);
        symlinkSync(oldMain, snapshotMain);
        rewriteManifest();
      }
      if (failure === "HARDLINK") {
        rmSync(snapshotMain);
        linkSync(oldMain, snapshotMain);
        rewriteManifest();
      }
      assert.throws(() => run({
        failVacuum: failure === "VACUUM",
        failMoveAt: failure === "SWAP_MAIN" ? 3 : failure === "SWAP_USERS" ? 4 : undefined,
      }));
      assert.equal(readFact(oldMain), "old-main");
      assert.equal(readFact(oldUser), "old-user");
    });
  });
}

test("production restore script rejects an invalid snapshot name before touching current data", () => {
  withRestoreFixture(({ run, oldMain, oldUser }) => {
    assert.throws(() => run({ snapshotName: "../unsafe" }));
    assert.equal(readFact(oldMain), "old-main");
    assert.equal(readFact(oldUser), "old-user");
  });
});

type RestoreRunOptions = {
  failMoveAt?: number;
  failVacuum?: boolean;
  snapshotName?: string;
};

function withRestoreFixture(operation: (fixture: {
  run: (options?: RestoreRunOptions) => void;
  oldMain: string;
  oldUser: string;
  snapshotMain: string;
  rewriteManifest: () => void;
}) => void) {
  const root = mkdtempSync(join(tmpdir(), "stellax-restore-fault-"));
  const data = join(root, "data");
  const backups = join(root, "backups");
  const snapshotName = "stellax-20260826T000000Z";
  const snapshot = join(backups, snapshotName);
  const userName = "0123456789abcdef0123456789abcdef.sqlite";
  const oldMain = join(data, "trading.sqlite");
  const oldUsers = join(data, "binance-users");
  const oldUser = join(oldUsers, userName);
  const snapshotUsers = join(snapshot, "binance-users");
  const snapshotMain = join(snapshot, "trading.sqlite");
  const snapshotUser = join(snapshotUsers, userName);
  const tools = join(root, "tools");
  mkdirSync(oldUsers, { recursive: true, mode: 0o700 });
  mkdirSync(snapshotUsers, { recursive: true, mode: 0o700 });
  mkdirSync(tools, { mode: 0o700 });
  writeFact(oldMain, "old-main");
  writeFact(oldUser, "old-user");
  writeFact(snapshotMain, "new-main");
  writeFact(snapshotUser, "new-user");
  chmodSync(snapshot, 0o700);
  chmodSync(snapshotUsers, 0o700);
  for (const path of [snapshotMain, snapshotUser]) chmodSync(path, 0o600);
  const manifest = join(snapshot, "SHA256SUMS");
  const rewriteManifest = () => {
    writeFileSync(manifest, [
      `${sha256(snapshotMain)}  trading.sqlite`,
      `${sha256(snapshotUser)}  binance-users/${userName}`,
      "",
    ].join("\n"));
    chmodSync(manifest, 0o600);
  };
  rewriteManifest();

  const patched = join(root, "restore.sh");
  writeFileSync(patched, restore.replaceAll("/app/data", data).replaceAll("/backups", backups));
  chmodSync(patched, 0o700);
  writeFileSync(join(tools, "stat"), `#!/bin/sh
if [ "$(uname)" = Darwin ]; then
  format="$2"; path="$3"
  [ "$format" != "%a:%u:%g" ] || format="%Lp:%u:%g"
  [ "$format" != "%h:%a:%u:%g" ] || format="%l:%Lp:%u:%g"
  exec /usr/bin/stat -f "$format" "$path"
fi
exec /usr/bin/stat "$@"
`);
  writeFileSync(join(tools, "mv"), `#!/bin/sh
count=0
[ ! -f "$RESTORE_MV_COUNTER" ] || count=$(cat "$RESTORE_MV_COUNTER")
count=$((count + 1)); echo "$count" > "$RESTORE_MV_COUNTER"
if [ -n "\${FAIL_MOVE_AT:-}" ] && [ "$count" -eq "$FAIL_MOVE_AT" ]; then
  exit 74
fi
exec /bin/mv "$@"
`);
  writeFileSync(join(tools, "sqlite3"), `#!/bin/sh
case "\${FAIL_VACUUM:-}:$*" in
  1:*VACUUM\ INTO*) exit 74 ;;
esac
exec /usr/bin/sqlite3 "$@"
`);
  for (const name of ["stat", "mv", "sqlite3"]) chmodSync(join(tools, name), 0o700);

  const run = (options: RestoreRunOptions = {}) => execFileSync("sh", [patched], {
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      TRADING_DB_PATH: oldMain,
      BINANCE_USER_ORDER_DB_DIR: oldUsers,
      SQLITE_RESTORE_SNAPSHOT: options.snapshotName ?? snapshotName,
      RESTORE_MV_COUNTER: join(root, "mv-counter"),
      FAIL_MOVE_AT: options.failMoveAt === undefined ? "" : String(options.failMoveAt),
      FAIL_VACUUM: options.failVacuum ? "1" : "",
    },
    stdio: "pipe",
  });
  try {
    operation({ run, oldMain, oldUser, snapshotMain, rewriteManifest });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFact(path: string, value: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE facts (value TEXT NOT NULL)");
    db.prepare("INSERT INTO facts (value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

function readFact(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM facts").get()?.value;
  } finally {
    db.close();
  }
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
