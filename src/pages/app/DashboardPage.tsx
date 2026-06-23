import { ArrowRight, WalletCards } from "lucide-react";
import { Link } from "react-router-dom";
import { Card } from "../../components/ui/Card";
import { useAuthStore } from "../../store/authStore";
import { useConfigStore } from "../../store/configStore";
import { useUserStore } from "../../store/userStore";

export function DashboardPage() {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const user = useUserStore((state) => state.getById(currentUserId));
  const { config } = useConfigStore();

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-gradient-to-br from-[#111827] to-[#0d141d] p-6">
        <p className="text-sm text-muted">欢迎回来</p>
        <h1 className="mt-2 text-2xl font-semibold md:text-3xl">
          {user?.nickname || user?.email}，这里是 {config.platformName}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{config.riskNotice}</p>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">模拟账户权益</p>
          <p className="mt-3 text-3xl font-semibold">{config.defaultCurrency} 100,000.00</p>
          <p className="mt-2 text-xs text-muted">可进入交易终端查看 Binance 加密行情。</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">账户状态</p>
          <p className="mt-3 text-3xl font-semibold">Active</p>
          <p className="mt-2 text-xs text-muted">当前账号允许登录模拟交易环境。</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">当前币种</p>
          <p className="mt-3 text-3xl font-semibold">{config.defaultCurrency}</p>
          <p className="mt-2 text-xs text-muted">可在后台白标配置中修改。</p>
        </Card>
      </div>

      <Card className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-lg text-[#07110f]"
            style={{ backgroundColor: config.themeColor }}
          >
            <WalletCards size={22} />
          </div>
          <div>
            <h2 className="font-semibold">模拟账户入口</h2>
            <p className="text-sm text-muted">查看 PERP BTC/USDT K线、实时报价，并提交内部模拟市价单。</p>
          </div>
        </div>
        <Link
          to="/app/account"
          className="inline-flex items-center gap-2 text-sm font-semibold"
          style={{ color: config.themeColor }}
        >
          查看账户资料 <ArrowRight size={16} />
        </Link>
      </Card>
    </div>
  );
}
