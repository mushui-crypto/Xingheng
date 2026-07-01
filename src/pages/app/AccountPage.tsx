import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchOrders, fetchPositions, fetchTradingAccount, type OrderRecord, type PositionView, type TradingAccount } from "../../api/market";
import {
  createInternalTransfer,
  createWithdrawalRequest,
  fetchDepositAddress,
  fetchOnchainDeposits,
  fetchWalletAccounts,
  fetchWalletLedger,
  fetchWalletTransfers,
  fetchWithdrawalRequests,
  transferWalletAccount,
  type AccountTransferRecord,
  type DepositAddress,
  type FundingAccount,
  type FundingLedgerEntry,
  type OnchainDeposit,
  type WalletAccountType,
  type WithdrawalRequest,
} from "../../api/walletApi";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
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
  "withdrawals",
  "deposits",
  "ledger",
  "onchain-deposits",
  "trade-orders",
] as const;

type AccountSection = (typeof accountSections)[number];
type QuickAction = "deposit" | "withdraw" | "transfer" | "internal-transfer";
type TransferAccount = Extract<WalletAccountType, "funding" | "simulation" | "realTrading">;

const tokenIconSrc = "/assets/xingheng-logo@2x.png";
const bscTestnetLabel = "BNB Smart Chain Testnet";
const requiredConfirmations = 1;
const transferAccountOptions = [
  { value: "funding", label: "资金账户" },
  { value: "simulation", label: "模拟账户" },
  { value: "realTrading", label: "交易账户" },
];

export function AccountPage() {
  const user = useUserStore((state) => state.currentUser);
  const [funding, setFunding] = useState<FundingAccount | null>(null);
  const [simulationAccount, setSimulationAccount] = useState<TradingAccount | null>(null);
  const [realTradingAccount, setRealTradingAccount] = useState<FundingAccount | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [ledger, setLedger] = useState<FundingLedgerEntry[]>([]);
  const [transfers, setTransfers] = useState<AccountTransferRecord[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [depositAddress, setDepositAddress] = useState<DepositAddress | null>(null);
  const [deposits, setDeposits] = useState<OnchainDeposit[]>([]);
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

  const asset = funding?.asset ?? simulationAccount?.asset ?? realTradingAccount?.asset ?? "USDT";
  const depositOrders = useMemo(() => deposits.filter((deposit) => deposit.status === "confirmed"), [deposits]);

  const loadAccount = async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      const [walletAccounts, nextPositions, nextOrders, nextLedger, nextTransfers, nextWithdrawals, nextDepositAddress, nextDeposits, fallbackTradingAccount] = await Promise.all([
        fetchWalletAccounts(),
        fetchPositions(),
        fetchOrders(),
        fetchWalletLedger(),
        fetchWalletTransfers(),
        fetchWithdrawalRequests(),
        fetchDepositAddress(),
        fetchOnchainDeposits(),
        fetchTradingAccount(),
      ]);
      setFunding(walletAccounts.funding);
      setSimulationAccount(walletAccounts.simulation ?? walletAccounts.trading ?? fallbackTradingAccount);
      setRealTradingAccount(walletAccounts.realTrading ?? null);
      setPositions(nextPositions);
      setOrders(nextOrders);
      setLedger(nextLedger);
      setTransfers(nextTransfers);
      setWithdrawals(nextWithdrawals);
      setDepositAddress(nextDepositAddress);
      setDeposits(nextDeposits);
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
      await createWithdrawalRequest(withdrawAmount, withdrawNetwork, withdrawAddress, "用户出金申请");
      await loadAccount();
      setMessage("出金申请已提交，等待后台审核。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "出金申请提交失败。");
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
    <div className="xh-page">
      <section className="border border-white/15 bg-black p-5 md:p-7">
        <p className="xh-kicker">Account operations</p>
        <h1 className="mt-3 xh-title">资金控制台</h1>
        <p className="xh-subtitle">
          账户总览、资产账户、订单记录和充值 / 出金 / 划转入口统一归集在此页面。当前钱包网络为 {bscTestnetLabel}。
        </p>
      </section>

      {isLoading ? <InlineState title="正在加载资金数据" description="正在同步资金账户、充值地址、链上记录和出金状态。" /> : null}
      {loadError ? <InlineState tone="danger" title="资金数据加载失败" description={loadError} actionLabel="重新加载" onAction={() => void loadAccount()} /> : null}

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <AccountNav activeSection={activeSection} onChange={changeSection} />
          <div className="mt-3 hidden border border-white/15 bg-white/[0.03] p-4 text-xs leading-5 text-muted lg:block">
            账户页侧边导航只在本页内切换内容；顶部主导航负责跨页面跳转。
          </div>
        </aside>

        <main className="min-w-0 space-y-5">
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

          {message ? <p className="xh-message">{message}</p> : null}

          {activeSection === "overview" ? (
            <OverviewSection
              asset={asset}
              deposits={deposits}
              funding={funding}
              orders={orders}
              positions={positions}
              realTradingAccount={realTradingAccount}
              simulationAccount={simulationAccount}
              user={user}
              withdrawals={withdrawals}
            />
          ) : null}
          {activeSection === "wallet-overview" ? <WalletOverviewSection asset={asset} depositAddress={depositAddress} deposits={deposits} funding={funding} withdrawals={withdrawals} /> : null}
          {activeSection === "funding" ? <FundingSection asset={asset} depositAddress={depositAddress} funding={funding} /> : null}
          {activeSection === "trading" ? <RealTradingSection account={realTradingAccount} asset={asset} /> : null}
          {activeSection === "simulation" ? <SimulationSection account={simulationAccount} asset={asset} orders={orders} positions={positions} /> : null}
          {activeSection === "withdrawals" ? <WithdrawalsSection asset={asset} funding={funding} withdrawals={withdrawals} /> : null}
          {activeSection === "deposits" ? <DepositOrdersSection deposits={depositOrders} /> : null}
          {activeSection === "ledger" ? <LedgerSection ledger={ledger} transfers={transfers} /> : null}
          {activeSection === "onchain-deposits" ? <OnchainDepositsSection deposits={deposits} /> : null}
          {activeSection === "trade-orders" ? <TradeOrdersSection orders={orders} /> : null}
        </main>
      </div>
    </div>
  );
}

function AccountNav({ activeSection, onChange }: { activeSection: AccountSection; onChange: (section: AccountSection) => void }) {
  return (
    <nav className="no-scrollbar flex gap-2 overflow-x-auto border border-white/15 bg-black p-2 lg:flex-col lg:overflow-visible">
      <SectionButton active={activeSection === "overview"} label="账户总览" onClick={() => onChange("overview")} />
      <NavGroup title="资产" />
      <SectionButton active={activeSection === "wallet-overview"} label="钱包总览" level="child" onClick={() => onChange("wallet-overview")} />
      <SectionButton active={activeSection === "funding"} label="资金账户" level="child" onClick={() => onChange("funding")} />
      <SectionButton active={activeSection === "trading"} label="交易账户" level="child" onClick={() => onChange("trading")} />
      <SectionButton active={activeSection === "simulation"} label="模拟账户" level="child" onClick={() => onChange("simulation")} />
      <NavGroup title="订单" />
      <SectionButton active={activeSection === "withdrawals"} label="出金订单" level="child" onClick={() => onChange("withdrawals")} />
      <SectionButton active={activeSection === "deposits"} label="入金订单" level="child" onClick={() => onChange("deposits")} />
      <SectionButton active={activeSection === "ledger"} label="资金流水" level="child" onClick={() => onChange("ledger")} />
      <SectionButton active={activeSection === "onchain-deposits"} label="链上充值记录" level="child" onClick={() => onChange("onchain-deposits")} />
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

  useEffect(() => {
    if (activeAction !== "transfer") {
      setTransferFeedback("");
    }
    if (activeAction !== "internal-transfer") {
      setInternalTransferFeedback("");
    }
  }, [activeAction]);

  if (actions.length === 0) {
    return null;
  }

  return (
    <Card>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h2 className="xh-panel-title">快捷操作</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            子页面只保留统一入口；点击后展开对应操作，避免把充值、出金和划转表单重复铺满每个页面。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.includes("deposit") ? (
            <Button variant={activeAction === "deposit" ? "primary" : "secondary"} onClick={() => onActionChange(activeAction === "deposit" ? null : "deposit")}>
              充值
            </Button>
          ) : null}
          {actions.includes("withdraw") ? (
            <Button variant={activeAction === "withdraw" ? "primary" : "secondary"} onClick={() => onActionChange(activeAction === "withdraw" ? null : "withdraw")}>
              出金
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

      {activeAction === "deposit" ? (
        <div className="mt-5 border-t border-line pt-5">
          <DepositAddressPanel asset={asset} depositAddress={depositAddress} onCopyDepositAddress={onCopyDepositAddress} />
        </div>
      ) : null}
      {activeAction === "withdraw" ? (
        <div className="mt-5 border-t border-line pt-5">
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
      <Modal
        open={activeAction === "transfer"}
        title="账户划转"
        description="划转 = 同一用户在资金账户、交易账户、模拟账户之间调拨余额。当前必须经过资金账户中转。"
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
        description="内部转账 = 当前用户把资金账户余额转给另一位平台用户的资金账户。可用 recipient 填用户 ID 或邮箱。"
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
    </Card>
  );
}

function OverviewSection({
  asset,
  deposits,
  funding,
  orders,
  positions,
  realTradingAccount,
  simulationAccount,
  user,
  withdrawals,
}: {
  asset: string;
  deposits: OnchainDeposit[];
  funding: FundingAccount | null;
  orders: OrderRecord[];
  positions: PositionView[];
  realTradingAccount: FundingAccount | null;
  simulationAccount: TradingAccount | null;
  user: ReturnType<typeof useUserStore.getState>["currentUser"];
  withdrawals: WithdrawalRequest[];
}) {
  const pendingWithdrawals = withdrawals.filter((item) => item.status !== "confirmed" && item.status !== "rejected" && item.status !== "failed").length;
  const confirmingDeposits = deposits.filter((item) => item.status === "detected" || item.status === "confirming").length;

  return (
    <div className="space-y-5">
      <Card>
        <SectionHeader title="账户总览" description="这里展示身份、权限和最近状态，不承载完整资产明细或订单表单。" />
        <dl className="mt-5 grid gap-5 md:grid-cols-2">
          <Info label="用户 ID" value={user?.id || "-"} />
          <Info label="邮箱" value={user?.email || "-"} />
          <Info label="昵称" value={user?.nickname || "未设置"} />
          <Info label="账号状态" value={formatUserStatus(user?.status)} />
          <Info label="注册时间" value={user?.createdAt ? formatDateTime(user.createdAt) : "-"} />
        </dl>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="资金账户可用" value={funding?.available} currency={asset} />
        <Metric label="资金冻结" value={funding?.frozen} currency={asset} />
        <Metric label="交易账户可用" value={realTradingAccount?.available} currency={asset} />
        <Metric label="模拟账户权益" value={simulationAccount?.equity} currency={asset} />
      </div>

      <Card>
        <SectionHeader title="待处理事项" description="只展示需要关注的状态入口，详细记录请进入对应订单子页面。" />
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <FlowStep title="出金处理中" description={`${pendingWithdrawals} 笔待审核、广播中或待链上确认的出金订单。`} />
          <FlowStep title="充值确认中" description={`${confirmingDeposits} 笔链上充值仍在等待确认或入账。`} />
          <FlowStep title="模拟交易活动" description={`${positions.length} 笔持仓，${orders.length} 条订单记录。`} />
        </div>
      </Card>
    </div>
  );
}

function WalletOverviewSection({
  asset,
  depositAddress,
  deposits,
  funding,
  withdrawals,
}: {
  asset: string;
  depositAddress: DepositAddress | null;
  deposits: OnchainDeposit[];
  funding: FundingAccount | null;
  withdrawals: WithdrawalRequest[];
}) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionHeader title="钱包总览" description="钱包总览是资金模块的汇总页，只放网络、资产、地址和近期链上状态。" />
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <TokenSummary asset={asset} description="当前账户资产固定为 USDT，测试币图标复用星衡 Logo。" />
          <ChainInfo label="钱包网络" value={bscTestnetLabel} />
          <ChainInfo label="充值地址状态" value={depositAddress?.address ? "已分配专属地址" : "地址加载中"} />
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="资金余额" value={funding?.balance} currency={asset} />
        <Metric label="冻结金额" value={funding?.frozen} currency={asset} />
        <Metric label="资金可用" value={funding?.available} currency={asset} />
      </div>

      <Card>
        <SectionHeader title="最近链上状态" description="展示最近充值和出金进度，完整记录请进入订单分组。" />
        <div className="mt-5 grid gap-3 xl:grid-cols-2">
          <RecentDepositList deposits={deposits} />
          <RecentWithdrawalList withdrawals={withdrawals} />
        </div>
      </Card>
    </div>
  );
}

function FundingSection({ asset, depositAddress, funding }: { asset: string; depositAddress: DepositAddress | null; funding: FundingAccount | null }) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionHeader title="资金账户" description="资金账户承载充值入账、出金冻结和内部划转后的资金余额。" />
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TokenSummary asset={asset} description="Funding Account 当前固定使用 USDT。" />
          <InfoTile label="账户 ID" value={funding?.id ?? "-"} />
          <InfoTile label="充值网络" value={bscTestnetLabel} />
          <InfoTile label="资金余额" value={formatMoney(funding?.balance, asset)} />
          <InfoTile label="冻结金额" value={formatMoney(funding?.frozen, asset)} />
          <InfoTile label="资金可用" value={formatMoney(funding?.available, asset)} />
        </div>
      </Card>

      <Card>
        <SectionHeader title="充值地址摘要" description="这里只展示地址摘要，完整复制入口统一放在顶部快捷操作中。" />
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <InfoTile label="专属地址" value={depositAddress?.address ?? "充值地址加载中"} mono />
          <InfoTile label="测试币合约" value={depositAddress?.tokenAddress ?? "合约地址加载中"} mono />
        </div>
        <div className="mt-3 border border-amber-400/25 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
          只向该地址充值 BNB Smart Chain Testnet 上的测试代币。充值到其他网络或其他代币，星衡不会自动入账。
        </div>
      </Card>
    </div>
  );
}

function RealTradingSection({ account, asset }: { account: FundingAccount | null; asset: string }) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionHeader title="交易账户" description="交易账户 = 未来真实交易入口。当前第一版只承载余额、冻结和可用余额，不接真实下单。"/>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TokenSummary asset={asset} description="当前只做账户账本占位，便于后续接真实交易能力。" />
          <InfoTile label="账户 ID" value={account?.id ?? "-"} />
          <InfoTile label="创建时间" value={formatTimestamp(account?.createdAt)} />
          <InfoTile label="余额" value={formatMoney(account?.balance, asset)} />
          <InfoTile label="冻结金额" value={formatMoney(account?.frozen, asset)} />
          <InfoTile label="可用余额" value={formatMoney(account?.available, asset)} />
        </div>
      </Card>
      <Card>
        <SectionHeader title="当前边界" description="本页现在只展示交易账户账本，不混入模拟持仓、模拟订单或真实链上托管语义。" />
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <FlowStep title="可接收划转" description="当前支持资金账户与交易账户之间划转。" />
          <FlowStep title="未接真实下单" description="真实开仓、平仓、持仓和风控接口后续再接。" />
          <FlowStep title="不混模拟数据" description="模拟交易仍只在模拟账户页面展示。" />
        </div>
      </Card>
    </div>
  );
}

function SimulationSection({ account, asset, orders, positions }: { account: TradingAccount | null; asset: string; orders: OrderRecord[]; positions: PositionView[] }) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionHeader title="模拟账户" description="现有模拟交易账户能力归属到这里，当前主读 simulation；trading 只作为兼容旧字段兜底。" />
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TokenSummary asset={account?.asset ?? asset} description="模拟交易账户仅用于虚拟成交、持仓和盈亏演示。" />
          <InfoTile label="账户 ID" value={account?.id ?? "-"} />
          <InfoTile label="创建时间" value={formatTimestamp(account?.createdAt)} />
          <InfoTile label="Balance" value={formatMoney(account?.balance, asset)} />
          <InfoTile label="Equity" value={formatMoney(account?.equity, asset)} />
          <InfoTile label="Used Margin" value={formatMoney(account?.usedMargin, asset)} />
          <InfoTile label="Free Margin" value={formatMoney(account?.freeMargin, asset)} />
          <InfoTile label="浮动盈亏" value={formatMoney(account?.floatingPnl, asset)} />
          <InfoTile label="当前持仓" value={`${positions.length} 笔`} />
          <InfoTile label="订单记录" value={`${orders.length} 条`} />
        </div>
      </Card>
      <Card>
        <SectionHeader title="模拟边界" description="模拟账户不代表真实交易账户，也不接真实撮合、清算或资金托管。" />
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <FlowStep title="虚拟成交" description="开仓和平仓在星衡内部模拟完成。" />
          <FlowStep title="虚拟资金" description="盈亏、保证金和权益只用于模拟交易展示。" />
          <FlowStep title="真实交易占位" description="真实交易账户将由交易账户页面承载，当前暂不接入。" />
        </div>
      </Card>
    </div>
  );
}

function WithdrawalsSection({ asset, funding, withdrawals }: { asset: string; funding: FundingAccount | null; withdrawals: WithdrawalRequest[] }) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionHeader title="出金订单" description="出金先冻结资金，后台审核通过后进入链上广播，链上确认后才正式扣减。" />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <ChainInfo label="可用余额" value={formatMoney(funding?.available, asset)} />
          <ChainInfo label="冻结规则" value="提交后先冻结，失败或拒绝后释放" />
          <ChainInfo label="确认规则" value={`${requiredConfirmations} 次区块确认后正式扣款`} />
        </div>
      </Card>
      <WithdrawalTable withdrawals={withdrawals} />
    </div>
  );
}

function DepositOrdersSection({ deposits }: { deposits: OnchainDeposit[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <RecordHeader
        title="入金订单"
        description="入金订单先由已确认的链上充值记录派生展示。已确认 = 链上交易达到确认要求，并已进入资金账户。"
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-line bg-white/[0.03] text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">入账时间</th>
              <th className="px-5 py-3 font-medium">金额</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">网络</th>
              <th className="px-5 py-3 font-medium">交易哈希</th>
              <th className="px-5 py-3 font-medium">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {deposits.length === 0 ? (
              <tr>
                <td className="px-5 py-8" colSpan={6}>
                  <EmptyState title="暂无入金订单" description="链上充值确认并入账后，会在这里以用户订单视角展示。" />
                </td>
              </tr>
            ) : (
              deposits.slice(0, 10).map((deposit) => (
                <tr key={deposit.id}>
                  <td className="px-5 py-4 text-muted">{formatTimestamp(deposit.confirmedAt ?? deposit.updatedAt ?? deposit.detectedAt)}</td>
                  <td className="px-5 py-4">{formatMoney(deposit.amountDecimal, deposit.asset)}</td>
                  <td className="px-5 py-4"><StatusCell status={deposit.status} /></td>
                  <td className="px-5 py-4 text-muted">{formatNetwork(deposit.network)}</td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(deposit.txHash)}</td>
                  <td className="px-5 py-4 text-muted">链上充值已确认并进入资金账户。</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function LedgerSection({ ledger, transfers }: { ledger: FundingLedgerEntry[]; transfers: AccountTransferRecord[] }) {
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden p-0">
        <RecordHeader title="资金流水" description="资金流水记录余额、冻结金额和账户间划转的变化明细。" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">账户</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">余额变化</th>
                <th className="px-5 py-3 font-medium">冻结变化</th>
                <th className="px-5 py-3 font-medium">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ledger.length === 0 ? (
                <tr>
                  <td className="px-5 py-8" colSpan={7}>
                    <EmptyState title="暂无资金流水" description="充值入账、出金冻结、内部转账完成后，会在这里显示资金变化明细。" />
                  </td>
                </tr>
              ) : (
                ledger.slice(0, 10).map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-5 py-4 text-muted">{formatTimestamp(entry.createdAt)}</td>
                    <td className="px-5 py-4">{formatWalletAccountLabel(entry.accountType)}</td>
                    <td className="px-5 py-4">{formatLedgerType(entry.type)}</td>
                    <td className="px-5 py-4">{formatMoney(entry.amount, entry.asset)}</td>
                    <td className="px-5 py-4 text-muted">{entry.balanceBefore.toFixed(2)} → {entry.balanceAfter.toFixed(2)}</td>
                    <td className="px-5 py-4 text-muted">{entry.frozenBefore.toFixed(2)} → {entry.frozenAfter.toFixed(2)}</td>
                    <td className="px-5 py-4"><StatusBadge status={entry.status} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <RecordHeader title="转账记录" description="这里单独展示账户划转和用户间内部转账，便于区分同账户调拨和跨用户转账。" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">方向</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">备注</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {transfers.length === 0 ? (
                <tr>
                  <td className="px-5 py-8" colSpan={6}>
                    <EmptyState title="暂无转账记录" description="完成账户划转或内部转账后，会在这里显示独立记录。" />
                  </td>
                </tr>
              ) : (
                transfers.slice(0, 10).map((transfer) => (
                  <tr key={transfer.id}>
                    <td className="px-5 py-4 text-muted">{formatTimestamp(transfer.createdAt)}</td>
                    <td className="px-5 py-4">{formatTransferType(transfer.transferType)}</td>
                    <td className="px-5 py-4 text-muted">{formatWalletAccountLabel(transfer.fromAccountType)} → {formatWalletAccountLabel(transfer.toAccountType)}</td>
                    <td className="px-5 py-4">{formatMoney(transfer.amount, transfer.asset)}</td>
                    <td className="px-5 py-4"><StatusBadge status={transfer.status === "failed" ? "failed" : transfer.status === "reversed" ? "rejected" : "completed"} /></td>
                    <td className="px-5 py-4 text-muted">{transfer.remark ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function OnchainDepositsSection({ deposits }: { deposits: OnchainDeposit[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <RecordHeader
        title="链上充值记录"
        description="链上充值记录展示扫描过程，包含检测、确认中、已确认和失败状态。"
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1240px] text-left text-sm">
          <thead className="border-b border-line bg-white/[0.03] text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">检测时间</th>
              <th className="px-5 py-3 font-medium">金额</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">确认数</th>
              <th className="px-5 py-3 font-medium">来源地址</th>
              <th className="px-5 py-3 font-medium">收款地址</th>
              <th className="px-5 py-3 font-medium">交易哈希</th>
              <th className="px-5 py-3 font-medium">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {deposits.length === 0 ? (
              <tr>
                <td className="px-5 py-8" colSpan={8}>
                  <EmptyState title="暂无链上充值记录" description="向专属地址充值测试代币后，扫描服务检测到交易才会出现在这里。" />
                </td>
              </tr>
            ) : (
              deposits.slice(0, 10).map((deposit) => (
                <tr key={deposit.id}>
                  <td className="px-5 py-4 text-muted">{formatTimestamp(deposit.detectedAt)}</td>
                  <td className="px-5 py-4">{formatMoney(deposit.amountDecimal, deposit.asset)}</td>
                  <td className="px-5 py-4"><StatusCell status={deposit.status} /></td>
                  <td className="px-5 py-4 text-muted">{formatConfirmations(deposit.confirmations)}</td>
                  <td className="px-5 py-4"><AddressText value={deposit.fromAddress} /></td>
                  <td className="px-5 py-4"><AddressText value={deposit.toAddress} /></td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(deposit.txHash)}</td>
                  <td className="px-5 py-4">{renderReason(deposit.failedReason)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TradeOrdersSection({ orders }: { orders: OrderRecord[] }) {
  return (
    <Card>
      <SectionHeader title="交易订单" description="当前展示模拟交易订单，真实交易订单后续归入交易账户体系。" />
      {orders.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="暂无订单记录" description="交易页产生模拟开仓或平仓后，订单会同步到这里。" />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {orders.slice(0, 10).map((order) => (
            <div key={order.id} className="flex flex-col gap-3 border border-line bg-white/[0.03] p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium">
                  {order.symbol} · {order.action === "open" ? "开仓" : "平仓"} · {formatTradeSide(order.side)}
                </p>
                <p className="mt-1 text-xs text-muted">{formatTimestamp(order.createdAt)}</p>
              </div>
              <div className="text-sm text-muted">
                {order.status === "rejected" ? order.reason : `${order.price?.toFixed(5) ?? "-"} / ${order.volume}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function WithdrawalTable({ withdrawals }: { withdrawals: WithdrawalRequest[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <RecordHeader
        title="出金申请记录"
        description="出金先冻结资金，后台审核通过后进入链上广播，链上确认后才正式扣减。"
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1320px] text-left text-sm">
          <thead className="border-b border-line bg-white/[0.03] text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">时间</th>
              <th className="px-5 py-3 font-medium">金额</th>
              <th className="px-5 py-3 font-medium">申请状态</th>
              <th className="px-5 py-3 font-medium">链上阶段</th>
              <th className="px-5 py-3 font-medium">确认数</th>
              <th className="px-5 py-3 font-medium">网络</th>
              <th className="px-5 py-3 font-medium">目标地址</th>
              <th className="px-5 py-3 font-medium">交易哈希</th>
              <th className="px-5 py-3 font-medium">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {withdrawals.length === 0 ? (
              <tr>
                <td className="px-5 py-8" colSpan={9}>
                  <EmptyState title="暂无出金申请" description="提交出金申请后，会在这里显示审核、广播、确认或失败状态。" />
                </td>
              </tr>
            ) : (
              withdrawals.slice(0, 10).map((withdrawal) => (
                <tr key={withdrawal.id}>
                  <td className="px-5 py-4 text-muted">{formatTimestamp(withdrawal.createdAt)}</td>
                  <td className="px-5 py-4">{formatMoney(withdrawal.amount, withdrawal.asset)}</td>
                  <td className="px-5 py-4"><StatusCell status={withdrawal.status} /></td>
                  <td className="px-5 py-4">{withdrawal.onchainStatus ? <StatusCell status={withdrawal.onchainStatus} /> : <span className="text-muted">待审核后生成</span>}</td>
                  <td className="px-5 py-4 text-muted">{formatConfirmations(withdrawal.confirmations ?? 0)}</td>
                  <td className="px-5 py-4 text-muted">{formatNetwork(withdrawal.network)}</td>
                  <td className="px-5 py-4"><AddressText value={withdrawal.walletAddress} /></td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(withdrawal.broadcastTxHash ?? withdrawal.txHash)}</td>
                  <td className="px-5 py-4">{renderReason(withdrawal.failedReason ?? withdrawal.reviewNote ?? withdrawal.remark)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
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
      <SectionHeader
        title="测试网充值地址"
        description="专属地址 = 系统为每个用户固定分配的一条测试链地址，用来识别是谁充值的。"
      />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <FlowStep title="收款地址" description="复制专属地址并从测试钱包转入代币。" />
        <FlowStep title="链上确认" description={`扫描服务检测交易，并等待 ${requiredConfirmations} 次区块确认。`} />
        <FlowStep title="资金入账" description="确认后记入星衡资金账户，前台资产显示为 USDT。" />
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
      <SectionHeader
        title="提交出金申请"
        description="当前出金会先冻结资金，审核通过后广播到 BSC Testnet，链上确认后再正式扣减。"
      />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <ChainInfo label="可用余额" value={formatMoney(funding?.available, asset)} />
        <ChainInfo label="冻结规则" value="失败或拒绝后释放冻结" />
        <ChainInfo label="网络" value={bscTestnetLabel} />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <Input label="金额" type="number" min={0} value={withdrawAmount} onChange={(event) => onWithdrawAmountChange(Number(event.target.value))} />
        <Input label="网络" value={bscTestnetLabel} disabled />
        <Input label="出金地址" value={withdrawAddress} onChange={(event) => onWithdrawAddressChange(event.target.value)} placeholder="0x..." />
      </div>
      <Button className="mt-4" disabled={withdrawAmount <= 0 || !withdrawAddress.trim()} onClick={onSubmitWithdrawal}>
        提交出金申请
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
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-end">
        <Select label="转出账户" value={transferFrom} options={options} onChange={(event) => onTransferFromChange(event.target.value as TransferAccount)} />
        <Button type="button" className="h-[46px] w-full md:w-auto md:px-3" variant="secondary" onClick={swapAccounts}>
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
      <p className="border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-muted">
        当前只支持 资金账户 ↔ 模拟账户、资金账户 ↔ 交易账户。模拟账户与交易账户之间不能直接互转。
      </p>
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
      <p className="border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-muted">
        内部转账只发生在平台内部：当前固定为 资金账户 → 另一位用户的资金账户，不触发链上转账。
      </p>
      {transferFeedback ? <p className="border border-white/15 bg-white/[0.035] p-3 text-sm leading-6 text-slate-200">{transferFeedback}</p> : null}
    </div>
  );
}

function RecentDepositList({ deposits }: { deposits: OnchainDeposit[] }) {
  const recent = deposits.slice(0, 3);
  return (
    <div className="border border-white/10 bg-white/[0.025] p-4">
      <p className="text-sm font-semibold text-white">最近充值</p>
      {recent.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">暂无链上充值记录。</p>
      ) : (
        <div className="mt-3 space-y-3">
          {recent.map((deposit) => (
            <div key={deposit.id} className="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{formatMoney(deposit.amountDecimal, deposit.asset)}</span>
                <StatusBadge status={deposit.status} />
              </div>
              <p className="text-xs text-muted">{formatTimestamp(deposit.detectedAt)} · {shortenHash(deposit.txHash)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentWithdrawalList({ withdrawals }: { withdrawals: WithdrawalRequest[] }) {
  const recent = withdrawals.slice(0, 3);
  return (
    <div className="border border-white/10 bg-white/[0.025] p-4">
      <p className="text-sm font-semibold text-white">最近出金</p>
      {recent.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">暂无出金申请。</p>
      ) : (
        <div className="mt-3 space-y-3">
          {recent.map((withdrawal) => (
            <div key={withdrawal.id} className="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{formatMoney(withdrawal.amount, withdrawal.asset)}</span>
                <StatusBadge status={withdrawal.status} />
              </div>
              <p className="text-xs text-muted">{formatTimestamp(withdrawal.createdAt)} · {formatNetwork(withdrawal.network)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NavGroup({ title }: { title: string }) {
  return <div className="shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-dim lg:mt-2">{title}</div>;
}

function SectionButton({ active, label, level = "root", onClick }: { active: boolean; label: string; level?: "root" | "child"; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={`shrink-0 border px-4 py-3 text-left text-sm font-semibold transition lg:w-full ${
        active ? "border-white bg-white text-black" : "border-white/10 text-muted hover:border-white/40 hover:text-white"
      } ${level === "child" ? "lg:pl-7" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="xh-panel-title">{title}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{description}</p>
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

function TokenSummary({ asset, description }: { asset: string; description: string }) {
  return (
    <div className="flex items-center gap-3 border border-white/10 bg-white/[0.03] px-4 py-3">
      <img src={tokenIconSrc} alt={`${asset} token icon`} className="h-10 w-10 object-contain" />
      <div>
        <p className="text-sm font-medium text-white">{asset}</p>
        <p className="text-xs leading-5 text-muted">{description}</p>
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

function RecordHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold tracking-[-0.01em] text-white">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto max-w-md border border-white/10 bg-white/[0.025] p-5 text-center">
      <p className="font-medium text-white">{title}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
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
  description: string;
  tone?: "neutral" | "danger";
  actionLabel?: string;
  onAction?: () => void;
}) {
  const toneClass = tone === "danger" ? "border-red-400/40 bg-red-500/10 text-red-100" : "border-white/15 bg-white/[0.03] text-slate-200";
  return (
    <div className={`flex flex-col gap-3 border p-4 md:flex-row md:items-center md:justify-between ${toneClass}`}>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
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

function formatNumber(value: number | undefined | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

function isTransferPairAllowed(from: TransferAccount, to: TransferAccount) {
  if (from === to) {
    return false;
  }
  return from === "funding" || to === "funding";
}

function formatTimestamp(value?: number | null) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("zh-CN");
}

function formatLedgerType(type: FundingLedgerEntry["type"]) {
  const labels: Record<FundingLedgerEntry["type"], string> = {
    deposit: "入金",
    withdrawal_freeze: "出金冻结",
    withdrawal_approved: "出金通过",
    withdrawal_rejected: "出金拒绝",
    transfer_in: "转入",
    transfer_out: "转出",
    internal_transfer_in: "内部转入",
    internal_transfer_out: "内部转出",
    adjustment: "调整",
  };
  return labels[type];
}

function formatWalletAccountLabel(type: WalletAccountType) {
  const labels: Record<WalletAccountType, string> = {
    funding: "资金账户",
    simulation: "模拟账户",
    realTrading: "交易账户",
    trading: "模拟账户(兼容)",
  };
  return labels[type];
}

function formatTransferType(type: AccountTransferRecord["transferType"]) {
  return type === "internal_transfer" ? "内部转账" : "账户划转";
}

function StatusBadge({ status }: { status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] | OnchainDeposit["status"] }) {
  const tone =
    status === "completed" || status === "confirmed"
      ? "success"
      : status === "rejected" || status === "failed"
        ? "danger"
        : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

function StatusCell({ status }: { status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] | OnchainDeposit["status"] }) {
  return (
    <div className="space-y-1">
      <StatusBadge status={status} />
      <p className="text-xs leading-5 text-muted">{formatStatusHint(status)}</p>
    </div>
  );
}

function formatStatus(status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] | OnchainDeposit["status"]) {
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

function formatStatusHint(status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] | OnchainDeposit["status"]) {
  const hints: Record<string, string> = {
    pending: "等待处理",
    completed: "账本已完成",
    rejected: "资金已解冻",
    pending_review: "等待后台审核",
    broadcasting: "准备提交链上",
    broadcasted: "已提交链上",
    confirmed: "链上已确认",
    failed: "资金已释放或需处理",
    detected: "已扫到交易",
    confirming: "等待区块确认",
  };
  return hints[status] ?? "状态待同步";
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
      className="inline-flex flex-col gap-1 text-white underline underline-offset-2"
      href={`https://testnet.bscscan.com/tx/${txHash}`}
      target="_blank"
      rel="noreferrer"
    >
      <span>查看交易</span>
      <span className="font-mono text-[11px] text-muted no-underline">{shortenHash(txHash)}</span>
    </a>
  );
}

function renderReason(value?: string | null) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="block max-w-[220px] text-sm leading-5 text-amber-100">{value}</span>;
}

function shortenHash(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function quickActionsForSection(section: AccountSection): Array<QuickAction | "trade"> {
  const actions: Record<AccountSection, Array<QuickAction | "trade">> = {
    overview: ["deposit", "withdraw", "transfer", "internal-transfer", "trade"],
    "wallet-overview": ["deposit", "withdraw", "transfer", "internal-transfer"],
    funding: ["deposit", "withdraw", "transfer", "internal-transfer"],
    trading: ["transfer"],
    simulation: ["trade"],
    withdrawals: ["withdraw"],
    deposits: ["deposit"],
    ledger: ["transfer", "internal-transfer"],
    "onchain-deposits": ["deposit"],
    "trade-orders": ["trade"],
  };
  return actions[section];
}

function readSectionFromUrl(): AccountSection {
  const section = new URLSearchParams(window.location.search).get("section");
  return isAccountSection(section) ? section : "overview";
}

function isAccountSection(value: string | null): value is AccountSection {
  return accountSections.includes(value as AccountSection);
}
