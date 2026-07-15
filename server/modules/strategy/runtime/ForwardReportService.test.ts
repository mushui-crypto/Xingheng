import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerStrategyRoutes } from "../../api/strategyRoutes";
import { normalizeForwardReport, readForwardReport } from "./ForwardReportService";

test("normalizes a forward report and hides non-public fields", () => {
  const report = normalizeForwardReport({
    routeId: "ict-route-b-100x-cross-margin-2pct",
    status: "collecting",
    forwardStart: 1784073600,
    through: 1784093700,
    elapsedDays: 0.23,
    observationGate: { minimumDays: 60, minimumCompletedTrades: 50, mode: "either", reached: false },
    assumptions: { initialMarginFraction: 0.02, automaticOrdersEnabled: true },
    dataQuality: { source: "binance_futures_public_rest", interval: "5m", candleCount: 2084, missingBarCount: 0 },
    metrics: { initialEquity: 10000, finalEquity: 10000, netPnl: 0, tradeCount: 0, profitFactor: 0, averageR: 0, totalFees: 0, maxDrawdownFraction: 0 },
    diagnostics: { signals: 1, filledOrders: 0, expiredOrders: 1, costRejectedOrders: 0, byRegime: { asia: { signals: 1 } } },
    openPosition: { side: "long", signalTime: 1784080000, entryTime: 1784080300, entryPrice: 100, stopPrice: 99, targetPrice: 102, quantity: 1, netPnl: 0, rMultiple: 0, fees: 1, exitReason: "end_of_data", internalPath: "/tmp/secret" },
    recentCompletedTrades: [],
    output: "/tmp/research-ict-route-b-forward.json",
  });
  assert.equal(report.assumptions.automaticOrdersEnabled, false);
  assert.equal(report.assumptions.venue, "binance_usdm_btcusdt_perpetual");
  assert.equal(report.assumptions.marginFraction, 0.02);
  assert.equal(report.metrics.profitFactor, null);
  assert.equal(report.diagnostics.filled, 0);
  assert.equal(report.diagnostics.expired, 1);
  assert.equal(report.openPosition?.entryPrice, 100);
  assert.ok(!("internalPath" in report.openPosition!));
  assert.deepEqual(report.warnings, []);
});

test("returns a safe empty state when no forward report exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-forward-empty-"));
  try {
    const result = await readForwardReport(path.join(directory, "missing.json"), { includeLegacyFallback: false });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 200);
    assert.equal(result.report.status, "unavailable");
    assert.deepEqual(result.report.warnings, ["no_report"]);
    assert.equal(result.report.assumptions.automaticOrdersEnabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a sanitized unavailable response for a damaged forward report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-forward-damaged-"));
  try {
    const file = path.join(directory, "report.json");
    await writeFile(file, "{not-json", "utf8");
    const result = await readForwardReport(file);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.report.status, "unavailable");
    assert.deepEqual(result.report.warnings, ["report_unreadable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strategy forward route rejects unauthenticated requests", async () => {
  const app = express();
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/strategy/ict/forward`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "用户未登录或登录已失效。" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("strategy forward route returns a normalized report for authenticated users", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-forward-route-"));
  const previousPath = process.env.STRATEGY_FORWARD_REPORT_PATH;
  const file = path.join(directory, "report.json");
  process.env.STRATEGY_FORWARD_REPORT_PATH = file;
  await writeFile(file, JSON.stringify({
    status: "collecting",
    forwardStart: 1784073600,
    through: 1784093700,
    metrics: { tradeCount: 1, netPnl: 10, profitFactor: 2, averageR: 1, maxDrawdownFraction: 0.01, initialEquity: 10000, finalEquity: 10010, totalFees: 1 },
    diagnostics: { signals: 1, filledOrders: 1, expiredOrders: 0, costRejectedOrders: 0, byRegime: {} },
  }), "utf8");
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "USR-test", email: "test@example.com", nickname: "Test", status: "active", createdAt: "2026-07-15T00:00:00.000Z", emailVerifiedAt: "2026-07-15T00:00:00.000Z" };
    next();
  });
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/strategy/ict/forward`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.status, "collecting");
    assert.equal(body.metrics.tradeCount, 1);
    assert.equal(body.assumptions.automaticOrdersEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousPath === undefined) delete process.env.STRATEGY_FORWARD_REPORT_PATH;
    else process.env.STRATEGY_FORWARD_REPORT_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
