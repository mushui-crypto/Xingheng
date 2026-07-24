import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const forbiddenEnvironment = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "RWA_AUTOMATION_MASTER_KEY",
  "RWA_BINANCE_ALLOWED_EGRESS_IPS",
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
];

if (
  process.env.NODE_ENV === "production"
  || process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH === "false"
  || forbiddenEnvironment.some((name) => Boolean(process.env[name]?.trim()))
) {
  console.error("offline rehearsal refused: production identity, credential, network, or execution settings are present");
  process.exit(1);
}

const automationDirectory = resolve("server/modules/arbitrage/automation");
const automationTests = readdirSync(automationDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => resolve(automationDirectory, name));
const securityTests = [
  resolve("server/modules/security/StepUpSecurityService.test.ts"),
  resolve("server/modules/security/Totp.test.ts"),
];

const environment = { ...process.env, NODE_ENV: "test" };
for (const name of forbiddenEnvironment) delete environment[name];
delete environment.RWA_AUTOMATION_SERVER_KILL_SWITCH;

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...automationTests, ...securityTests],
  {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error("offline rehearsal could not start");
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("RWA Mainnet readiness offline rehearsal passed; no production identity or credential settings were used.");
