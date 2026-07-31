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
