import assert from "node:assert/strict";
import { buildDemoMarketIconUrl } from "../server/modules/api/marketRoutes";
import { normalizeDemoBookSide, normalizeDemoMarketSummary, normalizeDemoTrade } from "../server/modules/market/HyperliquidRestClient";
import { resolveRealTradingCategory } from "../src/features/realTrading/lib/marketCategory";
import {
  buildRealTradingCategoryMap,
  buildRealTradingIconUrl,
  normalizeBookSide,
  normalizeFees,
  normalizeFill,
  normalizeHistoricalOrder,
  normalizeMarketSummary,
  normalizeRealTradingMarketCategory,
  normalizeOpenOrder,
  normalizePositions,
  normalizeSymbolMarginCapabilities,
  normalizeSpotBalances,
  resolveRealTradingSymbolCategory,
} from "../server/modules/hyperliquid/HyperliquidInfoClient";

const summary = normalizeMarketSummary("BTCUSDT", "BTC", {
  markPx: "105",
  oraclePx: "104",
  midPx: "104.5",
  prevDayPx: "100",
  dayNtlVlm: "12345.67",
  openInterest: "9.5",
  funding: "0.0001",
});
assert.equal(summary.previousDayPrice, 100);
assert.equal(summary.dayChange, 5);
assert.equal(summary.dayChangePercent, 5);

const invalidSummary = normalizeMarketSummary("BTCUSDT", "BTC", { markPx: "bad", prevDayPx: "0" });
assert.equal(invalidSummary.markPrice, null);
assert.equal(invalidSummary.dayChange, null);
assert.equal(invalidSummary.dayChangePercent, null);

const demoSummary = normalizeDemoMarketSummary("BTCUSDT", {
  markPx: "105",
  oraclePx: "104",
  midPx: "104.5",
  prevDayPx: "100",
  dayNtlVlm: "888",
  openInterest: "12",
  funding: "0.0002",
  nextFundingTime: 12345,
});
assert.equal(demoSummary.markPrice, 105);
assert.equal(demoSummary.dayChange, 5);
assert.equal(demoSummary.dayChangePercent, 5);
assert.equal(demoSummary.status, "connected");

const invalidDemoSummary = normalizeDemoMarketSummary("BTCUSDT", { markPx: "", prevDayPx: "0" });
assert.equal(invalidDemoSummary.markPrice, null);
assert.equal(invalidDemoSummary.status, "unavailable");

assert.equal(buildRealTradingIconUrl("BTC"), "https://app.hyperliquid-testnet.xyz/coins/BTC.svg");
assert.equal(buildRealTradingIconUrl("xyz:GOLD"), "https://app.hyperliquid-testnet.xyz/coins/xyz:GOLD.svg");
assert.equal(buildRealTradingIconUrl("xyz:AAPL"), "https://app.hyperliquid-testnet.xyz/coins/xyz:AAPL.svg");
assert.equal(buildRealTradingIconUrl("bad coin"), null);
assert.equal(buildDemoMarketIconUrl("BTC"), "https://app.hyperliquid.xyz/coins/BTC.svg");
assert.equal(buildDemoMarketIconUrl("xyz:GOLD"), "https://app.hyperliquid.xyz/coins/xyz:GOLD.svg");
assert.equal(buildDemoMarketIconUrl("xyz:AAPL"), "https://app.hyperliquid.xyz/coins/xyz:AAPL.svg");
assert.equal(buildDemoMarketIconUrl("bad coin"), null);
assert.equal(resolveRealTradingSymbolCategory("BTC"), "crypto");
assert.equal(normalizeRealTradingMarketCategory("stocks", "xyz:AAPL"), "us_equities");
assert.equal(normalizeRealTradingMarketCategory("equities", "xyz:TSLA"), "us_equities");
assert.equal(normalizeRealTradingMarketCategory("indices", "xyz:SP500"), "indices");
assert.equal(normalizeRealTradingMarketCategory("commodities", "xyz:GOLD"), "metals");
assert.equal(normalizeRealTradingMarketCategory(null, "xyz:SILVER"), "metals");
assert.equal(normalizeRealTradingMarketCategory("commodities", "xyz:OIL"), "other");
assert.equal(resolveRealTradingSymbolCategory("xyz:UNKNOWN"), "other");
const categoryMap = buildRealTradingCategoryMap(
  [["xyz:AAPL", "stocks"], ["xyz:GOLD", { category: "commodities", displayName: "Gold" }]],
  [["xyz:SP500", { category: "indices" }], ["xyz:UNKNOWN", { category: "mystery" }]],
);
assert.equal(resolveRealTradingSymbolCategory("xyz:AAPL", categoryMap), "us_equities");
assert.equal(resolveRealTradingSymbolCategory("xyz:GOLD", categoryMap), "metals");
assert.equal(resolveRealTradingSymbolCategory("xyz:SP500", categoryMap), "indices");
assert.equal(resolveRealTradingSymbolCategory("xyz:UNKNOWN", categoryMap), "other");
assert.equal(resolveRealTradingCategory("BTC"), "crypto");
assert.equal(resolveRealTradingCategory("xyz:GOLD"), "metals");
assert.equal(resolveRealTradingCategory("xyz:SP500"), "indices");
assert.equal(resolveRealTradingCategory("nq:TEST"), "other");
assert.equal(resolveRealTradingCategory("flx:TSLA", "us_equities"), "us_equities");

const book = normalizeBookSide([
  { px: "101", sz: "2", n: 1 },
  { px: "100", sz: "3", n: 2 },
  { px: "bad", sz: "9" },
], "asc");
assert.deepEqual(book.map((level) => [level.price, level.size, level.cumulativeSize, level.total]), [
  [100, 3, 3, 3],
  [101, 2, 5, 5],
]);

const demoBook = normalizeDemoBookSide([
  { px: "101", sz: "2", n: 1 },
  { px: "100", sz: "3", n: 2 },
  { px: "bad", sz: "9" },
], "desc");
assert.deepEqual(demoBook.map((level) => [level.price, level.size, level.cumulativeSize, level.total]), [
  [101, 2, 2, 2],
  [100, 3, 5, 5],
]);

const demoTrade = normalizeDemoTrade({ px: "100001", sz: "0.01", side: "B", time: 789, tid: 12, hash: "0xabc" }, "BTCUSDT");
assert.equal(demoTrade?.price, 100001);
assert.equal(demoTrade?.size, 0.01);
assert.equal(demoTrade?.side, "buy");
assert.equal(demoTrade?.timestamp, 789);
assert.equal(demoTrade?.tradeId, "12");
assert.equal(demoTrade?.txHash, "0xabc");
assert.equal(normalizeDemoTrade({ px: "bad", sz: "0.01", time: 789 }, "BTCUSDT"), null);

assert.deepEqual(normalizeSymbolMarginCapabilities({}).supportedMarginModes, ["cross", "isolated"]);
assert.equal(normalizeSymbolMarginCapabilities({}).marginModeConstraint, "cross_and_isolated");
assert.deepEqual(normalizeSymbolMarginCapabilities({ marginMode: "strictIsolated" }).supportedMarginModes, ["isolated"]);
assert.equal(normalizeSymbolMarginCapabilities({ marginMode: "strictIsolated" }).marginModeConstraint, "isolated_only");
assert.deepEqual(normalizeSymbolMarginCapabilities({ marginMode: "noCross" }).supportedMarginModes, ["isolated"]);
assert.equal(normalizeSymbolMarginCapabilities({ marginMode: "noCross" }).marginModeConstraint, "isolated_only");
assert.deepEqual(normalizeSymbolMarginCapabilities({ onlyIsolated: true }).supportedMarginModes, ["isolated"]);
assert.equal(normalizeSymbolMarginCapabilities({ onlyIsolated: true }).marginModeConstraint, "isolated_only");

const positions = normalizePositions([
  {
    position: {
      coin: "ETH",
      szi: "-0.5",
      entryPx: "3000",
      markPx: "2950",
      liquidationPx: "3500",
      marginUsed: "150",
      positionValue: "1475",
      returnOnEquity: "-0.1",
      leverage: { type: "isolated", value: 10 },
      maxLeverage: 20,
      unrealizedPnl: "-25",
      cumFunding: { allTime: "1.2", sinceChange: "0.3", sinceOpen: "0.2" },
      type: "legacy-type-should-not-be-status",
      status: "open",
    },
  },
  { position: { coin: "BTC", szi: "0" } },
]);
assert.equal(positions.length, 1);
assert.equal(positions[0].side, "short");
assert.equal(positions[0].entryPx, 3000);
assert.equal(positions[0].entryPrice, 3000);
assert.equal(positions[0].markPx, 2950);
assert.equal(positions[0].markPrice, 2950);
assert.equal(positions[0].liqPx, 3500);
assert.equal(positions[0].liquidationPrice, 3500);
assert.equal(positions[0].positionValue, 1475);
assert.equal(positions[0].returnOnEquity, -0.1);
assert.equal(positions[0].marginMode, "isolated");
assert.equal(positions[0].leverage, 10);
assert.equal(positions[0].maxLeverage, 20);
assert.equal(positions[0].rawStatus, "open");
assert.equal(positions[0].fundingSinceOpen, 0.2);

const fallbackPositions = normalizePositions([
  {
    position: {
      coin: "BTC",
      szi: "0.002",
      entryPx: "60000",
      markPx: "0",
      positionValue: "120",
      leverage: { type: "cross", value: 5 },
    },
  },
  {
    position: {
      coin: "ETH",
      szi: "-0.5",
      entryPx: "3000",
      markPx: "2950",
    },
  },
  {
    position: {
      coin: "SOL",
      szi: "2",
      markPx: "-1",
      leverage: { type: "portfolio", value: "bad" },
    },
  },
  {
    position: {
      coin: "DOGE",
      szi: "100",
      markPx: "not-a-number",
    },
  },
], new Map([
  ["BTC", { markPx: "68123.5" }],
  ["ETH", { markPx: "2400" }],
  ["DOGE", { markPx: "also-bad" }],
]));
assert.equal(fallbackPositions.length, 4);
assert.equal(fallbackPositions.find((position) => position.coin === "BTC")?.markPx, 68123.5);
assert.equal(fallbackPositions.find((position) => position.coin === "BTC")?.markPrice, 68123.5);
assert.equal(fallbackPositions.find((position) => position.coin === "BTC")?.marginMode, "cross");
assert.equal(fallbackPositions.find((position) => position.coin === "ETH")?.markPx, 2950);
assert.equal(fallbackPositions.find((position) => position.coin === "SOL")?.markPx, null);
assert.equal(fallbackPositions.find((position) => position.coin === "SOL")?.marginMode, null);
assert.equal(fallbackPositions.find((position) => position.coin === "SOL")?.leverage, null);
assert.equal(fallbackPositions.find((position) => position.coin === "DOGE")?.markPx, null);

const order = normalizeOpenOrder({
  coin: "BTC",
  side: "B",
  limitPx: "100000",
  sz: "0.01",
  timestamp: 123,
  oid: 7,
  reduceOnly: true,
  isPositionTpsl: false,
  isTrigger: true,
  orderType: "Take Profit Market",
  origSz: "0.02",
  triggerCondition: "Price above",
  triggerPx: "110000",
});
assert.equal(order.price, 100000);
assert.equal(order.size, 0.01);
assert.equal(order.limitPx, 100000);
assert.equal(order.sz, 0.01);
assert.equal(order.isTrigger, true);
assert.equal(order.triggerPx, 110000);

const historical = normalizeHistoricalOrder({
  status: "filled",
  statusTimestamp: 456,
  order: { coin: "BTC", side: "A", limitPx: "99999", sz: "0.02" },
});
assert.equal(historical.status, "filled");
assert.equal(historical.statusTimestamp, 456);
assert.equal(historical.price, 99999);
assert.equal(historical.size, 0.02);

const fill = normalizeFill({
  coin: "BTC",
  side: "B",
  px: "100001",
  sz: "0.01",
  time: 789,
  fee: "0.4",
  feeToken: "USDC",
  hash: "0xabc",
  dir: "Open Long",
});
assert.equal(fill.price, 100001);
assert.equal(fill.size, 0.01);
assert.equal(fill.fee, 0.4);
assert.equal(fill.feeToken, "USDC");
assert.equal(fill.hash, "0xabc");
assert.equal(fill.direction, "Open Long");

const balances = normalizeSpotBalances({ balances: [{ coin: "USDC", total: "500", hold: "25" }, { coin: "BAD", total: "x", hold: "1" }] });
assert.deepEqual(balances[0], { coin: "USDC", total: 500, hold: 25, available: 475 });
assert.equal(balances[1].total, null);
assert.equal(balances[1].available, null);

const fees = normalizeFees({
  userAddRate: "0.0001",
  userCrossRate: "0.0004",
  spotAddRate: "0.0002",
  spotCrossRate: "0.0005",
  activeReferralDiscount: "0.04",
  activeStakingDiscount: "0.01",
});
assert.equal(fees.makerRate, 0.0001);
assert.equal(fees.takerRate, 0.0004);
assert.equal(fees.spotMakerRate, 0.0002);
assert.equal(fees.spotTakerRate, 0.0005);

console.log("real trading normalizers smoke passed");
