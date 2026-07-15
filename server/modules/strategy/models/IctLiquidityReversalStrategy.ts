import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import {
  averageTrueRange,
  confirmedSwings,
  fairValueGap,
  isDisplacement,
  type SwingPoint,
} from "../ict/priceAction";
import { isWithinTimeZoneSession } from "../ict/time";
import { classifyMarketRegime } from "../ict/regime";
import { intervalDurationMs } from "../../market/marketConfig";

export type IctLiquidityReversalConfig = {
  symbol: string;
  riskFraction: number;
  atrPeriod: number;
  displacementBodyAtr: number;
  minSweepAtr: number;
  maxSweepAtr: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  fvgMinAtr: number;
  fvgMaxAtr: number;
  sweepLookbackBars: number;
  setupExpiryBars: number;
  rewardRisk: number;
  sessionStartMinute: number;
  sessionEndMinute: number;
  sessionTimeZone: string;
  biasMode: "ema_only" | "structure_and_ema";
  allowWeekends: boolean;
  volatilityFilter: "all" | "exclude_low" | "high_only";
  minimumVolatilityRatio: number | null;
  fvgRetraceFraction: number;
  entryMode: "fvg_limit" | "next_bar_market";
  setupMode: "liquidity_reversal" | "mss_continuation";
  stopDistanceMode: "atr_bounded_structure" | "price_fraction_floor";
  minimumStopPriceFraction: number | null;
  maximumStructuralStopPriceFraction: number | null;
};

export const defaultIctLiquidityReversalConfig: IctLiquidityReversalConfig = {
  symbol: "BTCUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  displacementBodyAtr: 0.8,
  minSweepAtr: 0.02,
  maxSweepAtr: 0.5,
  stopBufferAtr: 0.1,
  minStopAtr: 0.25,
  maxStopAtr: 2,
  fvgMinAtr: 0.05,
  fvgMaxAtr: 1,
  sweepLookbackBars: 3,
  setupExpiryBars: 4,
  rewardRisk: 2,
  sessionStartMinute: 8 * 60 + 30,
  sessionEndMinute: 11 * 60,
  sessionTimeZone: "America/New_York",
  biasMode: "structure_and_ema",
  allowWeekends: true,
  volatilityFilter: "all",
  minimumVolatilityRatio: null,
  fvgRetraceFraction: 0.5,
  entryMode: "fvg_limit",
  setupMode: "liquidity_reversal",
  stopDistanceMode: "atr_bounded_structure",
  minimumStopPriceFraction: null,
  maximumStructuralStopPriceFraction: null,
};

type Sweep = { index: number; level: SwingPoint; extreme: number };

export class IctLiquidityReversalStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 300;
  private preparedCandles: Candle[] | null = null;
  private lastConfirmedHigh: Array<SwingPoint | null> = [];
  private lastConfirmedLow: Array<SwingPoint | null> = [];
  private biasByFifteenMinuteBucket = new Map<number, "bullish" | "bearish" | "neutral">();

  constructor(readonly config: IctLiquidityReversalConfig = defaultIctLiquidityReversalConfig) {
    this.id = config.setupMode === "mss_continuation" ? "ict-mss-continuation-v1" : "ict-liquidity-reversal-v1";
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles) return;
    this.preparedCandles = candles;
    const swings = confirmedSwings(candles, candles.length - 1);
    this.lastConfirmedHigh = buildLastConfirmedSwing(candles.length, swings, "high");
    this.lastConfirmedLow = buildLastConfirmedSwing(candles.length, swings, "low");
    this.biasByFifteenMinuteBucket = buildHigherTimeframeBias(candles, this.config.biasMode);
  }

  release() {
    this.preparedCandles = null;
    this.lastConfirmedHigh = [];
    this.lastConfirmedLow = [];
    this.biasByFifteenMinuteBucket.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles) this.prepare(candles);
    if (index < this.warmupBars || candles[index].symbol !== this.config.symbol) return null;
    const current = candles[index];
    if (!isWithinTimeZoneSession(
      current.time,
      this.config.sessionTimeZone,
      this.config.sessionStartMinute,
      this.config.sessionEndMinute,
    )) return null;
    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0) return null;
    const bias = this.getBias(candles, index);
    if (bias === "neutral") return null;
    const side: StrategySide = bias === "bullish" ? "long" : "short";
    const structure = side === "long" ? this.lastConfirmedHigh[index - 1] : this.lastConfirmedLow[index - 1];
    if (!structure) return null;
    const sweep = this.config.setupMode === "liquidity_reversal" ? this.findSweep(candles, index, side, atr) : null;
    if (this.config.setupMode === "liquidity_reversal" && !sweep) return null;
    const displacementSide = side === "long" ? "bullish" : "bearish";
    if (!isDisplacement(current, atr, displacementSide, this.config.displacementBodyAtr)) return null;
    if (side === "long" ? current.close <= structure.price : current.close >= structure.price) return null;
    if (
      this.config.setupMode === "mss_continuation" &&
      (side === "long" ? candles[index - 1].close > structure.price : candles[index - 1].close < structure.price)
    ) return null;
    const gap = fairValueGap(candles, index);
    if (!gap || gap.side !== displacementSide) return null;
    const gapSize = gap.upper - gap.lower;
    if (gapSize < atr * this.config.fvgMinAtr || gapSize > atr * this.config.fvgMaxAtr) return null;

    const continuationOrigin = side === "long"
      ? Math.min(candles[index - 1].low, current.low)
      : Math.max(candles[index - 1].high, current.high);
    const invalidationExtreme = sweep?.extreme ?? continuationOrigin;
    const rawStop = side === "long"
      ? invalidationExtreme - atr * this.config.stopBufferAtr
      : invalidationExtreme + atr * this.config.stopBufferAtr;
    const entryPrice = this.config.entryMode === "next_bar_market"
      ? current.close
      : fvgEntryPrice(gap.lower, gap.upper, side, this.config.fvgRetraceFraction);
    const resolvedStop = resolveStopPrice({ side, entryPrice, structuralStopPrice: rawStop, atr, config: this.config });
    if (!resolvedStop) return null;
    const { stopPrice, riskDistance } = resolvedStop;
    const targetPrice = side === "long"
      ? entryPrice + riskDistance * this.config.rewardRisk
      : entryPrice - riskDistance * this.config.rewardRisk;

    const regime = classifyMarketRegime(candles, index);
    if (!this.config.allowWeekends && regime.calendar === "weekend") return null;
    if (this.config.minimumVolatilityRatio !== null && regime.volatilityRatio < this.config.minimumVolatilityRatio) return null;
    if (this.config.volatilityFilter === "exclude_low" && regime.volatility === "low") return null;
    if (this.config.volatilityFilter === "high_only" && regime.volatility !== "high") return null;

    return this.toSignal(
      current,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      atr,
      sweep,
      structure.price,
      gap.lower,
      gap.upper,
      regime,
      rawStop,
    );
  }

  private getBias(candles: Candle[], index: number) {
    const bucket = Math.floor(candles[index].time / (15 * 60)) * (15 * 60);
    return this.biasByFifteenMinuteBucket.get(bucket - 15 * 60) ?? "neutral";
  }

  private findSweep(candles: Candle[], index: number, side: StrategySide, atr: number): Sweep | null {
    for (let candleIndex = index - 1; candleIndex >= Math.max(0, index - this.config.sweepLookbackBars); candleIndex -= 1) {
      const candle = candles[candleIndex];
      const level = side === "long" ? this.lastConfirmedLow[candleIndex - 1] : this.lastConfirmedHigh[candleIndex - 1];
      if (!level) continue;
      const penetration = side === "long" ? level.price - candle.low : candle.high - level.price;
      const reclaimed = side === "long" ? candle.close > level.price : candle.close < level.price;
      if (
        reclaimed &&
        penetration >= atr * this.config.minSweepAtr &&
        penetration <= atr * this.config.maxSweepAtr
      ) {
        return { index: candleIndex, level, extreme: side === "long" ? candle.low : candle.high };
      }
    }
    return null;
  }

  private toSignal(
    candle: Candle,
    side: StrategySide,
    entryPrice: number,
    stopPrice: number,
    targetPrice: number,
    atr: number,
    sweep: Sweep | null,
    structurePrice: number,
    fvgLower: number,
    fvgUpper: number,
    regime: ReturnType<typeof classifyMarketRegime>,
    structuralStopPrice: number,
  ): StrategySignal {
    const expiresAt = candle.time + this.config.setupExpiryBars * intervalDurationMs(candle.interval) / 1000;
    return {
      id: crypto.createHash("sha256").update(`${this.id}:${candle.symbol}:${candle.time}:${side}`).digest("hex").slice(0, 24),
      strategyId: this.id,
      symbol: candle.symbol,
      interval: candle.interval,
      createdAt: candle.time,
      expiresAt,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      riskFraction: this.config.riskFraction,
      entryOrderType: this.config.entryMode === "next_bar_market" ? "market" : "limit",
      reasonCodes: this.config.setupMode === "liquidity_reversal"
        ? ["HTF_STRUCTURE_BIAS", "LIQUIDITY_SWEEP", "DISPLACEMENT", "MSS", "FVG_RETRACE"]
        : ["HTF_STRUCTURE_BIAS", "DISPLACEMENT", "MSS_CROSS", "FVG_CONTINUATION"],
      evidence: {
        atr,
        structuralStopPrice,
        stopDistance: Math.abs(candle.close - stopPrice),
        stopDistanceFraction: candle.close > 0 ? Math.abs(candle.close - stopPrice) / candle.close : 0,
        setupMode: this.config.setupMode,
        ...(sweep ? {
          sweepIndex: sweep.index,
          sweptLiquidity: sweep.level.price,
          sweepExtreme: sweep.extreme,
        } : {}),
        structurePrice,
        fvgLower,
        fvgUpper,
        regimeKey: regime.key,
        volatilityRegime: regime.volatility,
        volatilityRatio: regime.volatilityRatio,
        structureRegime: regime.structure,
        sessionRegime: regime.session,
        calendarRegime: regime.calendar,
      },
    };
  }
}

export function resolveStopPrice(input: {
  side: StrategySide;
  entryPrice: number;
  structuralStopPrice: number;
  atr: number;
  config: Pick<
    IctLiquidityReversalConfig,
    "stopDistanceMode" | "minStopAtr" | "maxStopAtr" | "minimumStopPriceFraction" | "maximumStructuralStopPriceFraction"
  >;
}) {
  const { side, entryPrice, structuralStopPrice, atr, config } = input;
  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(structuralStopPrice) ||
    !Number.isFinite(atr) || atr <= 0 ||
    (side === "long" ? structuralStopPrice >= entryPrice : structuralStopPrice <= entryPrice)
  ) return null;
  const structuralRiskDistance = Math.abs(entryPrice - structuralStopPrice);
  let riskDistance = structuralRiskDistance;
  if (config.stopDistanceMode === "price_fraction_floor") {
    const minimumFraction = config.minimumStopPriceFraction;
    const maximumStructuralFraction = config.maximumStructuralStopPriceFraction;
    if (
      minimumFraction === null || maximumStructuralFraction === null ||
      !Number.isFinite(minimumFraction) || minimumFraction <= 0 ||
      !Number.isFinite(maximumStructuralFraction) || maximumStructuralFraction < minimumFraction
    ) return null;
    if (structuralRiskDistance > entryPrice * maximumStructuralFraction) return null;
    riskDistance = Math.max(structuralRiskDistance, entryPrice * minimumFraction);
  } else if (riskDistance < atr * config.minStopAtr || riskDistance > atr * config.maxStopAtr) {
    return null;
  }
  return {
    stopPrice: side === "long" ? entryPrice - riskDistance : entryPrice + riskDistance,
    riskDistance,
    structuralRiskDistance,
  };
}

export function fvgEntryPrice(lower: number, upper: number, side: StrategySide, retraceFraction: number) {
  const fraction = Math.max(0, Math.min(1, retraceFraction));
  const size = upper - lower;
  return side === "long" ? upper - size * fraction : lower + size * fraction;
}

function buildLastConfirmedSwing(length: number, swings: SwingPoint[], kind: SwingPoint["kind"]) {
  const byConfirmation = new Map<number, SwingPoint[]>();
  for (const swing of swings.filter((item) => item.kind === kind)) {
    const list = byConfirmation.get(swing.confirmedAtIndex) ?? [];
    list.push(swing);
    byConfirmation.set(swing.confirmedAtIndex, list);
  }
  const result: Array<SwingPoint | null> = Array.from({ length }, () => null);
  let latest: SwingPoint | null = null;
  for (let index = 0; index < length; index += 1) {
    for (const swing of byConfirmation.get(index) ?? []) latest = swing;
    result[index] = latest;
  }
  return result;
}

function buildHigherTimeframeBias(candles: Candle[], biasMode: IctLiquidityReversalConfig["biasMode"]) {
  const higher = aggregateCandles(candles, "15m");
  const swings = confirmedSwings(higher, higher.length - 1);
  const confirmations = new Map<number, SwingPoint[]>();
  for (const swing of swings) {
    const list = confirmations.get(swing.confirmedAtIndex) ?? [];
    list.push(swing);
    confirmations.set(swing.confirmedAtIndex, list);
  }
  const result = new Map<number, "bullish" | "bearish" | "neutral">();
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  const multiplier = 2 / 21;
  let ema = higher[0]?.close ?? 0;
  for (let index = 0; index < higher.length; index += 1) {
    if (index > 0) ema = (higher[index].close - ema) * multiplier + ema;
    for (const swing of confirmations.get(index) ?? []) {
      const target = swing.kind === "high" ? highs : lows;
      target.push(swing);
      if (target.length > 2) target.shift();
    }
    let bias: "bullish" | "bearish" | "neutral" = "neutral";
    if (index >= 19) {
      if (biasMode === "ema_only") {
        bias = higher[index].close > ema ? "bullish" : higher[index].close < ema ? "bearish" : "neutral";
      } else if (highs.length === 2 && lows.length === 2) {
        if (higher[index].close > ema && highs[1].price > highs[0].price && lows[1].price > lows[0].price) bias = "bullish";
        if (higher[index].close < ema && highs[1].price < highs[0].price && lows[1].price < lows[0].price) bias = "bearish";
      }
    }
    result.set(higher[index].time, bias);
  }
  return result;
}
