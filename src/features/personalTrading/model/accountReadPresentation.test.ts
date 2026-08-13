import assert from "node:assert/strict";
import test from "node:test";
import type { AccountReadSnapshot } from "../../../api/accountRead";
import {
  accountModeLabel,
  estimatedTotalValue,
  estimatedValue,
  nullableAmount,
  permissionLabel,
} from "./accountReadPresentation";

test("permissions use Chinese labels without exposing enums", () => {
  assert.equal(permissionLabel("ENABLED"), "已启用");
  assert.equal(permissionLabel("DISABLED"), "未启用");
  assert.equal(permissionLabel("UNKNOWN"), "无法确认");
});

test("nullable balances and valuations are not presented as zero", () => {
  assert.equal(nullableAmount(null), "暂无可靠数据");
  assert.equal(estimatedValue(null), "暂无估值");
  assert.equal(nullableAmount(0), "0");
  assert.equal(estimatedValue(0), "0 USDT");
});

test("partial account valuation is explicitly marked as incomplete", () => {
  assert.equal(estimatedTotalValue(snapshot("unified", 120, "PARTIAL")), "120 USDT（部分资产）");
  assert.equal(estimatedTotalValue(snapshot("unified", null, "UNAVAILABLE")), "暂无估值");
});

test("known account modes use Chinese display labels", () => {
  assert.equal(accountModeLabel(snapshot("multi_assets_hedge")), "多资产 · 双向持仓");
  assert.equal(accountModeLabel(snapshot("unified_2:regular_margin")), "统一账户 2.0 · 常规保证金");
  assert.equal(accountModeLabel(snapshot("multi_currency_margin")), "多币种保证金");
  assert.equal(accountModeLabel(snapshot("hybrid:advanced:multi_assets")), "混合统一账户 · 高级 · 多资产");
});

function snapshot(
  accountMode: string,
  estimatedTotalValueUsdt: number | null = null,
  valuationCoverage: AccountReadSnapshot["valuationCoverage"] = "UNAVAILABLE",
): AccountReadSnapshot {
  return {
    venue: "binance",
    accountId: "account-hash",
    accountFingerprint: "fingerprint-hash",
    accountTypes: ["unified"],
    accountMode,
    connection: { status: "connected", checkedAt: 1 },
    credentialValidation: { status: "validated", checkedAt: 1 },
    balances: [],
    permissions: { read: "UNKNOWN", spotTrade: "UNKNOWN", derivativesTrade: "UNKNOWN", withdraw: "UNKNOWN", ipRestricted: "UNKNOWN" },
    latestSyncAt: 1,
    estimatedTotalValueUsdt,
    valuationCoverage,
  };
}
