import type { Candle } from "../../../types";
import type { Strategy, StrategyExitTarget, StrategySignal } from "../core/types";
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
  maxNewEntriesPerDay?: number;
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
  maxConcurrentPositions?: number;
  concurrentPositionMode?: "any" | "same_side";
  markToMarketEquityCurve?: boolean;
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
  maxConcurrentPositions: 1,
  concurrentPositionMode: "any",
  markToMarketEquityCurve: false,
};

export type BacktestExitLeg = {
  label: string;
  reason: "partial_target" | "stop" | "break_even" | "target" | "liquidation" | "time_stop" | "session_close" | "end_of_data";
  time: number;
  price: number;
  quantity: number;
  quantityFraction: number;
  grossPnl: number;
  entryFeeAllocated: number;
  exitFee: number;
  netPnl: number;
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
  exitReason: "stop" | "break_even" | "target" | "liquidation" | "time_stop" | "session_close" | "end_of_data";
  regimeKey: string;
  maxAdverseR: number;
  exitLegs?: BacktestExitLeg[];
  breakEvenActivatedAt?: number | null;
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
    entryLimitRejectedOrders: number;
    filledOrders: number;
    concurrentSignalsRejected: number;
    maximumConcurrentPositions: number;
    byRegime: Record<string, { signals: number; expired: number; costRejected: number; entryLimitRejected: number; filled: number }>;
  };
  metrics: ReturnType<typeof calculateMetrics>;
};

type PendingOrder = { signal: StrategySignal };
type OpenPosition = {
  signal: StrategySignal;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  entryFee: number;
  initialRisk: number;
  maxAdversePriceDistance: number;
  currentStopPrice: number;
  breakEvenActivationPrice: number | null;
  breakEvenActivatedAt: number | null;
  targets: StrategyExitTarget[];
  nextTargetIndex: number;
  realizedGrossPnl: number;
  exitFees: number;
  exitLegs: BacktestExitLeg[];
  initialLiquidationPrice: number | null;
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
    const maxConcurrentPositions = resolveMaxConcurrentPositions(this.config.maxConcurrentPositions);
    this.strategy.prepare?.(candles);
    let equity = this.config.initialEquity;
    let peakEquity = equity;
    let pending: PendingOrder[] = [];
    let positions: OpenPosition[] = [];
    const trades: BacktestTrade[] = [];
    const diagnostics = {
      signals: 0,
      expiredOrders: 0,
      costRejectedOrders: 0,
      entryLimitRejectedOrders: 0,
      filledOrders: 0,
      concurrentSignalsRejected: 0,
      maximumConcurrentPositions: 0,
      byRegime: {} as Record<string, { signals: number; expired: number; costRejected: number; entryLimitRejected: number; filled: number }>,
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

      const survivingPositions: OpenPosition[] = [];
      for (const position of positions) {
        const closed = this.tryExit(position, candle);
        if (closed) {
          recordClosedTrade(closed);
        } else survivingPositions.push(position);
      }
      positions = survivingPositions;

      const remainingPending: PendingOrder[] = [];
      for (const order of pending) {
        if (
          candle.time > order.signal.expiresAt ||
          !this.isWithinTradingSession(candle.time)
        ) {
          diagnostics.expiredOrders += 1;
          regimeDiagnostics(diagnostics.byRegime, order.signal).expired += 1;
        } else if (candle.time > order.signal.createdAt && touchesEntry(candle, order.signal)) {
          if (isNewEntryLimitReached(dayState, this.config)) {
            diagnostics.entryLimitRejectedOrders += 1;
            regimeDiagnostics(diagnostics.byRegime, order.signal).entryLimitRejected += 1;
          } else {
            const position = positions.length < maxConcurrentPositions
              ? this.open(order.signal, candle, equity)
              : null;
            if (position) {
              diagnostics.filledOrders += 1;
              dayState.entries += 1;
              regimeDiagnostics(diagnostics.byRegime, order.signal).filled += 1;
              const closed = this.tryExit(position, candle);
              if (closed) {
                recordClosedTrade(closed);
              } else positions.push(position);
            } else {
              diagnostics.costRejectedOrders += 1;
              regimeDiagnostics(diagnostics.byRegime, order.signal).costRejected += 1;
            }
          }
        } else remainingPending.push(order);
      }
      pending = remainingPending;
      diagnostics.maximumConcurrentPositions = Math.max(diagnostics.maximumConcurrentPositions, positions.length);

      if (
        positions.length + pending.length < maxConcurrentPositions &&
        !isNewEntryLimitReached(dayState, this.config) &&
        (this.config.accountRiskControlsEnabled === false || !isDailyLocked(dayState, this.config))
      ) {
        const signal = this.strategy.evaluate({ candles, index, equity });
        if (signal) {
          diagnostics.signals += 1;
          regimeDiagnostics(diagnostics.byRegime, signal).signals += 1;
        }
        if (signal && isConcurrentSideCompatible(signal, positions, pending, this.config.concurrentPositionMode)) {
          pending.push({ signal });
        } else if (signal) diagnostics.concurrentSignalsRejected += 1;
      }
      const markedEquity = this.config.markToMarketEquityCurve
        ? equity + positions.reduce((sum, position) => sum + this.markToMarketNetPnl(position, candle.close), 0)
        : equity;
      peakEquity = Math.max(peakEquity, markedEquity);
      equityCurve.push({ time: candle.time, equity: markedEquity });
    }

    if (positions.length > 0 && candles.length > 0) {
      const last = candles.at(-1)!;
      for (const position of positions) {
        const closed = this.close(position, last.time, last.close, "end_of_data");
        trades.push(closed);
        equity += closed.netPnl;
      }
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
    const targets = normalizeExitTargets(signal, entryPrice);
    if (!targets || (signal.maxHoldingSeconds !== undefined && (
      !Number.isFinite(signal.maxHoldingSeconds) || signal.maxHoldingSeconds <= 0
    ))) return null;
    if (signal.side === "long" ? entryPrice <= signal.stopPrice : entryPrice >= signal.stopPrice) return null;
    const stopDistance = Math.abs(entryPrice - signal.stopPrice);
    const breakEvenRewardRisk = signal.moveStopToBreakEvenAtRewardRisk;
    if (breakEvenRewardRisk !== undefined && (
      signal.exitPlan ||
      !Number.isFinite(breakEvenRewardRisk) ||
      breakEvenRewardRisk <= 0
    )) return null;
    const breakEvenActivationPrice = breakEvenRewardRisk === undefined
      ? null
      : signal.side === "long"
        ? entryPrice + stopDistance * breakEvenRewardRisk
        : entryPrice - stopDistance * breakEvenRewardRisk;
    if (breakEvenActivationPrice !== null) {
      const finalTarget = targets.at(-1)!.price;
      if (
        breakEvenActivationPrice <= 0 ||
        (signal.side === "long" ? breakEvenActivationPrice >= finalTarget : breakEvenActivationPrice <= finalTarget)
      ) return null;
    }
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
    const estimatedNetReward = targets.reduce((sum, target) => {
      const targetDistance = Math.abs(target.price - entryPrice);
      const targetQuantity = quantity * target.quantityFraction;
      const targetFees = (entryPrice * entryFeeRate + target.price * this.config.takerExitFeeRate) * targetQuantity;
      return sum + targetDistance * targetQuantity - targetFees;
    }, 0);
    const estimatedStopFees = estimatedStopFeePerUnit * quantity;
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
    const resolvedSignal = signal.targetRewardRisk === undefined
      ? signal
      : { ...signal, targetPrice: targets.at(-1)!.price };
    return {
      signal: resolvedSignal,
      entryTime: candle.time,
      entryPrice,
      quantity,
      remainingQuantity: quantity,
      entryFee,
      initialRisk: stopDistance * quantity + entryFee,
      maxAdversePriceDistance: 0,
      currentStopPrice: signal.stopPrice,
      breakEvenActivationPrice,
      breakEvenActivatedAt: null,
      targets,
      nextTargetIndex: 0,
      realizedGrossPnl: 0,
      exitFees: 0,
      exitLegs: [],
      initialLiquidationPrice: liquidationPrice,
      liquidationPrice,
      allocatedMargin,
      marginMode,
      liquidationCollateral,
    };
  }

  private markToMarketNetPnl(position: OpenPosition, rawExitPrice: number) {
    const adverseSlippage = rawExitPrice * this.config.slippageBps / 10_000;
    const exitPrice = position.signal.side === "long" ? rawExitPrice - adverseSlippage : rawExitPrice + adverseSlippage;
    const direction = position.signal.side === "long" ? 1 : -1;
    const unrealizedGrossPnl = (exitPrice - position.entryPrice) * position.remainingQuantity * direction;
    const estimatedExitFee = exitPrice * position.remainingQuantity * this.config.takerExitFeeRate;
    return position.realizedGrossPnl + unrealizedGrossPnl - position.entryFee - position.exitFees - estimatedExitFee;
  }

  private tryExit(position: OpenPosition, candle: Candle): BacktestTrade | null {
    const { signal } = position;
    const adverseDistance = signal.side === "long"
      ? position.entryPrice - candle.low
      : candle.high - position.entryPrice;
    position.maxAdversePriceDistance = Math.max(position.maxAdversePriceDistance, adverseDistance, 0);
    const stopHit = signal.side === "long"
      ? candle.low <= position.currentStopPrice
      : candle.high >= position.currentStopPrice;
    const liquidationHit = position.liquidationPrice !== null && (
      signal.side === "long" ? candle.low <= position.liquidationPrice : candle.high >= position.liquidationPrice
    );
    const hardStopEnabled = (this.config.stopExecutionMode ?? "hard") === "hard";
    const liquidationPrecedesStop = position.liquidationPrice !== null && (
      signal.side === "long"
        ? position.liquidationPrice >= position.currentStopPrice
        : position.liquidationPrice <= position.currentStopPrice
    );
    if (liquidationHit && (!hardStopEnabled || !stopHit || liquidationPrecedesStop)) {
      return this.close(position, candle.time, position.liquidationPrice!, "liquidation");
    }
    if (hardStopEnabled && stopHit) {
      return this.close(
        position,
        candle.time,
        position.currentStopPrice,
        position.breakEvenActivatedAt === null ? "stop" : "break_even",
      );
    }

    if (position.breakEvenActivationPrice !== null && position.breakEvenActivatedAt === null) {
      const activationHit = signal.side === "long"
        ? candle.high >= position.breakEvenActivationPrice
        : candle.low <= position.breakEvenActivationPrice;
      if (activationHit) {
        position.breakEvenActivatedAt = candle.time;
        position.currentStopPrice = position.entryPrice;
        const movedStopHit = signal.side === "long"
          ? candle.low <= position.currentStopPrice
          : candle.high >= position.currentStopPrice;
        if (hardStopEnabled && movedStopHit) {
          return this.close(position, candle.time, position.currentStopPrice, "break_even");
        }
      }
    }

    while (position.nextTargetIndex < position.targets.length) {
      const target = position.targets[position.nextTargetIndex];
      const targetHit = signal.side === "long" ? candle.high >= target.price : candle.low <= target.price;
      if (!targetHit) break;
      const isFinalTarget = position.nextTargetIndex === position.targets.length - 1;
      const requestedQuantity = isFinalTarget
        ? position.remainingQuantity
        : position.quantity * target.quantityFraction;
      const exitQuantity = Math.min(position.remainingQuantity, requestedQuantity);
      this.realizeExitLeg(
        position,
        candle.time,
        target.price,
        exitQuantity,
        isFinalTarget ? "target" : "partial_target",
        target.label ?? `tp${position.nextTargetIndex + 1}`,
      );
      position.nextTargetIndex += 1;
      if (target.moveStopToBreakEvenAfterFill) position.currentStopPrice = position.entryPrice;
      this.recalculateLiquidationPrice(position);
      if (position.remainingQuantity <= quantityEpsilon(position.quantity)) {
        return this.finalizeTrade(position, "target");
      }

      const movedStopHit = signal.side === "long"
        ? candle.low <= position.currentStopPrice
        : candle.high >= position.currentStopPrice;
      if (hardStopEnabled && movedStopHit) {
        return this.close(position, candle.time, position.currentStopPrice, "stop");
      }
    }

    if (
      signal.maxHoldingSeconds !== undefined &&
      candle.time - position.entryTime >= signal.maxHoldingSeconds
    ) {
      return this.close(position, candle.time, candle.close, "time_stop");
    }

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

  private close(
    position: OpenPosition,
    exitTime: number,
    rawExitPrice: number,
    exitReason: BacktestTrade["exitReason"],
  ): BacktestTrade {
    this.realizeExitLeg(
      position,
      exitTime,
      rawExitPrice,
      position.remainingQuantity,
      exitReason,
      exitReason,
    );
    return this.finalizeTrade(position, exitReason);
  }

  private realizeExitLeg(
    position: OpenPosition,
    exitTime: number,
    rawExitPrice: number,
    quantity: number,
    reason: BacktestExitLeg["reason"],
    label: string,
  ) {
    if (quantity <= 0) return;
    const adverseSlippage = rawExitPrice * this.config.slippageBps / 10_000;
    const exitPrice = position.signal.side === "long" ? rawExitPrice - adverseSlippage : rawExitPrice + adverseSlippage;
    const direction = position.signal.side === "long" ? 1 : -1;
    const grossPnl = (exitPrice - position.entryPrice) * quantity * direction;
    const requestedExitFeeRate = reason === "liquidation"
      ? this.config.liquidationFeeRate ?? this.config.takerExitFeeRate
      : this.config.takerExitFeeRate;
    const requestedExitFee = exitPrice * quantity * requestedExitFeeRate;
    const availableLiquidationCollateral = position.liquidationCollateral === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
        0,
        position.liquidationCollateral - position.entryFee + position.realizedGrossPnl - position.exitFees + grossPnl,
      );
    const exitFee = reason === "liquidation"
      ? Math.min(requestedExitFee, availableLiquidationCollateral)
      : requestedExitFee;
    const quantityFraction = quantity / position.quantity;
    const entryFeeAllocated = position.entryFee * quantityFraction;
    position.realizedGrossPnl += grossPnl;
    position.exitFees += exitFee;
    position.remainingQuantity = Math.max(0, position.remainingQuantity - quantity);
    position.exitLegs.push({
      label,
      reason,
      time: exitTime,
      price: exitPrice,
      quantity,
      quantityFraction,
      grossPnl,
      entryFeeAllocated,
      exitFee,
      netPnl: grossPnl - entryFeeAllocated - exitFee,
    });
  }

  private recalculateLiquidationPrice(position: OpenPosition) {
    if (position.liquidationCollateral === null || position.remainingQuantity <= quantityEpsilon(position.quantity)) {
      position.liquidationPrice = null;
      return;
    }
    const availableMargin = Math.max(
      0,
      position.liquidationCollateral - position.entryFee + position.realizedGrossPnl - position.exitFees,
    );
    position.liquidationPrice = calculateLinearLiquidationPrice({
      side: position.signal.side,
      entryPrice: position.entryPrice,
      quantity: position.remainingQuantity,
      availableMargin,
      maintenanceMarginRate: this.config.liquidationMaintenanceMarginRate,
    });
  }

  private finalizeTrade(position: OpenPosition, exitReason: BacktestTrade["exitReason"]): BacktestTrade {
    const grossPnl = position.realizedGrossPnl;
    const fees = position.entryFee + position.exitFees;
    const netPnl = grossPnl - fees;
    const weightedExitPrice = position.exitLegs.reduce((sum, leg) => sum + leg.price * leg.quantity, 0) / position.quantity;
    const exitTime = position.exitLegs.at(-1)?.time ?? position.entryTime;
    return {
      signalId: position.signal.id,
      side: position.signal.side,
      signalTime: position.signal.createdAt,
      entryTime: position.entryTime,
      exitTime,
      entryPrice: position.entryPrice,
      exitPrice: weightedExitPrice,
      stopPrice: position.signal.stopPrice,
      targetPrice: position.signal.targetPrice,
      liquidationPrice: position.initialLiquidationPrice,
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
      exitLegs: position.exitLegs,
      breakEvenActivatedAt: position.breakEvenActivatedAt,
    };
  }

}


function normalizeExitTargets(signal: StrategySignal, entryPrice: number): StrategyExitTarget[] | null {
  if (signal.targetRewardRisk !== undefined) {
    if (
      signal.exitPlan ||
      !Number.isFinite(signal.targetRewardRisk) ||
      signal.targetRewardRisk <= 0 ||
      (signal.side === "long" ? entryPrice <= signal.stopPrice : entryPrice >= signal.stopPrice)
    ) return null;
    const distance = Math.abs(entryPrice - signal.stopPrice) * signal.targetRewardRisk;
    const price = signal.side === "long" ? entryPrice + distance : entryPrice - distance;
    return Number.isFinite(price) && price > 0
      ? [{ price, quantityFraction: 1, label: "target" }]
      : null;
  }
  const targets = signal.exitPlan?.targets ?? [{ price: signal.targetPrice, quantityFraction: 1, label: "target" }];
  if (targets.length === 0) return null;
  let fractionTotal = 0;
  let previousPrice = entryPrice;
  for (const target of targets) {
    if (
      !Number.isFinite(target.price) || target.price <= 0 ||
      !Number.isFinite(target.quantityFraction) || target.quantityFraction <= 0 || target.quantityFraction > 1 ||
      (signal.side === "long" ? target.price <= previousPrice : target.price >= previousPrice)
    ) return null;
    previousPrice = target.price;
    fractionTotal += target.quantityFraction;
  }
  if (Math.abs(fractionTotal - 1) > 1e-9) return null;
  const finalPrice = targets.at(-1)!.price;
  if (Math.abs(finalPrice - signal.targetPrice) > Math.max(1e-9, signal.targetPrice * 1e-12)) return null;
  return targets.map((target) => ({ ...target }));
}

function quantityEpsilon(initialQuantity: number) {
  return Math.max(1e-12, initialQuantity * 1e-12);
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
  groups: Record<string, { signals: number; expired: number; costRejected: number; entryLimitRejected: number; filled: number }>,
  signal: StrategySignal,
) {
  const key = String(signal.evidence.regimeKey ?? "unclassified");
  groups[key] ??= { signals: 0, expired: 0, costRejected: 0, entryLimitRejected: 0, filled: 0 };
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

function resolveMaxConcurrentPositions(value: number | undefined) {
  const resolved = value ?? 1;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 10) {
    throw new Error("maxConcurrentPositions must be an integer between 1 and 10.");
  }
  return resolved;
}

function isConcurrentSideCompatible(
  signal: StrategySignal,
  positions: OpenPosition[],
  pending: PendingOrder[],
  mode: BacktestConfig["concurrentPositionMode"],
) {
  if ((mode ?? "any") === "any") return true;
  return positions.every((position) => position.signal.side === signal.side) &&
    pending.every((order) => order.signal.side === signal.side);
}

function makeDayState(timestamp: number, equity: number) {
  return { dateKey: newYorkTime(timestamp).dateKey, openingEquity: equity, pnl: 0, trades: 0, entries: 0, consecutiveLosses: 0 };
}

function isNewEntryLimitReached(day: ReturnType<typeof makeDayState>, config: BacktestConfig) {
  return config.maxNewEntriesPerDay !== undefined && day.entries >= config.maxNewEntriesPerDay;
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
