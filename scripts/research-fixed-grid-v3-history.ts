import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  calculateFixedGridDirections,
  FIXED_GRID_CONFIG,
  FIXED_GRID_ROUTE_ID,
  simulateFixedGridSymbol,
  type FixedGridCompletedGroup,
} from "../server/modules/strategy/runtime/FixedGridPaperEngine";
import {
  MARTINGALE_GRID_SYMBOLS,
  type MartingaleGridSymbol,
} from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const from = process.env.FIXED_GRID_HISTORY_FROM ?? "2024-01-01";
const through = process.env.FIXED_GRID_HISTORY_THROUGH ?? "2026-07-15";
const warmupDays = 30;
const outputPath = path.resolve(
  process.env.FIXED_GRID_HISTORY_REPORT_PATH
    ?? "server/data/strategy/research-fixed-grid-v3-history.json",
);
const cachePath = path.resolve(
  process.env.FIXED_GRID_HISTORY_CACHE_PATH ?? ".cache/strategy/binance-vision",
);

const fromSeconds = Date.parse(`${from}T00:00:00.000Z`) / 1000;
const throughExclusive = Date.parse(`${through}T00:00:00.000Z`) / 1000 + 86_400;
if (!Number.isFinite(fromSeconds) || !Number.isFinite(throughExclusive) || fromSeconds >= throughExclusive) {
  throw new Error("Invalid fixed-grid history range.");
}

const warmupStart = new Date((fromSeconds - warmupDays * 86_400) * 1000).toISOString().slice(0, 10);
const lastFullMonth = new Date(`${through.slice(0, 7)}-01T00:00:00.000Z`);
lastFullMonth.setUTCMonth(lastFullMonth.getUTCMonth() - 1);
const lastFullMonthText = lastFullMonth.toISOString().slice(0, 7);
const dailyStart = `${through.slice(0, 7)}-01`;
const source = new BinanceVisionHistoricalDataSource(undefined, cachePath);

const candlesBySymbol = {} as Record<MartingaleGridSymbol, Candle[]>;
const qualityBySymbol = {} as Record<MartingaleGridSymbol, unknown>;

for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  console.info(JSON.stringify({ event: "fixed_grid_v3_history_load_start", symbol, warmupStart, through }));
  const monthly = await source.loadMonths(monthRange(warmupStart.slice(0, 7), lastFullMonthText, symbol));
  const daily = await source.loadDays(dayRange(dailyStart, through, symbol));
  const normalized = normalize([...monthly.candles, ...daily.candles])
    .filter((candle) => candle.time >= Date.parse(`${warmupStart}T00:00:00.000Z`) / 1000 && candle.time < throughExclusive);
  candlesBySymbol[symbol] = normalized;
  qualityBySymbol[symbol] = {
    candleCount: normalized.length,
    missingBarCount: missingBars(normalized),
    first: iso(normalized[0]?.time ?? null),
    last: iso(normalized.at(-1)?.time ?? null),
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    files: [...monthly.quality.files, ...daily.quality.files],
  };
  if (missingBars(normalized) !== 0) throw new Error(`${symbol} contains missing 5m bars.`);
  console.info(JSON.stringify({ event: "fixed_grid_v3_history_data_ready", symbol, candleCount: normalized.length }));
}

const base = runScenario("base_cost", 1);
const doubleCost = runScenario("double_fee_and_slippage", 2);
const report = {
  routeId: `${FIXED_GRID_ROUTE_ID}-history-v1`,
  generatedAt: new Date().toISOString(),
  datasetRole: "historical_recalculation_seen_history_not_clean_holdout",
  range: { from, through, warmupStart, attributionField: "exitTime" },
  assumptions: {
    source: "binance_vision_usdm_monthly_and_daily",
    interval: "5m",
    fundingIgnored: true,
    markPriceAndDynamicLiquidationIgnored: true,
    automaticOrdersEnabled: false,
    parametersFrozenFrom: "docs/strategy/STRATEGY_MARTINGALE_GRID_FIXED_STEP_V3.md",
  },
  dataQuality: qualityBySymbol,
  base,
  doubleCost,
  warnings: [
    "The 2024-01-01 through current history has already been observed in prior BTC/ETH research and is not a clean holdout.",
    "Funding, mark-price liquidation, order-book impact, tick/step rounding and exchange minimum order constraints are not modeled.",
    "Fixed absolute BTC/ETH grid steps are not volatility-normalized, so regime transfer must be interpreted cautiously.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "fixed_grid_v3_history_complete", outputPath, summary: base.combined }));

function runScenario(label: string, costMultiplier: number) {
  const config = {
    ...FIXED_GRID_CONFIG,
    gridStepBySymbol: { ...FIXED_GRID_CONFIG.gridStepBySymbol },
    takerFeeRate: FIXED_GRID_CONFIG.takerFeeRate * costMultiplier,
    slippageRate: FIXED_GRID_CONFIG.slippageRate * costMultiplier,
  };
  const simulations = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    simulateFixedGridSymbol(symbol, candlesBySymbol[symbol], { forwardStart: fromSeconds, config }),
  ])) as Record<MartingaleGridSymbol, ReturnType<typeof simulateFixedGridSymbol>>;
  const directions = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    directionSummary(candlesBySymbol[symbol], fromSeconds, config),
  ]));
  const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    summarize(simulations[symbol].completed, simulations[symbol].equityCurve, config.initialEquityPerSymbol, simulations[symbol].diagnostics),
  ])) as Record<MartingaleGridSymbol, ReturnType<typeof summarize>>;
  const allCompleted = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed).sort((a, b) => a.exitTime - b.exitTime);
  const combinedCurve = simulations.BTCUSDT.equityCurve.map((point, index) => ({
    time: point.time,
    equity: point.equity + (simulations.ETHUSDT.equityCurve[index]?.equity ?? config.initialEquityPerSymbol),
  }));
  return {
    label,
    configuration: { ...config, gridStepBySymbol: { ...config.gridStepBySymbol } },
    directionTimeShare: directions,
    bySymbol,
    combined: summarize(
      allCompleted,
      combinedCurve,
      config.initialEquityPerSymbol * MARTINGALE_GRID_SYMBOLS.length,
      {
        confirmations: bySymbol.BTCUSDT.confirmations + bySymbol.ETHUSDT.confirmations,
        expiredPlans: bySymbol.BTCUSDT.expiredPlans + bySymbol.ETHUSDT.expiredPlans,
        startedGroups: bySymbol.BTCUSDT.startedGroups + bySymbol.ETHUSDT.startedGroups,
        dailyLossLocks: bySymbol.BTCUSDT.dailyLossLocks + bySymbol.ETHUSDT.dailyLossLocks,
      },
    ),
  };
}

function summarize(
  groups: FixedGridCompletedGroup[],
  equityCurve: Array<{ time: number; equity: number }>,
  initialEquity: number,
  diagnostics: { confirmations: number; expiredPlans: number; startedGroups: number; dailyLossLocks: number },
) {
  const wins = groups.filter((group) => group.netPnl > 0);
  const losses = groups.filter((group) => group.netPnl < 0);
  const grossProfit = wins.reduce((sum, group) => sum + group.netPnl, 0);
  const grossLoss = -losses.reduce((sum, group) => sum + group.netPnl, 0);
  const netPnl = groups.reduce((sum, group) => sum + group.netPnl, 0);
  const fees = groups.reduce((sum, group) => sum + group.fees, 0);
  const fillDistribution = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const layers = index + 1;
    return [layers, groups.filter((group) => group.fills.length === layers).length];
  }));
  const side = Object.fromEntries(["long", "short"].map((value) => {
    const selected = groups.filter((group) => group.side === value);
    return [value, compactMetrics(selected)];
  }));
  const annual = Object.fromEntries([...new Set(groups.map((group) => new Date(group.exitTime * 1000).getUTCFullYear()))]
    .sort()
    .map((year) => [year, compactMetrics(groups.filter((group) => new Date(group.exitTime * 1000).getUTCFullYear() === year))]));
  return {
    completedGroups: groups.length,
    wins: wins.length,
    losses: losses.length,
    winRate: groups.length ? wins.length / groups.length : 0,
    netPnl,
    returnFraction: netPnl / initialEquity,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageR: average(groups.map((group) => group.rMultiple)),
    maxMarkToMarketDrawdownFraction: maxDrawdown(equityCurve),
    fees,
    averageHoldingMinutes: average(groups.map((group) => group.holdingMinutes)),
    takeProfits: groups.filter((group) => group.exitReason === "take_profit").length,
    groupStops: groups.filter((group) => group.exitReason === "group_stop").length,
    timeouts: groups.filter((group) => group.exitReason === "timeout").length,
    fullLayerGroups: groups.filter((group) => group.fills.length === 12).length,
    fullLayerRate: groups.length ? groups.filter((group) => group.fills.length === 12).length / groups.length : 0,
    averageLayers: average(groups.map((group) => group.fills.length)),
    fillDistribution,
    confirmations: diagnostics.confirmations,
    expiredPlans: diagnostics.expiredPlans,
    startedGroups: diagnostics.startedGroups,
    firstLayerTriggerRate: diagnostics.confirmations ? diagnostics.startedGroups / diagnostics.confirmations : 0,
    dailyLossLocks: diagnostics.dailyLossLocks,
    side,
    annual,
  };
}

function compactMetrics(groups: FixedGridCompletedGroup[]) {
  const profit = groups.filter((group) => group.netPnl > 0).reduce((sum, group) => sum + group.netPnl, 0);
  const loss = -groups.filter((group) => group.netPnl < 0).reduce((sum, group) => sum + group.netPnl, 0);
  return {
    groups: groups.length,
    netPnl: groups.reduce((sum, group) => sum + group.netPnl, 0),
    profitFactor: loss > 0 ? profit / loss : null,
    averageR: average(groups.map((group) => group.rMultiple)),
    winRate: groups.length ? groups.filter((group) => group.netPnl > 0).length / groups.length : 0,
    fees: groups.reduce((sum, group) => sum + group.fees, 0),
  };
}

function directionSummary(candles: Candle[], start: number, config: typeof FIXED_GRID_CONFIG) {
  const points = calculateFixedGridDirections(candles, config).filter((_, index) => candles[index].time >= start);
  return {
    longFraction: points.length ? points.filter((point) => point.fourHourBias === "long").length / points.length : 0,
    shortFraction: points.length ? points.filter((point) => point.fourHourBias === "short").length / points.length : 0,
    neutralFraction: points.length ? points.filter((point) => point.fourHourBias === "neutral").length / points.length : 0,
    oneHourLongBreaks: points.filter((point) => point.confirmation === "long_break").length,
    oneHourShortBreaks: points.filter((point) => point.confirmation === "short_break").length,
  };
}

function normalize(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time);
}

function missingBars(candles: Candle[]) {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}

function maxDrawdown(points: Array<{ equity: number }>) {
  let peak = points[0]?.equity ?? 0;
  let drawdown = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - point.equity) / peak);
  }
  return drawdown;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function iso(seconds: number | null) {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}
