import type { FundingOpportunityView } from "../model/types";
import {
  confidenceLabel,
  formatRate,
  formatTime,
  venueLabel,
} from "../lib/opportunityViews";

type FundingOpportunityTableProps = {
  opportunities: readonly FundingOpportunityView[];
};

export function FundingOpportunityTable({ opportunities }: FundingOpportunityTableProps) {
  if (opportunities.length === 0) {
    return (
      <div className="border border-line bg-black px-5 py-14 text-center">
        <p className="text-sm font-medium text-white">当前没有资金费率套利机会</p>
        <p className="mt-2 text-xs text-muted">调整筛选条件或等待下一次只读快照更新。</p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-auto border border-line bg-black [contain:paint]">
      <table className="xh-table min-w-[1040px] table-fixed">
        <colgroup>
          <col className="w-[150px]" />
          <col className="w-[180px]" />
          <col className="w-[180px]" />
          <col className="w-[150px]" />
          <col className="w-[150px]" />
          <col className="w-[170px]" />
          <col className="w-[120px]" />
          <col className="w-[170px]" />
        </colgroup>
        <thead className="xh-thead">
          <tr>
            <th className="xh-th text-left">交易对</th>
            <th className="xh-th">Long venue</th>
            <th className="xh-th">Short venue</th>
            <th className="xh-th text-center">Funding Spread</th>
            <th className="xh-th text-center">Estimated Cost</th>
            <th className="xh-th text-center">Estimated Net Yield</th>
            <th className="xh-th text-center">Confidence</th>
            <th className="xh-th text-center">Expiry</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {opportunities.map((opportunity) => (
            <tr className="hover:bg-white/[0.025]" key={`${opportunity.symbol}:${opportunity.longVenue}:${opportunity.shortVenue}`}>
              <td className="px-5 py-4 font-mono text-sm font-semibold text-white">{opportunity.symbol}</td>
              <td className="px-5 py-4">
                <VenueDirection tone="long" venue={opportunity.longVenue} />
              </td>
              <td className="px-5 py-4">
                <VenueDirection tone="short" venue={opportunity.shortVenue} />
              </td>
              <td className="px-5 py-4 text-center font-mono text-sm text-muted">{formatRate(opportunity.fundingSpread, true)}</td>
              <td className="px-5 py-4 text-center font-mono text-sm text-muted">{formatRate(opportunity.estimatedCost)}</td>
              <td className={`px-5 py-4 text-center font-mono text-sm font-semibold ${opportunity.estimatedNetYield > 0 ? "text-emerald-200" : "text-red-300"}`}>
                {formatRate(opportunity.estimatedNetYield, true)}
              </td>
              <td className="px-5 py-4 text-center">
                <ConfidenceBadge confidence={opportunity.confidence} />
              </td>
              <td className="px-5 py-4 text-center font-mono text-xs text-muted">{formatTime(opportunity.expiresAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VenueDirection({ tone, venue }: { tone: "long" | "short"; venue: FundingOpportunityView["longVenue"] }) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-2">
      <span className={`text-xs font-semibold ${tone === "long" ? "text-emerald-300" : "text-red-300"}`}>
        {tone === "long" ? "Long" : "Short"}
      </span>
      <span className="truncate text-sm text-white">{venueLabel(venue)}</span>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: FundingOpportunityView["confidence"] }) {
  const className = confidence === "high"
    ? "border-emerald-400/30 text-emerald-200"
    : confidence === "medium"
      ? "border-amber-400/30 text-amber-200"
      : "border-white/15 text-muted";
  return (
    <span className={`inline-flex min-w-12 justify-center whitespace-nowrap border px-2 py-1 text-xs ${className}`}>
      {confidenceLabel(confidence)}
    </span>
  );
}
