import type { CandleInterval } from "../../../types";

export const tradingIntervals: CandleInterval[] = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
];

export const tradingIntervalLabels: Record<CandleInterval, string> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "8h": "8h",
  "12h": "12h",
  "1d": "1D",
  "3d": "3D",
  "1w": "1W",
  "1M": "1M",
};

export const currentSimulationAccountKey = "xingheng.trading.currentSimulationAccountId";
