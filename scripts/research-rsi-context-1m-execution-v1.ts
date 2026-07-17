import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
  type HistoricalDataQuality,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
  RSI_CONTEXT_SYMBOLS,
  RsiContextOneMinutePortfolio,
  type RsiContextEvent,
  type RsiContextExecutionConfig,
  type RsiContextPortfolioSnapshot,
  type RsiContextSymbol,
  type RsiContextTrade,
} from "../server/modules/strategy/research/RsiContextOneMinuteEngine";

type EventReport = { rawEvents: RsiContextEvent[] };
type Stage = "formation_2021_2023" | "validation_2024_2025" | "diagnostic_2026_partial";

const startTime = Date.parse("2020-12-01T00:00:00Z") / 1000;
const formationStart = Date.parse("2021-01-01T00:00:00Z") / 1000;
const validationStart = Date.parse("2024-01-01T00:00:00Z") / 1000;
const diagnosticStart = Date.parse("2026-01-01T00:00:00Z") / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const configurations: RsiContextExecutionConfig[] = [
  { id: "stop_1_atr_target_1_5r", stopAtrMultiple: 1, targetRMultiple: 1.5 },
  { id: "stop_1_atr_target_2r", stopAtrMultiple: 1, targetRMultiple: 2 },
  { id: "stop_1_5_atr_target_1_5r", stopAtrMultiple: 1.5, targetRMultiple: 1.5 },
  { id: "stop_1_5_atr_target_2r", stopAtrMultiple: 1.5, targetRMultiple: 2 },
];

const eventReportPath = path.resolve("server/data/strategy/research-rsi-overbought-oversold-events-v1.json");
const eventReport = JSON.parse(await readFile(eventReportPath, "utf8")) as EventReport;
const contexts = eventReport.rawEvents
  .filter(isEligibleContext)
  .filter((event) => event.signalTime >= formationStart && event.signalTime < throughExclusive)
  .sort((left, right) => left.signalTime - right.signalTime || left.symbol.localeCompare(right.symbol));
const contextsByTime = new Map<number, RsiContextEvent[]>();
for (const context of contexts) contextsByTime.set(context.signalTime, [...(contextsByTime.get(context.signalTime) ?? []), context]);

const basePortfolios = configurations.map((config) => new RsiContextOneMinutePortfolio(config));
const stressPortfolios = configurations.map((config) => new RsiContextOneMinutePortfolio(config, {
  ...DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
  feeRatePerSide: DEFAULT_RSI_CONTEXT_ASSUMPTIONS.feeRatePerSide * 2,
  slippageFractionPerSide: DEFAULT_RSI_CONTEXT_ASSUMPTIONS.slippageFractionPerSide * 2,
}));
const allPortfolios = [...basePortfolios, ...stressPortfolios];
const source = new BinanceVisionHistoricalDataSource(
  undefined,
  path.resolve(".cache/strategy/binance-vision"),
  undefined,
  "1m",
);
const quality = Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, createStreamingQuality(symbol)])) as Record<RsiContextSymbol, ReturnType<typeof createStreamingQuality>>;
let lastProcessedTime = startTime;

for (const request of monthRange("2020-12", "2026-06", "BTCUSDT")) {
  const [btc, eth] = await Promise.all([
    source.loadMonth(request),
    source.loadMonth({ ...request, symbol: "ETHUSDT" }),
  ]);
  processChunk(btc.candles, eth.candles);
  quality.BTCUSDT.add(btc.candles, btc.fileName);
  quality.ETHUSDT.add(eth.candles, eth.fileName);
  console.info(JSON.stringify({
    event: "rsi_context_1m_month_complete",
    month: `${request.year}-${String(request.month).padStart(2, "0")}`,
    baseTradeCounts: Object.fromEntries(basePortfolios.map((portfolio) => [portfolio.config.id, portfolio.snapshot().trades.length])),
  }));
}

const [btcDaily, ethDaily] = await Promise.all([
  source.loadDays(dayRange("2026-07-01", "2026-07-15", "BTCUSDT")),
  source.loadDays(dayRange("2026-07-01", "2026-07-15", "ETHUSDT")),
]);
processChunk(btcDaily.candles, ethDaily.candles);
quality.BTCUSDT.add(btcDaily.candles, btcDaily.quality.files);
quality.ETHUSDT.add(ethDaily.candles, ethDaily.quality.files);
lastProcessedTime = Math.min(btcDaily.candles.at(-1)?.time ?? lastProcessedTime, ethDaily.candles.at(-1)?.time ?? lastProcessedTime) + 60;
for (const portfolio of allPortfolios) portfolio.finish(lastProcessedTime);

const results = configurations.map((config, index) => buildConfigResult(basePortfolios[index].snapshot(), stressPortfolios[index].snapshot()));
const candidates = results.filter((result) => result.gates.finalPassed);
const report = {
  routeId: "binance-usdm-btc-eth-rsi-context-1m-execution-v1",
  generatedAt: new Date().toISOString(),
  status: candidates.length > 0 ? "candidate_found_pending_review" : "research_rejected_no_candidate",
  range: {
    warmupStart: "2020-12-01",
    formation: "2021-01-01/2023-12-31",
    validation: "2024-01-01/2025-12-31",
    diagnostic: "2026-01-01/2026-07-15",
  },
  assumptions: {
    context: "15m_Wilder_RSI14_first_cross_plus_completed_4h_EMA50_200_regime",
    execution: "1m_Wilder_RSI7_recovery_plus_EMA20_next_open",
    atr: "1m_Wilder_ATR14",
    contextLifetimeMinutes: 60,
    maximumHoldingMinutes: 60,
    riskFraction: DEFAULT_RSI_CONTEXT_ASSUMPTIONS.riskFraction,
    leverageSelection: 20,
    maximumNotionalEquityMultiplePerPosition: DEFAULT_RSI_CONTEXT_ASSUMPTIONS.notionalEquityCap,
    feeRatePerSide: DEFAULT_RSI_CONTEXT_ASSUMPTIONS.feeRatePerSide,
    slippageFractionPerSide: DEFAULT_RSI_CONTEXT_ASSUMPTIONS.slippageFractionPerSide,
    sameCandleCollision: "stop_first",
    automaticOrdersEnabled: false,
  },
  contextCounts: {
    total: contexts.length,
    bySymbolAndType: countBy(contexts, (event) => `${event.symbol}|${event.type}`),
  },
  dataQuality: Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, quality[symbol].snapshot()])),
  preregisteredGates: {
    formation: { minimumTrades: 500, minimumTradesPerDay: 0.45, minimumProfitFactor: 1.15, minimumAverageR: 0.05, maximumDrawdownFraction: 0.08 },
    validation: { positiveNetPnl: true, minimumProfitFactor: 1.05, positiveAverageR: true, maximumDrawdownFraction: 0.08, symbolsNotBothNegative: true },
    doubleCost: { range: "2021-01-01/2025-12-31", minimumProfitFactor: 1 },
  },
  candidateConfigIds: candidates.map((result) => result.config.id),
  results,
};
const output = path.resolve("server/data/strategy/research-rsi-context-1m-execution-v1.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "rsi_context_1m_complete", status: report.status, candidates: report.candidateConfigIds, results: results.map(compactResult), output }));

function processChunk(btcCandles: Candle[], ethCandles: Candle[]) {
  let btcIndex = 0;
  let ethIndex = 0;
  while (btcIndex < btcCandles.length || ethIndex < ethCandles.length) {
    const btcTime = btcCandles[btcIndex]?.time ?? Number.POSITIVE_INFINITY;
    const ethTime = ethCandles[ethIndex]?.time ?? Number.POSITIVE_INFINITY;
    const time = Math.min(btcTime, ethTime);
    if (time < startTime || time >= throughExclusive) {
      if (btcTime === time) btcIndex += 1;
      if (ethTime === time) ethIndex += 1;
      continue;
    }
    const candles: Partial<Record<RsiContextSymbol, Candle>> = {};
    if (btcTime === time) candles.BTCUSDT = btcCandles[btcIndex++];
    if (ethTime === time) candles.ETHUSDT = ethCandles[ethIndex++];
    const stage = stageAt(time);
    const minuteContexts = contextsByTime.get(time) ?? [];
    for (const portfolio of allPortfolios) portfolio.processMinute(candles, minuteContexts, stage);
    lastProcessedTime = time + 60;
  }
}

function buildConfigResult(base: RsiContextPortfolioSnapshot, stress: RsiContextPortfolioSnapshot) {
  const formation = metrics(base, "formation_2021_2023");
  const validation = metrics(base, "validation_2024_2025");
  const diagnostic = metrics(base, "diagnostic_2026_partial");
  const full = summarizeTrades(base.trades.filter((trade) => trade.entryTime >= formationStart && trade.entryTime < throughExclusive));
  const formationPassed = formation.tradeCount >= 500
    && formation.tradeCount / 1095 >= 0.45
    && formation.netPnl > 0
    && (formation.profitFactor ?? 0) >= 1.15
    && formation.averageR >= 0.05
    && formation.maximumDrawdownFraction <= 0.08;
  const validationSymbols = countPnlBySymbol(base.trades.filter((trade) => trade.entryTime >= validationStart && trade.entryTime < diagnosticStart));
  const validationPassed = formationPassed
    && validation.netPnl > 0
    && (validation.profitFactor ?? 0) >= 1.05
    && validation.averageR > 0
    && validation.maximumDrawdownFraction <= 0.08
    && !(validationSymbols.BTCUSDT < 0 && validationSymbols.ETHUSDT < 0);
  const stress2021To2025 = summarizeTrades(stress.trades.filter((trade) => trade.entryTime >= formationStart && trade.entryTime < diagnosticStart));
  const doubleCostPassed = validationPassed && (stress2021To2025.profitFactor ?? 0) >= 1;
  return {
    config: base.config,
    gates: { formationPassed, validationPassed, doubleCostPassed, finalPassed: formationPassed && validationPassed && doubleCostPassed },
    formation,
    validation,
    diagnostic,
    full,
    annual: Object.fromEntries(years(2021, 2026).map((year) => [String(year), summarizeTrades(base.trades.filter((trade) => new Date(trade.entryTime * 1000).getUTCFullYear() === year))])),
    bySymbol: Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, summarizeTrades(base.trades.filter((trade) => trade.symbol === symbol))])),
    bySide: Object.fromEntries((["long", "short"] as const).map((side) => [side, summarizeTrades(base.trades.filter((trade) => trade.side === side))])),
    exitReasons: countBy(base.trades, (trade) => trade.exitReason),
    doubleCost2021To2025: stress2021To2025,
  };
}

function metrics(snapshot: RsiContextPortfolioSnapshot, stage: Stage) {
  const range = stageRange(stage);
  return {
    ...summarizeTrades(snapshot.trades.filter((trade) => trade.entryTime >= range.start && trade.entryTime < range.end)),
    maximumDrawdownFraction: snapshot.drawdownByStage[stage] ?? 0,
  };
}

function summarizeTrades(trades: RsiContextTrade[]) {
  const profits = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  const losses = Math.abs(trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
  return {
    tradeCount: trades.length,
    netPnl: sum(trades.map((trade) => trade.netPnl)),
    profitFactor: losses > 0 ? profits / losses : null,
    averageR: average(trades.map((trade) => trade.rMultiple)),
    winRate: trades.filter((trade) => trade.netPnl > 0).length / Math.max(1, trades.length),
    fees: sum(trades.map((trade) => trade.fees)),
  };
}

function countPnlBySymbol(trades: RsiContextTrade[]) {
  return Object.fromEntries(RSI_CONTEXT_SYMBOLS.map((symbol) => [symbol, sum(trades.filter((trade) => trade.symbol === symbol).map((trade) => trade.netPnl))])) as Record<RsiContextSymbol, number>;
}

function isEligibleContext(event: RsiContextEvent) {
  if (event.session !== "america_16_24_utc") return false;
  if (event.type === "oversold") return event.trendRegime === "uptrend" || event.trendRegime === "neutral";
  return event.trendRegime === "neutral";
}

function stageAt(time: number): Stage | null {
  if (time < formationStart) return null;
  if (time < validationStart) return "formation_2021_2023";
  if (time < diagnosticStart) return "validation_2024_2025";
  if (time < throughExclusive) return "diagnostic_2026_partial";
  return null;
}

function stageRange(stage: Stage) {
  if (stage === "formation_2021_2023") return { start: formationStart, end: validationStart };
  if (stage === "validation_2024_2025") return { start: validationStart, end: diagnosticStart };
  return { start: diagnosticStart, end: throughExclusive };
}

function compactResult(result: ReturnType<typeof buildConfigResult>) {
  return {
    id: result.config.id,
    formation: pickMetrics(result.formation),
    validation: pickMetrics(result.validation),
    diagnostic: pickMetrics(result.diagnostic),
    doubleCostPf: result.doubleCost2021To2025.profitFactor,
    gates: result.gates,
  };
}

function pickMetrics(metrics: ReturnType<typeof metrics>) {
  return { trades: metrics.tradeCount, net: metrics.netPnl, pf: metrics.profitFactor, averageR: metrics.averageR, drawdown: metrics.maximumDrawdownFraction };
}

function countBy<T>(items: T[], keyFor: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyFor(item)] = (counts[keyFor(item)] ?? 0) + 1;
  return counts;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : 0;
}

function years(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function createStreamingQuality(symbol: RsiContextSymbol) {
  const state = {
    files: [] as string[],
    candleCount: 0,
    duplicateCount: 0,
    missingBarCount: 0,
    firstTime: null as number | null,
    lastTime: null as number | null,
  };
  return {
    add(candles: Candle[], fileOrFiles: string | string[]) {
      state.files.push(...(Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]));
      for (const candle of candles) {
        if (candle.time < startTime || candle.time >= throughExclusive) continue;
        if (state.lastTime !== null) {
          if (candle.time === state.lastTime) state.duplicateCount += 1;
          else if (candle.time > state.lastTime + 60) state.missingBarCount += Math.round((candle.time - state.lastTime) / 60) - 1;
        }
        state.firstTime ??= candle.time;
        state.lastTime = Math.max(state.lastTime ?? candle.time, candle.time);
        state.candleCount += 1;
      }
    },
    snapshot(): HistoricalDataQuality {
      if (state.missingBarCount > 0 || state.duplicateCount > 0) throw new Error(`${symbol} 1m data failed quality checks: missing=${state.missingBarCount}, duplicates=${state.duplicateCount}.`);
      return {
        source: "binance_vision_usdm",
        market: symbol,
        interval: "1m",
        files: state.files,
        checksumVerified: true,
        candleCount: state.candleCount,
        duplicateCount: state.duplicateCount,
        missingBarCount: state.missingBarCount,
        firstCandleTime: state.firstTime,
        lastCandleTime: state.lastTime,
      };
    },
  };
}
