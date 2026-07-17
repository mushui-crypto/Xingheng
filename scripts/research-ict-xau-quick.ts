import crypto from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BacktestEngine,
  defaultBacktestConfig,
  type BacktestConfig,
  type BacktestResult,
} from "../server/modules/strategy/backtest/BacktestEngine";
import { newYorkTime } from "../server/modules/strategy/ict/time";
import {
  XauMultiTimeframeSmcIctStrategy,
  xauMultiTimeframeSmcIctConfigs,
  type XauMultiTimeframeSmcIctConfig,
} from "../server/modules/strategy/models/XauMultiTimeframeSmcIctStrategy";

const dataPath = path.resolve(process.argv[2] ?? "research-data/xauusd-dukascopy/chunks");
const outputTag = process.argv[3] ?? "quick";
const isHuggingFaceDerivedProxy = /xauusd-huggingface/i.test(dataPath);
const marketLabel = isHuggingFaceDerivedProxy
  ? "Hugging Face community XAUUSD OTC/CFD chart-price proxy"
  : "Dukascopy broker-specific OTC spot/CFD quote proxy";
const sourceLabel = isHuggingFaceDerivedProxy
  ? "Andri-Supriadi/xauusd-m1-layering M1_features.parquet, UTC 1m aggregated to 5m; symmetric Bid/Ask derived around chart OHLC using the supplied spread field"
  : "Dukascopy historical Bid and Ask m5";
const marginFractions = [0.02, 0.03, 0.04, 0.05] as const;

const files = await discoverCsvFiles(dataPath);
const bidFiles = files.filter((file) => /(^|[/\\])(?:xauusd[^/\\]*-)?bid[^/\\]*\.csv$/i.test(file));
const askFiles = files.filter((file) => /(^|[/\\])(?:xauusd[^/\\]*-)?ask[^/\\]*\.csv$/i.test(file));
if (bidFiles.length === 0 || askFiles.length === 0) {
  throw new Error(`Expected bid and ask CSV files in ${dataPath}; found bid=${bidFiles.length}, ask=${askFiles.length}.`);
}

console.error(`Loading ${bidFiles.length} bid and ${askFiles.length} ask files...`);
const [bid, ask, sourceHashes] = await Promise.all([
  loadPriceFiles(bidFiles),
  loadPriceFiles(askFiles),
  hashFiles([...bidFiles, ...askFiles]),
]);
const merged = mergeBidAsk(bid, ask);
if (merged.candles.length < 1_500) throw new Error(`Only ${merged.candles.length} matched candles; need at least 1,500.`);

const spreadStats = distribution(merged.spreads);
const medianPrice = distribution(merged.candles.map((candle) => candle.close)).p50;
const halfSpreadBps = medianPrice > 0 ? spreadStats.p50 / medianPrice * 10_000 / 2 : 0;
const additionalExecutionSlippageBps = 0.5;
const modeledSlippageBpsPerFill = halfSpreadBps + additionalExecutionSlippageBps;

const candidates: Record<string, ReturnType<typeof runCandidate>> = {};
for (const route of xauMultiTimeframeSmcIctConfigs) {
  for (const marginFraction of marginFractions) {
    const key = `${route.routeId}__margin_${Math.round(marginFraction * 100)}pct`;
    console.error(`Running ${key}...`);
    candidates[key] = runCandidate(route, marginFraction, merged.candles, modeledSlippageBpsPerFill);
  }
}

const ranked = Object.entries(candidates)
  .map(([key, value]) => ({ key, finalRewardRisk: value.finalRewardRisk, marginFraction: value.marginFraction, ...value.summary }))
  .sort((left, right) => right.netPnl - left.netPnl);
const baselinePassedCandidateKeys = ranked
  .filter((candidate) => candidate.tradeCount >= 100 && candidate.netPnl > 0 && candidate.profitFactor >= 1.2 && candidate.averageR >= 0.1 && candidate.maxDrawdown <= 0.2 && candidate.liquidations === 0)
  .map((candidate) => candidate.key);

const firstTime = merged.candles[0].time;
const lastTime = merged.candles.at(-1)!.time;
const report = {
  study: "XAUUSD SMC/ICT quick independent Q1 baseline",
  generatedAt: new Date().toISOString(),
  routeVersion: "xau-smc-ict-q1-preregistered-before-first-run",
  symbol: "XAUUSD",
  market: marketLabel,
  source: sourceLabel,
  requestedDataPath: dataPath,
  sourceFiles: sourceHashes,
  researchOnly: true,
  automaticExecutionEligible: false,
  dataRange: {
    from: new Date(firstTime * 1_000).toISOString(),
    through: new Date(lastTime * 1_000).toISOString(),
    calendarDays: (lastTime - firstTime) / 86_400,
  },
  quality: {
    bidRows: bid.rows,
    askRows: ask.rows,
    matchedBidAskCandles: merged.candles.length,
    bidOnlyTimestamps: merged.bidOnly,
    askOnlyTimestamps: merged.askOnly,
    duplicateBidRows: bid.duplicates,
    duplicateAskRows: ask.duplicates,
    invalidBidRows: bid.invalid,
    invalidAskRows: ask.invalid,
    observedMarketBreaks: summarizeBreaks(merged.candles),
    note: "XAU is not 24/7. Weekend, holiday and daily maintenance closures are observed market breaks, not automatically classified as missing bars.",
  },
  spreadModel: {
    rawCloseSpreadUsd: spreadStats,
    medianPrice,
    medianHalfSpreadBps: halfSpreadBps,
    additionalExecutionSlippageBpsPerFill: additionalExecutionSlippageBps,
    modeledAdverseSlippageBpsPerFill: modeledSlippageBpsPerFill,
    method: "Signals use midpoint OHLC. Each entry and exit receives median half-spread plus 0.5 bps adverse execution slippage; this approximates a full median Bid/Ask spread round trip.",
  },
  frozenRules: {
    multiTimeframe: "4h/1h context, 15m direction, 5m entry",
    setup: "weekday London or New York session, liquidity sweep, MSS displacement, FVG in Fibonacci discount/premium half, nearby order block",
    entrySessionsNewYorkTime: ["02:00-05:00", "07:00-11:00"],
    weekdayEntriesOnly: true,
    weekendHoldingAllowed: true,
    maximumNewEntriesPerNewYorkDay: 2,
    consecutiveLossEntryLockEnabled: false,
    dailyLossEntryLockEnabled: false,
    stop: "structure beyond sweep/order block + 0.10 ATR buffer; expand below 0.35 ATR; reject above 1.75 ATR",
    takeProfit: ["100%@1.5R", "100%@2R", "100%@2.5R"],
    exchangeLeverageSetting: 100,
    crossMargin: true,
    initialMarginFractions: marginFractions,
    feeRate: 0,
    spreadAndSlippageIncluded: true,
  },
  candidates,
  rankingByNetPnl: ranked,
  assessment: {
    rule: "trades>=100, netPnl>0, PF>=1.20, AvgR>=0.10, maxDD<=20%, liquidations=0",
    passedCandidateKeys: baselinePassedCandidateKeys,
    status: baselinePassedCandidateKeys.length > 0
      ? "historical_baseline_passed_requires_independent_forward_shadow_validation"
      : "quick_baseline_rejected_new_route_required_for_any_optimization",
    shadowEligible: baselinePassedCandidateKeys.length > 0,
    automaticExecutionEligible: false,
  },
  limitations: [
    isHuggingFaceDerivedProxy
      ? "This is a community XAUUSD OTC/CFD chart-price proxy with a supplied spread field, not exchange-certified COMEX GC data, Dukascopy raw Bid/Ask, or Binance XAUUSDT."
      : "This is Dukascopy broker-specific OTC XAUUSD quote history, not COMEX GC and not Binance XAUUSDT.",
    isHuggingFaceDerivedProxy
      ? "The source chart OHLC is treated as midpoint; symmetric Bid/Ask bars are derived using spread * 0.001. This assumption must be verified against the originating broker before any forward test."
      : "Midpoint candles plus a median spread model do not reproduce every historical intrabar Bid/Ask path.",
    "Five-minute OHLC cannot reveal whether stop or target occurred first inside the same candle; the engine uses conservative liquidation/stop-before-target ordering.",
    "100x leverage and the simplified maintenance margin rate are research assumptions, not a broker-specific executable margin specification.",
    "Historical performance alone cannot establish live usability.",
  ],
};

const output = path.resolve(`research-ict-xau-smc-q1-${outputTag}.json`);
const markdown = path.resolve(`STRATEGY_XAU_SMC_ICT_Q1_${outputTag.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_RESULT.md`);
await Promise.all([
  writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(markdown, renderMarkdown(report), "utf8"),
]);
console.log(JSON.stringify({ output, markdown, dataRange: report.dataRange, quality: report.quality, spreadModel: report.spreadModel, assessment: report.assessment, ranking: ranked }, null, 2));

function runCandidate(
  route: XauMultiTimeframeSmcIctConfig,
  marginFraction: number,
  candles: Candle[],
  slippageBps: number,
) {
  const config: BacktestConfig = {
    ...defaultBacktestConfig,
    initialEquity: 10_000,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps,
    maxLeverage: 100,
    minNetRewardRisk: 0,
    sessionTimeZone: "America/New_York",
    sessionStartMinute: 0,
    sessionEndMinute: 0,
    closePositionAtSessionEnd: false,
    accountRiskControlsEnabled: false,
    maxNewEntriesPerDay: 2,
    stopExecutionMode: "hard",
    positionSizingMode: "fixed_margin_fraction",
    positionMarginFraction: marginFraction,
    positionLeverage: 100,
    positionMarginMode: "cross",
    liquidationMaintenanceMarginRate: 0.005,
    liquidationFeeRate: 0,
  };
  const strategy = new XauMultiTimeframeSmcIctStrategy(route);
  const result = new BacktestEngine(strategy, config).run(candles);
  strategy.release();
  const summary = summarizeResult(result);
  return { routeId: route.routeId, finalRewardRisk: route.finalRewardRisk, marginFraction, approximateInitialNotionalToEquity: marginFraction * 100, config, strategyConfig: route, result, summary };
}

function summarizeResult(result: BacktestResult) {
  const weekendEntries = result.trades.filter((trade) => newYorkTime(trade.entryTime).isWeekend).length;
  const liquidations = result.trades.filter((trade) => trade.exitReason === "liquidation").length;
  const targets = result.trades.filter((trade) => trade.exitReason === "target").length;
  const stops = result.trades.filter((trade) => trade.exitReason === "stop").length;
  const uniqueEntryDays = new Set(result.trades.map((trade) => newYorkTime(trade.entryTime).dateKey)).size;
  return {
    tradeCount: result.metrics.tradeCount,
    netPnl: result.metrics.netPnl,
    profitFactor: result.metrics.profitFactor ?? Number.POSITIVE_INFINITY,
    averageR: result.metrics.averageR,
    maxDrawdownUsd: result.metrics.maxDrawdown,
    maxDrawdown: result.metrics.maxDrawdownFraction,
    winRate: result.metrics.winRate,
    targets,
    stops,
    liquidations,
    weekendEntries,
    uniqueEntryDays,
    tradesPerActiveDay: uniqueEntryDays > 0 ? result.metrics.tradeCount / uniqueEntryDays : 0,
    signals: result.diagnostics.signals,
    filledOrders: result.diagnostics.filledOrders,
    expiredOrders: result.diagnostics.expiredOrders,
  };
}

type ParsedPrices = { byTime: Map<number, Omit<Candle, "symbol" | "interval" | "time">>; rows: number; duplicates: number; invalid: number };
async function loadPriceFiles(files: string[]): Promise<ParsedPrices> {
  const byTime = new Map<number, Omit<Candle, "symbol" | "interval" | "time">>();
  let rows = 0;
  let duplicates = 0;
  let invalid = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || /^timestamp,/i.test(line)) continue;
      rows += 1;
      const [timestampRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = line.split(",");
      const timestamp = Number(timestampRaw);
      const open = Number(openRaw);
      const high = Number(highRaw);
      const low = Number(lowRaw);
      const close = Number(closeRaw);
      const volume = Number(volumeRaw ?? 0);
      if (![timestamp, open, high, low, close, volume].every(Number.isFinite) || timestamp <= 0 || open <= 0 || high < low) {
        invalid += 1;
        continue;
      }
      const time = Math.trunc(timestamp / 1_000);
      if (byTime.has(time)) duplicates += 1;
      byTime.set(time, { open, high, low, close, volume });
    }
  }
  return { byTime, rows, duplicates, invalid };
}

function mergeBidAsk(bid: ParsedPrices, ask: ParsedPrices) {
  const candles: Candle[] = [];
  const spreads: number[] = [];
  let bidOnly = 0;
  let askOnly = 0;
  const timestamps = [...new Set([...bid.byTime.keys(), ...ask.byTime.keys()])].sort((a, b) => a - b);
  for (const time of timestamps) {
    const bidBar = bid.byTime.get(time);
    const askBar = ask.byTime.get(time);
    if (!bidBar) { askOnly += 1; continue; }
    if (!askBar) { bidOnly += 1; continue; }
    const closeSpread = askBar.close - bidBar.close;
    if (closeSpread < 0) continue;
    candles.push({
      symbol: "XAUUSD",
      interval: "5m",
      time,
      open: (bidBar.open + askBar.open) / 2,
      high: (bidBar.high + askBar.high) / 2,
      low: (bidBar.low + askBar.low) / 2,
      close: (bidBar.close + askBar.close) / 2,
      volume: Math.max(bidBar.volume, askBar.volume),
    });
    spreads.push(closeSpread);
  }
  return { candles, spreads, bidOnly, askOnly };
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { count: sorted.length, min: sorted[0] ?? 0, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? 0, mean: sorted.length ? sum / sorted.length : 0 };
}

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}

function summarizeBreaks(candles: Candle[]) {
  const gaps: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) gaps.push(delta - 300);
  }
  return { count: gaps.length, totalClosedHours: gaps.reduce((sum, seconds) => sum + seconds, 0) / 3_600, longestClosedHours: gaps.length ? Math.max(...gaps) / 3_600 : 0, breaksOver24Hours: gaps.filter((seconds) => seconds >= 24 * 3_600).length };
}

async function discoverCsvFiles(input: string) {
  const inputStat = await stat(input);
  if (inputStat.isFile()) return [input];
  const entries = await readdir(input, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(input, entry.name);
    if (entry.isDirectory()) files.push(...await discoverCsvFiles(target));
    else if (entry.isFile() && /\.csv$/i.test(entry.name)) files.push(target);
  }
  return files.sort();
}

async function hashFiles(files: string[]) {
  return Promise.all(files.map(async (file) => ({ file, sha256: crypto.createHash("sha256").update(await readFile(file)).digest("hex") })));
}

function renderMarkdown(report: typeof report) {
  const rows = report.rankingByNetPnl.map((candidate) => `| ${candidate.finalRewardRisk}R | ${(candidate.marginFraction * 100).toFixed(0)}% | ${candidate.tradeCount} | ${candidate.netPnl.toFixed(2)} | ${format(candidate.profitFactor)} | ${format(candidate.averageR)} | ${(candidate.maxDrawdown * 100).toFixed(2)}% | ${(candidate.winRate * 100).toFixed(2)}% | ${candidate.targets}/${candidate.stops}/${candidate.liquidations} |`);
  return `# XAUUSD SMC + ICT Q1 快速基线回测\n\n` +
    `- 数据：${report.source}（${report.market}；不是 COMEX 或 Binance XAUUSDT）\n` +
    `- 区间：${report.dataRange.from} 至 ${report.dataRange.through}\n` +
    `- 匹配 K 线：${report.quality.matchedBidAskCandles}\n` +
    `- 中位点差：${report.spreadModel.rawCloseSpreadUsd.p50.toFixed(4)} USD；每次成交建模滑点：${report.spreadModel.modeledAdverseSlippageBpsPerFill.toFixed(4)} bps\n` +
    `- 结论：**${report.assessment.status}**\n\n` +
    `## 冻结规则\n\n` +
    `4h/1h 趋势环境、15m 方向、5m 入场；工作日伦敦/纽约时段；扫流动性 + MSS 位移 + 0.5 区域 FVG + 邻近订单块；结构止损加 0.10 ATR 缓冲，最小 0.35 ATR、最大 1.75 ATR；正常止盈 1.5R/2R/2.5R；每日最多两次新开仓。\n\n` +
    `## 连续区间排名\n\n` +
    `| TP | 保证金 | 交易数 | 净收益 | PF | Avg R | 最大回撤 | 胜率 | 目标/止损/清算 |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n` +
    `## 边界\n\n本结果只用于研究，不能直接证明可实盘。若有组合通过历史门槛，仍需独立 forward/shadow 验证。\n`;
}

function format(value: number) {
  return Number.isFinite(value) ? value.toFixed(4) : "∞";
}
