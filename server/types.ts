export type MarketSource = "hyperliquid";
export type MarketStatus = "connected" | "stale" | "disconnected";
export type CandleInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";

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
  quoteVolume?: number;
  tradeCount?: number;
  takerBuyBaseVolume?: number;
  takerBuyQuoteVolume?: number;
};

export type MarketCategory = "crypto" | "metals" | "us_equities" | "indices" | "other";
export type MarketSourceType = "main" | "hip3";

export type MarketSymbol = {
  symbol: string;
  displayName: string;
  apiSymbol: string;
  providerMarketId: string;
  providerCoin: string;
  sourceDex: string;
  sourceType: MarketSourceType;
  category: MarketCategory;
  iconUrl?: string | null;
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
  accountId: string;
  simulationAccountId: string;
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
  simulationAccountId?: string;
  asset: "USDT";
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  floatingPnl: number;
  createdAt: number;
  updatedAt: number;
};

export type SimulationAccountStatus = "active" | "deleted" | "disabled";

export type SimulationAccount = TradingAccount & {
  name: string;
  status: SimulationAccountStatus;
  lastResetAt?: number | null;
};

export type SimulationAccountView = SimulationAccount & {
  nextResetAvailableAt?: number | null;
  canReset: boolean;
};

export type OrderRecord = {
  id: string;
  userId: string;
  accountId: string;
  simulationAccountId: string;
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

export type WalletAccountType = "wallet" | "funding" | "trading" | "simulation" | "realTrading";
export type WalletAsset = "USDT";
export type WalletNetwork = "BSC_TESTNET";
export type ExternalWalletProvider = "metamask";
export type ExternalWalletBindStatus = "pending" | "active";
export type OnchainDepositStatus = "detected" | "confirming" | "confirmed" | "failed";
export type WithdrawalStatus = "pending_review" | "broadcasting" | "broadcasted" | "confirmed" | "failed" | "rejected";
export type AccountTransferType = "account_transfer" | "internal_transfer";
export type AccountTransferStatus = "completed" | "failed" | "reversed";

export type DepositAddress = {
  id: string;
  userId: string;
  network: WalletNetwork;
  address: string;
  derivationIndex: number;
  createdAt: number;
  updatedAt: number;
  isConfigured?: boolean;
  message?: string | null;
};

export type ExternalWalletBinding = {
  id: string;
  userId: string;
  walletAddress: string;
  network: WalletNetwork;
  provider: ExternalWalletProvider;
  isDefault: boolean;
  bindStatus: ExternalWalletBindStatus;
  nonce: string;
  challenge: string;
  challengeExpiresAt: number;
  lastVerifiedAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ExternalWalletChallenge = {
  challengeId: string;
  walletAddress: string;
  network: WalletNetwork;
  provider: ExternalWalletProvider;
  nonce: string;
  message: string;
  expiresAt: number;
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

export type AccountOverview = {
  asset: WalletAsset;
  walletEquity: number;
  fundingEquity: number;
  realTradingEquity: number;
  totalEquity: number;
  accountTodayPnl: number;
  accountTodayPnlRate: number;
  simulationTotalEquity: number;
  simulationTodayPnl: number;
  simulationTodayPnlRate: number;
  simulationAccountCount: number;
  simulationAccountLimit: number;
  canCreateSimulationAccount: boolean;
  recentFundingActivities: RecentFundingActivity[];
};

export type AccountTransferRecord = {
  id: string;
  transferType: AccountTransferType;
  asset: WalletAsset;
  amount: number;
  fromUserId: string;
  toUserId: string;
  fromAccountType: WalletAccountType;
  toAccountType: WalletAccountType;
  status: AccountTransferStatus;
  clientRequestId?: string | null;
  remark?: string | null;
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
  | "internal_transfer_in"
  | "internal_transfer_out"
  | "adjustment";

export type FundingLedgerSource =
  | "admin_manual"
  | "withdrawal_request"
  | "internal_transfer"
  | "account_transfer"
  | "user_internal_transfer"
  | "onchain_deposit"
  | "onchain_reserved";
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
  address?: string | null;
  txHash?: string | null;
  remark?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RecentFundingActivity = {
  id: string;
  activityType:
    | "onchain_deposit"
    | "withdrawal"
    | "account_transfer"
    | "internal_transfer"
    | "funding_ledger";
  title: string;
  accountType?: WalletAccountType | null;
  fromAccountType?: WalletAccountType | null;
  toAccountType?: WalletAccountType | null;
  amount: number;
  asset: WalletAsset;
  status: string;
  direction: "in" | "out" | "neutral";
  txHash?: string | null;
  remark?: string | null;
  createdAt: number;
};

export type FundingOrderType = "deposit" | "withdrawal" | "account_transfer" | "internal_transfer";
export type FundingOrderDisplayStatus = "processing" | "pending" | "completed" | "cancelled" | "failed";
export type FundingOrderDirection = "in" | "out" | "neutral";

export type FundingOrder = {
  id: string;
  orderType: FundingOrderType;
  accountType: "funding";
  amount: number;
  asset: WalletAsset;
  status: string;
  displayStatus: FundingOrderDisplayStatus;
  direction: FundingOrderDirection;
  fromAccountType?: WalletAccountType | null;
  toAccountType?: WalletAccountType | null;
  relatedLedgerId?: string | null;
  relatedTransferId?: string | null;
  relatedWithdrawalId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type OnchainRecord = {
  id: string;
  type: "deposit" | "withdrawal";
  amount: number;
  asset: WalletAsset;
  network: WalletNetwork | string;
  fromAddress?: string | null;
  toAddress?: string | null;
  txHash?: string | null;
  confirmations?: number | null;
  chainStatus: string;
  createdAt: number;
  updatedAt: number;
  relatedWithdrawalId?: string | null;
  relatedDepositId?: string | null;
};

export type UserStatus = "active" | "disabled";

export type User = {
  id: string;
  email: string;
  nickname?: string;
  status: UserStatus;
  createdAt: string;
  emailVerifiedAt?: string | null;
};

export type EmailTokenPurpose = "register" | "password_reset";

export type EmailTokenRecord = {
  id: string;
  email: string;
  purpose: EmailTokenPurpose;
  userId?: string | null;
  codeHash: string;
  tokenHash: string;
  expiresAt: number;
  usedAt?: number | null;
  createdAt: number;
};

export type WithdrawalRequest = {
  id: string;
  userId: string;
  asset: WalletAsset;
  amount: number;
  status: WithdrawalStatus;
  network?: string | null;
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
