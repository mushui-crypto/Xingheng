import { useState } from "react";
import { Activity, LockKeyhole } from "lucide-react";
import { BinanceTradingWorkbench } from "../../features/personalTrading/components/BinanceTradingWorkbench";
import { ExchangeCredentialsPanel } from "../../features/personalTrading/components/ExchangeCredentialsPanel";

export function PersonalTradingPage() {
  const [binanceReloadToken, setBinanceReloadToken] = useState(0);

  return (
    <div className="xh-page min-w-0 pb-8">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">我的套利</h1>
            <span className="inline-flex items-center gap-1.5 border border-white/20 px-2.5 py-1 text-xs font-medium text-[#c5ccd4]">
              <Activity size={13} /> Personal Trading
            </span>
          </div>
          <p className="xh-subtitle">管理个人交易所连接，并查看 Binance XAUT 对冲策略的账户、行情、订单与对账状态。</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#8f99a5]">
          <LockKeyhole size={14} /> Secret 不回显、不在浏览器持久化
        </div>
      </header>

      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <ExchangeCredentialsPanel onBinanceChanged={() => setBinanceReloadToken((value) => value + 1)} />
        <BinanceTradingWorkbench reloadToken={binanceReloadToken} />
      </div>
    </div>
  );
}
