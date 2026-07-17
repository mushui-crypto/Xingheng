import { useEffect, useReducer, useState } from "react";
import { fetchStrategyForwardReport, fetchStrategyHistoryReport } from "../../api/strategy";
import {
  ObservationProgress,
  RecentStrategyTrades,
  StrategyConfigPanel,
  StrategyErrorState,
  StrategyLoadingState,
  StrategyMetricsTable,
  StrategyPageHeader,
  StrategyRuntimePanels,
  StrategyWorkerPanel,
} from "../../features/strategy/components/StrategyPanels";
import {
  StrategyHistoryView,
  StrategyViewTabs,
  type StrategyHistoryRange,
  type StrategyView,
} from "../../features/strategy/components/StrategyHistoryPanels";
import { StrategyTradeChart } from "../../features/strategy/components/StrategyTradeChart";
import {
  MartingalePageHeader,
  MartingaleStrategyView,
} from "../../features/strategy/components/MartingaleStrategyView";
import {
  buildStrategyTradeMarkerEvents,
  strategyTradeKey,
} from "../../features/strategy/lib/tradeChart";
import type { StrategyForwardReport, StrategyHistoryQuery } from "../../features/strategy/model/types";
import {
  initialStrategyHistoryRequestState,
  strategyHistoryRequestReducer,
} from "../../features/strategy/model/historyRequestState";

const forwardRefreshMs = 30_000;
const historyPageLimit = 20;
const historyRanges: Record<Exclude<StrategyHistoryRange, "custom">, Pick<StrategyHistoryQuery, "from" | "to">> = {
  "2024_2025": { from: "2024-01-01", to: "2025-12-31" },
  "2026": { from: "2026-01-01", to: "2026-07-13" },
  all: {},
};

export function StrategyPage() {
  const [activeView, setActiveView] = useState<StrategyView>("forward");
  const [report, setReport] = useState<StrategyForwardReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyRequest, dispatchHistoryRequest] = useReducer(
    strategyHistoryRequestReducer,
    initialStrategyHistoryRequestState,
  );
  const [historyRange, setHistoryRange] = useState<StrategyHistoryRange>("all");
  const [historyQuery, setHistoryQuery] = useState<Pick<StrategyHistoryQuery, "from" | "to">>({});
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<Array<string | null>>([]);
  const [customFrom, setCustomFrom] = useState("2024-01-01");
  const [customTo, setCustomTo] = useState("2026-07-13");
  const [customError, setCustomError] = useState("");
  const [chartFocus, setChartFocus] = useState<{
    view: "forward" | "history";
    centerTime: string;
    markerId: string | null;
    revision: number;
  } | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let active = true;
    const load = (initial: boolean) => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      if (initial) setLoading(true);
      void fetchStrategyForwardReport(requestController.signal)
        .then((nextReport) => {
          if (!active) return;
          setReport(nextReport);
          setError("");
        })
        .catch((reason) => {
          if (active && !requestController.signal.aborted) setError(reason instanceof Error ? reason.message : "策略观察状态加载失败。");
        })
        .finally(() => {
          if (active && initial) setLoading(false);
        });
    };
    load(true);
    const interval = window.setInterval(() => {
      if (!document.hidden) load(false);
    }, forwardRefreshMs);
    const handleVisibility = () => {
      if (!document.hidden) load(false);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (activeView !== "history") return;
    const controller = new AbortController();
    dispatchHistoryRequest({ type: "start" });
    void fetchStrategyHistoryReport({
      ...historyQuery,
      limit: historyPageLimit,
      cursor: historyCursor ?? undefined,
    }, controller.signal)
      .then((nextReport) => dispatchHistoryRequest({ type: "success", report: nextReport }))
      .catch((reason) => {
        if (!controller.signal.aborted) {
          dispatchHistoryRequest({
            type: "failure",
            message: reason instanceof Error ? reason.message : "历史回测报告加载失败。",
          });
        }
      });
    return () => controller.abort();
  }, [activeView, historyCursor, historyQuery.from, historyQuery.to]);

  const availableReport = report?.status === "unavailable" ? null : report;
  const availableHistoryReport = historyRequest.report?.status === "available" ? historyRequest.report : null;
  const forwardTrades = availableReport ? [
    ...(availableReport.openPosition ? [availableReport.openPosition] : []),
    ...availableReport.recentCompletedTrades,
  ] : [];
  const historyTrades = availableHistoryReport?.completedTrades ?? [];

  const handleViewChange = (view: StrategyView) => {
    setActiveView(view);
    setChartFocus(null);
  };

  const handleLocateTrade = (view: "forward" | "history", trade: NonNullable<StrategyForwardReport["openPosition"]>) => {
    if (!trade.entryTime) return;
    setChartFocus((current) => ({
      view,
      centerTime: trade.entryTime as string,
      markerId: `${strategyTradeKey(trade)}:entry`,
      revision: (current?.revision ?? 0) + 1,
    }));
  };

  const resetChartFocus = () => setChartFocus(null);

  const handleRangeChange = (range: StrategyHistoryRange) => {
    setHistoryRange(range);
    setCustomError("");
    if (range === "custom") return;
    resetChartFocus();
    setHistoryQuery(historyRanges[range]);
    setHistoryCursor(null);
    setPreviousCursors([]);
  };

  const handleApplyCustom = () => {
    if (!isDateOnly(customFrom) || !isDateOnly(customTo)) {
      setCustomError("请选择有效的开始和结束日期。");
      return;
    }
    if (customFrom > customTo) {
      setCustomError("开始日期不能晚于结束日期。");
      return;
    }
    setCustomError("");
    resetChartFocus();
    setHistoryQuery({ from: customFrom, to: customTo });
    setHistoryCursor(null);
    setPreviousCursors([]);
  };

  const handleNextPage = () => {
    const nextCursor = historyRequest.report?.pagination.nextCursor;
    if (!nextCursor) return;
    resetChartFocus();
    setPreviousCursors((current) => [...current, historyCursor]);
    setHistoryCursor(nextCursor);
  };

  const handlePreviousPage = () => {
    if (!previousCursors.length) return;
    resetChartFocus();
    setHistoryCursor(previousCursors.at(-1) ?? null);
    setPreviousCursors((current) => current.slice(0, -1));
  };

  return (
    <div className="xh-strategy-page">
      {activeView === "martingale"
        ? <MartingalePageHeader />
        : <StrategyPageHeader report={report} loading={loading} error={Boolean(error)} />}
      <StrategyViewTabs active={activeView} onChange={handleViewChange} />
      {activeView === "forward" ? (
        <div className="xh-strategy-forward-view" role="tabpanel" aria-label="前向 Paper">
          <StrategyTradeChart
            mode="forward"
            contextState={loading ? "loading" : error || !availableReport ? "unavailable" : "ready"}
            markerDataCount={forwardTrades.length}
            markerDataSignature={JSON.stringify(forwardTrades)}
            buildMarkerEvents={(interval) => buildStrategyTradeMarkerEvents(forwardTrades, interval)}
            fallbackTime={availableReport?.openPosition?.entryTime
              ?? availableReport?.recentCompletedTrades.at(-1)?.entryTime
              ?? availableReport?.through
              ?? null}
            focusRequest={chartFocus?.view === "forward" ? chartFocus : null}
          />
          {loading ? <StrategyLoadingState /> : (
            <>
              {error ? <StrategyErrorState message={error} /> : null}
              <StrategyWorkerPanel report={report} />
              <ObservationProgress report={availableReport} />
              <StrategyMetricsTable report={availableReport} />
              <StrategyConfigPanel report={availableReport} />
              <StrategyRuntimePanels report={availableReport} />
              <RecentStrategyTrades report={availableReport} onLocateTrade={(trade) => handleLocateTrade("forward", trade)} />
            </>
          )}
        </div>
      ) : activeView === "history" ? (
        <StrategyHistoryView
          chart={(
            <StrategyTradeChart
              mode="history"
              contextState={historyRequest.loading ? "loading" : historyRequest.error || !availableHistoryReport ? "unavailable" : "ready"}
              markerDataCount={historyTrades.length}
              markerDataSignature={JSON.stringify(historyTrades)}
              buildMarkerEvents={(interval) => buildStrategyTradeMarkerEvents(historyTrades, interval)}
              fallbackTime={availableHistoryReport?.completedTrades.at(-1)?.entryTime
                ?? availableHistoryReport?.dataThrough
                ?? null}
              focusRequest={chartFocus?.view === "history" ? chartFocus : null}
            />
          )}
          report={historyRequest.report}
          loading={historyRequest.loading}
          error={historyRequest.error}
          range={historyRange}
          customFrom={customFrom}
          customTo={customTo}
          customError={customError}
          canGoPrevious={previousCursors.length > 0}
          onRangeChange={handleRangeChange}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
          onApplyCustom={handleApplyCustom}
          onNextPage={handleNextPage}
          onPreviousPage={handlePreviousPage}
          onLocateTrade={(trade) => handleLocateTrade("history", trade)}
        />
      ) : (
        <MartingaleStrategyView />
      )}
    </div>
  );
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
