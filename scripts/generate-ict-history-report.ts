import path from "node:path";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  atomicWriteJson,
  buildRouteBHistoryReport,
  ROUTE_B_HISTORY_DEFAULT_THROUGH_DATE,
} from "../server/modules/strategy/runtime/RouteBPaperEngine";

const startMonth = process.argv[2] ?? "2024-01";
const dailyEnd = process.argv[3] ?? ROUTE_B_HISTORY_DEFAULT_THROUGH_DATE;
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange(startMonth, "2026-06")),
  source.loadDays(dayRange("2026-07-01", dailyEnd)),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const report = buildRouteBHistoryReport(candles, {
  availableFrom: `${startMonth}-01`,
  dataThrough: dailyEnd,
  checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
  files: [...monthly.quality.files, ...daily.quality.files],
});
if (report.dataQuality.missingBarCount > 0) {
  throw new Error(`Route B history dataset contains ${report.dataQuality.missingBarCount} missing 5m bars.`);
}
const output = path.resolve(process.env.STRATEGY_HISTORY_REPORT_PATH ?? "server/data/strategy/research-ict-route-b-history.json");
await atomicWriteJson(output, report);
console.log(JSON.stringify({
  output,
  routeId: report.routeId,
  availableRange: report.availableRange,
  dataThrough: report.dataThrough,
  tradeCount: report.metrics.tradeCount,
  netPnl: report.metrics.netPnl,
  automaticOrdersEnabled: report.assumptions.automaticOrdersEnabled,
}, null, 2));
