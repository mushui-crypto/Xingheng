import type { Candle } from "../../../types";

export const RSI_CONTEXT_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export type RsiContextSymbol = typeof RSI_CONTEXT_SYMBOLS[number];
export type RsiContextSide = "long" | "short";
export type RsiContextTrend = "uptrend" | "downtrend" | "neutral";

export type RsiContextEvent = {
  symbol: RsiContextSymbol;
  type: "oversold" | "overbought";
  signalTime: number;
  trendRegime: RsiContextTrend;
  session: string;
};

export type RsiContextExecutionConfig = {
  id: string;
  stopAtrMultiple: number;
  targetRMultiple: number;
};

export type RsiContextExecutionAssumptions = {
  initialEquity: number;
  riskFraction: number;
  notionalEquityCap: number;
  feeRatePerSide: number;
  slippageFractionPerSide: number;
  maxHoldingSeconds: number;
  contextLifetimeSeconds: number;
  rsiPeriod: number;
  emaPeriod: number;
  atrPeriod: number;
};

export type RsiContextTrade = {
  symbol: RsiContextSymbol;
  side: RsiContextSide;
  contextSignalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
  plannedRisk: number;
  netPnl: number;
  rMultiple: number;
  fees: number;
  exitReason: "stop" | "target" | "time" | "end_of_data";
};

type ActiveContext = {
  signalTime: number;
  expiresAt: number;
  side: RsiContextSide;
};

type PendingEntry = {
  contextSignalTime: number;
  side: RsiContextSide;
  atr: number;
};

type OpenPosition = {
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
  rsi: WilderRsi;
  ema: Ema;
  atr: WilderAtr;
  previousRsi: number | null;
  activeContext: ActiveContext | null;
  pendingEntry: PendingEntry | null;
  position: OpenPosition | null;
  lastClose: number | null;
};

type DrawdownState = {
  peak: number;
  maximumFraction: number;
  initialized: boolean;
};

export type RsiContextPortfolioSnapshot = {
  config: RsiContextExecutionConfig;
  assumptions: RsiContextExecutionAssumptions;
  realizedEquity: number;
  markedEquity: number;
  trades: RsiContextTrade[];
  drawdownByStage: Record<string, number>;
  openPositionCount: number;
};

export const DEFAULT_RSI_CONTEXT_ASSUMPTIONS: RsiContextExecutionAssumptions = {
  initialEquity: 10_000,
  riskFraction: 0.0025,
  notionalEquityCap: 1,
  feeRatePerSide: 0.00045,
  slippageFractionPerSide: 0.0001,
  maxHoldingSeconds: 60 * 60,
  contextLifetimeSeconds: 60 * 60,
  rsiPeriod: 7,
  emaPeriod: 20,
  atrPeriod: 14,
};

export class RsiContextOneMinutePortfolio {
  private realizedEquity: number;
  private readonly states = new Map<RsiContextSymbol, SymbolState>();
  private readonly trades: RsiContextTrade[] = [];
  private readonly drawdowns = new Map<string, DrawdownState>();

  constructor(
    readonly config: RsiContextExecutionConfig,
    readonly assumptions: RsiContextExecutionAssumptions = DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
  ) {
    this.realizedEquity = assumptions.initialEquity;
    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      this.states.set(symbol, {
        rsi: new WilderRsi(assumptions.rsiPeriod),
        ema: new Ema(assumptions.emaPeriod),
        atr: new WilderAtr(assumptions.atrPeriod),
        previousRsi: null,
        activeContext: null,
        pendingEntry: null,
        position: null,
        lastClose: null,
      });
    }
  }

  processMinute(
    candles: Partial<Record<RsiContextSymbol, Candle>>,
    contexts: RsiContextEvent[],
    stage: string | null,
  ) {
    const contextsBySymbol = new Map<RsiContextSymbol, RsiContextEvent[]>();
    for (const context of contexts) {
      contextsBySymbol.set(context.symbol, [...(contextsBySymbol.get(context.symbol) ?? []), context]);
    }

    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      const candle = candles[symbol];
      if (!candle) continue;
      const state = this.requireState(symbol);
      this.executePending(symbol, state, candle);
      this.evaluateExit(state, candle);

      const previousRsi = state.previousRsi;
      const currentRsi = state.rsi.update(candle.close);
      const currentEma = state.ema.update(candle.close);
      const currentAtr = state.atr.update(candle);
      state.previousRsi = currentRsi;
      state.lastClose = candle.close;

      for (const context of contextsBySymbol.get(symbol) ?? []) {
        const eligible = eligibleContext(context, this.assumptions.contextLifetimeSeconds);
        if (eligible) state.activeContext = eligible;
      }
      if (state.activeContext && candle.time + 60 > state.activeContext.expiresAt) state.activeContext = null;

      if (
        !state.position
        && !state.pendingEntry
        && state.activeContext
        && previousRsi !== null
        && currentRsi !== null
        && currentEma !== null
        && currentAtr !== null
      ) {
        const side = state.activeContext.side;
        const recovered = side === "long"
          ? previousRsi <= 35 && currentRsi > 35 && candle.close > currentEma
          : previousRsi >= 65 && currentRsi < 65 && candle.close < currentEma;
        if (recovered) {
          state.pendingEntry = {
            contextSignalTime: state.activeContext.signalTime,
            side,
            atr: currentAtr,
          };
          state.activeContext = null;
        }
      }
    }

    if (stage) this.updateDrawdown(stage);
  }

  finish(lastTime: number) {
    for (const symbol of RSI_CONTEXT_SYMBOLS) {
      const state = this.requireState(symbol);
      if (!state.position || state.lastClose === null) continue;
      this.closePosition(state, lastTime, state.lastClose, "end_of_data");
    }
  }

  snapshot(): RsiContextPortfolioSnapshot {
    return {
      config: this.config,
      assumptions: this.assumptions,
      realizedEquity: this.realizedEquity,
      markedEquity: this.markedEquity(),
      trades: [...this.trades],
      drawdownByStage: Object.fromEntries([...this.drawdowns.entries()].map(([stage, value]) => [stage, value.maximumFraction])),
      openPositionCount: [...this.states.values()].filter((state) => state.position).length,
    };
  }

  private executePending(symbol: RsiContextSymbol, state: SymbolState, candle: Candle) {
    const pending = state.pendingEntry;
    if (!pending || state.position) return;
    state.pendingEntry = null;
    const slip = this.assumptions.slippageFractionPerSide;
    const entryPrice = pending.side === "long" ? candle.open * (1 + slip) : candle.open * (1 - slip);
    const stopDistance = pending.atr * this.config.stopAtrMultiple;
    if (!(entryPrice > 0) || !(stopDistance > 0)) return;
    const equity = Math.max(0, this.markedEquity());
    const plannedRiskBudget = equity * this.assumptions.riskFraction;
    const riskQuantity = plannedRiskBudget / stopDistance;
    const cappedQuantity = equity * this.assumptions.notionalEquityCap / entryPrice;
    const quantity = Math.min(riskQuantity, cappedQuantity);
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
      contextSignalTime: pending.contextSignalTime,
      entryTime: candle.time,
      entryPrice,
      stopPrice,
      targetPrice,
      quantity,
      plannedRisk: stopDistance * quantity,
      entryFee,
    };
  }

  private evaluateExit(state: SymbolState, candle: Candle) {
    const position = state.position;
    if (!position) return;
    const stopHit = position.side === "long" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
    const targetHit = position.side === "long" ? candle.high >= position.targetPrice : candle.low <= position.targetPrice;
    if (stopHit) {
      this.closePosition(state, candle.time, position.stopPrice, "stop");
      return;
    }
    if (targetHit) {
      this.closePosition(state, candle.time, position.targetPrice, "target");
      return;
    }
    if (candle.time + 60 - position.entryTime >= this.assumptions.maxHoldingSeconds) {
      this.closePosition(state, candle.time + 60, candle.close, "time");
    }
  }

  private closePosition(
    state: SymbolState,
    exitTime: number,
    rawExitPrice: number,
    exitReason: RsiContextTrade["exitReason"],
  ) {
    const position = state.position;
    if (!position) return;
    const slip = this.assumptions.slippageFractionPerSide;
    const exitPrice = position.side === "long" ? rawExitPrice * (1 - slip) : rawExitPrice * (1 + slip);
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
      exitReason,
    });
    state.position = null;
  }

  private markedEquity() {
    let equity = this.realizedEquity;
    for (const state of this.states.values()) {
      const position = state.position;
      const rawPrice = state.lastClose;
      if (!position || rawPrice === null) continue;
      const slip = this.assumptions.slippageFractionPerSide;
      const price = position.side === "long" ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
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
    if (!drawdown.initialized) {
      drawdown.peak = equity;
      drawdown.initialized = true;
    }
    drawdown.peak = Math.max(drawdown.peak, equity);
    if (drawdown.peak > 0) drawdown.maximumFraction = Math.max(drawdown.maximumFraction, (drawdown.peak - equity) / drawdown.peak);
    this.drawdowns.set(stage, drawdown);
  }

  private requireState(symbol: RsiContextSymbol) {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`Missing RSI context state for ${symbol}.`);
    return state;
  }
}

function eligibleContext(event: RsiContextEvent, lifetime: number): ActiveContext | null {
  if (event.session !== "america_16_24_utc") return null;
  if (event.type === "oversold" && (event.trendRegime === "uptrend" || event.trendRegime === "neutral")) {
    return { signalTime: event.signalTime, expiresAt: event.signalTime + lifetime, side: "long" };
  }
  if (event.type === "overbought" && event.trendRegime === "neutral") {
    return { signalTime: event.signalTime, expiresAt: event.signalTime + lifetime, side: "short" };
  }
  return null;
}

class Ema {
  private value: number | null = null;
  private samples = 0;
  private readonly alpha: number;

  constructor(private readonly period: number) {
    this.alpha = 2 / (period + 1);
  }

  update(close: number) {
    this.value = this.value === null ? close : close * this.alpha + this.value * (1 - this.alpha);
    this.samples += 1;
    return this.samples >= this.period ? this.value : null;
  }
}

class WilderRsi {
  private previousClose: number | null = null;
  private averageGain = 0;
  private averageLoss = 0;
  private changes = 0;

  constructor(private readonly period: number) {}

  update(close: number) {
    if (this.previousClose === null) {
      this.previousClose = close;
      return null;
    }
    const change = close - this.previousClose;
    this.previousClose = close;
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    this.changes += 1;
    if (this.changes <= this.period) {
      this.averageGain += gain / this.period;
      this.averageLoss += loss / this.period;
      return this.changes === this.period ? rsiFromAverages(this.averageGain, this.averageLoss) : null;
    }
    this.averageGain = (this.averageGain * (this.period - 1) + gain) / this.period;
    this.averageLoss = (this.averageLoss * (this.period - 1) + loss) / this.period;
    return rsiFromAverages(this.averageGain, this.averageLoss);
  }
}

class WilderAtr {
  private previousClose: number | null = null;
  private value = 0;
  private samples = 0;

  constructor(private readonly period: number) {}

  update(candle: Candle) {
    const trueRange = this.previousClose === null
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low, Math.abs(candle.high - this.previousClose), Math.abs(candle.low - this.previousClose));
    this.previousClose = candle.close;
    this.samples += 1;
    if (this.samples <= this.period) {
      this.value += trueRange / this.period;
      return this.samples === this.period ? this.value : null;
    }
    this.value = (this.value * (this.period - 1) + trueRange) / this.period;
    return this.value;
  }
}

function rsiFromAverages(averageGain: number, averageLoss: number) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}
