import type { Candle } from "../../../types";
import {
  DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
  RSI_CONTEXT_SYMBOLS,
  type RsiContextExecutionAssumptions,
  type RsiContextExecutionConfig,
  type RsiContextPortfolioSnapshot,
  type RsiContextSide,
  type RsiContextSymbol,
  type RsiContextTrade,
} from "./RsiContextOneMinuteEngine";

type Direction = RsiContextSide | "neutral";
type Breakout = { side: RsiContextSide; level: number; signalTime: number; expiresAt: number };
type Pending = { side: RsiContextSide; signalTime: number; atr5m: number; structurePrice: number };
type Position = {
  symbol: RsiContextSymbol;
  side: RsiContextSide;
  contextSignalTime: number;
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
  plannedRisk: number;
  entryFee: number;
};
type TrendState = { ema20: Ema; ema50: Ema; ema20History: number[]; direction: Direction };
type SymbolState = {
  fiveMinute: CandleAggregator;
  fifteenMinute: CandleAggregator;
  oneHour: CandleAggregator;
  fiveMinuteAtr: WilderAtr;
  fifteenMinuteAtr: WilderAtr;
  fifteenMinuteTrend: TrendState;
  oneHourTrend: TrendState;
  recentFifteenMinute: Candle[];
  breakout: Breakout | null;
  pending: Pending | null;
  position: Position | null;
  cooldownUntil: number;
  lastClose: number | null;
};
type Drawdown = { peak: number; maximumFraction: number; initialized: boolean };

export type StructureBreakoutDiagnostics = {
  alignedBreakouts: number;
  retestSignals: number;
  entries: number;
  structureRejected: number;
  sessionCanceled: number;
};

export class StructureBreakoutOneMinutePortfolio {
  private realizedEquity: number;
  private readonly states = new Map<RsiContextSymbol, SymbolState>();
  private readonly trades: RsiContextTrade[] = [];
  private readonly drawdowns = new Map<string, Drawdown>();
  private readonly diagnostics: StructureBreakoutDiagnostics = {
    alignedBreakouts: 0,
    retestSignals: 0,
    entries: 0,
    structureRejected: 0,
    sessionCanceled: 0,
  };

  constructor(
    readonly config: RsiContextExecutionConfig,
    readonly assumptions: RsiContextExecutionAssumptions = {
      ...DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
      maxHoldingSeconds: 240 * 60,
    },
  ) {
    this.realizedEquity = assumptions.initialEquity;
    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      this.states.set(symbol, {
        fiveMinute: new CandleAggregator(300, "5m"),
        fifteenMinute: new CandleAggregator(900, "15m"),
        oneHour: new CandleAggregator(3_600, "1h"),
        fiveMinuteAtr: new WilderAtr(14),
        fifteenMinuteAtr: new WilderAtr(14),
        fifteenMinuteTrend: trendState(),
        oneHourTrend: trendState(),
        recentFifteenMinute: [],
        breakout: null,
        pending: null,
        position: null,
        cooldownUntil: 0,
        lastClose: null,
      });
    }
  }

  processMinute(candles: Partial<Record<RsiContextSymbol, Candle>>, stage: string | null) {
    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      const candle = candles[symbol];
      if (!candle) continue;
      const state = this.requireState(symbol);
      this.updateHigherTimeframes(state, candle, stage);
      if (!stage) {
        state.breakout = null;
        state.pending = null;
      }
      this.executePending(symbol, state, candle);
      this.evaluateExit(state, candle);
      state.lastClose = candle.close;

      if (state.breakout && (
        candle.time + 60 > state.breakout.expiresAt
        || state.breakout.side !== state.fifteenMinuteTrend.direction
        || state.breakout.side !== state.oneHourTrend.direction
      )) state.breakout = null;

      if (
        stage
        && state.breakout
        && !state.position
        && !state.pending
        && candle.time >= state.cooldownUntil
        && state.fiveMinuteAtr.value !== null
        && sessionEligible(candle.time)
      ) {
        const atr5m = state.fiveMinuteAtr.value;
        const retested = state.breakout.side === "long"
          ? candle.low <= state.breakout.level + 0.1 * atr5m && candle.close > state.breakout.level && candle.close > candle.open
          : candle.high >= state.breakout.level - 0.1 * atr5m && candle.close < state.breakout.level && candle.close < candle.open;
        if (retested) {
          state.pending = {
            side: state.breakout.side,
            signalTime: candle.time + 60,
            atr5m,
            structurePrice: state.breakout.side === "long"
              ? candle.low - 0.25 * atr5m
              : candle.high + 0.25 * atr5m,
          };
          state.breakout = null;
          this.diagnostics.retestSignals += 1;
        }
      }
    }
    if (stage) this.updateDrawdown(stage);
  }

  finish(lastTime: number) {
    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      const state = this.requireState(symbol);
      if (state.position && state.lastClose !== null) this.closePosition(state, lastTime, state.lastClose, "end_of_data");
    }
  }

  snapshot(): RsiContextPortfolioSnapshot & { diagnostics: StructureBreakoutDiagnostics } {
    return {
      config: this.config,
      assumptions: this.assumptions,
      realizedEquity: this.realizedEquity,
      markedEquity: this.markedEquity(),
      trades: [...this.trades],
      drawdownByStage: Object.fromEntries([...this.drawdowns].map(([key, value]) => [key, value.maximumFraction])),
      openPositionCount: [...this.states.values()].filter((state) => state.position).length,
      diagnostics: { ...this.diagnostics },
    };
  }

  private updateHigherTimeframes(state: SymbolState, candle: Candle, stage: string | null) {
    const completed5m = state.fiveMinute.update(candle);
    if (completed5m) state.fiveMinuteAtr.update(completed5m);

    const completed1h = state.oneHour.update(candle);
    if (completed1h) updateTrend(state.oneHourTrend, completed1h);

    const completed15m = state.fifteenMinute.update(candle);
    if (!completed15m) return;
    const atr15m = state.fifteenMinuteAtr.update(completed15m);
    updateTrend(state.fifteenMinuteTrend, completed15m);
    if (
      stage
      && sessionEligible(candle.time)
      && !state.position
      && !state.pending
      && atr15m !== null
      && state.recentFifteenMinute.length === 20
      && state.fifteenMinuteTrend.direction !== "neutral"
      && state.fifteenMinuteTrend.direction === state.oneHourTrend.direction
    ) {
      const high = Math.max(...state.recentFifteenMinute.map((item) => item.high));
      const low = Math.min(...state.recentFifteenMinute.map((item) => item.low));
      const range = completed15m.high - completed15m.low;
      const body = Math.abs(completed15m.close - completed15m.open);
      const direction = state.fifteenMinuteTrend.direction;
      const longBreakout = direction === "long"
        && completed15m.close > high
        && completed15m.close > completed15m.open
        && body >= 0.5 * atr15m
        && range > 0
        && (completed15m.close - completed15m.low) / range >= 0.75;
      const shortBreakout = direction === "short"
        && completed15m.close < low
        && completed15m.close < completed15m.open
        && body >= 0.5 * atr15m
        && range > 0
        && (completed15m.high - completed15m.close) / range >= 0.75;
      if (longBreakout || shortBreakout) {
        state.breakout = {
          side: longBreakout ? "long" : "short",
          level: longBreakout ? high : low,
          signalTime: candle.time,
          expiresAt: candle.time + 60 * 60,
        };
        this.diagnostics.alignedBreakouts += 1;
      }
    }
    state.recentFifteenMinute.push(completed15m);
    if (state.recentFifteenMinute.length > 20) state.recentFifteenMinute.shift();
  }

  private executePending(symbol: RsiContextSymbol, state: SymbolState, candle: Candle) {
    const pending = state.pending;
    if (!pending || state.position) return;
    state.pending = null;
    if (!sessionEligible(candle.time)) {
      this.diagnostics.sessionCanceled += 1;
      return;
    }
    const slip = this.assumptions.slippageFractionPerSide;
    const entryPrice = pending.side === "long" ? candle.open * (1 + slip) : candle.open * (1 - slip);
    const structureDistance = pending.side === "long" ? entryPrice - pending.structurePrice : pending.structurePrice - entryPrice;
    if (structureDistance > 2.5 * pending.atr5m) {
      this.diagnostics.structureRejected += 1;
      return;
    }
    const stopDistance = Math.max(this.config.stopAtrMultiple * pending.atr5m, structureDistance);
    if (!(stopDistance > 0)) return;
    const equity = Math.max(0, this.markedEquity());
    const quantity = Math.min(
      equity * this.assumptions.riskFraction / stopDistance,
      equity * this.assumptions.notionalEquityCap / entryPrice,
    );
    if (!(quantity > 0)) return;
    const stopPrice = pending.side === "long" ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = pending.side === "long"
      ? entryPrice + stopDistance * this.config.targetRMultiple
      : entryPrice - stopDistance * this.config.targetRMultiple;
    const entryFee = entryPrice * quantity * this.assumptions.feeRatePerSide;
    this.realizedEquity -= entryFee;
    state.position = {
      symbol,
      side: pending.side,
      contextSignalTime: pending.signalTime,
      entryTime: candle.time,
      entryPrice,
      stopPrice,
      targetPrice,
      quantity,
      plannedRisk: stopDistance * quantity,
      entryFee,
    };
    this.diagnostics.entries += 1;
  }

  private evaluateExit(state: SymbolState, candle: Candle) {
    const position = state.position;
    if (!position) return;
    const stopHit = position.side === "long" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
    const targetHit = position.side === "long" ? candle.high >= position.targetPrice : candle.low <= position.targetPrice;
    if (stopHit) return this.closePosition(state, candle.time, position.stopPrice, "stop");
    if (targetHit) return this.closePosition(state, candle.time, position.targetPrice, "target");
    if (candle.time + 60 - position.entryTime >= this.assumptions.maxHoldingSeconds) {
      this.closePosition(state, candle.time + 60, candle.close, "time");
    }
  }

  private closePosition(state: SymbolState, exitTime: number, rawExit: number, reason: RsiContextTrade["exitReason"]) {
    const position = state.position;
    if (!position) return;
    const slip = this.assumptions.slippageFractionPerSide;
    const exitPrice = position.side === "long" ? rawExit * (1 - slip) : rawExit * (1 + slip);
    const grossPnl = position.side === "long"
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;
    const exitFee = exitPrice * position.quantity * this.assumptions.feeRatePerSide;
    this.realizedEquity += grossPnl - exitFee;
    const netPnl = grossPnl - position.entryFee - exitFee;
    this.trades.push({
      symbol: position.symbol,
      side: position.side,
      contextSignalTime: position.contextSignalTime,
      entryTime: position.entryTime,
      exitTime,
      entryPrice: position.entryPrice,
      exitPrice,
      stopPrice: position.stopPrice,
      targetPrice: position.targetPrice,
      quantity: position.quantity,
      plannedRisk: position.plannedRisk,
      netPnl,
      rMultiple: position.plannedRisk > 0 ? netPnl / position.plannedRisk : 0,
      fees: position.entryFee + exitFee,
      exitReason: reason,
    });
    state.position = null;
    state.cooldownUntil = exitTime + 15 * 60;
    state.breakout = null;
  }

  private markedEquity() {
    let equity = this.realizedEquity;
    for (const state of this.states.values()) {
      if (!state.position || state.lastClose === null) continue;
      const position = state.position;
      const slip = this.assumptions.slippageFractionPerSide;
      const price = position.side === "long" ? state.lastClose * (1 - slip) : state.lastClose * (1 + slip);
      const gross = position.side === "long"
        ? (price - position.entryPrice) * position.quantity
        : (position.entryPrice - price) * position.quantity;
      equity += gross - price * position.quantity * this.assumptions.feeRatePerSide;
    }
    return equity;
  }

  private updateDrawdown(stage: string) {
    const equity = this.markedEquity();
    const drawdown = this.drawdowns.get(stage) ?? { peak: equity, maximumFraction: 0, initialized: false };
    if (!drawdown.initialized) { drawdown.peak = equity; drawdown.initialized = true; }
    drawdown.peak = Math.max(drawdown.peak, equity);
    if (drawdown.peak > 0) drawdown.maximumFraction = Math.max(drawdown.maximumFraction, (drawdown.peak - equity) / drawdown.peak);
    this.drawdowns.set(stage, drawdown);
  }

  private requireState(symbol: RsiContextSymbol) {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`Missing structure breakout state for ${symbol}.`);
    return state;
  }
}

function trendState(): TrendState {
  return { ema20: new Ema(20), ema50: new Ema(50), ema20History: [], direction: "neutral" };
}

function updateTrend(state: TrendState, candle: Candle) {
  const ema20 = state.ema20.update(candle.close);
  const ema50 = state.ema50.update(candle.close);
  if (ema20 !== null) {
    state.ema20History.push(ema20);
    if (state.ema20History.length > 4) state.ema20History.shift();
  }
  if (ema20 === null || ema50 === null || state.ema20History.length < 4) {
    state.direction = "neutral";
    return;
  }
  const prior = state.ema20History[0];
  state.direction = ema20 > ema50 && candle.close > ema20 && ema20 > prior
    ? "long"
    : ema20 < ema50 && candle.close < ema20 && ema20 < prior
      ? "short"
      : "neutral";
}

function sessionEligible(time: number) {
  return new Date(time * 1000).getUTCHours() >= 8;
}

class Ema {
  private current: number | null = null;
  private samples = 0;
  private readonly alpha: number;
  constructor(private readonly period: number) { this.alpha = 2 / (period + 1); }
  update(value: number) {
    this.current = this.current === null ? value : value * this.alpha + this.current * (1 - this.alpha);
    this.samples += 1;
    return this.samples >= this.period ? this.current : null;
  }
}

class WilderAtr {
  private previousClose: number | null = null;
  private current = 0;
  private samples = 0;
  value: number | null = null;
  constructor(private readonly period: number) {}
  update(candle: Candle) {
    const range = this.previousClose === null
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low, Math.abs(candle.high - this.previousClose), Math.abs(candle.low - this.previousClose));
    this.previousClose = candle.close;
    this.samples += 1;
    this.current = this.samples <= this.period ? this.current + range / this.period : (this.current * (this.period - 1) + range) / this.period;
    this.value = this.samples >= this.period ? this.current : null;
    return this.value;
  }
}

class CandleAggregator {
  private current: Candle | null = null;
  constructor(private readonly seconds: number, private readonly interval: "5m" | "15m" | "1h") {}
  update(candle: Candle) {
    const bucket = Math.floor(candle.time / this.seconds) * this.seconds;
    let completed: Candle | null = null;
    if (this.current && this.current.time !== bucket) { completed = this.current; this.current = null; }
    if (!this.current) this.current = { ...candle, interval: this.interval, time: bucket };
    else {
      this.current.high = Math.max(this.current.high, candle.high);
      this.current.low = Math.min(this.current.low, candle.low);
      this.current.close = candle.close;
      this.current.volume += candle.volume;
    }
    return completed;
  }
}
