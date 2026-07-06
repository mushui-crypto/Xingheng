import type { TradingAccount } from "./market";
import { adminHeaders, requestJson, userHeaders } from "./httpClient";

export type WalletAsset = "USDT";
export type WalletAccountType = "wallet" | "funding" | "trading" | "simulation" | "realTrading";
export type WalletNetwork = "BSC_TESTNET";
export type ExternalWalletProvider = "metamask";
export type ExternalWalletBindStatus = "pending" | "active";
export type OnchainDepositStatus = "detected" | "confirming" | "confirmed" | "failed";
export type WithdrawalStatus = "pending_review" | "broadcasting" | "broadcasted" | "confirmed" | "failed" | "rejected";
export type AccountTransferType = "account_transfer" | "internal_transfer";
export type AccountTransferStatus = "completed" | "failed" | "reversed";
export type FundingOrderType = "deposit" | "withdrawal" | "account_transfer" | "internal_transfer";
export type FundingOrderDisplayStatus = "processing" | "pending" | "completed" | "cancelled" | "failed";
export type FundingOrderDirection = "in" | "out" | "neutral";

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

export type RealTradingAccount = FundingAccount & {
  status?: "active" | "disabled";
  opened?: boolean;
  enabled?: boolean;
};

export type SimulationAccountView = TradingAccount & {
  name?: string;
  status?: "active" | "deleted" | "disabled";
  lastResetAt?: number | null;
  nextResetAvailableAt?: number | null;
  canReset?: boolean;
  availableMargin?: number;
  unrealizedPnl?: number;
};

export type SimulationAccountsResponse = {
  items: SimulationAccountView[];
  accountCount: number;
  accountLimit: number;
  canCreate: boolean;
};

export type SimulationAccountMutationResponse = {
  account: SimulationAccountView;
  accountCount?: number;
  accountLimit?: number;
  canCreate?: boolean;
  nextResetAvailableAt?: number | null;
  canReset?: boolean;
};

export type SimulationSummary = {
  asset: WalletAsset;
  totalEquity: number;
  todayPnl: number;
  todayPnlRate: number;
  accountCount: number;
  accountLimit: number;
  canCreateSimulationAccount: boolean;
};

export type WalletAccounts = {
  wallet?: FundingAccount | null;
  funding: FundingAccount;
  realTrading?: RealTradingAccount | null;
  simulation?: SimulationAccountView | null;
  simulationSummary?: SimulationSummary;
  simulationAccounts?: SimulationAccountView[];
  /**
   * 旧后端兼容字段：历史上 trading 表示模拟交易账户。
   * 前端只允许把它作为 simulation 的兜底，不再作为“交易账户”主口径展示。
   */
  trading?: SimulationAccountView | null;
};

export type RecentFundingActivity = {
  id: string;
  activityType: "onchain_deposit" | "withdrawal" | "account_transfer" | "internal_transfer" | "funding_ledger";
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

export type PaginatedEnvelope<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

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
  recentFundingActivities?: RecentFundingActivity[];
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

export type ExternalWalletBindingResponse = {
  binding: ExternalWalletBinding | null;
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

export type AccountTransferResponse = {
  transfer: AccountTransferRecord;
  accounts: WalletAccounts;
};

export type FundingLedgerEntry = {
  id: string;
  userId: string;
  accountId: string;
  accountType: WalletAccountType;
  type:
    | "deposit"
    | "withdrawal_freeze"
    | "withdrawal_approved"
    | "withdrawal_rejected"
    | "transfer_in"
    | "transfer_out"
    | "internal_transfer_in"
    | "internal_transfer_out"
    | "adjustment";
  source:
    | "admin_manual"
    | "withdrawal_request"
    | "internal_transfer"
    | "account_transfer"
    | "user_internal_transfer"
    | "onchain_deposit"
    | "onchain_reserved";
  asset: WalletAsset;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  frozenBefore: number;
  frozenAfter: number;
  status: "pending" | "completed" | "rejected";
  relatedId?: string | null;
  network?: string | null;
  walletAddress?: string | null;
  txHash?: string | null;
  remark?: string | null;
  createdAt: number;
  updatedAt: number;
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

export type DepositAddress = {
  id: string;
  userId: string;
  network: WalletNetwork;
  address: string;
  derivationIndex: number;
  createdAt: number;
  updatedAt: number;
  chainId?: number;
  tokenAddress?: string;
  tokenDecimals?: number;
  tokenSymbol?: string;
  explorerBaseUrl?: string;
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

export async function fetchWalletAccounts() {
  return requestJson<WalletAccounts>("/api/wallet/accounts", "钱包账户加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchSimulationAccounts() {
  return requestJson<SimulationAccountsResponse>("/api/wallet/simulation-accounts", "模拟账户加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function createSimulationAccount(name?: string) {
  return requestJson<SimulationAccountMutationResponse>("/api/wallet/simulation-accounts", "模拟账户创建失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...userHeaders() },
      body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
    },
    userAuthFailure: true,
  });
}

export async function renameSimulationAccount(id: string, name: string) {
  return requestJson<SimulationAccountMutationResponse>(
    `/api/wallet/simulation-accounts/${encodeURIComponent(id)}`,
    "模拟账户重命名失败。",
    {
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: JSON.stringify({ name }),
      },
      userAuthFailure: true,
    },
  );
}

export async function deleteSimulationAccount(id: string) {
  return requestJson<{ ok: true }>(`/api/wallet/simulation-accounts/${encodeURIComponent(id)}`, "模拟账户删除失败。", {
    init: {
      method: "DELETE",
      headers: userHeaders(),
    },
    userAuthFailure: true,
  });
}

export async function resetSimulationAccount(id: string) {
  return requestJson<SimulationAccountMutationResponse>(
    `/api/wallet/simulation-accounts/${encodeURIComponent(id)}/reset`,
    "模拟账户资金重置失败。",
    {
      init: {
        method: "POST",
        headers: userHeaders(),
      },
      userAuthFailure: true,
    },
  );
}

export async function fetchAccountOverview() {
  return requestJson<AccountOverview>("/api/wallet/overview", "账户总览加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRecentFundingActivities() {
  return requestJson<RecentFundingActivity[]>("/api/wallet/recent-activities", "近期资金记录加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchFundingOrders(type: "all" | "deposit" | "withdrawal" | "transfer" | FundingOrderType = "all", limit = 50) {
  const params = new URLSearchParams({ type, limit: String(limit) });
  return requestJson<PaginatedEnvelope<FundingOrder>>(`/api/wallet/funding-orders?${params.toString()}`, "资金订单加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchOnchainRecords(limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  return requestJson<PaginatedEnvelope<OnchainRecord>>(`/api/wallet/onchain-records?${params.toString()}`, "链上充提记录加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchExternalWalletBinding() {
  return requestJson<ExternalWalletBindingResponse>(
    "/api/wallet/external-wallet",
    "第三方钱包绑定状态加载失败。",
    {
      init: { headers: userHeaders() },
      userAuthFailure: true,
      networkErrorMessage: "第三方钱包绑定状态加载失败。 无法连接服务，请检查网络或稍后重试。",
    },
  );
}

export async function createExternalWalletChallenge(walletAddress: string, network: WalletNetwork = "BSC_TESTNET", provider: ExternalWalletProvider = "metamask") {
  return requestJson<ExternalWalletChallenge>(
    "/api/wallet/external-wallet/challenge",
    "第三方钱包签名请求失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: JSON.stringify({ walletAddress, network, provider }),
      },
      userAuthFailure: true,
      networkErrorMessage: "第三方钱包签名请求失败。 无法连接服务，请检查网络或稍后重试。",
    },
  );
}

export async function bindExternalWallet(challengeId: string, walletAddress: string, signature: string) {
  return requestJson<{ binding: ExternalWalletBinding }>(
    "/api/wallet/external-wallet/bind",
    "第三方钱包绑定失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: JSON.stringify({ challengeId, walletAddress, signature }),
      },
      userAuthFailure: true,
      networkErrorMessage: "第三方钱包绑定失败。 无法连接服务，请检查网络或稍后重试。",
    },
  );
}

export async function unbindExternalWallet() {
  return requestJson<ExternalWalletBindingResponse & { ok?: true }>(
    "/api/wallet/external-wallet",
    "第三方钱包解绑失败。",
    {
      init: {
        method: "DELETE",
        headers: userHeaders(),
      },
      userAuthFailure: true,
      networkErrorMessage: "第三方钱包解绑失败。 无法连接服务，请检查网络或稍后重试。",
    },
  );
}

export async function fetchDepositAddress() {
  return requestJson<DepositAddress>("/api/wallet/deposit-address", "充值地址加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchOnchainDeposits() {
  return requestJson<OnchainDeposit[]>("/api/wallet/deposits", "链上充值记录加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchWalletLedger() {
  return requestJson<FundingLedgerEntry[]>("/api/wallet/ledger", "资金流水加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchWalletTransfers() {
  return requestJson<AccountTransferRecord[]>("/api/wallet/transfers", "转账记录加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function transferWalletAccount(
  from: WalletAccountType,
  to: WalletAccountType,
  amount: number,
  remark: string,
) {
  return requestJson<AccountTransferResponse>("/api/wallet/account-transfer", "账户划转失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...userHeaders() },
      body: JSON.stringify({ from, to, amount, remark }),
    },
    userAuthFailure: true,
  });
}

export async function createInternalTransfer(recipient: string, amount: number, remark: string, clientRequestId?: string) {
  return requestJson<AccountTransferResponse>("/api/wallet/internal-transfer", "内部转账失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...userHeaders() },
      body: JSON.stringify({ recipient, amount, remark, clientRequestId }),
    },
    userAuthFailure: true,
  });
}

export async function createWithdrawalRequest(amount: number, network: string, walletAddress: string, remark: string) {
  return requestJson<WithdrawalRequest>("/api/wallet/withdrawals", "提现申请提交失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...userHeaders() },
      body: JSON.stringify({ amount, network, walletAddress, remark }),
    },
    userAuthFailure: true,
  });
}

export async function fetchWithdrawalRequests() {
  return requestJson<WithdrawalRequest[]>("/api/wallet/withdrawals", "提现申请加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchAdminWalletAccounts() {
  return requestJson<WalletAccounts[]>("/api/admin/wallet/accounts", "后台钱包账户加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminDepositAddresses() {
  return requestJson<DepositAddress[]>("/api/admin/wallet/deposit-addresses", "后台充值地址加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminOnchainDeposits() {
  return requestJson<OnchainDeposit[]>("/api/admin/wallet/deposits", "后台链上充值记录加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminWalletLedger() {
  return requestJson<FundingLedgerEntry[]>("/api/admin/wallet/ledger", "后台资金流水加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminWalletTransfers() {
  return requestJson<AccountTransferRecord[]>("/api/admin/wallet/transfers", "后台转账记录加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminWithdrawalRequests() {
  return requestJson<WithdrawalRequest[]>("/api/admin/wallet/withdrawals", "后台提现申请加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function depositFundingAccount(userId: string, amount: number, remark: string) {
  return requestJson<WalletAccounts>("/api/admin/wallet/deposit", "后台充值失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ userId, amount, remark }),
    },
  });
}

export async function approveWithdrawalRequest(id: string, reviewNote: string, txHash = "") {
  return requestJson<WithdrawalRequest>(`/api/admin/wallet/withdrawals/${id}/approve`, "提现审核通过失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ reviewNote, txHash }),
    },
  });
}

export async function rejectWithdrawalRequest(id: string, reviewNote: string) {
  return requestJson<WithdrawalRequest>(`/api/admin/wallet/withdrawals/${id}/reject`, "提现拒绝失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ reviewNote }),
    },
  });
}

export async function runAdminOnchainScan() {
  return requestJson<{
    fromBlock?: number;
    toBlock?: number;
    scannedBlocks?: number;
    deposits?: number;
    saved?: number;
    credited?: number;
    status?: "ok" | "rate_limited";
    rateLimited?: boolean;
    message?: string;
  }>("/api/admin/wallet/onchain/scan", "链上扫描触发失败。", {
    init: {
      method: "POST",
      headers: adminHeaders(),
    },
  });
}

export async function confirmAdminWithdrawals() {
  return requestJson<WithdrawalRequest[]>("/api/admin/wallet/withdrawals/confirm", "提现确认触发失败。", {
    init: {
      method: "POST",
      headers: adminHeaders(),
    },
  });
}
