import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
  RSI_CONTEXT_SYMBOLS,
  type RsiContextExecutionConfig,
  type RsiContextSymbol,
  type RsiContextTrade,
} from "../server/modules/strategy/research/RsiContextOneMinuteEngine";
import { StructureBreakoutOneMinutePortfolio } from "../server/modules/strategy/research/StructureBreakoutOneMinuteEngine";

type Stage = "formation_2021_2023" | "validation_2024_2025" | "diagnostic_2026_partial";
const warmupStart = Date.parse("2020-12-01T00:00:00Z") / 1000;
const formationStart = Date.parse("2021-01-01T00:00:00Z") / 1000;
const validationStart = Date.parse("2024-01-01T00:00:00Z") / 1000;
const diagnosticStart = Date.parse("2026-01-01T00:00:00Z") / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const configs: RsiContextExecutionConfig[] = [
  { id: "atr_floor_1_target_1_5r", stopAtrMultiple: 1, targetRMultiple: 1.5 },
  { id: "atr_floor_1_target_2r", stopAtrMultiple: 1, targetRMultiple: 2 },
  { id: "atr_floor_1_5_target_1_5r", stopAtrMultiple: 1.5, targetRMultiple: 1.5 },
  { id: "atr_floor_1_5_target_2r", stopAtrMultiple: 1.5, targetRMultiple: 2 },
];
const baseAssumptions = { ...DEFAULT_RSI_CONTEXT_ASSUMPTIONS, maxHoldingSeconds: 240 * 60 };
const stressAssumptions = {
  ...baseAssumptions,
  feeRatePerSide: baseAssumptions.feeRatePerSide * 2,
  slippageFractionPerSide: baseAssumptions.slippageFractionPerSide * 2,
};
const base = configs.map((config) => new StructureBreakoutOneMinutePortfolio(config, baseAssumptions));
const stress = configs.map((config) => new StructureBreakoutOneMinutePortfolio(config, stressAssumptions));
const all = [...base, ...stress];
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"), undefined, "1m");
const quality = Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, createQuality(symbol)])) as Record<RsiContextSymbol, ReturnType<typeof createQuality>>;
let lastTime = warmupStart;

for (const request of monthRange("2020-12", "2026-06", "BTCUSDT")) {
  const [btc, eth] = await Promise.all([
    source.loadMonth(request),
    source.loadMonth({ ...request, symbol: "ETHUSDT" }),
  ]);
  process(btc.candles, eth.candles);
  quality.BTCUSDT.add(btc.candles);
  quality.ETHUSDT.add(eth.candles);
  console.info(JSON.stringify({
    event: "structure_breakout_1m_month_complete",
    month: `${request.year}-${String(request.month).padStart(2, "0")}`,
    tradeCounts: Object.fromEntries(base.map((portfolio) => [portfolio.config.id, portfolio.snapshot().trades.length])),
  }));
}

const [btcDaily, ethDaily] = await Promise.all([
  source.loadDays(dayRange("2026-07-01", "2026-07-15", "BTCUSDT")),
  source.loadDays(dayRange("2026-07-01", "2026-07-15", "ETHUSDT")),
]);
process(btcDaily.candles, ethDaily.candles);
quality.BTCUSDT.add(btcDaily.candles);
quality.ETHUSDT.add(ethDaily.candles);
for (const portfolio of all) portfolio.finish(lastTime);

const results = configs.map((config, index) => buildResult(base[index].snapshot(), stress[index].snapshot()));
const candidates = results.filter((result) => result.gates.finalPassed);
const report = {
  routeId: "binance-usdm-btc-eth-structure-breakout-1m-execution-v3",
  generatedAt: new Date().toISOString(),
  status: candidates.length ? "candidate_found_pending_review" : "research_rejected_no_candidate",
  range: { warmup: "2020-12", formation: "2021-01-01/2023-12-31", validation: "2024-01-01/2025-12-31", diagnostic: "2026-01-01/2026-07-15" },
  assumptions: {
    direction: "completed_1h_and_15m_EMA20_EMA50_with_3bar_slope_alignment",
    breakout: "completed_15m_close_beyond_prior_20bar_structure_body_at_least_0.5_ATR_close_in_outer_25pct",
    retest: "first_1m_rejection_at_breakout_level_with_0.1_completed_5m_ATR_tolerance_next_open_fill",
    stop: "max_completed_5m_ATR_floor_and_retest_structure_plus_0.25ATR_reject_above_2.5ATR",
    eligibleHoursUtc: "08:00-23:59",
    breakoutLifetimeMinutes: 60,
    cooldownMinutes: 15,
    maximumHoldingMinutes: 240,
    riskFraction: baseAssumptions.riskFraction,
    leverageSelection: 20,
    maximumNotionalEquityMultiplePerPosition: baseAssumptions.notionalEquityCap,
    feeRatePerSide: baseAssumptions.feeRatePerSide,
    slippageFractionPerSide: baseAssumptions.slippageFractionPerSide,
    sameCandleCollision: "stop_first",
    automaticOrdersEnabled: false,
  },
  dataQuality: Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, quality[symbol].snapshot()])),
  preregisteredGates: {
    formation: { minimumTrades: 300, minimumTradesPerDay: 0.27, positiveNetPnl: true, minimumProfitFactor: 1.2, minimumAverageR: 0.05, maximumDrawdownFraction: 0.08 },
    validation: { positiveNetPnl: true, minimumProfitFactor: 1.05, positiveAverageR: true, maximumDrawdownFraction: 0.08, symbolsNotBothNegative: true },
    doubleCost: { minimumProfitFactor2021To2025: 1 },
  },
  candidateConfigIds: candidates.map((result) => result.config.id),
  results,
};
const output = path.resolve("server/data/strategy/research-structure-breakout-1m-execution-v3.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "structure_breakout_1m_complete", status: report.status, candidates: report.candidateConfigIds, results: results.map(compact), output }));

function process(btc: Candle[], eth: Candle[]) {
  let left = 0;
  let right = 0;
  while (left < btc.length || right < eth.length) {
    const btcTime = btc[left]?.time ?? Number.POSITIVE_INFINITY;
    const ethTime = eth[right]?.time ?? Number.POSITIVE_INFINITY;
    const time = Math.min(btcTime, ethTime);
    if (time < warmupStart || time >= throughExclusive) {
      if (btcTime === time) left += 1;
      if (ethTime === time) right += 1;
      continue;
    }
    const candles: Partial<Record<RsiContextSymbol, Candle>> = {};
    if (btcTime === time) candles.BTCUSDT = btc[left++];
    if (ethTime === time) candles.ETHUSDT = eth[right++];
    for (const portfolio of all) portfolio.processMinute(candles, stageAt(time));
    lastTime = time + 60;
  }
}

function buildResult(baseSnapshot: ReturnType<StructureBreakoutOneMinutePortfolio["snapshot"]>, stressSnapshot: ReturnType<StructureBreakoutOneMinutePortfolio["snapshot"]>) {
  const formation = stageMetrics(baseSnapshot, "formation_2021_2023");
  const validation = stageMetrics(baseSnapshot, "validation_2024_2025");
  const diagnostic = stageMetrics(baseSnapshot, "diagnostic_2026_partial");
  const formationPassed = formation.tradeCount >= 300
    && formation.tradeCount / 1095 >= 0.27
    && formation.netPnl > 0
    && (formation.profitFactor ?? 0) >= 1.2
    && formation.averageR >= 0.05
    && formation.maximumDrawdownFraction <= 0.08;
  const validationTrades = baseSnapshot.trades.filter((trade) => trade.entryTime >= validationStart && trade.entryTime < diagnosticStart);
  const validationPnl = pnlBySymbol(validationTrades);
  const validationPassed = formationPassed
    && validation.netPnl > 0
    && (validation.profitFactor ?? 0) >= 1.05
    && validation.averageR > 0
    && validation.maximumDrawdownFraction <= 0.08
    && !(validationPnl.BTCUSDT < 0 && validationPnl.ETHUSDT < 0);
  const doubleCost = summarize(stressSnapshot.trades.filter((trade) => trade.entryTime >= formationStart && trade.entryTime < diagnosticStart));
  const doubleCostPassed = validationPassed && (doubleCost.profitFactor ?? 0) >= 1;
  return {
    config: baseSnapshot.config,
    gates: { formationPassed, validationPassed, doubleCostPassed, finalPassed: formationPassed && validationPassed && doubleCostPassed },
    formation,
    validation,
    diagnostic,
    full: summarize(baseSnapshot.trades),
    annual: Object.fromEntries(Array.from({ length: 6 }, (_, index) => 2021 + index).map((year) => [year, summarize(baseSnapshot.trades.filter((trade) => new Date(trade.entryTime * 1000).getUTCFullYear() === year))])),
    bySymbol: Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, summarize(baseSnapshot.trades.filter((trade) => trade.symbol === symbol))])),
    bySide: Object.fromEntries((["long", "short"] as const).map((side) => [side, summarize(baseSnapshot.trades.filter((trade) => trade.side === side))])),
    exitReasons: countBy(baseSnapshot.trades, (trade) => trade.exitReason),
    diagnostics: baseSnapshot.diagnostics,
    doubleCost2021To2025: doubleCost,
  };
}

function stageMetrics(snapshot: ReturnType<StructureBreakoutOneMinutePortfolio["snapshot"]>, stage: Stage) {
  const { start, end } = range(stage);
  return { ...summarize(snapshot.trades.filter((trade) => trade.entryTime >= start && trade.entryTime < end)), maximumDrawdownFraction: snapshot.drawdownByStage[stage] ?? 0 };
}

function summarize(trades: RsiContextTrade[]) {
  const profit = sum(trades.filter((trade) => trade.netPnl > 0).map((trade) => trade.netPnl));
  const loss = Math.abs(sum(trades.filter((trade) => trade.netPnl < 0).map((trade) => trade.netPnl)));
  return {
    tradeCount: trades.length,
    netPnl: sum(trades.map((trade) => trade.netPnl)),
    profitFactor: loss > 0 ? profit / loss : null,
    averageR: average(trades.map((trade) => trade.rMultiple)),
    winRate: trades.filter((trade) => trade.netPnl > 0).length / Math.max(1, trades.length),
    fees: sum(trades.map((trade) => trade.fees)),
  };
}

function stageAt(time: number): Stage | null {
  if (time < formationStart) return null;
  if (time < validationStart) return "formation_2021_2023";
  if (time < diagnosticStart) return "validation_2024_2025";
  return time < throughExclusive ? "diagnostic_2026_partial" : null;
}
function range(stage: Stage) {
  if (stage === "formation_2021_2023") return { start: formationStart, end: validationStart };
  if (stage === "validation_2024_2025") return { start: validationStart, end: diagnosticStart };
  return { start: diagnosticStart, end: throughExclusive };
}
function compact(result: ReturnType<typeof buildResult>) {
  return { id: result.config.id, formation: brief(result.formation), validation: brief(result.validation), diagnostic: brief(result.diagnostic), doubleCostPf: result.doubleCost2021To2025.profitFactor, gates: result.gates, diagnostics: result.diagnostics };
}
function brief(value: ReturnType<typeof stageMetrics>) { return { trades: value.tradeCount, net: value.netPnl, pf: value.profitFactor, averageR: value.averageR, drawdown: value.maximumDrawdownFraction }; }
function pnlBySymbol(trades: RsiContextTrade[]) { return Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, sum(trades.filter((trade) => trade.symbol === symbol).map((trade) => trade.netPnl))])) as Record<RsiContextSymbol, number>; }
function countBy<T>(items: T[], key: (item: T) => string) { const output: Record<string, number> = {}; for (const item of items) output[key(item)] = (output[key(item)] ?? 0) + 1; return output; }
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
function average(values: number[]) { return values.length ? sum(values) / values.length : 0; }

function createQuality(symbol: RsiContextSymbol) {
  const state = { candleCount: 0, duplicateCount: 0, missingBarCount: 0, first: null as number | null, last: null as number | null };
  return {
    add(candles: Candle[]) {
      for (const candle of candles) {
        if (candle.time < warmupStart || candle.time >= throughExclusive) continue;
        if (state.last !== null) {
          if (candle.time === state.last) state.duplicateCount += 1;
          else if (candle.time > state.last + 60) state.missingBarCount += Math.round((candle.time - state.last) / 60) - 1;
        }
        state.first ??= candle.time;
        state.last = Math.max(state.last ?? candle.time, candle.time);
        state.candleCount += 1;
      }
    },
    snapshot() {
      if (state.duplicateCount || state.missingBarCount) throw new Error(`${symbol} V3 quality failed: missing=${state.missingBarCount}, duplicates=${state.duplicateCount}.`);
      return { source: "binance_vision_usdm", market: symbol, interval: "1m", checksumVerified: true, ...state };
    },
  };
}
