export type MarketSource = "binance";
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
  asset: "USDT";
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

export type WalletAccountType = "funding" | "trading";
export type WalletAsset = "USDT";
export type WalletNetwork = "BSC_TESTNET";
export type OnchainDepositStatus = "detected" | "confirming" | "confirmed" | "failed";
export type WithdrawalStatus = "pending_review" | "broadcasting" | "broadcasted" | "confirmed" | "failed" | "rejected";

export type DepositAddress = {
  id: string;
  userId: string;
  network: WalletNetwork;
  address: string;
  derivationIndex: number;
  createdAt: number;
  updatedAt: number;
};

export type OnchainDeposit = {
  id: string;
  userId: string;
  asset: WalletAsset;
  network: WalletNetwork;
  chainId: number;
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountDecimal: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash?: string | null;
  confirmations: number;
  status: OnchainDepositStatus;
  creditedLedgerId?: string | null;
  failedReason?: string | null;
  detectedAt: number;
  confirmedAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ChainScanCursor = {
  id: string;
  network: WalletNetwork;
  chainId: number;
  tokenAddress: string;
  lastScannedBlock: number;
  updatedAt: number;
};

export type FundingAccount = {
  id: string;
  userId: string;
  asset: WalletAsset;
  balance: number;
  frozen: number;
  available: number;
  createdAt: number;
  updatedAt: number;
};

export type FundingLedgerType =
  | "deposit"
  | "withdrawal_freeze"
  | "withdrawal_approved"
  | "withdrawal_rejected"
  | "transfer_in"
  | "transfer_out"
  | "adjustment";

export type FundingLedgerSource = "admin_manual" | "withdrawal_request" | "internal_transfer" | "onchain_deposit" | "onchain_reserved";
export type FundingLedgerStatus = "pending" | "completed" | "rejected";

export type FundingLedgerEntry = {
  id: string;
  userId: string;
  accountId: string;
  accountType: WalletAccountType;
  type: FundingLedgerType;
  source: FundingLedgerSource;
  asset: WalletAsset;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  frozenBefore: number;
  frozenAfter: number;
  status: FundingLedgerStatus;
  relatedId?: string | null;
  network?: string | null;
  walletAddress?: string | null;
  txHash?: string | null;
  remark?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type UserStatus = "active" | "disabled";

export type User = {
  id: string;
  email: string;
  nickname?: string;
  status: UserStatus;
  createdAt: string;
};

export type WithdrawalRequest = {
  id: string;
  userId: string;
  asset: WalletAsset;
  amount: number;
  status: WithdrawalStatus;
  network?: string | null;
  walletAddress?: string | null;
  txHash?: string | null;
  onchainStatus?: WithdrawalStatus | null;
  chainId?: number | null;
  tokenAddress?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  broadcastTxHash?: string | null;
  broadcastedAt?: number | null;
  confirmedAt?: number | null;
  failedAt?: number | null;
  failedReason?: string | null;
  confirmations?: number | null;
  broadcastAttemptCount?: number | null;
  lastBroadcastAttemptAt?: number | null;
  remark?: string | null;
  reviewNote?: string | null;
  createdAt: number;
  reviewedAt?: number | null;
  updatedAt: number;
};
