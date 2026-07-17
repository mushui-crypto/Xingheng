import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { EthOrderFlowStructureStrategy } from "./EthOrderFlowStructureStrategy";

test("order-flow structure signal uses only closed history and emits an actual-fill 2R target", () => {
  const signalIndex = 905;
  const original = fixtureCandles(912, signalIndex);
  const mutatedFuture = original.map((candle, index) => index <= signalIndex ? { ...candle } : {
    ...candle,
    open: 9_000,
    high: 9_500,
    low: 8_500,
    close: 9_200,
    volume: 1_000_000,
    quoteVolume: 9_000_000_000,
    tradeCount: 1_000_000,
    takerBuyBaseVolume: 1_000_000,
    takerBuyQuoteVolume: 9_000_000_000,
  });
  const config = {
    symbol: "ETHUSDT" as const,
    family: "taker_imbalance_continuation" as const,
    threshold: 0.75 as const,
    structureLookbackBars: 6 as const,
    riskFraction: 0.0025,
  };
  const first = new EthOrderFlowStructureStrategy(config).evaluate({ candles: original, index: signalIndex, equity: 10_000 });
  const second = new EthOrderFlowStructureStrategy(config).evaluate({ candles: mutatedFuture, index: signalIndex, equity: 10_000 });
  assert.ok(first, "fixture should produce a preregistered continuation signal");
  assert.deepEqual(second, first);
  assert.equal(first.targetRewardRisk, 2);
  assert.equal(first.entryOrderType, "market");
  assert.ok(Number(first.evidence.stopAtr) >= 0.5);
  assert.ok(Number(first.evidence.stopAtr) <= 2);
});

test("order-flow research fails closed when Binance microstructure fields are absent", () => {
  const candles = fixtureCandles(912, 905).map(({ quoteVolume: _quote, tradeCount: _trades, takerBuyBaseVolume: _base, takerBuyQuoteVolume: _quoteBuy, ...candle }) => candle);
  const strategy = new EthOrderFlowStructureStrategy({
    symbol: "ETHUSDT",
    family: "taker_imbalance_continuation",
    threshold: 0.75,
    structureLookbackBars: 6,
    riskFraction: 0.0025,
  });
  assert.throws(
    () => strategy.evaluate({ candles, index: 905, equity: 10_000 }),
    /missing Binance kline fields/,
  );
});

function fixtureCandles(count: number, signalIndex: number): Candle[] {
  const signalTime = Date.parse("2026-07-16T15:55:00Z") / 1000;
  const start = signalTime - signalIndex * 300;
  return Array.from({ length: count }, (_, index) => {
    const event = index >= signalIndex - 2 && index <= signalIndex;
    const open = 1_000 + index * 0.0005 + (event ? (index - (signalIndex - 2)) * 0.6 : 0);
    const close = open + (event ? 0.6 : 0.02);
    const volume = event ? 300 : 100 + index % 7;
    const takerBuyBaseVolume = event ? volume * 0.97 : volume * (0.48 + (index % 5) * 0.01);
    const quoteVolume = volume * ((open + close) / 2);
    return {
      symbol: "ETHUSDT",
      interval: "5m",
      time: start + index * 300,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume,
      quoteVolume,
      tradeCount: event ? 500 : 100 + index % 11,
      takerBuyBaseVolume,
      takerBuyQuoteVolume: quoteVolume * (takerBuyBaseVolume / volume),
    };
  });
}
