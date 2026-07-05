import type { TradingAccount } from "./market";
import { readStorage, storageKeys } from "../utils/storage";
import { handleUserAuthFailure } from "./session";

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

function userHeaders(userId?: string | null): Record<string, string> {
  const auth = readStorage<{ isLoggedIn?: boolean; userToken?: string | null }>(storageKeys.auth, {});
  return auth.userToken ? { Authorization: `Bearer ${auth.userToken}` } : {};
}

function adminHeaders(): Record<string, string> {
  const auth = readStorage<{ isAdminLoggedIn?: boolean; adminToken?: string | null }>(storageKeys.adminAuth, {});
  return auth.adminToken ? { Authorization: `Bearer ${auth.adminToken}` } : {};
}

async function readJson<T>(response: Response, fallbackMessage: string, options?: { userAuthFailure?: boolean }) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (options?.userAuthFailure && (response.status === 401 || response.status === 403)) {
      handleUserAuthFailure(payload?.message ?? "账号已禁用或登录已失效，请重新登录。");
    }
    throw new Error(payload?.message ?? fallbackMessage);
  }
  return payload as T;
}

export async function fetchWalletAccounts() {
  const response = await fetch("/api/wallet/accounts", { headers: userHeaders() });
  return readJson<WalletAccounts>(response, "钱包账户加载失败。", { userAuthFailure: true });
}

export async function fetchSimulationAccounts() {
  const response = await fetch("/api/wallet/simulation-accounts", { headers: userHeaders() });
  return readJson<SimulationAccountsResponse>(response, "模拟账户加载失败。", { userAuthFailure: true });
}

export async function createSimulationAccount(name?: string) {
  const response = await fetch("/api/wallet/simulation-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
  });
  return readJson<SimulationAccountMutationResponse>(response, "模拟账户创建失败。", { userAuthFailure: true });
}

export async function renameSimulationAccount(id: string, name: string) {
  const response = await fetch(`/api/wallet/simulation-accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ name }),
  });
  return readJson<SimulationAccountMutationResponse>(response, "模拟账户重命名失败。", { userAuthFailure: true });
}

export async function deleteSimulationAccount(id: string) {
  const response = await fetch(`/api/wallet/simulation-accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: userHeaders(),
  });
  return readJson<{ ok: true }>(response, "模拟账户删除失败。", { userAuthFailure: true });
}

export async function resetSimulationAccount(id: string) {
  const response = await fetch(`/api/wallet/simulation-accounts/${encodeURIComponent(id)}/reset`, {
    method: "POST",
    headers: userHeaders(),
  });
  return readJson<SimulationAccountMutationResponse>(response, "模拟账户资金重置失败。", { userAuthFailure: true });
}

export async function fetchAccountOverview() {
  const response = await fetch("/api/wallet/overview", { headers: userHeaders() });
  return readJson<AccountOverview>(response, "账户总览加载失败。", { userAuthFailure: true });
}

export async function fetchRecentFundingActivities() {
  const response = await fetch("/api/wallet/recent-activities", { headers: userHeaders() });
  return readJson<RecentFundingActivity[]>(response, "近期资金记录加载失败。", { userAuthFailure: true });
}

export async function fetchFundingOrders(type: "all" | "deposit" | "withdrawal" | "transfer" | FundingOrderType = "all", limit = 50) {
  const params = new URLSearchParams({ type, limit: String(limit) });
  const response = await fetch(`/api/wallet/funding-orders?${params.toString()}`, { headers: userHeaders() });
  return readJson<PaginatedEnvelope<FundingOrder>>(response, "资金订单加载失败。", { userAuthFailure: true });
}

export async function fetchOnchainRecords(limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`/api/wallet/onchain-records?${params.toString()}`, { headers: userHeaders() });
  return readJson<PaginatedEnvelope<OnchainRecord>>(response, "链上充提记录加载失败。", { userAuthFailure: true });
}

export async function fetchExternalWalletBinding() {
  const response = await fetch("/api/wallet/external-wallet", { headers: userHeaders() });
  return readJson<ExternalWalletBindingResponse>(response, "第三方钱包绑定状态加载失败。", { userAuthFailure: true });
}

export async function createExternalWalletChallenge(walletAddress: string, network: WalletNetwork = "BSC_TESTNET", provider: ExternalWalletProvider = "metamask") {
  const response = await fetch("/api/wallet/external-wallet/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ walletAddress, network, provider }),
  });
  return readJson<ExternalWalletChallenge>(response, "第三方钱包签名请求失败。", { userAuthFailure: true });
}

export async function bindExternalWallet(challengeId: string, walletAddress: string, signature: string) {
  const response = await fetch("/api/wallet/external-wallet/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ challengeId, walletAddress, signature }),
  });
  return readJson<{ binding: ExternalWalletBinding }>(response, "第三方钱包绑定失败。", { userAuthFailure: true });
}

export async function unbindExternalWallet() {
  const response = await fetch("/api/wallet/external-wallet", {
    method: "DELETE",
    headers: userHeaders(),
  });
  return readJson<ExternalWalletBindingResponse & { ok?: true }>(response, "第三方钱包解绑失败。", { userAuthFailure: true });
}

export async function fetchDepositAddress() {
  const response = await fetch("/api/wallet/deposit-address", { headers: userHeaders() });
  return readJson<DepositAddress>(response, "充值地址加载失败。", { userAuthFailure: true });
}

export async function fetchOnchainDeposits() {
  const response = await fetch("/api/wallet/deposits", { headers: userHeaders() });
  return readJson<OnchainDeposit[]>(response, "链上充值记录加载失败。", { userAuthFailure: true });
}

export async function fetchWalletLedger() {
  const response = await fetch("/api/wallet/ledger", { headers: userHeaders() });
  return readJson<FundingLedgerEntry[]>(response, "资金流水加载失败。", { userAuthFailure: true });
}

export async function fetchWalletTransfers() {
  const response = await fetch("/api/wallet/transfers", { headers: userHeaders() });
  return readJson<AccountTransferRecord[]>(response, "转账记录加载失败。", { userAuthFailure: true });
}

export async function transferWalletAccount(
  from: WalletAccountType,
  to: WalletAccountType,
  amount: number,
  remark: string,
) {
  const response = await fetch("/api/wallet/account-transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ from, to, amount, remark }),
  });
  return readJson<AccountTransferResponse>(response, "账户划转失败。", { userAuthFailure: true });
}

export async function createInternalTransfer(recipient: string, amount: number, remark: string, clientRequestId?: string) {
  const response = await fetch("/api/wallet/internal-transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ recipient, amount, remark, clientRequestId }),
  });
  return readJson<AccountTransferResponse>(response, "内部转账失败。", { userAuthFailure: true });
}

export async function createWithdrawalRequest(amount: number, network: string, walletAddress: string, remark: string) {
  const response = await fetch("/api/wallet/withdrawals", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ amount, network, walletAddress, remark }),
  });
  return readJson<WithdrawalRequest>(response, "提现申请提交失败。", { userAuthFailure: true });
}

export async function fetchWithdrawalRequests() {
  const response = await fetch("/api/wallet/withdrawals", { headers: userHeaders() });
  return readJson<WithdrawalRequest[]>(response, "提现申请加载失败。", { userAuthFailure: true });
}

export async function fetchAdminWalletAccounts() {
  const response = await fetch("/api/admin/wallet/accounts", { headers: adminHeaders() });
  return readJson<WalletAccounts[]>(response, "后台钱包账户加载失败。");
}

export async function fetchAdminDepositAddresses() {
  const response = await fetch("/api/admin/wallet/deposit-addresses", { headers: adminHeaders() });
  return readJson<DepositAddress[]>(response, "后台充值地址加载失败。");
}

export async function fetchAdminOnchainDeposits() {
  const response = await fetch("/api/admin/wallet/deposits", { headers: adminHeaders() });
  return readJson<OnchainDeposit[]>(response, "后台链上充值记录加载失败。");
}

export async function fetchAdminWalletLedger() {
  const response = await fetch("/api/admin/wallet/ledger", { headers: adminHeaders() });
  return readJson<FundingLedgerEntry[]>(response, "后台资金流水加载失败。");
}

export async function fetchAdminWalletTransfers() {
  const response = await fetch("/api/admin/wallet/transfers", { headers: adminHeaders() });
  return readJson<AccountTransferRecord[]>(response, "后台转账记录加载失败。");
}

export async function fetchAdminWithdrawalRequests() {
  const response = await fetch("/api/admin/wallet/withdrawals", { headers: adminHeaders() });
  return readJson<WithdrawalRequest[]>(response, "后台提现申请加载失败。");
}

export async function depositFundingAccount(userId: string, amount: number, remark: string) {
  const response = await fetch("/api/admin/wallet/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ userId, amount, remark }),
  });
  return readJson<WalletAccounts>(response, "后台充值失败。");
}

export async function approveWithdrawalRequest(id: string, reviewNote: string, txHash = "") {
  const response = await fetch(`/api/admin/wallet/withdrawals/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ reviewNote, txHash }),
  });
  return readJson<WithdrawalRequest>(response, "提现审核通过失败。");
}

export async function rejectWithdrawalRequest(id: string, reviewNote: string) {
  const response = await fetch(`/api/admin/wallet/withdrawals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ reviewNote }),
  });
  return readJson<WithdrawalRequest>(response, "提现拒绝失败。");
}

export async function runAdminOnchainScan() {
  const response = await fetch("/api/admin/wallet/onchain/scan", {
    method: "POST",
    headers: adminHeaders(),
  });
  return readJson<{
    fromBlock?: number;
    toBlock?: number;
    scannedBlocks?: number;
    deposits?: number;
    saved?: number;
    credited?: number;
    status?: "ok" | "rate_limited";
    rateLimited?: boolean;
    message?: string;
  }>(response, "链上扫描触发失败。");
}

export async function confirmAdminWithdrawals() {
  const response = await fetch("/api/admin/wallet/withdrawals/confirm", {
    method: "POST",
    headers: adminHeaders(),
  });
  return readJson<WithdrawalRequest[]>(response, "提现确认触发失败。");
}
