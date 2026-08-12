import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("legacy Binance strategy controls are absent", () => {
  const component = readFileSync(new URL("./BinanceTradingWorkbench.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../../api/binancePersonalTrading.ts", import.meta.url), "utf8");

  assert.doesNotMatch(component, /enterBinanceStrategy|exitBinanceStrategy|fetchBinanceStrategy|StrategySection/u);
  assert.doesNotMatch(api, /\/api\/binance\/strategy|BinanceStrategyStatus/u);
  assert.doesNotMatch(component, /reconcileBinance|执行对账/u);
  assert.doesNotMatch(api, /\/api\/binance\/reconciliation|BinanceReconciliation/u);
});

test("Binance workbench keeps account, market, and order load failures visible", () => {
  const component = readFileSync(new URL("./BinanceTradingWorkbench.tsx", import.meta.url), "utf8");

  assert.match(component, /fetchBinanceAccount/u);
  assert.match(component, /fetchBinanceMarket/u);
  assert.match(component, /fetchBinanceOrders/u);
  assert.match(component, /Account snapshot query failed/u);
  assert.match(component, /Market query failed/u);
  assert.match(component, /Orders query failed/u);
});
