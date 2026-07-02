import { HDNodeWallet } from "ethers";
import type { TradingService } from "../market/TradingService";
import type { TradingStore } from "../storage/TradingStore";
import { OnchainWalletService } from "./OnchainWalletService";
import type {
  AccountTransferRecord,
  DepositAddress,
  FundingAccount,
  FundingLedgerEntry,
  FundingLedgerStatus,
  FundingLedgerType,
  WalletAccountType,
  WalletNetwork,
  WithdrawalRequest,
} from "../types";

const defaultUserId = "demo-user";
const asset = "USDT";
const depositNetwork: WalletNetwork = "BSC_TESTNET";

type TransferSide = WalletAccountType;
type NormalizedTransferSide = "funding" | "simulation" | "realTrading";

export class WalletService {
  private depositMnemonic: string;
  private depositDerivationPath: string;

  constructor(
    private store: TradingStore,
    private trading: TradingService,
    private onchain: OnchainWalletService,
  ) {
    this.depositMnemonic = process.env.BSC_TESTNET_DEPOSIT_MNEMONIC?.trim() ?? "";
    this.depositDerivationPath = process.env.BSC_TESTNET_DERIVATION_PATH?.trim() || "m/44'/60'/0'/0";
    this.ensureFundingAccount(defaultUserId);
    this.ensureRealTradingAccount(defaultUserId);
  }

  getAccounts(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const simulation = this.trading.getAccount(normalizedUserId);
    return {
      funding: this.ensureFundingAccount(normalizedUserId),
      realTrading: this.ensureRealTradingAccount(normalizedUserId),
      simulation,
      trading: simulation,
    };
  }

  listAccounts() {
    const userIds = new Set<string>();
    for (const account of this.store.listFundingAccounts()) {
      userIds.add(account.userId);
    }
    for (const account of this.store.listRealTradingAccounts()) {
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

  listTransfers(userId?: string) {
    return this.store.listAccountTransfers(userId ? normalizeUserId(userId) : undefined);
  }

  listWithdrawals(userId?: string) {
    return this.store.listWithdrawalRequests(userId ? normalizeUserId(userId) : undefined);
  }

  getDepositAddress(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const address = this.store.transaction(() => this.getOrCreateDepositAddress(normalizedUserId));
    return {
      ...this.onchain.getPublicConfig(),
      ...address,
    };
  }

  listDepositAddresses() {
    return this.store.listDepositAddresses();
  }

  listOnchainDeposits(userId?: string) {
    return this.store.listOnchainDeposits(userId ? normalizeUserId(userId) : undefined);
  }

  async scanDeposits() {
    const result = await this.onchain.scanDeposits();
    const credited = this.creditConfirmedDeposits();
    return { ...result, credited };
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
    return this.accountTransfer(userId, from, to, amount, remark).accounts;
  }

  accountTransfer(userId: string, from: TransferSide, to: TransferSide, amount: number, remark?: string) {
    assertPositiveAmount(amount);
    const normalizedFrom = normalizeAccountType(from);
    const normalizedTo = normalizeAccountType(to);
    if (normalizedFrom === normalizedTo) {
      throw new Error("转出账户和转入账户不能相同。");
    }
    return this.transferAccountBalance(normalizeUserId(userId), normalizedFrom, normalizedTo, amount, normalizeOptional(remark));
  }

  internalTransfer(
    userId: string,
    input: { recipient?: string; amount: number; remark?: string; clientRequestId?: string | null },
  ) {
    assertPositiveAmount(input.amount);
    const fromUserId = normalizeUserId(userId);
    const recipient = String(input.recipient ?? "").trim();
    if (!recipient) {
      throw new Error("收款用户不能为空。");
    }

    const clientRequestId = normalizeOptional(input.clientRequestId);
    const remark = normalizeOptional(input.remark);
    if (clientRequestId) {
      const existing = this.store.getAccountTransferByClientRequestId(fromUserId, clientRequestId);
      if (existing) {
        return { transfer: existing, accounts: this.getAccounts(fromUserId) };
      }
    }

    const fromUser = this.store.findUserById(fromUserId);
    if (!fromUser || fromUser.status !== "active") {
      throw new Error("当前用户状态不可转账。");
    }

    const toUser = this.findTransferRecipient(recipient);
    if (!toUser) {
      throw new Error("收款用户不存在。");
    }
    if (toUser.status !== "active") {
      throw new Error("收款用户已禁用，不能收款。");
    }
    if (toUser.id === fromUserId) {
      throw new Error("不能向自己发起内部转账。");
    }

    return this.store.transaction(() => {
      const existing = clientRequestId ? this.store.getAccountTransferByClientRequestId(fromUserId, clientRequestId) : undefined;
      if (existing) {
        return { transfer: existing, accounts: this.getAccounts(fromUserId) };
      }

      const fromBefore = this.ensureFundingAccount(fromUserId);
      if (fromBefore.available < input.amount) {
        throw new Error("资金账户可用余额不足。");
      }
      const toBefore = this.ensureFundingAccount(toUser.id);
      const amount = roundMoney(input.amount);
      const now = Date.now();
      const fromAfter = this.withAvailable({
        ...fromBefore,
        balance: roundMoney(fromBefore.balance - amount),
        updatedAt: now,
      });
      const toAfter = this.withAvailable({
        ...toBefore,
        balance: roundMoney(toBefore.balance + amount),
        updatedAt: now,
      });
      const transfer = this.createTransferRecord({
        transferType: "internal_transfer",
        amount,
        fromUserId,
        toUserId: toUser.id,
        fromAccountType: "funding",
        toAccountType: "funding",
        clientRequestId,
        remark,
      });

      this.store.upsertFundingAccount(fromAfter);
      this.store.upsertFundingAccount(toAfter);
      this.store.saveAccountTransfer(transfer);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: fromUserId,
          accountId: fromAfter.id,
          accountType: "funding",
          type: "internal_transfer_out",
          source: "user_internal_transfer",
          amount,
          balanceBefore: fromBefore.balance,
          balanceAfter: fromAfter.balance,
          frozenBefore: fromBefore.frozen,
          frozenAfter: fromAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId: toUser.id,
          accountId: toAfter.id,
          accountType: "funding",
          type: "internal_transfer_in",
          source: "user_internal_transfer",
          amount,
          balanceBefore: toBefore.balance,
          balanceAfter: toAfter.balance,
          frozenBefore: toBefore.frozen,
          frozenAfter: toAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );

      return { transfer, accounts: this.getAccounts(fromUserId) };
    });
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
        status: "pending_review",
        network: depositNetwork,
        walletAddress: normalizeOptional(input.walletAddress),
        txHash: null,
        onchainStatus: "pending_review",
        chainId: this.onchain.config.chainId,
        tokenAddress: this.onchain.config.tokenAddress,
        fromAddress: null,
        toAddress: normalizeOptional(input.walletAddress),
        broadcastTxHash: null,
        broadcastedAt: null,
        confirmedAt: null,
        failedAt: null,
        failedReason: null,
        confirmations: 0,
        broadcastAttemptCount: 0,
        lastBroadcastAttemptAt: null,
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

  async approveWithdrawal(id: string, reviewNote?: string) {
    const broadcasting = this.markWithdrawalBroadcasting(id, reviewNote);
    try {
      const broadcast = await this.onchain.broadcastWithdrawal(broadcasting);
      return this.markWithdrawalBroadcasted(id, broadcast);
    } catch (error) {
      return this.failWithdrawal(id, error instanceof Error ? error.message : "出金广播失败。");
    }
  }

  rejectWithdrawal(id: string, reviewNote?: string) {
    return this.rejectPendingWithdrawal(id, reviewNote);
  }

  async confirmWithdrawals() {
    const results: WithdrawalRequest[] = [];
    for (const request of this.store.listWithdrawalsByStatuses(["broadcasted"])) {
      const txHash = request.broadcastTxHash ?? request.txHash;
      if (!txHash) {
        results.push(this.failWithdrawal(request.id, "缺少 txHash，无法确认链上出金。"));
        continue;
      }
      const status = await this.onchain.getTransactionStatus(txHash);
      if (!status.found) {
        continue;
      }
      if (status.failed) {
        results.push(this.failWithdrawal(request.id, "链上交易执行失败。", status.confirmations));
        continue;
      }
      if (status.confirmed) {
        results.push(this.confirmWithdrawal(request.id, status.confirmations));
      } else {
        this.store.saveWithdrawalRequest({ ...request, confirmations: status.confirmations, updatedAt: Date.now() });
      }
    }
    return results;
  }

  private transferAccountBalance(
    userId: string,
    from: NormalizedTransferSide,
    to: NormalizedTransferSide,
    amount: number,
    remark?: string | null,
  ) {
    if (from === "funding" && to === "simulation") {
      return this.transferFundingToSimulation(userId, amount, remark);
    }
    if (from === "simulation" && to === "funding") {
      return this.transferSimulationToFunding(userId, amount, remark);
    }
    if (from === "funding" && to === "realTrading") {
      return this.transferFundingToRealTrading(userId, amount, remark);
    }
    if (from === "realTrading" && to === "funding") {
      return this.transferRealTradingToFunding(userId, amount, remark);
    }
    throw new Error("转账方向不正确。");
  }

  private transferFundingToSimulation(userId: string, amount: number, remark?: string | null) {
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

      const transfer = this.createTransferRecord({
        transferType: "account_transfer",
        amount,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "funding",
        toAccountType: "simulation",
        remark,
      });
      this.store.saveAccountTransfer(transfer);
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "transfer_out",
          source: "account_transfer",
          amount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: tradingMove.account.id,
          accountType: "simulation",
          type: "transfer_in",
          source: "account_transfer",
          amount,
          balanceBefore: tradingMove.balanceBefore,
          balanceAfter: tradingMove.balanceAfter,
          frozenBefore: 0,
          frozenAfter: 0,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );

      return { transfer, accounts: this.getAccounts(userId) };
    });
  }

  private transferSimulationToFunding(userId: string, amount: number, remark?: string | null) {
    return this.store.transaction(() => {
      const fundingBefore = this.ensureFundingAccount(userId);
      const tradingMove = this.trading.debitFreeMargin(userId, amount);
      const fundingAfter = this.withAvailable({
        ...fundingBefore,
        balance: roundMoney(fundingBefore.balance + amount),
        updatedAt: Date.now(),
      });
      this.store.upsertFundingAccount(fundingAfter);

      const transfer = this.createTransferRecord({
        transferType: "account_transfer",
        amount,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "simulation",
        toAccountType: "funding",
        remark,
      });
      this.store.saveAccountTransfer(transfer);
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: tradingMove.account.id,
          accountType: "simulation",
          type: "transfer_out",
          source: "account_transfer",
          amount,
          balanceBefore: tradingMove.balanceBefore,
          balanceAfter: tradingMove.balanceAfter,
          frozenBefore: 0,
          frozenAfter: 0,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "transfer_in",
          source: "account_transfer",
          amount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );

      return { transfer, accounts: this.getAccounts(userId) };
    });
  }

  private transferFundingToRealTrading(userId: string, amount: number, remark?: string | null) {
    return this.store.transaction(() => {
      const fundingBefore = this.ensureFundingAccount(userId);
      if (fundingBefore.available < amount) {
        throw new Error("资金账户可用余额不足。");
      }

      const realBefore = this.ensureRealTradingAccount(userId);
      const now = Date.now();
      const fundingAfter = this.withAvailable({
        ...fundingBefore,
        balance: roundMoney(fundingBefore.balance - amount),
        updatedAt: now,
      });
      const realAfter = this.withAvailable({
        ...realBefore,
        balance: roundMoney(realBefore.balance + amount),
        updatedAt: now,
      });
      const transfer = this.createTransferRecord({
        transferType: "account_transfer",
        amount,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "funding",
        toAccountType: "realTrading",
        remark,
      });

      this.store.upsertFundingAccount(fundingAfter);
      this.store.upsertRealTradingAccount(realAfter);
      this.store.saveAccountTransfer(transfer);
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "transfer_out",
          source: "account_transfer",
          amount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: realAfter.id,
          accountType: "realTrading",
          type: "transfer_in",
          source: "account_transfer",
          amount,
          balanceBefore: realBefore.balance,
          balanceAfter: realAfter.balance,
          frozenBefore: realBefore.frozen,
          frozenAfter: realAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );

      return { transfer, accounts: this.getAccounts(userId) };
    });
  }

  private transferRealTradingToFunding(userId: string, amount: number, remark?: string | null) {
    return this.store.transaction(() => {
      const realBefore = this.ensureRealTradingAccount(userId);
      if (realBefore.available < amount) {
        throw new Error("交易账户可用余额不足。");
      }

      const fundingBefore = this.ensureFundingAccount(userId);
      const now = Date.now();
      const realAfter = this.withAvailable({
        ...realBefore,
        balance: roundMoney(realBefore.balance - amount),
        updatedAt: now,
      });
      const fundingAfter = this.withAvailable({
        ...fundingBefore,
        balance: roundMoney(fundingBefore.balance + amount),
        updatedAt: now,
      });
      const transfer = this.createTransferRecord({
        transferType: "account_transfer",
        amount,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "realTrading",
        toAccountType: "funding",
        remark,
      });

      this.store.upsertRealTradingAccount(realAfter);
      this.store.upsertFundingAccount(fundingAfter);
      this.store.saveAccountTransfer(transfer);
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: realAfter.id,
          accountType: "realTrading",
          type: "transfer_out",
          source: "account_transfer",
          amount,
          balanceBefore: realBefore.balance,
          balanceAfter: realAfter.balance,
          frozenBefore: realBefore.frozen,
          frozenAfter: realAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "transfer_in",
          source: "account_transfer",
          amount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          remark,
        }),
      );

      return { transfer, accounts: this.getAccounts(userId) };
    });
  }

  private markWithdrawalBroadcasting(id: string, reviewNote?: string) {
    return this.store.transaction(() => {
      const request = this.store.getWithdrawalRequest(id);
      if (!request) {
        throw new Error("出金申请不存在。");
      }
      if (request.status !== "pending_review") {
        throw new Error("只能审核 pending_review 状态的出金申请。");
      }

      const before = this.ensureFundingAccount(request.userId);
      if (before.frozen < request.amount) {
        throw new Error("资金账户冻结金额不足，无法审核。");
      }
      const now = Date.now();
      const updated: WithdrawalRequest = {
        ...request,
        status: "broadcasting",
        onchainStatus: "broadcasting",
        reviewNote: normalizeOptional(reviewNote),
        reviewedAt: now,
        broadcastAttemptCount: (request.broadcastAttemptCount ?? 0) + 1,
        lastBroadcastAttemptAt: now,
        updatedAt: now,
      };
      this.store.saveWithdrawalRequest(updated);
      return updated;
    });
  }

  private markWithdrawalBroadcasted(id: string, broadcast: { txHash: string; fromAddress: string; toAddress: string }) {
    return this.store.transaction(() => {
      const request = this.store.getWithdrawalRequest(id);
      if (!request || request.status !== "broadcasting") {
        throw new Error("出金申请状态不是 broadcasting。");
      }
      const now = Date.now();
      const updated: WithdrawalRequest = {
        ...request,
        status: "broadcasted",
        onchainStatus: "broadcasted",
        txHash: broadcast.txHash,
        broadcastTxHash: broadcast.txHash,
        fromAddress: broadcast.fromAddress,
        toAddress: broadcast.toAddress,
        broadcastedAt: now,
        updatedAt: now,
      };
      this.store.saveWithdrawalRequest(updated);
      return updated;
    });
  }

  private confirmWithdrawal(id: string, confirmations: number) {
    return this.store.transaction(() => {
      const request = this.store.getWithdrawalRequest(id);
      if (!request || request.status !== "broadcasted") {
        throw new Error("出金申请状态不是 broadcasted。");
      }
      const before = this.ensureFundingAccount(request.userId);
      if (before.frozen < request.amount) {
        throw new Error("资金账户冻结金额不足，无法确认出金。");
      }
      const now = Date.now();
      const after = this.withAvailable({
        ...before,
        balance: roundMoney(before.balance - request.amount),
        frozen: roundMoney(before.frozen - request.amount),
        updatedAt: now,
      });
      if (after.balance < 0 || after.frozen < 0) {
        throw new Error("资金账户余额异常，无法确认出金。");
      }
      const updated: WithdrawalRequest = {
        ...request,
        status: "confirmed",
        onchainStatus: "confirmed",
        confirmations,
        confirmedAt: now,
        updatedAt: now,
      };
      this.store.upsertFundingAccount(after);
      this.store.saveWithdrawalRequest(updated);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: request.userId,
          accountId: after.id,
          accountType: "funding",
          type: "withdrawal_approved",
          source: "withdrawal_request",
          amount: request.amount,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: "completed",
          relatedId: request.id,
          network: request.network,
          walletAddress: request.walletAddress,
          txHash: updated.broadcastTxHash ?? updated.txHash,
          remark: updated.reviewNote,
        }),
      );
      return updated;
    });
  }

  private rejectPendingWithdrawal(id: string, reviewNote?: string) {
    return this.releaseWithdrawal(id, "rejected", normalizeOptional(reviewNote) ?? "后台拒绝出金。");
  }

  private failWithdrawal(id: string, failedReason: string, confirmations?: number) {
    return this.releaseWithdrawal(id, "failed", failedReason, confirmations);
  }

  private releaseWithdrawal(id: string, status: "failed" | "rejected", reason: string, confirmations?: number) {
    return this.store.transaction(() => {
      const request = this.store.getWithdrawalRequest(id);
      if (!request) {
        throw new Error("出金申请不存在。");
      }
      if (!["pending_review", "broadcasting", "broadcasted"].includes(request.status)) {
        throw new Error("当前出金状态不能释放冻结。");
      }
      const before = this.ensureFundingAccount(request.userId);
      if (before.frozen < request.amount) {
        throw new Error("资金账户冻结金额不足，无法释放。");
      }
      const now = Date.now();
      const after = this.withAvailable({
        ...before,
        frozen: roundMoney(before.frozen - request.amount),
        updatedAt: now,
      });
      this.store.upsertFundingAccount(after);
      const updated: WithdrawalRequest = {
        ...request,
        status,
        onchainStatus: status,
        failedAt: status === "failed" ? now : request.failedAt,
        failedReason: status === "failed" ? reason : request.failedReason,
        confirmations: confirmations ?? request.confirmations,
        reviewNote: status === "rejected" ? reason : request.reviewNote,
        reviewedAt: status === "rejected" ? now : request.reviewedAt,
        updatedAt: now,
      };
      this.store.saveWithdrawalRequest(updated);
      this.store.saveFundingLedger(
        this.createLedger({
          userId: request.userId,
          accountId: after.id,
          accountType: "funding",
          type: "withdrawal_rejected",
          source: "withdrawal_request",
          amount: request.amount,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: "rejected",
          relatedId: request.id,
          network: request.network,
          walletAddress: request.walletAddress,
          txHash: request.broadcastTxHash ?? request.txHash,
          remark: reason,
        }),
      );
      return updated;
    });
  }

  private creditConfirmedDeposits() {
    let credited = 0;
    for (const deposit of this.store.listOnchainDeposits()) {
      if (deposit.status !== "confirmed" || deposit.creditedLedgerId) {
        continue;
      }
      this.store.transaction(() => {
        const current = this.store.getOnchainDeposit(deposit.id);
        if (!current || current.status !== "confirmed" || current.creditedLedgerId) {
          return;
        }
        const before = this.ensureFundingAccount(current.userId);
        const after = this.withAvailable({
          ...before,
          balance: roundMoney(before.balance + current.amountDecimal),
          updatedAt: Date.now(),
        });
        const ledger = this.createLedger({
          userId: current.userId,
          accountId: after.id,
          accountType: "funding",
          type: "deposit",
          source: "onchain_deposit",
          amount: current.amountDecimal,
          balanceBefore: before.balance,
          balanceAfter: after.balance,
          frozenBefore: before.frozen,
          frozenAfter: after.frozen,
          status: "completed",
          relatedId: current.id,
          network: current.network,
          walletAddress: current.toAddress,
          txHash: current.txHash,
          remark: "BSC Testnet 链上充值确认入账",
        });
        this.store.upsertFundingAccount(after);
        this.store.saveFundingLedger(ledger);
        this.store.saveOnchainDeposit({ ...current, creditedLedgerId: ledger.id, updatedAt: Date.now() });
        credited += 1;
      });
    }
    return credited;
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

  private ensureRealTradingAccount(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const existing = this.store.getRealTradingAccount(normalizedUserId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const account = this.withAvailable({
      id: `REAL-${normalizedUserId}`,
      userId: normalizedUserId,
      asset,
      balance: 0,
      frozen: 0,
      available: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.store.upsertRealTradingAccount(account);
    return account;
  }

  private findTransferRecipient(recipient: string) {
    const byId = this.store.findUserById(recipient);
    if (byId) {
      return byId;
    }
    return this.store.findUserByEmail(recipient.toLowerCase()) ?? null;
  }

  private getOrCreateDepositAddress(userId: string): DepositAddress {
    const existing = this.store.getDepositAddressByUserId(userId);
    if (existing) {
      return existing;
    }

    const derivationIndex = (this.store.getMaxDepositDerivationIndex() ?? -1) + 1;
    const path = `${this.depositDerivationPath}/${derivationIndex}`;
    const wallet = HDNodeWallet.fromPhrase(normalizeRequiredValue(this.depositMnemonic, "BSC_TESTNET_DEPOSIT_MNEMONIC"), undefined, path);
    const now = Date.now();
    const address: DepositAddress = {
      id: `ADDR-${userId}`,
      userId,
      network: depositNetwork,
      address: wallet.address,
      derivationIndex,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveDepositAddress(address);
    return address;
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

  private createTransferRecord(input: {
    transferType: AccountTransferRecord["transferType"];
    amount: number;
    fromUserId: string;
    toUserId: string;
    fromAccountType: WalletAccountType;
    toAccountType: WalletAccountType;
    clientRequestId?: string | null;
    remark?: string | null;
  }): AccountTransferRecord {
    const now = Date.now();
    return {
      id: makeId("TRF"),
      transferType: input.transferType,
      asset,
      amount: roundMoney(input.amount),
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      fromAccountType: input.fromAccountType,
      toAccountType: input.toAccountType,
      status: "completed",
      clientRequestId: input.clientRequestId ?? null,
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

function normalizeRequiredValue(value: string, name: string) {
  if (!value) {
    throw new Error(`缺少环境变量 ${name}。`);
  }
  return value;
}

function normalizeAccountType(value: WalletAccountType): NormalizedTransferSide {
  if (value === "trading" || value === "simulation") {
    return "simulation";
  }
  if (value === "funding" || value === "realTrading") {
    return value;
  }
  throw new Error("账户类型不正确。");
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
