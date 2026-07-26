import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../dist-server/index.js", import.meta.url));

const baseEnvironment = {
  ...process.env,
  NODE_ENV: "production",
  XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
  XINGHENG_COMPOSE_PROJECT: "xingheng",
  XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
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
  BSC_TESTNET_DEPOSIT_MNEMONIC: "test test test test test test test test test test test junk",
  STRATEGY_EMAIL_ALERTS_ENABLED: "false",
  STRATEGY_ALERT_EMAIL_TO: "ops@stellarx.test",
  RWA_CREDENTIAL_KEY_PROVIDER: "gcp-kms",
  RWA_GCP_KMS_KEY_NAME: "projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials",
  RWA_GCP_WIF_AUDIENCE: "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/xingheng-rwa-prod/providers/vultr-x509",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/gcp-wif/adc.json",
  RWA_AUTOMATION_DATA_DIR: "/app/rwa-automation-data",
  RWA_AUTOMATION_INSTANCE_COUNT: "1",
  WEB_CONCURRENCY: "1",
  RWA_AUTOMATION_EXECUTION_MODE: "single-host",
  RWA_AUTOMATION_LOCK_DIR: "/app/rwa-automation-lock",
  RWA_AUTOMATION_LOCK_PATH: "/app/rwa-automation-lock/operation.lock",
  RWA_AUTOMATION_BACKUP_DIR: "/app/rwa-automation-backups",
  RWA_AUTOMATION_BACKUP_RETENTION_DAYS: "30",
  RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES: "1073741824",
  RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES: "104857600",
};

const cases = [
  ["example domain", { DOMAIN: "trade.example.com", CORS_ALLOWED_ORIGINS: "https://trade.example.com" }, "DOMAIN 仍是示例占位值"],
  ["invalid hostname", { DOMAIN: "-bad.example", CORS_ALLOWED_ORIGINS: "https://-bad.example" }, "部署环境必须绑定有效的纯域名"],
  ["missing deployment environment", { XINGHENG_DEPLOYMENT_ENVIRONMENT: undefined }, "XINGHENG_DEPLOYMENT_ENVIRONMENT 必须精确为"],
  ["crossed Compose project", { XINGHENG_COMPOSE_PROJECT: "xingheng-real-test" }, "部署环境身份与固定 Compose 项目不一致"],
  ["crossed WIF host path", { XINGHENG_WIF_HOST_PATH: "/run/xingheng-real-test/gcp-wif" }, "部署环境 WIF 挂载身份不一致"],
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
  ["local RWA master key", { RWA_AUTOMATION_MASTER_KEY: "11".repeat(32) }, "RWA_AUTOMATION_MASTER_KEY 已停用"],
  ["fake credential provider", { RWA_CREDENTIAL_KEY_PROVIDER: "fake" }, "RWA_CREDENTIAL_KEY_PROVIDER 必须固定为 gcp-kms"],
  ["wrong GCP KMS key", { RWA_GCP_KMS_KEY_NAME: "projects/other/locations/global/keyRings/other/cryptoKeys/other" }, "正式环境 RWA_GCP_KMS_KEY_NAME 必须是已冻结的 CryptoKey"],
  ["real-test crossed public domain", {
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
    XINGHENG_COMPOSE_PROJECT: "xingheng-real-test",
    XINGHENG_WIF_HOST_PATH: "/run/xingheng-real-test/gcp-wif",
    REAL_TEST_DOMAIN: "real-test.stellarx.test",
  }, "真实测试 API 的 DOMAIN 必须精确绑定 REAL_TEST_DOMAIN"],
  ["real-test reuses production KMS key", {
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
    XINGHENG_COMPOSE_PROJECT: "xingheng-real-test",
    XINGHENG_WIF_HOST_PATH: "/run/xingheng-real-test/gcp-wif",
    DOMAIN: "real-test.stellarx.test",
    REAL_TEST_DOMAIN: "real-test.stellarx.test",
    APP_PUBLIC_URL: "https://real-test.stellarx.test",
    CORS_ALLOWED_ORIGINS: "https://real-test.stellarx.test",
  }, "真实测试环境必须使用独立且有效的 GCP KMS CryptoKey"],
  ["untrusted WIF audience", { RWA_GCP_WIF_AUDIENCE: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/other/providers/other" }, "RWA_GCP_WIF_AUDIENCE 必须是受信 WIF provider"],
  ["unsafe ADC path", { GOOGLE_APPLICATION_CREDENTIALS: "/app/service-account.json" }, "GOOGLE_APPLICATION_CREDENTIALS 必须指向冻结的 X.509 WIF ADC"],
  ["wrong RWA data path", { RWA_AUTOMATION_DATA_DIR: "/app/data" }, "RWA_AUTOMATION_DATA_DIR 必须使用冻结的专用卷路径"],
  ["mixed RWA backup path", { RWA_AUTOMATION_BACKUP_DIR: "/backups" }, "RWA_AUTOMATION_BACKUP_DIR 必须使用独立备份卷路径"],
  ["invalid RWA retention", { RWA_AUTOMATION_BACKUP_RETENTION_DAYS: "0" }, "自动套利备份保留或容量配置无效"],
  ["invalid RWA total capacity", { RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES: "unlimited" }, "自动套利备份保留或容量配置无效"],
  ["invalid RWA snapshot capacity", { RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES: "999999999999" }, "自动套利备份保留或容量配置无效"],
  ["disabled automation limiter", { RWA_AUTOMATION_EXECUTE_BURST_MAX: "0" }, "自动套利限流或状态容量配置无效"],
  ["oversized automation limiter", { RWA_AUTOMATION_PREFLIGHT_SUSTAINED_MAX: "999999999" }, "自动套利限流或状态容量配置无效"],
  ["invalid automation retention", { RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS: "-1" }, "自动套利限流或状态容量配置无效"],
  ["short automation retention", { RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS: String(29 * 86_400) }, "自动套利限流或状态容量配置无效"],
  ["inverted automation state capacity", {
    RWA_AUTOMATION_STATE_MAX_BYTES: "10485760",
    RWA_AUTOMATION_STATE_MAX_BYTES_HARD: "1048576",
  }, "自动套利限流或状态容量配置无效"],
  ["multiple automation instances", { RWA_AUTOMATION_INSTANCE_COUNT: "2" }, "当前只允许单 Node API 实例"],
  ["node worker expansion", { WEB_CONCURRENCY: "2" }, "当前只允许单 Node API 实例"],
  ["wrong automation execution mode", { RWA_AUTOMATION_EXECUTION_MODE: "multi-host" }, "自动套利执行拓扑必须使用冻结的单主机独占租约配置"],
  ["wrong automation lock root", { RWA_AUTOMATION_LOCK_DIR: "/app/data" }, "自动套利执行拓扑必须使用冻结的单主机独占租约配置"],
  ["wrong automation lock path", { RWA_AUTOMATION_LOCK_PATH: "/app/rwa-automation-lock/other.lock" }, "自动套利执行拓扑必须使用冻结的单主机独占租约配置"],
  ["short monitored Binance account", { RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS: "binance:0123456789abcdef,binance:0123" }, "必须只包含精确的 Binance 专用账户内部指纹"],
  ["mixed-case monitored Binance account", { RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS: "binance:0123456789abcdeF" }, "必须只包含精确的 Binance 专用账户内部指纹"],
  ["empty monitored Binance account segment", { RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS: "binance:0123456789abcdef," }, "必须只包含精确的 Binance 专用账户内部指纹"],
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
