import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production SQLite restore keeps read-only backups immutable", () => {
  const source = readFileSync(
    new URL("sqlite-restore-production.sh", import.meta.url),
    "utf8",
  );
  assert.match(source, /backup_uri="file:\$backup\?immutable=1"/u);
  assert.match(source, /sqlite3 "\$backup_uri" 'PRAGMA integrity_check;'/u);
  assert.match(source, /sqlite3 "\$backup_uri" "VACUUM INTO/u);
  assert.doesNotMatch(source, /\.restore '\$backup'/u);
});

test("RWA backup wrapper emits only stable lifecycle diagnostics on stderr", () => {
  const source = readFileSync(
    new URL("rwa-automation-backup.sh", import.meta.url),
    "utf8",
  );
  assert.match(source, /if production_compose --profile rwa-automation-ops run --rm --no-deps rwa-automation-backup; then/u);
  assert.match(source, /XINGHENG_RECEIPT:\{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":true,"stage":"backup_container","category":null,"exitCode":0\}.*>&2/u);
  assert.match(source, /XINGHENG_RECEIPT:\{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":false,"stage":"backup_container","category":"backup_container_failed","exitCode":%s\}.*>&2/u);
  assert.match(source, /XINGHENG_RECEIPT:\{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":true,"stage":"api_restoration","category":null\}.*>&2/u);
  assert.match(source, /XINGHENG_RECEIPT:\{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":false,"stage":"api_restoration","category":"api_restoration_failed","exitCode":%s\}.*>&2/u);
  const receiptLines = source.split("\n").filter((line) => line.includes("XINGHENG_RECEIPT:"));
  assert.equal(receiptLines.length, 4);
  for (const line of receiptLines) assert.match(line, />&2$/u);
});
