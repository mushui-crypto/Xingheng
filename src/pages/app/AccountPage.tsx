import { useEffect, useState } from "react";
import { fetchOrders, fetchPositions, fetchTradingAccount, type OrderRecord, type PositionView, type TradingAccount } from "../../api/market";
import {
  createWithdrawalRequest,
  fetchWalletAccounts,
  fetchWalletLedger,
  fetchWithdrawalRequests,
  transferWalletBalance,
  type FundingAccount,
  type FundingLedgerEntry,
  type WalletAccountType,
  type WithdrawalRequest,
} from "../../api/walletApi";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { useUserStore } from "../../store/userStore";
import { formatDateTime } from "../../utils/validators";

export function AccountPage() {
  const user = useUserStore((state) => state.currentUser);
  const [funding, setFunding] = useState<FundingAccount | null>(null);
  const [account, setAccount] = useState<TradingAccount | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [ledger, setLedger] = useState<FundingLedgerEntry[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [transferDirection, setTransferDirection] = useState<"funding_to_trading" | "trading_to_funding">("funding_to_trading");
  const [transferAmount, setTransferAmount] = useState(100);
  const [withdrawAmount, setWithdrawAmount] = useState(100);
  const [withdrawNetwork, setWithdrawNetwork] = useState("reserved");
  const [withdrawAddress, setWithdrawAddress] = useState("reserved");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadAccount();
  }, []);

  const asset = funding?.asset ?? account?.asset ?? "USDT";

  const loadAccount = async () => {
    const [walletAccounts, nextPositions, nextOrders, nextLedger, nextWithdrawals, fallbackTradingAccount] = await Promise.all([
      fetchWalletAccounts(),
      fetchPositions(),
      fetchOrders(),
      fetchWalletLedger(),
      fetchWithdrawalRequests(),
      fetchTradingAccount(),
    ]);
    setFunding(walletAccounts.funding);
    setAccount(walletAccounts.trading ?? fallbackTradingAccount);
    setPositions(nextPositions);
    setOrders(nextOrders);
    setLedger(nextLedger);
    setWithdrawals(nextWithdrawals);
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

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">我的账户</h1>
        <p className="mt-2 text-sm text-muted">查看资金账户、交易账户、内部转账、出金申请和最近交易。</p>
      </div>
      <Card>
        <dl className="grid gap-5 md:grid-cols-2">
          <Info label="用户 ID" value={user?.id || "-"} />
          <Info label="邮箱" value={user?.email || "-"} />
          <Info label="昵称" value={user?.nickname || "未设置"} />
          <Info label="状态" value={user?.status || "-"} />
          <Info label="注册时间" value={user?.createdAt ? formatDateTime(user.createdAt) : "-"} />
        </dl>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="资金余额" value={funding?.balance} currency={asset} />
        <Metric label="冻结金额" value={funding?.frozen} currency={asset} />
        <Metric label="资金可用" value={funding?.available} currency={asset} />
        <Metric label="交易权益" value={account?.equity} currency={asset} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold">资金账户</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Info label="账户 ID" value={funding?.id ?? "-"} />
            <Info label="资产" value={funding?.asset ?? "USDT"} />
            <Info label="余额" value={formatMoney(funding?.balance, asset)} />
            <Info label="冻结" value={formatMoney(funding?.frozen, asset)} />
            <Info label="可用" value={formatMoney(funding?.available, asset)} />
            <Info label="Network / Wallet" value="reserved / reserved" />
          </div>
        </Card>

        <Card>
          <h2 className="font-semibold">交易账户</h2>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold">内部转账</h2>
          <p className="mt-2 text-sm text-muted">在资金账户和交易账户之间划转 USDT。</p>
          <div className="mt-4 grid gap-4 md:grid-cols-[1fr_180px_auto] md:items-end">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-300">方向</span>
              <select
                className="w-full rounded-lg border border-line bg-[#0f1722] px-3.5 py-3 text-sm text-white outline-none focus:border-emerald-400"
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

        <Card>
          <h2 className="font-semibold">出金申请</h2>
          <p className="mt-2 text-sm text-muted">V0.3 只提交内部审核，不发起真实链上转账。</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Input label="金额" type="number" min={0} value={withdrawAmount} onChange={(event) => setWithdrawAmount(Number(event.target.value))} />
            <Input label="Network" value={withdrawNetwork} onChange={(event) => setWithdrawNetwork(event.target.value)} />
            <Input label="Wallet Address" value={withdrawAddress} onChange={(event) => setWithdrawAddress(event.target.value)} />
          </div>
          <Button className="mt-4" disabled={withdrawAmount <= 0 || !withdrawNetwork.trim() || !withdrawAddress.trim()} onClick={() => void submitWithdrawal()}>
            提交出金申请
          </Button>
        </Card>
      </div>

      {message ? <p className="rounded-lg border border-line bg-white/[0.03] p-3 text-sm text-slate-200">{message}</p> : null}

      <Card>
        <h2 className="font-semibold">模拟账户状态</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Info label="账户 ID" value={account?.id ?? "-"} />
          <Info label="浮动盈亏" value={formatMoney(account?.floatingPnl, asset)} />
          <Info label="当前持仓" value={`${positions.length} 笔`} />
          <Info label="订单记录" value={`${orders.length} 条`} />
          <Info label="账户资产" value={account?.asset ?? asset} />
          <Info label="创建时间" value={account?.createdAt ? new Date(account.createdAt).toLocaleString("zh-CN") : "-"} />
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line p-4">
          <h2 className="font-semibold">出金申请记录</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">Network</th>
                <th className="px-5 py-3 font-medium">Wallet</th>
                <th className="px-5 py-3 font-medium">审核说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {withdrawals.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={6}>暂无出金申请。</td></tr>
              ) : withdrawals.slice(0, 8).map((withdrawal) => (
                <tr key={withdrawal.id}>
                  <td className="px-5 py-4 text-muted">{new Date(withdrawal.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4">{formatMoney(withdrawal.amount, withdrawal.asset)}</td>
                  <td className="px-5 py-4"><StatusBadge status={withdrawal.status} /></td>
                  <td className="px-5 py-4 text-muted">{withdrawal.network ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{withdrawal.walletAddress ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{withdrawal.reviewNote ?? withdrawal.remark ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line p-4">
          <h2 className="font-semibold">最近资金流水</h2>
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
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={7}>暂无资金流水。</td></tr>
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
        <h2 className="font-semibold">最近订单</h2>
        {orders.length === 0 ? (
          <p className="mt-4 text-sm text-muted">暂无订单记录。</p>
        ) : (
          <div className="mt-4 space-y-3">
            {orders.slice(0, 5).map((order) => (
              <div key={order.id} className="flex flex-col gap-2 rounded-lg border border-line bg-white/[0.03] p-4 md:flex-row md:items-center md:justify-between">
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
    </div>
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

function Metric({ label, value, currency }: { label: string; value?: number; currency: string }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-2xl font-semibold">
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

function StatusBadge({ status }: { status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] }) {
  const tone = status === "completed" || status === "approved" ? "success" : status === "rejected" ? "danger" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}
