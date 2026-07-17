import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  simulateExchangeStyleDirectionalMartingaleV2,
  type ExchangeMartingaleV2Config,
  type ExchangeMartingaleV2Cycle,
} from "../server/modules/strategy/research/ExchangeStyleDirectionalMartingaleV2Engine";

const symbol = "ETHUSDT" as const;
const start = Date.parse("2024-01-01T00:00:00Z") / 1000;
const validationStart = Date.parse("2025-01-01T00:00:00Z") / 1000;
const diagnosticStart = Date.parse("2026-01-01T00:00:00Z") / 1000;
const end = Date.parse("2026-07-16T00:00:00Z") / 1000;
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const monthly = await source.loadMonths(monthRange("2023-12", "2026-06", symbol));
const daily = await source.loadDays(dayRange("2026-07-01", "2026-07-15", symbol));
const candles = normalize([...monthly.candles, ...daily.candles]).filter((candle) => candle.time >= Date.parse("2023-12-02T00:00:00Z") / 1000 && candle.time < end);
const missing = missingBars(candles);
if (missing !== 0) throw new Error(`ETH V2B history contains ${missing} missing bars.`);

const configs = [0.008, 0.012].map((takeProfitPriceFraction) => buildConfig(takeProfitPriceFraction as 0.008 | 0.012));
const results = configs.map((config) => {
  const base = simulateExchangeStyleDirectionalMartingaleV2(symbol, candles, { forwardStart: start, config });
  const doubleConfig = { ...config, id: `${config.id}__double-cost`, takerFeeRate: config.takerFeeRate * 2, slippageRate: config.slippageRate * 2 };
  const doubled = simulateExchangeStyleDirectionalMartingaleV2(symbol, candles.filter((candle) => candle.time < diagnosticStart), { forwardStart: start, config: doubleConfig });
  const formation = summarize(base, start, validationStart);
  const validation = summarize(base, validationStart, diagnosticStart);
  const doubleCost = summarize(doubled, start, diagnosticStart);
  const diagnostic = summarize(base, diagnosticStart, end);
  const passed = validation.netPnl > 0
    && Number(validation.profitFactor ?? 0) >= 1.05
    && validation.maxMarkToMarketDrawdownFraction <= 0.05
    && Number(doubleCost.profitFactor ?? 0) >= 1
    && formation.approximateLiquidations + validation.approximateLiquidations === 0;
  return { config, formation, validation, doubleCost2024To2025: doubleCost, diagnostic2026: diagnostic, passed };
});

const candidates = results.filter((result) => result.passed).sort((left, right) =>
  Number(right.validation.profitFactor ?? 0) - Number(left.validation.profitFactor ?? 0)
  || right.validation.netPnl - left.validation.netPnl
  || left.validation.maxMarkToMarketDrawdownFraction - right.validation.maxMarkToMarketDrawdownFraction
  || left.config.takeProfitPriceFraction - right.config.takeProfitPriceFraction);

const report = {
  routeId: "binance-usdm-exchange-style-directional-martingale-v2b-eth-research",
  generatedAt: new Date().toISOString(),
  status: candidates.length ? "historical_candidate_pending_future_paper" : "rejected",
  datasetRole: "eth_asset_separation_2024_formation_2025_validation_seen_history",
  dataQuality: {
    symbol,
    candleCount: candles.length,
    missingBarCount: missing,
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    first: iso(candles[0]?.time ?? null),
    last: iso(candles.at(-1)?.time ?? null),
  },
  btcDisposition: "rejected_v2_all_formation_configs_below_profit_factor_1",
  results,
  selectedCandidate: candidates[0] ?? null,
  assumptions: { automaticOrdersEnabled: false, fundingIgnored: true, markPriceLiquidationApproximated: true },
};
const output = path.resolve("server/data/strategy/research-exchange-style-directional-martingale-v2b-eth.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "martingale_v2b_eth_complete", status: report.status, results: results.map((result) => ({ id: result.config.id, passed: result.passed, validation: result.validation, doubleCost: result.doubleCost2024To2025, diagnostic: result.diagnostic2026 })), selected: candidates[0]?.config.id ?? null, output }));

function buildConfig(takeProfitPriceFraction: 0.008 | 0.012): ExchangeMartingaleV2Config {
  return {
    id: `eth_cooldown_4h__l6__tp${Math.round(takeProfitPriceFraction * 10_000)}bp__completed_1h_atr`,
    initialEquity: 5_000,
    leverageSelection: 20,
    marginMode: "isolated",
    maximumLayers: 6,
    amountMultiplier: 1.08,
    priceStepMultiplier: 1,
    stepMode: "completed_1h_atr",
    fixedStepFractionBySymbol: { BTCUSDT: 0.006, ETHUSDT: 0.008 },
    atrStepMultiplier: 0.75,
    minimumStepFraction: 0.004,
    maximumStepFraction: 0.012,
    takeProfitPriceFraction,
    reentryPolicy: "cooldown_4h",
    cooldownMinutes: 240,
    cumulativeMarginFractionCap: 0.015,
    maximumCycleLossFraction: 0.005,
    stopBeyondLastStepMultiplier: 1,
    maintenanceMarginRateStress: 0.005,
    takerFeeRate: 0.00045,
    slippageRate: 0.0001,
  };
}

function summarize(simulation: ReturnType<typeof simulateExchangeStyleDirectionalMartingaleV2>, from: number, through: number) {
  const cycles = simulation.completed.filter((cycle) => cycle.entryTime >= from && cycle.entryTime < through);
  const curve = simulation.equityCurve.filter((point) => point.time >= from && point.time < through);
  const profit = cycles.filter((cycle) => cycle.netPnl > 0).reduce((sum, cycle) => sum + cycle.netPnl, 0);
  const loss = -cycles.filter((cycle) => cycle.netPnl < 0).reduce((sum, cycle) => sum + cycle.netPnl, 0);
  return {
    completedCycles: cycles.length,
    longCycles: cycles.filter((cycle) => cycle.side === "long").length,
    shortCycles: cycles.filter((cycle) => cycle.side === "short").length,
    takeProfits: cycles.filter((cycle) => cycle.exitReason === "cycle_take_profit").length,
    stops: cycles.filter((cycle) => cycle.exitReason === "cycle_stop").length,
    approximateLiquidations: cycles.filter((cycle) => cycle.exitReason === "approx_liquidation").length,
    netPnl: cycles.reduce((sum, cycle) => sum + cycle.netPnl, 0),
    profitFactor: loss > 0 ? profit / loss : null,
    averageR: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.rMultiple, 0) / cycles.length : 0,
    fees: cycles.reduce((sum, cycle) => sum + cycle.fees, 0),
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve),
  };
}

function normalize(input: Candle[]) { return [...new Map(input.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time); }
function missingBars(input: Candle[]) { let count = 0; for (let index = 1; index < input.length; index += 1) { const delta = input[index].time - input[index - 1].time; if (delta > 300) count += Math.floor(delta / 300) - 1; } return count; }
function maxDrawdown(curve: Array<{ equity: number }>) { let peak = curve[0]?.equity ?? 0; let maximum = 0; for (const point of curve) { peak = Math.max(peak, point.equity); if (peak > 0) maximum = Math.max(maximum, (peak - point.equity) / peak); } return maximum; }
function iso(seconds: number | null) { return seconds === null ? null : new Date(seconds * 1000).toISOString(); }
