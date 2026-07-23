import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchArbitrageDashboard } from "../../api/arbitrage";
import { HttpRequestError } from "../../api/httpClient";
import { DropdownSelect } from "../../components/ui/DropdownSelect";
import { ArbitrageMarketTable } from "../../features/arbitrage/components/ArbitrageMarketTable";
import { ArbitrageOpportunityTable } from "../../features/arbitrage/components/ArbitrageOpportunityTable";
import { ArbitrageHelp } from "../../features/arbitrage/components/ArbitrageHelp";
import { ArbitrageSummaryBar } from "../../features/arbitrage/components/ArbitrageSummaryBar";
import { equivalentNetYield } from "../../features/arbitrage/lib/formatters";
import {
  matchesOpportunityEntryStatus,
  matchesOpportunityRecommendation,
  matchesOpportunityVenue,
  opportunityLegVenues,
} from "../../features/arbitrage/lib/opportunityFilters";
import type {
  ArbitrageAsset,
  ArbitrageDashboardSnapshot,
  ArbitrageEntryStatus,
  ArbitrageHorizon,
  ArbitrageRecommendation,
  ArbitrageVenue,
  ArbitrageYieldMetric,
} from "../../features/arbitrage/model/types";
import { ARBITRAGE_ASSET_ORDER } from "../../features/arbitrage/model/types";

type BoardView = "markets" | "opportunities";
type OpportunitySort = "score" | "netApr";
type AssetFilter = "all" | ArbitrageAsset;
type VenueFilter = "all" | ArbitrageVenue;
type RecommendationFilter = "all" | ArbitrageRecommendation;
type EntryStatusFilter = "all" | ArbitrageEntryStatus;

const horizons: ArbitrageHorizon[] = [90, 365];
const assetRank = new Map(ARBITRAGE_ASSET_ORDER.map((value, index) => [value, index]));
const venues: Array<{ value: ArbitrageVenue; label: string }> = [
  { value: "binance", label: "Binance" },
  { value: "bybit", label: "Bybit" },
  { value: "bitget", label: "Bitget" },
  { value: "okx", label: "OKX" },
  { value: "tradexyz", label: "tradeXYZ" },
];
const recommendationLabels: Record<ArbitrageRecommendation, string> = {
  recommended: "持有逻辑较强",
  watch: "值得持续关注",
  neutral: "历史优势有限",
  blocked: "无法安全评估",
};
const recommendationOptions: Array<{ value: RecommendationFilter; label: string }> = [
  { value: "all", label: "持有质量-全部" },
  ...Object.entries(recommendationLabels).map(([value, label]) => ({
    value: value as ArbitrageRecommendation,
    label,
  })),
];
const entryStatusLabels: Record<ArbitrageEntryStatus, string> = {
  favorable: "当前条件较好",
  cautious: "谨慎评估入场",
  waiting: "等待费率差转正",
  blocked: "当前不可执行",
};
const entryStatusOptions: Array<{ value: EntryStatusFilter; label: string }> = [
  { value: "all", label: "当前入场-全部" },
  ...Object.entries(entryStatusLabels).map(([value, label]) => ({
    value: value as ArbitrageEntryStatus,
    label,
  })),
];
const opportunityPageSize = 25;

export function ArbitragePage() {
  const [horizonDays, setHorizonDays] = useState<ArbitrageHorizon>(90);
  const [yieldMetric, setYieldMetric] = useState<ArbitrageYieldMetric>("apr");
  const [view, setView] = useState<BoardView>("opportunities");
  const [sort, setSort] = useState<OpportunitySort>("score");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [recommendation, setRecommendation] = useState<RecommendationFilter>("all");
  const [entryStatus, setEntryStatus] = useState<EntryStatusFilter>("all");
  const [longVenue, setLongVenue] = useState<VenueFilter>("all");
  const [shortVenue, setShortVenue] = useState<VenueFilter>("all");
  const [marketVenue, setMarketVenue] = useState<VenueFilter>("all");
  const [snapshot, setSnapshot] = useState<ArbitrageDashboardSnapshot | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [opportunityPage, setOpportunityPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const assetOptions = useMemo<Array<{ value: AssetFilter; label: string }>>(() => {
    const available = new Set(snapshot?.markets.map((market) => market.asset) ?? ARBITRAGE_ASSET_ORDER);
    return [
      { value: "all", label: "全部资产" },
      ...ARBITRAGE_ASSET_ORDER.filter((value) => available.has(value)).map((value) => ({ value, label: value })),
    ];
  }, [snapshot]);

  const longVenueOptions = useMemo(() => filterVenueOptions(
    "做多-全部交易所",
    snapshot ? opportunityLegVenues(snapshot.opportunities, "long") : null,
    "做多",
  ), [snapshot]);
  const shortVenueOptions = useMemo(() => filterVenueOptions(
    "做空-全部交易所",
    snapshot ? opportunityLegVenues(snapshot.opportunities, "short") : null,
    "做空",
  ), [snapshot]);
  const marketVenueOptions = useMemo(() => filterVenueOptions(
    "全部交易所",
    snapshot ? new Set(snapshot.markets.map((market) => market.venue)) : null,
  ), [snapshot]);

  const load = useCallback(async (forceRefresh = false) => {
    forceRefresh ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      setSnapshot(await fetchArbitrageDashboard(horizonDays, forceRefresh));
    } catch (loadError) {
      setError(formatArbitrageError(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [horizonDays]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filteredMarkets = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.markets
      .filter((market) => asset === "all" || market.asset === asset)
      .filter((market) => marketVenue === "all" || market.venue === marketVenue)
      .sort((left, right) =>
        (assetRank.get(left.asset) ?? 99) - (assetRank.get(right.asset) ?? 99)
        || left.venueLabel.localeCompare(right.venueLabel)
        || left.kind.localeCompare(right.kind),
      );
  }, [asset, marketVenue, snapshot]);

  const filteredOpportunities = useMemo(() => {
    if (!snapshot) return [];
    const opportunities = snapshot.opportunities
      .filter((item) => asset === "all" || item.longLeg.asset === asset || item.shortLeg.asset === asset)
      .filter((item) => matchesOpportunityRecommendation(item, recommendation))
      .filter((item) => matchesOpportunityEntryStatus(item, entryStatus))
      .filter((item) => matchesOpportunityVenue(item, longVenue, shortVenue));

    if (sort === "score") {
      return opportunities.sort((left, right) =>
        right.historicalQualityScore - left.historicalQualityScore || right.netApr - left.netApr,
      );
    }

    const displayedYields = new Map(opportunities.map((item) => [
      item.id,
      equivalentNetYield(item.netApr, horizonDays, yieldMetric) ?? Number.NEGATIVE_INFINITY,
    ]));
    return opportunities.sort((left, right) =>
      (displayedYields.get(right.id) ?? Number.NEGATIVE_INFINITY)
        - (displayedYields.get(left.id) ?? Number.NEGATIVE_INFINITY)
        || right.score - left.score,
    );
  }, [asset, entryStatus, horizonDays, longVenue, recommendation, shortVenue, snapshot, sort, yieldMetric]);

  const opportunityPageCount = Math.max(1, Math.ceil(filteredOpportunities.length / opportunityPageSize));
  const visibleOpportunities = useMemo(() => filteredOpportunities.slice(
    (opportunityPage - 1) * opportunityPageSize,
    opportunityPage * opportunityPageSize,
  ), [filteredOpportunities, opportunityPage]);

  const toggleOpportunity = useCallback((id: string) => {
    setExpandedId((current) => current === id ? null : id);
  }, []);

  const changeOpportunityPage = useCallback((page: number) => {
    setExpandedId(null);
    setOpportunityPage(page);
  }, []);

  useEffect(() => {
    setOpportunityPage(1);
    setExpandedId(null);
  }, [asset, entryStatus, horizonDays, longVenue, marketVenue, recommendation, shortVenue, sort, yieldMetric]);

  useEffect(() => {
    if (!longVenueOptions.some((option) => option.value === longVenue)) setLongVenue("all");
    if (!shortVenueOptions.some((option) => option.value === shortVenue)) setShortVenue("all");
    if (!marketVenueOptions.some((option) => option.value === marketVenue)) setMarketVenue("all");
  }, [longVenue, longVenueOptions, marketVenue, marketVenueOptions, shortVenue, shortVenueOptions]);

  useEffect(() => {
    if (opportunityPage > opportunityPageCount) setOpportunityPage(opportunityPageCount);
  }, [opportunityPage, opportunityPageCount]);

  return (
    <div className="xh-page w-full min-w-0 max-w-full px-4 py-5 md:px-8 md:py-7">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">套利看板</h1>
            <span className="inline-flex border border-sky-400/30 bg-sky-400/[0.07] px-2.5 py-1 text-xs font-medium text-sky-200">只读 · 主网公开行情</span>
          </div>
          <p className="xh-subtitle">分别评估中长期持有质量与当前入场时机；结论仅辅助筛选，不代替用户决策。</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>{snapshot ? `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待数据"}</span>
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center border border-white/20 text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
            aria-label="刷新套利行情"
            title="刷新行情"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} size={16} />
          </button>
        </div>
      </header>

      {snapshot ? <ArbitrageSummaryBar snapshot={snapshot} yieldMetric={yieldMetric} /> : <SummarySkeleton />}

      {snapshot?.warnings.length ? (
        <div className="flex items-start gap-3 border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <p>{snapshot.warnings.join("；")}</p>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center justify-between gap-4 border border-red-400/35 bg-black px-4 py-3 text-sm text-red-200">
          <span>{error}</span>
          <button className="shrink-0 font-semibold text-white hover:underline" type="button" onClick={() => void load(true)}>重试</button>
        </div>
      ) : null}

      <section className="w-full min-w-0 max-w-full space-y-4">
        <div className="flex flex-col gap-3 border-y border-line py-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SegmentedControl
              value={view}
              options={[{ value: "opportunities", label: "套利机会" }, { value: "markets", label: "市场对比" }]}
              onChange={(value) => setView(value as BoardView)}
              label="看板视图"
            />
            <DropdownSelect
              className="w-[132px]"
              value={asset}
              options={assetOptions}
              onChange={setAsset}
              label="筛选资产"
            />
            {view === "opportunities" ? (
              <>
                <DropdownSelect
                  className="w-[172px]"
                  value={recommendation}
                  options={recommendationOptions}
                  onChange={setRecommendation}
                  label="筛选持有质量"
                />
                <DropdownSelect
                  className="w-[166px]"
                  value={entryStatus}
                  options={entryStatusOptions}
                  onChange={setEntryStatus}
                  label="筛选当前入场状态"
                />
                <DropdownSelect
                  className="w-[164px]"
                  value={longVenue}
                  options={longVenueOptions}
                  onChange={setLongVenue}
                  label="筛选做多交易所"
                />
                <DropdownSelect
                  className="w-[164px]"
                  value={shortVenue}
                  options={shortVenueOptions}
                  onChange={setShortVenue}
                  label="筛选做空交易所"
                />
              </>
            ) : (
              <DropdownSelect
                className="w-[148px]"
                value={marketVenue}
                options={marketVenueOptions}
                onChange={setMarketVenue}
                label="筛选市场交易所"
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {view === "opportunities" ? (
              <SegmentedControl
                value={sort}
                options={[{ value: "score", label: "持有质量优先" }, { value: "netApr", label: `净${yieldMetric.toUpperCase()}优先` }]}
                onChange={(value) => setSort(value as OpportunitySort)}
                label="机会排序"
              />
            ) : null}
            <SegmentedControl
              value={yieldMetric}
              options={[{ value: "apr", label: "APR" }, { value: "apy", label: "APY" }]}
              onChange={(value) => setYieldMetric(value as ArbitrageYieldMetric)}
              label="收益指标"
            />
            <SegmentedControl
              value={String(horizonDays)}
              options={horizons.map((value) => ({ value: String(value), label: `${value}天` }))}
              onChange={(value) => setHorizonDays(Number(value) as ArbitrageHorizon)}
              label="持有周期"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p>{view === "opportunities"
            ? opportunityCountLabel(filteredOpportunities.length, recommendation, entryStatus, longVenue, shortVenue)
            : `${filteredMarkets.length} 个市场`}</p>
          <div className="flex items-center gap-1.5">
            <span>近90天费率基准 · {horizonDays}天持有{horizonDays === 365 ? "情景" : ""}</span>
            <ArbitrageHelp content={`历史资金费率固定观察最近90天；${horizonDays}天仅用于持有期和往返成本摊销。按Taker成交，并分别计量USDT与USDC。`} label="查看测算口径" />
          </div>
        </div>

        {loading && !snapshot ? (
          <TableSkeleton />
        ) : view === "markets" ? (
          <ArbitrageMarketTable markets={filteredMarkets} />
        ) : (
          <ArbitrageOpportunityTable
            opportunities={visibleOpportunities}
            holdingDays={horizonDays}
            yieldMetric={yieldMetric}
            expandedId={expandedId}
            onToggle={toggleOpportunity}
          />
        )}
        {view === "opportunities" && filteredOpportunities.length > opportunityPageSize ? (
          <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
            <p className="text-xs text-muted">
              第 {(opportunityPage - 1) * opportunityPageSize + 1}–{Math.min(opportunityPage * opportunityPageSize, filteredOpportunities.length)} 条，共 {filteredOpportunities.length} 条
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center border border-white/20 text-white transition hover:border-white disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="上一页"
                title="上一页"
                disabled={opportunityPage <= 1}
                onClick={() => changeOpportunityPage(Math.max(1, opportunityPage - 1))}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="min-w-16 text-center font-mono text-xs text-muted">{opportunityPage} / {opportunityPageCount}</span>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center border border-white/20 text-white transition hover:border-white disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="下一页"
                title="下一页"
                disabled={opportunityPage >= opportunityPageCount}
                onClick={() => changeOpportunityPage(Math.min(opportunityPageCount, opportunityPage + 1))}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function formatArbitrageError(error: unknown) {
  if (error instanceof HttpRequestError && error.status === 429) {
    const seconds = parseRetryAfterSeconds(error.retryAfter);
    return seconds
      ? `刷新过于频繁，请 ${seconds} 秒后再试。`
      : "刷新过于频繁，请稍后再试。";
  }
  return error instanceof Error ? error.message : "套利看板加载失败。";
}

function parseRetryAfterSeconds(value: string | null) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(1, Math.ceil((timestamp - Date.now()) / 1000));
}

function filterVenueOptions(
  allLabel: string,
  available: Set<ArbitrageVenue> | null,
  prefix?: "做多" | "做空",
): Array<{ value: VenueFilter; label: string }> {
  return [
    { value: "all", label: allLabel },
    ...venues
      .filter((option) => !available || available.has(option.value))
      .map((option) => ({
        ...option,
        label: prefix ? `${prefix}-${option.label}` : option.label,
      })),
  ];
}

function opportunityCountLabel(
  count: number,
  recommendation: RecommendationFilter,
  entryStatus: EntryStatusFilter,
  longVenue: VenueFilter,
  shortVenue: VenueFilter,
) {
  const venueScope = longVenue === "all" && shortVenue === "all"
    ? "中性 / 套利组合"
    : venueFilterSummary(longVenue, shortVenue);
  const recommendationScope = recommendation === "all" ? "" : ` · ${recommendationLabels[recommendation]}`;
  const entryScope = entryStatus === "all" ? "" : ` · ${entryStatusLabels[entryStatus]}`;
  return `${count} 个 ${venueScope}${recommendationScope}${entryScope}`;
}

function venueFilterSummary(longVenue: VenueFilter, shortVenue: VenueFilter) {
  if (longVenue !== "all" && longVenue === shortVenue) {
    return `${venueLabel(longVenue)} 同所组合`;
  }
  const longLabel = longVenue === "all" ? "全部交易所" : venueLabel(longVenue);
  const shortLabel = shortVenue === "all" ? "全部交易所" : venueLabel(shortVenue);
  return `${longLabel} 做多 / ${shortLabel} 做空组合`;
}

function venueLabel(venue: ArbitrageVenue) {
  return venues.find((option) => option.value === venue)?.label ?? venue;
}

type SegmentedControlProps = {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  label: string;
};

function SegmentedControl({ value, options, onChange, label }: SegmentedControlProps) {
  return (
    <div className="inline-flex border border-line bg-black p-0.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`min-h-9 whitespace-nowrap px-3 text-xs font-medium transition ${value === option.value ? "bg-white text-black" : "text-muted hover:bg-white/[0.06] hover:text-white"}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="grid animate-pulse border border-line bg-black sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-[104px] border-line p-4 sm:border-l first:border-l-0">
          <div className="h-3 w-20 bg-white/10" />
          <div className="mt-4 h-6 w-28 bg-white/10" />
          <div className="mt-3 h-3 w-36 bg-white/5" />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="animate-pulse border border-line bg-black">
      <div className="h-11 border-b border-line bg-white/[0.03]" />
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="flex h-16 items-center gap-8 border-b border-line px-5 last:border-b-0">
          <div className="h-4 w-16 bg-white/10" />
          <div className="h-4 w-32 bg-white/10" />
          <div className="h-4 w-24 bg-white/5" />
          <div className="ml-auto h-4 w-20 bg-white/10" />
        </div>
      ))}
    </div>
  );
}
