import type { OrderRecord } from "../../../api/market";
import type {
  ExternalWalletBinding,
  FundingOrder,
  OnchainRecord,
  RecentFundingActivity,
  WalletAccountType,
} from "../../../api/walletApi";
import {
  accountSections,
  bscTestnetLabel,
  currentSimulationAccountKey,
  requiredConfirmations,
} from "../model/constants";
import type {
  AccountSection,
  OverviewFundingRow,
  QuickAction,
  TransferAccount,
} from "../model/types";

export function formatMoney(value: number | undefined | null, asset: string) {
  return `${formatNumber(value)} ${asset}`;
}

export function formatSignedMoney(value: number, asset: string) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${Math.abs(value).toFixed(2)} ${asset}`;
}

export function formatNumber(value: number | undefined | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

export function formatGroupedMoney(value: number | undefined | null, asset: string) {
  return `${formatGroupedNumber(value)} ${asset}`;
}

export function formatSignedGroupedMoney(value: number, asset: string) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${formatGroupedNumber(Math.abs(value))} ${asset}`;
}

export function formatGroupedNumber(value: number | undefined | null) {
  return typeof value === "number"
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "-";
}

export function getSignedToneClass(value: number) {
  if (value > 0) {
    return "text-emerald-400";
  }
  if (value < 0) {
    return "text-red-400";
  }
  return "text-muted";
}

export function getOverviewStatusClass(status: string) {
  if (status === "completed" || status === "confirmed") {
    return "is-success";
  }
  if (status === "failed") {
    return "is-danger";
  }
  if (status === "pending_review") {
    return "is-warning";
  }
  if (status === "broadcasting" || status === "broadcasted" || status === "detected" || status === "confirming" || status === "pending") {
    return "is-progress";
  }
  if (status === "rejected") {
    return "is-muted";
  }
  return "is-muted";
}

export function formatOverviewStatus(status: string) {
  const labels: Record<string, string> = {
    completed: "已完成",
    confirmed: "已完成",
    failed: "失败",
    pending_review: "待审核",
    broadcasting: "进行中",
    broadcasted: "进行中",
    detected: "进行中",
    confirming: "进行中",
    pending: "进行中",
    rejected: "已取消",
  };
  return labels[status] ?? status;
}

export function mapRecentFundingActivity(activity: RecentFundingActivity): OverviewFundingRow {
  return {
    id: activity.id,
    type: activity.title,
    amount: activity.amount,
    asset: activity.asset,
    time: activity.createdAt,
    status: activity.status,
  };
}

export function isTransferPairAllowed(from: TransferAccount, to: TransferAccount) {
  if (from === to) {
    return false;
  }
  if (from === "wallet" || to === "wallet") {
    return from === "wallet" && to === "funding";
  }
  return from === "funding" || to === "funding";
}

export function formatTimestamp(value?: number | null) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("zh-CN");
}

export function formatWalletAccountLabel(type: WalletAccountType) {
  const labels: Record<WalletAccountType, string> = {
    wallet: "钱包",
    funding: "资金账户",
    simulation: "模拟账户",
    realTrading: "交易账户",
    trading: "模拟账户(兼容)",
  };
  return labels[type];
}

export function formatFundingOrderType(type: FundingOrder["orderType"]) {
  const labels: Record<FundingOrder["orderType"], string> = {
    deposit: "充值",
    withdrawal: "提现",
    account_transfer: "划转",
    internal_transfer: "内部转账",
  };
  return labels[type];
}

export function formatFundingOrderDirection(order: FundingOrder) {
  if (order.fromAccountType && order.toAccountType) {
    return `${formatWalletAccountLabel(order.fromAccountType)} → ${formatWalletAccountLabel(order.toAccountType)}`;
  }
  if (order.direction === "in") {
    return `到达 ${formatWalletAccountLabel(order.accountType)}`;
  }
  if (order.direction === "out") {
    return `从 ${formatWalletAccountLabel(order.accountType)} 出账`;
  }
  return "-";
}

export function formatOnchainRecordType(type: OnchainRecord["type"]) {
  return type === "deposit" ? "充值" : "提现";
}

export function formatStatus(status: string) {
  const labels: Record<string, string> = {
    processing: "进行中",
    pending: "待处理",
    completed: "已完成",
    cancelled: "已取消",
    rejected: "已取消",
    reversed: "已取消",
    pending_review: "待处理",
    broadcasting: "进行中",
    broadcasted: "进行中",
    confirmed: "已完成",
    failed: "失败",
    detected: "进行中",
    confirming: "进行中",
    filled: "已完成",
    canceled: "已取消",
  };
  return labels[status] ?? status;
}

export function formatConfirmations(value: number) {
  return `${value} / ${requiredConfirmations}`;
}

export function formatNetwork(value?: string | null) {
  return value === "BSC_TESTNET" ? bscTestnetLabel : value ?? "-";
}

export function formatTradeSide(value: OrderRecord["side"]) {
  return value === "buy" ? "买入" : "卖出";
}

export function formatOrderStatus(value: OrderRecord["status"]) {
  return value === "filled" ? "已成交" : "已拒绝";
}

export function formatUserStatus(value?: string) {
  if (value === "active") {
    return "正常";
  }
  if (value === "disabled") {
    return "已禁用";
  }
  return "-";
}

export function readCurrentSimulationAccountId() {
  try {
    return window.localStorage.getItem(currentSimulationAccountKey) ?? "";
  } catch {
    return "";
  }
}

export function writeCurrentSimulationAccountId(accountId: string) {
  try {
    window.localStorage.setItem(currentSimulationAccountKey, accountId);
  } catch {
    // localStorage 不可用时仍允许通过 URL 参数进入交易页。
  }
}

export function formatExternalWalletBindStatus(value: ExternalWalletBinding["bindStatus"]) {
  if (value === "active") {
    return "已绑定";
  }
  return "待签名";
}

export function shortenHash(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export function shortenChainAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 6)}...${value.slice(-6)}`;
}

export function shortenWalletAddress(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function quickActionsForSection(section: AccountSection): Array<QuickAction | "trade"> {
  const actions: Record<AccountSection, Array<QuickAction | "trade">> = {
    overview: ["deposit", "withdraw", "transfer", "internal-transfer", "trade"],
    "wallet-overview": ["deposit", "withdraw", "transfer", "internal-transfer"],
    funding: [],
    trading: ["transfer"],
    simulation: [],
    ledger: [],
    "onchain-deposits": [],
    "trade-orders": [],
  };
  return actions[section];
}

export function readSectionFromUrl(): AccountSection {
  const section = new URLSearchParams(window.location.search).get("section");
  if (section === "withdrawals" || section === "deposits") {
    return "ledger";
  }
  return isAccountSection(section) ? section : "overview";
}

export function isAccountSection(value: string | null): value is AccountSection {
  return accountSections.includes(value as AccountSection);
}
