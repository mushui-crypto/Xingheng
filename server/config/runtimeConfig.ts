import { isAddress } from "ethers";

export type RuntimeConfig = {
  port: number;
  isProduction: boolean;
  adminEmail: string;
  adminPassword: string;
  adminAuthConfigured: boolean;
  allowedOrigins: Set<string>;
};

export function loadRuntimeConfig(): RuntimeConfig {
  const port = Number(process.env.API_PORT ?? 8787);
  const isProduction = process.env.NODE_ENV === "production";
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  const allowedOrigins = getAllowedOrigins(isProduction);
  const config = {
    port,
    isProduction,
    adminEmail,
    adminPassword,
    adminAuthConfigured: Boolean(adminEmail && adminPassword.length >= 12),
    allowedOrigins,
  };
  validateProductionConfig(config);
  return config;
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
    ["TRADING_DB_PATH", process.env.TRADING_DB_PATH?.trim() ?? ""],
    ["CORS_ALLOWED_ORIGINS", process.env.CORS_ALLOWED_ORIGINS?.trim() ?? ""],
    ["BSC_TESTNET_RPC_URL", process.env.BSC_TESTNET_RPC_URL?.trim() ?? ""],
    ["BSC_TESTNET_TOKEN_ADDRESS", process.env.BSC_TESTNET_TOKEN_ADDRESS?.trim() ?? ""],
    ["BSC_TESTNET_DEPOSIT_MNEMONIC", process.env.BSC_TESTNET_DEPOSIT_MNEMONIC?.trim() ?? ""],
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
}
