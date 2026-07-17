import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  buildMartingaleGridPaperReport,
  MARTINGALE_GRID_CONFIG,
  MARTINGALE_GRID_ROUTE_ID,
  simulateMartingaleGridSymbol,
  type MartingaleGridConfig,
} from "./MartingaleGridPaperEngine";

const compactConfig: MartingaleGridConfig = {
  ...MARTINGALE_GRID_CONFIG,
  initialEquityPerSymbol: 5_000,
  leverageSelection: 5,
  baseMarginFraction: 0.005,
  sizeMultiplier: 1.35,
  maximumLayers: 3,
  atrPeriod: 2,
  rsiPeriod: 2,
  fastEmaPeriod15m: 2,
  slowEmaPeriod15m: 4,
  longRsiThreshold: 40,
  shortRsiThreshold: 60,
  gridAtrMultiple: 0.5,
  minimumGridFraction: 0.01,
  targetAtrMultiple: 0.25,
  minimumTargetFraction: 0.005,
  stopBeyondLastGridSteps: 2,
  maximumGroupLossFraction: 0.015,
  maximumHoldingMinutes: 1_440,
};

test("martingale grid uses adverse-first same-candle ordering and caps layer count", () => {
  const candles = makeLongSetupCandles(true);
  const result = simulateMartingaleGridSymbol("BTCUSDT", candles, { forwardStart: candles[0].time, config: compactConfig });
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].exitReason, "take_profit");
  assert.equal(result.completed[0].fills.length, 3);
  assert.ok(result.completed[0].netPnl > 0);
  assert.equal(result.open, null);
});

test("martingale grid planned loss stays inside the configured group safety cap", () => {
  const candles = makeLongSetupCandles(false);
  const result = simulateMartingaleGridSymbol("BTCUSDT", candles, { forwardStart: candles[0].time, config: compactConfig });
  assert.ok(result.open);
  assert.ok(result.open!.plannedRisk <= compactConfig.initialEquityPerSymbol * compactConfig.maximumGroupLossFraction + 0.01);
  assert.equal(result.open!.fills.length, 1);
});

test("paper report fixes exchange-order capability off and keeps symbols isolated", () => {
  const btc = makeLongSetupCandles(false);
  const eth = btc.map((candle) => ({ ...candle, symbol: "ETHUSDT", open: candle.open / 10, high: candle.high / 10, low: candle.low / 10, close: candle.close / 10 }));
  const report = buildMartingaleGridPaperReport({ BTCUSDT: btc, ETHUSDT: eth }, { forwardStart: btc[0].time, config: compactConfig });
  assert.equal(report.routeId, MARTINGALE_GRID_ROUTE_ID);
  assert.equal(report.assumptions.automaticOrdersEnabled, false);
  assert.equal(report.assumptions.exchangeCredentialsRequired, false);
  assert.equal(report.configuration.oneGroupPerSymbol, true);
  assert.equal(report.metrics.initialEquity, 10_000);
});

test("15m entry mode confirms only a completed 15m signal and enters on the next 5m open", () => {
  const start = 1_780_000_000 - (1_780_000_000 % 900);
  const fifteenMinuteCloses = [100, 101, 102, 103, 104, 105, 106, 150, 140, 141];
  const candles = fifteenMinuteCloses.flatMap((close, bucket) => Array.from({ length: 3 }, (_, offset) => ({
    symbol: "BTCUSDT",
    interval: "5m" as const,
    time: start + bucket * 900 + offset * 300,
    open: close,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 10,
  })));
  const config = { ...compactConfig, longRsiThreshold: 90 };
  const result = simulateMartingaleGridSymbol("BTCUSDT", candles, {
    forwardStart: start,
    config,
    signalIntervalMinutes: 15,
  });

  assert.equal(result.diagnostics.signals, 1);
  assert.equal(result.diagnostics.startedGroups, 1);
  assert.ok(result.open);
  assert.equal(result.open!.signalTime % 900, 600);
  assert.equal(result.open!.entryTime, result.open!.signalTime + 300);
  assert.equal(result.open!.entryTime % 900, 0);
});

function makeLongSetupCandles(exitOnEntryCandle: boolean): Candle[] {
  const start = 1_780_000_000 - (1_780_000_000 % 300);
  const closes = Array.from({ length: 30 }, (_, index) => 100 + index)
    .concat([128, 127, 127]);
  return closes.map((close, index) => {
    const previous = closes[index - 1] ?? close;
    const open = previous;
    const isEntryCandle = index === closes.length - 1;
    return {
      symbol: "BTCUSDT",
      interval: "5m",
      time: start + index * 300,
      open,
      high: isEntryCandle && exitOnEntryCandle ? 130 : Math.max(open, close) + 0.2,
      low: isEntryCandle && exitOnEntryCandle ? 124 : Math.min(open, close) - 0.2,
      close,
      volume: 10,
    };
  });
}
