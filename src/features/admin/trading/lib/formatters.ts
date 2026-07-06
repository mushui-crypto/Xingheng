import type { FundingLedgerEntry, OnchainDepositStatus, WithdrawalRequest } from "../../../../api/walletApi";

const bscTestnetLabel = "BNB Smart Chain Testnet";
const requiredConfirmations = 1;

export function formatLedgerType(type: FundingLedgerEntry["type"]) {
  const labels: Record<FundingLedgerEntry["type"], string> = {
    deposit: "充值",
    withdrawal_freeze: "提现冻结",
    withdrawal_approved: "提现通过",
    withdrawal_rejected: "提现拒绝",
    transfer_in: "转入",
    transfer_out: "转出",
    internal_transfer_in: "内部转入",
    internal_transfer_out: "内部转出",
    adjustment: "调整",
  };
  return labels[type];
}

export function formatStatus(status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] | OnchainDepositStatus) {
  const labels: Record<string, string> = {
    pending: "处理中",
    completed: "已完成",
    rejected: "已拒绝",
    pending_review: "待审核",
    broadcasting: "广播中",
    broadcasted: "已广播",
    confirmed: "已确认",
    failed: "失败",
    detected: "已检测",
    confirming: "确认中",
  };
  return labels[status] ?? status;
}

export function formatStatusHint(status: WithdrawalRequest["status"] | OnchainDepositStatus) {
  const hints: Record<string, string> = {
    pending_review: "等待人工审核",
    broadcasting: "准备提交链上",
    broadcasted: "已提交链上",
    confirmed: "链上已确认",
    failed: "失败后需排查",
    rejected: "已释放冻结",
    detected: "已扫到交易",
    confirming: "等待区块确认",
  };
  return hints[status] ?? "等待同步";
}

export function formatConfirmations(value: number) {
  return `${value} / ${requiredConfirmations}`;
}

export function formatNetwork(value?: string | null) {
  return value === "BSC_TESTNET" ? bscTestnetLabel : value ?? "-";
}

export function formatAssetAmount(value: number | undefined | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

export function shortenHash(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}
