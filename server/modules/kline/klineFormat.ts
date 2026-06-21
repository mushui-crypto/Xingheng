import type { Candle } from "../../types";

export type PublicKline = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

export type PublicKlineMessage = {
  type: "kline";
  symbol: string;
  interval: string;
  data: Omit<PublicKline, "timestamp">;
  timestamp: number;
};

export function toPublicKline(candle: Candle): PublicKline {
  return {
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    timestamp: candle.time,
  };
}

export function toPublicKlineMessage(candle: Candle): PublicKlineMessage {
  return {
    type: "kline",
    symbol: candle.symbol,
    interval: candle.interval,
    data: {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
    timestamp: candle.time,
  };
}
