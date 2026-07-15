import type { Candle } from "../../../types";
import type { Strategy, StrategySignal } from "../core/types";
import { isWithinTimeZoneSession, newYorkTime } from "../ict/time";

export type BacktestConfig = {
  initialEquity: number;
  makerEntryFeeRate: number;
  takerEntryFeeRate?: number;
  takerExitFeeRate: number;
  slippageBps: number;
  maxLeverage: number;
  dailyLossFraction: number;
  maxTradesPerDay: number;
  maxConsecutiveLossesPerDay: number;
  minNetRewardRisk: number;
  sessionStartMinute: number;
  sessionEndMinute: number;
  stopExecutionMode?: "hard" | "session_close_only";
  sessionTimeZone?: string;
  closePositionAtSessionEnd?: boolean;
  accountRiskControlsEnabled?: boolean;
  positionSizingMode?: "risk_fraction" | "fixed_margin_fraction";
  positionMarginFraction?: number;
  positionLeverage?: number;
  positionMarginMode?: "isolated" | "cross";
  liquidationMaintenanceMarginRate?: number;
  liquidationFeeRate?: number;
};

export const defaultBacktestConfig: BacktestConfig = {
  initialEquity: 10_000,
  makerEntryFeeRate: 0.00015,
  takerEntryFeeRate: 0.00045,
  takerExitFeeRate: 0.00045,
  slippageBps: 1,
  maxLeverage: 3,
  dailyLossFraction: 0.01,
  maxTradesPerDay: 2,
  maxConsecutiveLossesPerDay: 2,
  minNetRewardRisk: 1.5,
  sessionStartMinute: 8 * 60 + 30,
  sessionEndMinute: 11 * 60,
  stopExecutionMode: "hard",
  sessionTimeZone: "America/New_York",
  closePositionAtSessionEnd: true,
  accountRiskControlsEnabled: true,
  positionSizingMode: "risk_fraction",
};

export type BacktestTrade = {
  signalId: string;
  side: "long" | "short";
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  rMultiple: number;
  liquidationPrice: number | null;
  allocatedMargin: number | null;
  marginMode: "isolated" | "cross" | null;
  liquidationCollateral: number | null;
  exitReason: "stop" | "target" | "liquidation" | "session_close" | "end_of_data";
  regimeKey: string;
  maxAdverseR: number;
};

export type BacktestResult = {
  strategyId: string;
  symbol: string;
  from: number | null;
  to: number | null;
  config: BacktestConfig;
  trades: BacktestTrade[];
  diagnostics: {
    signals: number;
    expiredOrders: number;
    costRejectedOrders: number;
    filledOrders: number;
    byRegime: Record<string, { signals: number; expired: number; costRejected: number; filled: number }>;
  };
  metrics: ReturnType<typeof calculateMetrics>;
};

type PendingOrder = { signal: StrategySignal };
type OpenPosition = {
  signal: StrategySignal;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  entryFee: number;
  initialRisk: number;
  maxAdversePriceDistance: number;
  liquidationPrice: number | null;
  allocatedMargin: number | null;
  marginMode: "isolated" | "cross" | null;
  liquidationCollateral: number | null;
};

export class BacktestEngine {
  constructor(
    private strategy: Strategy,
    private config: BacktestConfig = defaultBacktestConfig,
  ) {}

  run(inputCandles: Candle[]): BacktestResult {
    const candles = normalizeCandles(inputCandles);
    this.strategy.prepare?.(candles);
    let equity = this.config.initialEquity;
    let peakEquity = equity;
    let pending: PendingOrder | null = null;
    let position: OpenPosition | null = null;
    const trades: BacktestTrade[] = [];
    const diagnostics = {
      signals: 0,
      expiredOrders: 0,
      costRejectedOrders: 0,
      filledOrders: 0,
      byRegime: {} as Record<string, { signals: number; expired: number; costRejected: number; filled: number }>,
    };
    const equityCurve: Array<{ time: number; equity: number }> = [];
    let dayState = makeDayState(candles[0]?.time ?? 0, equity);
    const recordClosedTrade = (closed: BacktestTrade) => {
      trades.push(closed);
      equity += closed.netPnl;
      peakEquity = Math.max(peakEquity, equity);
      dayState.trades += 1;
      dayState.pnl += closed.netPnl;
      dayState.consecutiveLosses = closed.netPnl < 0 ? dayState.consecutiveLosses + 1 : 0;
    };

    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      const dateKey = newYorkTime(candle.time).dateKey;
      if (dateKey !== dayState.dateKey) dayState = makeDayState(candle.time, equity);

      if (position) {
        const closed = this.tryExit(position, candle);
        if (closed) {
          recordClosedTrade(closed);
          position = null;
        }
      }

      if (!position && pending) {
        if (
          candle.time > pending.signal.expiresAt ||
          !this.isWithinTradingSession(candle.time)
        ) {
          diagnostics.expiredOrders += 1;
          regimeDiagnostics(diagnostics.byRegime, pending.signal).expired += 1;
          pending = null;
        } else if (candle.time > pending.signal.createdAt && touchesEntry(candle, pending.signal)) {
          position = this.open(pending.signal, candle, equity);
          if (position) {
            diagnostics.filledOrders += 1;
            regimeDiagnostics(diagnostics.byRegime, pending.signal).filled += 1;
            const closed = this.tryExit(position, candle);
            if (closed) {
              recordClosedTrade(closed);
              position = null;
            }
          } else {
            diagnostics.costRejectedOrders += 1;
            regimeDiagnostics(diagnostics.byRegime, pending.signal).costRejected += 1;
          }
          pending = null;
        }
      }

      if (
        !position &&
        !pending &&
        (this.config.accountRiskControlsEnabled === false || !isDailyLocked(dayState, this.config))
      ) {
        const signal = this.strategy.evaluate({ candles, index, equity });
        if (signal) {
          diagnostics.signals += 1;
          regimeDiagnostics(diagnostics.byRegime, signal).signals += 1;
        }
        pending = signal ? { signal } : null;
      }
      equityCurve.push({ time: candle.time, equity });
    }

    if (position && candles.length > 0) {
      const last = candles.at(-1)!;
      const closed = this.close(position, last.time, last.close, "end_of_data");
      trades.push(closed);
      equity += closed.netPnl;
      equityCurve.push({ time: last.time, equity });
    }

    return {
      strategyId: this.strategy.id,
      symbol: candles[0]?.symbol ?? "",
      from: candles[0]?.time ?? null,
      to: candles.at(-1)?.time ?? null,
      config: this.config,
      trades,
      diagnostics,
      metrics: calculateMetrics(trades, equityCurve, this.config.initialEquity, peakEquity),
    };
  }

  private open(signal: StrategySignal, candle: Candle, equity: number): OpenPosition | null {
    const isMarket = signal.entryOrderType === "market";
    const rawEntryPrice = isMarket ? candle.open : signal.entryPrice;
    const adverseSlippage = rawEntryPrice * this.config.slippageBps / 10_000;
    const entryPrice = signal.side === "long" ? rawEntryPrice + adverseSlippage : rawEntryPrice - adverseSlippage;
    if (signal.side === "long" ? entryPrice <= signal.stopPrice || entryPrice >= signal.targetPrice : entryPrice >= signal.stopPrice || entryPrice <= signal.targetPrice) {
      return null;
    }
    const stopDistance = Math.abs(entryPrice - signal.stopPrice);
    const entryFeeRate = isMarket ? (this.config.takerEntryFeeRate ?? this.config.takerExitFeeRate) : this.config.makerEntryFeeRate;
    const estimatedStopFeePerUnit = entryPrice * entryFeeRate + signal.stopPrice * this.config.takerExitFeeRate;
    const accountRiskControlsEnabled = this.config.accountRiskControlsEnabled !== false;
    const fixedMarginSizing = this.config.positionSizingMode === "fixed_margin_fraction";
    const marginFraction = this.config.positionMarginFraction ?? 0;
    const positionLeverage = this.config.positionLeverage ?? 0;
    if (fixedMarginSizing && (
      !Number.isFinite(marginFraction) || marginFraction <= 0 || marginFraction > 1 ||
      !Number.isFinite(positionLeverage) || positionLeverage <= 0
    )) return null;
    const allocatedMargin = fixedMarginSizing ? equity * marginFraction : null;
    const marginMode = fixedMarginSizing ? this.config.positionMarginMode ?? "isolated" : null;
    const riskBudget = equity * signal.riskFraction;
    const riskQuantity = riskBudget / (stopDistance + estimatedStopFeePerUnit);
    const leverageQuantity = equity * this.config.maxLeverage / entryPrice;
    const quantity = Math.max(0, fixedMarginSizing
      ? allocatedMargin! * positionLeverage / entryPrice
      : accountRiskControlsEnabled ? Math.min(riskQuantity, leverageQuantity) : riskQuantity);
    const targetDistance = Math.abs(signal.targetPrice - entryPrice);
    const estimatedTargetFees = (
      entryPrice * entryFeeRate + signal.targetPrice * this.config.takerExitFeeRate
    ) * quantity;
    const estimatedStopFees = estimatedStopFeePerUnit * quantity;
    const estimatedNetReward = targetDistance * quantity - estimatedTargetFees;
    const estimatedNetRisk = stopDistance * quantity + estimatedStopFees;
    if (
      quantity <= 0 ||
      estimatedNetRisk <= 0 ||
      (accountRiskControlsEnabled && estimatedNetReward / estimatedNetRisk < this.config.minNetRewardRisk)
    ) {
      return null;
    }
    const entryFee = entryPrice * quantity * entryFeeRate;
    const liquidationCollateral = fixedMarginSizing
      ? marginMode === "cross" ? equity : allocatedMargin
      : null;
    const liquidationPrice = fixedMarginSizing
      ? calculateLinearLiquidationPrice({
        side: signal.side,
        entryPrice,
        quantity,
        availableMargin: Math.max(0, liquidationCollateral! - entryFee),
        maintenanceMarginRate: this.config.liquidationMaintenanceMarginRate,
      })
      : null;
    return {
      signal,
      entryTime: candle.time,
      entryPrice,
      quantity,
      entryFee,
      initialRisk: stopDistance * quantity + entryFee,
      maxAdversePriceDistance: 0,
      liquidationPrice,
      allocatedMargin,
      marginMode,
      liquidationCollateral,
    };
  }

  private tryExit(position: OpenPosition, candle: Candle) {
    const { signal } = position;
    const adverseDistance = signal.side === "long"
      ? position.entryPrice - candle.low
      : candle.high - position.entryPrice;
    position.maxAdversePriceDistance = Math.max(position.maxAdversePriceDistance, adverseDistance, 0);
    const stopHit = signal.side === "long" ? candle.low <= signal.stopPrice : candle.high >= signal.stopPrice;
    const targetHit = signal.side === "long" ? candle.high >= signal.targetPrice : candle.low <= signal.targetPrice;
    const liquidationHit = position.liquidationPrice !== null && (
      signal.side === "long" ? candle.low <= position.liquidationPrice : candle.high >= position.liquidationPrice
    );
    const hardStopEnabled = (this.config.stopExecutionMode ?? "hard") === "hard";
    const liquidationPrecedesStop = position.liquidationPrice !== null && (
      signal.side === "long"
        ? position.liquidationPrice >= signal.stopPrice
        : position.liquidationPrice <= signal.stopPrice
    );
    if (liquidationHit && (!hardStopEnabled || !stopHit || liquidationPrecedesStop)) {
      return this.close(position, candle.time, position.liquidationPrice!, "liquidation");
    }
    if (hardStopEnabled && stopHit) {
      return this.close(position, candle.time, signal.stopPrice, "stop");
    }
    if (targetHit) return this.close(position, candle.time, signal.targetPrice, "target");
    if (this.config.closePositionAtSessionEnd !== false && !this.isWithinTradingSession(candle.time)) {
      return this.close(position, candle.time, candle.close, "session_close");
    }
    return null;
  }

  private isWithinTradingSession(timestamp: number) {
    return isWithinTimeZoneSession(
      timestamp,
      this.config.sessionTimeZone ?? "America/New_York",
      this.config.sessionStartMinute,
      this.config.sessionEndMinute,
    );
  }

  private close(position: OpenPosition, exitTime: number, rawExitPrice: number, exitReason: BacktestTrade["exitReason"]): BacktestTrade {
    const adverseSlippage = rawExitPrice * this.config.slippageBps / 10_000;
    const exitPrice = position.signal.side === "long" ? rawExitPrice - adverseSlippage : rawExitPrice + adverseSlippage;
    const direction = position.signal.side === "long" ? 1 : -1;
    const grossPnl = (exitPrice - position.entryPrice) * position.quantity * direction;
    const requestedExitFeeRate = exitReason === "liquidation"
      ? this.config.liquidationFeeRate ?? this.config.takerExitFeeRate
      : this.config.takerExitFeeRate;
    const requestedExitFee = exitPrice * position.quantity * requestedExitFeeRate;
    const maximumCollateralLiquidationFee = exitReason === "liquidation" && position.liquidationCollateral !== null
      ? Math.max(0, position.liquidationCollateral + grossPnl - position.entryFee)
      : Number.POSITIVE_INFINITY;
    const exitFee = Math.min(requestedExitFee, maximumCollateralLiquidationFee);
    const fees = position.entryFee + exitFee;
    const netPnl = grossPnl - fees;
    return {
      signalId: position.signal.id,
      side: position.signal.side,
      signalTime: position.signal.createdAt,
      entryTime: position.entryTime,
      exitTime,
      entryPrice: position.entryPrice,
      exitPrice,
      stopPrice: position.signal.stopPrice,
      targetPrice: position.signal.targetPrice,
      liquidationPrice: position.liquidationPrice,
      allocatedMargin: position.allocatedMargin,
      marginMode: position.marginMode,
      liquidationCollateral: position.liquidationCollateral,
      quantity: position.quantity,
      grossPnl,
      fees,
      netPnl,
      rMultiple: position.initialRisk > 0 ? netPnl / position.initialRisk : 0,
      exitReason,
      regimeKey: String(position.signal.evidence.regimeKey ?? "unclassified"),
      maxAdverseR: position.initialRisk > 0
        ? (position.maxAdversePriceDistance * position.quantity + position.entryFee) / position.initialRisk
        : 0,
    };
  }
}

function calculateLinearLiquidationPrice(input: {
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  availableMargin: number;
  maintenanceMarginRate?: number;
}) {
  const maintenanceMarginRate = input.maintenanceMarginRate;
  if (
    maintenanceMarginRate === undefined ||
    !Number.isFinite(maintenanceMarginRate) ||
    maintenanceMarginRate < 0 ||
    maintenanceMarginRate >= 1 ||
    input.quantity <= 0
  ) return null;
  const marginPerUnit = input.availableMargin / input.quantity;
  const price = input.side === "long"
    ? (input.entryPrice - marginPerUnit) / (1 - maintenanceMarginRate)
    : (input.entryPrice + marginPerUnit) / (1 + maintenanceMarginRate);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function regimeDiagnostics(
  groups: Record<string, { signals: number; expired: number; costRejected: number; filled: number }>,
  signal: StrategySignal,
) {
  const key = String(signal.evidence.regimeKey ?? "unclassified");
  groups[key] ??= { signals: 0, expired: 0, costRejected: 0, filled: 0 };
  return groups[key];
}

function normalizeCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()]
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0))
    .sort((left, right) => left.time - right.time);
}

function touchesEntry(candle: Candle, signal: StrategySignal) {
  return signal.entryOrderType === "market" || (candle.low <= signal.entryPrice && candle.high >= signal.entryPrice);
}

function makeDayState(timestamp: number, equity: number) {
  return { dateKey: newYorkTime(timestamp).dateKey, openingEquity: equity, pnl: 0, trades: 0, consecutiveLosses: 0 };
}

function isDailyLocked(day: ReturnType<typeof makeDayState>, config: BacktestConfig) {
  return day.pnl <= -day.openingEquity * config.dailyLossFraction ||
    day.trades >= config.maxTradesPerDay ||
    day.consecutiveLosses >= config.maxConsecutiveLossesPerDay;
}

function calculateMetrics(
  trades: BacktestTrade[],
  equityCurve: Array<{ time: number; equity: number }>,
  initialEquity: number,
  observedPeak: number,
) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  let peak = initialEquity;
  let maxDrawdown = 0;
  let maxDrawdownFraction = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownFraction = peak > 0 ? drawdown / peak : 0;
    }
  }
  return {
    initialEquity,
    finalEquity: initialEquity + netPnl,
    observedPeakEquity: observedPeak,
    netPnl,
    grossProfit,
    grossLoss,
    returnFraction: netPnl / initialEquity,
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0),
    maxDrawdown,
    maxDrawdownFraction,
    maxConsecutiveLosses: longestLosingStreak(trades),
    worstTradeR: trades.length ? Math.min(...trades.map((trade) => trade.rMultiple)) : 0,
    maxAdverseR: trades.length ? Math.max(...trades.map((trade) => trade.maxAdverseR)) : 0,
    averageMaxAdverseR: trades.length
      ? trades.reduce((sum, trade) => sum + trade.maxAdverseR, 0) / trades.length
      : 0,
  };
}

function longestLosingStreak(trades: BacktestTrade[]) {
  let current = 0;
  let maximum = 0;
  for (const trade of trades) {
    current = trade.netPnl < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}
