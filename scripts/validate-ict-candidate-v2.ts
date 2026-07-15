import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ictResearchCandidateV2WorkerParameters } from "../server/modules/strategy/models/ictResearchCandidate";

const execFileAsync = promisify(execFile);
const tsx = path.resolve("node_modules/.bin/tsx");
const worker = path.resolve("scripts/research-ict-combination.ts");
const segments = [
  { id: "validation-2025-h1", role: "validation", start: "2025-01", end: "2025-06" },
  { id: "validation-2025-h2", role: "validation", start: "2025-07", end: "2025-12" },
  { id: "holdout-2026-h1", role: "final_holdout", start: "2026-01", end: "2026-06" },
] as const;

const results: SegmentResult[] = [];
for (const segment of segments) {
  process.stderr.write(`Frozen ICT candidate v2: ${segment.id}\n`);
  const { stdout } = await execFileAsync(
    tsx,
    [worker, segment.start, segment.end, JSON.stringify(ictResearchCandidateV2WorkerParameters)],
    { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } },
  );
  results.push({ ...segment, result: JSON.parse(stdout) as WorkerResult });
}

const validationSegments = results.filter((item) => item.role === "validation");
const holdoutSegments = results.filter((item) => item.role === "final_holdout");
const validation = aggregate(validationSegments);
const finalHoldout = aggregate(holdoutSegments);
const validationGate = {
  annualTrades: validation.tradeCount >= 80 && validation.tradeCount <= 150,
  positiveNetPnl: validation.netPnl > 0,
  profitFactor: validation.profitFactor !== null && validation.profitFactor >= 1.15,
  averageR: validation.averageR >= 0.1,
  halfYearStability: validationSegments.every((item) => item.result.row.metrics.netPnl > 0),
  maxDrawdown: validation.maxDrawdownFraction <= 0.05,
};
const validationPassed = Object.values(validationGate).every(Boolean);
const holdoutGate = {
  annualizedTrades: finalHoldout.tradeCount >= 40 && finalHoldout.tradeCount <= 75,
  positiveNetPnl: finalHoldout.netPnl > 0,
  profitFactor: finalHoldout.profitFactor !== null && finalHoldout.profitFactor >= 1.1,
  averageR: finalHoldout.averageR > 0,
  maxDrawdown: finalHoldout.maxDrawdownFraction <= 0.05,
};
const holdoutPassed = Object.values(holdoutGate).every(Boolean);
const output = path.resolve("research-ict-candidate-v2-2025-01-2026-06.json");
await writeFile(output, `${JSON.stringify({
  candidate: ictResearchCandidateV2WorkerParameters,
  dataPolicy: {
    development: "2024-01..2024-12",
    validation: "2025-01..2025-12",
    finalHoldout: "2026-01..2026-06",
    frozenBeforeValidation: true,
  },
  segments: results,
  validation,
  validationGate,
  validationPassed,
  finalHoldout,
  holdoutGate,
  holdoutPassed,
  shadowEligible: validationPassed && holdoutPassed,
  automaticExecutionEligible: false,
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, validation, validationGate, validationPassed, finalHoldout, holdoutGate, holdoutPassed }, null, 2));

function aggregate(items: SegmentResult[]) {
  const metrics = items.map((item) => item.result.row.metrics);
  const tradeCount = metrics.reduce((sum, item) => sum + item.tradeCount, 0);
  const grossProfit = metrics.reduce((sum, item) => sum + item.grossProfit, 0);
  const grossLoss = metrics.reduce((sum, item) => sum + item.grossLoss, 0);
  return {
    tradeCount,
    netPnl: metrics.reduce((sum, item) => sum + item.netPnl, 0),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: tradeCount ? metrics.reduce((sum, item) => sum + item.averageR * item.tradeCount, 0) / tradeCount : 0,
    totalFees: metrics.reduce((sum, item) => sum + item.totalFees, 0),
    maxDrawdownFraction: Math.max(0, ...metrics.map((item) => item.maxDrawdownFraction)),
    worstTradeR: Math.min(0, ...metrics.map((item) => item.worstTradeR)),
    maxAdverseR: Math.max(0, ...metrics.map((item) => item.maxAdverseR)),
  };
}

type Metrics = {
  tradeCount: number; netPnl: number; grossProfit: number; grossLoss: number; averageR: number;
  totalFees: number; maxDrawdownFraction: number; worstTradeR: number; maxAdverseR: number;
};
type WorkerResult = { row: { metrics: Metrics } } & Record<string, unknown>;
type SegmentResult = typeof segments[number] & { result: WorkerResult };
