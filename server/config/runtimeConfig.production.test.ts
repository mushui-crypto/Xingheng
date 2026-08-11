import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "./runtimeConfig";

const productionEnvironment = {
  NODE_ENV: "production",
  DOMAIN: "app.stellaxtrade.com",
  APP_PUBLIC_URL: "https://app.stellaxtrade.com",
  CORS_ALLOWED_ORIGINS: "https://app.stellaxtrade.com",
  ADMIN_EMAIL: "admin@stellaxtrade.com",
  ADMIN_PASSWORD: "production-test-password",
  SMTP_HOST: "smtp.stellaxtrade.com",
  SMTP_PORT: "587",
  SMTP_USER: "smtp-user",
  SMTP_PASSWORD: "smtp-password",
  SMTP_FROM: "ops@stellaxtrade.com",
  TRADING_DB_PATH: "/app/data/trading.sqlite",
  BINANCE_USER_ORDER_DB_DIR: "/app/data/binance-users",
  BSC_TESTNET_RPC_URL: "https://bsc-testnet-rpc.stellaxtrade.com",
  BSC_TESTNET_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000001",
  BSC_TESTNET_DEPOSIT_MNEMONIC: "test mnemonic used only for runtime config validation",
} as const;

test("production requires an explicit Binance user order database directory", () => {
  withEnvironment(productionEnvironment, () => {
    delete process.env.BINANCE_USER_ORDER_DB_DIR;
    assert.throws(
      () => loadRuntimeConfig(),
      /生产环境缺少必填配置：BINANCE_USER_ORDER_DB_DIR/u,
    );

    process.env.BINANCE_USER_ORDER_DB_DIR = productionEnvironment.BINANCE_USER_ORDER_DB_DIR;
    assert.equal(loadRuntimeConfig().isProduction, true);

    process.env.BINANCE_USER_ORDER_DB_DIR = "/tmp/binance-users";
    assert.throws(
      () => loadRuntimeConfig(),
      /必须位于持久化数据卷 \/app\/data\/binance-users/u,
    );
  });
});

test("development keeps the Binance user order database directory optional", () => {
  withEnvironment({ NODE_ENV: "development" }, () => {
    delete process.env.BINANCE_USER_ORDER_DB_DIR;
    assert.equal(loadRuntimeConfig().isProduction, false);
  });
});

function withEnvironment(overrides: NodeJS.ProcessEnv, callback: () => void) {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, overrides);
    callback();
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in previous)) delete process.env[name];
    }
    Object.assign(process.env, previous);
  }
}
