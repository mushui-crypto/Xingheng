import assert from "node:assert/strict";
import test from "node:test";
import type { MartingaleForwardReport } from "./martingaleTypes";
import { initialMartingaleRequestState, martingaleRequestReducer } from "./martingaleRequestState";

const report = { status: "collecting" } as MartingaleForwardReport;

test("new martingale request removes the previous report before loading", () => {
  const previous = { report, loading: false, error: "" };
  assert.deepEqual(martingaleRequestReducer(previous, { type: "start" }), {
    report: null,
    loading: true,
    error: "",
  });
});

test("503 or network failure cannot leave stale martingale data visible", () => {
  const previous = { report, loading: false, error: "" };
  assert.deepEqual(martingaleRequestReducer(previous, { type: "failure", message: "加载失败" }), {
    report: null,
    loading: false,
    error: "加载失败",
  });
});

test("only the current successful request installs a martingale report", () => {
  assert.deepEqual(martingaleRequestReducer(initialMartingaleRequestState, { type: "success", report }), {
    report,
    loading: false,
    error: "",
  });
});
