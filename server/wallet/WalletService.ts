import { HDNodeWallet } from "ethers";
import type { TradingService } from "../market/TradingService";
import type { TradingStore } from "../storage/TradingStore";
import { OnchainWalletService } from "./OnchainWalletService";
import type {
  AccountTransferRecord,
  AccountOverview,
  DepositAddress,
  FundingAccount,
  FundingLedgerEntry,
  FundingLedgerStatus,
  FundingLedgerType,
  FundingOrder,
  FundingOrderDisplayStatus,
  FundingOrderType,
  OnchainDeposit,
  OnchainRecord,
  RecentFundingActivity,
  WalletAccountType,
  WalletNetwork,
  WithdrawalRequest,
} from "../types";

const defaultUserId = "demo-user";
const asset = "USDT";
const depositNetwork: WalletNetwork = "BSC_TESTNET";

type TransferSide = WalletAccountType;
type NormalizedTransferSide = "wallet" | "funding" | "simulation" | "realTrading";
type FundingOrderFilter = "all" | "deposit" | "withdrawal" | "transfer" | FundingOrderType;

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
    this.seedDemoWalletData();
  }

  private seedDemoWalletData() {
    const userId = defaultUserId;
    const hasSeededDemoData =
      this.store.listFundingLedger(userId).some((entry) => entry.id === "LED-DEMO-ONCHAIN-001") &&
      this.store.listOnchainDeposits(userId).some((deposit) => deposit.id === "DEP-DEMO-CONFIRMED-001") &&
      this.store.listWithdrawalRequests(userId).some((request) => request.id === "WDR-DEMO-PENDING-001");
    if (hasSeededDemoData) {
      return;
    }

    let depositAddress: DepositAddress;
    try {
      depositAddress = this.store.transaction(() => this.getOrCreateDepositAddress(userId));
    } catch (error) {
      console.warn("[wallet] skipped demo wallet data seed:", error instanceof Error ? error.message : error);
      return;
    }

    const createdAt = Date.parse("2026-07-03T09:30:00+08:00");
    const fundingAccount = this.withAvailable({
      id: `FUND-${userId}`,
      userId,
      asset,
      balance: 3200,
      frozen: 250,
      available: 2950,
      createdAt,
      updatedAt: createdAt,
    });
    const realTradingAccount = this.withAvailable({
      id: `REAL-${userId}`,
      userId,
      asset,
      balance: 200,
      frozen: 0,
      available: 200,
      createdAt,
      updatedAt: createdAt,
    });

    const confirmedDepositId = "DEP-DEMO-CONFIRMED-001";
    const confirmingDepositId = "DEP-DEMO-CONFIRMING-001";
    const pendingWithdrawalId = "WDR-DEMO-PENDING-001";
    const confirmedWithdrawalId = "WDR-DEMO-CONFIRMED-001";
    const failedWithdrawalId = "WDR-DEMO-FAILED-001";
    const transferInId = "TRF-DEMO-SIM-FUND-001";
    const transferOutId = "TRF-DEMO-FUND-REAL-001";

    this.store.transaction(() => {
      this.store.upsertFundingAccount(fundingAccount);
      this.store.upsertRealTradingAccount(realTradingAccount);

      this.store.saveOnchainDeposit(
        createDemoDeposit({
          id: confirmedDepositId,
          userId,
          toAddress: depositAddress.address,
          tokenAddress: this.onchain.config.tokenAddress,
          amount: "2500000000000000000000",
          amountDecimal: 2500,
          txHash: "0x1000000000000000000000000000000000000000000000000000000000000001",
          logIndex: 0,
          blockNumber: 116536950,
          confirmations: 18,
          status: "confirmed",
          creditedLedgerId: null,
          createdAt: createdAt + 60_000,
          confirmedAt: createdAt + 180_000,
        }),
      );
      this.store.saveOnchainDeposit(
        createDemoDeposit({
          id: confirmingDepositId,
          userId,
          toAddress: depositAddress.address,
          tokenAddress: this.onchain.config.tokenAddress,
          amount: "750000000000000000000",
          amountDecimal: 750,
          txHash: "0x1000000000000000000000000000000000000000000000000000000000000002",
          logIndex: 1,
          blockNumber: 116536980,
          confirmations: 0,
          status: "confirming",
          createdAt: createdAt + 720_000,
        }),
      );
      this.store.saveOnchainDeposit(
        createDemoDeposit({
          id: "DEP-DEMO-FAILED-001",
          userId,
          toAddress: depositAddress.address,
          tokenAddress: this.onchain.config.tokenAddress,
          amount: "99990000000000000000",
          amountDecimal: 99.99,
          txHash: "0x1000000000000000000000000000000000000000000000000000000000000003",
          logIndex: 2,
          blockNumber: 116536990,
          confirmations: 3,
          status: "failed",
          failedReason: "演示数据：代币合约或入账校验未通过",
          createdAt: createdAt + 1_020_000,
        }),
      );

      this.store.saveAccountTransfer({
        id: transferInId,
        transferType: "account_transfer",
        asset,
        amount: 1500,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "simulation",
        toAccountType: "funding",
        status: "completed",
        clientRequestId: "demo-transfer-simulation-to-funding",
        remark: "演示数据：模拟账户转入资金账户",
        createdAt: createdAt + 240_000,
        updatedAt: createdAt + 240_000,
      });
      this.store.saveAccountTransfer({
        id: transferOutId,
        transferType: "account_transfer",
        asset,
        amount: 200,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "funding",
        toAccountType: "realTrading",
        status: "completed",
        clientRequestId: "demo-transfer-funding-to-real",
        remark: "演示数据：资金账户转入交易账户",
        createdAt: createdAt + 900_000,
        updatedAt: createdAt + 900_000,
      });

      this.store.saveWithdrawalRequest(
        createDemoWithdrawal({
          id: pendingWithdrawalId,
          userId,
          amount: 250,
          status: "pending_review",
          walletAddress: "0x2222222222222222222222222222222222222222",
          tokenAddress: this.onchain.config.tokenAddress,
          createdAt: createdAt + 480_000,
          remark: "演示数据：等待后台审核",
        }),
      );
      this.store.saveWithdrawalRequest(
        createDemoWithdrawal({
          id: confirmedWithdrawalId,
          userId,
          amount: 600,
          status: "confirmed",
          walletAddress: "0x3333333333333333333333333333333333333333",
          tokenAddress: this.onchain.config.tokenAddress,
          broadcastTxHash: "0x2000000000000000000000000000000000000000000000000000000000000001",
          confirmations: 12,
          createdAt: createdAt + 540_000,
          reviewedAt: createdAt + 600_000,
          broadcastedAt: createdAt + 660_000,
          confirmedAt: createdAt + 780_000,
          remark: "演示数据：已链上确认",
        }),
      );
      this.store.saveWithdrawalRequest(
        createDemoWithdrawal({
          id: failedWithdrawalId,
          userId,
          amount: 120,
          status: "failed",
          walletAddress: "0x4444444444444444444444444444444444444444",
          tokenAddress: this.onchain.config.tokenAddress,
          broadcastTxHash: "0x2000000000000000000000000000000000000000000000000000000000000002",
          failedReason: "演示数据：RPC 广播超时，冻结资金已释放",
          confirmations: 0,
          createdAt: createdAt + 1_080_000,
          reviewedAt: createdAt + 1_140_000,
          broadcastedAt: createdAt + 1_200_000,
          failedAt: createdAt + 1_260_000,
          remark: "演示数据：失败释放冻结",
        }),
      );

      for (const entry of createDemoLedgerEntries({ userId, accountId: fundingAccount.id, depositAddress: depositAddress.address })) {
        this.store.saveFundingLedger(entry);
      }
    });
  }

  getAccounts(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const simulation = this.trading.getAccount(normalizedUserId);
    const simulationView = this.withSimulationCompatibility(simulation);
    const realTrading = this.withRealTradingStatus(this.ensureRealTradingAccount(normalizedUserId));
    return {
      wallet: this.getWalletAccount(normalizedUserId),
      funding: this.ensureFundingAccount(normalizedUserId),
      realTrading,
      simulation: simulationView,
      trading: simulationView,
      simulationSummary: {
        asset,
        totalEquity: roundMoney(simulation.equity),
        todayPnl: 0,
        todayPnlRate: 0,
        accountCount: 1,
        accountLimit: 5,
        canCreateSimulationAccount: true,
      },
      simulationAccounts: [simulationView],
    };
  }

  getOverview(userId: string): AccountOverview {
    const normalizedUserId = normalizeUserId(userId);
    const wallet = this.getWalletAccount(normalizedUserId);
    const funding = this.ensureFundingAccount(normalizedUserId);
    const realTrading = this.ensureRealTradingAccount(normalizedUserId);
    const simulation = this.trading.getAccount(normalizedUserId);
    const walletEquity = roundMoney(wallet.available);
    const fundingEquity = roundMoney(funding.balance);
    const realTradingEquity = this.isRealTradingOpened(realTrading) ? roundMoney(realTrading.balance) : 0;
    return {
      asset,
      walletEquity,
      fundingEquity,
      realTradingEquity,
      totalEquity: roundMoney(walletEquity + fundingEquity + realTradingEquity),
      accountTodayPnl: 0,
      accountTodayPnlRate: 0,
      simulationTotalEquity: roundMoney(simulation.equity),
      simulationTodayPnl: 0,
      simulationTodayPnlRate: 0,
      simulationAccountCount: 1,
      simulationAccountLimit: 5,
      canCreateSimulationAccount: true,
      recentFundingActivities: this.listRecentActivities(normalizedUserId, 6),
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

  getWalletAccount(userId: string): FundingAccount {
    const normalizedUserId = normalizeUserId(userId);
    const deposits = this.store
      .listOnchainDeposits(normalizedUserId)
      .filter((deposit) => deposit.status === "confirmed");
    const confirmedAmount = roundMoney(deposits.reduce((sum, deposit) => sum + deposit.amountDecimal, 0));
    const allocatedToFunding = roundMoney(
      this.store
        .listFundingLedger(normalizedUserId)
        .filter((entry) => entry.source === "onchain_deposit" && entry.status === "completed")
        .reduce((sum, entry) => sum + entry.amount, 0),
    );
    const now = Date.now();
    return this.withAvailable({
      id: `WALLET-${normalizedUserId}`,
      userId: normalizedUserId,
      asset,
      balance: confirmedAmount,
      frozen: Math.min(confirmedAmount, allocatedToFunding),
      available: 0,
      createdAt: deposits.at(-1)?.createdAt ?? now,
      updatedAt: Math.max(0, ...deposits.map((deposit) => deposit.updatedAt), ...this.store.listFundingLedger(normalizedUserId).map((entry) => entry.updatedAt)) || now,
    });
  }

  listLedger(userId?: string) {
    return this.store.listFundingLedger(userId ? normalizeUserId(userId) : undefined);
  }

  listTransfers(userId?: string) {
    return this.store.listAccountTransfers(userId ? normalizeUserId(userId) : undefined);
  }

  listRecentActivities(userId: string, limit = 20): RecentFundingActivity[] {
    const normalizedUserId = normalizeUserId(userId);
    const deposits = this.store.listOnchainDeposits(normalizedUserId).map((deposit): RecentFundingActivity => ({
      id: `deposit-${deposit.id}`,
      activityType: "onchain_deposit",
      title: "链上充值",
      accountType: "wallet",
      amount: roundMoney(deposit.amountDecimal),
      asset: deposit.asset,
      status: deposit.status,
      direction: "in",
      txHash: deposit.txHash,
      remark: deposit.failedReason ?? null,
      createdAt: deposit.confirmedAt ?? deposit.updatedAt ?? deposit.detectedAt,
    }));
    const withdrawals = this.store.listWithdrawalRequests(normalizedUserId).map((withdrawal): RecentFundingActivity => ({
      id: `withdrawal-${withdrawal.id}`,
      activityType: "withdrawal",
      title: this.getWithdrawalActivityTitle(withdrawal),
      accountType: "funding",
      amount: roundMoney(withdrawal.amount),
      asset: withdrawal.asset,
      status: withdrawal.onchainStatus ?? withdrawal.status,
      direction: "out",
      txHash: withdrawal.broadcastTxHash ?? withdrawal.txHash ?? null,
      remark: withdrawal.failedReason ?? withdrawal.reviewNote ?? withdrawal.remark ?? null,
      createdAt: withdrawal.confirmedAt ?? withdrawal.failedAt ?? withdrawal.broadcastedAt ?? withdrawal.reviewedAt ?? withdrawal.updatedAt ?? withdrawal.createdAt,
    }));
    const transfers = this.store.listAccountTransfers(normalizedUserId).map((transfer): RecentFundingActivity => ({
      id: `transfer-${transfer.id}`,
      activityType: transfer.transferType,
      title: transfer.transferType === "internal_transfer" ? "用户间内部转账" : "账户划转",
      fromAccountType: transfer.fromAccountType,
      toAccountType: transfer.toAccountType,
      amount: roundMoney(transfer.amount),
      asset: transfer.asset,
      status: transfer.status,
      direction: transfer.toUserId === normalizedUserId ? "in" : transfer.fromUserId === normalizedUserId ? "out" : "neutral",
      remark: transfer.remark ?? null,
      createdAt: transfer.updatedAt ?? transfer.createdAt,
    }));
    const ledger = this.store
      .listFundingLedger(normalizedUserId)
      .filter((entry) => !entry.relatedId || entry.source === "admin_manual" || entry.type.startsWith("withdrawal_"))
      .map((entry): RecentFundingActivity => ({
        id: `ledger-${entry.id}`,
        activityType: "funding_ledger",
        title: this.getLedgerActivityTitle(entry),
        accountType: entry.accountType,
        amount: roundMoney(entry.amount),
        asset: entry.asset,
        status: entry.status,
        direction: getLedgerDirection(entry),
        txHash: entry.txHash ?? null,
        remark: entry.remark ?? null,
        createdAt: entry.updatedAt ?? entry.createdAt,
      }));

    return [...deposits, ...withdrawals, ...transfers, ...ledger]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit));
  }

  listFundingOrders(
    userId: string,
    options: { type?: string; limit?: number; page?: number; pageSize?: number } = {},
  ): { items: FundingOrder[]; total: number; page: number; pageSize: number; hasMore: boolean } {
    const normalizedUserId = normalizeUserId(userId);
    const filter = normalizeFundingOrderFilter(options.type);
    const ledgerEntries = this.store.listFundingLedger(normalizedUserId);
    const ledgerByRelatedId = new Map<string, FundingLedgerEntry[]>();
    for (const entry of ledgerEntries) {
      if (!entry.relatedId) {
        continue;
      }
      const existing = ledgerByRelatedId.get(entry.relatedId) ?? [];
      existing.push(entry);
      ledgerByRelatedId.set(entry.relatedId, existing);
    }

    const depositOrders = ledgerEntries
      .filter((entry) => entry.accountType === "funding")
      .filter((entry) => entry.type === "deposit" && entry.status === "completed")
      .filter((entry) => entry.source === "admin_manual")
      .map((entry): FundingOrder => ({
        id: `funding-ledger-${entry.id}`,
        orderType: "deposit",
        accountType: "funding",
        amount: roundMoney(entry.amount),
        asset: entry.asset,
        status: entry.status,
        displayStatus: getLedgerDisplayStatus(entry.status),
        direction: "in",
        fromAccountType: null,
        toAccountType: "funding",
        relatedLedgerId: entry.id,
        relatedTransferId: null,
        relatedWithdrawalId: null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));

    const withdrawalOrders = this.store.listWithdrawalRequests(normalizedUserId).map((withdrawal): FundingOrder => {
      const relatedLedger = pickPrimaryFundingLedger(ledgerByRelatedId.get(withdrawal.id));
      return {
        id: `withdrawal-${withdrawal.id}`,
        orderType: "withdrawal",
        accountType: "funding",
        amount: roundMoney(withdrawal.amount),
        asset: withdrawal.asset,
        status: withdrawal.onchainStatus ?? withdrawal.status,
        displayStatus: getWithdrawalDisplayStatus(withdrawal.status),
        direction: "out",
        fromAccountType: "funding",
        toAccountType: null,
        relatedLedgerId: relatedLedger?.id ?? null,
        relatedTransferId: null,
        relatedWithdrawalId: withdrawal.id,
        createdAt: withdrawal.createdAt,
        updatedAt: withdrawal.updatedAt,
      };
    });

    const transferOrders = this.store
      .listAccountTransfers(normalizedUserId)
      .filter((transfer) => transfer.fromAccountType === "funding" || transfer.toAccountType === "funding")
      .map((transfer): FundingOrder => {
        const relatedLedger = pickPrimaryFundingLedger(
          (ledgerByRelatedId.get(transfer.id) ?? []).filter((entry) => entry.accountType === "funding"),
        );
        return {
          id: `transfer-${transfer.id}`,
          orderType: transfer.transferType,
          accountType: "funding",
          amount: roundMoney(transfer.amount),
          asset: transfer.asset,
          status: transfer.status,
          displayStatus: getTransferDisplayStatus(transfer.status),
          direction: getTransferFundingDirection(transfer, normalizedUserId),
          fromAccountType: transfer.fromAccountType,
          toAccountType: transfer.toAccountType,
          relatedLedgerId: relatedLedger?.id ?? null,
          relatedTransferId: transfer.id,
          relatedWithdrawalId: null,
          createdAt: transfer.createdAt,
          updatedAt: transfer.updatedAt,
        };
      });

    const orders = [...depositOrders, ...withdrawalOrders, ...transferOrders]
      .filter((order) => matchesFundingOrderFilter(order, filter))
      .sort((a, b) => b.createdAt - a.createdAt);
    const pageSize = normalizePageSize(resolvePageSize(options.limit, options.pageSize));
    const page = normalizePage(options.page);
    const start = (page - 1) * pageSize;
    const items = orders.slice(start, start + pageSize);
    return {
      items,
      total: orders.length,
      page,
      pageSize,
      hasMore: start + items.length < orders.length,
    };
  }

  listOnchainRecords(
    userId: string,
    options: { limit?: number; page?: number; pageSize?: number } = {},
  ): { items: OnchainRecord[]; total: number; page: number; pageSize: number; hasMore: boolean } {
    const normalizedUserId = normalizeUserId(userId);
    const deposits = this.store.listOnchainDeposits(normalizedUserId).map((deposit): OnchainRecord => ({
      id: `onchain-deposit-${deposit.id}`,
      type: "deposit",
      amount: roundMoney(deposit.amountDecimal),
      asset: deposit.asset,
      network: deposit.network,
      fromAddress: deposit.fromAddress,
      toAddress: deposit.toAddress,
      txHash: deposit.txHash,
      confirmations: deposit.confirmations,
      chainStatus: deposit.status,
      createdAt: deposit.detectedAt,
      updatedAt: deposit.updatedAt,
      relatedDepositId: deposit.id,
      relatedWithdrawalId: null,
    }));
    const withdrawals = this.store.listWithdrawalRequests(normalizedUserId).map((withdrawal): OnchainRecord => ({
      id: `onchain-withdrawal-${withdrawal.id}`,
      type: "withdrawal",
      amount: roundMoney(withdrawal.amount),
      asset: withdrawal.asset,
      network: withdrawal.network ?? depositNetwork,
      fromAddress: withdrawal.fromAddress ?? null,
      toAddress: withdrawal.toAddress ?? withdrawal.walletAddress ?? null,
      txHash: withdrawal.broadcastTxHash ?? withdrawal.txHash ?? null,
      confirmations: withdrawal.confirmations ?? null,
      chainStatus: withdrawal.onchainStatus ?? withdrawal.status,
      createdAt: withdrawal.createdAt,
      updatedAt: withdrawal.updatedAt,
      relatedDepositId: null,
      relatedWithdrawalId: withdrawal.id,
    }));
    const records = [...deposits, ...withdrawals].sort((a, b) => b.createdAt - a.createdAt);
    const pageSize = normalizePageSize(resolvePageSize(options.limit, options.pageSize));
    const page = normalizePage(options.page);
    const start = (page - 1) * pageSize;
    const items = records.slice(start, start + pageSize);
    return {
      items,
      total: records.length,
      page,
      pageSize,
      hasMore: start + items.length < records.length,
    };
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
    return {
      ...result,
      credited: 0,
      creditMode: "wallet_only",
      message: result.message ?? "链上充值确认后只计入钱包资产，不自动进入资金账户。",
    };
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
    if (from === "wallet" && to === "funding") {
      return this.transferWalletToFunding(userId, amount, remark);
    }
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

  private transferWalletToFunding(userId: string, amount: number, remark?: string | null) {
    return this.store.transaction(() => {
      const walletBefore = this.getWalletAccount(userId);
      if (walletBefore.available < amount) {
        throw new Error("钱包可划转余额不足。");
      }

      const fundingBefore = this.ensureFundingAccount(userId);
      const now = Date.now();
      const roundedAmount = roundMoney(amount);
      const fundingAfter = this.withAvailable({
        ...fundingBefore,
        balance: roundMoney(fundingBefore.balance + roundedAmount),
        updatedAt: now,
      });
      const walletAfter = this.withAvailable({
        ...walletBefore,
        frozen: roundMoney(walletBefore.frozen + roundedAmount),
        updatedAt: now,
      });
      const transfer = this.createTransferRecord({
        transferType: "account_transfer",
        amount: roundedAmount,
        fromUserId: userId,
        toUserId: userId,
        fromAccountType: "wallet",
        toAccountType: "funding",
        remark,
      });

      this.store.upsertFundingAccount(fundingAfter);
      this.store.saveAccountTransfer(transfer);
      this.store.saveFundingLedger(
        this.createLedger({
          userId,
          accountId: fundingAfter.id,
          accountType: "funding",
          type: "deposit",
          source: "onchain_deposit",
          amount: roundedAmount,
          balanceBefore: fundingBefore.balance,
          balanceAfter: fundingAfter.balance,
          frozenBefore: fundingBefore.frozen,
          frozenAfter: fundingAfter.frozen,
          status: "completed",
          relatedId: transfer.id,
          network: depositNetwork,
          walletAddress: this.store.getDepositAddressByUserId(userId)?.address ?? null,
          remark: remark ?? "钱包划转入资金账户",
        }),
      );

      return { transfer, accounts: { ...this.getAccounts(userId), wallet: walletAfter } };
    });
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

  private withSimulationCompatibility<T extends { freeMargin: number; floatingPnl: number }>(account: T) {
    return {
      ...account,
      availableMargin: roundMoney(account.freeMargin),
      unrealizedPnl: roundMoney(account.floatingPnl),
    };
  }

  private withRealTradingStatus(account: FundingAccount) {
    const opened = this.isRealTradingOpened(account);
    return {
      ...account,
      status: opened ? "active" : "disabled",
      opened,
      enabled: opened,
    };
  }

  private isRealTradingOpened(account: FundingAccount) {
    return account.balance > 0 || account.frozen > 0;
  }

  private getWithdrawalActivityTitle(withdrawal: WithdrawalRequest) {
    const status = withdrawal.onchainStatus ?? withdrawal.status;
    if (status === "pending_review") {
      return "提现申请";
    }
    if (status === "broadcasting") {
      return "提现审核通过，广播中";
    }
    if (status === "broadcasted") {
      return "提现已广播";
    }
    if (status === "confirmed") {
      return "提现已确认";
    }
    if (status === "failed") {
      return "提现失败";
    }
    if (status === "rejected") {
      return "提现已拒绝";
    }
    return "提现记录";
  }

  private getLedgerActivityTitle(entry: FundingLedgerEntry) {
    if (entry.source === "admin_manual" && entry.type === "deposit") {
      return "后台手工入金";
    }
    if (entry.type === "withdrawal_freeze") {
      return "提现冻结";
    }
    if (entry.type === "withdrawal_approved") {
      return "提现扣减";
    }
    if (entry.type === "withdrawal_rejected") {
      return "提现释放";
    }
    if (entry.type === "transfer_in") {
      return "账户划转转入";
    }
    if (entry.type === "transfer_out") {
      return "账户划转转出";
    }
    if (entry.type === "internal_transfer_in") {
      return "内部转账转入";
    }
    if (entry.type === "internal_transfer_out") {
      return "内部转账转出";
    }
    return "资金记录";
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

function getLedgerDirection(entry: FundingLedgerEntry): RecentFundingActivity["direction"] {
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

function normalizeFundingOrderFilter(value: string | undefined): FundingOrderFilter {
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

function matchesFundingOrderFilter(order: FundingOrder, filter: FundingOrderFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "transfer") {
    return order.orderType === "account_transfer" || order.orderType === "internal_transfer";
  }
  return order.orderType === filter;
}

function getLedgerDisplayStatus(status: FundingLedgerStatus): FundingOrderDisplayStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "rejected") {
    return "cancelled";
  }
  return "pending";
}

function getWithdrawalDisplayStatus(status: WithdrawalRequest["status"]): FundingOrderDisplayStatus {
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

function getTransferDisplayStatus(status: AccountTransferRecord["status"]): FundingOrderDisplayStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "reversed") {
    return "cancelled";
  }
  return "failed";
}

function getTransferFundingDirection(transfer: AccountTransferRecord, userId: string): FundingOrder["direction"] {
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

function pickPrimaryFundingLedger(entries: FundingLedgerEntry[] | undefined) {
  if (!entries || entries.length === 0) {
    return null;
  }
  return [...entries].sort((a, b) => {
    const fundingDeltaA = Math.abs(a.balanceAfter - a.balanceBefore) + Math.abs(a.frozenAfter - a.frozenBefore);
    const fundingDeltaB = Math.abs(b.balanceAfter - b.balanceBefore) + Math.abs(b.frozenAfter - b.frozenBefore);
    return fundingDeltaB - fundingDeltaA || b.updatedAt - a.updatedAt;
  })[0];
}

function normalizePageSize(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

function resolvePageSize(limit: number | undefined, pageSize: number | undefined) {
  return typeof pageSize === "number" && Number.isFinite(pageSize) ? pageSize : limit;
}

function normalizePage(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.trunc(value));
}

function createDemoDeposit(input: {
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

function createDemoWithdrawal(input: {
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

function createDemoLedgerEntries(input: { userId: string; accountId: string; depositAddress: string }): FundingLedgerEntry[] {
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
