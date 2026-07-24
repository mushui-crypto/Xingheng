import { spawnSync } from "node:child_process";

function validate(name) {
  return spawnSync("sh", ["scripts/restore.sh", name], {
    encoding: "utf8",
    env: { ...process.env, RESTORE_VALIDATE_ONLY: "true" },
  });
}

function validateRwaAutomation(name) {
  return spawnSync("sh", ["scripts/rwa-automation-restore.sh", name], {
    encoding: "utf8",
    env: { ...process.env, RWA_AUTOMATION_RESTORE_VALIDATE_ONLY: "true" },
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

const rwaAccepted = validateRwaAutomation("rwa-automation-20260706T123456Z.rwa.enc.json");
if (rwaAccepted.status !== 0) throw new Error(`valid RWA restore filename rejected: ${rwaAccepted.stderr}`);
const rwaRejected = [
  "rwa-automation-20260706T12345Z.rwa.enc.json",
  "rwa-automation-20260706T123456Z.rwa.enc.json.extra",
  "rwa-automation-20260706T123456Z.rwa.enc.json;id",
  "rwa-automation-20260706T123456Z.rwa.enc.json\nnext",
  "../rwa-automation-20260706T123456Z.rwa.enc.json",
  "trading-20260706T123456Z.sqlite",
];
for (const name of rwaRejected) {
  if (validateRwaAutomation(name).status === 0) {
    throw new Error(`unsafe RWA restore filename accepted: ${JSON.stringify(name)}`);
  }
}

console.log(`restore filename allowlists passed (${rejected.length + rwaRejected.length} unsafe cases rejected)`);
