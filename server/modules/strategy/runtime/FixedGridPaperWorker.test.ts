import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "./MartingaleGridPaperEngine";
import { FixedGridPaperWorker } from "./FixedGridPaperWorker";

test("fixed grid worker writes one Paper report and never enables exchange orders", async () => {
  const fixtures = makeFixtures();
  let writes = 0;
  let automaticOrdersEnabled: boolean | null = null;
  const worker = new FixedGridPaperWorker({
    now: fixedNow,
    loadLatestClosedCandle: async (symbol) => fixtures[symbol].at(-1)!,
    loadCandles: async (symbol) => fixtures[symbol],
    writeReport: async (report) => { writes += 1; automaticOrdersEnabled = report.assumptions.automaticOrdersEnabled; },
  });
  await worker.checkNow();
  await worker.checkNow();
  assert.equal(writes, 1);
  assert.equal(automaticOrdersEnabled, false);
  assert.equal(worker.getStatus().consecutiveFailures, 0);
});

test("fixed grid worker is single-flight across BTC and ETH", async () => {
  const fixtures = makeFixtures();
  let loads = 0;
  const holder: { release?: () => void } = {};
  const worker = new FixedGridPaperWorker({
    now: fixedNow,
    loadLatestClosedCandle: async (symbol) => fixtures[symbol].at(-1)!,
    loadCandles: async (symbol) => {
      loads += 1;
      if (loads === 1) await new Promise<void>((resolve) => { holder.release = resolve; });
      return fixtures[symbol];
    },
    writeReport: async () => undefined,
  });
  const first = worker.checkNow();
  const second = worker.checkNow();
  while (!holder.release) await Promise.resolve();
  holder.release();
  await Promise.all([first, second]);
  assert.equal(loads, MARTINGALE_GRID_SYMBOLS.length);
});

test("fixed grid worker falls back to verified Binance Vision archive semantics when REST is unavailable", async () => {
  const fixtures = makeFixtures();
  let source: string | null = null;
  const worker = new FixedGridPaperWorker({
    now: fixedNow,
    loadLatestClosedCandle: async () => { throw new Error("restricted location"); },
    loadLatestArchiveCandle: async (symbol) => fixtures[symbol].at(-1)!,
    loadArchiveCandles: async (symbol) => fixtures[symbol],
    writeReport: async (report) => { source = report.dataQuality.source; },
  });
  await worker.checkNow();
  assert.equal(source, "binance_vision_usdm_archive");
  assert.equal(worker.getStatus().lastError, null);
});

function fixedNow() { return Date.parse("2026-07-18T00:00:00.000Z"); }

function makeFixtures(): Record<MartingaleGridSymbol, Candle[]> {
  const start = Math.floor(Date.parse("2026-07-10T00:00:00.000Z") / 1000);
  return Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol, symbolIndex) => [symbol, Array.from({ length: 700 }, (_, index) => {
    const price = (symbolIndex === 0 ? 60_000 : 3_000) + index * (symbolIndex === 0 ? 2 : 0.1);
    return { symbol, interval: "5m", time: start + index * 300, open: price, high: price + 1, low: price - 1, close: price + 0.2, volume: 10 } satisfies Candle;
  })])) as Record<MartingaleGridSymbol, Candle[]>;
}
