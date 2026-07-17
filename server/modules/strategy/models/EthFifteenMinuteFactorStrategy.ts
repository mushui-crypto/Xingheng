import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { isWithinTimeZoneSession } from "../ict/time";
import type { EthFactorFamily, EthFactorSession } from "./EthFactorScoreStrategy";

export type EthFifteenMinuteFactorConfig = {
  symbol: "ETHUSDT";
  family: EthFactorFamily;
  threshold: 1 | 1.5;
  stopAtr: 0.75 | 1;
  rewardRisk: 1.5 | 2 | 2.5;
  session: EthFactorSession;
  riskFraction: number;
  maximumHoldingBars: number;
};

type FeatureSet = {
  candles: Candle[];
  indexByBucket: Map<number, number>;
  atr14: Float64Array;
  atr96: Float64Array;
  ema24: Float64Array;
  ema48: Float64Array;
  ema96: Float64Array;
  volumeZ96: Float64Array;
  priorHigh72: Float64Array;
  priorLow72: Float64Array;
};

const cache = new Map<string, FeatureSet>();

export class EthFifteenMinuteFactorStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 900;
  private preparedCandles: Candle[] | null = null;
  private features: FeatureSet | null = null;

  constructor(readonly config: EthFifteenMinuteFactorConfig) {
    this.id = `eth-15m-factor-${config.family}-${config.session}`;
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles && this.features) return;
    this.preparedCandles = candles;
    const key = cacheKey(candles);
    const cached = cache.get(key);
    this.features = cached ?? buildFeatures(candles);
    if (!cached) cache.set(key, this.features);
  }

  release() {
    this.preparedCandles = null;
    this.features = null;
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles || !this.features) this.prepare(candles);
    if (index < this.warmupBars || !this.features || candles[index]?.symbol !== this.config.symbol) return null;
    const current = candles[index];
    if (current.time % (15 * 60) !== 10 * 60) return null;
    if (
      this.config.session === "beijing_non_asia" &&
      !isWithinTimeZoneSession(current.time, "Asia/Shanghai", 18 * 60, 8 * 60)
    ) return null;

    const bucket = Math.floor(current.time / 900) * 900;
    const factorIndex = this.features.indexByBucket.get(bucket);
    if (factorIndex === undefined || factorIndex < 300) return null;
    const score = factorScore(this.features, factorIndex, this.config.family);
    const previous = factorScore(this.features, factorIndex - 1, this.config.family);
    if (!Number.isFinite(score) || Math.abs(score) < this.config.threshold) return null;
    if (Number.isFinite(previous) && Math.abs(previous) >= this.config.threshold && Math.sign(previous) === Math.sign(score)) return null;

    const atr = this.features.atr14[factorIndex];
    if (!Number.isFinite(atr) || atr <= 0) return null;
    const side: StrategySide = score > 0 ? "long" : "short";
    const distance = atr * this.config.stopAtr;
    const stopPrice = side === "long" ? current.close - distance : current.close + distance;
    const targetPrice = side === "long"
      ? current.close + distance * this.config.rewardRisk
      : current.close - distance * this.config.rewardRisk;
    if (stopPrice <= 0 || targetPrice <= 0) return null;
    return signal({ current, side, score, atr, stopPrice, targetPrice, config: this.config, strategyId: this.id });
  }
}
function factorScore(features: FeatureSet, index: number, family: EthFactorFamily) {
  if (index < 96 || index >= features.candles.length) return Number.NaN;
  const candle = features.candles[index];
  const atr = features.atr14[index];
  if (!Number.isFinite(atr) || atr <= 0) return Number.NaN;
  const emaSpreadAtr = (features.ema24[index] - features.ema96[index]) / atr;
  const volumeZ = clamp(features.volumeZ96[index], -3, 3);
  if (family === "trend_continuation") {
    const momentumAtr = (candle.close - features.candles[index - 24].close) / atr;
    return 0.55 * emaSpreadAtr + 0.35 * momentumAtr + 0.10 * volumeZ;
  }
  if (family === "channel_breakout") {
    const priorHigh = features.priorHigh72[index];
    const priorLow = features.priorLow72[index];
    const halfRange = (priorHigh - priorLow) / 2;
    if (!Number.isFinite(halfRange) || halfRange <= 0) return Number.NaN;
    const channelPosition = (candle.close - (priorHigh + priorLow) / 2) / halfRange;
    const direction = Math.sign(channelPosition) || 1;
    const volatilityExpansion = Math.max(0, features.atr14[index] / features.atr96[index] - 1);
    return channelPosition + direction * 0.25 * Math.max(0, volumeZ) + direction * 0.25 * volatilityExpansion;
  }
  const deviationAtr = (candle.close - features.ema48[index]) / atr;
  const reversalBodyAtr = (candle.close - candle.open) / atr;
  return -deviationAtr + 0.5 * reversalBodyAtr - 0.1 * emaSpreadAtr;
}

function signal(input: {
  current: Candle;
  side: StrategySide;
  score: number;
  atr: number;
  stopPrice: number;
  targetPrice: number;
  config: EthFifteenMinuteFactorConfig;
  strategyId: string;
}): StrategySignal {
  const { current, side, score, atr, stopPrice, targetPrice, config, strategyId } = input;
  return {
    id: crypto.createHash("sha256")
      .update(`${strategyId}:${config.threshold}:${config.stopAtr}:${config.rewardRisk}:${current.time}:${side}`)
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
    targetPrice,
    riskFraction: config.riskFraction,
    entryOrderType: "market",
    maxHoldingSeconds: config.maximumHoldingBars * 300,
    reasonCodes: ["ETH_15M_FACTOR_THRESHOLD_CROSS", config.family.toUpperCase(), "NEXT_5M_EXECUTION"],
    evidence: {
      regimeKey: `${config.family}:15m:${config.session}:${side}`,
      family: config.family,
      factorInterval: "15m",
      executionInterval: "5m",
      session: config.session,
      score,
      threshold: config.threshold,
      atr15m: atr,
      stopAtr: config.stopAtr,
      rewardRisk: config.rewardRisk,
    },
  };
}

function buildFeatures(input: Candle[]): FeatureSet {
  const candles = aggregateCandles(input, "15m");
  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  return {
    candles,
    indexByBucket: new Map(candles.map((item, index) => [item.time, index])),
    atr14: atrSeries(candles, 14),
    atr96: atrSeries(candles, 96),
    ema24: emaSeries(closes, 24),
    ema48: emaSeries(closes, 48),
    ema96: emaSeries(closes, 96),
    volumeZ96: rollingZScore(volumes, 96),
    priorHigh72: priorExtreme(candles, 72, "high"),
    priorLow72: priorExtreme(candles, 72, "low"),
  };
}

function emaSeries(values: number[], period: number) {
  const output = new Float64Array(values.length);
  if (!values.length) return output;
  output[0] = values[0];
  const alpha = 2 / (period + 1);
  for (let index = 1; index < values.length; index += 1) output[index] = values[index] * alpha + output[index - 1] * (1 - alpha);
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
      value = field === "high" ? Math.max(value, candles[cursor].high) : Math.min(value, candles[cursor].low);
    }
    output[index] = Number.isFinite(value) ? value : candles[index][field];
  }
  return output;
}

function cacheKey(candles: Candle[]) {
  const indexes = [0, Math.floor(candles.length / 2), Math.max(0, candles.length - 1)];
  const sample = indexes.map((index) => `${candles[index]?.time ?? 0}:${candles[index]?.close ?? 0}:${candles[index]?.volume ?? 0}`).join("|");
  return `15m:${candles[0]?.symbol ?? ""}:${candles.length}:${sample}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
