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
  [compose.includes("strategy_data:/app/strategy-data"), "Strategy reports must use a dedicated named volume"],
  [compose.includes("STRATEGY_FORWARD_REPORT_PATH: /app/strategy-data/route-b-forward.json"), "Compose must pin the forward strategy report path"],
  [compose.includes("STRATEGY_HISTORY_REPORT_PATH: /app/strategy-data/route-b-history.json"), "Compose must pin the history strategy report path"],
  [compose.includes("target: strategy-tools") && compose.includes("strategy-history:"), "Compose must provide a one-shot strategy history service"],
  [dockerfile.includes("AS strategy-tools") && dockerfile.includes("research:ict:history"), "Dockerfile must provide a strategy tools target"],
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
      "STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json",
      "STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json",
      "STRATEGY_EMAIL_ALERTS_ENABLED=false",
      "STRATEGY_ALERT_EMAIL_TO=",
      "RWA_CREDENTIAL_KEY_PROVIDER=gcp-kms",
      "RWA_GCP_KMS_KEY_NAME=projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials",
      "RWA_GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/REPLACE_WITH_PROJECT_NUMBER/locations/global/workloadIdentityPools/REPLACE_WITH_POOL/providers/REPLACE_WITH_PROVIDER",
      "GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp-wif/adc.json",
    ].every((key) => env.includes(key)),
    "production env example is incomplete",
  ],
  [server.includes("STRATEGY_ALERT_EMAIL_TO 必须是有效且非示例"), "production config must validate strategy alert email when enabled"],
  [server.includes("RWA_AUTOMATION_MASTER_KEY 已停用") && server.includes("RWA_CREDENTIAL_KEY_PROVIDER 必须固定为 gcp-kms"), "production must reject local or fake credential key providers"],
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
