import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerStrategyRoutes } from "../../api/strategyRoutes";
import { readFixedGridReport } from "./FixedGridReportService";

test("fixed grid report service returns safe missing and damaged states", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-fixed-grid-report-"));
  try {
    const missing = await readFixedGridReport(path.join(directory, "missing.json"));
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error("expected missing report");
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.report.status, "unavailable");
    assert.deepEqual(missing.report.warnings, ["no_report"]);

    const damagedPath = path.join(directory, "damaged.json");
    await writeFile(damagedPath, "{not-json", "utf8");
    const damaged = await readFixedGridReport(damagedPath);
    assert.equal(damaged.ok, false);
    if (damaged.ok) throw new Error("expected damaged report");
    assert.equal(damaged.statusCode, 503);
    assert.deepEqual(damaged.report.warnings, ["report_unreadable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed grid forward route is login-protected", async () => {
  const app = express();
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/strategy/martingale/fixed-grid/forward`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "用户未登录或登录已失效。" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
