import { asset, depositNetwork } from "./walletConstants";
import { roundMoney } from "./walletUtils";
import type { FundingLedgerEntry, OnchainDeposit, WithdrawalRequest } from "../types";

export function createDemoDeposit(input: {
  id: string;
  userId: string;
  toAddress: string;
  tokenAddress: string;
  amount: string;
  amountDecimal: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  confirmations: number;
  status: OnchainDeposit["status"];
  creditedLedgerId?: string | null;
  failedReason?: string | null;
  createdAt: number;
  confirmedAt?: number | null;
}): OnchainDeposit {
  return {
    id: input.id,
    userId: input.userId,
    asset,
    network: depositNetwork,
    chainId: Number(process.env.BSC_TESTNET_CHAIN_ID ?? 97),
    tokenAddress: input.tokenAddress,
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: input.toAddress,
    amount: input.amount,
    amountDecimal: roundMoney(input.amountDecimal),
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    blockHash: `0x${input.blockNumber.toString(16).padStart(64, "0")}`,
    confirmations: input.confirmations,
    status: input.status,
    creditedLedgerId: input.creditedLedgerId ?? null,
    failedReason: input.failedReason ?? null,
    detectedAt: input.createdAt,
    confirmedAt: input.confirmedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.confirmedAt ?? input.createdAt,
  };
}

export function createDemoWithdrawal(input: {
  id: string;
  userId: string;
  amount: number;
  status: WithdrawalRequest["status"];
  walletAddress: string;
  tokenAddress: string;
  broadcastTxHash?: string | null;
  failedReason?: string | null;
  confirmations?: number | null;
  createdAt: number;
  reviewedAt?: number | null;
  broadcastedAt?: number | null;
  confirmedAt?: number | null;
  failedAt?: number | null;
  remark?: string | null;
}): WithdrawalRequest {
  return {
    id: input.id,
    userId: input.userId,
    asset,
    amount: roundMoney(input.amount),
    status: input.status,
    network: depositNetwork,
    walletAddress: input.walletAddress,
    txHash: input.broadcastTxHash ?? null,
    onchainStatus: input.status,
    chainId: Number(process.env.BSC_TESTNET_CHAIN_ID ?? 97),
    tokenAddress: input.tokenAddress,
    fromAddress: "0x5555555555555555555555555555555555555555",
    toAddress: input.walletAddress,
    broadcastTxHash: input.broadcastTxHash ?? null,
    broadcastedAt: input.broadcastedAt ?? null,
    confirmedAt: input.confirmedAt ?? null,
    failedAt: input.failedAt ?? null,
    failedReason: input.failedReason ?? null,
    confirmations: input.confirmations ?? 0,
    broadcastAttemptCount: input.broadcastTxHash ? 1 : 0,
    lastBroadcastAttemptAt: input.broadcastedAt ?? null,
    remark: input.remark ?? null,
    reviewNote: input.reviewedAt ? "演示数据：后台审核通过" : null,
    createdAt: input.createdAt,
    reviewedAt: input.reviewedAt ?? null,
    updatedAt: input.failedAt ?? input.confirmedAt ?? input.broadcastedAt ?? input.reviewedAt ?? input.createdAt,
  };
}

export function createDemoLedgerEntries(input: { userId: string; accountId: string; depositAddress: string }): FundingLedgerEntry[] {
  const createdAt = Date.parse("2026-07-03T09:30:00+08:00");
  const userId = input.userId;
  const accountId = input.accountId;
  const makeEntry = (
    entry: Omit<FundingLedgerEntry, "userId" | "accountId" | "accountType" | "asset" | "network" | "createdAt" | "updatedAt"> & {
      createdAt: number;
      network?: string | null;
    },
  ): FundingLedgerEntry => ({
    userId,
    accountId,
    accountType: "funding",
    asset,
    network: entry.network ?? null,
    ...entry,
    amount: roundMoney(entry.amount),
    balanceBefore: roundMoney(entry.balanceBefore),
    balanceAfter: roundMoney(entry.balanceAfter),
    frozenBefore: roundMoney(entry.frozenBefore),
    frozenAfter: roundMoney(entry.frozenAfter),
    updatedAt: entry.createdAt,
  });

  return [
    makeEntry({
      id: "LED-DEMO-ONCHAIN-001",
      type: "deposit",
      source: "onchain_deposit",
      amount: 2500,
      balanceBefore: 0,
      balanceAfter: 2500,
      frozenBefore: 0,
      frozenAfter: 0,
      status: "completed",
      relatedId: "DEP-DEMO-CONFIRMED-001",
      network: depositNetwork,
      walletAddress: input.depositAddress,
      txHash: "0x1000000000000000000000000000000000000000000000000000000000000001",
      remark: "演示数据：钱包划转入资金账户",
      createdAt: createdAt + 180_000,
    }),
    makeEntry({
      id: "LED-DEMO-TRANSFER-IN-001",
      type: "transfer_in",
      source: "account_transfer",
      amount: 1500,
      balanceBefore: 2500,
      balanceAfter: 4000,
      frozenBefore: 0,
      frozenAfter: 0,
      status: "completed",
      relatedId: "TRF-DEMO-SIM-FUND-001",
      walletAddress: null,
      txHash: null,
      remark: "演示数据：模拟账户转入资金账户",
      createdAt: createdAt + 240_000,
    }),
    makeEntry({
      id: "LED-DEMO-WITHDRAW-PENDING-001",
      type: "withdrawal_freeze",
      source: "withdrawal_request",
      amount: 250,
      balanceBefore: 4000,
      balanceAfter: 4000,
      frozenBefore: 0,
      frozenAfter: 250,
      status: "pending",
      relatedId: "WDR-DEMO-PENDING-001",
      network: depositNetwork,
      walletAddress: "0x2222222222222222222222222222222222222222",
      txHash: null,
      remark: "演示数据：出金待审核，资金已冻结",
      createdAt: createdAt + 480_000,
    }),
    makeEntry({
      id: "LED-DEMO-WITHDRAW-FREEZE-001",
      type: "withdrawal_freeze",
      source: "withdrawal_request",
      amount: 600,
      balanceBefore: 4000,
      balanceAfter: 4000,
      frozenBefore: 250,
      frozenAfter: 850,
      status: "pending",
      relatedId: "WDR-DEMO-CONFIRMED-001",
      network: depositNetwork,
      walletAddress: "0x3333333333333333333333333333333333333333",
      txHash: null,
      remark: "演示数据：已审核出金的冻结记录",
      createdAt: createdAt + 540_000,
    }),
    makeEntry({
      id: "LED-DEMO-WITHDRAW-CONFIRMED-001",
      type: "withdrawal_approved",
      source: "withdrawal_request",
      amount: 600,
      balanceBefore: 4000,
      balanceAfter: 3400,
      frozenBefore: 850,
      frozenAfter: 250,
      status: "completed",
      relatedId: "WDR-DEMO-CONFIRMED-001",
      network: depositNetwork,
      walletAddress: "0x3333333333333333333333333333333333333333",
      txHash: "0x2000000000000000000000000000000000000000000000000000000000000001",
      remark: "演示数据：出金链上确认后正式扣减",
      createdAt: createdAt + 780_000,
    }),
    makeEntry({
      id: "LED-DEMO-TRANSFER-OUT-001",
      type: "transfer_out",
      source: "account_transfer",
      amount: 200,
      balanceBefore: 3400,
      balanceAfter: 3200,
      frozenBefore: 250,
      frozenAfter: 250,
      status: "completed",
      relatedId: "TRF-DEMO-FUND-REAL-001",
      walletAddress: null,
      txHash: null,
      remark: "演示数据：资金账户转入真实交易账户",
      createdAt: createdAt + 900_000,
    }),
    makeEntry({
      id: "LED-DEMO-WITHDRAW-FAILED-FREEZE-001",
      type: "withdrawal_freeze",
      source: "withdrawal_request",
      amount: 120,
      balanceBefore: 3200,
      balanceAfter: 3200,
      frozenBefore: 250,
      frozenAfter: 370,
      status: "pending",
      relatedId: "WDR-DEMO-FAILED-001",
      network: depositNetwork,
      walletAddress: "0x4444444444444444444444444444444444444444",
      txHash: null,
      remark: "演示数据：失败出金的冻结记录",
      createdAt: createdAt + 1_080_000,
    }),
    makeEntry({
      id: "LED-DEMO-WITHDRAW-FAILED-RELEASE-001",
      type: "withdrawal_rejected",
      source: "withdrawal_request",
      amount: 120,
      balanceBefore: 3200,
      balanceAfter: 3200,
      frozenBefore: 370,
      frozenAfter: 250,
      status: "rejected",
      relatedId: "WDR-DEMO-FAILED-001",
      network: depositNetwork,
      walletAddress: "0x4444444444444444444444444444444444444444",
      txHash: "0x2000000000000000000000000000000000000000000000000000000000000002",
      remark: "演示数据：RPC 广播超时，冻结资金已释放",
      createdAt: createdAt + 1_260_000,
    }),
  ];
}
