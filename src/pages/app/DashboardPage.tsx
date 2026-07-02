import { ArrowRight, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchWalletAccounts, type WalletAccounts } from "../../api/walletApi";
import { Card } from "../../components/ui/Card";
import { useUserStore } from "../../store/userStore";

const tokenIconSrc = "/assets/xingheng-logo@2x.png";

export function DashboardPage() {
  const user = useUserStore((state) => state.currentUser);
  const [accounts, setAccounts] = useState<WalletAccounts | null>(null);
  const [message, setMessage] = useState("");
  const simulationEquity = accounts?.simulation?.equity ?? accounts?.trading?.equity;

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
    <div className="xh-page">
      <section className="border border-line bg-black p-6">
        <p className="xh-kicker">Mission control</p>
        <h1 className="mt-2 xh-title">
          {user?.nickname || user?.email}，这里是星衡
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          当前为模拟交易环境，所有交易均为内部模拟成交，不涉及真实资金交易。
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">模拟账户权益</p>
          <div className="mt-3 flex items-center gap-3">
            <img src={tokenIconSrc} alt="USDT token icon" className="h-9 w-9 object-contain" />
            <p className="text-3xl font-semibold">USDT {simulationEquity?.toFixed(2) ?? "--"}</p>
          </div>
          <p className="mt-2 text-xs text-muted">实时读取当前模拟账户权益；旧 trading 字段仅作兼容兜底。</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">账户状态</p>
          <p className="mt-3 text-3xl font-semibold">Active</p>
          <p className="mt-2 text-xs text-muted">当前账号允许登录模拟交易环境。</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">资金账户可用余额</p>
          <div className="mt-3 flex items-center gap-3">
            <img src={tokenIconSrc} alt="USDT token icon" className="h-9 w-9 object-contain" />
            <p className="text-3xl font-semibold">USDT {accounts?.funding.available?.toFixed(2) ?? "--"}</p>
          </div>
          <p className="mt-2 text-xs text-muted">实时读取当前资金账户可用余额。</p>
        </Card>
      </div>

      {message ? <p className="xh-message">{message}</p> : null}

      <Card className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center border border-white bg-white text-black">
            <WalletCards size={22} />
          </div>
          <div>
            <h2 className="font-semibold">模拟账户入口</h2>
            <p className="text-sm text-muted">查看 PERP BTC/USDT K线、实时报价，并提交内部模拟市价单。</p>
          </div>
        </div>
        <Link
          to="/app/account"
          className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-white underline-offset-4 hover:underline"
        >
          查看账户资料 <ArrowRight size={16} />
        </Link>
      </Card>
    </div>
  );
}
