import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const backupEntry = source("./backup.sh");
const backup = source("./sqlite-backup.sh");
const restore = source("./sqlite-restore-production.sh");
const compose = source("../compose.yaml");

test("backup stops API and captures all execution recovery data", () => {
  assert.ok(backupEntry.indexOf("docker compose stop api") < backupEntry.indexOf("sqlite-backup"));
  assert.match(backupEntry, /docker compose up -d --wait api web/u);
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
  assert.match(compose, /sqlite_data:\/app\/data/u);
  assert.match(compose, /sqlite_data:\/app\/data:ro/u);
  assert.match(compose, /umask 077; exec node dist-server\/index\.js/u);
});

test("backup and restore scripts contain no provider or trading operation", () => {
  for (const script of [backupEntry, backup, restore]) {
    assert.doesNotMatch(script, /BinanceClient|placeOrder|cancelOrder|ExecutionRuntime|retry|scheduler|worker/iu);
  }
});

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
