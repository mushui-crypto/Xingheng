import { BarChart3 } from "lucide-react";
import { memo } from "react";
import type { ArbitrageOpportunity, ArbitrageYieldMetric } from "../model/types";
import { equivalentNetYield, formatApr, formatFundingRate } from "../lib/formatters";
import { ArbitrageHelp } from "./ArbitrageHelp";
import { FundingCountdown } from "./FundingCountdown";

type ArbitrageOpportunityTableProps = {
  opportunities: ArbitrageOpportunity[];
  holdingDays: number;
  yieldMetric: ArbitrageYieldMetric;
  onAnalyze: (opportunity: ArbitrageOpportunity) => void;
};

export const ArbitrageOpportunityTable = memo(function ArbitrageOpportunityTable({ opportunities, holdingDays, yieldMetric, onAnalyze }: ArbitrageOpportunityTableProps) {
  if (opportunities.length === 0) {
    return (
      <div className="border border-line bg-black px-5 py-14 text-center">
        <p className="text-sm font-medium text-white">没有符合筛选条件的中性或套利组合</p>
        <p className="mt-2 text-xs text-muted">调整资产或交易所筛选条件后重试。</p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-auto border border-line bg-black" role="region" aria-label="套利机会，可横向滚动查看全部列" tabIndex={0}>
      <table className="xh-table min-w-[1120px] table-fixed [&_th]:px-3 [&_th]:tracking-normal [&_td]:px-3">
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[18.5%]" />
          <col className="w-[18.5%]" />
          <col className="w-[11%]" />
          <col className="w-[9%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
        </colgroup>
        <thead className="xh-thead">
          <tr>
            <th className="xh-th sticky left-0 z-10 bg-[#121212]"><HeaderLabel label="综合质量 / 当前条件" help="综合质量结合近90天费率与持续性、标的匹配、当前流动性与容量、成本和数据状态；当前条件反映最新资金费率、即时基差、报价和容量。两者互不替代。" align="left" /></th>
            <th className="xh-th">做多</th>
            <th className="xh-th">做空</th>
            <th className="xh-th text-center"><HeaderLabel label="类型 / 匹配" help="同所中性仅包含同一交易所、同一资产的现货多头与永续空头；跨所套利沿用原跨交易所组合。精确匹配为同一资产，其他组合仍存在指数或代理标的风险。" /></th>
            <th className="xh-th text-center"><HeaderLabel label="当前费率差" help="按两腿最新资金费率折算的年化毛收益差，未扣除交易成本。" /></th>
            <th className="xh-th text-center"><HeaderLabel label="近90天费率差" help="两腿最近90天逐日对齐后的平均资金费率差，再按365天年化；未扣除交易成本。" /></th>
            <th className="xh-th text-center"><HeaderLabel label={`估算净 ${yieldMetric.toUpperCase()}`} help={yieldMetric === "apr" ? `近90天费率差扣除按${holdingDays}天持有测算情景摊销的往返费用与1万美元档滑点后年化。` : `由估算净APR按${holdingDays}天再投资周期假设复利换算；不代表实际可持续复投收益。`} /></th>
            <th className="xh-th text-center"><span className="sr-only">详情</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {opportunities.map((opportunity) => (
            <OpportunityRow
              key={opportunity.id}
              opportunity={opportunity}
              holdingDays={holdingDays}
              yieldMetric={yieldMetric}
              onAnalyze={onAnalyze}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});

const OpportunityRow = memo(function OpportunityRow({ opportunity, holdingDays, yieldMetric, onAnalyze }: {
  opportunity: ArbitrageOpportunity;
  holdingDays: number;
  yieldMetric: ArbitrageYieldMetric;
  onAnalyze: (opportunity: ArbitrageOpportunity) => void;
}) {
  const displayedYield = equivalentNetYield(opportunity.netApr, holdingDays, yieldMetric);
  return (
    <tr
      aria-label={`查看 ${opportunity.longLeg.symbol} 与 ${opportunity.shortLeg.symbol} 套利分析`}
      className="cursor-pointer transition hover:bg-white/[0.035] focus-visible:bg-white/[0.035] focus-visible:outline focus-visible:outline-1 focus-visible:outline-inset focus-visible:outline-white"
      onClick={() => onAnalyze(opportunity)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onAnalyze(opportunity);
      }}
      tabIndex={0}
    >
      <td className="sticky left-0 z-[1] bg-black px-5 py-4">
        <div className="flex flex-col items-start gap-1.5">
          {opportunity.freshness === "STALE" ? <span className="text-xs text-amber-300">历史机会 · 更新未完成</span> : <>
            <RecommendationBadge recommendation={opportunity.recommendation} />
            <EntryStatusBadge entryStatus={opportunity.entryStatus} />
          </>}
        </div>
      </td>
      <td className="px-5 py-4"><Leg leg={opportunity.longLeg} side="long" /></td>
      <td className="px-5 py-4"><Leg leg={opportunity.shortLeg} side="short" /></td>
      <td className="px-5 py-4 text-center"><MatchBadge opportunity={opportunity} /></td>
      <td className="px-5 py-4 text-center font-mono font-normal text-muted">{formatApr(opportunity.currentGrossApr, true)}</td>
      <td className="px-5 py-4 text-center font-mono font-normal text-muted">{formatApr(opportunity.historicalGrossApr, true)}</td>
      <td className={`px-5 py-4 text-center font-mono font-semibold ${(displayedYield ?? 0) > 0 ? "text-white" : "text-red-300"}`}>
        {formatApr(displayedYield, true)}
      </td>
      <td className="px-3 py-4 text-center">
        <button
          type="button"
          className="inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap border border-white/20 px-2.5 text-xs font-medium text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white"
          aria-label={`查看 ${opportunity.longLeg.symbol} 与 ${opportunity.shortLeg.symbol} 套利分析`}
          onClick={(event) => {
            event.stopPropagation();
            onAnalyze(opportunity);
          }}
        >
          <BarChart3 aria-hidden="true" size={14} className="shrink-0" /> 查看分析
        </button>
      </td>
    </tr>
  );
});

function HeaderLabel({ label, help, align = "center" }: { label: string; help: string; align?: "left" | "center" }) {
  return (
    <span className={`flex items-center gap-1.5 ${align === "center" ? "justify-center" : "justify-start"}`}>
      <span>{label}</span>
      <ArbitrageHelp content={help} label={`查看${label}说明`} />
    </span>
  );
}

function Leg({ leg, side }: { leg: ArbitrageOpportunity["longLeg"]; side: "long" | "short" }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold ${side === "long" ? "text-emerald-300" : "text-red-300"}`}>{side === "long" ? "多" : "空"}</span>
        <span className="min-w-0 break-words font-mono text-sm font-semibold text-white">{leg.asset}</span>
      </div>
      <div className="mt-1 text-xs leading-5 text-muted">
        <p>{leg.venueLabel} · {leg.kind === "spot" ? "现货" : "永续"}</p>
        <p className="break-all font-mono">{leg.symbol}</p>
      </div>
      <LegFunding leg={leg} side={side} />
    </div>
  );
}

function LegFunding({ leg, side }: { leg: ArbitrageOpportunity["longLeg"]; side: "long" | "short" }) {
  if (leg.kind === "spot") return <p className="mt-1.5 whitespace-nowrap text-xs font-normal text-dim">无资金费率</p>;
  return (
    <div className="mt-1.5 min-w-0 font-mono text-xs tabular-nums">
      <div className="flex flex-wrap gap-x-1 gap-y-1 font-normal text-muted">
        <span className="font-sans">资金费率</span>
        <span>{formatFundingRate(leg.fundingRate)}</span>
        {leg.fundingIntervalHours ? <span>/ {formatInterval(leg.fundingIntervalHours)} 小时</span> : null}
      </div>
      {side === "long" ? <p className="mt-1 font-sans text-muted">{fundingDirection(leg.fundingRate, side)}</p> : null}
      <p className="mt-1 whitespace-nowrap font-normal text-muted">当前 APR {formatApr(leg.currentFundingApr, true)}</p>
      <p className="mt-1.5 whitespace-nowrap font-normal">
        <FundingCountdown nextFundingTime={leg.nextFundingTime} />
      </p>
    </div>
  );
}

function fundingDirection(rate: number | null, side: "long" | "short") {
  if (rate === null || rate === 0) return "方向待更新";
  if (side === "long") return rate > 0 ? "多方支付" : "多方收取";
  return rate > 0 ? "空方收取" : "空方支付";
}

function formatInterval(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function MatchBadge({ opportunity }: { opportunity: ArbitrageOpportunity }) {
  const className = opportunity.matchQuality === "exact"
    ? "border-emerald-400/30 text-emerald-200"
    : opportunity.matchQuality === "oracle"
      ? "border-sky-400/30 text-sky-200"
      : "border-amber-400/30 text-amber-200";
  const strategyClassName = opportunity.strategyType === "same_venue_neutral"
    ? "border-violet-400/30 text-violet-200"
    : "border-sky-400/30 text-sky-200";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className={`inline-flex whitespace-nowrap border px-2.5 py-1 text-xs ${strategyClassName}`}>{opportunity.strategyLabel}</span>
      <span className={`inline-flex whitespace-nowrap border px-2.5 py-1 text-xs ${className}`}>{opportunity.matchLabel}</span>
    </div>
  );
}

function RecommendationBadge({ recommendation }: { recommendation: ArbitrageOpportunity["recommendation"] }) {
  const labels = {
    recommended: "综合质量：高",
    watch: "综合质量：中",
    neutral: "综合质量：低",
    blocked: "综合质量：无法评估",
  };
  const className = recommendation === "recommended"
    ? "text-emerald-300"
    : recommendation === "watch"
      ? "text-amber-300"
      : recommendation === "blocked"
        ? "text-red-300"
        : "text-muted";
  return <span className={`inline-flex whitespace-nowrap text-xs font-semibold ${className}`}>{labels[recommendation]}</span>;
}

function EntryStatusBadge({ entryStatus }: { entryStatus: ArbitrageOpportunity["entryStatus"] }) {
  const labels = {
    favorable: "当前条件：满足",
    cautious: "当前条件：部分满足",
    waiting: "当前费率差：未转正",
    blocked: "当前条件：无法评估",
  };
  const className = entryStatus === "favorable"
    ? "border-emerald-400/30 text-emerald-200"
    : entryStatus === "cautious"
      ? "border-amber-400/30 text-amber-200"
      : entryStatus === "blocked"
        ? "border-red-400/30 text-red-200"
        : "border-white/15 text-muted";
  return <span className={`inline-flex whitespace-nowrap border px-2 py-1 text-[11px] font-normal ${className}`}>{labels[entryStatus]}</span>;
}
