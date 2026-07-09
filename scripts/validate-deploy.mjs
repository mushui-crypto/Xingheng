import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const dockerfile = read("Dockerfile");
const compose = read("compose.yaml");
const caddy = read("deploy/Caddyfile");
const env = read(".env.production.example");
const server = [read("server/index.ts"), read("server/config/runtimeConfig.ts")].join("\n");
const wallet = read("server/wallet/WalletService.ts");
const restore = read("scripts/restore.sh");
const backup = read("scripts/backup.sh");
const smoke = read("scripts/smoke.sh");

const assertions = [
  [dockerfile.includes("AS build") && dockerfile.includes("AS api") && dockerfile.includes("AS web"), "Dockerfile must use build/api/web stages"],
  [dockerfile.includes("npm ci --omit=dev") && dockerfile.includes('CMD [\"node\", \"dist-server/index.js\"]'), "API runtime must use production dependencies and compiled JS"],
  [dockerfile.includes("USER node"), "API must run as a non-root user"],
  [compose.includes("condition: service_healthy"), "web must wait for a healthy API"],
  [compose.includes('test -n "$$DOMAIN"'), "web must reject a missing domain"],
  [(compose.match(/env_file:/g) ?? []).length === 1, "only API may receive the production secret env file"],
  [compose.includes('DOMAIN: "${DOMAIN:?'), "web must receive only the interpolated public domain"],
  [compose.includes("sqlite_data:/app/data"), "SQLite must use its named volume"],
  [compose.includes('BSC_TESTNET_CHAIN_ID: \"97\"'), "BSC Testnet chain ID must be pinned"],
  [caddy.indexOf("reverse_proxy /api*") < caddy.indexOf("try_files"), "/api proxy must precede SPA fallback"],
  [caddy.indexOf("reverse_proxy /ws") < caddy.indexOf("try_files"), "/ws proxy must precede SPA fallback"],
  [
    [
      "DOMAIN=",
      "APP_PUBLIC_URL=https://",
      "CORS_ALLOWED_ORIGINS=https://",
      "ADMIN_EMAIL=",
      "ADMIN_PASSWORD=",
      "SMTP_HOST=",
      "SMTP_PORT=",
      "SMTP_USER=",
      "SMTP_PASSWORD=",
      "SMTP_FROM=",
      "BSC_TESTNET_CHAIN_ID=97",
    ].every((key) => env.includes(key)),
    "production env example is incomplete",
  ],
  [env.includes(".invalid") && env.includes("REPLACE_WITH_BSC_TESTNET_RPC_URL") && env.includes("REPLACE_WITH_BSC_TESTNET_TOKEN_ADDRESS"), "production env example must use unmistakable rejected placeholders"],
  [server.includes('domain.endsWith(".invalid")') && server.includes("BSC_TESTNET_TOKEN_ADDRESS 必须是有效且非零") && server.includes("SMTP 配置仍是示例占位值"), "production startup must reject placeholder identity and unsafe token configuration"],
  [wallet.includes('process.env.NODE_ENV !== "production"') && wallet.includes('process.env.NODE_ENV === "production"'), "production must not initialize or seed demo wallet data"],
  [restore.includes("trading-[0-9][0-9]") && !restore.includes("trading-*.sqlite"), "restore filename must use a strict timestamp allowlist"],
  [[backup, restore, smoke].every((script) => script.includes('--env-file')), "operational scripts must load the production Compose environment explicitly"],
];

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("deployment static validation passed");
