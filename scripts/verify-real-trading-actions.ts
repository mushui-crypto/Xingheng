import assert from "node:assert/strict";
import type { RealPosition, RealTradingSymbol } from "../src/api/realTrading";
import { submitPositionCloseRequest, submitPositionTpslRequest } from "../src/features/realTrading/lib/positionActions";
import {
  buildEntryTpslOrderRequest,
  buildPositionTpslOrderRequest,
  buildUpdateLeverageRequest,
  normalizeSdkError,
  submitMarginLeverageUpdate,
  type HyperliquidLimitOrderInput,
  type HyperliquidSessionSigner,
  type HyperliquidTriggerOrderInput,
} from "../src/features/realTrading/lib/hyperliquidSdk";
import { buildPositionTpslOrders } from "../src/features/realTrading/lib/tpslOrders";
import { enrichPositionMarks } from "../src/features/realTrading/lib/enrichPositionMarks";
import { mergeTradingSearchParams } from "../src/features/trading/lib/tradingSearchParams";
import { resolveMarginLeverageSelection } from "../src/features/realTrading/model/marginLeverage";

const symbol: RealTradingSymbol = { assetId: 0, providerCoin: "BTC", symbol: "BTCUSDT", szDecimals: 5 };
const longPosition: RealPosition = { coin: "BTC", markPx: 60_000, side: "long", size: 0.01, symbol: "BTCUSDT" };
const submitted: HyperliquidLimitOrderInput[][] = [];
const submittedTriggers: HyperliquidTriggerOrderInput[][] = [];
const signer = {
  async placeOrder(input: HyperliquidLimitOrderInput) {
    submitted.push([input]);
  },
  async placeOrders(inputs: HyperliquidLimitOrderInput[]) {
    submitted.push(inputs);
  },
  async placePositionTpsl(inputs: HyperliquidTriggerOrderInput[]) {
    submittedTriggers.push(inputs);
  },
} as unknown as HyperliquidSessionSigner;

await submitPositionCloseRequest(signer, { mode: "market", positions: [longPosition], scope: "single" }, [symbol]);
assert.equal(submitted[0][0].isBuy, false);
assert.equal(submitted[0][0].reduceOnly, true);
assert.equal(submitted[0][0].market, true);
assert.equal(submitted[0][0].size, "0.01");

await submitPositionCloseRequest(signer, { limitPrice: "59900", mode: "limit", positions: [longPosition], scope: "single" }, [symbol]);
assert.equal(submitted[1][0].price, "59900");
assert.equal(submitted[1][0].market, false);

const longTriggers = buildPositionTpslOrders({
  asset: 0,
  closingIsBuy: false,
  referencePrice: 60_000,
  size: "0.01",
  slPrice: "59000",
  szDecimals: 5,
  tpPrice: "62000",
});
assert.deepEqual(longTriggers.map((order) => order.tpsl), ["tp", "sl"]);
assert.ok(longTriggers.every((order) => order.isBuy === false));
assert.equal(longTriggers[0].triggerPrice, "62000");
assert.equal(longTriggers[1].triggerPrice, "59000");

const longEntryTpslRequest = buildEntryTpslOrderRequest({
  asset: 0,
  isBuy: true,
  market: false,
  price: "60000",
  reduceOnly: false,
  size: "0.01",
}, longTriggers);
assertEntryTpslRequest(longEntryTpslRequest, { childIsBuy: false, parentIsBuy: true, parentTif: "Gtc", tpsl: ["tp", "sl"] });

const shortTpOnly = buildPositionTpslOrders({
  asset: 0,
  closingIsBuy: true,
  referencePrice: 60_000,
  size: "0.01",
  szDecimals: 5,
  tpPrice: "58000",
});
const shortEntryTpRequest = buildEntryTpslOrderRequest({
  asset: 0,
  isBuy: false,
  market: true,
  price: "59400",
  reduceOnly: false,
  size: "0.01",
}, shortTpOnly);
assertEntryTpslRequest(shortEntryTpRequest, { childIsBuy: true, parentIsBuy: false, parentTif: "Ioc", tpsl: ["tp"] });

const longSlOnly = buildPositionTpslOrders({
  asset: 0,
  closingIsBuy: false,
  referencePrice: 60_000,
  size: "0.01",
  slPrice: "59000",
  szDecimals: 5,
});
const longEntrySlRequest = buildEntryTpslOrderRequest({
  asset: 0,
  isBuy: true,
  market: false,
  price: "60000",
  reduceOnly: false,
  size: "0.01",
}, longSlOnly);
assertEntryTpslRequest(longEntrySlRequest, { childIsBuy: false, parentIsBuy: true, parentTif: "Gtc", tpsl: ["sl"] });

const positionTpslRequest = buildPositionTpslOrderRequest(longTriggers);
assert.equal(positionTpslRequest.grouping, "positionTpsl");
assert.ok(positionTpslRequest.orders.every((order) => "trigger" in order.t && order.r));

assert.throws(() => buildPositionTpslOrders({
  asset: 0,
  closingIsBuy: false,
  referencePrice: 60_000,
  size: "0.01",
  szDecimals: 5,
  tpPrice: "59000",
}), /多仓止盈价必须高于参考价格/);

const requestedSymbols: string[] = [];
const enrichedPositions = await enrichPositionMarks([
  { coin: "BTC", markPx: null, side: "long", size: 0.01, symbol: "BTCUSDT" },
  { coin: "BTC", markPrice: null, side: "long", size: 0.02, symbol: "BTCUSDT" },
  { coin: "ETH", markPx: 3_000, side: "short", size: 0.1, symbol: "ETHUSDT" },
], async (requestedSymbol) => {
  requestedSymbols.push(requestedSymbol);
  return {
    markPrice: requestedSymbol === "BTCUSDT" ? 62_848 : 1,
    network: "hyperliquid-testnet",
    status: "connected",
    symbol: requestedSymbol,
    timestamp: Date.now(),
  };
});
assert.deepEqual(requestedSymbols, ["BTCUSDT"]);
assert.equal(enrichedPositions[0].markPx, 62_848);
assert.equal(enrichedPositions[0].markPrice, 62_848);
assert.equal(enrichedPositions[1].markPx, 62_848);
assert.equal(enrichedPositions[2].markPx, 3_000);

await submitPositionCloseRequest(signer, { mode: "market", positions: [enrichedPositions[0]], scope: "single" }, [symbol]);
assert.equal(submitted.at(-1)?.[0].price, "62219");
await submitPositionTpslRequest(signer, {
  position: enrichedPositions[0],
  slPrice: "60000",
  tpPrice: "70000",
}, [symbol]);
assert.deepEqual(submittedTriggers[0].map((order) => order.triggerPrice), ["70000", "60000"]);

const mergedParams = mergeTradingSearchParams(
  new URLSearchParams("symbol=BTCUSDT&source=acceptance"),
  "ETHUSDT",
  "demo-account",
);
assert.equal(mergedParams.get("symbol"), "ETHUSDT");
assert.equal(mergedParams.get("simulationAccountId"), "demo-account");
assert.equal(mergedParams.get("source"), "acceptance");

assert.equal(
  normalizeSdkError(new Error("Failed to sign the typed data using the wallet")),
  "用户拒绝了本地签名。",
);
assert.equal(
  normalizeSdkError(new Error("order 0: Trigger order has unexpected type.")),
  "TP/SL 订单组合被 Hyperliquid 拒绝：order 0: Trigger order has unexpected type.",
);

assert.deepEqual(buildUpdateLeverageRequest(0, 1, "cross"), { asset: 0, isCross: true, leverage: 1 });
assert.deepEqual(buildUpdateLeverageRequest(1, 20, "isolated"), { asset: 1, isCross: false, leverage: 20 });

let leverageUpdateCount = 0;
let lastLeverageUpdate: unknown[] = [];
const leverageSigner = {
  async updateLeverage(...args: unknown[]) {
    leverageUpdateCount += 1;
    lastLeverageUpdate = args;
  },
};
await submitMarginLeverageUpdate(leverageSigner, 0, 20, "isolated");
assert.equal(leverageUpdateCount, 1);
assert.deepEqual(lastLeverageUpdate, [0, 20, "isolated"]);

const defaultMarginSelection = resolveMarginLeverageSelection({ maxLeverage: 20 });
assert.equal(defaultMarginSelection.marginMode, "cross");
assert.equal(defaultMarginSelection.leverage, 5);
assert.deepEqual(defaultMarginSelection.supportedMarginModes, ["cross", "isolated"]);

const isolatedOnlySelection = resolveMarginLeverageSelection({
  marginModeConstraint: "isolated_only",
  maxLeverage: 3,
  sessionSelection: { leverage: 20, marginMode: "cross" },
  supportedMarginModes: ["isolated"],
});
assert.equal(isolatedOnlySelection.marginMode, "isolated");
assert.equal(isolatedOnlySelection.leverage, 3);

const positionMarginSelection = resolveMarginLeverageSelection({
  maxLeverage: 50,
  position: { coin: "BTC", leverage: 8, marginMode: "isolated", maxLeverage: 10, side: "long", size: 0.01 },
  sessionSelection: { leverage: 2, marginMode: "cross" },
});
assert.equal(positionMarginSelection.marginMode, "isolated");
assert.equal(positionMarginSelection.leverage, 8);
assert.equal(positionMarginSelection.maxLeverage, 10);

const symbolASelection = resolveMarginLeverageSelection({
  maxLeverage: 20,
  sessionSelection: { leverage: 15, marginMode: "isolated" },
});
const symbolBSelection = resolveMarginLeverageSelection({
  maxLeverage: 3,
  sessionSelection: { leverage: 9, marginMode: "cross" },
});
assert.deepEqual([symbolASelection.leverage, symbolASelection.marginMode], [15, "isolated"]);
assert.deepEqual([symbolBSelection.leverage, symbolBSelection.marginMode], [3, "cross"]);

console.log("real trading actions smoke passed");

function assertEntryTpslRequest(
  request: ReturnType<typeof buildEntryTpslOrderRequest>,
  expected: {
    childIsBuy: boolean;
    parentIsBuy: boolean;
    parentTif: "Gtc" | "Ioc";
    tpsl: Array<"tp" | "sl">;
  },
) {
  assert.equal(request.grouping, "normalTpsl");
  const [parent, ...children] = request.orders;
  assert.ok("limit" in parent.t);
  if (!("limit" in parent.t)) throw new Error("entry parent must be a limit/IOC order");
  assert.equal(parent.b, expected.parentIsBuy);
  assert.equal(parent.r, false);
  assert.equal(parent.t.limit.tif, expected.parentTif);
  assert.equal(children.length, expected.tpsl.length);
  assert.ok(children.every((order) => order.b === expected.childIsBuy));
  assert.ok(children.every((order) => order.r));
  assert.ok(children.every((order) => order.s === parent.s));
  assert.deepEqual(children.map((order) => "trigger" in order.t ? order.t.trigger.tpsl : null), expected.tpsl);
  assert.ok(children.every((order) => "trigger" in order.t && order.t.trigger.isMarket));
}
