export type MarketSource = "binance" | "tradermade" | "mock";
export type MarketStatus = "connected" | "stale" | "disconnected";
export type CandleInterval = "1m" | "5m" | "15m" | "1h";

export type MarketTick = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  spread: number;
  source: MarketSource;
  timestamp: number;
};

export type Candle = {
  symbol: string;
  interval: CandleInterval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketSymbol = {
  symbol: string;
  displayName: string;
  apiSymbol: string;
  category: "forex" | "metal" | "crypto" | "index" | "stock";
  digits: number;
  spread: number;
  leverage: number;
  contractSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  tradeStatus: "enabled" | "close_only" | "disabled";
  isVisible: boolean;
};

export type TradeSide = "buy" | "sell";
export type PositionSide = "long" | "short";

export type Position = {
  id: string;
  userId: string;
  symbol: string;
  side: PositionSide;
  volume: number;
  entryPrice: number;
  margin: number;
  openedAt: number;
  source: MarketSource;
  quoteTime: number;
  entryBid: number;
  entryAsk: number;
  entrySpread: number;
};

export type PositionView = Position & {
  markPrice: number | null;
  pnl: number | null;
};

export type TradingAccount = {
  id: string;
  userId: string;
  currency: string;
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  floatingPnl: number;
  createdAt: number;
  updatedAt: number;
};

export type OrderRecord = {
  id: string;
  userId: string;
  accountId: string;
  positionId?: string;
  symbol: string;
  side: TradeSide;
  positionSide: PositionSide;
  orderType: "Market";
  action: "open" | "close";
  status: "filled" | "rejected";
  volume: number;
  price: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  source: MarketSource | "unknown";
  quoteTime: number | null;
  simulated: true;
  reason?: string;
  pnl?: number;
  createdAt: number;
};

export type BalanceAdjustment = {
  id: string;
  accountId: string;
  userId: string;
  type: "deposit" | "withdraw" | "reset";
  amount: number;
  previousBalance: number;
  nextBalance: number;
  note?: string;
  createdAt: number;
};
