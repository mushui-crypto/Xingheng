import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BinanceAccountSnapshot, BinanceMarketSnapshot, BinanceOrdersState, BinanceStatus } from "../../../api/binancePersonalTrading";
import { BinanceDiagnosticsContent } from "./BinanceAccountDiagnostics";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Binance detail keeps valuable account, market, funding, risk and order diagnostics read-only", () => {
  const html = renderToStaticMarkup(<BinanceDiagnosticsContent checking={false} onCheckConnection={() => undefined} onRefresh={() => undefined} state={{
    status: { status: "success", value: status() }, account: { status: "success", value: account() },
    market: { status: "success", value: market() }, orders: { status: "success", value: orders() },
  }} />);
  for (const label of ["连接状态", "真实交易", "Binance 急停", "单笔上限", "仓位上限", "Spot 可用 USDT", "Futures 可用 USDT", "现货 XAUT 总量", "永续 XAUT 仓位", "活动订单", "Spot 市场状态", "Futures 市场状态", "Funding rate", "下次结算时间", "订单诊断", "测试诊断"]) assert.match(html, new RegExp(label));
  assert.match(html, /检查连接/);
  assert.doesNotMatch(html, /开仓|平仓|下单|调仓|立即修复|PnL|APR|APY/u);
});

test("Binance detail isolates unavailable account and order sources", () => {
  const html = renderToStaticMarkup(<BinanceDiagnosticsContent checking={false} onCheckConnection={() => undefined} onRefresh={() => undefined} state={{
    status: { status: "success", value: status() }, account: { status: "error" },
    market: { status: "success", value: market() }, orders: { status: "error" },
  }} />);
  assert.match(html, /Binance 账户信息暂时不可用/);
  assert.match(html, /Binance 订单诊断暂时不可用/);
  assert.match(html, /Funding rate/);
  assert.match(html, /已连接/);
});

function status(): BinanceStatus {
  return { mode: "personal", version: "test", credential: { configured: true, maskedApiKey: "••••1234" }, connection: { status: "connected", checkedAt: 1_800_000_000_000, accountId: "account", message: null }, risk: { liveTradingEnabled: false, killSwitchActive: true, maxOrderUsd: 100, maxPositionUsd: 500 } };
}

function account(): BinanceAccountSnapshot {
  return {
    accountId: "account", accountFingerprint: "fingerprint", fetchedAt: 1_800_000_000_000, accountMode: "single_asset_one_way",
    permissions: { read: true, spotTrade: true, contractTrade: true, withdraw: false, ipRestricted: true, spotAccount: true, futuresAccount: true, positionModeSupported: true },
    productAvailability: { available: true, status: "available", spotSymbol: "XAUTUSDT", perpetualSymbol: "XAUTUSDT", checkedAt: 1_800_000_000_000, message: null },
    availableUsdt: 900, spotAvailableUsdt: 400, futuresAvailableUsdt: 500, spotFreeXaut: 1, spotLockedXaut: 0.1,
    existingSpotQuantityXaut: 1.1, spotAvailableQuantityXaut: 1, spotLockedQuantityXaut: 0.1, existingPerpetualQuantityXaut: 1.1,
    perpetualPositionSide: "short", openSpotOrderCount: 1, openPerpetualOrderCount: 2, spot: instrument(),
    perpetual: { ...instrument(), leverage: 2, marginMode: "cross", mark: 3300, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingTime: 1_800_000_010_000, liquidationDistancePercent: null },
    fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
  };
}

function market(): BinanceMarketSnapshot {
  const value = account();
  return { fetchedAt: value.fetchedAt, productAvailability: value.productAvailability, spot: value.spot, perpetual: value.perpetual, fees: value.fees };
}

function orders(): BinanceOrdersState {
  return { orders: [{ idempotencyKey: "order-1", clientOrderId: "client-1", providerOrderId: "provider-1", category: "spot", executionMode: "test_gtc", status: "completed", order: { orderId: "provider-1", orderLinkId: "client-1", status: "Filled", requestedQuantityXaut: 1, filledQuantityXaut: 1, averagePrice: 3300, feeUsd: 1, updatedAt: 1_800_000_000_000 }, error: null, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }] };
}

function instrument() {
  return { status: "Trading" as const, minOrderQty: 0.001, qtyStep: 0.001, minNotionalUsd: 10, priceTick: 0.1, quantityPrecision: 3, bid: 3299, ask: 3301, depthUsd: 100000 };
}
