import crypto from "node:crypto";
import { HDNodeWallet, verifyMessage } from "ethers";
import type { TradingService } from "../market/TradingService";
import type { TradingStore } from "../storage/TradingStore";
import { OnchainWalletService } from "./OnchainWalletService";
import { asset, defaultUserId, depositNetwork, simulationAccountLimit, simulationInitialBalance, simulationResetCooldownMs } from "./walletConstants";
import type { NormalizedTransferSide } from "./walletConstants";
import { createDemoDeposit, createDemoLedgerEntries, createDemoWithdrawal } from "./demoWalletData";
import {
  assertNonNegativeAmount,
  assertPositiveAmount,
  buildExternalWalletChallengeMessage,
  getLedgerDirection,
  getLedgerDisplayStatus,
  getTransferDisplayStatus,
  getTransferFundingDirection,
  getWithdrawalDisplayStatus,
  makeId,
  matchesFundingOrderFilter,
  normalizeAccountType,
  normalizeExternalWalletNetwork,
  normalizeExternalWalletProvider,
  normalizeFundingOrderFilter,
  normalizeOptional,
  normalizePage,
  normalizePageSize,
  normalizeRequiredInput,
  normalizeRequiredValue,
  normalizeSimulationAccountName,
  normalizeUserId,
  normalizeWalletAddress,
  pickPrimaryFundingLedger,
  resolvePageSize,
  roundMoney,
} from "./walletUtils";
import type {
  AccountTransferRecord,
  AccountOverview,
  DepositAddress,
  ExternalWalletBinding,
  ExternalWalletChallenge,
  FundingAccount,
  FundingLedgerEntry,
  FundingLedgerStatus,
  FundingLedgerType,
  FundingOrder,
  OnchainRecord,
  RecentFundingActivity,
  SimulationAccount,
  SimulationAccountView,
  WalletAccountType,
  WithdrawalRequest,
} from "../types";

type TransferSide = WalletAccountType;

export class WalletService {
  private depositMnemonic: string;
  private depositDerivationPath: string;

  constructor(
    private store: TradingStore,
    private trading: TradingService,
    private onchain: OnchainWalletService,
  ) {
    const credentiallessRealTest =
      process.env.NODE_ENV === "production"
      && process.env.XINGHENG_DEPLOYMENT_ENVIRONMENT === "real-test"
      && process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH === "true"
      && process.env.BSC_TESTNET_DEPOSIT_MNEMONIC === undefined
      && process.env.BSC_TESTNET_PRIVATE_KEY === undefined;
    if (
      process.env.XINGHENG_DEPLOYMENT_ENVIRONMENT === "real-test"
      && (
        process.env.BSC_TESTNET_DEPOSIT_MNEMONIC !== undefined
        || process.env.BSC_TESTNET_PRIVATE_KEY !== undefined
      )
    ) {
      throw new Error("真实测试环境禁止 BSC 交易凭证。");
    }
    this.depositMnemonic = credentiallessRealTest
      ? ""
      : normalizeRequiredValue(
        process.env.BSC_TESTNET_DEPOSIT_MNEMONIC?.trim() ?? "",
        "BSC_TESTNET_DEPOSIT_MNEMONIC",
      );
    this.depositDerivationPath = process.env.BSC_TESTNET_DERIVATION_PATH?.trim() || "m/44'/60'/0'/0";
    if (process.env.NODE_ENV !== "production") {
      this.ensureFundingAccount(defaultUserId);
      this.ensureRealTradingAccount(defaultUserId);
      this.seedDemoWalletData();
    }
  }

  private seedDemoWalletData() {
    if (process.env.NODE_ENV === "production") {
      return;
    }
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
          toAddress: "0x2222222222222222222222222222222222222222",
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
          toAddress: "0x3333333333333333333333333333333333333333",
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
          toAddress: "0x4444444444444444444444444444444444444444",
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
    const simulationAccounts = this.listSimulationAccountViews(normalizedUserId);
    const simulationSummary = this.buildSimulationSummary(simulationAccounts);
    const simulationView = simulationAccounts[0] ?? this.createEmptySimulationCompatibility(normalizedUserId);
    const realTrading = this.withRealTradingStatus(this.ensureRealTradingAccount(normalizedUserId));
    return {
      wallet: this.getWalletAccount(normalizedUserId),
      funding: this.ensureFundingAccount(normalizedUserId),
      realTrading,
      simulation: simulationView,
      trading: simulationView,
      simulationSummary,
      simulationAccounts,
    };
  }

  getOverview(userId: string): AccountOverview {
    const normalizedUserId = normalizeUserId(userId);
    const wallet = this.getWalletAccount(normalizedUserId);
    const funding = this.ensureFundingAccount(normalizedUserId);
    const realTrading = this.ensureRealTradingAccount(normalizedUserId);
    const simulationSummary = this.buildSimulationSummary(this.listSimulationAccountViews(normalizedUserId));
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
      simulationTotalEquity: simulationSummary.totalEquity,
      simulationTodayPnl: simulationSummary.todayPnl,
      simulationTodayPnlRate: simulationSummary.todayPnlRate,
      simulationAccountCount: simulationSummary.accountCount,
      simulationAccountLimit: simulationSummary.accountLimit,
      canCreateSimulationAccount: simulationSummary.canCreateSimulationAccount,
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
      toAddress: withdrawal.toAddress ?? null,
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

  listSimulationAccounts(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const items = this.listSimulationAccountViews(normalizedUserId);
    return {
      items,
      accountCount: items.length,
      accountLimit: simulationAccountLimit,
      canCreate: items.length < simulationAccountLimit,
    };
  }

  createSimulationAccount(userId: string, input: { name?: string } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    return this.store.transaction(() => {
      const existing = this.store.listSimulationAccounts(normalizedUserId);
      if (existing.length >= simulationAccountLimit) {
        throw new Error(`模拟账户最多 ${simulationAccountLimit} 个。`);
      }
      const now = Date.now();
      const account: SimulationAccount = {
        id: makeId("SIM"),
        userId: normalizedUserId,
        name: normalizeSimulationAccountName(input.name, `模拟账户 ${existing.length + 1}`),
        asset,
        balance: simulationInitialBalance,
        equity: simulationInitialBalance,
        usedMargin: 0,
        freeMargin: simulationInitialBalance,
        floatingPnl: 0,
        status: "active",
        lastResetAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.upsertSimulationAccount(account);
      const items = this.listSimulationAccountViews(normalizedUserId);
      return {
        account: this.toSimulationAccountView(account),
        accountCount: items.length,
        accountLimit: simulationAccountLimit,
        canCreate: items.length < simulationAccountLimit,
      };
    });
  }

  renameSimulationAccount(userId: string, accountId: string, input: { name?: string }) {
    const account = this.getOwnedSimulationAccount(userId, accountId);
    const next: SimulationAccount = {
      ...account,
      name: normalizeSimulationAccountName(input.name),
      updatedAt: Date.now(),
    };
    this.store.upsertSimulationAccount(next);
    return { account: this.toSimulationAccountView(next) };
  }

  deleteSimulationAccount(userId: string, accountId: string) {
    const account = this.getOwnedSimulationAccount(userId, accountId);
    this.store.upsertSimulationAccount({
      ...account,
      status: "deleted",
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  resetSimulationAccount(userId: string, accountId: string) {
    const account = this.getOwnedSimulationAccount(userId, accountId);
    if (account.usedMargin > 0) {
      throw new Error("当前模拟账户存在持仓或占用保证金，暂不能重置资金。");
    }
    const now = Date.now();
    const nextResetAvailableAt = account.lastResetAt ? account.lastResetAt + simulationResetCooldownMs : null;
    if (nextResetAvailableAt && nextResetAvailableAt > now) {
      throw new Error("模拟账户每 24 小时只能重置一次。");
    }

    const next: SimulationAccount = {
      ...account,
      balance: simulationInitialBalance,
      equity: simulationInitialBalance,
      usedMargin: 0,
      freeMargin: simulationInitialBalance,
      floatingPnl: 0,
      lastResetAt: now,
      updatedAt: now,
    };
    this.store.upsertSimulationAccount(next);
    const view = this.toSimulationAccountView(next);
    return {
      account: view,
      nextResetAvailableAt: view.nextResetAvailableAt,
      canReset: view.canReset,
    };
  }

  createExternalWalletChallenge(
    userId: string,
    input: { walletAddress?: string; network?: string; provider?: string },
  ): ExternalWalletChallenge {
    const normalizedUserId = normalizeUserId(userId);
    const walletAddress = normalizeWalletAddress(input.walletAddress);
    const network = normalizeExternalWalletNetwork(input.network);
    const provider = normalizeExternalWalletProvider(input.provider);
    const now = Date.now();
    return this.store.transaction(() => {
      const existingForUser = this.store.getExternalWalletBindingByUserId(normalizedUserId);
      if (existingForUser?.bindStatus === "active") {
        throw new Error("当前用户已绑定第三方钱包，请先解绑后再绑定新地址。");
      }

      const existingForAddress = this.store.getExternalWalletBindingByAddress(walletAddress);
      if (existingForAddress && existingForAddress.userId !== normalizedUserId) {
        if (existingForAddress.bindStatus === "active" || existingForAddress.challengeExpiresAt > now) {
          throw new Error("该钱包地址已被其他用户绑定或正在绑定中。");
        }
        this.store.deleteExternalWalletBinding(existingForAddress.id);
      }

      const nonce = crypto.randomBytes(16).toString("hex");
      const expiresAt = now + 10 * 60 * 1000;
      const challengeId = existingForUser?.id ?? makeId("EW");
      const message = buildExternalWalletChallengeMessage({
        userId: normalizedUserId,
        walletAddress,
        network,
        provider,
        nonce,
        issuedAt: now,
        expiresAt,
      });
      const binding: ExternalWalletBinding = {
        id: challengeId,
        userId: normalizedUserId,
        walletAddress,
        network,
        provider,
        isDefault: false,
        bindStatus: "pending",
        nonce,
        challenge: message,
        challengeExpiresAt: expiresAt,
        lastVerifiedAt: null,
        createdAt: existingForUser?.createdAt ?? now,
        updatedAt: now,
      };
      this.store.saveExternalWalletBinding(binding);
      return {
        challengeId,
        walletAddress,
        network,
        provider,
        nonce,
        message,
        expiresAt,
      };
    });
  }

  bindExternalWallet(
    userId: string,
    input: { challengeId?: string; walletAddress?: string; signature?: string },
  ): { binding: ExternalWalletBinding } {
    const normalizedUserId = normalizeUserId(userId);
    const challengeId = normalizeRequiredInput(input.challengeId, "challengeId");
    const walletAddress = normalizeWalletAddress(input.walletAddress);
    const signature = normalizeRequiredInput(input.signature, "signature");
    return this.store.transaction(() => {
      const binding = this.store.getExternalWalletBindingById(challengeId);
      if (!binding || binding.userId !== normalizedUserId) {
        throw new Error("签名 challenge 不存在或不属于当前用户。");
      }
      if (binding.bindStatus === "active") {
        throw new Error("该第三方钱包已完成绑定。");
      }
      if (binding.challengeExpiresAt <= Date.now()) {
        throw new Error("签名 challenge 已过期，请重新获取。");
      }
      if (binding.walletAddress !== walletAddress) {
        throw new Error("提交的钱包地址与 challenge 不一致。");
      }

      let recoveredAddress: string;
      try {
        recoveredAddress = normalizeWalletAddress(verifyMessage(binding.challenge, signature));
      } catch {
        throw new Error("签名验证失败，请确认使用 MetaMask 当前地址签名。");
      }
      if (recoveredAddress !== walletAddress) {
        throw new Error("签名地址与绑定地址不一致。");
      }

      const existingForAddress = this.store.getExternalWalletBindingByAddress(walletAddress);
      if (existingForAddress && existingForAddress.userId !== normalizedUserId) {
        throw new Error("该钱包地址已被其他用户绑定。");
      }

      const now = Date.now();
      const activeBinding: ExternalWalletBinding = {
        ...binding,
        walletAddress,
        isDefault: true,
        bindStatus: "active",
        lastVerifiedAt: now,
        updatedAt: now,
      };
      this.store.saveExternalWalletBinding(activeBinding);
      return { binding: activeBinding };
    });
  }

  getExternalWalletBinding(userId: string): { binding: ExternalWalletBinding | null } {
    const binding = this.store.getExternalWalletBindingByUserId(normalizeUserId(userId));
    return { binding: binding?.bindStatus === "active" ? binding : null };
  }

  unbindExternalWallet(userId: string): { ok: true; binding: null } {
    const binding = this.store.getExternalWalletBindingByUserId(normalizeUserId(userId));
    if (binding) {
      this.store.deleteExternalWalletBinding(binding.id);
    }
    return { ok: true, binding: null };
  }

  listExternalWalletBindings() {
    return this.store.listExternalWalletBindings().filter((binding) => binding.bindStatus === "active");
  }

  listWithdrawals(userId?: string) {
    return this.store.listWithdrawalRequests(userId ? normalizeUserId(userId) : undefined);
  }

  getDepositAddress(userId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const address = this.store.transaction(() => this.getOrCreateDepositAddressIfConfigured(normalizedUserId));
    return {
      ...this.onchain.getPublicConfig(),
      ...address,
    };
  }

  ensureDepositAddressForRegisteredUser(userId: string) {
    return this.getOrCreateDepositAddress(normalizeUserId(userId));
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

  createWithdrawal(userId: string, input: { amount: number; network?: string; toAddress?: string; remark?: string }) {
    assertPositiveAmount(input.amount);
    const normalizedUserId = normalizeUserId(userId);
    const toAddress = normalizeRequiredInput(input.toAddress, "toAddress");
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
        txHash: null,
        onchainStatus: "pending_review",
        chainId: this.onchain.config.chainId,
        tokenAddress: this.onchain.config.tokenAddress,
        fromAddress: null,
        toAddress,
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
          address: request.toAddress,
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
      return this.failWithdrawal(id, error instanceof Error ? error.message : "提现广播失败。");
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
        results.push(this.failWithdrawal(request.id, "缺少 txHash，无法确认链上提现。"));
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
          address: this.store.getDepositAddressByUserId(userId)?.address ?? null,
          remark: remark ?? "钱包划转入资金账户",
        }),
      );

      return { transfer, accounts: { ...this.getAccounts(userId), wallet: walletAfter } };
    });
  }

  private transferFundingToSimulation(_userId: string, _amount: number, _remark?: string | null): never {
    throw new Error("模拟账户资金与资金账户不联动，请在模拟账户页使用重置资金。");
  }

  private transferSimulationToFunding(_userId: string, _amount: number, _remark?: string | null): never {
    throw new Error("模拟账户资金与资金账户不联动，不能划转到资金账户。");
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
        throw new Error("提现申请不存在。");
      }
      if (request.status !== "pending_review") {
        throw new Error("只能审核 pending_review 状态的提现申请。");
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
        throw new Error("提现申请状态不是 broadcasting。");
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
        throw new Error("提现申请状态不是 broadcasted。");
      }
      const before = this.ensureFundingAccount(request.userId);
      if (before.frozen < request.amount) {
        throw new Error("资金账户冻结金额不足，无法确认提现。");
      }
      const now = Date.now();
      const after = this.withAvailable({
        ...before,
        balance: roundMoney(before.balance - request.amount),
        frozen: roundMoney(before.frozen - request.amount),
        updatedAt: now,
      });
      if (after.balance < 0 || after.frozen < 0) {
        throw new Error("资金账户余额异常，无法确认提现。");
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
          address: request.toAddress,
          txHash: updated.broadcastTxHash ?? updated.txHash,
          remark: updated.reviewNote,
        }),
      );
      return updated;
    });
  }

  private rejectPendingWithdrawal(id: string, reviewNote?: string) {
    return this.releaseWithdrawal(id, "rejected", normalizeOptional(reviewNote) ?? "后台拒绝提现。");
  }

  private failWithdrawal(id: string, failedReason: string, confirmations?: number) {
    return this.releaseWithdrawal(id, "failed", failedReason, confirmations);
  }

  private releaseWithdrawal(id: string, status: "failed" | "rejected", reason: string, confirmations?: number) {
    return this.store.transaction(() => {
      const request = this.store.getWithdrawalRequest(id);
      if (!request) {
        throw new Error("提现申请不存在。");
      }
      if (!["pending_review", "broadcasting", "broadcasted"].includes(request.status)) {
        throw new Error("当前提现状态不能释放冻结。");
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
          address: request.toAddress,
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
    const mnemonic = normalizeRequiredValue(
      this.depositMnemonic,
      "BSC_TESTNET_DEPOSIT_MNEMONIC",
    );
    const existing = this.store.getDepositAddressByUserId(userId);
    if (existing) {
      return existing;
    }

    const derivationIndex = (this.store.getMaxDepositDerivationIndex() ?? -1) + 1;
    const path = `${this.depositDerivationPath}/${derivationIndex}`;
    const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, path);
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

  private getOrCreateDepositAddressIfConfigured(userId: string): DepositAddress {
    const existing = this.store.getDepositAddressByUserId(userId);
    if (existing) {
      return {
        ...existing,
        isConfigured: true,
        message: null,
      };
    }
    if (!this.depositMnemonic) {
      return this.createUnavailableDepositAddress(userId);
    }
    return {
      ...this.getOrCreateDepositAddress(userId),
      isConfigured: true,
      message: null,
    };
  }

  private createUnavailableDepositAddress(userId: string): DepositAddress {
    const now = Date.now();
    return {
      id: `ADDR-${userId}-UNCONFIGURED`,
      userId,
      network: depositNetwork,
      address: "",
      derivationIndex: -1,
      createdAt: now,
      updatedAt: now,
      isConfigured: false,
      message: "测试网充值地址未配置，请联系管理员。",
    };
  }

  private withAvailable(account: FundingAccount): FundingAccount {
    return {
      ...account,
      balance: roundMoney(account.balance),
      frozen: roundMoney(account.frozen),
      available: roundMoney(account.balance - account.frozen),
    };
  }

  private listSimulationAccountViews(userId: string): SimulationAccountView[] {
    return this.store.listSimulationAccounts(normalizeUserId(userId)).map((account) => this.toSimulationAccountView(account));
  }

  private buildSimulationSummary(accounts: SimulationAccountView[]) {
    return {
      asset,
      totalEquity: roundMoney(accounts.reduce((sum, account) => sum + account.equity, 0)),
      todayPnl: 0,
      todayPnlRate: 0,
      accountCount: accounts.length,
      accountLimit: simulationAccountLimit,
      canCreateSimulationAccount: accounts.length < simulationAccountLimit,
    };
  }

  private toSimulationAccountView(account: SimulationAccount): SimulationAccountView {
    const nextResetAvailableAt = account.lastResetAt ? account.lastResetAt + simulationResetCooldownMs : null;
    const canReset = account.status === "active" && (!nextResetAvailableAt || nextResetAvailableAt <= Date.now());
    return this.withSimulationCompatibility({
      ...account,
      balance: roundMoney(account.balance),
      equity: roundMoney(account.equity),
      usedMargin: roundMoney(account.usedMargin),
      freeMargin: roundMoney(account.freeMargin),
      floatingPnl: roundMoney(account.floatingPnl),
      lastResetAt: account.lastResetAt ?? null,
      nextResetAvailableAt,
      canReset,
    });
  }

  private createEmptySimulationCompatibility(userId: string): SimulationAccountView {
    return this.withSimulationCompatibility({
      id: "",
      userId,
      simulationAccountId: "",
      name: "未创建模拟账户",
      asset,
      balance: 0,
      equity: 0,
      usedMargin: 0,
      freeMargin: 0,
      floatingPnl: 0,
      status: "disabled" as const,
      createdAt: 0,
      updatedAt: 0,
      lastResetAt: null,
      nextResetAvailableAt: null,
      canReset: false,
    });
  }

  private getOwnedSimulationAccount(userId: string, accountId: string) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedAccountId = normalizeRequiredInput(accountId, "accountId");
    const account = this.store.getSimulationAccount(normalizedAccountId);
    if (!account || account.userId !== normalizedUserId || account.status === "deleted") {
      throw new Error("模拟账户不存在。");
    }
    if (account.status === "disabled") {
      throw new Error("模拟账户已禁用。");
    }
    return account;
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
      return "后台手工充值";
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
    address?: string | null;
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
      address: input.address ?? null,
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
