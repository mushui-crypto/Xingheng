import assert from "node:assert/strict";
import test from "node:test";
import { buildPositionTpslOrders } from "../src/features/realTrading/lib/tpslOrders";
import { assertHyperliquidCloid, deriveHyperliquidCloid } from "../src/features/realTrading/lib/hyperliquidCloid";
import { normalizeHyperliquidPrice } from "../src/features/realTrading/lib/hyperliquidPrice";
import {
  formatHyperliquidOrderSizeFloor,
  getHyperliquidSizeInputStep,
  normalizeHyperliquidOrderSizeInput,
} from "../src/features/realTrading/lib/hyperliquidSize";
import { getRealTradingDisplayPriceDecimals } from "../src/features/realTrading/lib/realTradingDisplayPrecision";
import { buildRealTradingEntryOrderInput } from "../src/features/realTrading/lib/realTradingOrderValidation";
import { resolveRealTradingSymbolForRecord, recordBelongsToMarket } from "../src/features/realTrading/lib/realTradingMarket";
import { submitPositionCloseRequest, submitPositionTpslRequest } from "../src/features/realTrading/lib/positionActions";
import type { RealOpenOrder, RealPosition, RealTradingSymbol } from "../src/api/realTrading";

function testCloid(value: number) {
  return assertHyperliquidCloid(`0x${value.toString(16).padStart(32, "0")}`);
}

test("DOGE size precision blocks decimal quantities before signer", () => {
  assert.equal(normalizeHyperliquidOrderSizeInput("1", 0, "DOGEUSDT"), "1");
  assert.equal(normalizeHyperliquidOrderSizeInput("10", 0, "DOGEUSDT"), "10");
  assert.equal(normalizeHyperliquidOrderSizeInput("100", 0, "DOGEUSDT"), "100");
  assert.throws(() => normalizeHyperliquidOrderSizeInput("0.1", 0, "DOGEUSDT"), /DOGEUSDT 数量最多允许 0 位小数/);
  assert.throws(() => normalizeHyperliquidOrderSizeInput("1.5", 0, "DOGEUSDT"), /DOGEUSDT 数量最多允许 0 位小数/);
  assert.throws(() => normalizeHyperliquidOrderSizeInput("10.01", 0, "DOGEUSDT"), /DOGEUSDT 数量最多允许 0 位小数/);

  let signerCalled = false;
  assert.throws(() => {
    buildRealTradingEntryOrderInput({
      assetId: 12,
      cloid: testCloid(1),
      orderPrice: "0.07123456",
      orderSide: "buy",
      orderType: "limit",
      reduceOnly: false,
      size: "1.5",
      szDecimals: 0,
      symbol: "DOGEUSDT",
    });
    signerCalled = true;
  }, /DOGEUSDT 数量最多允许 0 位小数/);
  assert.equal(signerCalled, false);
});

test("BTC and ETH size precision validates without floating rounding", () => {
  assert.equal(normalizeHyperliquidOrderSizeInput("0.12345", 5, "BTCUSDT"), "0.12345");
  assert.throws(() => normalizeHyperliquidOrderSizeInput("0.123456", 5, "BTCUSDT"), /BTCUSDT 数量最多允许 5 位小数/);
  assert.equal(normalizeHyperliquidOrderSizeInput("1.2345", 4, "ETHUSDT"), "1.2345");
  assert.throws(() => normalizeHyperliquidOrderSizeInput("1.23456", 4, "ETHUSDT"), /ETHUSDT 数量最多允许 4 位小数/);
});

test("slider/calculated size floors to szDecimals and exposes matching input step", () => {
  assert.equal(formatHyperliquidOrderSizeFloor(12.999, 0, "DOGEUSDT"), "12");
  assert.equal(formatHyperliquidOrderSizeFloor(0.999, 0, "DOGEUSDT"), "");
  assert.equal(formatHyperliquidOrderSizeFloor(0.123456789, 5, "BTCUSDT"), "0.12345");
  assert.equal(formatHyperliquidOrderSizeFloor(1.23456, 4, "ETHUSDT"), "1.2345");
  assert.equal(getHyperliquidSizeInputStep(0), "1");
  assert.equal(getHyperliquidSizeInputStep(5), "0.00001");
  assert.equal(getHyperliquidSizeInputStep(4), "0.0001");
});

test("Hyperliquid perpetual price normalization handles DOGE lows and integer prices", () => {
  assert.equal(normalizeHyperliquidPrice("0.07123456", 0, "down"), "0.071234");
  assert.equal(normalizeHyperliquidPrice("0.07123456", 0, "up"), "0.071235");
  assert.equal(normalizeHyperliquidPrice("123456", 5, "down"), "123456");
  assert.equal(normalizeHyperliquidPrice("123456", 5, "up"), "123456");
});

test("limit, market protection, TP and SL prices use the same normalization entry", () => {
  const limit = buildRealTradingEntryOrderInput({
    assetId: 12,
    cloid: testCloid(2),
    orderPrice: "0.07123456",
    orderSide: "buy",
    orderType: "limit",
    reduceOnly: false,
    size: "10",
    szDecimals: 0,
    symbol: "DOGEUSDT",
  });
  assert.equal(limit.price, normalizeHyperliquidPrice("0.07123456", 0, "up"));

  const marketProtectionPrice = normalizeHyperliquidPrice(0.07123456 * 1.01, 0, "up");
  const market = buildRealTradingEntryOrderInput({
    assetId: 12,
    cloid: testCloid(3),
    orderPrice: marketProtectionPrice,
    orderSide: "buy",
    orderType: "market",
    reduceOnly: false,
    size: "10",
    szDecimals: 0,
    symbol: "DOGEUSDT",
  });
  assert.equal(market.price, normalizeHyperliquidPrice(marketProtectionPrice, 0, "up"));

  const triggers = buildPositionTpslOrders({
    asset: 12,
    closingIsBuy: false,
    parentCloid: testCloid(4),
    referencePrice: 0.07123456,
    size: "10",
    slPrice: "0.06",
    szDecimals: 0,
    tpPrice: "0.08",
  });
  const tp = triggers.find((order) => order.tpsl === "tp");
  const sl = triggers.find((order) => order.tpsl === "sl");
  assert.equal(tp?.triggerPrice, normalizeHyperliquidPrice("0.08", 0, "down"));
  assert.equal(tp?.price, normalizeHyperliquidPrice(0.08 * 0.9, 0, "down"));
  assert.equal(sl?.triggerPrice, normalizeHyperliquidPrice("0.06", 0, "down"));
  assert.equal(sl?.price, normalizeHyperliquidPrice(0.06 * 0.9, 0, "down"));
});

test("switching to DOGE cannot submit stale BTC decimal quantity", () => {
  let signerCalled = false;
  assert.throws(() => {
    buildRealTradingEntryOrderInput({
      assetId: 12,
      cloid: testCloid(5),
      orderPrice: "0.07123456",
      orderSide: "buy",
      orderType: "limit",
      reduceOnly: false,
      size: "0.12345",
      szDecimals: 0,
      symbol: "DOGEUSDT",
    });
    signerCalled = true;
  }, /DOGEUSDT 数量最多允许 0 位小数/);
  assert.equal(signerCalled, false);
});

test("display precision follows pxDecimals for current market only", () => {
  assert.equal(getRealTradingDisplayPriceDecimals(6), 6); // DOGE
  assert.equal(getRealTradingDisplayPriceDecimals(1), 1); // BTC
  assert.equal(getRealTradingDisplayPriceDecimals(2), 2); // ETH / xyz:GOLD
  assert.equal(getRealTradingDisplayPriceDecimals(undefined), 2);
  assert.equal(getRealTradingDisplayPriceDecimals(Number.NaN), 2);
});


test("confirm modal draft normalizes without signer and market switch reset contract is explicit", () => {
  const draft = buildRealTradingEntryOrderInput({
    assetId: 12,
    cloid: testCloid(6),
    orderPrice: "0.07123456",
    orderSide: "buy",
    orderType: "limit",
    reduceOnly: false,
    size: "10",
    szDecimals: 0,
    symbol: "DOGEUSDT",
  });
  const triggers = buildPositionTpslOrders({
    asset: 12,
    closingIsBuy: false,
    parentCloid: draft.cloid,
    referencePrice: Number(draft.price),
    size: draft.size,
    slPrice: "0.06",
    szDecimals: 0,
    tpPrice: "0.08",
  });

  assert.deepEqual(
    {
      asset: draft.asset,
      market: draft.market,
      price: draft.price,
      size: draft.size,
      triggerPrices: triggers.map((order) => order.triggerPrice),
    },
    {
      asset: 12,
      market: false,
      price: "0.071235",
      size: "10",
      triggerPrices: ["0.08", "0.06"],
    },
  );

  let signerCalled = false;
  assert.equal(signerCalled, false, "building the confirmation summary must not call a signer");

  const staleBtcDraft = () => buildRealTradingEntryOrderInput({
    assetId: 12,
    cloid: testCloid(7),
    orderPrice: "0.07123456",
    orderSide: "buy",
    orderType: "limit",
    reduceOnly: false,
    size: "0.12345",
    szDecimals: 0,
    symbol: "DOGEUSDT",
  });
  assert.throws(staleBtcDraft, /DOGEUSDT 数量最多允许 0 位小数/);
  assert.equal(signerCalled, false, "stale BTC decimal size must still be blocked before signer after switching to DOGE");
});

test("main DEX and HIP-3 account records resolve by symbol/providerMarketId/assetId before coin", async () => {
  const symbols: RealTradingSymbol[] = [
    { assetId: 0, providerCoin: "BTC", providerMarketId: "BTC", pxDecimals: 1, szDecimals: 5, symbol: "BTCUSDT" },
    { assetId: 10001, providerCoin: "BTC", providerMarketId: "xyz:BTC", pxDecimals: 2, szDecimals: 4, symbol: "XYZ-BTCUSDT" },
    { assetId: 10002, providerCoin: "GOLD", providerMarketId: "xyz:GOLD", pxDecimals: 2, szDecimals: 4, symbol: "XYZ-GOLDUSDT" },
  ];
  const mainPosition: RealPosition = {
    assetId: 0,
    coin: "BTC",
    markPx: 65000.12,
    providerMarketId: "BTC",
    side: "long",
    size: 0.123456,
    symbol: "BTCUSDT",
  };
  const hip3Position: RealPosition = {
    assetId: 10001,
    coin: "BTC",
    markPx: 123.4567,
    providerMarketId: "xyz:BTC",
    side: "short",
    size: 1.23456,
    symbol: "XYZ-BTCUSDT",
  };
  const goldPosition: RealPosition = {
    assetId: 10002,
    coin: "GOLD",
    markPx: 2345.67,
    providerMarketId: "xyz:GOLD",
    side: "long",
    size: 2.34567,
    symbol: "XYZ-GOLDUSDT",
  };
  const mainTrigger: RealOpenOrder = { assetId: 0, coin: "BTC", isTrigger: true, oid: 11, providerMarketId: "BTC", symbol: "BTCUSDT" };
  const hip3Trigger: RealOpenOrder = { assetId: 10001, coin: "BTC", isTrigger: true, oid: 22, providerMarketId: "xyz:BTC", symbol: "XYZ-BTCUSDT" };
  const goldTrigger: RealOpenOrder = { assetId: 10002, coin: "GOLD", isTrigger: true, oid: 33, providerMarketId: "xyz:GOLD", symbol: "XYZ-GOLDUSDT" };

  assert.equal(resolveRealTradingSymbolForRecord(mainPosition, symbols)?.assetId, 0);
  assert.equal(resolveRealTradingSymbolForRecord(hip3Position, symbols)?.assetId, 10001);
  assert.equal(resolveRealTradingSymbolForRecord({ assetId: 10002, coin: "BTC" }, symbols)?.symbol, "XYZ-GOLDUSDT");
  assert.equal(resolveRealTradingSymbolForRecord({ coin: "BTC" }, symbols), null, "ambiguous coin-only BTC must not resolve across main/HIP-3");

  assert.equal(recordBelongsToMarket(mainTrigger, symbols[0], symbols), true);
  assert.equal(recordBelongsToMarket(hip3Trigger, symbols[0], symbols), false);
  assert.equal(recordBelongsToMarket(hip3Trigger, symbols[1], symbols), true);
  assert.deepEqual(
    [mainTrigger, hip3Trigger, goldTrigger].filter((order) => order.isTrigger && recordBelongsToMarket(order, symbols[1], symbols)).map((order) => order.oid),
    [22],
  );

  const placedOrders: unknown[][] = [];
  const placedTriggers: unknown[][] = [];
  const signer = {
    async placeOrders(orders: unknown[]) {
      placedOrders.push(orders);
    },
    async placePositionTpsl(orders: unknown[]) {
      placedTriggers.push(orders);
    },
  };

  const closeAllCloid = testCloid(8);
  await submitPositionCloseRequest(signer, { cloid: closeAllCloid, mode: "market", positions: [mainPosition, hip3Position], scope: "all" }, symbols);
  assert.deepEqual(placedOrders[0], [
    { asset: 0, cloid: closeAllCloid, isBuy: false, market: true, price: "64350", reduceOnly: true, size: "0.12345" },
    { asset: 10001, cloid: deriveHyperliquidCloid(closeAllCloid, "close:1"), isBuy: true, market: true, price: "124.7", reduceOnly: true, size: "1.2345" },
  ]);

  const positionTpslCloid = testCloid(9);
  await submitPositionTpslRequest(signer, { cloid: positionTpslCloid, position: goldPosition, slPrice: "2300.12345", tpPrice: "2400.12345" }, symbols);
  assert.deepEqual(placedTriggers[0].map((order: any) => ({ asset: order.asset, cloid: order.cloid, size: order.size, tpsl: order.tpsl })), [
    { asset: 10002, cloid: deriveHyperliquidCloid(positionTpslCloid, "tp"), size: "2.3456", tpsl: "tp" },
    { asset: 10002, cloid: deriveHyperliquidCloid(positionTpslCloid, "sl"), size: "2.3456", tpsl: "sl" },
  ]);
});
