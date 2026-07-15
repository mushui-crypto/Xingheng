import type { Candle, CandleInterval } from "../../../types";

export type StrategySide = "long" | "short";

export type StrategySignal = {
  id: string;
  strategyId: string;
  symbol: string;
  interval: CandleInterval;
  createdAt: number;
  expiresAt: number;
  side: StrategySide;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskFraction: number;
  entryOrderType?: "limit" | "market";
  reasonCodes: string[];
  evidence: Record<string, number | string | boolean>;
};

export type StrategyEvaluationContext = {
  candles: Candle[];
  index: number;
  equity: number;
};

export interface Strategy {
  readonly id: string;
  readonly warmupBars: number;
  prepare?(candles: Candle[]): void;
  release?(): void;
  evaluate(context: StrategyEvaluationContext): StrategySignal | null;
}

export type StrategyFactory<TConfig> = (config: TConfig) => Strategy;
