import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const study = args[0]?.startsWith("v") ? args.shift()! : "v2";
const years = args.length ? args.map(Number) : [2021, 2022, 2023];
const reports = await Promise.all(years.map(async (year) => {
  const file = path.resolve(`research-ict-grid-${study}-${year}-01-${year}-12.json`);
  return JSON.parse(await readFile(file, "utf8")) as ResearchReport;
}));
const groups = new Map<string, CombinedRow>();
for (let reportIndex = 0; reportIndex < reports.length; reportIndex += 1) {
  const year = years[reportIndex];
  for (const row of reports[reportIndex].rows) {
    const key = JSON.stringify(row.parameters);
    const group = groups.get(key) ?? {
      parameters: row.parameters,
      yearly: {},
      tradeCount: 0,
      netPnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      totalFees: 0,
      weightedR: 0,
      maxDrawdownFraction: 0,
      profitableYears: 0,
    };
    group.yearly[year] = row.metrics;
    group.tradeCount += row.metrics.tradeCount;
    group.netPnl += row.metrics.netPnl;
    group.grossProfit += row.metrics.grossProfit;
    group.grossLoss += row.metrics.grossLoss;
    group.totalFees += row.metrics.totalFees;
    group.weightedR += row.metrics.averageR * row.metrics.tradeCount;
    group.maxDrawdownFraction = Math.max(group.maxDrawdownFraction, row.metrics.maxDrawdownFraction);
    group.profitableYears += row.metrics.netPnl > 0 ? 1 : 0;
    groups.set(key, group);
  }
}
const rows = [...groups.values()].map((group) => ({
  ...group,
  averageR: group.tradeCount ? group.weightedR / group.tradeCount : 0,
  profitFactor: group.grossLoss > 0 ? group.grossProfit / group.grossLoss : group.grossProfit > 0 ? null : 0,
  statisticallySufficient: group.tradeCount >= 30,
})).sort((left, right) => score(right) - score(left));
const output = path.resolve(`research-ict-development-${study}-${years[0]}-${years.at(-1)}.json`);
await writeFile(output, `${JSON.stringify({ study, datasetRole: "development_only", years, rows }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, top: rows.slice(0, 10) }, null, 2));

function score(row: typeof rows[number]) {
  if (!row.statisticallySufficient) return -1_000_000 + row.tradeCount;
  return row.averageR * 100 + (row.profitFactor ?? 10) * 10 + row.profitableYears * 5 - row.maxDrawdownFraction * 100;
}

type Metrics = {
  tradeCount: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  totalFees: number;
  averageR: number;
  maxDrawdownFraction: number;
};
type ResearchReport = { rows: Array<{ parameters: Record<string, unknown>; metrics: Metrics }> };
type CombinedRow = {
  parameters: Record<string, unknown>;
  yearly: Record<number, Metrics>;
  tradeCount: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  totalFees: number;
  weightedR: number;
  maxDrawdownFraction: number;
  profitableYears: number;
};
