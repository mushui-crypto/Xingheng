import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BacktestEngine,
  type BacktestResult,
  type BacktestTrade,
} from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import {
  ictResearchCandidateV5,
  ictResearchCandidateV5Backtest,
} from "../server/modules/strategy/models/ictResearchCandidate";
import { EthOrderFlowStructureStrategy } from "../server/modules/strategy/models/EthOrderFlowStructureStrategy";
import {
  SignalRangePullbackEntryStrategy,
  modeId,
  type SignalRangeEntryMode,
} from "../server/modules/strategy/models/SignalRangePullbackEntryStrategy";

const routeId = "btc-eth-entry-route-v1-signal-range-pullback-2026-07-17";
const outputPath = path.resolve("research-btc-eth-entry-route-v1-signal-range-pullback-2026-07-17.json");
const riskFraction = 0.0025;
const modes: SignalRangeEntryMode[] = [
  { kind: "next_bar_market" },
  { kind: "signal_range_pullback", fraction: 0.25, expiryBars: 3 },
  { kind: "signal_range_pullback", fraction: 0.5, expiryBars: 3 },
  { kind: "signal_range_pullback", fraction: 0.25, expiryBars: 6 },
  { kind: "signal_range_pullback", fraction: 0.5, expiryBars: 6 },
];

const source = new BinanceVisionHistoricalDataSource();
const [btcLoaded, ethLoaded] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2023-12", "BTCUSDT")),
  source.loadMonths(monthRange("2021-01", "2023-12", "ETHUSDT")),
]);
validateData("BTC", btcLoaded.candles, btcLoaded.quality.checksumVerified);
validateData("ETH", ethLoaded.candles, ethLoaded.quality.checksumVerified, true);
if (
  btcLoaded.candles.length !== ethLoaded.candles.length ||
  btcLoaded.candles.some((candle, index) => candle.time !== ethLoaded.candles[index].time)
) throw new Error("BTC and ETH formation candles are not time-aligned.");

const runs: EntryRun[] = [];
for (let index = 0; index < modes.length; index += 1) {
  const mode = modes[index];
  const btc = runBtc(btcLoaded.candles, mode);
  const eth = runEth(ethLoaded.candles, mode);
  const combined = combineRiskNormalized(btc.trades, eth.trades);
  const overlap = summarizeOverlap(btc.trades, eth.trades);
  const yearly = combinedYearly(btc.trades, eth.trades, [2021, 2022, 2023]);
  const checks = {
    combinedTradesAtLeast600: combined.tradeCount >= 600,
    btcTradesAtLeast90: btc.metrics.tradeCount >= 90,
    btcProfitFactorAboveOne: numericProfitFactor(btc.metrics.profitFactor) > 1,
    btcAverageRPositive: btc.metrics.averageR > 0,
    ethTradesAtLeast90: eth.metrics.tradeCount >= 90,
    ethProfitFactorAboveOne: numericProfitFactor(eth.metrics.profitFactor) > 1,
    ethAverageRPositive: eth.metrics.averageR > 0,
    combinedProfitFactorAtLeast115: numericProfitFactor(combined.profitFactor) >= 1.15,
    combinedAverageRAtLeast010: combined.averageR >= 0.10,
    combinedDrawdownAtMost15Pct: combined.maxDrawdownFraction <= 0.15,
    allThreeYearsPositive: Object.values(yearly).every((item) => item.netR > 0),
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key);
  runs.push({
    mode,
    modeId: modeId(mode),
    btc: summarizeResult(btc),
    eth: summarizeResult(eth),
    combined,
    yearly,
    overlap,
    checks,
    failedChecks,
    passed: failedChecks.length === 0,
  });
  console.log(`[entry] ${index + 1}/${modes.length} ${modeId(mode)}`);
}

const passing = runs.filter((run) => run.passed);
const report = {
  routeId,
  generatedAt: new Date().toISOString(),
  status: passing.length > 0
    ? "historical_diagnostic_pass_pending_new_forward"
    : "rejected_historical_entry_optimization",
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: {
    document: "STRATEGY_BTC_ETH_ENTRY_ROUTE_V1.md",
    period: "2021-01-01..2023-12-31",
    cleanHistoricalHoldoutAvailable: false,
    modes: modes.map(modeId),
    btcBase: "ict-btc-v5-2026-07-15",
    btcRewardRisk: 2.5,
    ethBase: "eth-v5-taker-imbalance-threshold-0.75-structure-6x5m-rejected-source",
    ethRewardRisk: 2,
    riskFraction,
  },
  dataQuality: {
    btc: btcLoaded.quality,
    eth: ethLoaded.quality,
    alignedCandleCount: btcLoaded.candles.length,
  },
  costs: {
    marketEntryFeeRate: 0.00045,
    limitEntryFeeRate: 0.00045,
    exitFeeRate: 0.00045,
    slippageBpsPerSide: 1,
  },
  runs,
  passingModes: passing.map((run) => run.modeId),
  decision: {
    candidateFormed: passing.length > 0,
    nextAction: passing.length > 0
      ? "freeze_mode_for_new_forward_only_due_to_seen_history"
      : "close_route_without_post_hoc_entry_grid_expansion",
  },
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  deterministicHash: hashWithoutGeneratedAt(report),
  status: report.status,
  passingModes: report.passingModes,
  runs: runs.map((run) => ({
    modeId: run.modeId,
    passed: run.passed,
    btc: run.btc.metrics,
    eth: run.eth.metrics,
    combined: run.combined,
    overlap: run.overlap,
    failedChecks: run.failedChecks,
  })),
}, null, 2));

type EntryRun = {
  mode: SignalRangeEntryMode;
  modeId: string;
  btc: ReturnType<typeof summarizeResult>;
  eth: ReturnType<typeof summarizeResult>;
  combined: ReturnType<typeof combineRiskNormalized>;
  yearly: ReturnType<typeof combinedYearly>;
  overlap: ReturnType<typeof summarizeOverlap>;
  checks: Record<string, boolean>;
  failedChecks: string[];
  passed: boolean;
};

function runBtc(candles: Candle[], mode: SignalRangeEntryMode) {
  const base = new IctLiquidityReversalStrategy({
    ...ictResearchCandidateV5,
    symbol: "BTCUSDT",
    riskFraction,
  });
  const strategy = new SignalRangePullbackEntryStrategy(base, mode);
  try {
    return new BacktestEngine(strategy, {
      ...ictResearchCandidateV5Backtest,
      makerEntryFeeRate: 0.00045,
      takerEntryFeeRate: 0.00045,
      takerExitFeeRate: 0.00045,
      slippageBps: 1,
      closePositionAtSessionEnd: false,
      accountRiskControlsEnabled: false,
    }).run(candles);
  } finally {
    strategy.release();
  }
}

function runEth(candles: Candle[], mode: SignalRangeEntryMode) {
  const base = new EthOrderFlowStructureStrategy({
    symbol: "ETHUSDT",
    family: "taker_imbalance_continuation",
    threshold: 0.75,
    structureLookbackBars: 6,
    riskFraction,
  });
  const strategy = new SignalRangePullbackEntryStrategy(base, mode);
  try {
    return new BacktestEngine(strategy, {
      ...ictResearchCandidateV5Backtest,
      makerEntryFeeRate: 0.00045,
      takerEntryFeeRate: 0.00045,
      takerExitFeeRate: 0.00045,
      slippageBps: 1,
      closePositionAtSessionEnd: false,
      accountRiskControlsEnabled: false,
    }).run(candles);
  } finally {
    strategy.release();
  }
}

function summarizeResult(result: BacktestResult) {
  return {
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    yearly: summarizeByYear(result.trades, [2021, 2022, 2023]),
    sides: summarizeByKey(result.trades, (trade) => trade.side),
    exits: summarizeByKey(result.trades, (trade) => trade.exitReason),
  };
}

function combineRiskNormalized(btc: BacktestTrade[], eth: BacktestTrade[]) {
  const trades = [...btc, ...eth].sort((left, right) => (
    left.exitTime - right.exitTime || left.signalId.localeCompare(right.signalId)
  ));
  let equity = 10_000;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownFraction = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (let index = 0; index < trades.length;) {
    const exitTime = trades[index].exitTime;
    const group: BacktestTrade[] = [];
    while (index < trades.length && trades[index].exitTime === exitTime) group.push(trades[index++]);
    const baseEquity = equity;
    const groupPnls = group.map((trade) => baseEquity * riskFraction * trade.rMultiple);
    const groupPnl = groupPnls.reduce((sum, pnl) => sum + pnl, 0);
    grossProfit += groupPnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    grossLoss += groupPnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + Math.abs(pnl), 0);
    equity += groupPnl;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownFraction = peak > 0 ? drawdown / peak : 0;
    }
  }
  return {
    initialEquity: 10_000,
    finalEquity: equity,
    netPnl: equity - 10_000,
    tradeCount: trades.length,
    annualizedTrades: trades.length / 3,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    maxDrawdown,
    maxDrawdownFraction,
  };
}

function summarizeOverlap(btc: BacktestTrade[], eth: BacktestTrade[]) {
  let overlappingPairs = 0;
  let oppositeDirectionPairs = 0;
  for (const btcTrade of btc) {
    for (const ethTrade of eth) {
      if (Math.max(btcTrade.entryTime, ethTrade.entryTime) > Math.min(btcTrade.exitTime, ethTrade.exitTime)) continue;
      overlappingPairs += 1;
      if (btcTrade.side !== ethTrade.side) oppositeDirectionPairs += 1;
    }
  }
  return {
    overlappingPairs,
    oppositeDirectionPairs,
    sameDirectionPairs: overlappingPairs - oppositeDirectionPairs,
  };
}

function combinedYearly(btc: BacktestTrade[], eth: BacktestTrade[], years: number[]) {
  const all = [...btc, ...eth];
  return Object.fromEntries(years.map((year) => {
    const trades = all.filter((trade) => new Date(trade.entryTime * 1000).getUTCFullYear() === year);
    const netR = trades.reduce((sum, trade) => sum + trade.rMultiple, 0);
    return [String(year), { trades: trades.length, netR, positive: netR > 0 }];
  }));
}

function summarizeByYear(trades: BacktestTrade[], years: number[]) {
  const groups = summarizeByKey(trades, (trade) => String(new Date(trade.entryTime * 1000).getUTCFullYear()));
  return Object.fromEntries(years.map((year) => [String(year), groups[String(year)] ?? emptySummary()]));
}

function summarizeByKey(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, ReturnType<typeof emptySummary>> = {};
  for (const trade of trades) {
    const id = key(trade);
    groups[id] ??= emptySummary();
    const group = groups[id];
    group.trades += 1;
    group.wins += trade.netPnl > 0 ? 1 : 0;
    group.netPnl += trade.netPnl;
    group.grossProfit += trade.netPnl > 0 ? trade.netPnl : 0;
    group.grossLoss += trade.netPnl < 0 ? Math.abs(trade.netPnl) : 0;
    group.averageR += trade.rMultiple;
    group.fees += trade.fees;
  }
  for (const group of Object.values(groups)) {
    group.winRate = group.trades ? group.wins / group.trades : 0;
    group.profitFactor = group.grossLoss > 0 ? group.grossProfit / group.grossLoss : group.grossProfit > 0 ? null : 0;
    group.averageR = group.trades ? group.averageR / group.trades : 0;
  }
  return groups;
}

function emptySummary() {
  return {
    trades: 0,
    wins: 0,
    winRate: 0,
    netPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: 0 as number | null,
    averageR: 0,
    fees: 0,
  };
}

function validateData(label: string, candles: Candle[], checksumVerified: boolean, orderFlowRequired = false) {
  const gaps = countMissingBars(candles);
  const missingOrderFlow = orderFlowRequired
    ? candles.filter((candle) => ![
      candle.quoteVolume,
      candle.tradeCount,
      candle.takerBuyBaseVolume,
      candle.takerBuyQuoteVolume,
    ].every((value) => Number.isFinite(value) && value! >= 0)).length
    : 0;
  if (!checksumVerified || gaps !== 0 || missingOrderFlow !== 0) {
    throw new Error(`${label} data quality failed: checksum=${checksumVerified} gaps=${gaps} missingOrderFlow=${missingOrderFlow}`);
  }
}

function countMissingBars(candles: Candle[]) {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}

function numericProfitFactor(value: number | null) {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function hashWithoutGeneratedAt(value: typeof report) {
  const clone = structuredClone(value);
  delete (clone as { generatedAt?: string }).generatedAt;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}
