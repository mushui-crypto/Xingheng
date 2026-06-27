import type { TradingAccount } from "./market";
import { readStorage, storageKeys } from "../utils/storage";

export type WalletAsset = "USDT";
export type WalletAccountType = "funding" | "trading";

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

export type WalletAccounts = {
  funding: FundingAccount;
  trading: TradingAccount;
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
    | "adjustment";
  source: "admin_manual" | "withdrawal_request" | "internal_transfer" | "onchain_reserved";
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
  status: "pending" | "approved" | "rejected";
  network?: string | null;
  walletAddress?: string | null;
  txHash?: string | null;
  remark?: string | null;
  reviewNote?: string | null;
  createdAt: number;
  reviewedAt?: number | null;
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

async function readJson<T>(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? fallbackMessage);
  }
  return payload as T;
}

export async function fetchWalletAccounts() {
  const response = await fetch("/api/wallet/accounts", { headers: userHeaders() });
  return readJson<WalletAccounts>(response, "钱包账户加载失败。");
}

export async function fetchWalletLedger() {
  const response = await fetch("/api/wallet/ledger", { headers: userHeaders() });
  return readJson<FundingLedgerEntry[]>(response, "资金流水加载失败。");
}

export async function transferWalletBalance(
  from: WalletAccountType,
  to: WalletAccountType,
  amount: number,
  remark: string,
) {
  const response = await fetch("/api/wallet/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ from, to, amount, remark }),
  });
  return readJson<WalletAccounts>(response, "内部转账失败。");
}

export async function createWithdrawalRequest(amount: number, network: string, walletAddress: string, remark: string) {
  const response = await fetch("/api/wallet/withdrawals", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ amount, network, walletAddress, remark }),
  });
  return readJson<WithdrawalRequest>(response, "出金申请提交失败。");
}

export async function fetchWithdrawalRequests() {
  const response = await fetch("/api/wallet/withdrawals", { headers: userHeaders() });
  return readJson<WithdrawalRequest[]>(response, "出金申请加载失败。");
}

export async function fetchAdminWalletAccounts() {
  const response = await fetch("/api/admin/wallet/accounts", { headers: adminHeaders() });
  return readJson<WalletAccounts[]>(response, "后台钱包账户加载失败。");
}

export async function fetchAdminWalletLedger() {
  const response = await fetch("/api/admin/wallet/ledger", { headers: adminHeaders() });
  return readJson<FundingLedgerEntry[]>(response, "后台资金流水加载失败。");
}

export async function fetchAdminWithdrawalRequests() {
  const response = await fetch("/api/admin/wallet/withdrawals", { headers: adminHeaders() });
  return readJson<WithdrawalRequest[]>(response, "后台出金申请加载失败。");
}

export async function depositFundingAccount(userId: string, amount: number, remark: string) {
  const response = await fetch("/api/admin/wallet/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ userId, amount, remark }),
  });
  return readJson<WalletAccounts>(response, "后台入金失败。");
}

export async function approveWithdrawalRequest(id: string, reviewNote: string, txHash = "") {
  const response = await fetch(`/api/admin/wallet/withdrawals/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ reviewNote, txHash }),
  });
  return readJson<WithdrawalRequest>(response, "出金审核通过失败。");
}

export async function rejectWithdrawalRequest(id: string, reviewNote: string) {
  const response = await fetch(`/api/admin/wallet/withdrawals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ reviewNote }),
  });
  return readJson<WithdrawalRequest>(response, "出金拒绝失败。");
}
