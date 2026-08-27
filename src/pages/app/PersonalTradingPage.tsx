import { Activity, LockKeyhole } from "lucide-react";
import { AccountReadOverview } from "../../features/personalTrading/components/AccountReadOverview";
import { ArbitrageInstanceOverview } from "../../features/personalTrading/components/ArbitrageInstanceOverview";

export function PersonalTradingPage() {
  return (
    <div className="xh-page w-full min-w-0 max-w-full px-4 py-5 md:px-8 md:py-7">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">我的套利</h1>
            <span className="inline-flex items-center gap-1.5 border border-white/20 px-2.5 py-1 text-xs font-medium text-[#c5ccd4]">
              <Activity size={13} /> 套利系统 · 真实资产
            </span>
          </div>
          <p className="xh-subtitle">查看个人交易所账户的真实只读数据，并管理交易所连接。</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#8f99a5]">
          <LockKeyhole size={14} /> 密钥不回显、不在浏览器持久化
        </div>
      </header>

      <AccountReadOverview />

      <ArbitrageInstanceOverview />
    </div>
  );
}
