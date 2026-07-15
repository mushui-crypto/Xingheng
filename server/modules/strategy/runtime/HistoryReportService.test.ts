import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerStrategyRoutes } from "../../api/strategyRoutes";
import { normalizeHistoryReport, readHistoryReport } from "./HistoryReportService";

test("history report filters by entryTime and paginates", () => {
  const report = normalizeHistoryReport(makeRawReport(), { from: "2024-01-01", to: "2024-12-31", limit: "1" });
  assert.equal(report.status, "available");
  assert.equal(report.attributionField, "entryTime");
  assert.equal(report.metrics.tradeCount, 2);
  assert.equal(report.completedTrades.length, 1);
  assert.equal(report.pagination.total, 2);
  assert.equal(report.pagination.nextCursor, "1");
  assert.equal(report.assumptions.automaticOrdersEnabled, false);
});

test("history report returns null profit factor when there is no loss sample", () => {
  const report = normalizeHistoryReport(makeRawReport(), { from: "2025-01-01", to: "2025-12-31" });
  assert.equal(report.metrics.tradeCount, 1);
  assert.equal(report.metrics.profitFactor, null);
});

test("history report clamps ranges to available data", () => {
  const report = normalizeHistoryReport(makeRawReport(), { from: "2023-01-01", to: "2027-01-01" });
  assert.deepEqual(report.requestedRange, { from: "2024-01-01", to: "2026-07-13" });
  assert.deepEqual(report.warnings, ["range_clamped"]);
});

test("history report read returns safe empty state when no report exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-history-empty-"));
  try {
    const result = await readHistoryReport({}, path.join(directory, "missing.json"));
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 200);
    assert.equal(result.report.status, "unavailable");
    assert.deepEqual(result.report.warnings, ["no_report"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history report read returns sanitized damaged state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-history-damaged-"));
  try {
    const file = path.join(directory, "history.json");
    await writeFile(file, "{bad-json", "utf8");
    const result = await readHistoryReport({}, file);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.report.warnings, ["report_unreadable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strategy history route rejects unauthenticated requests", async () => {
  const app = express();
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/strategy/ict/history`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "用户未登录或登录已失效。" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function makeRawReport() {
  return {
    availableRange: { from: "2024-01-01", to: "2026-07-13" },
    dataThrough: "2026-07-13",
    dataQuality: { source: "binance_vision_usdm", interval: "5m", candleCount: 1000, missingBarCount: 0, updatedAt: "2026-07-13" },
    completedTrades: [
      makeTrade({ entryTime: Date.parse("2024-02-01T00:00:00Z") / 1000, netPnl: 100, rMultiple: 1 }),
      makeTrade({ entryTime: Date.parse("2024-05-01T00:00:00Z") / 1000, netPnl: -50, rMultiple: -0.5 }),
      makeTrade({ entryTime: Date.parse("2025-03-01T00:00:00Z") / 1000, netPnl: 25, rMultiple: 0.25 }),
    ],
  };
}

function makeTrade(overrides: Partial<any>) {
  return {
    side: "long",
    signalTime: overrides.entryTime - 300,
    entryTime: overrides.entryTime,
    exitTime: overrides.entryTime + 900,
    entryPrice: 100,
    exitPrice: 101,
    stopPrice: 99,
    targetPrice: 102,
    quantity: 1,
    grossPnl: overrides.netPnl,
    fees: 1,
    netPnl: overrides.netPnl,
    rMultiple: overrides.rMultiple,
    exitReason: "target",
    ...overrides,
  };
}
