import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { intervalDurationMs } from "../../market/marketConfig";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySide, StrategySignal } from "../core/types";
import { classifyMarketRegime } from "../ict/regime";
import {
  averageTrueRange,
  confirmedSwings,
  fairValueGap,
  isDisplacement,
  type FairValueGap,
  type SwingPoint,
} from "../ict/priceAction";
import { isWithinTimeZoneSession } from "../ict/time";

export type EthSmcIctConfluenceConfig = {
  routeId: string;
  symbol: string;
  riskFraction: number;
  atrPeriod: number;
  swingLeftBars: number;
  swingRightBars: number;
  displacementBodyAtr: number;
  fvgLookbackBars: number;
  fvgMinAtr: number;
  fvgMaxAtr: number;
  orderBlockLookbackBars: number;
  orderBlockProximityAtr: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  rewardRisk: number;
  setupExpiryBars: number;
  sessionTimeZone: string;
  sessionStartMinute: number;
  sessionEndMinute: number;
  allowWeekends: boolean;
};

export const ethSmcIctConfluenceV1Config: EthSmcIctConfluenceConfig = {
  routeId: "ict-eth-smc-fib-fvg-ob-v1-2026-07-16",
  symbol: "ETHUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  swingLeftBars: 2,
  swingRightBars: 2,
  displacementBodyAtr: 0.8,
  fvgLookbackBars: 48,
  fvgMinAtr: 0.05,
  fvgMaxAtr: 1,
  orderBlockLookbackBars: 6,
  orderBlockProximityAtr: 0.5,
  stopBufferAtr: 0.1,
  minStopAtr: 0.25,
  maxStopAtr: 4,
  rewardRisk: 2.5,
  setupExpiryBars: 12,
  sessionTimeZone: "America/New_York",
  sessionStartMinute: 7 * 60,
  sessionEndMinute: 10 * 60,
  allowWeekends: false,
};

export type StructurePair = {
  breakLevel: SwingPoint;
  impulseOrigin: SwingPoint;
};

export type StructureContext = {
  bullish: StructurePair | null;
  bearish: StructurePair | null;
};

export type FibFvgOrderBlockSetup = {
  entryPrice: number;
  equilibriumPrice: number;
  fvg: FairValueGap;
  orderBlockIndex: number;
  orderBlockLow: number;
  orderBlockHigh: number;
  orderBlockDistanceAtr: number;
};

export class EthSmcIctConfluenceStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 300;
  private preparedCandles: Candle[] | null = null;
  private structureByFifteenMinuteBucket = new Map<number, StructureContext>();

  constructor(readonly config: EthSmcIctConfluenceConfig = ethSmcIctConfluenceV1Config) {
    this.id = config.routeId;
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles) return;
    this.preparedCandles = candles;
    const higher = aggregateCandles(candles, "15m");
    this.structureByFifteenMinuteBucket = buildConfirmedStructureContexts(
      higher,
      this.config.swingLeftBars,
      this.config.swingRightBars,
    );
  }

  release() {
    this.preparedCandles = null;
    this.structureByFifteenMinuteBucket.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles) this.prepare(candles);
    if (index < this.warmupBars || candles[index]?.symbol !== this.config.symbol) return null;
    const current = candles[index];
    const previous = candles[index - 1];
    if (!previous || !isWithinTimeZoneSession(
      current.time,
      this.config.sessionTimeZone,
      this.config.sessionStartMinute,
      this.config.sessionEndMinute,
    )) return null;

    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0) return null;
    const regime = classifyMarketRegime(candles, index);
    if (!this.config.allowWeekends && regime.calendar === "weekend") return null;

    const bucket = Math.floor(current.time / (15 * 60)) * (15 * 60);
    const structure = this.structureByFifteenMinuteBucket.get(bucket - 15 * 60);
    if (!structure) return null;

    const bullishBreak = structure.bullish &&
      previous.close <= structure.bullish.breakLevel.price &&
      current.close > structure.bullish.breakLevel.price;
    const bearishBreak = structure.bearish &&
      previous.close >= structure.bearish.breakLevel.price &&
      current.close < structure.bearish.breakLevel.price;
    const side: StrategySide | null = bullishBreak ? "long" : bearishBreak ? "short" : null;
    if (!side) return null;

    const displacementSide = side === "long" ? "bullish" : "bearish";
    if (!isDisplacement(current, atr, displacementSide, this.config.displacementBodyAtr)) return null;
    const activeStructure = side === "long" ? structure.bullish : structure.bearish;
    if (!activeStructure) return null;
    const impulseExtreme = side === "long" ? current.high : current.low;
    if (side === "long" && impulseExtreme <= activeStructure.impulseOrigin.price) return null;
    if (side === "short" && impulseExtreme >= activeStructure.impulseOrigin.price) return null;

    const setup = selectFibFvgOrderBlockSetup({
      candles,
      index,
      side,
      impulseOrigin: activeStructure.impulseOrigin,
      impulseExtreme,
      atr,
      config: this.config,
    });
    if (!setup) return null;
    if (side === "long" ? setup.entryPrice >= current.close : setup.entryPrice <= current.close) return null;

    const structuralStopPrice = side === "long"
      ? setup.orderBlockLow - atr * this.config.stopBufferAtr
      : setup.orderBlockHigh + atr * this.config.stopBufferAtr;
    const riskDistance = Math.abs(setup.entryPrice - structuralStopPrice);
    if (
      (side === "long" ? structuralStopPrice >= setup.entryPrice : structuralStopPrice <= setup.entryPrice) ||
      riskDistance < atr * this.config.minStopAtr ||
      riskDistance > atr * this.config.maxStopAtr
    ) return null;
    const targetPrice = side === "long"
      ? setup.entryPrice + riskDistance * this.config.rewardRisk
      : setup.entryPrice - riskDistance * this.config.rewardRisk;

    return this.toSignal({
      candle: current,
      side,
      entryPrice: setup.entryPrice,
      stopPrice: structuralStopPrice,
      targetPrice,
      atr,
      structure: activeStructure,
      setup,
      regime,
    });
  }

  private toSignal(input: {
    candle: Candle;
    side: StrategySide;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    atr: number;
    structure: StructurePair;
    setup: FibFvgOrderBlockSetup;
    regime: ReturnType<typeof classifyMarketRegime>;
  }): StrategySignal {
    const { candle, side, entryPrice, stopPrice, targetPrice, atr, structure, setup, regime } = input;
    return {
      id: crypto.createHash("sha256")
        .update(`${this.id}:${candle.symbol}:${candle.time}:${side}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      symbol: candle.symbol,
      interval: candle.interval,
      createdAt: candle.time,
      expiresAt: candle.time + this.config.setupExpiryBars * intervalDurationMs(candle.interval) / 1000,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      riskFraction: this.config.riskFraction,
      entryOrderType: "limit",
      reasonCodes: [
        "15M_CONFIRMED_SWING_BOS",
        "DISPLACEMENT",
        "FIBONACCI_DISCOUNT_PREMIUM",
        "UNMITIGATED_FVG",
        "ORDER_BLOCK_PROXIMITY",
        "ICT_NEW_YORK_WINDOW",
      ],
      evidence: {
        routeId: this.config.routeId,
        atr,
        breakLevel: structure.breakLevel.price,
        breakLevelTime: structure.breakLevel.time,
        impulseOrigin: structure.impulseOrigin.price,
        impulseOriginTime: structure.impulseOrigin.time,
        equilibriumPrice: setup.equilibriumPrice,
        fvgLower: setup.fvg.lower,
        fvgUpper: setup.fvg.upper,
        fvgMidpoint: setup.entryPrice,
        fvgTime: candleTimeAt(setup.fvg.index, this.preparedCandles),
        orderBlockIndex: setup.orderBlockIndex,
        orderBlockLow: setup.orderBlockLow,
        orderBlockHigh: setup.orderBlockHigh,
        orderBlockDistanceAtr: setup.orderBlockDistanceAtr,
        stopDistanceAtr: Math.abs(entryPrice - stopPrice) / atr,
        rewardRisk: this.config.rewardRisk,
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

export function buildConfirmedStructureContexts(
  higherCandles: Candle[],
  leftBars = 2,
  rightBars = 2,
) {
  const swings = confirmedSwings(higherCandles, higherCandles.length - 1, leftBars, rightBars);
  const byConfirmation = new Map<number, SwingPoint[]>();
  for (const swing of swings) {
    const list = byConfirmation.get(swing.confirmedAtIndex) ?? [];
    list.push(swing);
    byConfirmation.set(swing.confirmedAtIndex, list);
  }

  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  const result = new Map<number, StructureContext>();
  for (let index = 0; index < higherCandles.length; index += 1) {
    for (const swing of byConfirmation.get(index) ?? []) {
      (swing.kind === "high" ? highs : lows).push(swing);
    }
    const latestHigh = highs.at(-1) ?? null;
    const latestLow = lows.at(-1) ?? null;
    const bullishOrigin = latestHigh ? findLatestBefore(lows, latestHigh.index) : null;
    const bearishOrigin = latestLow ? findLatestBefore(highs, latestLow.index) : null;
    result.set(higherCandles[index].time, {
      bullish: latestHigh && bullishOrigin ? { breakLevel: latestHigh, impulseOrigin: bullishOrigin } : null,
      bearish: latestLow && bearishOrigin ? { breakLevel: latestLow, impulseOrigin: bearishOrigin } : null,
    });
  }
  return result;
}

export function selectFibFvgOrderBlockSetup(input: {
  candles: Candle[];
  index: number;
  side: StrategySide;
  impulseOrigin: SwingPoint;
  impulseExtreme: number;
  atr: number;
  config: Pick<
    EthSmcIctConfluenceConfig,
    "fvgLookbackBars" | "fvgMinAtr" | "fvgMaxAtr" | "orderBlockLookbackBars" | "orderBlockProximityAtr"
  >;
}): FibFvgOrderBlockSetup | null {
  const { candles, index, side, impulseOrigin, impulseExtreme, atr, config } = input;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const equilibriumPrice = (impulseOrigin.price + impulseExtreme) / 2;
  const earliestGapIndex = Math.max(2, index - config.fvgLookbackBars + 1);

  for (let gapIndex = index; gapIndex >= earliestGapIndex; gapIndex -= 1) {
    if (candles[gapIndex].time < impulseOrigin.time) break;
    const gap = fairValueGap(candles, gapIndex);
    const expectedGapSide = side === "long" ? "bullish" : "bearish";
    if (!gap || gap.side !== expectedGapSide) continue;
    const gapSizeAtr = (gap.upper - gap.lower) / atr;
    if (gapSizeAtr < config.fvgMinAtr || gapSizeAtr > config.fvgMaxAtr) continue;
    const entryPrice = gap.midpoint;
    const inFibHalf = side === "long"
      ? entryPrice >= impulseOrigin.price && entryPrice <= equilibriumPrice
      : entryPrice <= impulseOrigin.price && entryPrice >= equilibriumPrice;
    if (!inFibHalf || wasPriceTouched(candles, gapIndex + 1, index - 1, entryPrice)) continue;

    const orderBlockIndex = findOrderBlockIndex(
      candles,
      gapIndex,
      side,
      config.orderBlockLookbackBars,
      impulseOrigin.time,
    );
    if (orderBlockIndex === null) continue;
    const orderBlock = candles[orderBlockIndex];
    const distance = distanceToRange(entryPrice, orderBlock.low, orderBlock.high);
    const orderBlockDistanceAtr = distance / atr;
    if (orderBlockDistanceAtr > config.orderBlockProximityAtr) continue;
    return {
      entryPrice,
      equilibriumPrice,
      fvg: gap,
      orderBlockIndex,
      orderBlockLow: orderBlock.low,
      orderBlockHigh: orderBlock.high,
      orderBlockDistanceAtr,
    };
  }
  return null;
}

function findOrderBlockIndex(
  candles: Candle[],
  gapIndex: number,
  side: StrategySide,
  lookbackBars: number,
  notBeforeTime: number,
) {
  const firstIndex = Math.max(0, gapIndex - lookbackBars);
  for (let index = gapIndex - 1; index >= firstIndex; index -= 1) {
    const candle = candles[index];
    if (candle.time < notBeforeTime) break;
    const isOpposite = side === "long" ? candle.close < candle.open : candle.close > candle.open;
    if (isOpposite) return index;
  }
  return null;
}

function wasPriceTouched(candles: Candle[], startIndex: number, endIndex: number, price: number) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (candles[index].low <= price && candles[index].high >= price) return true;
  }
  return false;
}

function distanceToRange(price: number, low: number, high: number) {
  if (price < low) return low - price;
  if (price > high) return price - high;
  return 0;
}

function findLatestBefore(swings: SwingPoint[], index: number) {
  for (let cursor = swings.length - 1; cursor >= 0; cursor -= 1) {
    if (swings[cursor].index < index) return swings[cursor];
  }
  return null;
}

function candleTimeAt(index: number, candles: Candle[] | null) {
  return candles?.[index]?.time ?? 0;
}
