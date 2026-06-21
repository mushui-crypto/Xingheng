import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import {
  adjustAdminAccountBalance,
  fetchAdminAccounts,
  fetchAdminBalanceAdjustments,
  fetchAdminMarketStatus,
  fetchAdminOrders,
  fetchAdminPositions,
  fetchMarketSymbols,
  type AdminMarketStatus,
  type BalanceAdjustment,
  type OrderRecord,
  type PositionView,
  type TradingAccount,
} from "../../api/market";
import { useSymbolStore } from "../../store/symbolStore";
import { formatPrice } from "../../utils/price";

export function AdminTradingPage() {
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [adjustments, setAdjustments] = useState<BalanceAdjustment[]>([]);
  const [marketStatus, setMarketStatus] = useState<AdminMarketStatus[]>([]);
  const [adjustUserId, setAdjustUserId] = useState("");
  const [adjustType, setAdjustType] = useState<"deposit" | "withdraw" | "reset">("deposit");
  const [adjustAmount, setAdjustAmount] = useState(1000);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async () => {
    const nextSymbols = await fetchMarketSymbols();
    setSymbolsFromBackend(nextSymbols);
    const [nextAccounts, nextPositions, nextOrders, nextAdjustments, nextMarketStatus] = await Promise.all([
      fetchAdminAccounts(),
      fetchAdminPositions(),
      fetchAdminOrders(),
      fetchAdminBalanceAdjustments(),
      fetchAdminMarketStatus(),
    ]);
    setAccounts(nextAccounts);
    setPositions(nextPositions);
    setOrders(nextOrders);
    setAdjustments(nextAdjustments);
    setMarketStatus(nextMarketStatus);
  };

  const submitAdjustment = async () => {
    setMessage("");
    try {
      await adjustAdminAccountBalance(adjustUserId.trim(), adjustType, adjustAmount, "后台手动调整");
      await loadData();
      setMessage("资金调整已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "资金调整失败。");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">交易查询</h1>
          <p className="mt-2 text-sm text-muted">查看模拟账户、持仓、订单、行情状态，并调整虚拟资金。</p>
        </div>
        <Button variant="secondary" onClick={() => void loadData()}>
          刷新数据
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="模拟账户" value={accounts.length} />
        <Stat label="当前持仓" value={positions.length} />
        <Stat label="订单记录" value={orders.length} />
        <Stat label="资金流水" value={adjustments.length} />
      </div>

      <Card>
        <h2 className="font-semibold">后台调整资金</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_180px_180px_auto] md:items-end">
          <Input label="用户 ID" value={adjustUserId} onChange={(event) => setAdjustUserId(event.target.value)} placeholder="USR-..." />
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-300">类型</span>
            <select
              className="w-full rounded-lg border border-line bg-[#0f1722] px-3.5 py-3 text-sm text-white outline-none focus:border-emerald-400"
              value={adjustType}
              onChange={(event) => setAdjustType(event.target.value as "deposit" | "withdraw" | "reset")}
            >
              <option value="deposit">增加</option>
              <option value="withdraw">扣减</option>
              <option value="reset">重置</option>
            </select>
          </label>
          <Input label="金额" type="number" min={0} value={adjustAmount} onChange={(event) => setAdjustAmount(Number(event.target.value))} />
          <Button disabled={!adjustUserId.trim()} onClick={submitAdjustment}>保存调整</Button>
        </div>
        {message ? <p className="mt-4 rounded-lg border border-line bg-white/[0.03] p-3 text-sm text-slate-200">{message}</p> : null}
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="模拟账户" />
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
                  <td className="px-5 py-4">{account.balance.toFixed(2)} {account.currency}</td>
                  <td className="px-5 py-4">{account.equity.toFixed(2)} {account.currency}</td>
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
                  <td className="px-5 py-4 text-muted">{order.reason ?? (order.pnl !== undefined ? `P/L ${order.pnl.toFixed(2)}` : "模拟成交")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="资金流水" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">调整前</th>
                <th className="px-5 py-3 font-medium">调整后</th>
                <th className="px-5 py-3 font-medium">备注</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {adjustments.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={7}>暂无资金流水。</td></tr>
              ) : adjustments.slice(0, 30).map((adjustment) => (
                <tr key={adjustment.id}>
                  <td className="px-5 py-4 text-muted">{new Date(adjustment.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{adjustment.userId}</td>
                  <td className="px-5 py-4">{adjustment.type === "deposit" ? "入金" : adjustment.type === "withdraw" ? "扣减" : "重置"}</td>
                  <td className="px-5 py-4">{adjustment.amount.toFixed(2)}</td>
                  <td className="px-5 py-4">{adjustment.previousBalance.toFixed(2)}</td>
                  <td className="px-5 py-4">{adjustment.nextBalance.toFixed(2)}</td>
                  <td className="px-5 py-4 text-muted">{adjustment.note || "-"}</td>
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
