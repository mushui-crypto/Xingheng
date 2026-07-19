import assert from "node:assert/strict";
import test from "node:test";
import { resolveHyperliquidSessionIdentityChange } from "./sessionIdentity";

const providerA = {};
const providerB = {};
const activeIdentity = { provider: providerA, userId: "user-1", walletAddress: "0xAbC" };

test("相同会话身份不会因页面重新挂载而失效", () => {
  assert.deepEqual(
    resolveHyperliquidSessionIdentityChange(activeIdentity, activeIdentity, true),
    { changed: false, message: "" },
  );
});

test("已有会话的钱包地址变化会要求重新授权", () => {
  assert.deepEqual(
    resolveHyperliquidSessionIdentityChange(
      activeIdentity,
      { ...activeIdentity, walletAddress: "0xDEF" },
      true,
    ),
    { changed: true, message: "钱包地址已变化，需要重新初始化会话签名器。" },
  );
});

test("已有会话的 provider 变化会要求重新授权", () => {
  assert.deepEqual(
    resolveHyperliquidSessionIdentityChange(
      activeIdentity,
      { ...activeIdentity, provider: providerB },
      true,
    ),
    { changed: true, message: "钱包连接已变化，需要重新初始化会话签名器。" },
  );
});

test("初次恢复钱包连接不会误报钱包地址变化", () => {
  assert.deepEqual(
    resolveHyperliquidSessionIdentityChange(
      { provider: null, userId: "user-1", walletAddress: "" },
      activeIdentity,
      false,
    ),
    { changed: true, message: "" },
  );
});
