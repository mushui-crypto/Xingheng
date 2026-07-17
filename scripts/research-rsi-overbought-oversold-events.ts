import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

type EventType = "oversold" | "overbought";
type TrendRegime = "uptrend" | "downtrend" | "neutral";
type Session = "asia_00_08_utc" | "europe_08_16_utc" | "america_16_24_utc";
type Stage = "2021_2023" | "2024_2026";
type Horizon = "1h" | "4h" | "12h" | "24h";
type EventOutcome = { returnFraction: number; maximumUpFraction: number; maximumDownFraction: number };
type RsiEvent = {
  symbol: MartingaleGridSymbol;
  type: EventType;
  signalTime: number;
  signalTimeIso: string;
  signalPrice: number;
  rsi: number;
  trendRegime: TrendRegime;
  session: Session;
  stage: Stage;
  outcomes: Record<Horizon, EventOutcome>;
};

const warmupStart = Date.parse("2020-11-01T00:00:00Z") / 1000;
const evaluationStart = Date.parse("2021-01-01T00:00:00Z") / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const horizons: Record<Horizon, number> = { "1h": 4, "4h": 16, "12h": 48, "24h": 96 };
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const acceptedEvents: RsiEvent[] = [];
const rawEvents: Array<Omit<RsiEvent, "outcomes">> = [];
const dataQuality = {} as Record<MartingaleGridSymbol, unknown>;
const rawTriggerCounts = {} as Record<MartingaleGridSymbol, Record<EventType, number>>;

for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  const monthly = await source.loadMonths(monthRange("2020-11", "2026-06", symbol));
  const daily = await source.loadDays(dayRange("2026-07-01", "2026-07-15", symbol));
  const fiveMinute = normalize([...monthly.candles, ...daily.candles]).filter((candle) => candle.time >= warmupStart && candle.time < throughExclusive);
  const missing = countMissing(fiveMinute, 300);
  if (missing !== 0) throw new Error(`${symbol} RSI event history contains ${missing} missing 5m bars.`);
  const fifteenMinute = aggregate(fiveMinute, 900, "15m");
  const fourHour = aggregate(fiveMinute, 14_400, "4h");
  const rsi = wilderRsi(fifteenMinute.map((candle) => candle.close), 14);
  const trendByTime = completedFourHourTrend(fourHour);
  let lastAcceptedTime = Number.NEGATIVE_INFINITY;
  let oversoldRaw = 0;
  let overboughtRaw = 0;
  for (let index = 15; index < fifteenMinute.length - horizons["24h"]; index += 1) {
    const previous = rsi[index - 1];
    const current = rsi[index];
    if (previous === null || current === null) continue;
    const signalTime = fifteenMinute[index].time + 900;
    if (signalTime < evaluationStart || signalTime >= throughExclusive) continue;
    const type: EventType | null = previous > 30 && current <= 30
      ? "oversold"
      : previous < 70 && current >= 70
        ? "overbought"
        : null;
    if (!type) continue;
    if (type === "oversold") oversoldRaw += 1;
    else overboughtRaw += 1;
    const rawEvent = {
      symbol,
      type,
      signalTime,
      signalTimeIso: new Date(signalTime * 1000).toISOString(),
      signalPrice: fifteenMinute[index].close,
      rsi: current,
      trendRegime: trendAt(trendByTime, signalTime),
      session: sessionAt(signalTime),
      stage: signalTime < Date.parse("2024-01-01T00:00:00Z") / 1000 ? "2021_2023" as const : "2024_2026" as const,
    };
    rawEvents.push(rawEvent);
    if (signalTime - lastAcceptedTime < 4 * 3600) continue;
    lastAcceptedTime = signalTime;
    const candle = fifteenMinute[index];
    acceptedEvents.push({
      symbol,
      type,
      signalTime,
      signalTimeIso: new Date(signalTime * 1000).toISOString(),
      signalPrice: rawEvent.signalPrice,
      rsi: rawEvent.rsi,
      trendRegime: rawEvent.trendRegime,
      session: rawEvent.session,
      stage: rawEvent.stage,
      outcomes: Object.fromEntries(Object.entries(horizons).map(([horizon, bars]) => {
        const future = fifteenMinute[index + bars];
        const path = fifteenMinute.slice(index + 1, index + bars + 1);
        return [horizon, {
          returnFraction: future.close / candle.close - 1,
          maximumUpFraction: Math.max(...path.map((item) => item.high)) / candle.close - 1,
          maximumDownFraction: Math.min(...path.map((item) => item.low)) / candle.close - 1,
        }];
      })) as Record<Horizon, EventOutcome>,
    });
  }
  rawTriggerCounts[symbol] = { oversold: oversoldRaw, overbought: overboughtRaw };
  dataQuality[symbol] = {
    source: "binance_vision_usdm",
    sourceInterval: "5m",
    candleCount5m: fiveMinute.length,
    candleCount15m: fifteenMinute.length,
    candleCount4h: fourHour.length,
    missingBarCount5m: missing,
    duplicateCount: monthly.quality.duplicateCount + daily.quality.duplicateCount,
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    first: iso(fiveMinute[0]?.time ?? null),
    last: iso(fiveMinute.at(-1)?.time ?? null),
  };
  console.info(JSON.stringify({ event: "rsi_event_symbol_complete", symbol, raw: rawTriggerCounts[symbol], accepted: acceptedEvents.filter((item) => item.symbol === symbol).length }));
}

const groups = {
  overall: grouped(acceptedEvents, (event) => `${event.type}`),
  bySymbol: grouped(acceptedEvents, (event) => `${event.symbol}|${event.type}`),
  byTrend: grouped(acceptedEvents, (event) => `${event.trendRegime}|${event.type}`),
  bySymbolTrend: grouped(acceptedEvents, (event) => `${event.symbol}|${event.trendRegime}|${event.type}`),
  byStage: grouped(acceptedEvents, (event) => `${event.stage}|${event.type}`),
  bySession: grouped(acceptedEvents, (event) => `${event.session}|${event.type}`),
  byStageTrend: grouped(acceptedEvents, (event) => `${event.stage}|${event.trendRegime}|${event.type}`),
  byStageSession: grouped(acceptedEvents, (event) => `${event.stage}|${event.session}|${event.type}`),
  byTrendSession: grouped(acceptedEvents, (event) => `${event.trendRegime}|${event.session}|${event.type}`),
  byStageTrendSession: grouped(acceptedEvents, (event) => `${event.stage}|${event.trendRegime}|${event.session}|${event.type}`),
  bySymbolStageTrend: grouped(acceptedEvents, (event) => `${event.symbol}|${event.stage}|${event.trendRegime}|${event.type}`),
};
const report = {
  routeId: "binance-usdm-btc-eth-rsi14-overbought-oversold-event-study-v1",
  generatedAt: new Date().toISOString(),
  status: "descriptive_event_study_complete",
  range: { warmupStart: "2020-11-01", evaluationStart: "2021-01-01", through: "2026-07-15" },
  assumptions: {
    sourceIndicatorInterval: "15m",
    indicator: "Wilder_RSI_14",
    oversoldThreshold: 30,
    overboughtThreshold: 70,
    triggerMode: "first_cross_into_extreme",
    globalPerSymbolCooldownHours: 4,
    outcomeHorizons: Object.keys(horizons),
    automaticOrdersEnabled: false,
    feesAndSlippageIncluded: false,
  },
  dataQuality,
  rawTriggerCounts,
  acceptedEventCount: acceptedEvents.length,
  rawEvents,
  groups,
  events: acceptedEvents,
};
const output = path.resolve("server/data/strategy/research-rsi-overbought-oversold-events-v1.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "rsi_event_study_complete", acceptedEventCount: report.acceptedEventCount, overall: report.groups.overall, output }));

function grouped(events: RsiEvent[], keyFor: (event: RsiEvent) => string) {
  const buckets = new Map<string, RsiEvent[]>();
  for (const event of events) buckets.set(keyFor(event), [...(buckets.get(keyFor(event)) ?? []), event]);
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, items]) => [key, summarize(items)]));
}

function summarize(events: RsiEvent[]) {
  return {
    sampleCount: events.length,
    horizons: Object.fromEntries((Object.keys(horizons) as Horizon[]).map((horizon) => {
      const values = events.map((event) => event.outcomes[horizon]);
      const returns = values.map((value) => value.returnFraction);
      const eventType = events[0]?.type ?? "oversold";
      return [horizon, {
        averageReturnFraction: average(returns),
        medianReturnFraction: median(returns),
        positiveRate: returns.filter((value) => value > 0).length / Math.max(1, returns.length),
        contrarianSuccessRate: returns.filter((value) => eventType === "oversold" ? value > 0 : value < 0).length / Math.max(1, returns.length),
        averageContrarianReturnFraction: average(returns.map((value) => eventType === "oversold" ? value : -value)),
        averageMaximumUpFraction: average(values.map((value) => value.maximumUpFraction)),
        averageMaximumDownFraction: average(values.map((value) => value.maximumDownFraction)),
      }];
    })),
  };
}

function completedFourHourTrend(candles: Candle[]) {
  const ema50 = ema(candles.map((candle) => candle.close), 50);
  const ema200 = ema(candles.map((candle) => candle.close), 200);
  return candles.flatMap((candle, index) => {
    if (ema50[index] === null || ema200[index] === null) return [];
    const regime: TrendRegime = ema50[index]! > ema200[index]! && candle.close > ema200[index]!
      ? "uptrend"
      : ema50[index]! < ema200[index]! && candle.close < ema200[index]!
        ? "downtrend"
        : "neutral";
    return [{ completedAt: candle.time + 14_400, regime }];
  });
}

function trendAt(points: Array<{ completedAt: number; regime: TrendRegime }>, signalTime: number): TrendRegime {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].completedAt <= signalTime) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found >= 0 ? points[found].regime : "neutral";
}

function wilderRsi(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = values.map(() => null);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  output[period] = rsiFromAverages(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    output[index] = rsiFromAverages(averageGain, averageLoss);
  }
  return output;
}
function rsiFromAverages(gain: number, loss: number) { if (loss === 0) return 100; if (gain === 0) return 0; return 100 - 100 / (1 + gain / loss); }
function ema(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = values.map(() => null);
  if (values.length < period) return output;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) { value = values[index] * alpha + value * (1 - alpha); output[index] = value; }
  return output;
}
function aggregate(candles: Candle[], seconds: number, interval: string) {
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const time = Math.floor(candle.time / seconds) * seconds;
    const existing = buckets.get(time);
    if (!existing) buckets.set(time, { ...candle, time, interval });
    else { existing.high = Math.max(existing.high, candle.high); existing.low = Math.min(existing.low, candle.low); existing.close = candle.close; existing.volume += candle.volume; }
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time);
}
function sessionAt(time: number): Session { const hour = new Date(time * 1000).getUTCHours(); return hour < 8 ? "asia_00_08_utc" : hour < 16 ? "europe_08_16_utc" : "america_16_24_utc"; }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values: number[]) { if (!values.length) return 0; const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function normalize(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time); }
function countMissing(candles: Candle[], seconds: number) { let missing = 0; for (let index = 1; index < candles.length; index += 1) { const delta = candles[index].time - candles[index - 1].time; if (delta > seconds) missing += Math.floor(delta / seconds) - 1; } return missing; }
function iso(seconds: number | null) { return seconds === null ? null : new Date(seconds * 1000).toISOString(); }
