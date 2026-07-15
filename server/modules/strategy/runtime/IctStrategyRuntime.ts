import type { Candle } from "../../../types";
import type { KlineStore } from "../../kline/KlineStore";
import type { HyperliquidMarketService } from "../../market/HyperliquidMarketService";
import { BacktestEngine } from "../backtest/BacktestEngine";
import { IctLiquidityReversalStrategy } from "../models/IctLiquidityReversalStrategy";
import {
  ictResearchCandidateV5,
  ictResearchCandidateV5Backtest,
  ictResearchCandidateV5Decision,
} from "../models/ictResearchCandidate";
import type { StrategySignal } from "../core/types";

const symbol = "BTCUSDT";
const interval = "5m" as const;
const intervalSeconds = 5 * 60;
const historyLimit = 5_000;

export class IctStrategyRuntime {
  private releaseSubscription: (() => void) | null = null;
  private lastEvaluatedCandleTime: number | null = null;
  private latestSignal: StrategySignal | null = null;
  private latestBacktest: ReturnType<BacktestEngine["run"]> | null = null;
  private state: "initializing" | "ready" | "insufficient_history" | "error" = "initializing";
  private lastError: string | null = null;

  constructor(
    private market: HyperliquidMarketService,
    private store: KlineStore,
  ) {}

  async start() {
    try {
      await this.market.getKlines(symbol, interval, historyLimit);
      this.releaseSubscription = this.market.addCandleSubscription(symbol, interval);
      this.market.on("kline", this.handleKline);
      this.evaluateLatestClosedCandle();
    } catch (error) {
      this.state = "error";
      this.lastError = sanitizeError(error);
      throw error;
    }
  }

  stop() {
    this.market.off("kline", this.handleKline);
    this.releaseSubscription?.();
    this.releaseSubscription = null;
  }

  getStatus() {
    const now = Math.floor(Date.now() / 1000);
    const activeSignal = this.latestSignal && this.latestSignal.expiresAt >= now ? this.latestSignal : null;
    return {
      strategyId: "ict-liquidity-reversal-v1",
      candidateVersion: "v5",
      state: this.state,
      symbol,
      interval,
      marketData: { source: "hyperliquid", network: "mainnet_public", status: this.market.getStatus(symbol) },
      execution: {
        demo: "shadow_only",
        hyperliquidTestnet: "readonly_validation_only",
        automaticOrdersEnabled: false,
        reason: "V5 尚未完成足量 Hyperliquid 前向影子验证，禁止自动下单。",
      },
      decision: ictResearchCandidateV5Decision,
      config: publicConfig(),
      lastEvaluatedCandleTime: this.lastEvaluatedCandleTime,
      latestSignal: activeSignal,
      shadowSimulation: this.latestBacktest ? {
        from: this.latestBacktest.from,
        to: this.latestBacktest.to,
        metrics: this.latestBacktest.metrics,
        diagnostics: this.latestBacktest.diagnostics,
        recentTrades: this.latestBacktest.trades.slice(-20),
      } : null,
      lastError: this.lastError,
    };
  }

  private handleKline = (candle: Candle) => {
    if (candle.symbol !== symbol || candle.interval !== interval || !isClosed(candle)) return;
    if (this.lastEvaluatedCandleTime !== null && candle.time <= this.lastEvaluatedCandleTime) return;
    this.evaluateLatestClosedCandle();
  };

  private evaluateLatestClosedCandle() {
    try {
      const candles = this.store.getCandles(symbol, interval, historyLimit).filter(isClosed);
      const last = candles.at(-1);
      if (!last || candles.length <= 300) {
        this.state = "insufficient_history";
        return;
      }
      const backtestStrategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
      this.latestBacktest = new BacktestEngine(backtestStrategy, ictResearchCandidateV5Backtest).run(candles);
      backtestStrategy.release();

      const signalStrategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
      this.latestSignal = signalStrategy.evaluate({
        candles,
        index: candles.length - 1,
        equity: this.latestBacktest.metrics.finalEquity,
      });
      signalStrategy.release();
      this.lastEvaluatedCandleTime = last.time;
      this.state = "ready";
      this.lastError = null;
    } catch (error) {
      this.state = "error";
      this.lastError = sanitizeError(error);
    }
  }
}

function isClosed(candle: Candle) {
  return candle.time + intervalSeconds <= Math.floor(Date.now() / 1000);
}

function publicConfig() {
  return {
    higherTimeframe: "15m",
    entryTimeframe: "5m",
    setupMode: ictResearchCandidateV5.setupMode,
    entryMode: ictResearchCandidateV5.entryMode,
    biasMode: ictResearchCandidateV5.biasMode,
    displacementBodyAtr: ictResearchCandidateV5.displacementBodyAtr,
    sweepLookbackBars: ictResearchCandidateV5.sweepLookbackBars,
    setupExpiryBars: ictResearchCandidateV5.setupExpiryBars,
    rewardRisk: ictResearchCandidateV5.rewardRisk,
    researchSizingRiskFraction: ictResearchCandidateV5.riskFraction,
    maxStopAtr: ictResearchCandidateV5.maxStopAtr,
    minimumVolatilityRatio: ictResearchCandidateV5.minimumVolatilityRatio,
    allowWeekends: ictResearchCandidateV5.allowWeekends,
    sessionTimeZone: ictResearchCandidateV5.sessionTimeZone,
    sessionStartMinute: ictResearchCandidateV5.sessionStartMinute,
    sessionEndMinute: ictResearchCandidateV5.sessionEndMinute,
    closePositionAtSessionEnd: ictResearchCandidateV5Backtest.closePositionAtSessionEnd,
    accountRiskControlsEnabled: ictResearchCandidateV5Backtest.accountRiskControlsEnabled,
  };
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : "strategy runtime error";
}
