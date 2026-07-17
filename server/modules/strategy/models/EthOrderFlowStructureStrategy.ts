import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { isWithinTimeZoneSession, timeInZone } from "../ict/time";

export type EthOrderFlowFamily =
  | "taker_imbalance_continuation"
  | "absorption_reversal"
  | "trade_intensity_breakout";

export type EthOrderFlowStructureConfig = {
  symbol: "ETHUSDT" | "BTCUSDT";
  family: EthOrderFlowFamily;
  threshold: 0.75 | 1.25 | 1.75;
  structureLookbackBars: 6 | 12;
  riskFraction: number;
};

type FeatureSet = {
  candles: Candle[];
  indexByBucket: Map<number, number>;
  atr14: Float64Array;
  ema24: Float64Array;
  ema96: Float64Array;
  imbalanceZ96: Float64Array;
  tradeCountZ96: Float64Array;
  volumeZ96: Float64Array;
  averageTradeQuoteZ96: Float64Array;
  priorHigh24: Float64Array;
  priorLow24: Float64Array;
};

const featureCache = new WeakMap<Candle[], FeatureSet>();
const rewardRisk = 2;
const bufferAtr = 0.15;
const minimumStopAtr = 0.5;
const maximumStopAtr = 2;

export class EthOrderFlowStructureStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 900;
  private preparedCandles: Candle[] | null = null;
  private features: FeatureSet | null = null;

  constructor(readonly config: EthOrderFlowStructureConfig) {
    const market = config.symbol === "BTCUSDT" ? "btc" : "eth";
    this.id = `${market}-orderflow-${config.family}-t${config.threshold}-s${config.structureLookbackBars}`;
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles && this.features) return;
    this.preparedCandles = candles;
    const cached = featureCache.get(candles);
    this.features = cached ?? buildFeatures(candles);
    if (!cached) featureCache.set(candles, this.features);
  }

  release() {
    this.preparedCandles = null;
    this.features = null;
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles || !this.features) this.prepare(candles);
    if (index < this.warmupBars || !this.features) return null;
    const current = candles[index];
    if (!current || current.symbol !== this.config.symbol || current.time % 900 !== 600) return null;
    if (!hasOrderFlow(current)) return null;
    if (!isWithinTimeZoneSession(current.time, "Asia/Shanghai", 18 * 60, 8 * 60)) return null;
    if (timeInZone(current.time, "Asia/Shanghai").isWeekend) return null;

    const bucket = Math.floor(current.time / 900) * 900;
    const factorIndex = this.features.indexByBucket.get(bucket);
    if (factorIndex === undefined || factorIndex < 300) return null;
    const score = factorScore(this.features, factorIndex, this.config.family);
    if (!Number.isFinite(score) || Math.abs(score) < this.config.threshold) return null;
    const previousScore = factorScore(this.features, factorIndex - 1, this.config.family);
    if (
      Number.isFinite(previousScore) &&
      Math.abs(previousScore) >= this.config.threshold &&
      Math.sign(previousScore) === Math.sign(score)
    ) return null;

    const side: StrategySide = score > 0 ? "long" : "short";
    const atr = this.features.atr14[factorIndex];
    if (!Number.isFinite(atr) || atr <= 0) return null;
    const structure = structureExtreme(candles, index, this.config.structureLookbackBars, side);
    const stopPrice = side === "long" ? structure - bufferAtr * atr : structure + bufferAtr * atr;
    const stopDistance = Math.abs(current.close - stopPrice);
    const stopAtr = stopDistance / atr;
    if (
      stopPrice <= 0 ||
      stopAtr < minimumStopAtr ||
      stopAtr > maximumStopAtr ||
      (side === "long" ? stopPrice >= current.close : stopPrice <= current.close)
    ) return null;
    const referenceTarget = side === "long"
      ? current.close + stopDistance * rewardRisk
      : current.close - stopDistance * rewardRisk;
    if (referenceTarget <= 0 || !hasTargetRoom(this.features.candles, factorIndex, side, current.close, referenceTarget)) {
      return null;
    }

    return makeSignal({
      current,
      side,
      score,
      stopPrice,
      referenceTarget,
      atr,
      stopAtr,
      factorIndex,
      features: this.features,
      config: this.config,
      strategyId: this.id,
    });
  }
}

function buildFeatures(input: Candle[]): FeatureSet {
  const candles = aggregateCandles(input, "15m");
  const missing = candles.find((candle) => !hasOrderFlow(candle));
  if (missing) throw new Error(`Order-flow research candle ${missing.time} is missing Binance kline fields.`);
  const closes = candles.map((item) => item.close);
  const imbalance = candles.map((item) => item.volume > 0
    ? (2 * item.takerBuyBaseVolume! - item.volume) / item.volume
    : 0);
  const tradeCounts = candles.map((item) => item.tradeCount!);
  const volumes = candles.map((item) => item.volume);
  const averageTradeQuote = candles.map((item) => item.tradeCount! > 0 ? item.quoteVolume! / item.tradeCount! : 0);
  return {
    candles,
    indexByBucket: new Map(candles.map((item, index) => [item.time, index])),
    atr14: atrSeries(candles, 14),
    ema24: emaSeries(closes, 24),
    ema96: emaSeries(closes, 96),
    imbalanceZ96: rollingZScore(imbalance, 96),
    tradeCountZ96: rollingZScore(tradeCounts, 96),
    volumeZ96: rollingZScore(volumes, 96),
    averageTradeQuoteZ96: rollingZScore(averageTradeQuote, 96),
    priorHigh24: priorExtreme(candles, 24, "high"),
    priorLow24: priorExtreme(candles, 24, "low"),
  };
}

function factorScore(features: FeatureSet, index: number, family: EthOrderFlowFamily) {
  if (index < 96 || index >= features.candles.length) return Number.NaN;
  const candle = features.candles[index];
  const atr = features.atr14[index];
  if (!Number.isFinite(atr) || atr <= 0) return Number.NaN;
  const imbalanceZ = features.imbalanceZ96[index];
  if (family === "taker_imbalance_continuation") {
    const bodyAtr = (candle.close - candle.open) / atr;
    const trendAtr = (features.ema24[index] - features.ema96[index]) / atr;
    return 0.60 * imbalanceZ + 0.25 * bodyAtr + 0.15 * trendAtr;
  }
  if (family === "absorption_reversal") {
    const range = candle.high - candle.low;
    const closeLocation = range > 0 ? 2 * (candle.close - candle.low) / range - 1 : 0;
    if (Math.sign(closeLocation) === Math.sign(imbalanceZ) || Math.abs(imbalanceZ) < 0.5) return Number.NaN;
    return 0.55 * closeLocation - 0.45 * clamp(imbalanceZ, -3, 3);
  }
  const intensity = (
    0.50 * features.tradeCountZ96[index] +
    0.30 * features.volumeZ96[index] +
    0.20 * features.averageTradeQuoteZ96[index]
  );
  if (!Number.isFinite(intensity) || intensity <= 0) return Number.NaN;
  if (candle.close > features.priorHigh24[index]) return intensity;
  if (candle.close < features.priorLow24[index]) return -intensity;
  return Number.NaN;
}

function structureExtreme(candles: Candle[], index: number, lookback: number, side: StrategySide) {
  let extreme = side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let cursor = Math.max(0, index - lookback + 1); cursor <= index; cursor += 1) {
    extreme = side === "long"
      ? Math.min(extreme, candles[cursor].low)
      : Math.max(extreme, candles[cursor].high);
  }
  return extreme;
}

function hasTargetRoom(
  candles: Candle[],
  index: number,
  side: StrategySide,
  reference: number,
  target: number,
) {
  let nearest = side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let cursor = Math.max(2, index - 96); cursor + 2 < index; cursor += 1) {
    if (side === "long" && isConfirmedSwing(candles, cursor, "high")) {
      const level = candles[cursor].high;
      if (level > reference) nearest = Math.min(nearest, level);
    }
    if (side === "short" && isConfirmedSwing(candles, cursor, "low")) {
      const level = candles[cursor].low;
      if (level < reference) nearest = Math.max(nearest, level);
    }
  }
  if (!Number.isFinite(nearest)) return true;
  return side === "long" ? target <= nearest : target >= nearest;
}

function isConfirmedSwing(candles: Candle[], index: number, field: "high" | "low") {
  const value = candles[index][field];
  const neighbors = [candles[index - 2][field], candles[index - 1][field], candles[index + 1][field], candles[index + 2][field]];
  return field === "high"
    ? neighbors.every((neighbor) => value > neighbor)
    : neighbors.every((neighbor) => value < neighbor);
}

function makeSignal(input: {
  current: Candle;
  side: StrategySide;
  score: number;
  stopPrice: number;
  referenceTarget: number;
  atr: number;
  stopAtr: number;
  factorIndex: number;
  features: FeatureSet;
  config: EthOrderFlowStructureConfig;
  strategyId: string;
}): StrategySignal {
  const { current, side, score, stopPrice, referenceTarget, atr, stopAtr, factorIndex, features, config, strategyId } = input;
  return {
    id: crypto.createHash("sha256")
      .update(`${strategyId}:${current.time}:${side}`)
      .digest("hex")
      .slice(0, 24),
    strategyId,
    symbol: current.symbol,
    interval: current.interval,
    createdAt: current.time,
    expiresAt: current.time + 300,
    side,
    entryPrice: current.close,
    stopPrice,
    targetPrice: referenceTarget,
    targetRewardRisk: rewardRisk,
    riskFraction: config.riskFraction,
    entryOrderType: "market",
    reasonCodes: [config.symbol === "BTCUSDT" ? "BTC_KLINE_ORDERFLOW" : "ETH_KLINE_ORDERFLOW", config.family.toUpperCase(), "STRUCTURE_STOP", "ACTUAL_FILL_2R"],
    evidence: {
      regimeKey: `${config.family}:15m:${side}`,
      family: config.family,
      score,
      threshold: config.threshold,
      structureLookbackBars: config.structureLookbackBars,
      atr15m: atr,
      stopAtr,
      bufferAtr,
      rewardRisk,
      imbalanceZ: features.imbalanceZ96[factorIndex],
      tradeCountZ: features.tradeCountZ96[factorIndex],
      volumeZ: features.volumeZ96[factorIndex],
      averageTradeQuoteZ: features.averageTradeQuoteZ96[factorIndex],
    },
  };
}

function hasOrderFlow(candle: Candle): candle is Candle & Required<Pick<Candle,
  "quoteVolume" | "tradeCount" | "takerBuyBaseVolume" | "takerBuyQuoteVolume"
>> {
  return [
    candle.quoteVolume,
    candle.tradeCount,
    candle.takerBuyBaseVolume,
    candle.takerBuyQuoteVolume,
  ].every((value) => Number.isFinite(value) && value! >= 0);
}

function emaSeries(values: number[], period: number) {
  const output = new Float64Array(values.length);
  if (!values.length) return output;
  output[0] = values[0];
  const alpha = 2 / (period + 1);
  for (let index = 1; index < values.length; index += 1) {
    output[index] = values[index] * alpha + output[index - 1] * (1 - alpha);
  }
  return output;
}

function atrSeries(candles: Candle[], period: number) {
  const output = new Float64Array(candles.length);
  if (!candles.length) return output;
  output[0] = candles[0].high - candles[0].low;
  for (let index = 1; index < candles.length; index += 1) {
    const previousClose = candles[index - 1].close;
    const range = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - previousClose),
      Math.abs(candles[index].low - previousClose),
    );
    output[index] = index < period
      ? (output[index - 1] * index + range) / (index + 1)
      : (output[index - 1] * (period - 1) + range) / period;
  }
  return output;
}

function rollingZScore(values: number[], period: number) {
  const output = new Float64Array(values.length);
  let sum = 0;
  let squares = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    squares += values[index] ** 2;
    if (index >= period) {
      sum -= values[index - period];
      squares -= values[index - period] ** 2;
    }
    const count = Math.min(period, index + 1);
    const mean = sum / count;
    const deviation = Math.sqrt(Math.max(0, squares / count - mean ** 2));
    output[index] = deviation > 0 ? (values[index] - mean) / deviation : 0;
  }
  return output;
}

function priorExtreme(candles: Candle[], period: number, field: "high" | "low") {
  const output = new Float64Array(candles.length);
  for (let index = 0; index < candles.length; index += 1) {
    let value = field === "high" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let cursor = Math.max(0, index - period); cursor < index; cursor += 1) {
      value = field === "high" ? Math.max(value, candles[cursor][field]) : Math.min(value, candles[cursor][field]);
    }
    output[index] = Number.isFinite(value) ? value : candles[index][field];
  }
  return output;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
