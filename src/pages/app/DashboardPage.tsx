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
    if (!user) {
      setAccounts(null);
      setMessage("");
      return;
    }

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
  }, [user]);

  return (
    <div className="xh-page">
      <section className="border border-line bg-black p-6">
        <p className="xh-kicker">Mission control</p>
        <h1 className="mt-2 xh-title">
          {user?.nickname || user?.email || "STELLA X"}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          {user
            ? "当前为模拟交易环境，所有交易均为内部模拟成交，不涉及真实资金交易。"
            : "无需登录即可浏览公开行情、套利看板、策略报告与 Hyperliquid Testnet 公开市场数据。"}
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">模拟账户权益</p>
          <div className="mt-3 flex items-center gap-3">
            <img src={tokenIconSrc} alt="USDT token icon" className="h-9 w-9 object-contain" />
            <p className="text-3xl font-semibold">USDT {simulationEquity?.toFixed(2) ?? "--"}</p>
          </div>
          <p className="mt-2 text-xs text-muted">{user ? "模拟账户权益" : "登录后查看"}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">账户状态</p>
          <p className="mt-3 text-3xl font-semibold">{user ? "Active" : "Guest"}</p>
          <p className="mt-2 text-xs text-muted">{user ? "模拟交易可用" : "公开内容可浏览"}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">资金账户可用余额</p>
          <div className="mt-3 flex items-center gap-3">
            <img src={tokenIconSrc} alt="USDT token icon" className="h-9 w-9 object-contain" />
            <p className="text-3xl font-semibold">USDT {accounts?.funding.available?.toFixed(2) ?? "--"}</p>
          </div>
          <p className="mt-2 text-xs text-muted">{user ? "资金账户可用" : "登录后查看"}</p>
        </Card>
      </div>

      {message ? <p className="xh-message">{message}</p> : null}

      <Card className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center border border-white bg-white text-black">
            <WalletCards size={22} />
          </div>
          <div>
            <h2 className="font-semibold">{user ? "模拟账户入口" : "公开市场入口"}</h2>
            <p className="text-sm text-muted">
              {user
                ? "查看 Hyperliquid 永续 K 线与实时报价，并提交内部模拟市价单。"
                : "查看 Hyperliquid 永续 K 线、实时报价与公开市场数据。"}
            </p>
          </div>
        </div>
        <Link
          to={user ? "/app/account" : "/app/markets"}
          className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-white underline-offset-4 hover:underline"
        >
          {user ? "查看账户资料" : "浏览市场"} <ArrowRight size={16} />
        </Link>
      </Card>
    </div>
  );
}
