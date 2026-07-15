import { writeFile } from "node:fs/promises";
import path from "node:path";
import { BacktestEngine } from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5 } from "../server/modules/strategy/models/ictResearchCandidate";
import {
  ictLeverage100xRoute,
  makeIctLeverage100xBacktestConfig,
} from "../server/modules/strategy/models/ictResearchRoutes";

const marginPercent = Number(process.argv[2] ?? 2);
const dailyEnd = process.argv[3] ?? "2026-07-13";
const startMonth = process.argv[4] ?? "2024-01";
const marginFraction = marginPercent / 100;
if (!ictLeverage100xRoute.marginFractions.some((item) => item === marginFraction)) {
  throw new Error("Margin percent must be one of: 2, 3, 4, 5.");
}

const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange(startMonth, "2026-06")),
  source.loadDays(dayRange("2026-07-01", dailyEnd)),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`100x route dataset contains ${missingBarCount} missing 5m bars.`);

const strategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
const config = makeIctLeverage100xBacktestConfig(marginFraction);
const result = new BacktestEngine(strategy, config).run(candles);
strategy.release();
const exitCounts = result.trades.reduce<Record<string, number>>((groups, trade) => {
  groups[trade.exitReason] = (groups[trade.exitReason] ?? 0) + 1;
  return groups;
}, {});
const periodSuffix = startMonth === "2024-01" ? "" : `-${startMonth}-start`;
const output = path.resolve(`research-ict-route-b-100x-margin-${marginPercent}pct${periodSuffix}.json`);
await writeFile(output, `${JSON.stringify({
  route: ictLeverage100xRoute,
  through: dailyEnd,
  startMonth,
  quality: {
    source: "binance_vision_usdm",
    market: "BTCUSDT",
    interval: "5m",
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    candleCount: candles.length,
    missingBarCount,
  },
  result,
  exitCounts,
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output,
  marginPercent,
  leverage: config.positionLeverage,
  marginMode: config.positionMarginMode,
  through: dailyEnd,
  candleCount: candles.length,
  exitCounts,
  metrics: result.metrics,
}, null, 2));

function countMissingBars(items: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < items.length; index += 1) {
    const delta = items[index].time - items[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}
