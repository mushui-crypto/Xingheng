import path from "node:path";
import {
  atomicWriteJson,
  buildRouteBForwardReport,
  countMissingBars,
  loadBinanceFuturesClosedKlines,
  ROUTE_B_FORWARD_START,
  ROUTE_B_FORWARD_START_ISO,
} from "../server/modules/strategy/runtime/RouteBPaperEngine";

const forwardStartText = process.argv[2] ?? ROUTE_B_FORWARD_START_ISO;
const forwardStart = Math.floor(Date.parse(forwardStartText) / 1000);
if (!Number.isFinite(forwardStart)) throw new Error("Forward start must be an ISO-8601 timestamp.");

const now = Math.floor(Date.now() / 1000);
const historyStart = forwardStart - 7 * 24 * 60 * 60;
const candles = await loadBinanceFuturesClosedKlines({ startTime: historyStart, endTime: now });
if (candles.length <= 300) throw new Error("Binance forward source returned insufficient 5m history.");
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`Binance forward source contains ${missingBarCount} missing 5m bars.`);

const report = buildRouteBForwardReport(candles, { forwardStart: forwardStart || ROUTE_B_FORWARD_START });
const output = path.resolve(process.env.STRATEGY_FORWARD_REPORT_PATH ?? "server/data/strategy/research-ict-route-b-forward.json");
await atomicWriteJson(output, report);
console.log(JSON.stringify({ output, ...report, recentCompletedTrades: undefined }, null, 2));
