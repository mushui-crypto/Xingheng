import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowRightLeft, Copy, Globe2 } from "lucide-react";
import { Link } from "react-router-dom";
import { fetchOrders, fetchTradingAccount, type OrderRecord, type TradingAccount } from "../../api/market";
import {
  createInternalTransfer,
  createWithdrawalRequest,
  fetchAccountOverview,
  fetchDepositAddress,
  fetchFundingOrders,
  fetchOnchainRecords,
  fetchRecentFundingActivities,
  fetchWalletAccounts,
  transferWalletAccount,
  type AccountOverview,
  type DepositAddress,
  type FundingAccount,
  type FundingOrder,
  type OnchainRecord,
  type RecentFundingActivity,
  type RealTradingAccount,
  type WalletAccountType,
} from "../../api/walletApi";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { DataTable, type DataTableColumn } from "../../components/ui/DataTable";
import { Input } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { useUserStore } from "../../store/userStore";
import { formatDateTime } from "../../utils/validators";

const accountSections = [
  "overview",
  "wallet-overview",
  "funding",
  "trading",
  "simulation",
  "ledger",
  "onchain-deposits",
  "trade-orders",
] as const;

type AccountSection = (typeof accountSections)[number];
type QuickAction = "deposit" | "withdraw" | "transfer" | "internal-transfer";
type TransferAccount = Extract<WalletAccountType, "wallet" | "funding" | "simulation" | "realTrading">;
type LedgerTab = "ledger" | "deposits" | "withdrawals" | "transfers";
type TradeOrderFilter = "all" | "buy" | "sell" | "filled" | "rejected";

const tokenIconSrc = "/assets/xingheng-logo@2x.png";
const bscTestnetLabel = "BNB Smart Chain Testnet";
const requiredConfirmations = 1;
const transferAccountOptions = [
  { value: "wallet", label: "钱包" },
  { value: "funding", label: "资金账户" },
  { value: "simulation", label: "模拟账户" },
  { value: "realTrading", label: "交易账户" },
];

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
  const [transferFrom, setTransferFrom] = useState<TransferAccount>("funding");
  const [transferTo, setTransferTo] = useState<TransferAccount>("simulation");
  const [transferAmount, setTransferAmount] = useState(100);
  const [internalTransferRecipient, setInternalTransferRecipient] = useState("");
  const [internalTransferAmount, setInternalTransferAmount] = useState(100);
  const [withdrawAmount, setWithdrawAmount] = useState(100);
  const [withdrawNetwork] = useState("BSC_TESTNET");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [message, setMessage] = useState("");
  const [activeAction, setActiveAction] = useState<QuickAction | null>(null);
  const [activeSection, setActiveSection] = useState<AccountSection>(() => readSectionFromUrl());
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void loadAccount();
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

  const loadAccount = async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      const [
        walletAccounts,
        nextOverview,
        nextRecentFundingActivities,
        nextOrders,
        nextFundingOrders,
        nextOnchainRecords,
        nextDepositAddress,
        fallbackTradingAccount,
      ] = await Promise.all([
        fetchWalletAccounts(),
        fetchAccountOverview(),
        fetchRecentFundingActivities(),
        fetchOrders(),
        fetchFundingOrders("all", 50),
        fetchOnchainRecords(50),
        fetchDepositAddress(),
        fetchTradingAccount(),
      ]);
      setWallet(walletAccounts.wallet ?? null);
      setAccountOverview(nextOverview);
      setFunding(walletAccounts.funding);
      setSimulationAccount(walletAccounts.simulation ?? walletAccounts.trading ?? fallbackTradingAccount);
      setRealTradingAccount(walletAccounts.realTrading ?? null);
      setOrders(nextOrders);
      setFundingOrders(nextFundingOrders.items);
      setRecentFundingActivities(nextRecentFundingActivities);
      setOnchainRecords(nextOnchainRecords.items);
      setDepositAddress(nextDepositAddress);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "资金数据加载失败，请稍后重试。");
    } finally {
      setIsLoading(false);
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
      const blockedMessage = "账户划转必须经过资金账户，暂不支持模拟账户与交易账户直接互转。";
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
      setMessage("提现申请已提交，等待后台审核。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提现申请提交失败。");
    }
  };

  const copyDepositAddress = async () => {
    if (!depositAddress?.address) {
      setMessage("充值地址还未加载完成。");
      return;
    }
    try {
      await navigator.clipboard.writeText(depositAddress.address);
      setMessage("充值地址已复制。");
    } catch {
      setMessage("浏览器未允许复制，请手动选择地址复制。");
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
          {["wallet-overview", "funding", "trading", "ledger", "onchain-deposits", "trade-orders"].includes(activeSection) ? null : (
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
              onSubmitWithdrawal={() => void submitWithdrawal()}
              onTransferAmountChange={setTransferAmount}
              onTransferFromChange={setTransferFrom}
              onTransferToChange={setTransferTo}
              onWithdrawAddressChange={setWithdrawAddress}
              onWithdrawAmountChange={setWithdrawAmount}
            />
          )}

          {message ? <p className="xh-message">{message}</p> : null}

          {activeSection === "overview" ? (
            <OverviewSection
              asset={asset}
              accountOverview={accountOverview}
              recentFundingActivities={recentFundingActivities}
              wallet={wallet}
              funding={funding}
              realTradingAccount={realTradingAccount}
              simulationAccount={simulationAccount}
              onActionChange={setActiveAction}
              user={user}
            />
          ) : null}
          {activeSection === "wallet-overview" ? (
            <WalletOverviewSection
              asset={asset}
              depositAddress={depositAddress}
              wallet={wallet}
              onCopyDepositAddress={() => void copyDepositAddress()}
            />
          ) : null}
          {activeSection === "funding" ? <FundingSection asset={asset} funding={funding} /> : null}
          {activeSection === "trading" ? <RealTradingSection account={realTradingAccount} asset={asset} /> : null}
          {activeSection === "simulation" ? <SimulationSection account={simulationAccount} asset={asset} /> : null}
          {activeSection === "ledger" ? <LedgerSection fundingOrders={fundingOrders} /> : null}
          {activeSection === "onchain-deposits" ? <OnchainDepositsSection ownAddress={depositAddress?.address} records={onchainRecords} /> : null}
          {activeSection === "trade-orders" ? <TradeOrdersSection orders={orders} /> : null}
        </section>
      </div>
    </div>
  );
}

function AccountNav({ activeSection, onChange }: { activeSection: AccountSection; onChange: (section: AccountSection) => void }) {
  return (
    <nav className="xh-account-nav">
      <SectionButton active={activeSection === "overview"} label="账户总览" onClick={() => onChange("overview")} />
      <NavGroup title="资产" />
      <SectionButton active={activeSection === "funding"} label="资金账户" level="child" onClick={() => onChange("funding")} />
      <SectionButton active={activeSection === "wallet-overview"} label="钱包总览" level="child" onClick={() => onChange("wallet-overview")} />
      <SectionButton active={activeSection === "trading"} label="交易账户" level="child" onClick={() => onChange("trading")} />
      <SectionButton active={activeSection === "simulation"} label="模拟账户" level="child" onClick={() => onChange("simulation")} />
      <NavGroup title="订单" />
      <SectionButton active={activeSection === "ledger"} label="资金流水" level="child" onClick={() => onChange("ledger")} />
      <SectionButton active={activeSection === "onchain-deposits"} label="链上充提记录" level="child" onClick={() => onChange("onchain-deposits")} />
      <SectionButton active={activeSection === "trade-orders"} label="交易订单" level="child" onClick={() => onChange("trade-orders")} />
    </nav>
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
  onSubmitWithdrawal: () => void;
  onTransferAmountChange: (value: number) => void;
  onTransferFromChange: (value: TransferAccount) => void;
  onTransferToChange: (value: TransferAccount) => void;
  onWithdrawAddressChange: (value: string) => void;
  onWithdrawAmountChange: (value: number) => void;
}) {
  const actions = quickActionsForSection(activeSection);
  const [transferFeedback, setTransferFeedback] = useState("");
  const [internalTransferFeedback, setInternalTransferFeedback] = useState("");
  const showActionHeader = activeSection !== "overview";

  useEffect(() => {
    if (activeAction !== "transfer") {
      setTransferFeedback("");
    }
    if (activeAction !== "internal-transfer") {
      setInternalTransferFeedback("");
    }
  }, [activeAction]);

  if (actions.length === 0 || (!showActionHeader && activeAction === null)) {
    return null;
  }

  return (
    <>
      {showActionHeader || activeAction === "deposit" || activeAction === "withdraw" ? (
        <Card>
          {showActionHeader ? (
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h2 className="xh-panel-title">快捷操作</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {actions.includes("deposit") ? (
                  <Button variant={activeAction === "deposit" ? "primary" : "secondary"} onClick={() => onActionChange(activeAction === "deposit" ? null : "deposit")}>
                    充值
                  </Button>
                ) : null}
                {actions.includes("withdraw") ? (
                  <Button variant={activeAction === "withdraw" ? "primary" : "secondary"} onClick={() => onActionChange(activeAction === "withdraw" ? null : "withdraw")}>
                    提现
                  </Button>
                ) : null}
                {actions.includes("transfer") ? (
                  <Button variant={activeAction === "transfer" ? "primary" : "secondary"} onClick={() => onActionChange(activeAction === "transfer" ? null : "transfer")}>
                    划转
                  </Button>
                ) : null}
                {actions.includes("internal-transfer") ? (
                  <Button variant={activeAction === "internal-transfer" ? "primary" : "secondary"} onClick={() => onActionChange(activeAction === "internal-transfer" ? null : "internal-transfer")}>
                    内部转账
                  </Button>
                ) : null}
                {actions.includes("trade") ? (
                  <Link className="xh-action-link" to="/app/trading?symbol=BTCUSDT">
                    去交易
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeAction === "deposit" ? (
            <div className={showActionHeader ? "mt-5 border-t border-line pt-5" : ""}>
              <DepositAddressPanel asset={asset} depositAddress={depositAddress} onCopyDepositAddress={onCopyDepositAddress} />
            </div>
          ) : null}
          {activeAction === "withdraw" ? (
            <div className={showActionHeader ? "mt-5 border-t border-line pt-5" : ""}>
              <WithdrawalForm
                asset={asset}
                funding={funding}
                withdrawAddress={withdrawAddress}
                withdrawAmount={withdrawAmount}
                onSubmitWithdrawal={onSubmitWithdrawal}
                onWithdrawAddressChange={onWithdrawAddressChange}
                onWithdrawAmountChange={onWithdrawAmountChange}
              />
            </div>
          ) : null}
        </Card>
      ) : null}
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
    </>
  );
}

function OverviewSection({
  asset,
  accountOverview,
  recentFundingActivities,
  wallet,
  funding,
  realTradingAccount,
  simulationAccount,
  onActionChange,
  user,
}: {
  asset: string;
  accountOverview: AccountOverview | null;
  recentFundingActivities: RecentFundingActivity[];
  wallet: FundingAccount | null;
  funding: FundingAccount | null;
  realTradingAccount: RealTradingAccount | null;
  simulationAccount: TradingAccount | null;
  onActionChange: (action: QuickAction | null) => void;
  user: ReturnType<typeof useUserStore.getState>["currentUser"];
}) {
  const estimatedTotalAsset = accountOverview?.totalEquity ?? (wallet?.available ?? 0) + (funding?.balance ?? 0) + (realTradingAccount?.balance ?? 0);
  const simulationAsset = accountOverview?.simulationTotalEquity ?? simulationAccount?.equity ?? 0;
  const recentTransactions = recentFundingActivities.map(mapRecentFundingActivity);

  return (
    <div className="xh-overview-stack">
      <Card className="xh-overview-panel">
        <SectionHeader title="账户总览" />
        <dl className="xh-overview-info-grid">
          <OverviewInfo label="用户 ID" value={user?.id || "-"} />
          <OverviewInfo label="邮箱" value={user?.email || "-"} />
          <OverviewInfo label="账号状态" value={formatUserStatus(user?.status)} />
          <OverviewInfo label="注册时间" value={user?.createdAt ? formatDateTime(user.createdAt) : "-"} />
        </dl>
      </Card>

      <AssetSummaryPanel
        title="预估总资产"
        asset={asset}
        value={estimatedTotalAsset}
        pnl={accountOverview?.accountTodayPnl ?? 0}
        actions={
          <>
            <OverviewActionButton label="充值" onClick={() => onActionChange("deposit")} />
            <OverviewActionButton label="提现" onClick={() => onActionChange("withdraw")} />
            <OverviewActionButton label="划转" onClick={() => onActionChange("transfer")} />
            <OverviewActionButton label="内部转账" onClick={() => onActionChange("internal-transfer")} />
            <Link className="xh-overview-action" to="/app/trading?symbol=BTCUSDT">
              去交易
            </Link>
          </>
        }
        infos={[
          { label: "资金账户", value: formatMoney(funding?.available ?? 0, asset) },
          { label: "钱包", value: formatMoney(accountOverview?.walletEquity ?? wallet?.available ?? 0, asset) },
          { label: "交易账户", value: realTradingAccount?.opened === false ? "暂未开通" : formatMoney(accountOverview?.realTradingEquity ?? realTradingAccount?.available ?? 0, asset) },
          { label: "冻结金额", value: formatMoney((wallet?.frozen ?? 0) + (funding?.frozen ?? 0) + (realTradingAccount?.frozen ?? 0), asset) },
          { label: "账户权益", value: formatMoney(estimatedTotalAsset, asset) },
        ]}
      />

      <AssetSummaryPanel
        title="模拟账户资产"
        asset={asset}
        value={simulationAsset}
        pnl={accountOverview?.simulationTodayPnl ?? simulationAccount?.floatingPnl ?? 0}
        infos={[
          { label: "账户 ID", value: simulationAccount?.id ?? "-" },
          { label: "余额", value: formatMoney(simulationAccount?.balance, asset) },
          { label: "已用保证金", value: formatMoney(simulationAccount?.usedMargin, asset) },
          { label: "可用保证金", value: formatMoney(simulationAccount?.freeMargin, asset) },
        ]}
      />

      <Card className="xh-overview-panel overflow-hidden">
        <SectionHeader title="近期资金记录" />
        <OverviewFundingTable rows={recentTransactions} />
      </Card>
    </div>
  );
}

function OverviewPanelHeader({ actions, title }: { actions?: ReactNode; title: string }) {
  return (
    <div className="xh-overview-panel-header">
      <SectionHeader title={title} />
      {actions ? <div className="xh-overview-actions">{actions}</div> : null}
    </div>
  );
}

type AssetSummaryInfo = {
  label: string;
  value: string;
};

function AssetSummaryPanel({
  actions,
  asset,
  changeLabel = "今日盈亏",
  className = "",
  infos,
  pnl,
  pnlText,
  title,
  value,
}: {
  actions?: ReactNode;
  asset: string;
  changeLabel?: string;
  className?: string;
  infos: AssetSummaryInfo[];
  pnl?: number;
  pnlText?: string;
  title: string;
  value: number;
}) {
  return (
    <section className={`xh-asset-summary-panel ${className}`}>
      <div className="xh-asset-summary-top">
        <div className="xh-asset-summary-main">
          <h2>{title}</h2>
          <div className="xh-asset-summary-value">
            <span className="xh-asset-summary-number">{formatNumber(value)}</span>
            <span className="xh-asset-summary-unit">{asset}</span>
          </div>
          <p className="xh-asset-summary-pnl">
            <span>{changeLabel}</span>
            <span className={getSignedToneClass(pnl ?? 0)}>{pnlText ?? formatSignedMoney(pnl ?? 0, asset)}</span>
          </p>
        </div>
        {actions ? <div className="xh-asset-summary-actions">{actions}</div> : null}
      </div>

      <div className="xh-asset-summary-info-grid">
        {infos.map((info) => (
          <FundingInfo key={info.label} label={info.label} value={info.value} />
        ))}
      </div>
    </section>
  );
}

function OverviewInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="xh-overview-info">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function OverviewActionButton({ disabled = false, label, onClick }: { disabled?: boolean; label: string; onClick?: () => void }) {
  return (
    <button className="xh-overview-action" disabled={disabled} type="button" onClick={onClick}>
      {label}
    </button>
  );
}

function OverviewAssetMetric({
  asset,
  changeLabel = "今日盈亏",
  pnl,
  pnlText,
  value,
}: {
  asset: string;
  changeLabel?: string;
  pnl?: number;
  pnlText?: string;
  value: number;
}) {
  return (
    <div className="xh-overview-metric">
      <p className="xh-overview-metric-value">{formatMoney(value, asset)}</p>
      <p className="xh-overview-pnl">
        <span>{changeLabel}</span>
        <span className={getSignedToneClass(pnl ?? 0)}>{pnlText ?? formatSignedMoney(pnl ?? 0, asset)}</span>
      </p>
    </div>
  );
}

type OverviewFundingRow = {
  id: string;
  type: string;
  amount: number;
  asset: string;
  time: number;
  status: string;
};

function OverviewFundingTable({ rows }: { rows: OverviewFundingRow[] }) {
  return (
    <div className="xh-overview-table-wrap">
      <table className="xh-overview-table">
        <thead>
          <tr>
            <th>交易类型</th>
            <th>金额</th>
            <th>资产</th>
            <th>时间</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5}>
                <EmptyState title="暂无充提交易" />
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.type}</td>
                <td className="xh-overview-table-number">{formatNumber(row.amount)}</td>
                <td className="xh-overview-table-asset">{row.asset}</td>
                <td className="xh-overview-table-time">{formatTimestamp(row.time)}</td>
                <td className={`xh-overview-status ${getOverviewStatusClass(row.status)}`}>{formatOverviewStatus(row.status)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function WalletOverviewSection({
  asset,
  depositAddress,
  wallet,
  onCopyDepositAddress,
}: {
  asset: string;
  depositAddress: DepositAddress | null;
  wallet: FundingAccount | null;
  onCopyDepositAddress: () => void;
}) {
  const [selectedWalletId, setSelectedWalletId] = useState("primary");
  const fallbackAddress = "0x7A3B2fE4C9aA0fA0A5d9b2Ca6D13F905AfB99F12";
  const walletBalance = wallet?.balance ?? 0;
  const walletAvailable = wallet?.available ?? 0;
  const walletFrozen = wallet?.frozen ?? 0;
  const walletPnl = 0;
  const walletCards: WalletOverviewCard[] = [
    {
      id: "primary",
      name: "钱包#001",
      address: depositAddress?.address ?? fallbackAddress,
      balance: walletBalance,
      change24h: walletPnl,
      onCopyAddress: depositAddress?.address ? onCopyDepositAddress : undefined,
    },
    {
      id: "demo-secondary",
      name: "钱包#002",
      address: "0x2F6C8b9A1d4E3F7A9C0b12D45e8F9012cA34B567",
      balance: 0,
      change24h: 0,
    },
    {
      id: "demo-third",
      name: "钱包#003",
      address: "0x91A4d7C20bE8F13a56cD9A02b7F4E6C8D13579B0",
      balance: 0,
      change24h: 0,
    },
  ];
  const selectedWallet = walletCards.find((wallet) => wallet.id === selectedWalletId) ?? walletCards[0];
  const assetRows = Array.from({ length: 5 }, (_, index) => ({
    id: `stlx-${index + 1}`,
    symbol: asset,
    balance: formatNumber(index === 0 ? walletBalance : 0),
  }));

  return (
    <div className="xh-wallet-overview">
      <AssetSummaryPanel
        className="xh-wallet-hero"
        title="预估总资产"
        asset={asset}
        value={walletBalance}
        pnl={walletPnl}
        infos={[
          { label: "钱包网络", value: bscTestnetLabel },
          { label: "钱包数量", value: `${walletCards.length} 个` },
          { label: "可划转", value: formatMoney(walletAvailable, asset) },
          { label: "已归集", value: formatMoney(walletFrozen, asset) },
        ]}
      />

      <div className="xh-wallet-panel">
        <div className="xh-wallet-list-pane">
          <div className="xh-wallet-pane-header">
            <h3>钱包列表</h3>
            <WalletActionButton label="管理钱包" />
          </div>
          <div className="xh-wallet-list">
            {walletCards.map((wallet) => (
              <div
                key={wallet.id}
                aria-pressed={selectedWallet.id === wallet.id}
                className={`xh-wallet-list-card ${selectedWallet.id === wallet.id ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedWalletId(wallet.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedWalletId(wallet.id);
                  }
                }}
              >
                <span className="xh-wallet-list-card-top">
                  <strong>{wallet.name}</strong>
                  <b>{formatMoney(wallet.balance, asset)}</b>
                </span>
                <span className="xh-wallet-list-card-bottom">
                  <WalletAddressLine address={wallet.address} onCopyAddress={wallet.onCopyAddress} />
                </span>
              </div>
            ))}
          </div>
          <button className="xh-wallet-add-demo" type="button">
            添加钱包
          </button>
        </div>

        <div className="xh-wallet-detail-column">
          <div className="xh-wallet-detail-pane">
            <div className="xh-wallet-detail-header">
              <div className="xh-wallet-detail-title">
                <h3>{selectedWallet.name}</h3>
                <WalletAddressLine address={selectedWallet.address} onCopyAddress={selectedWallet.onCopyAddress} />
              </div>
              <div className="xh-wallet-actions">
                <WalletActionButton label="交易" />
                <WalletActionButton label="兑换" />
                <WalletActionButton label="发送" />
                <WalletActionButton label="收款" onClick={selectedWallet.onCopyAddress} />
              </div>
            </div>

            <div className="xh-wallet-detail-balance">
              <OverviewAssetMetric value={selectedWallet.balance} asset={asset} pnl={selectedWallet.change24h} />
            </div>
          </div>

          <div className="xh-wallet-asset-pane">
            <div className="xh-wallet-tabs">
              <button className="is-active" type="button">资产</button>
              <button type="button">活动</button>
            </div>

            <div className="xh-wallet-asset-header">
              <span>币种</span>
              <span>余额</span>
              <span>操作</span>
            </div>

            <div className="xh-wallet-asset-list">
              {assetRows.map((row) => (
                <div className="xh-wallet-asset-row" key={row.id}>
                  <span className="xh-wallet-token-cell">
                    <img alt="STLX" className="xh-wallet-token-icon" src={tokenIconSrc} />
                    <span>{row.symbol}</span>
                  </span>
                  <span>{row.balance}</span>
                  <span className="xh-wallet-row-actions">
                    <button type="button">充值</button>
                    <button type="button">提现</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type WalletOverviewCard = {
  id: string;
  name: string;
  address: string;
  balance: number;
  change24h: number;
  onCopyAddress?: () => void;
};

function WalletAddressLine({ address, onCopyAddress }: { address: string; onCopyAddress?: () => void }) {
  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (onCopyAddress) {
      onCopyAddress();
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // 复制失败不影响地址展示；用户仍可手动选择完整地址。
    }
  };

  return (
    <span className="xh-wallet-address-line">
      <span className="xh-wallet-address-text" title={address}>
        {shortenWalletAddress(address)}
      </span>
      <button aria-label="复制钱包地址" className="xh-wallet-copy-icon" type="button" onClick={(event) => void handleCopy(event)}>
        <Copy size={13} strokeWidth={1.8} />
      </button>
    </span>
  );
}

type FundingAssetRow = {
  id: string;
  symbol: string;
  balance: number;
  available: number;
  frozen: number;
};

const fundingAssetRows: FundingAssetRow[] = [
  { id: "usd1", symbol: "USD1", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usde", symbol: "USDe", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usdi", symbol: "USDI", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usdl", symbol: "USDL", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usdc", symbol: "USDC", balance: 239.91, available: 239.91, frozen: 239.91 },
];

function FundingSection({ asset, funding }: { asset: string; funding: FundingAccount | null }) {
  const columns: DataTableColumn<FundingAssetRow>[] = [
    {
      key: "asset",
      header: "资产",
      render: (row) => (
        <span className="xh-funding-token-cell">
          <img alt="星衡资产图标" className="xh-funding-token-icon" src={tokenIconSrc} />
          <span>{row.symbol}</span>
        </span>
      ),
    },
    { key: "balance", header: "余额", align: "right", render: (row) => formatNumber(row.balance) },
    { key: "available", header: "可用", align: "right", render: (row) => formatNumber(row.available) },
    { key: "frozen", header: "冻结", align: "right", render: (row) => formatNumber(row.frozen) },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: () => (
        <span className="xh-funding-row-actions">
          <button type="button">充值</button>
          <button type="button">提现</button>
        </span>
      ),
    },
  ];

  return (
    <div className="xh-funding-page">
      <AssetSummaryPanel
        className="xh-funding-summary-panel"
        title="预估总资产"
        asset={asset}
        value={funding?.available ?? 0}
        pnl={0}
        actions={
          <>
            <WalletActionButton label="充值" />
            <WalletActionButton label="提现" />
            <WalletActionButton label="划转" />
          </>
        }
        infos={[
          { label: "账户 ID", value: funding?.id ?? "FUND-USR-MR2Z51C2" },
          { label: "钱包网络", value: bscTestnetLabel },
          { label: "冻结金额", value: formatMoney(funding?.frozen ?? 0, asset) },
          { label: "可用资金", value: formatMoney(funding?.available ?? 0, asset) },
        ]}
      />

      <section className="xh-funding-assets-panel">
        <h2>资产详情</h2>
        <DataTable
          className="xh-funding-assets-table"
          columns={columns}
          rows={fundingAssetRows}
          getRowKey={(row) => row.id}
          gridTemplateColumns="minmax(320px,1fr) 160px 160px 160px 160px"
          minWidth="920px"
        />
      </section>
    </div>
  );
}

function FundingInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="xh-funding-info">
      <p>{label}</p>
      <span>{value}</span>
    </div>
  );
}

function RealTradingSection({ account, asset }: { account: RealTradingAccount | null; asset: string }) {
  const isOpened = account?.opened !== false && account?.status !== "disabled";
  return (
    <div className="xh-trading-account-page">
      <AssetSummaryPanel
        className="xh-trading-summary-panel"
        title="预估总资产"
        asset={asset}
        value={isOpened ? account?.available ?? 0 : 0}
        pnl={0}
        actions={
          <>
            <WalletActionButton label="充值" />
            <WalletActionButton label="提现" />
            <WalletActionButton label="划转" />
          </>
        }
        infos={[
          { label: "账户 ID", value: account?.id ?? "REAL-USR-MR2Z51C2" },
          { label: "账户状态", value: isOpened ? "已开通" : "暂未开通" },
          { label: "余额", value: formatMoney(isOpened ? account?.balance ?? 0 : 0, asset) },
          { label: "可用余额", value: formatMoney(isOpened ? account?.available ?? 0 : 0, asset) },
        ]}
      />

      <section className="xh-trading-boundary-panel">
        <h2>当前边界</h2>
        <p>本页现在只展示交易账户账本，不混入模拟持仓、模拟订单或真实链上托管语义。</p>
        <div className="xh-trading-boundary-grid">
          <BoundaryTile title="可接收划转" description="资金账户与交易账户之间可划转。" />
          <BoundaryTile title="未接真实下单" description="真实开仓、平仓和风控接口后续接入。" />
          <BoundaryTile title="不混模拟数据" description="模拟交易只在模拟账户页面展示。" />
        </div>
      </section>
    </div>
  );
}

function BoundaryTile({ title, description }: { title: string; description: string }) {
  return (
    <div className="xh-trading-boundary-tile">
      <p>{title}</p>
      <strong>—</strong>
      <span>{description}</span>
    </div>
  );
}

function SimulationSection({ account, asset }: { account: TradingAccount | null; asset: string }) {
  const accountAsset = account?.asset ?? asset;
  const simulationAccounts = [1, 2];

  return (
    <div className="xh-simulation-page">
      <button className="xh-simulation-add-button" type="button" aria-disabled="true" title="接口待接入">
        新增模拟账户
      </button>
      {simulationAccounts.map((index) => (
        <SimulationAccountCard account={account} asset={accountAsset} index={index} key={index} />
      ))}
    </div>
  );
}

function SimulationAccountCard({ account, asset, index }: { account: TradingAccount | null; asset: string; index: number }) {
  const equity = account?.equity ?? 0;
  const balance = account?.balance ?? 1000;
  const usedMargin = account?.usedMargin ?? 0;
  const freeMargin = account?.freeMargin ?? 1000;
  const marginBase = usedMargin + freeMargin;
  const marginRatio = account && marginBase > 0 ? `${((usedMargin / marginBase) * 100).toFixed(2)}%` : "12.23%";
  const floatingPnl = account?.floatingPnl ?? 200;
  const infoRows = [
    [
      { label: "账户 ID", value: account?.id ?? "ACC-USR-MR2Z51C2" },
      { label: "账户类型", value: "模拟账户" },
      { label: "账户状态", value: "使用中" },
      { label: "保证金比例", value: marginRatio },
    ],
    [
      { label: "浮动盈亏", value: <span className={getSignedToneClass(floatingPnl)}>{formatSignedGroupedMoney(floatingPnl, asset)}</span> },
      { label: "账户余额", value: formatGroupedMoney(balance, asset) },
      { label: "已用保证金", value: formatGroupedMoney(usedMargin, asset) },
      { label: "可用保证金", value: formatGroupedMoney(freeMargin, asset) },
    ],
  ];

  return (
    <section className="xh-simulation-account-card">
      <div className="xh-simulation-card-header">
        <h2>测试账户{index}</h2>
        <div className="xh-simulation-card-actions">
          <SimulationActionButton label="重置资金" />
          <SimulationActionButton asLink label="去交易" to="/app/trading?symbol=BTCUSDT" />
          <SimulationActionButton label="更多" />
        </div>
      </div>

      <div className="xh-simulation-primary-metric">
        <p>模拟账户资产</p>
        <div>
          <strong>{formatGroupedNumber(equity)}</strong>
          <span>{asset}</span>
        </div>
      </div>

      <div className="xh-simulation-info-grid">
        {infoRows.map((row, rowIndex) => (
          <div className="xh-simulation-info-row" key={rowIndex}>
            {row.map((item) => (
              <SimulationInfo key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function SimulationActionButton({ asLink = false, label, to }: { asLink?: boolean; label: string; to?: string }) {
  if (asLink && to) {
    return (
      <Link className="xh-simulation-action-button" to={to}>
        {label}
      </Link>
    );
  }

  return (
    <button className="xh-simulation-action-button" type="button" aria-disabled="true" title="接口待接入">
      {label}
    </button>
  );
}

function SimulationInfo({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="xh-simulation-info">
      <p>{label}</p>
      <span>{value}</span>
    </div>
  );
}

function FundingOrdersTable({ emptyTitle, orders }: { emptyTitle: string; orders: FundingOrder[] }) {
  const columns: DataTableColumn<FundingOrder>[] = [
    { key: "time", header: "时间", render: (order) => formatTimestamp(order.createdAt) },
    { key: "category", header: "类别", render: (order) => formatFundingOrderType(order.orderType) },
    { key: "amount", header: "金额", render: (order) => formatNumber(order.amount), align: "right" },
    { key: "asset", header: "资产", render: (order) => order.asset, align: "center" },
    { key: "direction", header: "方向", render: (order) => formatFundingOrderDirection(order) },
    { key: "orderNo", header: "订单号", render: (order) => <MonoText value={order.relatedWithdrawalId ?? order.relatedTransferId ?? order.relatedLedgerId ?? order.id} /> },
    { key: "status", header: "状态", render: (order) => <StatusBadge status={order.displayStatus} />, align: "center" },
  ];

  return (
    <DataTable
      className="xh-record-table"
      columns={columns}
      rows={orders.slice(0, 10)}
      getRowKey={(order) => order.id}
      gridTemplateColumns="minmax(160px,1fr) 120px 120px 80px minmax(180px,1.2fr) minmax(180px,1fr) 120px"
      minWidth="940px"
      emptyState={<RecordEmptyState title={emptyTitle} />}
    />
  );
}

function LedgerSection({ fundingOrders }: { fundingOrders: FundingOrder[] }) {
  const [activeTab, setActiveTab] = useState<LedgerTab>("ledger");
  const visibleOrders = activeTab === "deposits"
    ? fundingOrders.filter((order) => order.orderType === "deposit")
    : activeTab === "withdrawals"
      ? fundingOrders.filter((order) => order.orderType === "withdrawal" || order.orderType === "internal_transfer")
      : activeTab === "transfers"
        ? fundingOrders.filter((order) => order.orderType === "account_transfer")
        : fundingOrders;
  const emptyTitle = activeTab === "deposits"
    ? "暂无充值记录"
    : activeTab === "withdrawals"
      ? "暂无提现记录"
      : activeTab === "transfers"
        ? "暂无划转记录"
        : "暂无资金流水";

  return (
    <RecordPanel
      className="xh-record-panel-ledger"
      title="资金流水"
      filters={
        <>
          <LedgerTabButton active={activeTab === "ledger"} label="总览" onClick={() => setActiveTab("ledger")} />
          <LedgerTabButton active={activeTab === "deposits"} label="充值" onClick={() => setActiveTab("deposits")} />
          <LedgerTabButton active={activeTab === "withdrawals"} label="提现" onClick={() => setActiveTab("withdrawals")} />
          <LedgerTabButton active={activeTab === "transfers"} label="划转" onClick={() => setActiveTab("transfers")} />
        </>
      }
    >
      <FundingOrdersTable emptyTitle={emptyTitle} orders={visibleOrders} />
    </RecordPanel>
  );
}

function OnchainDepositsSection({ ownAddress, records }: { ownAddress?: string | null; records: OnchainRecord[] }) {
  const columns: DataTableColumn<OnchainRecord>[] = [
    { key: "time", header: "时间", render: (row) => formatTimestamp(row.createdAt) },
    { key: "type", header: "类型", render: (row) => formatOnchainRecordType(row.type), align: "center" },
    { key: "amount", header: "金额", render: (row) => formatNumber(row.amount), align: "right" },
    { key: "asset", header: "资产", render: (row) => row.asset, align: "center" },
    { key: "network", header: "网络", render: (row) => formatNetwork(row.network) },
    { key: "to", header: "转入地址", render: (row) => <ChainAddress value={row.toAddress} ownAddress={ownAddress} /> },
    { key: "from", header: "转出地址", render: (row) => <ChainAddress value={row.fromAddress} ownAddress={ownAddress} /> },
    { key: "tx", header: "交易哈希", render: (row) => renderTxLink(row.txHash) },
    { key: "status", header: "状态", render: (row) => <OnchainStatusBadge type={row.type} status={row.chainStatus} />, align: "center" },
  ];

  return (
    <RecordPanel className="xh-record-panel-onchain" title="链上充提记录">
      <DataTable
        className="xh-record-table"
        columns={columns}
        rows={records.slice(0, 10)}
        getRowKey={(row) => row.id}
        gridTemplateColumns="minmax(160px,1fr) 80px 120px 80px minmax(160px,0.9fr) minmax(210px,1.1fr) minmax(210px,1.1fr) minmax(170px,1fr) 120px"
        minWidth="1260px"
        emptyState={<RecordEmptyState title="暂无链上充提记录" />}
      />
    </RecordPanel>
  );
}

function TradeOrdersSection({ orders }: { orders: OrderRecord[] }) {
  const [activeFilter, setActiveFilter] = useState<TradeOrderFilter>("all");
  const filteredOrders = orders.filter((order) => {
    if (activeFilter === "all") {
      return true;
    }
    if (activeFilter === "buy" || activeFilter === "sell") {
      return order.side === activeFilter;
    }
    return order.status === activeFilter;
  });
  const columns: DataTableColumn<OrderRecord>[] = [
    { key: "time", header: "时间", render: (order) => formatTimestamp(order.createdAt) },
    { key: "symbol", header: "品种", render: (order) => order.symbol },
    { key: "side", header: "方向", render: (order) => formatTradeSide(order.side), align: "center" },
    { key: "action", header: "动作", render: (order) => (order.action === "open" ? "开仓" : "平仓"), align: "center" },
    { key: "volume", header: "数量", render: (order) => order.volume.toString(), align: "right" },
    { key: "price", header: "成交价", render: (order) => order.price?.toFixed(5) ?? "-", align: "right" },
    { key: "status", header: "状态", render: (order) => formatOrderStatus(order.status), align: "center" },
    { key: "reason", header: "说明", render: (order) => order.reason ?? "-" },
  ];

  return (
    <RecordPanel
      className="xh-record-panel-orders"
      title="交易订单"
      filters={
        <>
          <RecordFilterButton active={activeFilter === "all"} label="全部" onClick={() => setActiveFilter("all")} />
          <RecordFilterButton active={activeFilter === "buy"} label="买入" onClick={() => setActiveFilter("buy")} />
          <RecordFilterButton active={activeFilter === "sell"} label="卖出" onClick={() => setActiveFilter("sell")} />
          <RecordFilterButton active={activeFilter === "filled"} label="已成交" onClick={() => setActiveFilter("filled")} />
          <RecordFilterButton active={activeFilter === "rejected"} label="已拒绝" onClick={() => setActiveFilter("rejected")} />
        </>
      }
    >
      <DataTable
        className="xh-record-table"
        columns={columns}
        rows={filteredOrders.slice(0, 10)}
        getRowKey={(order) => order.id}
        gridTemplateColumns="170px 110px 90px 90px 100px 130px 100px minmax(180px,1fr)"
        minWidth="970px"
        emptyState={<RecordEmptyState title="暂无订单记录" />}
      />
    </RecordPanel>
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
    <div>
      <SectionHeader title="测试网充值地址" />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <FlowStep title="收款地址" description="专属地址" />
        <FlowStep title="链上确认" description={`${requiredConfirmations} 次`} />
        <FlowStep title="资金入账" description="USDT" />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <ChainInfo label="网络" value={bscTestnetLabel} />
        <ChainInfo label="前台资产" value={asset} />
        <ChainInfo label="确认要求" value={`${requiredConfirmations} 次区块确认`} />
      </div>
      <div className="mt-4 border border-white/10 bg-white/[0.03] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-dim">Deposit address</p>
        <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="break-all font-mono text-sm text-white">{depositAddress?.address ?? "充值地址加载中"}</p>
          <Button className="md:shrink-0" variant="secondary" disabled={!depositAddress?.address} onClick={onCopyDepositAddress}>
            复制地址
          </Button>
        </div>
      </div>
      <div className="mt-3 border border-white/10 bg-black/30 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-dim">Token contract</p>
        <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="break-all font-mono text-sm text-muted">{depositAddress?.tokenAddress ?? "合约地址加载中"}</p>
          {depositAddress?.tokenAddress ? (
            <span className="text-xs text-muted">{depositAddress.tokenSymbol ?? asset} · {depositAddress.tokenDecimals ?? 18} 位精度</span>
          ) : null}
        </div>
      </div>
      <div className="mt-3 border border-amber-400/25 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
        只向该地址充值 BNB Smart Chain Testnet 上的测试代币。充值到其他网络或其他代币，星衡不会自动入账。
      </div>
    </div>
  );
}

function WithdrawalForm({
  asset,
  funding,
  withdrawAddress,
  withdrawAmount,
  onSubmitWithdrawal,
  onWithdrawAddressChange,
  onWithdrawAmountChange,
}: {
  asset: string;
  funding: FundingAccount | null;
  withdrawAddress: string;
  withdrawAmount: number;
  onSubmitWithdrawal: () => void;
  onWithdrawAddressChange: (value: string) => void;
  onWithdrawAmountChange: (value: number) => void;
}) {
  return (
    <div>
      <SectionHeader title="提交提现申请" />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <ChainInfo label="可用余额" value={formatMoney(funding?.available, asset)} />
        <ChainInfo label="冻结规则" value="失败或拒绝后释放冻结" />
        <ChainInfo label="网络" value={bscTestnetLabel} />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <Input label="金额" type="number" min={0} value={withdrawAmount} onChange={(event) => onWithdrawAmountChange(Number(event.target.value))} />
        <Input label="网络" value={bscTestnetLabel} disabled />
        <Input label="提现地址" value={withdrawAddress} onChange={(event) => onWithdrawAddressChange(event.target.value)} placeholder="0x..." />
      </div>
      <Button className="mt-4" disabled={withdrawAmount <= 0 || !withdrawAddress.trim()} onClick={onSubmitWithdrawal}>
        提交提现申请
      </Button>
    </div>
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
    <div className="space-y-5">
      <div className="grid gap-3">
        <Select label="转出账户" value={transferFrom} options={options} onChange={(event) => onTransferFromChange(event.target.value as TransferAccount)} />
        <Button type="button" className="h-[42px] w-full" variant="secondary" onClick={swapAccounts}>
          <ArrowRightLeft size={16} aria-hidden="true" />
          交换
        </Button>
        <Select label="转入账户" value={transferTo} options={options} onChange={(event) => onTransferToChange(event.target.value as TransferAccount)} />
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <Input label="金额" type="number" min={0} value={transferAmount} onChange={(event) => onTransferAmountChange(Number(event.target.value))} />
        <Button className="h-[46px]" disabled={transferAmount <= 0} onClick={onSubmitTransfer}>
          确认划转
        </Button>
      </div>
      <p className="border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-muted">资金账户中转</p>
      {transferFeedback ? <p className="border border-white/15 bg-white/[0.035] p-3 text-sm leading-6 text-slate-200">{transferFeedback}</p> : null}
    </div>
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
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Input label="收款人" value={recipient} onChange={(event) => onRecipientChange(event.target.value)} placeholder="用户 ID 或邮箱" />
        <Input label="金额" type="number" min={0} value={amount} onChange={(event) => onAmountChange(Number(event.target.value))} />
      </div>
      <Button className="h-[46px]" disabled={amount <= 0 || !recipient.trim()} onClick={onSubmit}>
        确认内部转账
      </Button>
      {transferFeedback ? <p className="border border-white/15 bg-white/[0.035] p-3 text-sm leading-6 text-slate-200">{transferFeedback}</p> : null}
    </div>
  );
}

function WalletNetworkLabel() {
  return (
    <div className="xh-wallet-network">
      <p>钱包网络</p>
      <span>{bscTestnetLabel}</span>
    </div>
  );
}

function WalletActionButton({ disabled = false, icon, label, onClick }: { disabled?: boolean; icon?: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button className="xh-wallet-action" disabled={disabled} type="button" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function NavGroup({ title }: { title: string }) {
  return <div className="xh-account-nav-group">{title}</div>;
}

function LedgerTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <RecordFilterButton active={active} label={label} onClick={onClick} />;
}

function RecordFilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`xh-record-filter ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function RecordPanel({
  children,
  className = "",
  filters,
  title,
}: {
  children: ReactNode;
  className?: string;
  filters?: ReactNode;
  title: string;
}) {
  return (
    <section className={`xh-record-panel ${className}`}>
      <h2>{title}</h2>
      {filters ? <div className="xh-record-filters">{filters}</div> : null}
      {children}
    </section>
  );
}

function SectionButton({ active, label, level = "root", onClick }: { active: boolean; label: string; level?: "root" | "child"; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={`xh-account-nav-button ${active ? "is-active" : ""} ${level === "child" ? "is-child" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="xh-panel-title">{title}</h2>
      {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 break-all font-medium text-white">{value}</dd>
    </div>
  );
}

function InfoTile({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border border-white/10 bg-white/[0.025] p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-2 break-all text-sm font-medium text-white ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function TokenSummary({ asset, description }: { asset: string; description?: string }) {
  return (
    <div className="flex items-center gap-3 border border-white/10 bg-white/[0.03] px-4 py-3">
      <img src={tokenIconSrc} alt={`${asset} token icon`} className="h-10 w-10 object-contain" />
      <div>
        <p className="text-sm font-medium text-white">{asset}</p>
        {description ? <p className="text-xs leading-5 text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

function ChainInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 bg-white/[0.025] p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-white">{value}</p>
    </div>
  );
}

function RecordHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold tracking-[-0.01em] text-white">{title}</h2>
      {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mx-auto max-w-md border border-white/10 bg-white/[0.025] p-5 text-center">
      <p className="font-medium text-white">{title}</p>
      {description ? <p className="mt-2 text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

function RecordEmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="xh-record-empty-content">
      <p>{title}</p>
      {description ? <span>{description}</span> : null}
    </div>
  );
}

function InlineState({
  title,
  description,
  tone = "neutral",
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  tone?: "neutral" | "danger";
  actionLabel?: string;
  onAction?: () => void;
}) {
  const toneClass = tone === "danger" ? "border-red-400/40 bg-red-500/10 text-red-100" : "border-white/15 bg-white/[0.03] text-slate-200";
  return (
    <div className={`flex flex-col gap-3 border p-4 md:flex-row md:items-center md:justify-between ${toneClass}`}>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <Button className="md:shrink-0" variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function FlowStep({ title, description }: { title: string; description: string }) {
  return (
    <div className="border border-white/10 bg-white/[0.025] p-3">
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
    </div>
  );
}

function Metric({ label, value, currency }: { label: string; value?: number; currency: string }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-2xl font-semibold md:text-3xl">
        {formatNumber(value)} <span className="text-sm text-muted">{currency}</span>
      </p>
    </Card>
  );
}

function formatMoney(value: number | undefined | null, asset: string) {
  return `${formatNumber(value)} ${asset}`;
}

function formatSignedMoney(value: number, asset: string) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${Math.abs(value).toFixed(2)} ${asset}`;
}

function formatNumber(value: number | undefined | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

function formatGroupedMoney(value: number | undefined | null, asset: string) {
  return `${formatGroupedNumber(value)} ${asset}`;
}

function formatSignedGroupedMoney(value: number, asset: string) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${formatGroupedNumber(Math.abs(value))} ${asset}`;
}

function formatGroupedNumber(value: number | undefined | null) {
  return typeof value === "number"
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "-";
}

function getSignedToneClass(value: number) {
  if (value > 0) {
    return "text-emerald-400";
  }
  if (value < 0) {
    return "text-red-400";
  }
  return "text-muted";
}

function getOverviewStatusClass(status: string) {
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

function formatOverviewStatus(status: string) {
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

function mapRecentFundingActivity(activity: RecentFundingActivity): OverviewFundingRow {
  return {
    id: activity.id,
    type: activity.title,
    amount: activity.amount,
    asset: activity.asset,
    time: activity.createdAt,
    status: activity.status,
  };
}

function isTransferPairAllowed(from: TransferAccount, to: TransferAccount) {
  if (from === to) {
    return false;
  }
  if (from === "wallet" || to === "wallet") {
    return from === "wallet" && to === "funding";
  }
  return from === "funding" || to === "funding";
}

function formatTimestamp(value?: number | null) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("zh-CN");
}

function formatWalletAccountLabel(type: WalletAccountType) {
  const labels: Record<WalletAccountType, string> = {
    wallet: "钱包",
    funding: "资金账户",
    simulation: "模拟账户",
    realTrading: "交易账户",
    trading: "模拟账户(兼容)",
  };
  return labels[type];
}

function formatFundingOrderType(type: FundingOrder["orderType"]) {
  const labels: Record<FundingOrder["orderType"], string> = {
    deposit: "充值",
    withdrawal: "提现",
    account_transfer: "划转",
    internal_transfer: "内部转账",
  };
  return labels[type];
}

function formatFundingOrderDirection(order: FundingOrder) {
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

function formatOnchainRecordType(type: OnchainRecord["type"]) {
  return type === "deposit" ? "充值" : "提现";
}

function MonoText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return (
    <span className="break-all font-mono text-xs text-muted" title={value}>
      {shortenHash(value)}
    </span>
  );
}

function ChainAddress({ value, ownAddress }: { value?: string | null; ownAddress?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  const isOwnAddress = ownAddress ? value.toLowerCase() === ownAddress.toLowerCase() : false;
  const copyAddress = async () => {
    await navigator.clipboard.writeText(value);
  };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${isOwnAddress ? "text-emerald-300" : "text-muted"}`}>
      <span className="font-mono text-xs" title={value}>{shortenChainAddress(value)}</span>
      <a
        aria-label="查看地址链上数据"
        className="inline-flex text-white/80 transition hover:text-white"
        href={`https://testnet.bscscan.com/address/${value}`}
        target="_blank"
        rel="noreferrer"
      >
        <Globe2 size={13} />
      </a>
      <button aria-label="复制地址" className="inline-flex text-white/80 transition hover:text-white" type="button" onClick={() => void copyAddress()}>
        <Copy size={13} />
      </button>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "completed" || status === "confirmed"
      ? "success"
      : status === "cancelled" || status === "rejected" || status === "failed" || status === "reversed"
        ? "danger"
        : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

function OnchainStatusBadge({ type, status }: { type: OnchainRecord["type"]; status: string }) {
  if (type === "deposit" && status === "confirmed") {
    return <Badge tone="success">钱包到账</Badge>;
  }
  return <StatusBadge status={status} />;
}

function formatStatus(status: string) {
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

function AddressText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="break-all font-mono text-xs text-muted">{value}</span>;
}

function formatConfirmations(value: number) {
  return `${value} / ${requiredConfirmations}`;
}

function formatNetwork(value?: string | null) {
  return value === "BSC_TESTNET" ? bscTestnetLabel : value ?? "-";
}

function formatTradeSide(value: OrderRecord["side"]) {
  return value === "buy" ? "买入" : "卖出";
}

function formatOrderStatus(value: OrderRecord["status"]) {
  return value === "filled" ? "已成交" : "已拒绝";
}

function formatUserStatus(value?: string) {
  if (value === "active") {
    return "正常";
  }
  if (value === "disabled") {
    return "已禁用";
  }
  return "-";
}

function renderTxLink(txHash?: string | null) {
  if (!txHash) {
    return "-";
  }
  return (
    <a
      className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs text-muted transition hover:text-white"
      href={`https://testnet.bscscan.com/tx/${txHash}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`在 BscScan Testnet 查看交易 ${txHash}`}
    >
      <span>{shortenHash(txHash)}</span>
      <Globe2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
    </a>
  );
}

function shortenHash(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function shortenChainAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function shortenWalletAddress(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function quickActionsForSection(section: AccountSection): Array<QuickAction | "trade"> {
  const actions: Record<AccountSection, Array<QuickAction | "trade">> = {
    overview: ["deposit", "withdraw", "transfer", "internal-transfer", "trade"],
    "wallet-overview": ["deposit", "withdraw", "transfer", "internal-transfer"],
    funding: ["deposit", "withdraw", "transfer", "internal-transfer"],
    trading: ["transfer"],
    simulation: [],
    ledger: ["transfer", "internal-transfer"],
    "onchain-deposits": ["deposit"],
    "trade-orders": ["trade"],
  };
  return actions[section];
}

function readSectionFromUrl(): AccountSection {
  const section = new URLSearchParams(window.location.search).get("section");
  if (section === "withdrawals" || section === "deposits") {
    return "ledger";
  }
  return isAccountSection(section) ? section : "overview";
}

function isAccountSection(value: string | null): value is AccountSection {
  return accountSections.includes(value as AccountSection);
}
