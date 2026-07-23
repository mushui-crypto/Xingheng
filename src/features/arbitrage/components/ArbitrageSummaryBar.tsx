import { CircleAlert, ListChecks, Radio, Scale } from "lucide-react";
import type { ArbitrageDashboardSnapshot, ArbitrageYieldMetric } from "../model/types";
import { equivalentNetYield, formatApr, formatBps } from "../lib/formatters";
import { ArbitrageHelp } from "./ArbitrageHelp";

export function ArbitrageSummaryBar({ snapshot, yieldMetric }: { snapshot: ArbitrageDashboardSnapshot; yieldMetric: ArbitrageYieldMetric }) {
  const metricLabel = yieldMetric.toUpperCase();
  const items = [
    {
      label: "持有质量",
      value: `${snapshot.summary.eligibleOpportunityCount} 个`,
      meta: "逻辑较强或值得关注",
      help: "基于近90天资金费率、持续性、成本覆盖、标的匹配和数据质量评估中长期持有逻辑，不受最新一期Funding单独决定。",
      icon: ListChecks,
    },
    {
      label: `最高等效净 ${metricLabel}`,
      value: formatApr(equivalentNetYield(snapshot.summary.bestNetApr, snapshot.horizonDays, yieldMetric), true),
      meta: `${snapshot.horizonDays}天持有${snapshot.horizonDays === 365 ? "情景" : "周期"}`,
      help: yieldMetric === "apr"
        ? `基于近90天资金费率，将往返手续费和1万美元档滑点按${snapshot.horizonDays}天持有期摊销后年化。`
        : `由等效净APR按${snapshot.horizonDays}天为一个再投资周期复利换算；365天情景下APY与APR相同。`,
      icon: Scale,
    },
    {
      label: "数据源",
      value: `${snapshot.summary.connectedVenueCount} / ${snapshot.summary.totalVenueCount}`,
      meta: `${snapshot.summary.trackedMarketCount} 个公开市场`,
      help: "统计当前能够返回公开行情的交易所，以及纳入比较的黄金、股票RWA与主流加密资产市场。",
      icon: Radio,
    },
    {
      label: "USDC / USDT",
      value: snapshot.summary.usdcUsdtPrice?.toFixed(6) ?? "-",
      meta: `偏离 ${formatBps(snapshot.summary.stablecoinBasisBps, true)}`,
      help: "用于提示两腿分别以USDC和USDT结算时的稳定币汇率风险，不直接计入策略收益。",
      icon: CircleAlert,
    },
  ];

  return (
    <section className="grid overflow-hidden border border-line bg-black sm:grid-cols-2 xl:grid-cols-4" aria-label="套利摘要">
      {items.map((item, index) => {
        const Icon = item.icon;
        const emphasized = index <= 1;
        return (
          <div
            key={item.label}
            className={`min-w-0 p-4 ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""} ${index === 2 ? "sm:border-l-0 xl:border-l" : ""}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <p className="truncate text-xs font-medium text-muted">{item.label}</p>
                <ArbitrageHelp content={item.help} label={`查看${item.label}说明`} />
              </div>
              <Icon aria-hidden="true" className="shrink-0 text-dim" size={15} />
            </div>
            <p className={`mt-2 font-mono text-xl ${emphasized ? "font-semibold text-white" : "font-normal text-muted"}`}>{item.value}</p>
            <p className="mt-1 truncate text-xs text-dim" title={item.meta}>{item.meta}</p>
          </div>
        );
      })}
    </section>
  );
}
