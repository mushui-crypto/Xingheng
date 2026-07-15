import { readFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? process.env.STRATEGY_HISTORY_REPORT_PATH ?? "server/data/strategy/research-ict-route-b-history.json");
const report = JSON.parse(readFileSync(file, "utf8"));

const failures = [];
if (report.routeId !== "ict-route-b-100x-cross-margin-2pct") failures.push("routeId mismatch");
if (typeof report.dataThrough !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(report.dataThrough)) failures.push("dataThrough missing or invalid");
if (!Number.isFinite(report.metrics?.tradeCount) || report.metrics.tradeCount < 0) failures.push("tradeCount missing or invalid");
if (report.assumptions?.automaticOrdersEnabled !== false) failures.push("automaticOrdersEnabled must be false");

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  file,
  routeId: report.routeId,
  dataThrough: report.dataThrough,
  tradeCount: report.metrics.tradeCount,
  automaticOrdersEnabled: report.assumptions.automaticOrdersEnabled,
}, null, 2));
