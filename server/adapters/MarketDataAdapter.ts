import type { MarketTick } from "../types";

export type TickCallback = (tick: MarketTick) => void;

export interface MarketDataAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(symbols: string[]): Promise<void>;
  unsubscribe(symbols: string[]): Promise<void>;
  onTick(callback: TickCallback): () => void;
  reconnect(): Promise<void>;
}
