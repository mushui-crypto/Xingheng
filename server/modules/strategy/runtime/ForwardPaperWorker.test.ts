import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Candle } from "../../../types";
import { ForwardPaperWorker } from "./ForwardPaperWorker";
import { atomicWriteJson, ROUTE_B_FORWARD_START } from "./RouteBPaperEngine";

test("forward paper worker starts with an immediate run and keeps automatic orders disabled", async () => {
  let writes = 0;
  let lastReport: any = null;
  const worker = new ForwardPaperWorker({
    now: fixedNow,
    loadCandles: async () => makeCandles(ROUTE_B_FORWARD_START - 900, 6),
    writeReport: async (report) => {
      writes += 1;
      lastReport = report;
    },
    setTimer: (() => 1 as any),
    clearTimer: (() => undefined),
  });
  worker.start();
  await worker.checkNow();
  worker.stop();
  assert.equal(writes, 1);
  assert.equal(lastReport.assumptions.automaticOrdersEnabled, false);
  assert.equal(worker.getStatus().consecutiveFailures, 0);
});

test("forward paper worker does not rewrite when closed candle has not advanced", async () => {
  let writes = 0;
  const candles = makeCandles(ROUTE_B_FORWARD_START - 900, 6);
  const worker = new ForwardPaperWorker({
    now: fixedNow,
    loadCandles: async () => candles,
    writeReport: async () => { writes += 1; },
  });
  await worker.checkNow();
  await worker.checkNow();
  assert.equal(writes, 1);
});

test("forward paper worker is single-flight", async () => {
  let loadCount = 0;
  const holder: { release?: () => void } = {};
  const worker = new ForwardPaperWorker({
    now: fixedNow,
    loadCandles: async () => {
      loadCount += 1;
      await new Promise<void>((resolve) => { holder.release = resolve; });
      return makeCandles(ROUTE_B_FORWARD_START - 900, 6);
    },
    writeReport: async () => undefined,
  });
  const first = worker.checkNow();
  const second = worker.checkNow();
  assert.equal(loadCount, 1);
  assert.ok(holder.release);
  holder.release();
  await Promise.all([first, second]);
  assert.equal(loadCount, 1);
});

test("forward paper worker records sanitized failures and keeps previous report", async () => {
  let writes = 0;
  const worker = new ForwardPaperWorker({
    now: fixedNow,
    loadCandles: async () => {
      throw new Error("fetch failed https://example.com/secret-token-abcdefghijklmnopqrstuvwxyz123456");
    },
    writeReport: async () => { writes += 1; },
  });
  await worker.checkNow();
  const status = worker.getStatus();
  assert.equal(writes, 0);
  assert.equal(status.consecutiveFailures, 1);
  assert.match(status.lastError ?? "", /\[url\]/);
  assert.doesNotMatch(status.lastError ?? "", /secret-token/);
});

test("atomicWriteJson writes recoverable JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingheng-forward-atomic-"));
  try {
    const file = path.join(directory, "report.json");
    await atomicWriteJson(file, { ok: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forward paper worker stop clears timer", () => {
  let cleared = false;
  const worker = new ForwardPaperWorker({
    now: fixedNow,
    loadCandles: async () => makeCandles(ROUTE_B_FORWARD_START - 900, 6),
    writeReport: async () => undefined,
    setTimer: (() => 7 as any),
    clearTimer: (() => { cleared = true; }),
  });
  worker.start();
  worker.stop();
  assert.equal(cleared, true);
  assert.equal(worker.getStatus().nextCheckAt, null);
});

function fixedNow() {
  return (ROUTE_B_FORWARD_START + 1_800) * 1000;
}

function makeCandles(start: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const price = 100 + index;
    return {
      symbol: "BTCUSDT",
      interval: "5m",
      time: start + index * 300,
      open: price,
      high: price + 1,
      low: price - 1,
      close: price + 0.5,
      volume: 10,
    };
  });
}
