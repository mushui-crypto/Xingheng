import { getAddress } from "ethers";
import { depositNetwork } from "./walletConstants";
import type {
  AccountTransferRecord,
  ExternalWalletProvider,
  FundingLedgerEntry,
  FundingLedgerStatus,
  FundingOrder,
  FundingOrderDisplayStatus,
  RecentFundingActivity,
  WalletAccountType,
  WalletNetwork,
  WithdrawalRequest,
} from "../types";
import type { FundingOrderFilter, NormalizedTransferSide } from "./walletConstants";

export function normalizeUserId(userId: string) {
  return userId?.trim() || "demo-user";
}

export function getLedgerDirection(entry: FundingLedgerEntry): RecentFundingActivity["direction"] {
  if (entry.type === "deposit" || entry.type === "transfer_in" || entry.type === "internal_transfer_in") {
    return "in";
  }
  if (
    entry.type === "transfer_out" ||
    entry.type === "internal_transfer_out" ||
    entry.type === "withdrawal_freeze" ||
    entry.type === "withdrawal_approved"
  ) {
    return "out";
  }
  return "neutral";
}

export function normalizeFundingOrderFilter(value: string | undefined): FundingOrderFilter {
  if (
    value === "deposit" ||
    value === "withdrawal" ||
    value === "transfer" ||
    value === "account_transfer" ||
    value === "internal_transfer"
  ) {
    return value;
  }
  return "all";
}

export function matchesFundingOrderFilter(order: FundingOrder, filter: FundingOrderFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "transfer") {
    return order.orderType === "account_transfer" || order.orderType === "internal_transfer";
  }
  return order.orderType === filter;
}

export function getLedgerDisplayStatus(status: FundingLedgerStatus): FundingOrderDisplayStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "rejected") {
    return "cancelled";
  }
  return "pending";
}

export function getWithdrawalDisplayStatus(status: WithdrawalRequest["status"]): FundingOrderDisplayStatus {
  if (status === "confirmed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "rejected") {
    return "cancelled";
  }
  if (status === "broadcasting" || status === "broadcasted") {
    return "processing";
  }
  return "pending";
}

export function getTransferDisplayStatus(status: AccountTransferRecord["status"]): FundingOrderDisplayStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "reversed") {
    return "cancelled";
  }
  return "failed";
}

export function getTransferFundingDirection(transfer: AccountTransferRecord, userId: string): FundingOrder["direction"] {
  if (transfer.transferType === "internal_transfer") {
    if (transfer.toUserId === userId) {
      return "in";
    }
    if (transfer.fromUserId === userId) {
      return "out";
    }
    return "neutral";
  }
  if (transfer.toAccountType === "funding") {
    return "in";
  }
  if (transfer.fromAccountType === "funding") {
    return "out";
  }
  return "neutral";
}

export function pickPrimaryFundingLedger(entries: FundingLedgerEntry[] | undefined) {
  if (!entries || entries.length === 0) {
    return null;
  }
  return [...entries].sort((a, b) => {
    const fundingDeltaA = Math.abs(a.balanceAfter - a.balanceBefore) + Math.abs(a.frozenAfter - a.frozenBefore);
    const fundingDeltaB = Math.abs(b.balanceAfter - b.balanceBefore) + Math.abs(b.frozenAfter - b.frozenBefore);
    return fundingDeltaB - fundingDeltaA || b.updatedAt - a.updatedAt;
  })[0];
}

export function normalizePageSize(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

export function resolvePageSize(limit: number | undefined, pageSize: number | undefined) {
  return typeof pageSize === "number" && Number.isFinite(pageSize) ? pageSize : limit;
}

export function normalizePage(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.trunc(value));
}

export function normalizeOptional(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export function normalizeRequiredValue(value: string, name: string) {
  if (!value) {
    throw new Error(`缺少环境变量 ${name}。`);
  }
  return value;
}

export function normalizeRequiredInput(value: unknown, fieldName: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`缺少参数 ${fieldName}。`);
  }
  return normalized;
}

export function normalizeSimulationAccountName(value: unknown, fallback?: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  const name = normalized || fallback;
  if (!name) {
    throw new Error("模拟账户名称不能为空。");
  }
  if (name.length > 30) {
    throw new Error("模拟账户名称不能超过 30 个字符。");
  }
  return name;
}

export function normalizeWalletAddress(value: unknown) {
  const raw = normalizeRequiredInput(value, "walletAddress");
  try {
    return getAddress(raw);
  } catch {
    throw new Error("钱包地址格式不正确。");
  }
}

export function normalizeExternalWalletNetwork(value: unknown): WalletNetwork {
  const normalized = typeof value === "string" && value.trim() ? value.trim().toUpperCase() : depositNetwork;
  if (normalized !== depositNetwork) {
    throw new Error("当前仅支持 BSC_TESTNET 网络。");
  }
  return depositNetwork;
}

export function normalizeExternalWalletProvider(value: unknown): ExternalWalletProvider {
  const normalized = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "metamask";
  if (normalized !== "metamask") {
    throw new Error("当前仅支持 MetaMask 第三方钱包。");
  }
  return "metamask";
}

export function buildExternalWalletChallengeMessage(input: {
  userId: string;
  walletAddress: string;
  network: WalletNetwork;
  provider: ExternalWalletProvider;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}) {
  return [
    "Stella X 第三方钱包绑定验证",
    "",
    "请确认你正在把该第三方钱包绑定到 Stella X 账户。",
    "星衡不会获取你的私钥，也不会代你发起链上转账。",
    "",
    `User ID: ${input.userId}`,
    `Wallet Address: ${input.walletAddress}`,
    `Network: ${input.network}`,
    `Provider: ${input.provider}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date(input.issuedAt).toISOString()}`,
    `Expires At: ${new Date(input.expiresAt).toISOString()}`,
  ].join("\n");
}

export function normalizeAccountType(value: WalletAccountType): NormalizedTransferSide {
  if (value === "wallet") {
    return "wallet";
  }
  if (value === "trading" || value === "simulation") {
    return "simulation";
  }
  if (value === "funding" || value === "realTrading") {
    return value;
  }
  throw new Error("账户类型不正确。");
}

export function assertPositiveAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("金额必须大于 0。");
  }
}

export function assertNonNegativeAmount(amount: number) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("金额不能小于 0。");
  }
}

export function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

export function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
