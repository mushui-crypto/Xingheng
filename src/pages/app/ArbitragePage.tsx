import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchArbitrageDashboard } from "../../api/arbitrage";
import { HttpRequestError } from "../../api/httpClient";
import { DropdownSelect } from "../../components/ui/DropdownSelect";
import { ArbitrageAssetPicker } from "../../features/arbitrage/components/ArbitrageAssetPicker";
import { ArbitrageMarketTable } from "../../features/arbitrage/components/ArbitrageMarketTable";
import { ArbitrageOpportunityTable } from "../../features/arbitrage/components/ArbitrageOpportunityTable";
import { ArbitrageHelp } from "../../features/arbitrage/components/ArbitrageHelp";
import { ArbitrageSummaryBar } from "../../features/arbitrage/components/ArbitrageSummaryBar";
import { equivalentNetYield } from "../../features/arbitrage/lib/formatters";
import { buildArbitrageAnalysisHref } from "../../features/arbitrage/lib/analysisRoute";
import {
  ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
  startVisibilityAwarePolling,
} from "../../features/arbitrage/lib/visibilityPolling";
import {
  matchesOpportunityEntryStatus,
  matchesOpportunityProductType,
  matchesOpportunityRecommendation,
  matchesOpportunityVenue,
  opportunityLegVenues,
  type OpportunityProductType,
} from "../../features/arbitrage/lib/opportunityFilters";
import type {
  ArbitrageAsset,
  ArbitrageDashboardSnapshot,
  ArbitrageEntryStatus,
  ArbitrageHorizon,
  ArbitrageOpportunity,
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
type ProductTypeFilter = "all" | OpportunityProductType;

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
  recommended: "综合质量：高",
  watch: "综合质量：中",
  neutral: "综合质量：低",
  blocked: "综合质量：无法评估",
};
const recommendationOptions: Array<{ value: RecommendationFilter; label: string }> = [
  { value: "all", label: "综合质量：全部" },
  ...Object.entries(recommendationLabels).map(([value, label]) => ({
    value: value as ArbitrageRecommendation,
    label,
  })),
];
const entryStatusLabels: Record<ArbitrageEntryStatus, string> = {
  favorable: "当前条件：满足",
  cautious: "当前条件：部分满足",
  waiting: "当前费率差：未转正",
  blocked: "当前条件：无法评估",
};
const entryStatusOptions: Array<{ value: EntryStatusFilter; label: string }> = [
  { value: "all", label: "当前条件：全部" },
  ...Object.entries(entryStatusLabels).map(([value, label]) => ({
    value: value as ArbitrageEntryStatus,
    label,
  })),
];
const productTypeLabels: Record<OpportunityProductType, string> = {
  perpetual_perpetual: "永续-永续",
  spot_perpetual: "现货-永续",
};
const productTypeOptions: Array<{ value: ProductTypeFilter; label: string }> = [
  { value: "all", label: "套利类型：全部" },
  { value: "perpetual_perpetual", label: productTypeLabels.perpetual_perpetual },
  { value: "spot_perpetual", label: productTypeLabels.spot_perpetual },
];
const opportunityPageSize = 25;

export function ArbitragePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeArbitrageId = searchParams.get("resumeArbitrageId");
  const [horizonDays, setHorizonDays] = useState<ArbitrageHorizon>(90);
  const [yieldMetric, setYieldMetric] = useState<ArbitrageYieldMetric>("apr");
  const [view, setView] = useState<BoardView>("opportunities");
  const [sort, setSort] = useState<OpportunitySort>("score");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [productType, setProductType] = useState<ProductTypeFilter>("all");
  const [recommendation, setRecommendation] = useState<RecommendationFilter>("all");
  const [entryStatus, setEntryStatus] = useState<EntryStatusFilter>("all");
  const [longVenue, setLongVenue] = useState<VenueFilter>("all");
  const [shortVenue, setShortVenue] = useState<VenueFilter>("all");
  const [snapshot, setSnapshot] = useState<ArbitrageDashboardSnapshot | null>(null);
  const [opportunityPage, setOpportunityPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const lifecycleGeneration = useRef(0);

  useEffect(() => {
    lifecycleGeneration.current += 1;
    return () => {
      lifecycleGeneration.current += 1;
    };
  }, []);

  const availableAssets = useMemo(() => {
    const available = new Set(snapshot?.markets.filter((market) => view !== "markets" || market.venue !== "tradexyz").map((market) => market.asset) ?? ARBITRAGE_ASSET_ORDER.filter((asset) => view !== "markets" || asset !== "GOLD"));
    return ARBITRAGE_ASSET_ORDER.filter((value) => available.has(value));
  }, [snapshot, view]);

  useEffect(() => {
    if (view === "markets" && asset !== "all" && !availableAssets.includes(asset)) setAsset("all");
  }, [asset, availableAssets, view]);

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

  const load = useCallback(async (forceRefresh = false) => {
    const generation = lifecycleGeneration.current;
    forceRefresh ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const nextSnapshot = await fetchArbitrageDashboard(horizonDays, forceRefresh);
      if (lifecycleGeneration.current !== generation) return;
      setSnapshot(nextSnapshot);
    } catch (loadError) {
      if (lifecycleGeneration.current !== generation) return;
      setError(formatArbitrageError(loadError));
    } finally {
      if (lifecycleGeneration.current !== generation) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [horizonDays]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return startVisibilityAwarePolling(
      () => void load(),
      ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    );
  }, [load]);

  const filteredMarkets = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.markets
      .filter((market) => market.venue !== "tradexyz")
      .filter((market) => asset === "all" || market.asset === asset)
      .sort((left, right) =>
        (assetRank.get(left.asset) ?? 99) - (assetRank.get(right.asset) ?? 99)
        || left.venueLabel.localeCompare(right.venueLabel)
        || left.kind.localeCompare(right.kind),
      );
  }, [asset, snapshot]);

  const filteredOpportunities = useMemo(() => {
    if (!snapshot) return [];
    const opportunities = snapshot.opportunities
      .filter((item) => asset === "all" || item.longLeg.asset === asset || item.shortLeg.asset === asset)
      .filter((item) => matchesOpportunityProductType(item, productType))
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
  }, [asset, entryStatus, horizonDays, longVenue, productType, recommendation, shortVenue, snapshot, sort, yieldMetric]);

  const opportunityPageCount = Math.max(1, Math.ceil(filteredOpportunities.length / opportunityPageSize));
  const visibleOpportunities = useMemo(() => filteredOpportunities.slice(
    (opportunityPage - 1) * opportunityPageSize,
    opportunityPage * opportunityPageSize,
  ), [filteredOpportunities, opportunityPage]);

  const changeOpportunityPage = useCallback((page: number) => {
    setOpportunityPage(page);
  }, []);

  const openAnalysis = useCallback((opportunity: ArbitrageOpportunity) => {
    navigate(buildArbitrageAnalysisHref(opportunity.id, horizonDays, resumeArbitrageId));
  }, [horizonDays, navigate, resumeArbitrageId]);

  useEffect(() => {
    setOpportunityPage(1);
  }, [asset, entryStatus, horizonDays, longVenue, productType, recommendation, shortVenue, sort, yieldMetric]);

  useEffect(() => {
    if (!longVenueOptions.some((option) => option.value === longVenue)) setLongVenue("all");
    if (!shortVenueOptions.some((option) => option.value === shortVenue)) setShortVenue("all");
  }, [longVenue, longVenueOptions, shortVenue, shortVenueOptions]);

  useEffect(() => {
    if (opportunityPage > opportunityPageCount) setOpportunityPage(opportunityPageCount);
  }, [opportunityPage, opportunityPageCount]);

  return (
    <div className="xh-page w-full min-w-0 max-w-full">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">套利看板</h1>
            <span className="inline-flex border border-sky-400/30 bg-sky-400/[0.07] px-2.5 py-1 text-xs font-medium text-sky-200">套利系统 · 只读公开行情</span>
          </div>
          <p className="xh-subtitle">展示综合质量与当前市场条件；真实数据和估算指标仅辅助比较，不代替用户决策。</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>{snapshot ? `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待数据"}</span>
          {snapshot?.refreshState === "REFRESHING" ? <span className="text-muted" role="status">后台更新中</span> : null}
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

      {resumeArbitrageId ? (
        <div className="flex items-start gap-3 border border-sky-400/30 bg-sky-400/[0.06] px-4 py-3 text-sm text-sky-100" role="status">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <p>正在继续现有套利实例。请重新选择并确认与原实例一致的套利机会；系统不会创建新实例。</p>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center justify-between gap-4 border border-red-400/35 bg-black px-4 py-3 text-sm text-red-200">
          <span>{error}</span>
          <button className="shrink-0 font-semibold text-white hover:underline" type="button" onClick={() => void load(true)}>重试</button>
        </div>
      ) : null}

      <section className="w-full min-w-0 max-w-full space-y-4">
        <div className="flex flex-col gap-3 border-y border-line py-3">
          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SegmentedControl
                value={view}
                options={[{ value: "opportunities", label: "套利机会" }, { value: "markets", label: "市场对比" }]}
                onChange={(value) => setView(value as BoardView)}
                label="看板视图"
              />
              <div className="w-[200px] max-w-full">
                <ArbitrageAssetPicker value={asset} assets={availableAssets} onChange={setAsset} />
              </div>
            </div>
            {view === "opportunities" ? (
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
                <DropdownSelect
                  className="col-span-2 min-w-0 w-full sm:w-[200px]"
                  value={sort}
                  options={[{ value: "score", label: "综合质量优先" }, { value: "netApr", label: `估算净${yieldMetric.toUpperCase()}优先` }]}
                  onChange={(value) => setSort(value as OpportunitySort)}
                  label="机会排序"
                />
              <DropdownSelect
                className="min-w-0 w-full sm:w-[128px]"
                value={yieldMetric}
                options={[{ value: "apr", label: "APR" }, { value: "apy", label: "APY" }]}
                onChange={(value) => setYieldMetric(value as ArbitrageYieldMetric)}
                label="收益指标"
              />
              <DropdownSelect
                className="min-w-0 w-full sm:w-[164px]"
                value={String(horizonDays)}
                options={horizons.map((value) => ({ value: String(value), label: `持有 ${value} 天` }))}
                onChange={(value) => setHorizonDays(Number(value) as ArbitrageHorizon)}
                label="持有测算情景"
              />
            </div>
            ) : null}
          </div>
          {view === "opportunities" ? <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))] gap-2">
                <DropdownSelect
                  className="min-w-0 w-full"
                  value={productType}
                  options={productTypeOptions}
                  onChange={setProductType}
                  label="筛选套利类型"
                />
                <DropdownSelect
                  className="min-w-0 w-full"
                  value={recommendation}
                  options={recommendationOptions}
                  onChange={setRecommendation}
                  label="筛选综合质量"
                />
                <DropdownSelect
                  className="min-w-0 w-full"
                  value={entryStatus}
                  options={entryStatusOptions}
                  onChange={setEntryStatus}
                  label="筛选当前条件状态"
                />
                <DropdownSelect
                  className="min-w-0 w-full"
                  value={longVenue}
                  options={longVenueOptions}
                  onChange={setLongVenue}
                  label="筛选做多交易所"
                />
                <DropdownSelect
                  className="min-w-0 w-full"
                  value={shortVenue}
                  options={shortVenueOptions}
                  onChange={setShortVenue}
                  label="筛选做空交易所"
                />
          </div> : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p>{view === "opportunities"
            ? opportunityCountLabel(filteredOpportunities.length, productType, recommendation, entryStatus, longVenue, shortVenue)
            : `${filteredMarkets.length} 个市场`}</p>
          {view === "opportunities" ? <div className="flex items-center gap-1.5">
            <span>近90天费率基准 · {horizonDays}天持有测算情景</span>
            <ArbitrageHelp content={`历史资金费率固定观察最近90天；${horizonDays}天仅用于持有测算和往返成本摊销。按Taker成交，并分别计量USDT与USDC。`} label="查看测算口径" />
          </div> : <p>当前资金费率 · 当前价格（标记价 / 最新成交价）</p>}
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
            onAnalyze={openAnalysis}
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
  productType: ProductTypeFilter,
  recommendation: RecommendationFilter,
  entryStatus: EntryStatusFilter,
  longVenue: VenueFilter,
  shortVenue: VenueFilter,
) {
  const venueScope = longVenue === "all" && shortVenue === "all"
    ? "中性 / 套利组合"
    : venueFilterSummary(longVenue, shortVenue);
  const productTypeScope = productType === "all" ? "" : ` · ${productTypeLabels[productType]}`;
  const recommendationScope = recommendation === "all" ? "" : ` · ${recommendationLabels[recommendation]}`;
  const entryScope = entryStatus === "all" ? "" : ` · ${entryStatusLabels[entryStatus]}`;
  return `${count} 个 ${venueScope}${productTypeScope}${recommendationScope}${entryScope}`;
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
