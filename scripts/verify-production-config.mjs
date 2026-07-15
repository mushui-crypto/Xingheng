import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../dist-server/index.js", import.meta.url));

const baseEnvironment = {
  ...process.env,
  NODE_ENV: "production",
  API_PORT: "18789",
  DOMAIN: "trade.stellarx.test",
  APP_PUBLIC_URL: "https://trade.stellarx.test",
  CORS_ALLOWED_ORIGINS: "https://trade.stellarx.test",
  ADMIN_EMAIL: "ops@stellarx.test",
  ADMIN_PASSWORD: "test-only-random-password-123",
  SMTP_HOST: "smtp.stellarx.test",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "smtp-user",
  SMTP_PASSWORD: "smtp-password-123",
  SMTP_FROM: "Stella X <no-reply@stellarx.test>",
  TRADING_DB_PATH: "/tmp/xingheng-config-verification.sqlite",
  BSC_TESTNET_CHAIN_ID: "97",
  BSC_TESTNET_RPC_URL: "https://rpc.test.invalid",
  BSC_TESTNET_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
  STRATEGY_EMAIL_ALERTS_ENABLED: "false",
  STRATEGY_ALERT_EMAIL_TO: "ops@stellarx.test",
};

const cases = [
  ["example domain", { DOMAIN: "trade.example.com", CORS_ALLOWED_ORIGINS: "https://trade.example.com" }, "DOMAIN 仍是示例占位值"],
  ["invalid hostname", { DOMAIN: "-bad.example", CORS_ALLOWED_ORIGINS: "https://-bad.example" }, "DOMAIN 必须是纯域名"],
  ["example admin email", { ADMIN_EMAIL: "admin@example.com" }, "ADMIN_EMAIL 必须是有效且非示例"],
  ["invalid admin email", { ADMIN_EMAIL: "not-an-email" }, "ADMIN_EMAIL 必须是有效且非示例"],
  ["example password", { ADMIN_PASSWORD: "replace-with-a-long-random-secret" }, "ADMIN_PASSWORD 仍是示例占位值"],
  ["missing app public url", { APP_PUBLIC_URL: undefined }, "生产环境缺少必填配置：APP_PUBLIC_URL"],
  ["mismatched app public url", { APP_PUBLIC_URL: "https://other.stellarx.test" }, "APP_PUBLIC_URL 必须与 DOMAIN"],
  ["placeholder SMTP", { SMTP_HOST: "REPLACE_WITH_SMTP_HOST" }, "SMTP 配置仍是示例占位值"],
  ["placeholder RPC", { BSC_TESTNET_RPC_URL: "REPLACE_WITH_BSC_TESTNET_RPC_URL" }, "BSC_TESTNET_RPC_URL 必须是有效的 HTTP(S)"],
  ["non-http RPC", { BSC_TESTNET_RPC_URL: "ftp://rpc.example.net" }, "BSC_TESTNET_RPC_URL 必须是 HTTP(S)"],
  ["placeholder token address", { BSC_TESTNET_TOKEN_ADDRESS: "REPLACE_WITH_BSC_TESTNET_TOKEN_ADDRESS" }, "BSC_TESTNET_TOKEN_ADDRESS 必须是有效且非零"],
  ["zero token address", { BSC_TESTNET_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000000" }, "BSC_TESTNET_TOKEN_ADDRESS 必须是有效且非零"],
  ["enabled strategy email alert without recipient", { STRATEGY_EMAIL_ALERTS_ENABLED: "true", STRATEGY_ALERT_EMAIL_TO: "ops@example.invalid" }, "STRATEGY_ALERT_EMAIL_TO 必须是有效且非示例"],
];

for (const [name, overrides, expected] of cases) {
  const env = { ...baseEnvironment, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  const result = spawnSync(process.execPath, [serverEntry], {
    encoding: "utf8",
    env,
    cwd: tmpdir(),
    timeout: 5_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes(expected)) {
    throw new Error(`${name} was not rejected as expected\n${output}`);
  }
}

console.log(`production config rejection passed (${cases.length} cases)`);
