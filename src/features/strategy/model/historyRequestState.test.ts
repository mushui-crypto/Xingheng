import assert from "node:assert/strict";
import test from "node:test";
import type { StrategyHistoryReport } from "./types";
import {
  initialStrategyHistoryRequestState,
  strategyHistoryRequestReducer,
} from "./historyRequestState";

const report = (routeId: string) => ({ routeId, status: "available" }) as StrategyHistoryReport;

test("clears a successful history report before a new request and after a 503", () => {
  const loaded = strategyHistoryRequestReducer(initialStrategyHistoryRequestState, { type: "success", report: report("old-range") });
  const loading = strategyHistoryRequestReducer(loaded, { type: "start" });
  const failed = strategyHistoryRequestReducer(loading, { type: "failure", message: "历史回测报告暂时无法读取，请稍后再试。" });

  assert.equal(loading.report, null);
  assert.equal(loading.loading, true);
  assert.equal(failed.report, null);
  assert.equal(failed.loading, false);
  assert.match(failed.error, /无法读取/);
});

test("does not restore a previous range after a network failure", () => {
  const loaded = strategyHistoryRequestReducer(initialStrategyHistoryRequestState, { type: "success", report: report("page-one") });
  const loadingNextPage = strategyHistoryRequestReducer(loaded, { type: "start" });
  const failed = strategyHistoryRequestReducer(loadingNextPage, { type: "failure", message: "历史回测服务暂时不可用。" });

  assert.equal(failed.report, null);
  assert.match(failed.error, /暂时不可用/);
});

test("replaces the previous range only after the current request succeeds", () => {
  const loaded = strategyHistoryRequestReducer(initialStrategyHistoryRequestState, { type: "success", report: report("old-range") });
  const loading = strategyHistoryRequestReducer(loaded, { type: "start" });
  const refreshed = strategyHistoryRequestReducer(loading, { type: "success", report: report("new-range") });

  assert.equal(loading.report, null);
  assert.equal(refreshed.report?.routeId, "new-range");
  assert.equal(refreshed.error, "");
});
