import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { averageTrueRange, confirmedSwings, type SwingPoint } from "../ict/priceAction";
import { isWithinTimeZoneSession, timeInZone } from "../ict/time";

export type BtcFibonacciReclaimConfig = {
  routeId: string;
  symbol: string;
  riskFraction: number;
  zoneStart: number;
  coreRetracement: number;
  zoneEnd: number;
  stopBufferAtr: number;
  minimumStopAtr: number;
  maximumStopAtr: number;
  rewardRisk: number;
  maximumImpulseAgeSeconds: number;
};

export const btcFibonacciReclaimV1Config = Object.freeze({
  routeId: "ict-btc-fib-reclaim-direct-v1-2026-07-17",
  symbol: "BTCUSDT",
  riskFraction: 0.0025,
  zoneStart: 0.618,
  coreRetracement: 0.705,
  zoneEnd: 0.786,
  stopBufferAtr: 0.15,
  minimumStopAtr: 0.25,
  maximumStopAtr: 2.5,
  rewardRisk: 2,
  maximumImpulseAgeSeconds: 12 * 3600,
} satisfies BtcFibonacciReclaimConfig);

type Impulse = {
  id: string;
  side: StrategySide;
  createdAt: number;
  origin: number;
  extreme: number;
  atr: number;
};

export class BtcFibonacciReclaimStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 30;
  private impulseByCompletedBucket = new Map<number, Impulse | null>();
  private emitted = new Set<string>();

  constructor(readonly config: BtcFibonacciReclaimConfig = btcFibonacciReclaimV1Config) {
    this.id = config.routeId;
  }

  prepare(candles: Candle[]) {
    this.impulseByCompletedBucket = buildImpulseContext(candles, this.config);
    this.emitted.clear();
  }

  release() {
    this.impulseByCompletedBucket.clear();
    this.emitted.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (index < this.warmupBars) return null;
    const current = candles[index];
    if (!current || current.symbol !== this.config.symbol) return null;
    if (!isWithinTimeZoneSession(current.time, "Asia/Shanghai", 18 * 60, 8 * 60)) return null;
    if (timeInZone(current.time, "Asia/Shanghai").isWeekend) return null;

    const currentBucket = Math.floor(current.time / 900) * 900;
    const impulse = this.impulseByCompletedBucket.get(currentBucket - 900) ?? null;
    if (!impulse || this.emitted.has(impulse.id) || current.time - impulse.createdAt > this.config.maximumImpulseAgeSeconds) return null;
    if (impulse.side === "long" ? current.low <= impulse.origin : current.high >= impulse.origin) return null;

    const fib = fibonacciPrices(impulse);
    const touched = impulse.side === "long"
      ? current.low <= fib.zoneStartPrice && current.high >= fib.zoneEndPrice
      : current.high >= fib.zoneStartPrice && current.low <= fib.zoneEndPrice;
    const reclaimed = impulse.side === "long"
      ? current.close > current.open && current.close >= fib.corePrice
      : current.close < current.open && current.close <= fib.corePrice;
    if (!touched || !reclaimed) return null;

    const stopPrice = impulse.side === "long"
      ? impulse.origin - impulse.atr * this.config.stopBufferAtr
      : impulse.origin + impulse.atr * this.config.stopBufferAtr;
    const stopDistance = Math.abs(current.close - stopPrice);
    const stopAtr = stopDistance / impulse.atr;
    if (
      stopPrice <= 0 || stopAtr < this.config.minimumStopAtr || stopAtr > this.config.maximumStopAtr ||
      (impulse.side === "long" ? stopPrice >= current.close : stopPrice <= current.close)
    ) return null;
    const targetPrice = impulse.side === "long"
      ? current.close + stopDistance * this.config.rewardRisk
      : current.close - stopDistance * this.config.rewardRisk;
    if (targetPrice <= 0) return null;

    this.emitted.add(impulse.id);
    return makeSignal(current, impulse, fib, stopPrice, targetPrice, stopAtr, this.config);
  }
}

export function fibonacciPrices(impulse: Pick<Impulse, "side" | "origin" | "extreme">) {
  const range = Math.abs(impulse.extreme - impulse.origin);
  const price = (retracement: number) => impulse.side === "long"
    ? impulse.extreme - range * retracement
    : impulse.extreme + range * retracement;
  return {
    zoneStartPrice: price(0.618),
    corePrice: price(0.705),
    zoneEndPrice: price(0.786),
  };
}

function buildImpulseContext(candles: Candle[], config: BtcFibonacciReclaimConfig) {
  const higher = aggregateCandles(candles, "15m");
  const swings = confirmedSwings(higher, higher.length - 1);
  const confirmations = new Map<number, SwingPoint[]>();
  for (const swing of swings) {
    const list = confirmations.get(swing.confirmedAtIndex) ?? [];
    list.push(swing);
    confirmations.set(swing.confirmedAtIndex, list);
  }
  const result = new Map<number, Impulse | null>();
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  let active: Impulse | null = null;
  for (let index = 0; index < higher.length; index += 1) {
    for (const swing of confirmations.get(index) ?? []) {
      if (swing.kind === "high") lastHigh = swing;
      else lastLow = swing;
    }
    const current = higher[index];
    const previous = higher[index - 1];
    const atr = averageTrueRange(higher, index, 14);
    if (active && (current.time - active.createdAt > config.maximumImpulseAgeSeconds || (
      active.side === "long" ? current.low <= active.origin : current.high >= active.origin
    ))) active = null;
    if (previous && atr && atr > 0) {
      const longBreak = lastHigh && lastLow && lastLow.index < lastHigh.index &&
        previous.close <= lastHigh.price && current.close > lastHigh.price;
      const shortBreak = lastHigh && lastLow && lastHigh.index < lastLow.index &&
        previous.close >= lastLow.price && current.close < lastLow.price;
      if (longBreak) active = {
        id: `${current.time}:long`, side: "long", createdAt: current.time,
        origin: lastLow!.price, extreme: current.high, atr,
      };
      else if (shortBreak) active = {
        id: `${current.time}:short`, side: "short", createdAt: current.time,
        origin: lastHigh!.price, extreme: current.low, atr,
      };
    }
    result.set(current.time, active);
  }
  return result;
}

function makeSignal(
  candle: Candle,
  impulse: Impulse,
  fib: ReturnType<typeof fibonacciPrices>,
  stopPrice: number,
  targetPrice: number,
  stopAtr: number,
  config: BtcFibonacciReclaimConfig,
): StrategySignal {
  return {
    id: crypto.createHash("sha256").update(`${config.routeId}:${candle.time}:${impulse.id}`).digest("hex").slice(0, 24),
    strategyId: config.routeId,
    symbol: candle.symbol,
    interval: candle.interval,
    createdAt: candle.time,
    expiresAt: candle.time + 300,
    side: impulse.side,
    entryPrice: candle.close,
    stopPrice,
    targetPrice,
    targetRewardRisk: config.rewardRisk,
    riskFraction: config.riskFraction,
    entryOrderType: "market",
    reasonCodes: ["15M_STRUCTURE_BREAK", "FIB_618_786_ZONE", "FIB_705_RECLAIM", "DIRECT_NEXT_BAR_ENTRY"],
    evidence: {
      routeId: config.routeId,
      impulseId: impulse.id,
      impulseCreatedAt: impulse.createdAt,
      impulseOrigin: impulse.origin,
      impulseExtreme: impulse.extreme,
      impulseAtr: impulse.atr,
      fib618: fib.zoneStartPrice,
      fib705: fib.corePrice,
      fib786: fib.zoneEndPrice,
      stopDistanceAtr: stopAtr,
      regimeKey: `fib_reclaim:${impulse.side}`,
    },
  };
}
