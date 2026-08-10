import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFundingArbitrageOpportunities } from "../../api/fundingArbitrage";
import { DropdownSelect } from "../../components/ui/DropdownSelect";
import { FundingOpportunityTable } from "../../features/fundingArbitrage/components/FundingOpportunityTable";
import {
  filterFundingOpportunities,
  sortFundingOpportunities,
  venueLabel,
  venueOptions,
} from "../../features/fundingArbitrage/lib/opportunityViews";
import type {
  FundingOpportunityConfidence,
  FundingOpportunitySnapshot,
  FundingOpportunitySort,
  FundingOpportunityVenue,
} from "../../features/fundingArbitrage/model/types";

type VenueFilter = FundingOpportunityVenue | "all";
type ConfidenceFilter = FundingOpportunityConfidence | "all";

const sortOptions: Array<{ value: FundingOpportunitySort; label: string }> = [
  { value: "estimatedNetYield", label: "净收益优先" },
  { value: "confidence", label: "置信度优先" },
  { value: "expiresAt", label: "过期时间优先" },
];
const confidenceOptions: Array<{ value: ConfidenceFilter; label: string }> = [
  { value: "all", label: "Confidence-全部" },
  { value: "high", label: "Confidence-高" },
  { value: "medium", label: "Confidence-中" },
  { value: "low", label: "Confidence-低" },
];
const allVenues: FundingOpportunityVenue[] = ["binance", "okx", "bybit", "bitget"];

export function FundingArbitrageOpportunitiesPage() {
  const [snapshot, setSnapshot] = useState<FundingOpportunitySnapshot | null>(null);
  const [sort, setSort] = useState<FundingOpportunitySort>("estimatedNetYield");
  const [confidence, setConfidence] = useState<ConfidenceFilter>("all");
  const [longVenue, setLongVenue] = useState<VenueFilter>("all");
  const [shortVenue, setShortVenue] = useState<VenueFilter>("all");
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      setSnapshot(await fetchFundingArbitrageOpportunities({ sort, confidence, symbol }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "资金费率套利机会加载失败。");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [confidence, sort, symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  const opportunities = useMemo(() => {
    const source = snapshot?.opportunities ?? [];
    return sortFundingOpportunities(filterFundingOpportunities(source, {
      confidence,
      longVenue,
      shortVenue,
      symbol,
    }), sort);
  }, [confidence, longVenue, shortVenue, snapshot, sort, symbol]);

  const longVenueOptions = useMemo(() => buildVenueOptions(
    "Long-全部交易所",
    snapshot ? venueOptions(snapshot.opportunities, "long") : null,
  ), [snapshot]);
  const shortVenueOptions = useMemo(() => buildVenueOptions(
    "Short-全部交易所",
    snapshot ? venueOptions(snapshot.opportunities, "short") : null,
  ), [snapshot]);

  useEffect(() => {
    if (!longVenueOptions.some((option) => option.value === longVenue)) setLongVenue("all");
    if (!shortVenueOptions.some((option) => option.value === shortVenue)) setShortVenue("all");
  }, [longVenue, longVenueOptions, shortVenue, shortVenueOptions]);

  return (
    <div className="xh-page w-full min-w-0 max-w-full px-4 py-5 md:px-8 md:py-7">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">资金费率机会</h1>
            <span className="inline-flex border border-sky-400/30 bg-sky-400/[0.07] px-2.5 py-1 text-xs font-medium text-sky-200">只读 · Opportunity Discovery</span>
          </div>
          <p className="xh-subtitle">基于 FundingSpreadPlan 展示多交易所永续资金费率差；当前页面不生成订单，也不触发自动执行。</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>{snapshot ? `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待数据"}</span>
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center border border-white/20 text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
            aria-label="刷新资金费率套利机会"
            title="刷新机会"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} size={16} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="flex items-center justify-between gap-4 border border-red-400/35 bg-black px-4 py-3 text-sm text-red-200">
          <span>{error}</span>
          <button className="shrink-0 font-semibold text-white hover:underline" type="button" onClick={() => void load(true)}>重试</button>
        </div>
      ) : null}

      <section className="w-full min-w-0 max-w-full space-y-4">
        <div className="flex flex-col gap-3 border-y border-line py-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              aria-label="筛选交易对"
              className="h-10 w-[168px] border border-line bg-black px-3 text-sm font-normal text-[#b7bcc4] outline-none transition placeholder:text-dim hover:border-white/35 focus:border-white/60 focus:ring-1 focus:ring-white/25"
              placeholder="Symbol"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            />
            <DropdownSelect
              className="w-[156px]"
              value={confidence}
              options={confidenceOptions}
              onChange={setConfidence}
              label="筛选 Confidence"
            />
            <DropdownSelect
              className="w-[164px]"
              value={longVenue}
              options={longVenueOptions}
              onChange={setLongVenue}
              label="筛选 Long venue"
            />
            <DropdownSelect
              className="w-[164px]"
              value={shortVenue}
              options={shortVenueOptions}
              onChange={setShortVenue}
              label="筛选 Short venue"
            />
          </div>
          <DropdownSelect
            className="w-[156px]"
            value={sort}
            options={sortOptions}
            onChange={setSort}
            label="机会排序"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p>{opportunities.length} 个 FundingSpreadPlan 机会</p>
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} />
            <span>只读评估结果，不包含数量、价格或订单指令。</span>
          </div>
        </div>

        {loading && !snapshot ? <TableSkeleton /> : <FundingOpportunityTable opportunities={opportunities} />}
      </section>
    </div>
  );
}

function buildVenueOptions(
  allLabel: string,
  available: Set<FundingOpportunityVenue> | null,
): Array<{ value: VenueFilter; label: string }> {
  return [
    { value: "all", label: allLabel },
    ...allVenues
      .filter((venue) => !available || available.has(venue))
      .map((venue) => ({ value: venue, label: venueLabel(venue) })),
  ];
}

function TableSkeleton() {
  return (
    <div className="animate-pulse border border-line bg-black">
      <div className="h-11 border-b border-line bg-white/[0.03]" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex h-16 items-center gap-8 border-b border-line px-5 last:border-b-0">
          <div className="h-4 w-24 bg-white/10" />
          <div className="h-4 w-28 bg-white/10" />
          <div className="h-4 w-28 bg-white/5" />
          <div className="ml-auto h-4 w-24 bg-white/10" />
        </div>
      ))}
    </div>
  );
}
