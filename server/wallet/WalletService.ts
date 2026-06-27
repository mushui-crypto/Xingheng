import type { TradingService } from "../market/TradingService";
import type { TradingStore } from "../storage/TradingStore";
import type {
  FundingAccount,
  FundingLedgerEntry,
  FundingLedgerStatus,
  FundingLedgerType,
  WalletAccountType,
  WithdrawalRequest,
} from "../types";

const defaultUserId = "demo-user";
const asset = "USDT";

type TransferSide = WalletAccountType;

export class WalletService {
  constructor(
    private store: TradingStore,
    private trading: TradingService,
  ) {
    this.ensureFundingAccount(defaultUserId);
  }

  getAccounts(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    return {
      funding: this.ensureFundingAccount(normalizedUserId),
      trading: this.trading.getAccount(normalizedUserId),
    };
  }

  listAccounts() {
    const userIds = new Set<string>();
    for (const account of this.store.listFundingAccounts()) {
      userIds.add(account.userId);
    }
    for (const account of this.trading.listAccounts()) {
      userIds.add(account.userId);
    }
    userIds.add(defaultUserId);

    return [...userIds].sort().map((userId) => this.getAccounts(userId));
  }

  listLedger(userId?: string) {
    return this.store.listFundingLedger(userId ? normalizeUserId(userId) : undefined);
  }

  listWithdrawals(userId?: string) {
    return this.store.listWithdrawalRequests(userId ? normalizeUserId(userId) : undefined);
  }

  deposit(userId: string, amount: number, remark?: string) {
    assertPositiveAmount(amount);
    const normalizedUserId = normalizeUserId(userId);
    return this.store.transaction(() => {
      const before = this.ensureFundingAccount(normalizedUserId);
      const after = this.withAvailable({
        ...before,
        balance: roundMoney(before.balance + amount),
        updatedAt: Date.now(),
      });
      this.store.upsertFundingAccount(after);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: normalizedUserId,
          accountId: after.id,
          accountType: "funding",
          type: "deposit",
          source: "admin_manual",
          amount,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: "completed",
          remark,
        }),
      );
      return this.getAccounts(normalizedUserId);
    });
  }

  adjustFundingBalance(userId: string, type: "deposit" | "withdraw" | "reset", amount: number, remark?: string) {
    assertNonNegativeAmount(amount);
    if (type === "deposit") {
      return this.deposit(userId, amount, remark);
    }

    const normalizedUserId = normalizeUserId(userId);
    return this.store.transaction(() => {
      const before = this.ensureFundingAccount(normalizedUserId);
      const nextBalance = type === "reset" ? amount : roundMoney(before.balance - amount);
      if (nextBalance < before.frozen) {
        throw new Error("调整后余额不能小于冻结金额。");
      }

      const after = this.withAvailable({
        ...before,
        balance: roundMoney(nextBalance),
        updatedAt: Date.now(),
      });
      this.store.upsertFundingAccount(after);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: normalizedUserId,
          accountId: after.id,
          accountType: "funding",
          type: "adjustment",
          source: "admin_manual",
          amount,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: "completed",
          remark,
        }),
      );
      return this.getAccounts(normalizedUserId);
    });
  }

  transfer(userId: string, from: TransferSide, to: TransferSide, amount: number, remark?: string) {
    assertPositiveAmount(amount);
    if (from === to) {
      throw new Error("转出账户和转入账户不能相同。");
    }

    const normalizedUserId = normalizeUserId(userId);
    if (from === "funding" && to === "trading") {
      return this.transferFundingToTrading(normalizedUserId, amount, remark);
    }
    if (from === "trading" && to === "funding") {
      return this.transferTradingToFunding(normalizedUserId, amount, remark);
    }
    throw new Error("转账方向不正确。");
  }

  createWithdrawal(userId: string, input: { amount: number; network?: string; walletAddress?: string; remark?: string }) {
    assertPositiveAmount(input.amount);
    const normalizedUserId = normalizeUserId(userId);
    return this.store.transaction(() => {
      const before = this.ensureFundingAccount(normalizedUserId);
      if (before.available < input.amount) {
        throw new Error("资金账户可用余额不足。");
      }

      const now = Date.now();
      const request: WithdrawalRequest = {
        id: makeId("WDR"),
        userId: normalizedUserId,
        asset,
        amount: roundMoney(input.amount),
        status: "pending",
        network: normalizeOptional(input.network),
        walletAddress: normalizeOptional(input.walletAddress),
        txHash: null,
        remark: normalizeOptional(input.remark),
        reviewNote: null,
        createdAt: now,
        reviewedAt: null,
        updatedAt: now,
      };
      const after = this.withAvailable({
        ...before,
        frozen: roundMoney(before.frozen + input.amount),
        updatedAt: now,
      });
      this.store.upsertFundingAccount(after);
      this.store.saveWithdrawalRequest(request);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: normalizedUserId,
          accountId: after.id,
          accountType: "funding",
          type: "withdrawal_freeze",
          source: "withdrawal_request",
          amount: input.amount,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: "pending",
          relatedId: request.id,
          network: request.network,
          walletAddress: request.walletAddress,
          remark: request.remark,
        }),
      );
      return request;
    });
  }

  approveWithdrawal(id: string, reviewNote?: string, txHash?: string) {
    return this.reviewWithdrawal(id, "approved", reviewNote, txHash);
  }

  rejectWithdrawal(id: string, reviewNote?: string) {
    return this.reviewWithdrawal(id, "rejected", reviewNote);
  }

  private transferFundingToTrading(userId: string, amount: number, remark?: string) {
    return this.store.transaction(() => {
      const fundingBefore = this.ensureFundingAccount(userId);
      if (fundingBefore.available < amount) {
        throw new Error("资金账户可用余额不足。");
      }

      const fundingAfter = this.withAvailable({
        ...fundingBefore,
        balance: roundMoney(fundingBefore.balance - amount),
        updatedAt: Date.now(),
      });
      this.store.upsertFundingAccount(fundingAfter);
      const tradingMove = this.trading.creditBalance(userId, amount);

      const relatedId = makeId("TRF");
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "transfer_out",
          source: "internal_transfer",
          amount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: tradingMove.account.id,
          accountType: "trading",
          type: "transfer_in",
          source: "internal_transfer",
          amount,
          balanceBefore: tradingMove.balanceBefore,
          balanceAfter: tradingMove.balanceAfter,
          frozenBefore: 0,
          frozenAfter: 0,
          status: "completed",
          relatedId,
          remark,
        }),
      );

      return this.getAccounts(userId);
    });
  }

  private transferTradingToFunding(userId: string, amount: number, remark?: string) {
    return this.store.transaction(() => {
      const fundingBefore = this.ensureFundingAccount(userId);
      const tradingMove = this.trading.debitFreeMargin(userId, amount);
      const fundingAfter = this.withAvailable({
        ...fundingBefore,
        balance: roundMoney(fundingBefore.balance + amount),
        updatedAt: Date.now(),
      });
      this.store.upsertFundingAccount(fundingAfter);

      const relatedId = makeId("TRF");
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: tradingMove.account.id,
          accountType: "trading",
          type: "transfer_out",
          source: "internal_transfer",
          amount,
          balanceBefore: tradingMove.balanceBefore,
          balanceAfter: tradingMove.balanceAfter,
          frozenBefore: 0,
          frozenAfter: 0,
          status: "completed",
          relatedId,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "transfer_in",
          source: "internal_transfer",
          amount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId,
          remark,
        }),
      );

      return this.getAccounts(userId);
    });
  }

  private reviewWithdrawal(id: string, status: "approved" | "rejected", reviewNote?: string, txHash?: string) {
    return this.store.transaction(() => {
      const request = this.store.getWithdrawalRequest(id);
      if (!request) {
        throw new Error("出金申请不存在。");
      }
      if (request.status !== "pending") {
        throw new Error("只能审核 pending 状态的出金申请。");
      }

      const before = this.ensureFundingAccount(request.userId);
      if (before.frozen < request.amount) {
        throw new Error("资金账户冻结金额不足，无法审核。");
      }
      const now = Date.now();
      const after = this.withAvailable({
        ...before,
        balance: status === "approved" ? roundMoney(before.balance - request.amount) : before.balance,
        frozen: roundMoney(before.frozen - request.amount),
        updatedAt: now,
      });
      if (after.balance < 0 || after.frozen < 0) {
        throw new Error("资金账户余额异常，无法审核。");
      }

      const updated: WithdrawalRequest = {
        ...request,
        status,
        txHash: normalizeOptional(txHash) ?? request.txHash ?? null,
        reviewNote: normalizeOptional(reviewNote),
        reviewedAt: now,
        updatedAt: now,
      };
      this.store.upsertFundingAccount(after);
      this.store.saveWithdrawalRequest(updated);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: request.userId,
          accountId: after.id,
          accountType: "funding",
          type: status === "approved" ? "withdrawal_approved" : "withdrawal_rejected",
          source: "withdrawal_request",
          amount: request.amount,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: status === "approved" ? "completed" : "rejected",
          relatedId: request.id,
          network: request.network,
          walletAddress: request.walletAddress,
          txHash: updated.txHash,
          remark: updated.reviewNote,
        }),
      );
      return updated;
    });
  }

  private ensureFundingAccount(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const existing = this.store.getFundingAccount(normalizedUserId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const account = this.withAvailable({
      id: `FUND-${normalizedUserId}`,
      userId: normalizedUserId,
      asset,
      balance: 0,
      frozen: 0,
      available: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.store.upsertFundingAccount(account);
    return account;
  }

  private withAvailable(account: FundingAccount): FundingAccount {
    return {
      ...account,
      balance: roundMoney(account.balance),
      frozen: roundMoney(account.frozen),
      available: roundMoney(account.balance - account.frozen),
    };
  }

  private createLedger(input: {
    userId: string;
    accountId: string;
    accountType: WalletAccountType;
    type: FundingLedgerType;
    source: FundingLedgerEntry["source"];
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
  }): FundingLedgerEntry {
    const now = Date.now();
    return {
      id: makeId("LED"),
      userId: input.userId,
      accountId: input.accountId,
      accountType: input.accountType,
      type: input.type,
      source: input.source,
      asset,
      amount: roundMoney(input.amount),
      balanceBefore: roundMoney(input.balanceBefore),
      balanceAfter: roundMoney(input.balanceAfter),
      frozenBefore: roundMoney(input.frozenBefore),
      frozenAfter: roundMoney(input.frozenAfter),
      status: input.status,
      relatedId: input.relatedId ?? null,
      network: input.network ?? null,
      walletAddress: input.walletAddress ?? null,
      txHash: input.txHash ?? null,
      remark: input.remark ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function normalizeUserId(userId: string) {
  return userId?.trim() || defaultUserId;
}

function normalizeOptional(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function assertPositiveAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("金额必须大于 0。");
  }
}

function assertNonNegativeAmount(amount: number) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("金额不能小于 0。");
  }
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
