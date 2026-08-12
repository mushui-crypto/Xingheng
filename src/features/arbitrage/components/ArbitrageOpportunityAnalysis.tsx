import { AlertTriangle, ShieldAlert } from "lucide-react";
import type {
  ArbitrageMarket,
  ArbitrageOpportunity,
} from "../model/types";
import {
  equivalentNetYield,
  formatApr,
  formatBps,
  formatFundingRate,
  formatRatio,
  formatUsd,
} from "../lib/formatters";
import { buildOpportunityFactors, type OpportunityFactor } from "../lib/opportunityFactors";
import { ArbitrageHelp } from "./ArbitrageHelp";
import { ArbitrageMarketTable } from "./ArbitrageMarketTable";
import { FundingCountdown } from "./FundingCountdown";

type ArbitrageOpportunityAnalysisProps = {
  opportunity: ArbitrageOpportunity;
  longMarket: ArbitrageMarket | null;
  shortMarket: ArbitrageMarket | null;
  holdingDays: 90 | 365;
};

const scoreLabels: Record<keyof ArbitrageOpportunity["scoreBreakdown"], string> = {
  conservativeNetReturn: "保守净收益",
  driverStrength: "驱动强度",
  persistence: "持续性",
  costEfficiency: "成本效率",
  liquidity: "流动性",
  confidence: "比较置信度",
};

export function ArbitrageOpportunityAnalysis({
  opportunity,
  longMarket,
  shortMarket,
  holdingDays,
}: ArbitrageOpportunityAnalysisProps) {
  const factors = buildOpportunityFactors(opportunity);
  const estimatedApy = equivalentNetYield(opportunity.netApr, holdingDays, "apy");
  const markets = [longMarket, shortMarket].filter((market): market is ArbitrageMarket => market !== null);

  return (
    <div className="space-y-6">
      <section className="space-y-4" aria-labelledby="analysis-summary-title">
        <SectionTitle id="analysis-summary-title" title="机会摘要" description="展示当前两腿市场与可比较的估算指标，不构成交易建议。" />
        <div className="grid gap-3 lg:grid-cols-2">
          <LegSummary leg={opportunity.longLeg} side="long" />
          <LegSummary leg={opportunity.shortLeg} side="short" />
        </div>
        <MetricGrid>
          <Metric label="套利类型" value={`${opportunity.strategyLabel} · ${opportunity.matchLabel}`} />
          <Metric label="当前费率差" value={formatApr(opportunity.currentGrossApr, true)} />
          <Metric label="估算净 APR" value={formatApr(opportunity.netApr, true)} />
          <Metric label="估算净 APY" value={formatApr(estimatedApy, true)} />
          <Metric label="入场基差" value={formatBps(opportunity.entryBasisBps, true)} />
          <Metric label="参考容量" value={formatUsd(opportunity.capacityUsd)} />
        </MetricGrid>
      </section>

      <section className="space-y-4" aria-labelledby="holding-scenario-title">
        <SectionTitle
          id="holding-scenario-title"
          title="持有测算"
          description={`${holdingDays} 天仅用于收益测算、成本摊销和复利情景，不代表建议持有期限。`}
        />
        <MetricGrid>
          <Metric label="持有测算情景" value={`${holdingDays} 天`} />
          <Metric label="估算净 APR" value={formatApr(opportunity.netApr, true)} />
          <Metric label="估算净 APY" value={formatApr(estimatedApy, true)} />
          <Metric label="年化交易成本" value={formatApr(opportunity.annualizedTradingCostApr)} />
        </MetricGrid>
      </section>

      <section className="space-y-4" aria-labelledby="historical-funding-title">
        <SectionTitle id="historical-funding-title" title="历史资金费率" description="历史指标基于现有近 90 天公开资金费率数据。" />
        <MetricGrid>
          <Metric label="近 90 天费率差" value={formatApr(opportunity.historicalGrossApr, true)} />
          <Metric label="历史有利天数" value={formatRatio(opportunity.persistenceRatio)} />
          <HistoricalFundingMetrics label="做多腿" market={longMarket} />
          <HistoricalFundingMetrics label="做空腿" market={shortMarket} />
        </MetricGrid>
      </section>

      <section className="space-y-4" aria-labelledby="cost-analysis-title">
        <SectionTitle id="cost-analysis-title" title="成本与流动性" description="成本数据沿用套利看板现有手续费、盘口和滑点口径。" />
        <MetricGrid>
          <Metric label="往返成本" value={formatBps(opportunity.roundTripCostBps)} />
          <MarketCostMetrics label="做多腿" market={longMarket} />
          <MarketCostMetrics label="做空腿" market={shortMarket} />
        </MetricGrid>
      </section>

      <section className="space-y-4" aria-labelledby="market-comparison-title">
        <SectionTitle id="market-comparison-title" title="两腿市场对比" description="只展示当前机会对应的做多和做空市场。" />
        <MetricGrid>
          <MarketActivityMetrics label="做多腿" market={longMarket} />
          <MarketActivityMetrics label="做空腿" market={shortMarket} />
        </MetricGrid>
        {markets.length > 0 ? (
          <ArbitrageMarketTable markets={markets} />
        ) : (
          <InlineNotice text="当前快照中未找到对应市场详情。" />
        )}
      </section>

      <section className="space-y-4" aria-labelledby="comprehensive-analysis-title">
        <SectionTitle id="comprehensive-analysis-title" title="综合分析" description="综合质量结合历史表现、匹配、成本、流动性和数据状态。" />
        <MetricGrid>
          <Metric label="综合质量" value={recommendationLabel(opportunity.recommendation)} />
          <Metric label="综合质量评分" value={`${opportunity.historicalQualityScore} 分`} />
          <Metric label="比较置信度" value={confidenceLabel(opportunity.confidence)} />
          <Metric label="机会驱动" value={opportunity.opportunityDriverLabel} />
        </MetricGrid>

        <div className="border border-line bg-black">
          <div className="border-b border-line px-4 py-3 text-xs font-semibold text-white">分析因子</div>
          <div className="grid sm:grid-cols-2">
            {factors.map((factor) => <OpportunityFactorRow factor={factor} key={factor.label} />)}
          </div>
        </div>

        <div className="border border-line bg-black">
          <div className="border-b border-line px-4 py-3 text-xs font-semibold text-white">评分构成</div>
          <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(opportunity.scoreBreakdown).map(([key, value]) => (
              <Metric
                key={key}
                label={scoreLabels[key as keyof ArbitrageOpportunity["scoreBreakdown"]]}
                value={`${value} 分`}
              />
            ))}
          </div>
        </div>

        <RiskMessages opportunity={opportunity} />
      </section>
    </div>
  );
}

function LegSummary({ leg, side }: {
  leg: ArbitrageOpportunity["longLeg"];
  side: "long" | "short";
}) {
  const direction = side === "long" ? "做多" : "做空";
  return (
    <div className="border border-line bg-black p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={`text-xs font-semibold ${side === "long" ? "text-emerald-300" : "text-red-300"}`}>{direction}</p>
          <p className="mt-1 font-mono text-sm font-semibold text-white">{leg.venueLabel} · {leg.symbol}</p>
          <p className="mt-1 text-xs text-muted">{leg.kind === "spot" ? "现货" : "永续"} · {leg.quoteAsset} 报价 · {leg.settlementAsset} 结算</p>
        </div>
        <div className="text-right font-mono text-xs text-muted">
          {leg.kind === "spot" ? (
            <p>无资金费率</p>
          ) : (
            <>
              <p>资金费率（Funding） {formatFundingRate(leg.fundingRate)}{leg.fundingIntervalHours ? ` / ${formatInterval(leg.fundingIntervalHours)} 小时` : ""}</p>
              <p className="mt-1">当前 APR {formatApr(leg.currentFundingApr, true)}</p>
              <p className="mt-1"><FundingCountdown nextFundingTime={leg.nextFundingTime} /></p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoricalFundingMetrics({ label, market }: { label: string; market: ArbitrageMarket | null }) {
  if (!market) return <Metric label={`${label}历史数据`} value="市场详情不可用" />;
  if (market.kind === "spot") return <Metric label={`${label}历史资金费率`} value="现货无资金费率" />;
  return (
    <Metric
      label={`${label}历史资金费率`}
      value={`${formatApr(market.historicalFundingApr, true)} · 正费率 ${formatRatio(market.fundingPositiveRatio)} · 覆盖 ${formatRatio(market.fundingCoverageRatio)}`}
    />
  );
}

function MarketCostMetrics({ label, market }: { label: string; market: ArbitrageMarket | null }) {
  if (!market) return <Metric label={`${label}成本`} value="市场详情不可用" />;
  return (
    <Metric
      label={`${label}成本`}
      value={`吃单费 ${formatBps(market.takerFeeBps)} · 1 万美元滑点 ${formatBps(market.slippageBps10k)} · 10 万美元滑点 ${formatBps(market.slippageBps100k)}`}
    />
  );
}

function MarketActivityMetrics({ label, market }: { label: string; market: ArbitrageMarket | null }) {
  if (!market) return <Metric label={`${label}市场活动`} value="市场详情不可用" />;
  return (
    <Metric
      label={`${label}市场活动`}
      value={`点差 ${formatBps(market.spreadBps)} · 深度 ${formatUsd(market.depthUsd)} · 24小时成交额 ${formatUsd(market.volume24h)} · 未平仓量 ${market.openInterest === null ? "-" : String(market.openInterest)}`}
    />
  );
}

function RiskMessages({ opportunity }: { opportunity: ArbitrageOpportunity }) {
  const messages = [...new Set([...opportunity.disqualifiers, ...opportunity.warnings])];
  return (
    <div className="border border-line bg-black p-4">
      <p className="flex items-center gap-2 text-xs font-semibold text-white"><ShieldAlert size={14} /> 风险与限制</p>
      {messages.length > 0 ? (
        <ul className="mt-3 space-y-2 text-xs leading-5 text-muted">
          {messages.map((message) => <li key={message}>• {message}</li>)}
        </ul>
      ) : <p className="mt-3 text-xs text-muted">当前没有额外限制。</p>}

      <div className="mt-4 border-t border-line pt-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">自动执行条件（旧规则）</span>
          <span className={opportunity.automationEligible ? "text-emerald-300" : "text-amber-300"}>
            {opportunity.automationEligible ? "条件匹配" : "条件未完全匹配"}
          </span>
          <ArbitrageHelp
            content="这是旧版自动执行规则的条件状态，仅供分析说明，不代表当前系统会自动执行。"
            label="查看旧规则自动执行条件说明"
          />
        </div>
        <p className="mt-2 leading-5 text-dim">旧规则条件仅供分析说明，不代表当前系统会自动执行。</p>
        {!opportunity.automationEligible && opportunity.automationDisqualifiers.length > 0 ? (
          <ul className="mt-2 space-y-1 leading-5 text-dim">
            {opportunity.automationDisqualifiers.map((message) => <li key={message}>• {message}</li>)}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function OpportunityFactorRow({ factor }: { factor: OpportunityFactor }) {
  const toneClass = factor.tone === "positive"
    ? "text-emerald-300"
    : factor.tone === "negative" ? "text-red-300" : "text-muted";
  const toneLabel = factor.tone === "positive" ? "有利" : factor.tone === "negative" ? "不利" : "中性";
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b border-line px-4 py-3 odd:sm:border-r">
      <span className="shrink-0 text-xs text-dim">{factor.label}</span>
      <span className={`min-w-0 text-right text-xs leading-5 ${toneClass}`} title={factor.value}>
        <span className="mr-1.5 whitespace-nowrap">[{toneLabel}]</span>{factor.value}
      </span>
    </div>
  );
}

function SectionTitle({ description, id, title }: { description: string; id: string; title: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <h2 className="text-sm font-semibold text-white" id={id}>{title}</h2>
      <p className="text-xs leading-5 text-muted">{description}</p>
    </div>
  );
}

function MetricGrid({ children }: { children: import("react").ReactNode }) {
  return <div className="grid gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-black px-4 py-3">
      <p className="text-[11px] text-dim">{label}</p>
      <p className="mt-1 break-words font-mono text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function InlineNotice({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-100">
      <AlertTriangle size={14} /> {text}
    </div>
  );
}

function recommendationLabel(recommendation: ArbitrageOpportunity["recommendation"]) {
  return recommendation === "recommended" ? "高"
    : recommendation === "watch" ? "中"
      : recommendation === "neutral" ? "低"
        : "无法评估";
}

function confidenceLabel(confidence: ArbitrageOpportunity["confidence"]) {
  return confidence === "high" ? "高" : confidence === "medium" ? "中" : "低";
}

function formatInterval(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}
