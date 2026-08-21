import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchArbitrageDashboard } from "../../api/arbitrage";
import { ArbitrageOpportunityAnalysis } from "../../features/arbitrage/components/ArbitrageOpportunityAnalysis";
import { ArbitrageExecutionDraftEntry } from "../../features/arbitrage/components/ArbitrageExecutionDraftEntry";
import {
  findArbitrageAnalysisOpportunity,
  parseArbitrageAnalysisHorizon,
} from "../../features/arbitrage/lib/analysisRoute";
import type {
  ArbitrageDashboardSnapshot,
  ArbitrageHorizon,
} from "../../features/arbitrage/model/types";

const horizons: ArbitrageHorizon[] = [90, 365];
export const ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS = 30_000;

export type ArbitrageDashboardRefreshState = {
  snapshot: ArbitrageDashboardSnapshot | null;
  executionOpportunityId: string | null;
  status: "idle" | "loading" | "refreshing";
  error: string;
};

type ArbitrageDashboardRefreshAction =
  | { type: "load-started"; selectedOpportunityId: string }
  | { type: "load-succeeded"; snapshot: ArbitrageDashboardSnapshot; selectedOpportunityId: string }
  | { type: "load-failed"; error: string }
  | { type: "reset" };

export const initialArbitrageDashboardRefreshState: ArbitrageDashboardRefreshState = {
  snapshot: null,
  executionOpportunityId: null,
  status: "idle",
  error: "",
};

export function reduceArbitrageDashboardRefreshState(
  state: ArbitrageDashboardRefreshState,
  action: ArbitrageDashboardRefreshAction,
): ArbitrageDashboardRefreshState {
  switch (action.type) {
    case "load-started":
      return {
        ...state,
        executionOpportunityId: state.executionOpportunityId === action.selectedOpportunityId
          ? state.executionOpportunityId
          : null,
        status: state.snapshot ? "refreshing" : "loading",
        error: "",
      };
    case "load-succeeded": {
      const selectedOpportunityAvailable = action.snapshot.opportunities.some(
        (opportunity) => opportunity.id === action.selectedOpportunityId,
      );
      return {
        snapshot: action.snapshot,
        executionOpportunityId: selectedOpportunityAvailable
          ? action.selectedOpportunityId
          : state.executionOpportunityId,
        status: "idle",
        error: "",
      };
    }
    case "load-failed":
      return { ...state, status: "idle", error: action.error };
    case "reset":
      return initialArbitrageDashboardRefreshState;
  }
}

export function FundingArbitrageOpportunitiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const opportunityId = searchParams.get("opportunityId");
  const resumeArbitrageId = searchParams.get("resumeArbitrageId");
  const horizonDays = parseArbitrageAnalysisHorizon(searchParams.get("horizonDays"));
  const [{ snapshot, executionOpportunityId, status, error }, dispatchRefresh] = useReducer(
    reduceArbitrageDashboardRefreshState,
    initialArbitrageDashboardRefreshState,
  );
  const loading = status === "loading" || (Boolean(opportunityId) && !snapshot && !error);
  const refreshing = status === "refreshing";

  const load = useCallback(async (forceRefresh = false) => {
    if (!opportunityId) {
      dispatchRefresh({ type: "reset" });
      return;
    }

    dispatchRefresh({ type: "load-started", selectedOpportunityId: opportunityId });
    try {
      dispatchRefresh({
        type: "load-succeeded",
        snapshot: await fetchArbitrageDashboard(horizonDays, forceRefresh),
        selectedOpportunityId: opportunityId,
      });
    } catch (loadError) {
      dispatchRefresh({
        type: "load-failed",
        error: loadError instanceof Error ? loadError.message : "套利分析数据加载失败。",
      });
    }
  }, [horizonDays, opportunityId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!opportunityId) return;
    const timer = window.setInterval(() => void load(), ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load, opportunityId]);

  const opportunity = findArbitrageAnalysisOpportunity(snapshot, opportunityId);
  const longMarket = useMemo(
    () => snapshot?.markets.find((market) => market.id === opportunity?.longLeg.id) ?? null,
    [opportunity?.longLeg.id, snapshot],
  );
  const shortMarket = useMemo(
    () => snapshot?.markets.find((market) => market.id === opportunity?.shortLeg.id) ?? null,
    [opportunity?.shortLeg.id, snapshot],
  );

  const changeHorizon = useCallback((nextHorizon: ArbitrageHorizon) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("horizonDays", String(nextHorizon));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="xh-page w-full min-w-0 max-w-full px-4 py-5 md:px-8 md:py-7">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">套利分析</h1>
            <span className="inline-flex border border-sky-400/30 bg-sky-400/[0.07] px-2.5 py-1 text-xs font-medium text-sky-200">套利系统 · 只读分析</span>
          </div>
          <p className="xh-subtitle">基于套利看板的同一公开市场快照，展示选中机会的历史、成本、流动性和风险因素。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted">
          <span>{snapshot ? `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待数据"}</span>
          {executionOpportunityId && executionOpportunityId === opportunityId ? <ArbitrageExecutionDraftEntry horizonDays={horizonDays} opportunityId={executionOpportunityId} resumeArbitrageId={resumeArbitrageId} /> : null}
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center border border-white/20 text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
            aria-label="刷新套利分析"
            title="刷新分析"
            disabled={refreshing || !opportunityId}
            onClick={() => void load(true)}
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} size={16} />
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 border-y border-line py-3 sm:flex-row sm:items-center sm:justify-between">
        <Link className="inline-flex items-center gap-2 text-sm font-medium text-white hover:underline" to={resumeArbitrageId ? `/app/arbitrage?resumeArbitrageId=${encodeURIComponent(resumeArbitrageId)}` : "/app/arbitrage"}>
          <ArrowLeft size={15} /> 返回套利看板
        </Link>
        <HorizonControl value={horizonDays} onChange={changeHorizon} />
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-4 border border-red-400/35 bg-black px-4 py-3 text-sm text-red-200" role={snapshot ? "status" : "alert"}>
          <span>{snapshot ? `后台刷新失败，继续显示上次有效数据：${error}` : error}</span>
          <button className="shrink-0 font-semibold text-white hover:underline" type="button" onClick={() => void load(true)}>重试</button>
        </div>
      ) : null}

      {!opportunityId ? (
        <ArbitrageAnalysisEmptyState
          title="请选择一个套利机会进行分析"
          description="前往套利看板选择机会后，可查看完整分析。"
          actionLabel="前往套利看板"
        />
      ) : loading && !snapshot ? (
        <AnalysisSkeleton />
      ) : snapshot && !opportunity ? (
        <ArbitrageAnalysisEmptyState
          title={resumeArbitrageId ? "当前实例无法继续，需要重新处理" : "该套利机会当前已不可用或市场数据已更新"}
          description={resumeArbitrageId ? "当前机会已无法与原实例安全匹配；旧实例保持不变。" : "请返回套利看板，根据最新市场数据重新选择机会。"}
          actionLabel="返回套利看板"
          actionHref={resumeArbitrageId ? `/app/arbitrage?resumeArbitrageId=${encodeURIComponent(resumeArbitrageId)}` : undefined}
        />
      ) : opportunity ? (
        <ArbitrageOpportunityAnalysis
          opportunity={opportunity}
          longMarket={longMarket}
          shortMarket={shortMarket}
          holdingDays={horizonDays}
        />
      ) : null}
    </div>
  );
}

function HorizonControl({ value, onChange }: { value: ArbitrageHorizon; onChange: (value: ArbitrageHorizon) => void }) {
  return (
    <div className="inline-flex border border-line bg-black p-0.5" role="group" aria-label="持有测算情景">
      {horizons.map((horizon) => (
        <button
          key={horizon}
          type="button"
          className={`min-h-9 whitespace-nowrap px-3 text-xs font-medium transition ${value === horizon ? "bg-white text-black" : "text-muted hover:bg-white/[0.06] hover:text-white"}`}
          aria-pressed={value === horizon}
          onClick={() => onChange(horizon)}
        >
          {horizon} 天
        </button>
      ))}
    </div>
  );
}

export function ArbitrageAnalysisEmptyState({
  actionLabel,
  actionHref = "/app/arbitrage",
  description,
  title,
}: {
  actionLabel: string;
  actionHref?: string;
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center border border-line bg-black px-5 py-10 text-center">
      <AlertTriangle className="text-amber-300" size={22} />
      <h2 className="mt-3 text-sm font-semibold text-white">{title}</h2>
      <p className="mt-2 max-w-xl text-xs leading-5 text-muted">{description}</p>
      <Link className="mt-5 inline-flex min-h-10 items-center justify-center border border-white/25 px-4 text-sm font-semibold text-white hover:border-white" to={actionHref}>
        {actionLabel}
      </Link>
    </div>
  );
}

function AnalysisSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      {[0, 1, 2, 3].map((section) => (
        <div className="border border-line bg-black p-4" key={section}>
          <div className="h-4 w-28 bg-white/10" />
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((item) => <div className="h-16 bg-white/[0.05]" key={item} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
