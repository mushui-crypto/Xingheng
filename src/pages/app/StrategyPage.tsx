import { useEffect, useState } from "react";
import { fetchStrategyForwardReport } from "../../api/strategy";
import {
  ObservationProgress,
  RecentStrategyTrades,
  StrategyConfigPanel,
  StrategyErrorState,
  StrategyLoadingState,
  StrategyMetricsTable,
  StrategyPageHeader,
  StrategyRuntimePanels,
} from "../../features/strategy/components/StrategyPanels";
import type { StrategyForwardReport } from "../../features/strategy/model/types";

export function StrategyPage() {
  const [report, setReport] = useState<StrategyForwardReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchStrategyForwardReport(controller.signal)
      .then(setReport)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "策略观察状态加载失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const availableReport = report?.status === "unavailable" ? null : report;

  return (
    <div className="xh-strategy-page">
      <StrategyPageHeader report={report} loading={loading} error={Boolean(error)} />
      {loading ? <StrategyLoadingState /> : (
        <>
          {error ? <StrategyErrorState message={error} /> : null}
          <ObservationProgress report={availableReport} />
          <StrategyMetricsTable report={availableReport} />
          <StrategyConfigPanel report={availableReport} />
          <StrategyRuntimePanels report={availableReport} />
          <RecentStrategyTrades report={availableReport} />
        </>
      )}
    </div>
  );
}
