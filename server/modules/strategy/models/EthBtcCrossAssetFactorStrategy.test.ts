import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { EthBtcCrossAssetFactorStrategy } from "./EthBtcCrossAssetFactorStrategy";

test("cross-asset factor uses only completed BTC and ETH history", () => {
  const eth = makeCandles("ETHUSDT", 2_000, 1.2);
  const btc = makeCandles("BTCUSDT", 60_000, 8);
  const strategy = makeStrategy(btc);
  strategy.prepare(eth);
  const index = findSignal(strategy, eth);
  assert.ok(index > strategy.warmupBars);
  const original = strategy.evaluate({ candles: eth, index, equity: 10_000 });
  strategy.release();
  const changedEth = mutateFuture(eth, index);
  const changedBtc = mutateFuture(btc, index);
  const replay = makeStrategy(changedBtc);
  replay.prepare(changedEth);
  assert.deepEqual(replay.evaluate({ candles: changedEth, index, equity: 10_000 }), original);
  replay.release();
});

function makeStrategy(btc: Candle[]) {
  return new EthBtcCrossAssetFactorStrategy({
    symbol: "ETHUSDT",
    family: "btc_lead_lag",
    threshold: 0.75,
    stopAtr: 0.75,
    rewardRisk: 2,
    session: "all",
    riskFraction: 0.0025,
    maximumHoldingBars: 36,
    cooldownFactorBars: 8,
  }, btc);
}
function findSignal(strategy: EthBtcCrossAssetFactorStrategy, eth: Candle[]) {
  for (let index = strategy.warmupBars; index < eth.length; index += 1) {
    if (strategy.evaluate({ candles: eth, index, equity: 10_000 })) return index;
  }
  return -1;
}

function makeCandles(symbol: "ETHUSDT" | "BTCUSDT", initial: number, lateChange: number) {
  const result: Candle[] = [];
  let close = initial;
  for (let index = 0; index < 1_200; index += 1) {
    const change = index < 990 ? Math.sin(index / 19) * initial * 0.00005 : lateChange + (index - 990) * lateChange * 0.002;
    const open = close;
    close += change;
    result.push({
      symbol,
      interval: "5m",
      time: Date.parse("2026-01-05T00:00:00Z") / 1000 + index * 300,
      open,
      high: Math.max(open, close) + Math.abs(lateChange) * 0.2,
      low: Math.min(open, close) - Math.abs(lateChange) * 0.2,
      close,
      volume: 100 + index % 17,
    });
  }
  return result;
}

function mutateFuture(candles: Candle[], index: number) {
  return candles.map((candle, cursor) => cursor <= index ? candle : {
    ...candle,
    open: candle.open * 3,
    high: candle.high * 3,
    low: candle.low * 3,
    close: candle.close * 3,
    volume: 9_999_999,
  });
}
