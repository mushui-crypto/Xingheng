import { ChevronDown, ChevronUp, ShieldAlert } from "lucide-react";
import type { ArbitrageOpportunity, ArbitrageYieldMetric } from "../model/types";
import { equivalentNetYield, formatApr, formatBps, formatFundingRate, formatRatio, formatUsd } from "../lib/formatters";
import { ArbitrageHelp } from "./ArbitrageHelp";
import { FundingCountdown, useFundingClock } from "./FundingCountdown";

type ArbitrageOpportunityTableProps = {
  opportunities: ArbitrageOpportunity[];
  holdingDays: number;
  yieldMetric: ArbitrageYieldMetric;
  expandedId: string | null;
  onToggle: (id: string) => void;
};

export function ArbitrageOpportunityTable({ opportunities, holdingDays, yieldMetric, expandedId, onToggle }: ArbitrageOpportunityTableProps) {
  const now = useFundingClock();
  if (opportunities.length === 0) {
    return (
      <div className="border border-line bg-black px-5 py-14 text-center">
        <p className="text-sm font-medium text-white">没有符合筛选条件的套利组合</p>
        <p className="mt-2 text-xs text-muted">调整资产或交易所筛选条件后重试。</p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-auto border border-line bg-black [contain:paint]">
      <table className="xh-table min-w-[1600px]">
        <thead className="xh-thead">
          <tr>
            <th className="xh-th sticky left-0 z-10 bg-[#121212]"><HeaderLabel label="评分" help="综合等效净APR、持续性、标的匹配、流动性、成本和可靠性计算，满分100分。" /></th>
            <th className="xh-th">做多</th>
            <th className="xh-th">做空</th>
            <th className="xh-th"><HeaderLabel label="匹配" help="精确匹配为同一资产；同类黄金指数可能使用不同价格源；关联标的包含代币化黄金与黄金指数之间的跟踪差异。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="当前费率差" help="按两腿最新资金费率折算的年化毛收益差，未扣除交易成本。" align="right" /></th>
            <th className="xh-th text-right"><HeaderLabel label="近90天费率差" help="两腿最近90天逐日对齐后的平均资金费率差，再按365天年化；未扣除交易成本。" align="right" /></th>
            <th className="xh-th text-right"><HeaderLabel label={`等效净 ${yieldMetric.toUpperCase()}`} help={yieldMetric === "apr" ? `近90天费率差扣除按${holdingDays}天持有期摊销的往返费用与1万美元档滑点后年化。` : `由等效净APR按${holdingDays}天为一个再投资周期复利换算；不代表实际可持续复投收益。`} align="right" /></th>
            <th className="xh-th text-right"><HeaderLabel label="往返成本" help="两腿开仓和平仓的Taker手续费，加上按1万美元订单簿深度估算的双向滑点。" align="right" /></th>
            <th className="xh-th text-right"><HeaderLabel label="入场基差" help="做空腿Bid与做多腿Ask之间的即时价格差，以两者中间价折算为bps；正值通常更有利。" align="right" /></th>
            <th className="xh-th text-right"><HeaderLabel label="容量" help="两腿订单簿可用美元深度的较小值，仅作流动性参考，不等于保证成交规模。" align="right" /></th>
            <th className="xh-th"><HeaderLabel label="结论" help="75分及以上为优选，60–74分为关注，低于60分为观察；关联标的会因匹配风险少得分，但达到门槛后同样可以进入优选。硬性条件不满足时不可执行。" /></th>
            <th className="xh-th"><span className="sr-only">详情</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {opportunities.map((opportunity) => {
            const expanded = expandedId === opportunity.id;
            return (
              <OpportunityRows
                key={opportunity.id}
                opportunity={opportunity}
                holdingDays={holdingDays}
                yieldMetric={yieldMetric}
                now={now}
                expanded={expanded}
                onToggle={() => onToggle(opportunity.id)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OpportunityRows({ opportunity, holdingDays, yieldMetric, now, expanded, onToggle }: {
  opportunity: ArbitrageOpportunity;
  holdingDays: number;
  yieldMetric: ArbitrageYieldMetric;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const displayedYield = equivalentNetYield(opportunity.netApr, holdingDays, yieldMetric);
  return (
    <>
      <tr className="hover:bg-white/[0.025]">
        <td className="sticky left-0 z-[1] bg-black px-5 py-4">
          <ScoreBadge score={opportunity.score} recommendation={opportunity.recommendation} />
        </td>
        <td className="px-5 py-4"><Leg leg={opportunity.longLeg} side="long" now={now} /></td>
        <td className="px-5 py-4"><Leg leg={opportunity.shortLeg} side="short" now={now} /></td>
        <td className="px-5 py-4"><MatchBadge opportunity={opportunity} /></td>
        <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatApr(opportunity.currentGrossApr, true)}</td>
        <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatApr(opportunity.historicalGrossApr, true)}</td>
        <td className={`px-5 py-4 text-right font-mono font-semibold ${(displayedYield ?? 0) > 0 ? "text-white" : "text-red-300"}`}>
          {formatApr(displayedYield, true)}
        </td>
        <td className="px-5 py-4 text-right font-mono font-normal text-muted">
          {formatBps(opportunity.roundTripCostBps)}
        </td>
        <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatBps(opportunity.entryBasisBps, true)}</td>
        <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatUsd(opportunity.capacityUsd)}</td>
        <td className="px-5 py-4"><RecommendationBadge recommendation={opportunity.recommendation} /></td>
        <td className="px-5 py-4 text-right">
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center border border-white/15 text-muted transition hover:border-white/40 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white"
            aria-expanded={expanded}
            aria-label={expanded ? "收起评分详情" : "展开评分详情"}
            title={expanded ? "收起详情" : "查看详情"}
            onClick={onToggle}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={12} className="bg-[#0d0d0d] px-5 py-5">
            <OpportunityDetail opportunity={opportunity} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function OpportunityDetail({ opportunity }: { opportunity: ArbitrageOpportunity }) {
  const dimensions = [
    ["等效净APR", opportunity.scoreBreakdown.netApr, 30],
    ["持续性", opportunity.scoreBreakdown.persistence, 20],
    ["标的匹配", opportunity.scoreBreakdown.matching, 15],
    ["流动性", opportunity.scoreBreakdown.liquidity, 15],
    ["成本", opportunity.scoreBreakdown.cost, 10],
    ["可靠性", opportunity.scoreBreakdown.reliability, 10],
  ] as const;
  const messages = [...opportunity.disqualifiers, ...opportunity.warnings];
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {dimensions.map(([label, value, maximum]) => (
          <div key={label}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted">{label}</span>
              <span className="font-mono font-normal text-muted">{value.toFixed(1)} / {maximum}</span>
            </div>
            <div className="mt-2 h-1.5 bg-white/10">
              <div className="h-full bg-white" style={{ width: `${Math.min(100, (value / maximum) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-line pt-4 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
        <p className="flex items-center gap-2 text-xs font-semibold text-white"><ShieldAlert size={14} /> 风险与限制</p>
        {messages.length > 0 ? (
          <ul className="mt-3 space-y-2 text-xs leading-5 text-muted">
            {[...new Set(messages)].map((message) => <li key={message}>• {message}</li>)}
          </ul>
        ) : <p className="mt-3 text-xs text-muted">当前没有额外限制。</p>}
        <p className="mt-3 text-xs text-dim">历史有利天数占比 {formatRatio(opportunity.persistenceRatio)}</p>
      </div>
    </div>
  );
}

function HeaderLabel({ label, help, align = "left" }: { label: string; help: string; align?: "left" | "right" }) {
  return (
    <span className={`flex items-center gap-1.5 ${align === "right" ? "justify-end" : "justify-start"}`}>
      <span>{label}</span>
      <ArbitrageHelp content={help} label={`查看${label}说明`} />
    </span>
  );
}

function Leg({ leg, side, now }: { leg: ArbitrageOpportunity["longLeg"]; side: "long" | "short"; now: number }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold ${side === "long" ? "text-emerald-300" : "text-red-300"}`}>{side === "long" ? "多" : "空"}</span>
        <span className="font-mono text-sm font-semibold text-white">{leg.asset}</span>
      </div>
      <p className="mt-1 whitespace-nowrap text-xs text-muted">
        {leg.venueLabel} · <span className="font-mono">{leg.symbol}</span> · {leg.kind === "spot" ? "现货" : "永续"}
      </p>
      <LegFunding leg={leg} side={side} now={now} />
    </div>
  );
}

function LegFunding({ leg, side, now }: { leg: ArbitrageOpportunity["longLeg"]; side: "long" | "short"; now: number }) {
  if (leg.kind === "spot") return <p className="mt-1.5 whitespace-nowrap text-xs font-normal text-dim">Funding 无</p>;
  return (
    <div className="mt-1.5 min-w-[210px] font-mono text-xs tabular-nums">
      <p className="whitespace-nowrap font-normal text-muted">
        Funding {formatFundingRate(leg.fundingRate)}
        {leg.fundingIntervalHours ? ` / ${formatInterval(leg.fundingIntervalHours)}h` : ""}
        <span className="font-sans"> · {fundingDirection(leg.fundingRate, side)}</span>
      </p>
      <p className="mt-1.5 whitespace-nowrap font-normal">
        <FundingCountdown nextFundingTime={leg.nextFundingTime} now={now} />
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

function ScoreBadge({ score, recommendation }: Pick<ArbitrageOpportunity, "score" | "recommendation">) {
  const className = recommendation === "recommended"
    ? "border-emerald-400/40 bg-emerald-400/[0.1] text-white"
    : recommendation === "watch"
      ? "border-amber-400/40 bg-amber-400/[0.08] text-white"
      : recommendation === "blocked"
        ? "border-red-400/35 bg-red-400/[0.06] text-red-200"
        : "border-white/20 bg-panel2 text-white";
  return <span className={`inline-flex min-w-14 items-center justify-center border px-2.5 py-1.5 font-mono text-sm font-semibold ${className}`}>{score}</span>;
}

function MatchBadge({ opportunity }: { opportunity: ArbitrageOpportunity }) {
  const className = opportunity.matchQuality === "exact"
    ? "border-emerald-400/30 text-emerald-200"
    : opportunity.matchQuality === "oracle"
      ? "border-sky-400/30 text-sky-200"
      : "border-amber-400/30 text-amber-200";
  return <span className={`inline-flex whitespace-nowrap border px-2.5 py-1 text-xs ${className}`}>{opportunity.matchLabel}</span>;
}

function RecommendationBadge({ recommendation }: { recommendation: ArbitrageOpportunity["recommendation"] }) {
  const labels = { recommended: "优选", watch: "关注", neutral: "观察", blocked: "不可执行" };
  const className = recommendation === "recommended"
    ? "text-emerald-300"
    : recommendation === "watch"
      ? "text-amber-300"
      : recommendation === "blocked"
        ? "text-red-300"
        : "text-muted";
  return <span className={`whitespace-nowrap text-xs font-semibold ${className}`}>{labels[recommendation]}</span>;
}
