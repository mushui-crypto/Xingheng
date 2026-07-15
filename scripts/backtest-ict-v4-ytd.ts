import { writeFile } from "node:fs/promises";
import path from "node:path";
import { BacktestEngine } from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import {
  ictResearchCandidateV3,
  ictResearchCandidateV3Backtest,
  ictResearchCandidateV4,
  ictResearchCandidateV4Backtest,
  ictResearchCandidateV5,
  ictResearchCandidateV5Backtest,
  ictResearchCandidateV6,
  ictResearchCandidateV6Backtest,
} from "../server/modules/strategy/models/ictResearchCandidate";

const dailyEnd = process.argv[2] ?? "2026-07-13";
const requestedVersion = process.argv[3];
const candidateVersion = requestedVersion === "v3" || requestedVersion === "v4" || requestedVersion === "v6"
  ? requestedVersion
  : "v5";
const candidate = candidateVersion === "v3"
  ? ictResearchCandidateV3
  : candidateVersion === "v4"
    ? ictResearchCandidateV4
    : candidateVersion === "v6"
      ? ictResearchCandidateV6
      : ictResearchCandidateV5;
const backtestConfig = candidateVersion === "v3"
  ? ictResearchCandidateV3Backtest
  : candidateVersion === "v4"
    ? ictResearchCandidateV4Backtest
    : candidateVersion === "v6"
      ? ictResearchCandidateV6Backtest
      : ictResearchCandidateV5Backtest;
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2026-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", dailyEnd)),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`Combined 2026 YTD dataset contains ${missingBarCount} missing 5m bars.`);

const strategy = new IctLiquidityReversalStrategy(candidate);
const result = new BacktestEngine(strategy, backtestConfig).run(candles);
strategy.release();
const output = path.resolve(`research-ict-candidate-${candidateVersion}-2026-ytd.json`);
await writeFile(output, `${JSON.stringify({
  datasetRole: "final_holdout",
  candidateVersion,
  through: dailyEnd,
  quality: {
    source: "binance_vision_usdm",
    market: "BTCUSDT",
    interval: "5m",
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    candleCount: candles.length,
    missingBarCount,
    monthlyFiles: monthly.quality.files,
    dailyFiles: daily.quality.files,
    firstCandleTime: candles[0]?.time ?? null,
    lastCandleTime: candles.at(-1)?.time ?? null,
  },
  result,
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, candidateVersion, through: dailyEnd, quality: { candleCount: candles.length, missingBarCount }, metrics: result.metrics }, null, 2));

function countMissingBars(candles: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}
