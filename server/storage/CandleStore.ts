import type { Candle, CandleInterval } from "../types";

export interface CandleStore {
  init(): Promise<void>;
  saveCurrent(candle: Candle): Promise<void>;
  getCurrent(symbol: string, interval: CandleInterval): Promise<Candle | null>;
  saveClosed(candle: Candle): Promise<void>;
  getHistory(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]>;
}
