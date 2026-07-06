import { spawnSync } from "node:child_process";

function validate(name) {
  return spawnSync("sh", ["scripts/restore.sh", name], {
    encoding: "utf8",
    env: { ...process.env, RESTORE_VALIDATE_ONLY: "true" },
  });
}

const accepted = validate("trading-20260706T123456Z.sqlite");
if (accepted.status !== 0) throw new Error(`valid restore filename rejected: ${accepted.stderr}`);

const rejected = [
  "trading-20260706T12345Z.sqlite",
  "trading-20260706T123456Z.sqlite.extra",
  "trading-20260706T123456Z.sqlite;select 1",
  "trading-20260706T123456Z.sqlite\n.shell id",
  "../trading-20260706T123456Z.sqlite",
];
for (const name of rejected) {
  if (validate(name).status === 0) throw new Error(`unsafe restore filename accepted: ${JSON.stringify(name)}`);
}

console.log(`restore filename allowlist passed (${rejected.length} unsafe cases rejected)`);
