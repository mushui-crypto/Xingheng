import { writeFile } from "node:fs/promises";
import path from "node:path";
import { BacktestEngine, defaultBacktestConfig } from "../server/modules/strategy/backtest/BacktestEngine";
import { HyperliquidHistoricalDataSource } from "../server/modules/strategy/backtest/HyperliquidHistoricalDataSource";
import {
  defaultIctLiquidityReversalConfig,
  IctLiquidityReversalStrategy,
} from "../server/modules/strategy/models/IctLiquidityReversalStrategy";

const end = parseDate(process.argv[3] ?? new Date().toISOString().slice(0, 10));
const start = parseDate(process.argv[2] ?? new Date(end - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
const source = new HyperliquidHistoricalDataSource();
const candles = await source.load({
  symbol: "BTCUSDT",
  providerCoin: "BTC",
  interval: "5m",
  startTime: start,
  endTime: end,
});
const strategy = new IctLiquidityReversalStrategy(defaultIctLiquidityReversalConfig);
const entryCandles = candles;
const result = new BacktestEngine(strategy, defaultBacktestConfig).run(entryCandles);
const output = path.resolve(`backtest-ict-btc-${process.argv[2] ?? "auto"}-${process.argv[3] ?? "auto"}.json`);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, sourceCandles: candles.length, entryCandles: entryCandles.length, diagnostics: result.diagnostics, metrics: result.metrics }, null, 2));

function parseDate(value: string) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date: ${value}. Expected YYYY-MM-DD.`);
  return timestamp;
}
