import { useEffect, useState } from "react";
import { fetchOrders, fetchPositions, fetchTradingAccount, type OrderRecord, type PositionView, type TradingAccount } from "../../api/market";
import {
  createWithdrawalRequest,
  fetchDepositAddress,
  fetchOnchainDeposits,
  fetchWalletAccounts,
  fetchWalletLedger,
  fetchWithdrawalRequests,
  transferWalletBalance,
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
import { useUserStore } from "../../store/userStore";
import { formatDateTime } from "../../utils/validators";

type AccountSection = "overview" | "transfer" | "withdraw" | "records";
const tokenIconSrc = "/assets/xingheng-logo@2x.png";
const bscTestnetLabel = "BNB Smart Chain Testnet";
const requiredConfirmations = 1;

export function AccountPage() {
  const user = useUserStore((state) => state.currentUser);
  const [funding, setFunding] = useState<FundingAccount | null>(null);
  const [account, setAccount] = useState<TradingAccount | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [ledger, setLedger] = useState<FundingLedgerEntry[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [depositAddress, setDepositAddress] = useState<DepositAddress | null>(null);
  const [deposits, setDeposits] = useState<OnchainDeposit[]>([]);
  const [transferDirection, setTransferDirection] = useState<"funding_to_trading" | "trading_to_funding">("funding_to_trading");
  const [transferAmount, setTransferAmount] = useState(100);
  const [withdrawAmount, setWithdrawAmount] = useState(100);
  const [withdrawNetwork] = useState("BSC_TESTNET");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [message, setMessage] = useState("");
  const [activeSection, setActiveSection] = useState<AccountSection>("overview");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void loadAccount();
  }, []);

  const asset = funding?.asset ?? account?.asset ?? "USDT";

  const loadAccount = async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      const [walletAccounts, nextPositions, nextOrders, nextLedger, nextWithdrawals, nextDepositAddress, nextDeposits, fallbackTradingAccount] = await Promise.all([
        fetchWalletAccounts(),
        fetchPositions(),
        fetchOrders(),
        fetchWalletLedger(),
        fetchWithdrawalRequests(),
        fetchDepositAddress(),
        fetchOnchainDeposits(),
        fetchTradingAccount(),
      ]);
      setFunding(walletAccounts.funding);
      setAccount(walletAccounts.trading ?? fallbackTradingAccount);
      setPositions(nextPositions);
      setOrders(nextOrders);
      setLedger(nextLedger);
      setWithdrawals(nextWithdrawals);
      setDepositAddress(nextDepositAddress);
      setDeposits(nextDeposits);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "资金数据加载失败，请稍后重试。");
    } finally {
      setIsLoading(false);
    }
  };

  const submitTransfer = async () => {
    setMessage("");
    const from: WalletAccountType = transferDirection === "funding_to_trading" ? "funding" : "trading";
    const to: WalletAccountType = transferDirection === "funding_to_trading" ? "trading" : "funding";
    try {
      await transferWalletBalance(from, to, transferAmount, "用户内部转账");
      await loadAccount();
      setMessage("内部转账已完成。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内部转账失败。");
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
          资金账户、交易账户、充值地址、链上充值记录、出金申请和流水记录统一归集在此页面。当前钱包网络为 {bscTestnetLabel}。
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="资金余额" value={funding?.balance} currency={asset} />
        <Metric label="冻结金额" value={funding?.frozen} currency={asset} />
        <Metric label="资金可用" value={funding?.available} currency={asset} />
        <Metric label="交易权益" value={account?.equity} currency={asset} />
      </div>

      {isLoading ? <InlineState title="正在加载资金数据" description="正在同步资金账户、充值地址、链上记录和出金状态。" /> : null}
      {loadError ? <InlineState tone="danger" title="资金数据加载失败" description={loadError} actionLabel="重新加载" onAction={() => void loadAccount()} /> : null}

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <nav className="no-scrollbar flex gap-2 overflow-x-auto border border-white/15 bg-black p-2 lg:flex-col lg:overflow-visible">
            <SectionButton active={activeSection === "overview"} label="账户总览" onClick={() => setActiveSection("overview")} />
            <SectionButton active={activeSection === "transfer"} label="内部转账" onClick={() => setActiveSection("transfer")} />
            <SectionButton active={activeSection === "withdraw"} label="出金申请" onClick={() => setActiveSection("withdraw")} />
            <SectionButton active={activeSection === "records"} label="记录与订单" onClick={() => setActiveSection("records")} />
          </nav>
          <div className="mt-3 hidden border border-white/15 bg-white/[0.03] p-4 text-xs leading-5 text-muted lg:block">
            资金页侧边导航只在本页内切换内容；顶部主导航负责跨页面跳转。
          </div>
        </aside>

        <div className="min-w-0 space-y-5">
          {activeSection === "overview" ? (
            <>
              <Card>
                <h2 className="xh-panel-title">用户资料</h2>
                <dl className="mt-5 grid gap-5 md:grid-cols-2">
                  <Info label="用户 ID" value={user?.id || "-"} />
                  <Info label="邮箱" value={user?.email || "-"} />
                  <Info label="昵称" value={user?.nickname || "未设置"} />
                  <Info label="状态" value={user?.status || "-"} />
                  <Info label="注册时间" value={user?.createdAt ? formatDateTime(user.createdAt) : "-"} />
                </dl>
              </Card>

              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <h2 className="xh-panel-title">资金账户</h2>
                  <div className="mt-4 flex items-center gap-3 border border-white/10 bg-white/[0.03] px-4 py-3">
                    <img src={tokenIconSrc} alt={`${asset} token icon`} className="h-10 w-10 object-contain" />
                    <div>
                      <p className="text-sm font-medium text-white">{funding?.asset ?? "USDT"}</p>
                      <p className="text-xs text-muted">当前测试币图标使用星衡主 Logo。</p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <Info label="账户 ID" value={funding?.id ?? "-"} />
                    <Info label="资产" value={funding?.asset ?? "USDT"} />
                    <Info label="余额" value={formatMoney(funding?.balance, asset)} />
                    <Info label="冻结" value={formatMoney(funding?.frozen, asset)} />
                    <Info label="可用" value={formatMoney(funding?.available, asset)} />
                    <Info label="充值网络" value={bscTestnetLabel} />
                    <Info label="充值地址" value={depositAddress?.address ?? "-"} />
                  </div>
                </Card>

                <Card>
                  <h2 className="xh-panel-title">交易账户</h2>
                  <div className="mt-4 flex items-center gap-3 border border-white/10 bg-white/[0.03] px-4 py-3">
                    <img src={tokenIconSrc} alt={`${asset} token icon`} className="h-10 w-10 object-contain" />
                    <div>
                      <p className="text-sm font-medium text-white">{account?.asset ?? "USDT"}</p>
                      <p className="text-xs text-muted">交易账户资产展示复用当前项目 Logo。</p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <Info label="账户 ID" value={account?.id ?? "-"} />
                    <Info label="资产" value={account?.asset ?? "USDT"} />
                    <Info label="Balance" value={formatMoney(account?.balance, asset)} />
                    <Info label="Equity" value={formatMoney(account?.equity, asset)} />
                    <Info label="Used Margin" value={formatMoney(account?.usedMargin, asset)} />
                    <Info label="Free Margin" value={formatMoney(account?.freeMargin, asset)} />
                  </div>
                </Card>
              </div>

              <Card>
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="xh-panel-title">测试网充值地址</h2>
                    <p className="mt-2 text-sm leading-6 text-muted">
                      这是你的专属测试网收款地址。专属地址 = 系统为每个用户固定分配的一条测试链地址，用来识别是谁充值的。
                    </p>
                  </div>
                  <StatusBadge status={depositAddress?.address ? "completed" : "pending"} />
                </div>
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
                    <Button className="md:shrink-0" variant="secondary" disabled={!depositAddress?.address} onClick={() => void copyDepositAddress()}>
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
              </Card>

              <Card>
                <h2 className="xh-panel-title">模拟账户状态</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <Info label="账户 ID" value={account?.id ?? "-"} />
                  <Info label="浮动盈亏" value={formatMoney(account?.floatingPnl, asset)} />
                  <Info label="当前持仓" value={`${positions.length} 笔`} />
                  <Info label="订单记录" value={`${orders.length} 条`} />
                  <Info label="账户资产" value={account?.asset ?? asset} />
                  <Info label="创建时间" value={account?.createdAt ? new Date(account.createdAt).toLocaleString("zh-CN") : "-"} />
                </div>
              </Card>
            </>
          ) : null}

          {activeSection === "transfer" ? (
            <Card>
              <h2 className="xh-panel-title">内部转账</h2>
              <p className="mt-2 text-sm text-muted">在资金账户和交易账户之间划转 USDT。</p>
              <div className="mt-5 grid gap-4 md:grid-cols-[1fr_180px_auto] md:items-end">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-300">方向</span>
                  <select
                    className="w-full border border-white/20 bg-black px-3.5 py-3 text-sm text-white outline-none transition focus:border-white"
                    value={transferDirection}
                    onChange={(event) => setTransferDirection(event.target.value as typeof transferDirection)}
                  >
                    <option value="funding_to_trading">资金账户 → 交易账户</option>
                    <option value="trading_to_funding">交易账户 → 资金账户</option>
                  </select>
                </label>
                <Input label="金额" type="number" min={0} value={transferAmount} onChange={(event) => setTransferAmount(Number(event.target.value))} />
                <Button disabled={transferAmount <= 0} onClick={() => void submitTransfer()}>确认转账</Button>
              </div>
            </Card>
          ) : null}

          {activeSection === "withdraw" ? (
            <Card>
              <h2 className="xh-panel-title">出金申请</h2>
              <p className="mt-2 text-sm text-muted">
                提交后会先冻结资金，再进入后台审核。审核通过后，系统会把测试链转账广播到链上，并等待 1 次确认后正式扣款。
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <ChainInfo label="可用余额" value={formatMoney(funding?.available, asset)} />
                <ChainInfo label="冻结规则" value="提交后先冻结，失败或拒绝后释放" />
                <ChainInfo label="确认规则" value={`${requiredConfirmations} 次区块确认后正式扣款`} />
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <Input label="金额" type="number" min={0} value={withdrawAmount} onChange={(event) => setWithdrawAmount(Number(event.target.value))} />
                <Input label="网络" value={bscTestnetLabel} disabled />
                <Input label="提币地址" value={withdrawAddress} onChange={(event) => setWithdrawAddress(event.target.value)} placeholder="0x..." />
              </div>
              <Button className="mt-4" disabled={withdrawAmount <= 0 || !withdrawNetwork.trim() || !withdrawAddress.trim()} onClick={() => void submitWithdrawal()}>
                提交出金申请
              </Button>
            </Card>
          ) : null}

          {message ? <p className="xh-message">{message}</p> : null}

          {activeSection === "records" ? (
            <>
      <Card className="overflow-hidden p-0">
        <RecordHeader
          title="链上充值记录"
          description="链上扫描到转账后会先显示为确认中，达到 1 次区块确认后才会进入资金账户。"
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">检测时间</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">确认数</th>
                <th className="px-5 py-3 font-medium">来源地址</th>
                <th className="px-5 py-3 font-medium">交易哈希</th>
                <th className="px-5 py-3 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deposits.length === 0 ? (
                <tr>
                  <td className="px-5 py-8" colSpan={7}>
                    <EmptyState title="暂无链上充值记录" description="向上方专属地址充值测试代币后，扫描服务检测到交易才会出现在这里。" />
                  </td>
                </tr>
              ) : deposits.slice(0, 8).map((deposit) => (
                <tr key={deposit.id}>
                  <td className="px-5 py-4 text-muted">{new Date(deposit.detectedAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4">{formatMoney(deposit.amountDecimal, deposit.asset)}</td>
                  <td className="px-5 py-4"><StatusCell status={deposit.status} /></td>
                  <td className="px-5 py-4 text-muted">{formatConfirmations(deposit.confirmations)}</td>
                  <td className="px-5 py-4"><AddressText value={deposit.fromAddress} /></td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(deposit.txHash)}</td>
                  <td className="px-5 py-4">{renderReason(deposit.failedReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

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
              ) : withdrawals.slice(0, 8).map((withdrawal) => (
                <tr key={withdrawal.id}>
                  <td className="px-5 py-4 text-muted">{new Date(withdrawal.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4">{formatMoney(withdrawal.amount, withdrawal.asset)}</td>
                  <td className="px-5 py-4"><StatusCell status={withdrawal.status} /></td>
                  <td className="px-5 py-4">{withdrawal.onchainStatus ? <StatusCell status={withdrawal.onchainStatus} /> : <span className="text-muted">待审核后生成</span>}</td>
                  <td className="px-5 py-4 text-muted">{formatConfirmations(withdrawal.confirmations ?? 0)}</td>
                  <td className="px-5 py-4 text-muted">{formatNetwork(withdrawal.network)}</td>
                  <td className="px-5 py-4"><AddressText value={withdrawal.walletAddress} /></td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(withdrawal.broadcastTxHash ?? withdrawal.txHash)}</td>
                  <td className="px-5 py-4">{renderReason(withdrawal.failedReason ?? withdrawal.reviewNote ?? withdrawal.remark)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line p-4">
          <h2 className="font-semibold uppercase tracking-[0.08em]">最近资金流水</h2>
        </div>
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
              ) : ledger.slice(0, 10).map((entry) => (
                <tr key={entry.id}>
                  <td className="px-5 py-4 text-muted">{new Date(entry.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4">{entry.accountType === "funding" ? "资金账户" : "交易账户"}</td>
                  <td className="px-5 py-4">{formatLedgerType(entry.type)}</td>
                  <td className="px-5 py-4">{formatMoney(entry.amount, entry.asset)}</td>
                  <td className="px-5 py-4 text-muted">{entry.balanceBefore.toFixed(2)} → {entry.balanceAfter.toFixed(2)}</td>
                  <td className="px-5 py-4 text-muted">{entry.frozenBefore.toFixed(2)} → {entry.frozenAfter.toFixed(2)}</td>
                  <td className="px-5 py-4"><StatusBadge status={entry.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold uppercase tracking-[0.08em]">最近订单</h2>
        {orders.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="暂无订单记录" description="交易页产生模拟开仓或平仓后，最近订单会同步到这里。" />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {orders.slice(0, 5).map((order) => (
              <div key={order.id} className="flex flex-col gap-2 border border-line bg-white/[0.03] p-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-medium">
                    {order.symbol} · {order.action === "open" ? "开仓" : "平仓"} · {order.side}
                  </p>
                  <p className="mt-1 text-xs text-muted">{new Date(order.createdAt).toLocaleString("zh-CN")}</p>
                </div>
                <div className="text-sm text-muted">
                  {order.status === "rejected" ? order.reason : `${order.price?.toFixed(5) ?? "-"} / ${order.volume}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SectionButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={`shrink-0 border px-4 py-3 text-left text-sm font-semibold transition lg:w-full ${
        active ? "border-white bg-white text-black" : "border-white/10 text-muted hover:border-white/40 hover:text-white"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 font-medium text-white">{value}</dd>
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
      <h2 className="font-semibold uppercase tracking-[0.08em]">{title}</h2>
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
      <p className="xh-kicker">{label}</p>
      <p className="mt-3 text-2xl font-semibold md:text-3xl">
        {value?.toFixed(2) ?? "-"} <span className="text-sm text-muted">{currency}</span>
      </p>
    </Card>
  );
}

function formatMoney(value: number | undefined | null, asset: string) {
  return `${typeof value === "number" ? value.toFixed(2) : "-"} ${asset}`;
}

function formatLedgerType(type: FundingLedgerEntry["type"]) {
  const labels: Record<FundingLedgerEntry["type"], string> = {
    deposit: "入金",
    withdrawal_freeze: "出金冻结",
    withdrawal_approved: "出金通过",
    withdrawal_rejected: "出金拒绝",
    transfer_in: "转入",
    transfer_out: "转出",
    adjustment: "调整",
  };
  return labels[type];
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
