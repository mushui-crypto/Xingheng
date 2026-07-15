import { writeFile } from "node:fs/promises";
import path from "node:path";
import { BacktestEngine, defaultBacktestConfig } from "../server/modules/strategy/backtest/BacktestEngine";
import { BinanceVisionHistoricalDataSource, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { defaultIctLiquidityReversalConfig, IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";

const startMonth = process.argv[2] ?? "2026-06";
const endMonth = process.argv[3] ?? startMonth;
const source = new BinanceVisionHistoricalDataSource();
const { candles, quality } = await source.loadMonths(monthRange(startMonth, endMonth));
if (quality.missingBarCount > 0) {
  throw new Error(`Historical data has ${quality.missingBarCount} missing 5m candles; research aborted.`);
}
const entryCandles = candles;
const strategy = new IctLiquidityReversalStrategy(defaultIctLiquidityReversalConfig);
const result = new BacktestEngine(strategy, defaultBacktestConfig).run(entryCandles);
const output = path.resolve(`backtest-ict-binance-${startMonth}-${endMonth}.json`);
await writeFile(output, `${JSON.stringify({ researchMarket: "Binance USD-M BTCUSDT perpetual", executionTarget: "Hyperliquid BTC perpetual", quality, result }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, sourceCandles: candles.length, entryCandles: entryCandles.length, quality, diagnostics: result.diagnostics, metrics: result.metrics }, null, 2));
