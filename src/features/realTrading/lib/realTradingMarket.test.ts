import assert from "node:assert/strict";
import test from "node:test";
import type { RealTradingSymbol } from "../../../api/realTrading";
import { resolveRealTradingNavigationSymbol } from "./realTradingMarket";

const symbols: RealTradingSymbol[] = [
  { assetId: 0, providerCoin: "BTC", symbol: "BTCUSDT" },
  { assetId: 1, providerCoin: "ETH", symbol: "ETHUSDT" },
];

test("only positions mapped to the current real-trading catalog can navigate markets", () => {
  assert.equal(
    resolveRealTradingNavigationSymbol({ coin: "ETH", symbol: "ETHUSDT" }, symbols),
    "ETHUSDT",
  );
  assert.equal(
    resolveRealTradingNavigationSymbol({ coin: "UNKNOWN", symbol: "UNKNOWNUSDT" }, symbols),
    null,
  );
});
