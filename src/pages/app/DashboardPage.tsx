import { ArrowRight, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchWalletAccounts, type WalletAccounts } from "../../api/walletApi";
import { Card } from "../../components/ui/Card";
import { useUserStore } from "../../store/userStore";

export function DashboardPage() {
  const user = useUserStore((state) => state.currentUser);
  const [accounts, setAccounts] = useState<WalletAccounts | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetchWalletAccounts()
      .then((payload) => {
        if (!cancelled) {
          setAccounts(payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "账户概览加载失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-gradient-to-br from-[#111827] to-[#0d141d] p-6">
        <p className="text-sm text-muted">欢迎回来</p>
        <h1 className="mt-2 text-2xl font-semibold md:text-3xl">
          {user?.nickname || user?.email}，这里是 Xing Heng
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          当前为模拟交易环境，所有交易均为内部模拟成交，不涉及真实资金交易。
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">交易账户权益</p>
          <p className="mt-3 text-3xl font-semibold">USDT {accounts?.trading.equity?.toFixed(2) ?? "--"}</p>
          <p className="mt-2 text-xs text-muted">实时读取当前交易账户权益。</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">账户状态</p>
          <p className="mt-3 text-3xl font-semibold">Active</p>
          <p className="mt-2 text-xs text-muted">当前账号允许登录模拟交易环境。</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">资金账户可用余额</p>
          <p className="mt-3 text-3xl font-semibold">USDT {accounts?.funding.available?.toFixed(2) ?? "--"}</p>
          <p className="mt-2 text-xs text-muted">实时读取当前资金账户可用余额。</p>
        </Card>
      </div>

      {message ? <p className="rounded-lg border border-line bg-white/[0.03] p-3 text-sm text-slate-200">{message}</p> : null}

      <Card className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-400 text-[#07110f]">
            <WalletCards size={22} />
          </div>
          <div>
            <h2 className="font-semibold">模拟账户入口</h2>
            <p className="text-sm text-muted">查看 PERP BTC/USDT K线、实时报价，并提交内部模拟市价单。</p>
          </div>
        </div>
        <Link
          to="/app/account"
          className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-400"
        >
          查看账户资料 <ArrowRight size={16} />
        </Link>
      </Card>
    </div>
  );
}
