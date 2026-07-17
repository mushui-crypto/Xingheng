import {
  BinanceVisionHistoricalDataSource,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { BacktestEngine } from "../server/modules/strategy/backtest/BacktestEngine";
import type { StrategyEvaluationContext, StrategySignal } from "../server/modules/strategy/core/types";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5, ictResearchCandidateV5Backtest } from "../server/modules/strategy/models/ictResearchCandidate";

const source = new BinanceVisionHistoricalDataSource();
const loaded = await source.loadMonths(monthRange("2024-01", "2025-12"));
const candles = loaded.candles;
const strategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
strategy.prepare(candles);
const rawSignals: StrategySignal[] = [];
for (let index = strategy.warmupBars; index < candles.length; index += 1) {
  const signal = strategy.evaluate({ candles, index, equity: 10_000 } satisfies StrategyEvaluationContext);
  if (signal) rawSignals.push(signal);
}
strategy.release();

const executed = new BacktestEngine(
  new IctLiquidityReversalStrategy(ictResearchCandidateV5),
  ictResearchCandidateV5Backtest,
).run(candles);
const executedIds = new Set(executed.trades.map((trade) => trade.signalId));
const missed = rawSignals.filter((signal) => !executedIds.has(signal.id));
const candleIndexByTime = new Map(candles.map((candle, index) => [candle.time, index]));

const details = missed.map((signal) => {
  const occupying = executed.trades.find((trade) => signal.createdAt >= trade.entryTime && signal.createdAt <= trade.exitTime);
  const signalIndex = candleIndexByTime.get(signal.createdAt) ?? -1;
  const exitIndex = occupying ? (candleIndexByTime.get(occupying.exitTime) ?? -1) : -1;
  const expiryTime = signal.createdAt + 6 * 5 * 60;
  const sliceEnd = Math.min(candles.length - 1, signalIndex + 6);
  const signalCandle = candles[signalIndex];
  const pullbackPrice = signal.side === "long"
    ? signalCandle.close - 0.25 * (signalCandle.close - signalCandle.low)
    : signalCandle.close + 0.25 * (signalCandle.high - signalCandle.close);
  let stopTouchedBeforeExit = false;
  let pullbackTouchedBeforeExit = false;
  let pullbackTouchedAfterExit = false;
  for (let index = signalIndex + 1; index <= sliceEnd; index += 1) {
    const candle = candles[index];
    const beforeOrAtExit = exitIndex >= 0 && index <= exitIndex;
    const stopTouched = signal.side === "long" ? candle.low <= signal.stopPrice : candle.high >= signal.stopPrice;
    const pullbackTouched = signal.side === "long" ? candle.low <= pullbackPrice : candle.high >= pullbackPrice;
    if (beforeOrAtExit && stopTouched) stopTouchedBeforeExit = true;
    if (beforeOrAtExit && pullbackTouched) pullbackTouchedBeforeExit = true;
    if (!beforeOrAtExit && pullbackTouched && candle.time <= expiryTime) pullbackTouchedAfterExit = true;
  }
  const exitsWithinExpiry = Boolean(occupying && occupying.exitTime < expiryTime);
  return {
    signalTime: signal.createdAt,
    side: signal.side,
    occupyingSide: occupying?.side ?? null,
    occupyingExitTime: occupying?.exitTime ?? null,
    sameSideAsOccupying: occupying ? occupying.side === signal.side : null,
    exitsWithinExpiry,
    stopTouchedBeforeExit,
    pullbackTouchedBeforeExit,
    pullbackTouchedAfterExit,
    deferred25x6Feasible: exitsWithinExpiry && !stopTouchedBeforeExit && !pullbackTouchedBeforeExit && pullbackTouchedAfterExit,
  };
});

console.log(JSON.stringify({
  range: "2024-01-01..2025-12-31",
  dataQuality: {
    checksumVerified: loaded.quality.checksumVerified,
    candleCount: candles.length,
  },
  rawSignals: rawSignals.length,
  executedTrades: executed.trades.length,
  missedSignals: missed.length,
  missedInsideExistingTrade: details.filter((item) => item.occupyingSide !== null).length,
  missedSameSide: details.filter((item) => item.sameSideAsOccupying === true).length,
  missedOppositeSide: details.filter((item) => item.sameSideAsOccupying === false).length,
  occupyingTradeExitsWithin6Bars: details.filter((item) => item.exitsWithinExpiry).length,
  signalInvalidatedBeforeExit: details.filter((item) => item.stopTouchedBeforeExit).length,
  pullback25AlreadyTouchedBeforeExit: details.filter((item) => item.pullbackTouchedBeforeExit).length,
  deferred25x6Feasible: details.filter((item) => item.deferred25x6Feasible).length,
  missedByYear: group(details, (item) => String(new Date(item.signalTime * 1000).getUTCFullYear())),
  missedBySide: group(details, (item) => item.side),
  holdingHours: summarize(executed.trades.map((trade) => (trade.exitTime - trade.entryTime) / 3600)),
}, null, 2));

function group<T>(items: T[], key: (item: T) => string) {
  return items.reduce<Record<string, number>>((groups, item) => {
    const id = key(item);
    groups[id] = (groups[id] ?? 0) + 1;
    return groups;
  }, {});
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    maximum: sorted.at(-1) ?? 0,
    over8Hours: values.filter((value) => value > 8).length,
  };
}
