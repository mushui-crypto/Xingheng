import type { Candle } from "../../../types";
import { averageTrueRange } from "./priceAction";
import { newYorkTime } from "./time";

export type MarketRegime = {
  volatility: "low" | "normal" | "high";
  volatilityRatio: number;
  structure: "trend" | "rotation";
  session: "new_york_premarket" | "new_york_cash" | "off_hours";
  calendar: "weekday" | "weekend";
  key: string;
};

export function classifyMarketRegime(candles: Candle[], index: number): MarketRegime {
  const atr = averageTrueRange(candles, index, 14) ?? 0;
  let atrTotal = 0;
  let atrCount = 0;
  for (let cursor = Math.max(14, index - 240); cursor < index; cursor += 5) {
    const value = averageTrueRange(candles, cursor, 14);
    if (value !== null) {
      atrTotal += value;
      atrCount += 1;
    }
  }
  const atrBaseline = atrCount ? atrTotal / atrCount : atr;
  const volatilityRatio = atrBaseline > 0 ? atr / atrBaseline : 1;
  const volatility = volatilityRatio >= 1.25 ? "high" : volatilityRatio <= 0.75 ? "low" : "normal";

  const lookback = Math.min(60, index);
  let path = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) {
    path += Math.abs(candles[cursor].close - candles[cursor - 1].close);
  }
  const displacement = lookback > 0 ? Math.abs(candles[index].close - candles[index - lookback].close) : 0;
  const efficiencyRatio = path > 0 ? displacement / path : 0;
  const structure = efficiencyRatio >= 0.35 ? "trend" : "rotation";

  const ny = newYorkTime(candles[index].time);
  const session = ny.minuteOfDay >= 9 * 60 + 30 && ny.minuteOfDay < 16 * 60
    ? "new_york_cash"
    : ny.minuteOfDay >= 8 * 60 + 30 && ny.minuteOfDay < 9 * 60 + 30
      ? "new_york_premarket"
      : "off_hours";
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
    .format(new Date(candles[index].time * 1000));
  const calendar = weekday === "Sat" || weekday === "Sun" ? "weekend" : "weekday";
  return {
    volatility,
    volatilityRatio,
    structure,
    session,
    calendar,
    key: `${volatility}:${structure}:${session}:${calendar}`,
  };
}
