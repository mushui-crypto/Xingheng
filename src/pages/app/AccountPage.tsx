import { useEffect, useState } from "react";
import { fetchOrders, fetchPositions, fetchTradingAccount, type OrderRecord, type PositionView, type TradingAccount } from "../../api/market";
import { Card } from "../../components/ui/Card";
import { useAuthStore } from "../../store/authStore";
import { useConfigStore } from "../../store/configStore";
import { useUserStore } from "../../store/userStore";
import { formatDateTime } from "../../utils/validators";

export function AccountPage() {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currency = useConfigStore((state) => state.config.defaultCurrency);
  const user = useUserStore((state) => state.getById(currentUserId));
  const [account, setAccount] = useState<TradingAccount | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);

  useEffect(() => {
    async function loadAccount() {
      const [nextAccount, nextPositions, nextOrders] = await Promise.all([
        fetchTradingAccount(currentUserId, currency),
        fetchPositions(currentUserId),
        fetchOrders(currentUserId),
      ]);
      setAccount(nextAccount);
      setPositions(nextPositions);
      setOrders(nextOrders);
    }

    void loadAccount();
  }, [currency, currentUserId]);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">我的账户</h1>
        <p className="mt-2 text-sm text-muted">查看当前模拟交易账号资料、资金和最近交易。</p>
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
        <Metric label="Balance" value={account?.balance} currency={currency} />
        <Metric label="Equity" value={account?.equity} currency={currency} />
        <Metric label="Used Margin" value={account?.usedMargin} currency={currency} />
        <Metric label="Free Margin" value={account?.freeMargin} currency={currency} />
      </div>
      <Card>
        <h2 className="font-semibold">模拟账户状态</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Info label="账户 ID" value={account?.id ?? "-"} />
          <Info label="浮动盈亏" value={`${account?.floatingPnl.toFixed(2) ?? "-"} ${currency}`} />
          <Info label="当前持仓" value={`${positions.length} 笔`} />
          <Info label="订单记录" value={`${orders.length} 条`} />
          <Info label="账户币种" value={account?.currency ?? currency} />
          <Info label="创建时间" value={account?.createdAt ? new Date(account.createdAt).toLocaleString("zh-CN") : "-"} />
        </div>
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
