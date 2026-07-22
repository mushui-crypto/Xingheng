import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerStrategyRoutes } from "../../api/strategyRoutes";
import { MARTINGALE_GRID_ROUTE_ID } from "./MartingaleGridPaperEngine";
import { normalizeMartingaleGridReport, readMartingaleGridReport } from "./MartingaleGridReportService";

test("martingale report normalization cannot enable automatic orders", () => {
  const report = normalizeMartingaleGridReport({
    routeId: MARTINGALE_GRID_ROUTE_ID,
    status: "collecting",
    forwardStart: 1_784_246_400,
    assumptions: { automaticOrdersEnabled: true, apiKey: "secret" },
    configuration: { maximumLayers: 5 },
    dataQuality: { symbols: {} },
    metrics: {},
    diagnostics: { bySymbol: {} },
    openGroups: [],
    recentCompletedGroups: [],
  });
  assert.equal(report.assumptions.automaticOrdersEnabled, false);
  assert.equal(report.assumptions.exchangeCredentialsRequired, false);
  assert.ok(!("apiKey" in report.assumptions));
});

test("martingale report service returns safe missing and damaged states", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-martingale-report-"));
  try {
    const missing = await readMartingaleGridReport(path.join(directory, "missing.json"));
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error("expected missing report");
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.report.status, "unavailable");
    assert.deepEqual(missing.report.warnings, ["no_report"]);
    const damagedPath = path.join(directory, "damaged.json");
    await writeFile(damagedPath, "{not-json", "utf8");
    const damaged = await readMartingaleGridReport(damagedPath);
    assert.equal(damaged.ok, false);
    if (damaged.ok) throw new Error("expected damaged report");
    assert.equal(damaged.statusCode, 503);
    assert.deepEqual(damaged.report.warnings, ["report_unreadable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("martingale forward route allows anonymous read-only requests", async () => {
  const app = express();
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/strategy/martingale/forward`);
    assert.notEqual(response.status, 401);
    assert.equal(typeof (await response.json() as any).status, "string");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
