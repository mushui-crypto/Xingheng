import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BacktestEngine, type BacktestResult, type BacktestTrade } from "../server/modules/strategy/backtest/BacktestEngine";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import type { Strategy, StrategyEvaluationContext, StrategySignal } from "../server/modules/strategy/core/types";
import { BtcFibonacciReclaimStrategy, btcFibonacciReclaimV1Config } from "../server/modules/strategy/models/BtcFibonacciReclaimStrategy";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5, ictResearchCandidateV5Backtest } from "../server/modules/strategy/models/ictResearchCandidate";

const output = path.resolve("research-btc-fib-reclaim-v1-2026-07-17.json");
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", "2026-07-13")),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((a, b) => a.time - b.time);
const missing = countMissing(candles);
if (missing) throw new Error(`BTC Fibonacci data has ${missing} missing bars.`);

const definitions = [
  ["formation_2021_2023", "2021-01-01", "2023-12-31"],
  ["evaluation_2024", "2024-01-01", "2024-12-31"],
  ["evaluation_2025", "2025-01-01", "2025-12-31"],
  ["evaluation_2024_2025", "2024-01-01", "2025-12-31"],
  ["historical_recalculation_2026", "2026-01-01", "2026-07-13"],
] as const;
const results: Record<string, ReturnType<typeof evaluate>> = {};
for (const [id, from, to] of definitions) { console.log(`[run] ${id}`); results[id] = evaluate(candles, from, to, false); }
console.log("[run] doubled-cost 2024/2025");
const stress2024 = evaluate(candles, "2024-01-01", "2024-12-31", true);
const stress2025 = evaluate(candles, "2025-01-01", "2025-12-31", true);
const segmented = mergeYears(results.evaluation_2024, results.evaluation_2025);
const stressed = mergeYears(stress2024, stress2025);
const assessment = assess(results, segmented, stressed);
const report = {
  routeId: btcFibonacciReclaimV1Config.routeId,
  status: assessment.passed ? "historical_candidate_pending_forward" : "rejected_first_round",
  generatedAt: new Date().toISOString(),
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: { document: "docs/strategy/archive/STRATEGY_BTC_FIB_RECLAIM_V1.md", config: btcFibonacciReclaimV1Config,
    combinedMaxConcurrentPositions: 2, sameSideOnly: true, singleConfiguration: true },
  frozenReferences: { routeBChanged: false, productionPaperReportsChanged: false, forwardDataUsed: false },
  dataQuality: { source: "binance_vision_usdm", market: "BTCUSDT", interval: "5m",
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    candleCount: candles.length, missingBarCount: missing },
  segmentedEvaluation2024To2025: segmented,
  doubledCostEvaluation2024To2025: stressed,
  results,
  assessment,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, deterministicHash: hash(report), status: report.status, dataQuality: report.dataQuality,
  segmented, doubledCostCombined: stressed.combined, assessment,
  periods: Object.fromEntries(Object.entries(results).map(([id, value]) => [id, compact(value)])) }, null, 2));

function evaluate(all: Candle[], fromDate: string, toDate: string, doubled: boolean) {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  const items = all.filter((candle) => candle.time >= from && candle.time <= to);
  const v5 = run(makeV5(), items, 1, doubled);
  const fib = run(makeFib(), items, 2, doubled);
  const combined = run(makeCombined(), items, 2, doubled);
  const rawV5 = collect(makeV5(), items);
  const rawFib = collect(makeFib(), items);
  const v5Times = new Set(rawV5.map((signal) => signal.createdAt));
  return { range: { from: fromDate, to: toDate }, doubled,
    v5: summarize(v5), fib: summarize(fib), combined: summarize(combined),
    opportunity: { addedTrades: combined.metrics.tradeCount - v5.metrics.tradeCount, v5RawSignals: rawV5.length,
      fibRawSignals: rawFib.length, exactSignalOverlap: rawFib.filter((signal) => v5Times.has(signal.createdAt)).length,
      maximumConcurrentPositions: combined.diagnostics.maximumConcurrentPositions,
      oppositeSignalsRejected: combined.diagnostics.concurrentSignalsRejected } };
}
function makeV5() { return new IctLiquidityReversalStrategy(ictResearchCandidateV5); }
function makeFib() { return new BtcFibonacciReclaimStrategy(btcFibonacciReclaimV1Config); }
function makeCombined(): Strategy {
  const v5 = makeV5(); const fib = makeFib();
  return { id: "ict-btc-v5-plus-fib-reclaim-v1", warmupBars: Math.max(v5.warmupBars, fib.warmupBars),
    prepare: (candles) => { v5.prepare(candles); fib.prepare(candles); }, release: () => { v5.release(); fib.release(); },
    evaluate: (context) => { const first = v5.evaluate(context); const second = fib.evaluate(context);
      return first ? tag(first, "v5") : second ? tag(second, "fib") : null; } };
}
function tag(signal: StrategySignal, sourceId: string) { return { ...signal, id: `${sourceId}:${signal.id}`, evidence: { ...signal.evidence, combinationSource: sourceId } }; }
function run(strategy: Strategy, candles: Candle[], max: 1 | 2, doubled: boolean) {
  const multiplier = doubled ? 2 : 1;
  try { return new BacktestEngine(strategy, { ...ictResearchCandidateV5Backtest,
    makerEntryFeeRate: 0.00045 * multiplier, takerEntryFeeRate: 0.00045 * multiplier,
    takerExitFeeRate: 0.00045 * multiplier, slippageBps: multiplier, maxConcurrentPositions: max,
    concurrentPositionMode: "same_side", markToMarketEquityCurve: true }).run(candles); }
  finally { strategy.release?.(); }
}
function collect(strategy: Strategy, candles: Candle[]) { strategy.prepare?.(candles); const signals: StrategySignal[] = [];
  for (let index = strategy.warmupBars; index < candles.length; index += 1) {
    const signal = strategy.evaluate({ candles, index, equity: 10_000 } satisfies StrategyEvaluationContext); if (signal) signals.push(signal);
  }
  strategy.release?.(); return signals; }
function summarize(result: BacktestResult) { return { metrics: result.metrics, diagnostics: result.diagnostics,
  sides: group(result.trades, (trade) => trade.side), exits: group(result.trades, (trade) => trade.exitReason),
  sources: group(result.trades, (trade) => trade.signalId.startsWith("v5:") ? "v5" : trade.signalId.startsWith("fib:") ? "fib" : "standalone") }; }
function group(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) { const groups: Record<string, BacktestTrade[]> = {};
  for (const trade of trades) (groups[key(trade)] ??= []).push(trade); return Object.fromEntries(Object.entries(groups).map(([id, items]) => [id, metrics(items)])); }
function metrics(trades: BacktestTrade[]) { const gp = trades.filter((t) => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0);
  const gl = -trades.filter((t) => t.netPnl < 0).reduce((s, t) => s + t.netPnl, 0); return { tradeCount: trades.length,
    netPnl: trades.reduce((s, t) => s + t.netPnl, 0), grossProfit: gp, grossLoss: gl,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    averageR: trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0,
    fees: trades.reduce((s, t) => s + t.fees, 0) }; }
function mergeYears(a: ReturnType<typeof evaluate>, b: ReturnType<typeof evaluate>) { return {
  v5: merge(a.v5.metrics, b.v5.metrics), fib: merge(a.fib.metrics, b.fib.metrics), combined: merge(a.combined.metrics, b.combined.metrics),
  combined2024: a.combined.metrics.tradeCount, combined2025: b.combined.metrics.tradeCount,
  fibSides: mergeGroups(a.fib.sides, b.fib.sides), opportunity: { addedTrades: a.opportunity.addedTrades + b.opportunity.addedTrades,
    exactSignalOverlap: a.opportunity.exactSignalOverlap + b.opportunity.exactSignalOverlap,
    maximumConcurrentPositions: Math.max(a.opportunity.maximumConcurrentPositions, b.opportunity.maximumConcurrentPositions) } }; }
function merge(a: BacktestResult["metrics"], b: BacktestResult["metrics"]) { const n = a.tradeCount + b.tradeCount;
  const gp = a.grossProfit + b.grossProfit; const gl = a.grossLoss + b.grossLoss; return { tradeCount: n, netPnl: a.netPnl + b.netPnl,
    grossProfit: gp, grossLoss: gl, profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    averageR: n ? (a.averageR * a.tradeCount + b.averageR * b.tradeCount) / n : 0,
    maxDrawdownFraction: Math.max(a.maxDrawdownFraction, b.maxDrawdownFraction), fees: a.totalFees + b.totalFees }; }
type GM = ReturnType<typeof metrics>;
function mergeGroups(a: Record<string, GM>, b: Record<string, GM>) { const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries([...keys].map((key) => { const x = a[key] ?? empty(); const y = b[key] ?? empty(); const n = x.tradeCount + y.tradeCount;
    const gp = x.grossProfit + y.grossProfit; const gl = x.grossLoss + y.grossLoss; return [key, { tradeCount: n,
      netPnl: x.netPnl + y.netPnl, grossProfit: gp, grossLoss: gl, profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
      averageR: n ? (x.averageR * x.tradeCount + y.averageR * y.tradeCount) / n : 0, fees: x.fees + y.fees }]; })); }
function empty(): GM { return { tradeCount: 0, netPnl: 0, grossProfit: 0, grossLoss: 0, profitFactor: 0, averageR: 0, fees: 0 }; }
function assess(all: Record<string, ReturnType<typeof evaluate>>, s: ReturnType<typeof mergeYears>, stress: ReturnType<typeof mergeYears>) {
  const sides = s.fibSides; const checks = { combinedTradesAtLeast360: s.combined.tradeCount >= 360,
    combined2024AtLeast160: s.combined2024 >= 160, combined2025AtLeast160: s.combined2025 >= 160,
    combinedPfAtLeast120: finite(s.combined.profitFactor) >= 1.2, combinedAverageRAtLeast010: s.combined.averageR >= 0.1,
    combinedDrawdownAtMost10Pct: s.combined.maxDrawdownFraction <= 0.1, positive2024: all.evaluation_2024.combined.metrics.netPnl > 0,
    positive2025: all.evaluation_2025.combined.metrics.netPnl > 0, positive2026: all.historical_recalculation_2026.combined.metrics.netPnl > 0,
    formationPfAtLeast100: finite(all.formation_2021_2023.combined.metrics.profitFactor) >= 1,
    fibPf2024AtLeast105: finite(all.evaluation_2024.fib.metrics.profitFactor) >= 1.05,
    fibPf2025AtLeast105: finite(all.evaluation_2025.fib.metrics.profitFactor) >= 1.05,
    fibPositive2024: all.evaluation_2024.fib.metrics.netPnl > 0, fibPositive2025: all.evaluation_2025.fib.metrics.netPnl > 0,
    longNotLosing: (sides.long?.netPnl ?? 0) >= 0 && (sides.long?.tradeCount ?? 0) > 0,
    shortNotLosing: (sides.short?.netPnl ?? 0) >= 0 && (sides.short?.tradeCount ?? 0) > 0,
    doubledCostPfAtLeast100: finite(stress.combined.profitFactor) >= 1 };
  return { checks, passed: Object.values(checks).every(Boolean), failedChecks: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key) }; }
function compact(v: ReturnType<typeof evaluate>) { return { v5: v.v5.metrics, fib: v.fib.metrics, combined: v.combined.metrics, opportunity: v.opportunity }; }
function finite(v: number | null) { return v === null ? Number.POSITIVE_INFINITY : v; }
function hash(v: typeof report) { const c = structuredClone(v); delete (c as { generatedAt?: string }).generatedAt; return createHash("sha256").update(JSON.stringify(c)).digest("hex"); }
function countMissing(items: Array<{ time: number }>) { let n = 0; for (let i = 1; i < items.length; i += 1) { const d = items[i].time - items[i - 1].time; if (d > 300) n += Math.floor(d / 300) - 1; } return n; }
