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

  const handleRangeChange = (range: StrategyHistoryRange) => {
    setHistoryRange(range);
    setCustomError("");
    if (range === "custom") return;
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
    setHistoryQuery({ from: customFrom, to: customTo });
    setHistoryCursor(null);
    setPreviousCursors([]);
  };

  const handleNextPage = () => {
    const nextCursor = historyRequest.report?.pagination.nextCursor;
    if (!nextCursor) return;
    setPreviousCursors((current) => [...current, historyCursor]);
    setHistoryCursor(nextCursor);
  };

  const handlePreviousPage = () => {
    if (!previousCursors.length) return;
    setHistoryCursor(previousCursors.at(-1) ?? null);
    setPreviousCursors((current) => current.slice(0, -1));
  };

  return (
    <div className="xh-strategy-page">
      <StrategyPageHeader report={report} loading={loading} error={Boolean(error)} />
      <StrategyViewTabs active={activeView} onChange={setActiveView} />
      {activeView === "forward" ? (
        <div className="xh-strategy-forward-view" role="tabpanel" aria-label="前向 Paper">
          {loading ? <StrategyLoadingState /> : (
            <>
              {error ? <StrategyErrorState message={error} /> : null}
              <StrategyWorkerPanel report={report} />
              <ObservationProgress report={availableReport} />
              <StrategyMetricsTable report={availableReport} />
              <StrategyConfigPanel report={availableReport} />
              <StrategyRuntimePanels report={availableReport} />
              <RecentStrategyTrades report={availableReport} />
            </>
          )}
        </div>
      ) : (
        <StrategyHistoryView
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
        />
      )}
    </div>
  );
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
