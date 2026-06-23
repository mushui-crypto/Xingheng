import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import {
  fetchAdminAccounts,
  fetchAdminMarketStatus,
  fetchAdminOrders,
  fetchAdminPositions,
  fetchMarketSymbols,
  type AdminMarketStatus,
  type OrderRecord,
  type PositionView,
  type TradingAccount,
} from "../../api/market";
import {
  approveWithdrawalRequest,
  depositFundingAccount,
  fetchAdminWalletAccounts,
  fetchAdminWalletLedger,
  fetchAdminWithdrawalRequests,
  rejectWithdrawalRequest,
  type FundingLedgerEntry,
  type WalletAccounts,
  type WithdrawalRequest,
} from "../../api/walletApi";
import { useSymbolStore } from "../../store/symbolStore";
import { formatPrice } from "../../utils/price";

export function AdminTradingPage() {
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [walletAccounts, setWalletAccounts] = useState<WalletAccounts[]>([]);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [ledger, setLedger] = useState<FundingLedgerEntry[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [marketStatus, setMarketStatus] = useState<AdminMarketStatus[]>([]);
  const [depositUserId, setDepositUserId] = useState("demo-user");
  const [depositAmount, setDepositAmount] = useState(1000);
  const [depositRemark, setDepositRemark] = useState("后台手动入金");
  const [reviewNote, setReviewNote] = useState("后台审核");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async () => {
    const nextSymbols = await fetchMarketSymbols();
    setSymbolsFromBackend(nextSymbols);
    const [nextAccounts, nextWalletAccounts, nextPositions, nextOrders, nextLedger, nextWithdrawals, nextMarketStatus] = await Promise.all([
      fetchAdminAccounts(),
      fetchAdminWalletAccounts(),
      fetchAdminPositions(),
      fetchAdminOrders(),
      fetchAdminWalletLedger(),
      fetchAdminWithdrawalRequests(),
      fetchAdminMarketStatus(),
    ]);
    setAccounts(nextAccounts);
    setWalletAccounts(nextWalletAccounts);
    setPositions(nextPositions);
    setOrders(nextOrders);
    setLedger(nextLedger);
    setWithdrawals(nextWithdrawals);
    setMarketStatus(nextMarketStatus);
  };

  const submitDeposit = async () => {
    setMessage("");
    try {
      await depositFundingAccount(depositUserId.trim(), depositAmount, depositRemark);
      await loadData();
      setMessage("后台入金已进入资金账户。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "后台入金失败。");
    }
  };

  const reviewWithdrawal = async (id: string, action: "approve" | "reject") => {
    setMessage("");
    try {
      if (action === "approve") {
        await approveWithdrawalRequest(id, reviewNote);
      } else {
        await rejectWithdrawalRequest(id, reviewNote);
      }
      await loadData();
      setMessage(action === "approve" ? "出金申请已通过。" : "出金申请已拒绝，冻结金额已释放。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "出金审核失败。");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">交易 / 资金查询</h1>
          <p className="mt-2 text-sm text-muted">查看资金账户、交易账户、出金审核、流水、持仓、订单和行情状态。</p>
        </div>
        <Button variant="secondary" onClick={() => void loadData()}>
          刷新数据
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="资金账户" value={walletAccounts.length} />
        <Stat label="出金申请" value={withdrawals.length} />
        <Stat label="当前持仓" value={positions.length} />
        <Stat label="资金流水" value={ledger.length} />
      </div>

      <Card>
        <h2 className="font-semibold">后台入金到资金账户</h2>
        <p className="mt-2 text-sm text-muted">V0.3 入金先进资金账户，用户再自行转入交易账户。</p>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_180px_1fr_auto] md:items-end">
          <Input label="用户 ID" value={depositUserId} onChange={(event) => setDepositUserId(event.target.value)} placeholder="demo-user" />
          <Input label="金额" type="number" min={0} value={depositAmount} onChange={(event) => setDepositAmount(Number(event.target.value))} />
          <Input label="备注" value={depositRemark} onChange={(event) => setDepositRemark(event.target.value)} />
          <Button disabled={!depositUserId.trim() || depositAmount <= 0} onClick={() => void submitDeposit()}>确认入金</Button>
        </div>
        {message ? <p className="mt-4 rounded-lg border border-line bg-white/[0.03] p-3 text-sm text-slate-200">{message}</p> : null}
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="资金账户" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">用户 ID</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">Balance</th>
                <th className="px-5 py-3 font-medium">Frozen</th>
                <th className="px-5 py-3 font-medium">Available</th>
                <th className="px-5 py-3 font-medium">交易账户权益</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {walletAccounts.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={6}>暂无资金账户。</td></tr>
              ) : walletAccounts.map(({ funding, trading }) => (
                <tr key={funding.id}>
                  <td className="px-5 py-4 font-mono text-xs">{funding.userId}</td>
                  <td className="px-5 py-4">{funding.asset}</td>
                  <td className="px-5 py-4">{funding.balance.toFixed(2)}</td>
                  <td className="px-5 py-4">{funding.frozen.toFixed(2)}</td>
                  <td className="px-5 py-4">{funding.available.toFixed(2)}</td>
                  <td className="px-5 py-4">{trading.equity.toFixed(2)} {trading.asset ?? trading.currency ?? "USDT"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="交易账户" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">用户 ID</th>
                <th className="px-5 py-3 font-medium">Balance</th>
                <th className="px-5 py-3 font-medium">Equity</th>
                <th className="px-5 py-3 font-medium">Used Margin</th>
                <th className="px-5 py-3 font-medium">Free Margin</th>
                <th className="px-5 py-3 font-medium">Floating P/L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {accounts.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={6}>暂无账户，用户进入交易页后会自动创建。</td></tr>
              ) : accounts.map((account) => (
                <tr key={account.id}>
                  <td className="px-5 py-4 font-mono text-xs">{account.userId}</td>
                  <td className="px-5 py-4">{account.balance.toFixed(2)} {account.asset ?? account.currency}</td>
                  <td className="px-5 py-4">{account.equity.toFixed(2)} {account.asset ?? account.currency}</td>
                  <td className="px-5 py-4">{account.usedMargin.toFixed(2)}</td>
                  <td className="px-5 py-4">{account.freeMargin.toFixed(2)}</td>
                  <td className={`px-5 py-4 ${account.floatingPnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>{account.floatingPnl.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-line p-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-semibold">出金申请审核</h2>
            <p className="mt-1 text-sm text-muted">通过会扣减资金账户余额，拒绝会释放冻结金额。</p>
          </div>
          <Input className="md:w-72" label="审核说明" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">Network / Wallet</th>
                <th className="px-5 py-3 font-medium">审核说明</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {withdrawals.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={7}>暂无出金申请。</td></tr>
              ) : withdrawals.map((withdrawal) => (
                <tr key={withdrawal.id}>
                  <td className="px-5 py-4 text-muted">{new Date(withdrawal.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{withdrawal.userId}</td>
                  <td className="px-5 py-4">{withdrawal.amount.toFixed(2)} {withdrawal.asset}</td>
                  <td className="px-5 py-4"><WithdrawalBadge status={withdrawal.status} /></td>
                  <td className="px-5 py-4 text-muted">{withdrawal.network ?? "-"} / {withdrawal.walletAddress ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{withdrawal.reviewNote ?? withdrawal.remark ?? "-"}</td>
                  <td className="px-5 py-4">
                    {withdrawal.status === "pending" ? (
                      <div className="flex gap-2">
                        <Button onClick={() => void reviewWithdrawal(withdrawal.id, "approve")}>通过</Button>
                        <Button variant="danger" onClick={() => void reviewWithdrawal(withdrawal.id, "reject")}>拒绝</Button>
                      </div>
                    ) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="行情状态" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">API Symbol</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">Bid / Ask</th>
                <th className="px-5 py-3 font-medium">来源</th>
                <th className="px-5 py-3 font-medium">行情时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {marketStatus.map((item) => (
                <tr key={item.symbol}>
                  <td className="px-5 py-4">{item.symbol}<p className="text-xs text-muted">{item.displayName}</p></td>
                  <td className="px-5 py-4 text-muted">{item.apiSymbol}</td>
                  <td className="px-5 py-4"><Badge tone={item.status === "connected" ? "success" : item.status === "stale" ? "neutral" : "danger"}>{item.status}</Badge></td>
                  <td className="px-5 py-4">{formatPrice(item.ticker?.bid, 5)} / {formatPrice(item.ticker?.ask, 5)}</td>
                  <td className="px-5 py-4 text-muted">{item.ticker?.source ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{item.ticker?.timestamp ? new Date(item.ticker.timestamp).toLocaleString("zh-CN") : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="最近订单" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">动作</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">方向/手数</th>
                <th className="px-5 py-3 font-medium">价格</th>
                <th className="px-5 py-3 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={8}>暂无订单。</td></tr>
              ) : orders.slice(0, 30).map((order) => (
                <tr key={order.id}>
                  <td className="px-5 py-4 text-muted">{new Date(order.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{order.userId}</td>
                  <td className="px-5 py-4">{order.action === "open" ? "开仓" : "平仓"}</td>
                  <td className="px-5 py-4"><Badge tone={order.status === "filled" ? "success" : "danger"}>{order.status}</Badge></td>
                  <td className="px-5 py-4">{order.symbol}</td>
                  <td className="px-5 py-4">{order.side} / {order.volume}</td>
                  <td className="px-5 py-4">{order.price?.toFixed(5) ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{order.reason ?? (typeof order.pnl === "number" ? `P/L ${order.pnl.toFixed(2)}` : "模拟成交")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="统一资金流水" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">账户</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">余额变化</th>
                <th className="px-5 py-3 font-medium">冻结变化</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">备注</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ledger.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={9}>暂无资金流水。</td></tr>
              ) : ledger.slice(0, 40).map((entry) => (
                <tr key={entry.id}>
                  <td className="px-5 py-4 text-muted">{new Date(entry.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{entry.userId}</td>
                  <td className="px-5 py-4">{entry.accountType === "funding" ? "资金账户" : "交易账户"}</td>
                  <td className="px-5 py-4">{formatLedgerType(entry.type)}</td>
                  <td className="px-5 py-4">{entry.amount.toFixed(2)} {entry.asset}</td>
                  <td className="px-5 py-4 text-muted">{entry.balanceBefore.toFixed(2)} → {entry.balanceAfter.toFixed(2)}</td>
                  <td className="px-5 py-4 text-muted">{entry.frozenBefore.toFixed(2)} → {entry.frozenAfter.toFixed(2)}</td>
                  <td className="px-5 py-4"><LedgerBadge status={entry.status} /></td>
                  <td className="px-5 py-4 text-muted">{entry.remark || entry.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold">{value}</p>
    </Card>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold">{title}</h2>
    </div>
  );
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

function LedgerBadge({ status }: { status: FundingLedgerEntry["status"] }) {
  const tone = status === "completed" ? "success" : status === "rejected" ? "danger" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

function WithdrawalBadge({ status }: { status: WithdrawalRequest["status"] }) {
  const tone = status === "approved" ? "success" : status === "rejected" ? "danger" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}
