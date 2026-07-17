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

type Trend = RsiContextSide | "neutral";
type Pullback = {
  side: RsiContextSide;
  armedAt: number;
  expiresAt: number;
  extreme: number;
};
type Pending = {
  side: RsiContextSide;
  signalTime: number;
  atr5m: number;
  structurePrice: number;
};
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
type SymbolState = {
  oneMinuteRsi: WilderRsi;
  oneMinuteEma: Ema;
  fiveMinute: CandleAggregator;
  fifteenMinute: CandleAggregator;
  fiveMinuteAtr: WilderAtr;
  fifteenMinuteEma20: Ema;
  fifteenMinuteEma50: Ema;
  fifteenMinuteEma20History: number[];
  fifteenMinuteEma50Value: number | null;
  trend: Trend;
  previousClose: number | null;
  pullback: Pullback | null;
  pending: Pending | null;
  position: Position | null;
  cooldownUntil: number;
  lastClose: number | null;
};
type Drawdown = { peak: number; maximumFraction: number; initialized: boolean };

export type TrendPullbackDiagnostics = {
  pullbacksArmed: number;
  recoverySignals: number;
  entries: number;
  structureRejected: number;
  sessionCanceled: number;
};

export class TrendPullbackOneMinutePortfolio {
  private realizedEquity: number;
  private readonly states = new Map<RsiContextSymbol, SymbolState>();
  private readonly trades: RsiContextTrade[] = [];
  private readonly drawdowns = new Map<string, Drawdown>();
  private readonly diagnostics: TrendPullbackDiagnostics = {
    pullbacksArmed: 0,
    recoverySignals: 0,
    entries: 0,
    structureRejected: 0,
    sessionCanceled: 0,
  };

  constructor(
    readonly config: RsiContextExecutionConfig,
    readonly assumptions: RsiContextExecutionAssumptions = {
      ...DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
      maxHoldingSeconds: 120 * 60,
    },
  ) {
    this.realizedEquity = assumptions.initialEquity;
    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      this.states.set(symbol, {
        oneMinuteRsi: new WilderRsi(7),
        oneMinuteEma: new Ema(20),
        fiveMinute: new CandleAggregator(300, "5m"),
        fifteenMinute: new CandleAggregator(900, "15m"),
        fiveMinuteAtr: new WilderAtr(14),
        fifteenMinuteEma20: new Ema(20),
        fifteenMinuteEma50: new Ema(50),
        fifteenMinuteEma20History: [],
        fifteenMinuteEma50Value: null,
        trend: "neutral",
        previousClose: null,
        pullback: null,
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
      this.updateHigherTimeframes(state, candle);
      if (!stage) {
        state.pullback = null;
        state.pending = null;
      }
      this.executePending(symbol, state, candle);
      this.evaluateExit(state, candle);

      const previousClose = state.previousClose;
      const rsi = state.oneMinuteRsi.update(candle.close);
      const ema = state.oneMinuteEma.update(candle.close);
      state.previousClose = candle.close;
      state.lastClose = candle.close;

      const eligibleSession = sessionEligible(candle.time);
      if (!eligibleSession || state.trend === "neutral") state.pullback = null;
      if (state.pullback && (candle.time + 60 > state.pullback.expiresAt || state.pullback.side !== state.trend)) state.pullback = null;

      if (
        stage !== null
        && eligibleSession
        && !state.position
        && !state.pending
        && candle.time >= state.cooldownUntil
        && rsi !== null
        && ema !== null
        && state.fifteenMinuteEma50Value !== null
        && state.fiveMinuteAtr.value !== null
      ) {
        if (!state.pullback) {
          const armLong = state.trend === "long" && rsi <= 45 && candle.low <= ema && candle.close > state.fifteenMinuteEma50Value;
          const armShort = state.trend === "short" && rsi >= 55 && candle.high >= ema && candle.close < state.fifteenMinuteEma50Value;
          if (armLong || armShort) {
            state.pullback = {
              side: armLong ? "long" : "short",
              armedAt: candle.time + 60,
              expiresAt: candle.time + 60 + 10 * 60,
              extreme: armLong ? candle.low : candle.high,
            };
            this.diagnostics.pullbacksArmed += 1;
          }
        } else {
          state.pullback.extreme = state.pullback.side === "long"
            ? Math.min(state.pullback.extreme, candle.low)
            : Math.max(state.pullback.extreme, candle.high);
          const recovered = state.pullback.side === "long"
            ? rsi >= 50 && candle.close > ema && previousClose !== null && candle.close > previousClose
            : rsi <= 50 && candle.close < ema && previousClose !== null && candle.close < previousClose;
          if (recovered) {
            const atr5m = state.fiveMinuteAtr.value;
            state.pending = {
              side: state.pullback.side,
              signalTime: candle.time + 60,
              atr5m,
              structurePrice: state.pullback.side === "long"
                ? state.pullback.extreme - 0.1 * atr5m
                : state.pullback.extreme + 0.1 * atr5m,
            };
            state.pullback = null;
            this.diagnostics.recoverySignals += 1;
          }
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

  snapshot(): RsiContextPortfolioSnapshot & { diagnostics: TrendPullbackDiagnostics } {
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

  private updateHigherTimeframes(state: SymbolState, candle: Candle) {
    const completed5m = state.fiveMinute.update(candle);
    if (completed5m) state.fiveMinuteAtr.update(completed5m);
    const completed15m = state.fifteenMinute.update(candle);
    if (!completed15m) return;
    const ema20 = state.fifteenMinuteEma20.update(completed15m.close);
    const ema50 = state.fifteenMinuteEma50.update(completed15m.close);
    if (ema20 !== null) {
      state.fifteenMinuteEma20History.push(ema20);
      if (state.fifteenMinuteEma20History.length > 5) state.fifteenMinuteEma20History.shift();
    }
    state.fifteenMinuteEma50Value = ema50;
    if (ema20 === null || ema50 === null || state.fifteenMinuteEma20History.length < 5) {
      state.trend = "neutral";
      return;
    }
    const prior = state.fifteenMinuteEma20History[0];
    state.trend = ema20 > ema50 && completed15m.close > ema20 && ema20 > prior
      ? "long"
      : ema20 < ema50 && completed15m.close < ema20 && ema20 < prior
        ? "short"
        : "neutral";
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
    const stopDistance = Math.max(pending.atr5m * this.config.stopAtrMultiple, structureDistance);
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
    state.pullback = null;
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
    const state = this.drawdowns.get(stage) ?? { peak: equity, maximumFraction: 0, initialized: false };
    if (!state.initialized) {
      state.peak = equity;
      state.initialized = true;
    }
    state.peak = Math.max(state.peak, equity);
    if (state.peak > 0) state.maximumFraction = Math.max(state.maximumFraction, (state.peak - equity) / state.peak);
    this.drawdowns.set(stage, state);
  }

  private requireState(symbol: RsiContextSymbol) {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`Missing trend pullback state for ${symbol}.`);
    return state;
  }
}

function sessionEligible(time: number) {
  const hour = new Date(time * 1000).getUTCHours();
  return hour >= 8;
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

class WilderRsi {
  private previous: number | null = null;
  private averageGain = 0;
  private averageLoss = 0;
  private changes = 0;
  constructor(private readonly period: number) {}
  update(close: number) {
    if (this.previous === null) { this.previous = close; return null; }
    const change = close - this.previous;
    this.previous = close;
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    this.changes += 1;
    if (this.changes <= this.period) {
      this.averageGain += gain / this.period;
      this.averageLoss += loss / this.period;
      return this.changes === this.period ? rsi(this.averageGain, this.averageLoss) : null;
    }
    this.averageGain = (this.averageGain * (this.period - 1) + gain) / this.period;
    this.averageLoss = (this.averageLoss * (this.period - 1) + loss) / this.period;
    return rsi(this.averageGain, this.averageLoss);
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
  constructor(private readonly seconds: number, private readonly interval: "5m" | "15m") {}
  update(candle: Candle) {
    const bucket = Math.floor(candle.time / this.seconds) * this.seconds;
    let completed: Candle | null = null;
    if (this.current && this.current.time !== bucket) {
      completed = this.current;
      this.current = null;
    }
    if (!this.current) {
      this.current = { ...candle, interval: this.interval, time: bucket };
    } else {
      this.current.high = Math.max(this.current.high, candle.high);
      this.current.low = Math.min(this.current.low, candle.low);
      this.current.close = candle.close;
      this.current.volume += candle.volume;
    }
    return completed;
  }
}

function rsi(gain: number, loss: number) {
  if (loss === 0) return gain === 0 ? 50 : 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}
