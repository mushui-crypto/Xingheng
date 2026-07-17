import crypto from "node:crypto";
import type { Candle } from "../../../types";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { isWithinTimeZoneSession } from "../ict/time";

export type EthFactorFamily = "trend_continuation" | "channel_breakout" | "atr_mean_reversion";
export type EthFactorSession = "all" | "beijing_non_asia";

export type EthFactorScoreConfig = {
  symbol: "ETHUSDT";
  family: EthFactorFamily;
  threshold: 1 | 1.5 | 2;
  stopAtr: 1.5 | 2;
  rewardRisk: 1.5 | 2 | 2.5;
  session: EthFactorSession;
  riskFraction: number;
  maximumHoldingBars: number;
};

export const defaultEthFactorScoreConfig: EthFactorScoreConfig = {
  symbol: "ETHUSDT",
  family: "trend_continuation",
  threshold: 1.5,
  stopAtr: 1.5,
  rewardRisk: 2,
  session: "all",
  riskFraction: 0.0025,
  maximumHoldingBars: 24,
};

type FeatureSet = {
  atr14: Float64Array;
  atr96: Float64Array;
  ema24: Float64Array;
  ema48: Float64Array;
  ema96: Float64Array;
  volumeZ96: Float64Array;
  priorHigh72: Float64Array;
  priorLow72: Float64Array;
};

const featureCache = new Map<string, FeatureSet>();

export class EthFactorScoreStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 300;
  private preparedCandles: Candle[] | null = null;
  private features: FeatureSet | null = null;

  constructor(readonly config: EthFactorScoreConfig = defaultEthFactorScoreConfig) {
    this.id = `eth-factor-${config.family}-${config.session}`;
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles && this.features) return;
    this.preparedCandles = candles;
    const key = featureKey(candles);
    const cached = featureCache.get(key);
    this.features = cached ?? buildFeatures(candles);
    if (!cached) featureCache.set(key, this.features);
  }

  release() {
    this.preparedCandles = null;
    this.features = null;
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles || !this.features) this.prepare(candles);
    if (index < this.warmupBars || candles[index]?.symbol !== this.config.symbol || !this.features) return null;
    const current = candles[index];
    if (
      this.config.session === "beijing_non_asia" &&
      !isWithinTimeZoneSession(current.time, "Asia/Shanghai", 18 * 60, 8 * 60)
    ) return null;

    const score = factorScore(candles, this.features, index, this.config.family);
    const previousScore = factorScore(candles, this.features, index - 1, this.config.family);
    if (!Number.isFinite(score) || Math.abs(score) < this.config.threshold) return null;
    if (
      Number.isFinite(previousScore) &&
      Math.abs(previousScore) >= this.config.threshold &&
      Math.sign(previousScore) === Math.sign(score)
    ) return null;

    const atr = this.features.atr14[index];
    if (!Number.isFinite(atr) || atr <= 0) return null;
    const side: StrategySide = score > 0 ? "long" : "short";
    const riskDistance = atr * this.config.stopAtr;
    const stopPrice = side === "long" ? current.close - riskDistance : current.close + riskDistance;
    const targetPrice = side === "long"
      ? current.close + riskDistance * this.config.rewardRisk
      : current.close - riskDistance * this.config.rewardRisk;
    if (stopPrice <= 0 || targetPrice <= 0) return null;

    return toSignal({
      strategyId: this.id,
      candle: current,
      side,
      score,
      atr,
      stopPrice,
      targetPrice,
      config: this.config,
    });
  }
}

export function factorScore(
  candles: Candle[],
  features: FeatureSet,
  index: number,
  family: EthFactorFamily,
) {
  if (index < 96 || index >= candles.length) return Number.NaN;
  const candle = candles[index];
  const atr = features.atr14[index];
  if (!Number.isFinite(atr) || atr <= 0) return Number.NaN;
  const emaSpreadAtr = (features.ema24[index] - features.ema96[index]) / atr;
  const volumeZ = clamp(features.volumeZ96[index], -3, 3);

  if (family === "trend_continuation") {
    const momentumAtr = (candle.close - candles[index - 24].close) / atr;
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

function toSignal(input: {
  strategyId: string;
  candle: Candle;
  side: StrategySide;
  score: number;
  atr: number;
  stopPrice: number;
  targetPrice: number;
  config: EthFactorScoreConfig;
}): StrategySignal {
  const { strategyId, candle, side, score, atr, stopPrice, targetPrice, config } = input;
  return {
    id: crypto.createHash("sha256")
      .update(`${strategyId}:${config.threshold}:${config.stopAtr}:${config.rewardRisk}:${candle.time}:${side}`)
      .digest("hex")
      .slice(0, 24),
    strategyId,
    symbol: candle.symbol,
    interval: candle.interval,
    createdAt: candle.time,
    expiresAt: candle.time + 5 * 60,
    side,
    entryPrice: candle.close,
    stopPrice,
    targetPrice,
    riskFraction: config.riskFraction,
    entryOrderType: "market",
    maxHoldingSeconds: config.maximumHoldingBars * 5 * 60,
    reasonCodes: ["ETH_FACTOR_SCORE_THRESHOLD_CROSS", config.family.toUpperCase()],
    evidence: {
      regimeKey: `${config.family}:${config.session}:${side}`,
      family: config.family,
      session: config.session,
      score,
      threshold: config.threshold,
      atr,
      stopAtr: config.stopAtr,
      rewardRisk: config.rewardRisk,
      maximumHoldingBars: config.maximumHoldingBars,
    },
  };
}

function buildFeatures(candles: Candle[]): FeatureSet {
  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  return {
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
  if (values.length === 0) return output;
  const alpha = 2 / (period + 1);
  output[0] = values[0];
  for (let index = 1; index < values.length; index += 1) {
    output[index] = values[index] * alpha + output[index - 1] * (1 - alpha);
  }
  return output;
}

function atrSeries(candles: Candle[], period: number) {
  const output = new Float64Array(candles.length);
  if (candles.length === 0) return output;
  output[0] = candles[0].high - candles[0].low;
  for (let index = 1; index < candles.length; index += 1) {
    const previousClose = candles[index - 1].close;
    const trueRange = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - previousClose),
      Math.abs(candles[index].low - previousClose),
    );
    output[index] = index < period
      ? (output[index - 1] * index + trueRange) / (index + 1)
      : (output[index - 1] * (period - 1) + trueRange) / period;
  }
  return output;
}

function rollingZScore(values: number[], period: number) {
  const output = new Float64Array(values.length);
  let sum = 0;
  let squareSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    squareSum += values[index] * values[index];
    if (index >= period) {
      sum -= values[index - period];
      squareSum -= values[index - period] * values[index - period];
    }
    const count = Math.min(index + 1, period);
    const mean = sum / count;
    const variance = Math.max(0, squareSum / count - mean * mean);
    const standardDeviation = Math.sqrt(variance);
    output[index] = standardDeviation > 0 ? (values[index] - mean) / standardDeviation : 0;
  }
  return output;
}

function priorExtreme(candles: Candle[], period: number, field: "high" | "low") {
  const output = new Float64Array(candles.length);
  for (let index = 0; index < candles.length; index += 1) {
    let extreme = field === "high" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let cursor = Math.max(0, index - period); cursor < index; cursor += 1) {
      extreme = field === "high"
        ? Math.max(extreme, candles[cursor].high)
        : Math.min(extreme, candles[cursor].low);
    }
    output[index] = Number.isFinite(extreme) ? extreme : candles[index][field];
  }
  return output;
}

function featureKey(candles: Candle[]) {
  const sampleIndexes = [
    0,
    Math.floor(candles.length / 4),
    Math.floor(candles.length / 2),
    Math.floor(candles.length * 3 / 4),
    Math.max(0, candles.length - 1),
  ];
  const samples = sampleIndexes.map((index) => {
    const candle = candles[index];
    return candle ? `${candle.time}:${candle.close}:${candle.volume}` : "missing";
  }).join("|");
  return `${candles[0]?.symbol ?? ""}:${candles.length}:${samples}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
