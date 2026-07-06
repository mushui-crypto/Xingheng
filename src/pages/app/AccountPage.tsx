import { useEffect, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { fetchOrders, type OrderRecord, type TradingAccount } from "../../api/market";
import {
  bindExternalWallet,
  createExternalWalletChallenge,
  createInternalTransfer,
  createSimulationAccount,
  createWithdrawalRequest,
  deleteSimulationAccount,
  fetchExternalWalletBinding,
  fetchAccountOverview,
  fetchDepositAddress,
  fetchFundingOrders,
  fetchOnchainRecords,
  fetchRecentFundingActivities,
  fetchWalletAccounts,
  renameSimulationAccount,
  resetSimulationAccount,
  unbindExternalWallet,
  transferWalletAccount,
  type AccountOverview,
  type DepositAddress,
  type ExternalWalletBinding,
  type FundingAccount,
  type FundingOrder,
  type OnchainRecord,
  type RecentFundingActivity,
  type RealTradingAccount,
  type SimulationAccountView,
} from "../../api/walletApi";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import {
  FundingSection,
  RealTradingSection,
} from "../../features/account/components/AccountBalanceSections";
import {
  InlineState,
  Toast,
} from "../../features/account/components/AccountDisplayPrimitives";
import {
  AccountModalFeedback,
  AccountModalForm,
  AccountModalInput,
  AccountModalSelect,
  AccountModalValue,
} from "../../features/account/components/AccountModalPrimitives";
import { AccountNav } from "../../features/account/components/AccountNavigation";
import { OverviewSection } from "../../features/account/components/AccountOverviewSections";
import {
  LedgerSection,
  OnchainDepositsSection,
  TradeOrdersSection,
} from "../../features/account/components/AccountRecordSections";
import { SimulationSection } from "../../features/account/components/AccountSimulationSections";
import {
  ExternalWalletBindPanel,
  WalletOverviewSection,
} from "../../features/account/components/AccountWalletSections";
import {
  formatMoney,
  isTransferPairAllowed,
  quickActionsForSection,
  readCurrentSimulationAccountId,
  readSectionFromUrl,
  writeCurrentSimulationAccountId,
} from "../../features/account/lib/accountUtils";
import {
  ensureBscTestnet,
  getMetaMaskEthereum,
  normalizeWalletError,
  readCurrentMetaMaskAddress,
  requestCurrentMetaMaskAddress,
} from "../../features/account/lib/metamask";
import {
  bscTestnetLabel,
  transferAccountOptions,
} from "../../features/account/model/constants";
import type {
  AccountSection,
  QuickAction,
  TransferAccount,
} from "../../features/account/model/types";
import { useUserStore } from "../../store/userStore";

export function AccountPage() {
  const user = useUserStore((state) => state.currentUser);
  const [wallet, setWallet] = useState<FundingAccount | null>(null);
  const [accountOverview, setAccountOverview] = useState<AccountOverview | null>(null);
  const [funding, setFunding] = useState<FundingAccount | null>(null);
  const [simulationAccount, setSimulationAccount] = useState<TradingAccount | null>(null);
  const [realTradingAccount, setRealTradingAccount] = useState<RealTradingAccount | null>(null);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [fundingOrders, setFundingOrders] = useState<FundingOrder[]>([]);
  const [recentFundingActivities, setRecentFundingActivities] = useState<RecentFundingActivity[]>([]);
  const [depositAddress, setDepositAddress] = useState<DepositAddress | null>(null);
  const [onchainRecords, setOnchainRecords] = useState<OnchainRecord[]>([]);
  const [transferFrom, setTransferFrom] = useState<TransferAccount>("wallet");
  const [transferTo, setTransferTo] = useState<TransferAccount>("funding");
  const [transferAmount, setTransferAmount] = useState(100);
  const [internalTransferRecipient, setInternalTransferRecipient] = useState("");
  const [internalTransferAmount, setInternalTransferAmount] = useState(100);
  const [withdrawAmount, setWithdrawAmount] = useState(100);
  const [withdrawNetwork] = useState("BSC_TESTNET");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [externalWalletBinding, setExternalWalletBinding] = useState<ExternalWalletBinding | null>(null);
  const [externalWalletStatus, setExternalWalletStatus] = useState("");
  const [externalWalletError, setExternalWalletError] = useState("");
  const [simulationAccounts, setSimulationAccounts] = useState<SimulationAccountView[]>([]);
  const [currentSimulationAccountId, setCurrentSimulationAccountId] = useState(() => readCurrentSimulationAccountId());
  const [simulationAccountLimit, setSimulationAccountLimit] = useState(5);
  const [canCreateSimulationAccount, setCanCreateSimulationAccount] = useState(true);
  const [isAddWalletOpen, setIsAddWalletOpen] = useState(false);
  const [isBindingExternalWallet, setIsBindingExternalWallet] = useState(false);
  const [activeSimulationResetId, setActiveSimulationResetId] = useState<string | null>(null);
  const [activeSimulationRenameId, setActiveSimulationRenameId] = useState<string | null>(null);
  const [activeSimulationDeleteId, setActiveSimulationDeleteId] = useState<string | null>(null);
  const [simulationRenameValue, setSimulationRenameValue] = useState("");
  const [isSimulationSubmitting, setIsSimulationSubmitting] = useState(false);
  const [simulationFeedback, setSimulationFeedback] = useState("");
  const [message, setMessage] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [activeAction, setActiveAction] = useState<QuickAction | null>(null);
  const [activeSection, setActiveSection] = useState<AccountSection>(() => readSectionFromUrl());
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void loadAccount();
  }, []);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timer = window.setTimeout(() => setToastMessage(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum?.isMetaMask || !ethereum.on) {
      return undefined;
    }
    const handleAccountsChanged = () => {
      setExternalWalletStatus("");
      setExternalWalletError("");
    };
    ethereum.on("accountsChanged", handleAccountsChanged);
    return () => ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setActiveSection(readSectionFromUrl());
      setActiveAction(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const asset = wallet?.asset ?? funding?.asset ?? simulationAccount?.asset ?? realTradingAccount?.asset ?? "USDT";
  const activeSimulationAccountId = simulationAccounts.some((account) => account.id === currentSimulationAccountId)
    ? currentSimulationAccountId
    : simulationAccounts[0]?.id ?? "";
  const activeSimulationAccount = simulationAccounts.find((account) => account.id === activeSimulationAccountId) ?? null;

  const loadAccount = async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      const [
        walletAccounts,
        nextOverview,
        nextRecentFundingActivities,
        nextFundingOrders,
        nextOnchainRecords,
        nextDepositAddress,
      ] = await Promise.all([
        fetchWalletAccounts(),
        fetchAccountOverview(),
        fetchRecentFundingActivities(),
        fetchFundingOrders("all", 50),
        fetchOnchainRecords(50),
        fetchDepositAddress(),
      ]);
      setWallet(walletAccounts.wallet ?? null);
      setAccountOverview(nextOverview);
      setFunding(walletAccounts.funding);
      const nextSimulationAccounts = walletAccounts.simulationAccounts ?? [];
      setSimulationAccounts(nextSimulationAccounts);
      setSimulationAccount(nextSimulationAccounts[0] ?? walletAccounts.simulation ?? walletAccounts.trading ?? null);
      setSimulationAccountLimit(walletAccounts.simulationSummary?.accountLimit ?? nextOverview.simulationAccountLimit ?? 5);
      setCanCreateSimulationAccount(walletAccounts.simulationSummary?.canCreateSimulationAccount ?? nextOverview.canCreateSimulationAccount ?? nextSimulationAccounts.length < 5);
      const nextOrders = nextSimulationAccounts.length > 0
        ? (await Promise.all(nextSimulationAccounts.map((account) => fetchOrders(account.id)))).flat()
        : [];
      setRealTradingAccount(walletAccounts.realTrading ?? null);
      setOrders(nextOrders);
      setFundingOrders(nextFundingOrders.items);
      setRecentFundingActivities(nextRecentFundingActivities);
      setOnchainRecords(nextOnchainRecords.items);
      setDepositAddress(nextDepositAddress);
      await loadExternalWalletBinding();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "资金数据加载失败，请稍后重试。");
    } finally {
      setIsLoading(false);
    }
  };

  const loadExternalWalletBinding = async () => {
    try {
      const response = await fetchExternalWalletBinding();
      setExternalWalletBinding(response.binding);
      setExternalWalletError("");
    } catch (error) {
      setExternalWalletBinding(null);
      setExternalWalletError(error instanceof Error ? error.message : "第三方钱包绑定接口待接入。");
    }
  };

  const changeSection = (section: AccountSection) => {
    setActiveSection(section);
    setActiveAction(null);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", section);
    window.history.pushState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  };

  const submitTransfer = async () => {
    setMessage("");
    if (!isTransferPairAllowed(transferFrom, transferTo)) {
      const blockedMessage = "账户划转必须经过资金账户，模拟账户资金请在模拟账户页使用重置资金。";
      setMessage(blockedMessage);
      return { ok: false, message: blockedMessage };
    }
    try {
      await transferWalletAccount(transferFrom, transferTo, transferAmount, "用户账户划转");
      await loadAccount();
      const successMessage = "账户划转已完成。";
      setMessage(successMessage);
      return { ok: true, message: successMessage };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "账户划转失败。";
      setMessage(errorMessage);
      return { ok: false, message: errorMessage };
    }
  };

  const submitInternalTransfer = async () => {
    setMessage("");
    try {
      await createInternalTransfer(
        internalTransferRecipient.trim(),
        internalTransferAmount,
        "用户内部转账",
        `internal-${Date.now()}`,
      );
      await loadAccount();
      const successMessage = "内部转账已提交并完成。";
      setMessage(successMessage);
      return { ok: true, message: successMessage };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "内部转账失败。";
      setMessage(errorMessage);
      return { ok: false, message: errorMessage };
    }
  };

  const submitWithdrawal = async () => {
    setMessage("");
    try {
      await createWithdrawalRequest(withdrawAmount, withdrawNetwork, withdrawAddress, "用户提现申请");
      await loadAccount();
      const successMessage = "提现申请已提交，等待后台审核。";
      setMessage(successMessage);
      return { ok: true, message: successMessage };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "提现申请提交失败。";
      setMessage(errorMessage);
      return { ok: false, message: errorMessage };
    }
  };

  const bindMetaMaskWallet = async () => {
    setExternalWalletStatus("");
    setExternalWalletError("");
    setIsBindingExternalWallet(true);
    try {
      const ethereum = getMetaMaskEthereum();
      setExternalWalletStatus("连接 MetaMask");
      const walletAddress = await requestCurrentMetaMaskAddress(ethereum);

      setExternalWalletStatus("检查 BSC Testnet");
      await ensureBscTestnet(ethereum);

      setExternalWalletStatus("请求签名");
      const challenge = await createExternalWalletChallenge(walletAddress);
      const signature = await ethereum.request({
        method: "personal_sign",
        params: [challenge.message, walletAddress],
      }) as string;
      const latestWalletAddress = await readCurrentMetaMaskAddress(ethereum);
      if (latestWalletAddress !== walletAddress) {
        throw new Error("MetaMask 当前地址已变化，请重新发起绑定。");
      }

      setExternalWalletStatus("提交绑定");
      const result = await bindExternalWallet(challenge.challengeId, walletAddress, signature);
      setExternalWalletBinding(result.binding);
      setIsAddWalletOpen(false);
      setMessage("第三方钱包已绑定。");
    } catch (error) {
      const errorMessage = normalizeWalletError(error);
      setExternalWalletError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setExternalWalletStatus("");
      setIsBindingExternalWallet(false);
    }
  };

  const unbindMetaMaskWallet = async () => {
    setExternalWalletStatus("");
    setExternalWalletError("");
    setIsBindingExternalWallet(true);
    try {
      await unbindExternalWallet();
      setExternalWalletBinding(null);
      setIsAddWalletOpen(false);
      setMessage("第三方钱包已解绑。");
    } catch (error) {
      const errorMessage = normalizeWalletError(error);
      setExternalWalletError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setIsBindingExternalWallet(false);
    }
  };

  const addSimulationAccount = async () => {
    setSimulationFeedback("");
    setIsSimulationSubmitting(true);
    try {
      const nextName = `模拟账户${simulationAccounts.length + 1}`;
      await createSimulationAccount(nextName);
      await loadAccount();
      const successMessage = "模拟账户已新增。";
      setSimulationFeedback(successMessage);
      setMessage(successMessage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "模拟账户创建失败。";
      setSimulationFeedback(errorMessage);
      setMessage(errorMessage);
    } finally {
      setIsSimulationSubmitting(false);
    }
  };

  const submitSimulationReset = async () => {
    if (!activeSimulationResetId) {
      return;
    }
    setSimulationFeedback("");
    setIsSimulationSubmitting(true);
    try {
      await resetSimulationAccount(activeSimulationResetId);
      await loadAccount();
      const successMessage = "模拟账户资金已重置。";
      setSimulationFeedback(successMessage);
      setMessage(successMessage);
      setActiveSimulationResetId(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "模拟账户资金重置失败。";
      setSimulationFeedback(errorMessage);
      setMessage(errorMessage);
    } finally {
      setIsSimulationSubmitting(false);
    }
  };

  const openSimulationRename = (account: SimulationAccountView) => {
    setSimulationFeedback("");
    setActiveSimulationRenameId(account.id);
    setSimulationRenameValue(account.name || "");
  };

  const submitSimulationRename = async () => {
    if (!activeSimulationRenameId) {
      return;
    }
    setSimulationFeedback("");
    setIsSimulationSubmitting(true);
    try {
      await renameSimulationAccount(activeSimulationRenameId, simulationRenameValue.trim());
      await loadAccount();
      const successMessage = "模拟账户已重命名。";
      setSimulationFeedback(successMessage);
      setMessage(successMessage);
      setActiveSimulationRenameId(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "模拟账户重命名失败。";
      setSimulationFeedback(errorMessage);
      setMessage(errorMessage);
    } finally {
      setIsSimulationSubmitting(false);
    }
  };

  const submitSimulationDelete = async () => {
    if (!activeSimulationDeleteId) {
      return;
    }
    setSimulationFeedback("");
    setIsSimulationSubmitting(true);
    try {
      await deleteSimulationAccount(activeSimulationDeleteId);
      await loadAccount();
      const successMessage = "模拟账户已删除。";
      setSimulationFeedback(successMessage);
      setMessage(successMessage);
      setActiveSimulationDeleteId(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "模拟账户删除失败。";
      setSimulationFeedback(errorMessage);
      setMessage(errorMessage);
    } finally {
      setIsSimulationSubmitting(false);
    }
  };

  const copyDepositAddress = async () => {
    if (!depositAddress?.address) {
      setToastMessage("充值地址还未加载完成。");
      return;
    }
    try {
      await navigator.clipboard.writeText(depositAddress.address);
      setToastMessage("地址已复制。");
    } catch {
      setToastMessage("复制失败，请手动复制。");
    }
  };

  const copyChainAddress = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setToastMessage("地址已复制。");
    } catch {
      setToastMessage("复制失败，请手动复制。");
    }
  };

  return (
    <div className="xh-account-workspace">
      {isLoading ? <InlineState title="资金数据同步中" /> : null}
      {loadError ? <InlineState tone="danger" title="资金数据加载失败" description={loadError} actionLabel="重新加载" onAction={() => void loadAccount()} /> : null}

      <div className="xh-account-layout">
        <aside className="xh-account-sidebar">
          <AccountNav activeSection={activeSection} onChange={changeSection} />
        </aside>

        <section className="xh-account-content">
          <QuickActionPanel
            activeSection={activeSection}
            activeAction={activeAction}
            asset={asset}
            depositAddress={depositAddress}
            funding={funding}
            internalTransferAmount={internalTransferAmount}
            internalTransferRecipient={internalTransferRecipient}
            transferAmount={transferAmount}
            transferFrom={transferFrom}
            transferTo={transferTo}
            withdrawAddress={withdrawAddress}
            withdrawAmount={withdrawAmount}
            onActionChange={setActiveAction}
            onCopyDepositAddress={() => void copyDepositAddress()}
            onInternalTransferAmountChange={setInternalTransferAmount}
            onInternalTransferRecipientChange={setInternalTransferRecipient}
            onSubmitInternalTransfer={submitInternalTransfer}
            onSubmitTransfer={submitTransfer}
            onSubmitWithdrawal={submitWithdrawal}
            onTransferAmountChange={setTransferAmount}
            onTransferFromChange={setTransferFrom}
            onTransferToChange={setTransferTo}
            onWithdrawAddressChange={setWithdrawAddress}
            onWithdrawAmountChange={setWithdrawAmount}
          />

          {message ? <p className="xh-message">{message}</p> : null}

          {activeSection === "overview" ? (
            <OverviewSection
              asset={asset}
              accountOverview={accountOverview}
              recentFundingActivities={recentFundingActivities}
              wallet={wallet}
              funding={funding}
              realTradingAccount={realTradingAccount}
              simulationAccount={activeSimulationAccount}
              onActionChange={setActiveAction}
              onSectionChange={changeSection}
              user={user}
            />
          ) : null}
          {activeSection === "wallet-overview" ? (
            <WalletOverviewSection
              asset={asset}
              depositAddress={depositAddress}
              externalWalletBinding={externalWalletBinding}
              externalWalletError={externalWalletError}
              wallet={wallet}
              onCopyDepositAddress={() => void copyDepositAddress()}
              onCopyChainAddress={(value) => void copyChainAddress(value)}
              onAddWallet={() => {
                setExternalWalletError("");
                setExternalWalletStatus("");
                setIsAddWalletOpen(true);
              }}
              onDeposit={() => setActiveAction("deposit")}
              onExchange={() => setActiveAction("exchange")}
              onTrade={() => {
                window.location.href = "/app/trading?symbol=BTCUSDT";
              }}
              onWithdraw={() => setActiveAction("withdraw")}
            />
          ) : null}
          {activeSection === "funding" ? <FundingSection asset={asset} funding={funding} /> : null}
          {activeSection === "trading" ? (
            <RealTradingSection
              account={realTradingAccount}
              asset={asset}
              onTransfer={() => {
                setTransferFrom("funding");
                setTransferTo("realTrading");
                setActiveAction("transfer");
              }}
            />
          ) : null}
          {activeSection === "simulation" ? (
            <SimulationSection
              asset={asset}
              currentAccountId={activeSimulationAccountId}
              accounts={simulationAccounts}
              accountLimit={simulationAccountLimit}
              canCreate={canCreateSimulationAccount}
              isSubmitting={isSimulationSubmitting}
              onAddAccount={() => void addSimulationAccount()}
              onDelete={(accountId) => {
                setSimulationFeedback("");
                setActiveSimulationDeleteId(accountId);
              }}
              onRename={openSimulationRename}
              onReset={(accountId) => {
                setSimulationFeedback("");
                setActiveSimulationResetId(accountId);
              }}
              onTrade={(accountId) => {
                setCurrentSimulationAccountId(accountId);
                writeCurrentSimulationAccountId(accountId);
              }}
            />
          ) : null}
          {activeSection === "ledger" ? <LedgerSection fundingOrders={fundingOrders} /> : null}
          {activeSection === "onchain-deposits" ? <OnchainDepositsSection ownAddress={depositAddress?.address} records={onchainRecords} onCopyAddress={(value) => void copyChainAddress(value)} /> : null}
          {activeSection === "trade-orders" ? <TradeOrdersSection orders={orders} /> : null}
        </section>
      </div>
      <Toast message={toastMessage} />
      <Modal open={isAddWalletOpen} title="绑定第三方钱包" onClose={() => setIsAddWalletOpen(false)}>
        <ExternalWalletBindPanel
          binding={externalWalletBinding}
          error={externalWalletError}
          isSubmitting={isBindingExternalWallet}
          status={externalWalletStatus}
          onBind={() => void bindMetaMaskWallet()}
          onUnbind={() => void unbindMetaMaskWallet()}
        />
      </Modal>
      <Modal open={activeSimulationResetId !== null} title="重置模拟账户资金" onClose={() => setActiveSimulationResetId(null)}>
        <AccountModalForm>
          <AccountModalInput label="重置后资金" value="100000 USDT" disabled />
          <Button className="xh-account-modal-submit" disabled={isSimulationSubmitting} onClick={() => void submitSimulationReset()}>
            {isSimulationSubmitting ? "处理中" : "确认重置"}
          </Button>
          {simulationFeedback ? <AccountModalFeedback>{simulationFeedback}</AccountModalFeedback> : null}
        </AccountModalForm>
      </Modal>
      <Modal open={activeSimulationRenameId !== null} title="重命名模拟账户" onClose={() => setActiveSimulationRenameId(null)}>
        <AccountModalForm>
          <AccountModalInput label="账户名称" maxLength={30} value={simulationRenameValue} onChange={(event) => setSimulationRenameValue(event.target.value)} />
          <Button className="xh-account-modal-submit" disabled={isSimulationSubmitting || !simulationRenameValue.trim()} onClick={() => void submitSimulationRename()}>
            {isSimulationSubmitting ? "处理中" : "保存名称"}
          </Button>
          {simulationFeedback ? <AccountModalFeedback>{simulationFeedback}</AccountModalFeedback> : null}
        </AccountModalForm>
      </Modal>
      <Modal open={activeSimulationDeleteId !== null} title="删除模拟账户" onClose={() => setActiveSimulationDeleteId(null)}>
        <AccountModalForm>
          <AccountModalInput label="处理方式" value="删除后不回流资金账户" disabled />
          <Button className="xh-account-modal-submit" disabled={isSimulationSubmitting} onClick={() => void submitSimulationDelete()}>
            {isSimulationSubmitting ? "处理中" : "确认删除"}
          </Button>
          {simulationFeedback ? <AccountModalFeedback>{simulationFeedback}</AccountModalFeedback> : null}
        </AccountModalForm>
      </Modal>
    </div>
  );
}

function QuickActionPanel({
  activeSection,
  activeAction,
  asset,
  depositAddress,
  funding,
  internalTransferAmount,
  internalTransferRecipient,
  transferAmount,
  transferFrom,
  transferTo,
  withdrawAddress,
  withdrawAmount,
  onActionChange,
  onCopyDepositAddress,
  onInternalTransferAmountChange,
  onInternalTransferRecipientChange,
  onSubmitInternalTransfer,
  onSubmitTransfer,
  onSubmitWithdrawal,
  onTransferAmountChange,
  onTransferFromChange,
  onTransferToChange,
  onWithdrawAddressChange,
  onWithdrawAmountChange,
}: {
  activeSection: AccountSection;
  activeAction: QuickAction | null;
  asset: string;
  depositAddress: DepositAddress | null;
  funding: FundingAccount | null;
  internalTransferAmount: number;
  internalTransferRecipient: string;
  transferAmount: number;
  transferFrom: TransferAccount;
  transferTo: TransferAccount;
  withdrawAddress: string;
  withdrawAmount: number;
  onActionChange: (action: QuickAction | null) => void;
  onCopyDepositAddress: () => void;
  onInternalTransferAmountChange: (value: number) => void;
  onInternalTransferRecipientChange: (value: string) => void;
  onSubmitInternalTransfer: () => Promise<{ ok: boolean; message: string }>;
  onSubmitTransfer: () => Promise<{ ok: boolean; message: string }>;
  onSubmitWithdrawal: () => Promise<{ ok: boolean; message: string }>;
  onTransferAmountChange: (value: number) => void;
  onTransferFromChange: (value: TransferAccount) => void;
  onTransferToChange: (value: TransferAccount) => void;
  onWithdrawAddressChange: (value: string) => void;
  onWithdrawAmountChange: (value: number) => void;
}) {
  const actions = quickActionsForSection(activeSection);
  const [transferFeedback, setTransferFeedback] = useState("");
  const [internalTransferFeedback, setInternalTransferFeedback] = useState("");
  const [withdrawFeedback, setWithdrawFeedback] = useState("");
  const showActionHeader = !["overview", "wallet-overview", "trading"].includes(activeSection);

  useEffect(() => {
    if (activeAction !== "transfer") {
      setTransferFeedback("");
    }
    if (activeAction !== "internal-transfer") {
      setInternalTransferFeedback("");
    }
    if (activeAction !== "withdraw") {
      setWithdrawFeedback("");
    }
  }, [activeAction]);

  if (actions.length === 0 || (!showActionHeader && activeAction === null)) {
    return null;
  }

  return (
    <>
      {showActionHeader ? (
        <Card>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <h2 className="xh-panel-title">快捷操作</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {actions.includes("deposit") ? (
                <Button variant={activeAction === "deposit" ? "primary" : "secondary"} onClick={() => onActionChange("deposit")}>
                  充值
                </Button>
              ) : null}
              {actions.includes("withdraw") ? (
                <Button variant={activeAction === "withdraw" ? "primary" : "secondary"} onClick={() => onActionChange("withdraw")}>
                  提现
                </Button>
              ) : null}
              {actions.includes("transfer") ? (
                <Button variant={activeAction === "transfer" ? "primary" : "secondary"} onClick={() => onActionChange("transfer")}>
                  划转
                </Button>
              ) : null}
              {actions.includes("internal-transfer") ? (
                <Button variant={activeAction === "internal-transfer" ? "primary" : "secondary"} onClick={() => onActionChange("internal-transfer")}>
                  内部转账
                </Button>
              ) : null}
              {actions.includes("trade") ? (
                <Link className="xh-action-link" to="/app/trading?symbol=BTCUSDT">
                  模拟交易
                </Link>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
      <Modal
        open={activeAction === "deposit"}
        title="充值"
        onClose={() => onActionChange(null)}
      >
        <DepositAddressPanel asset={asset} depositAddress={depositAddress} onCopyDepositAddress={onCopyDepositAddress} />
      </Modal>
      <Modal
        open={activeAction === "withdraw"}
        title="提现"
        onClose={() => onActionChange(null)}
      >
        <WithdrawalForm
          asset={asset}
          funding={funding}
          withdrawAddress={withdrawAddress}
          withdrawAmount={withdrawAmount}
          withdrawFeedback={withdrawFeedback}
          onSubmitWithdrawal={async () => {
            setWithdrawFeedback("");
            const result = await onSubmitWithdrawal();
            setWithdrawFeedback(result.message);
            if (result.ok) {
              onActionChange(null);
            }
          }}
          onWithdrawAddressChange={onWithdrawAddressChange}
          onWithdrawAmountChange={onWithdrawAmountChange}
        />
      </Modal>
      <Modal
        open={activeAction === "transfer"}
        title="账户划转"
        onClose={() => onActionChange(null)}
      >
        <TransferForm
          transferAmount={transferAmount}
          transferFrom={transferFrom}
          transferTo={transferTo}
          onSubmitTransfer={async () => {
            setTransferFeedback("");
            const result = await onSubmitTransfer();
            setTransferFeedback(result.message);
            if (result.ok) {
              onActionChange(null);
            }
          }}
          transferFeedback={transferFeedback}
          onTransferAmountChange={onTransferAmountChange}
          onTransferFromChange={onTransferFromChange}
          onTransferToChange={onTransferToChange}
        />
      </Modal>
      <Modal
        open={activeAction === "internal-transfer"}
        title="内部转账"
        onClose={() => onActionChange(null)}
      >
        <InternalTransferForm
          amount={internalTransferAmount}
          recipient={internalTransferRecipient}
          transferFeedback={internalTransferFeedback}
          onAmountChange={onInternalTransferAmountChange}
          onRecipientChange={onInternalTransferRecipientChange}
          onSubmit={async () => {
            setInternalTransferFeedback("");
            const result = await onSubmitInternalTransfer();
            setInternalTransferFeedback(result.message);
            if (result.ok) {
              onActionChange(null);
            }
          }}
        />
      </Modal>
      <Modal
        open={activeAction === "exchange"}
        title="兑换"
        onClose={() => onActionChange(null)}
      >
        <ExchangeForm />
      </Modal>
    </>
  );
}

function DepositAddressPanel({
  asset,
  depositAddress,
  onCopyDepositAddress,
}: {
  asset: string;
  depositAddress: DepositAddress | null;
  onCopyDepositAddress: () => void;
}) {
  return (
    <AccountModalForm>
      <AccountModalValue label="网络" value={bscTestnetLabel} />
      <AccountModalValue label="资产" value={asset} />
      <AccountModalValue label="钱包地址" value={depositAddress?.address ?? "充值地址加载中"} mono />
      <Button className="xh-account-modal-submit" disabled={!depositAddress?.address} onClick={onCopyDepositAddress}>
        复制地址
      </Button>
    </AccountModalForm>
  );
}

function WithdrawalForm({
  asset,
  funding,
  withdrawAddress,
  withdrawAmount,
  withdrawFeedback,
  onSubmitWithdrawal,
  onWithdrawAddressChange,
  onWithdrawAmountChange,
}: {
  asset: string;
  funding: FundingAccount | null;
  withdrawAddress: string;
  withdrawAmount: number;
  withdrawFeedback: string;
  onSubmitWithdrawal: () => void;
  onWithdrawAddressChange: (value: string) => void;
  onWithdrawAmountChange: (value: number) => void;
}) {
  return (
    <AccountModalForm>
      <AccountModalValue label="可用余额" value={formatMoney(funding?.available, asset)} />
      <AccountModalInput label="金额" type="number" min={0} value={withdrawAmount} onChange={(event) => onWithdrawAmountChange(Number(event.target.value))} />
      <AccountModalInput label="网络" value={bscTestnetLabel} disabled />
      <AccountModalInput label="提现地址" value={withdrawAddress} onChange={(event) => onWithdrawAddressChange(event.target.value)} placeholder="0x..." />
      <Button className="xh-account-modal-submit" disabled={withdrawAmount <= 0 || !withdrawAddress.trim()} onClick={onSubmitWithdrawal}>
        提交提现申请
      </Button>
      {withdrawFeedback ? <AccountModalFeedback>{withdrawFeedback}</AccountModalFeedback> : null}
    </AccountModalForm>
  );
}

function TransferForm({
  transferAmount,
  transferFrom,
  transferTo,
  transferFeedback,
  onSubmitTransfer,
  onTransferAmountChange,
  onTransferFromChange,
  onTransferToChange,
}: {
  transferAmount: number;
  transferFrom: TransferAccount;
  transferTo: TransferAccount;
  transferFeedback: string;
  onSubmitTransfer: () => void | Promise<void>;
  onTransferAmountChange: (value: number) => void;
  onTransferFromChange: (value: TransferAccount) => void;
  onTransferToChange: (value: TransferAccount) => void;
}) {
  const options = transferAccountOptions;

  const swapAccounts = () => {
    onTransferFromChange(transferTo);
    onTransferToChange(transferFrom);
  };

  return (
    <AccountModalForm>
      <div className="xh-transfer-stack">
        <AccountModalSelect label="转出账户" value={transferFrom} options={options} onChange={(event) => onTransferFromChange(event.target.value as TransferAccount)} />
        <Button type="button" className="xh-transfer-swap" variant="secondary" onClick={swapAccounts}>
          <ArrowRightLeft size={16} aria-hidden="true" />
          交换
        </Button>
        <AccountModalSelect label="转入账户" value={transferTo} options={options} onChange={(event) => onTransferToChange(event.target.value as TransferAccount)} />
      </div>
      <AccountModalInput label="金额" type="number" min={0} value={transferAmount} onChange={(event) => onTransferAmountChange(Number(event.target.value))} />
      <Button className="xh-account-modal-submit" disabled={transferAmount <= 0} onClick={onSubmitTransfer}>
        确认划转
      </Button>
      {transferFeedback ? <AccountModalFeedback>{transferFeedback}</AccountModalFeedback> : null}
    </AccountModalForm>
  );
}

function InternalTransferForm({
  amount,
  recipient,
  transferFeedback,
  onAmountChange,
  onRecipientChange,
  onSubmit,
}: {
  amount: number;
  recipient: string;
  transferFeedback: string;
  onAmountChange: (value: number) => void;
  onRecipientChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
}) {
  return (
    <AccountModalForm>
      <AccountModalInput label="收款人" value={recipient} onChange={(event) => onRecipientChange(event.target.value)} placeholder="用户 ID 或邮箱" />
      <AccountModalInput label="金额" type="number" min={0} value={amount} onChange={(event) => onAmountChange(Number(event.target.value))} />
      <Button className="xh-account-modal-submit" disabled={amount <= 0 || !recipient.trim()} onClick={onSubmit}>
        确认内部转账
      </Button>
      {transferFeedback ? <AccountModalFeedback>{transferFeedback}</AccountModalFeedback> : null}
    </AccountModalForm>
  );
}

function ExchangeForm() {
  return (
    <AccountModalForm>
      <AccountModalValue label="支付资产" value="USDT" />
      <AccountModalValue label="获得资产" value="暂未开放" />
      <AccountModalInput label="兑换金额" type="number" min={0} value={0} disabled />
      <Button className="xh-account-modal-submit" disabled>
        确认兑换
      </Button>
    </AccountModalForm>
  );
}
