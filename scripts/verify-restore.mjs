import { spawnSync } from "node:child_process";

function validate(name) {
  return spawnSync("sh", ["scripts/restore.sh", name], {
    encoding: "utf8",
    env: { ...process.env, RESTORE_VALIDATE_ONLY: "true" },
  });
}

const accepted = validate("stellax-20260706T123456Z");
if (accepted.status !== 0) throw new Error(`valid restore filename rejected: ${accepted.stderr}`);

const rejected = [
  "stellax-20260706T12345Z",
  "stellax-20260706T123456Z.extra",
  "stellax-20260706T123456Z;select 1",
  "stellax-20260706T123456Z\n.shell id",
  "../stellax-20260706T123456Z",
];
for (const name of rejected) {
  if (validate(name).status === 0) throw new Error(`unsafe restore filename accepted: ${JSON.stringify(name)}`);
}

console.log(`restore filename allowlist passed (${rejected.length} unsafe cases rejected)`);
