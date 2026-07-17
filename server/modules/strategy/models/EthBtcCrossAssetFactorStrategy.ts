import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { isWithinTimeZoneSession } from "../ict/time";
import type { EthFactorSession } from "./EthFactorScoreStrategy";

export type EthBtcCrossAssetFamily = "btc_lead_lag" | "eth_relative_momentum" | "cross_asset_residual_reversion";

export type EthBtcCrossAssetFactorConfig = {
  symbol: "ETHUSDT";
  family: EthBtcCrossAssetFamily;
  threshold: 0.75 | 1 | 1.25;
  stopAtr: 0.75 | 1;
  rewardRisk: 1.5 | 2 | 2.5;
  session: EthFactorSession;
  riskFraction: number;
  maximumHoldingBars: number;
  cooldownFactorBars: number;
};

type Features = {
  eth: Candle[];
  btc: Candle[];
  indexByBucket: Map<number, number>;
  ethAtr: Float64Array;
  btcAtr: Float64Array;
  ethEma24: Float64Array;
  ethEma96: Float64Array;
  btcEma24: Float64Array;
  btcEma96: Float64Array;
};

const cache = new Map<string, Features>();

export class EthBtcCrossAssetFactorStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 900;
  private preparedEth: Candle[] | null = null;
  private features: Features | null = null;

  constructor(
    readonly config: EthBtcCrossAssetFactorConfig,
    private readonly btcFiveMinuteCandles: Candle[],
  ) {
    this.id = `eth-btc-cross-${config.family}-${config.session}`;
  }

  prepare(ethFiveMinuteCandles: Candle[]) {
    if (this.preparedEth === ethFiveMinuteCandles && this.features) return;
    this.preparedEth = ethFiveMinuteCandles;
    const key = cacheKey(ethFiveMinuteCandles, this.btcFiveMinuteCandles);
    const cached = cache.get(key);
    this.features = cached ?? buildFeatures(ethFiveMinuteCandles, this.btcFiveMinuteCandles);
    if (!cached) cache.set(key, this.features);
  }

  release() {
    this.preparedEth = null;
    this.features = null;
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedEth !== candles || !this.features) this.prepare(candles);
    if (index < this.warmupBars || !this.features || candles[index]?.symbol !== this.config.symbol) return null;
    const current = candles[index];
    if (current.time % 900 !== 600) return null;
    if (
      this.config.session === "beijing_non_asia" &&
      !isWithinTimeZoneSession(current.time, "Asia/Shanghai", 18 * 60, 8 * 60)
    ) return null;
    const bucket = Math.floor(current.time / 900) * 900;
    const factorIndex = this.features.indexByBucket.get(bucket);
    if (factorIndex === undefined || factorIndex < 300) return null;
    const score = crossAssetScore(this.features, factorIndex, this.config.family);
    const previous = crossAssetScore(this.features, factorIndex - 1, this.config.family);
    if (!Number.isFinite(score) || Math.abs(score) < this.config.threshold) return null;
    if (Number.isFinite(previous) && Math.abs(previous) >= this.config.threshold && Math.sign(previous) === Math.sign(score)) return null;
    for (let cursor = Math.max(300, factorIndex - this.config.cooldownFactorBars); cursor < factorIndex - 1; cursor += 1) {
      if (Math.abs(crossAssetScore(this.features, cursor, this.config.family)) >= this.config.threshold) return null;
    }
    const atr = this.features.ethAtr[factorIndex];
    if (!Number.isFinite(atr) || atr <= 0) return null;
    const side: StrategySide = score > 0 ? "long" : "short";
    const distance = atr * this.config.stopAtr;
    const stopPrice = side === "long" ? current.close - distance : current.close + distance;
    const targetPrice = side === "long"
      ? current.close + distance * this.config.rewardRisk
      : current.close - distance * this.config.rewardRisk;
    if (stopPrice <= 0 || targetPrice <= 0) return null;
    return makeSignal({ strategyId: this.id, current, side, score, atr, stopPrice, targetPrice, config: this.config });
  }
}
function crossAssetScore(features: Features, index: number, family: EthBtcCrossAssetFamily) {
  if (index < 96 || index >= features.eth.length || index >= features.btc.length) return Number.NaN;
  const ethAtr = features.ethAtr[index];
  const btcAtr = features.btcAtr[index];
  if (ethAtr <= 0 || btcAtr <= 0) return Number.NaN;
  const ethImpulse4 = (features.eth[index].close - features.eth[index - 4].close) / ethAtr;
  const btcImpulse4 = (features.btc[index].close - features.btc[index - 4].close) / btcAtr;
  const ethMomentum16 = (features.eth[index].close - features.eth[index - 16].close) / ethAtr;
  const btcMomentum16 = (features.btc[index].close - features.btc[index - 16].close) / btcAtr;
  const ethTrend = (features.ethEma24[index] - features.ethEma96[index]) / ethAtr;
  const btcTrend = (features.btcEma24[index] - features.btcEma96[index]) / btcAtr;
  if (family === "btc_lead_lag") return 0.60 * (btcImpulse4 - ethImpulse4) + 0.40 * btcTrend;
  if (family === "eth_relative_momentum") return 0.70 * (ethMomentum16 - btcMomentum16) + 0.30 * ethTrend;
  const reversalBody = (features.eth[index].close - features.eth[index].open) / ethAtr;
  return -(ethImpulse4 - btcImpulse4) + 0.25 * reversalBody;
}

function makeSignal(input: {
  strategyId: string;
  current: Candle;
  side: StrategySide;
  score: number;
  atr: number;
  stopPrice: number;
  targetPrice: number;
  config: EthBtcCrossAssetFactorConfig;
}): StrategySignal {
  const { strategyId, current, side, score, atr, stopPrice, targetPrice, config } = input;
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
    reasonCodes: ["BTC_ETH_CROSS_ASSET_FACTOR", config.family.toUpperCase(), "NEXT_5M_EXECUTION"],
    evidence: {
      regimeKey: `${config.family}:15m:${config.session}:${side}`,
      family: config.family,
      factorInterval: "15m",
      executionInterval: "5m",
      session: config.session,
      score,
      threshold: config.threshold,
      ethAtr15m: atr,
      stopAtr: config.stopAtr,
      rewardRisk: config.rewardRisk,
      cooldownFactorBars: config.cooldownFactorBars,
    },
  };
}

function buildFeatures(ethInput: Candle[], btcInput: Candle[]): Features {
  const eth15m = aggregateCandles(ethInput, "15m");
  const btcByTime = new Map(aggregateCandles(btcInput, "15m").map((item) => [item.time, item]));
  const eth: Candle[] = [];
  const btc: Candle[] = [];
  for (const candle of eth15m) {
    const matching = btcByTime.get(candle.time);
    if (!matching) continue;
    eth.push(candle);
    btc.push(matching);
  }
  const ethClose = eth.map((item) => item.close);
  const btcClose = btc.map((item) => item.close);
  return {
    eth,
    btc,
    indexByBucket: new Map(eth.map((item, index) => [item.time, index])),
    ethAtr: atrSeries(eth, 14),
    btcAtr: atrSeries(btc, 14),
    ethEma24: emaSeries(ethClose, 24),
    ethEma96: emaSeries(ethClose, 96),
    btcEma24: emaSeries(btcClose, 24),
    btcEma96: emaSeries(btcClose, 96),
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

function cacheKey(eth: Candle[], btc: Candle[]) {
  const sample = (candles: Candle[]) => [0, Math.floor(candles.length / 2), Math.max(0, candles.length - 1)]
    .map((index) => `${candles[index]?.time ?? 0}:${candles[index]?.close ?? 0}`)
    .join("|");
  return `cross:${eth.length}:${sample(eth)}:${btc.length}:${sample(btc)}`;
}
