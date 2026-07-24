import { isAddress } from "ethers";
import { RWA_GCP_KMS_KEY_NAME } from "../modules/arbitrage/automation/CredentialKeyProvider";
import {
  RWA_GCP_WIF_ADC_PATH,
  isCanonicalGcpWifAudience,
  validateGcpWifCredentialFiles,
  validateGcpWifRuntimeBoundary,
} from "../modules/arbitrage/automation/GcpWifCredentialConfig";
import {
  RWA_AUTOMATION_BACKUP_ROOT,
  loadRwaAutomationBackupLimits,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";
import {
  RWA_AUTOMATION_DATA_ROOT,
  validateRwaAutomationDataLayout,
} from "../modules/arbitrage/automation/RwaAutomationDataLayout";
import { loadRwaAutomationGovernanceConfig } from "../modules/arbitrage/automation/RwaAutomationGovernance";

export type RuntimeConfig = {
  port: number;
  isProduction: boolean;
  appPublicUrl: string;
  adminEmail: string;
  adminPassword: string;
  adminAuthConfigured: boolean;
  allowedOrigins: Set<string>;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
    configured: boolean;
  };
};

export function loadRuntimeConfig(): RuntimeConfig {
  const port = Number(process.env.API_PORT ?? 8787);
  const isProduction = process.env.NODE_ENV === "production";
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  const allowedOrigins = getAllowedOrigins(isProduction);
  const domain = process.env.DOMAIN?.trim() ?? "";
  const configuredAppPublicUrl = process.env.APP_PUBLIC_URL?.trim() ?? "";
  const appPublicUrl = normalizeAppPublicUrl(configuredAppPublicUrl || (!isProduction && domain ? `https://${domain}` : "http://localhost:5173"));
  const smtp = loadSmtpConfig();
  const config = {
    port,
    isProduction,
    appPublicUrl,
    adminEmail,
    adminPassword,
    adminAuthConfigured: Boolean(adminEmail && adminPassword.length >= 12),
    allowedOrigins,
    smtp,
  };
  validateProductionConfig(config);
  return config;
}

function normalizeAppPublicUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return value;
  }
}

function loadSmtpConfig(): RuntimeConfig["smtp"] {
  const port = Number(process.env.SMTP_PORT ?? 587);
  const host = process.env.SMTP_HOST?.trim() ?? "";
  const user = process.env.SMTP_USER?.trim() ?? "";
  const password = process.env.SMTP_PASSWORD ?? "";
  const from = process.env.SMTP_FROM?.trim() ?? "";
  return {
    host,
    port: Number.isInteger(port) ? port : 587,
    secure: process.env.SMTP_SECURE === "true",
    user,
    password,
    from,
    configured: Boolean(host && from && Number.isInteger(port) && port > 0 && port <= 65_535 && user && password),
  };
}

function getAllowedOrigins(isProduction: boolean) {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!isProduction) {
    configured.push(
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
    );
  }
  return new Set(configured);
}

function validateProductionConfig(config: RuntimeConfig) {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("API_PORT 必须是有效端口。");
  }
  const configuredChainId = Number(process.env.BSC_TESTNET_CHAIN_ID ?? 97);
  if (configuredChainId !== 97) {
    throw new Error("当前仅允许 BSC Testnet（BSC_TESTNET_CHAIN_ID=97）。");
  }
  if (!config.isProduction) return;

  const required = [
    ["DOMAIN", process.env.DOMAIN?.trim() ?? ""],
    ["ADMIN_EMAIL", config.adminEmail],
    ["ADMIN_PASSWORD（至少 12 位）", config.adminPassword.length >= 12 ? config.adminPassword : ""],
    ["APP_PUBLIC_URL", process.env.APP_PUBLIC_URL?.trim() ?? ""],
    ["SMTP_HOST", config.smtp.host],
    ["SMTP_PORT", String(config.smtp.port)],
    ["SMTP_USER", config.smtp.user],
    ["SMTP_PASSWORD", config.smtp.password],
    ["SMTP_FROM", config.smtp.from],
    ["TRADING_DB_PATH", process.env.TRADING_DB_PATH?.trim() ?? ""],
    ["CORS_ALLOWED_ORIGINS", process.env.CORS_ALLOWED_ORIGINS?.trim() ?? ""],
    ["BSC_TESTNET_RPC_URL", process.env.BSC_TESTNET_RPC_URL?.trim() ?? ""],
    ["BSC_TESTNET_TOKEN_ADDRESS", process.env.BSC_TESTNET_TOKEN_ADDRESS?.trim() ?? ""],
    ["BSC_TESTNET_DEPOSIT_MNEMONIC", process.env.BSC_TESTNET_DEPOSIT_MNEMONIC?.trim() ?? ""],
    ["RWA_CREDENTIAL_KEY_PROVIDER", process.env.RWA_CREDENTIAL_KEY_PROVIDER?.trim() ?? ""],
    ["RWA_GCP_KMS_KEY_NAME", process.env.RWA_GCP_KMS_KEY_NAME?.trim() ?? ""],
    ["RWA_GCP_WIF_AUDIENCE", process.env.RWA_GCP_WIF_AUDIENCE?.trim() ?? ""],
    ["GOOGLE_APPLICATION_CREDENTIALS", process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? ""],
    ["RWA_AUTOMATION_DATA_DIR", process.env.RWA_AUTOMATION_DATA_DIR?.trim() ?? ""],
    ["RWA_AUTOMATION_INSTANCE_COUNT", process.env.RWA_AUTOMATION_INSTANCE_COUNT?.trim() ?? ""],
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`生产环境缺少必填配置：${missing.join("、")}。`);
  }
  const domain = process.env.DOMAIN!.trim();
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes(":") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)
  ) {
    throw new Error("DOMAIN 必须是纯域名，不得包含协议、路径或端口。");
  }
  if (domain === "trade.example.com" || domain.endsWith(".invalid") || domain.includes("replace-me")) {
    throw new Error("DOMAIN 仍是示例占位值，请填写正式域名。");
  }
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail) ||
    config.adminEmail === "admin@example.com" ||
    config.adminEmail.endsWith("@example.invalid")
  ) {
    throw new Error("ADMIN_EMAIL 必须是有效且非示例的管理员邮箱。");
  }
  if (
    config.adminPassword === "replace-with-a-long-random-secret" ||
    config.adminPassword.includes("REPLACE_WITH") ||
    config.adminPassword.toLowerCase().includes("replace-me")
  ) {
    throw new Error("ADMIN_PASSWORD 仍是示例占位值，请生成独立随机密码。");
  }
  for (const origin of config.allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) {
      throw new Error("生产环境 CORS_ALLOWED_ORIGINS 必须是 HTTPS origin，不得包含路径。");
    }
  }
  if (!config.allowedOrigins.has(`https://${domain}`)) {
    throw new Error("CORS_ALLOWED_ORIGINS 必须包含与 DOMAIN 对应的 HTTPS origin。");
  }
  if (config.appPublicUrl !== `https://${domain}`) {
    throw new Error("APP_PUBLIC_URL 必须与 DOMAIN 对应的 HTTPS origin 一致。");
  }
  if (!config.smtp.configured) {
    throw new Error("生产环境必须配置 SMTP_HOST、SMTP_PORT、SMTP_FROM，用于注册和找回密码验证码。");
  }
  if (
    [config.smtp.host, config.smtp.user, config.smtp.password, config.smtp.from].some(
      (value) => value.includes("REPLACE_WITH") || value.toLowerCase().includes("replace-me") || value.endsWith(".invalid"),
    )
  ) {
    throw new Error("SMTP 配置仍是示例占位值，请填写正式邮件服务参数。");
  }
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(process.env.BSC_TESTNET_RPC_URL!.trim());
  } catch {
    throw new Error("BSC_TESTNET_RPC_URL 必须是有效的 HTTP(S) URL。");
  }
  if (!["http:", "https:"].includes(rpcUrl.protocol) || !rpcUrl.hostname) {
    throw new Error("BSC_TESTNET_RPC_URL 必须是 HTTP(S) URL。");
  }
  const tokenAddress = process.env.BSC_TESTNET_TOKEN_ADDRESS?.trim() ?? "";
  if (!isAddress(tokenAddress) || /^0x0{40}$/i.test(tokenAddress)) {
    throw new Error("BSC_TESTNET_TOKEN_ADDRESS 必须是有效且非零的测试网合约地址。");
  }
  if (process.env.STRATEGY_EMAIL_ALERTS_ENABLED === "true") {
    const recipient = process.env.STRATEGY_ALERT_EMAIL_TO?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient.endsWith("@example.invalid")) {
      throw new Error("STRATEGY_ALERT_EMAIL_TO 必须是有效且非示例的告警收件邮箱。");
    }
  }
  if (process.env.RWA_AUTOMATION_MASTER_KEY?.trim()) {
    throw new Error("RWA_AUTOMATION_MASTER_KEY 已停用；生产环境禁止回退本地主密钥。");
  }
  if (process.env.RWA_CREDENTIAL_KEY_PROVIDER !== "gcp-kms") {
    throw new Error("生产环境 RWA_CREDENTIAL_KEY_PROVIDER 必须固定为 gcp-kms。");
  }
  if (process.env.RWA_GCP_KMS_KEY_NAME !== RWA_GCP_KMS_KEY_NAME) {
    throw new Error("生产环境 RWA_GCP_KMS_KEY_NAME 必须是已冻结的 CryptoKey 完整资源名。");
  }
  if (process.env.RWA_AUTOMATION_DATA_DIR !== RWA_AUTOMATION_DATA_ROOT) {
    throw new Error("生产环境 RWA_AUTOMATION_DATA_DIR 必须使用冻结的专用卷路径。");
  }
  if (
    process.env.RWA_AUTOMATION_INSTANCE_COUNT !== "1"
    || (process.env.WEB_CONCURRENCY && process.env.WEB_CONCURRENCY !== "1")
  ) {
    throw new Error("自动套利容量治理当前只允许单 Node API 实例，禁止横向扩容。");
  }
  if (process.env.RWA_AUTOMATION_BACKUP_DIR && process.env.RWA_AUTOMATION_BACKUP_DIR !== RWA_AUTOMATION_BACKUP_ROOT) {
    throw new Error("生产环境 RWA_AUTOMATION_BACKUP_DIR 必须使用独立备份卷路径。");
  }
  try {
    loadRwaAutomationBackupLimits();
  } catch {
    throw new Error("生产环境自动套利备份保留或容量配置无效。");
  }
  try {
    loadRwaAutomationGovernanceConfig();
  } catch {
    throw new Error("生产环境自动套利限流或状态容量配置无效。");
  }
  const wifAudience = process.env.RWA_GCP_WIF_AUDIENCE?.trim() ?? "";
  if (!isCanonicalGcpWifAudience(wifAudience)) {
    throw new Error("生产环境 RWA_GCP_WIF_AUDIENCE 必须是受信 WIF provider 的完整 audience。");
  }
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "";
  if (adcPath !== RWA_GCP_WIF_ADC_PATH) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS 必须指向冻结的 X.509 WIF ADC secret 路径。");
  }
  validateGcpWifRuntimeBoundary();
  validateGcpWifCredentialFiles({ adcPath, expectedAudience: wifAudience });
  validateRwaAutomationDataLayout({ root: RWA_AUTOMATION_DATA_ROOT, production: true });
}
