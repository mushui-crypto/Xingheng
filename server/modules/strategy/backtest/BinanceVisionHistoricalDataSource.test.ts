import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
  parseBinanceKlines,
} from "./BinanceVisionHistoricalDataSource";

test("parses Binance USD-M kline CSV into the normalized Candle contract", () => {
  const candles = parseBinanceKlines([
    "1591258320000,9640.7,9642.4,9640.6,9642.0,206,1591258379999,2.1,48,119,1.2,0",
    "1591258380000,9642.0,9645.0,9641.0,9644.0,300,1591258439999,3.1,55,120,1.3,0",
  ].join("\n"));
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], {
    symbol: "BTCUSDT",
    interval: "5m",
    time: 1591258320,
    open: 9640.7,
    high: 9642.4,
    low: 9640.6,
    close: 9642,
    volume: 206,
    quoteVolume: 2.1,
    tradeCount: 48,
    takerBuyBaseVolume: 119,
    takerBuyQuoteVolume: 1.2,
  });
});

test("builds an inclusive daily range across a month boundary", () => {
  assert.deepEqual(dayRange("2026-06-30", "2026-07-02"), [
    { symbol: "BTCUSDT", date: "2026-06-30" },
    { symbol: "BTCUSDT", date: "2026-07-01" },
    { symbol: "BTCUSDT", date: "2026-07-02" },
  ]);
});

test("builds an inclusive chronological month range", () => {
  assert.deepEqual(monthRange("2025-11", "2026-02"), [
    { symbol: "BTCUSDT", year: 2025, month: 11 },
    { symbol: "BTCUSDT", year: 2025, month: 12 },
    { symbol: "BTCUSDT", year: 2026, month: 1 },
    { symbol: "BTCUSDT", year: 2026, month: 2 },
  ]);
});

test("preserves the requested ETHUSDT market in daily and monthly ranges", () => {
  assert.deepEqual(monthRange("2026-05", "2026-06", "ETHUSDT"), [
    { symbol: "ETHUSDT", year: 2026, month: 5 },
    { symbol: "ETHUSDT", year: 2026, month: 6 },
  ]);
  assert.deepEqual(dayRange("2026-07-13", "2026-07-14", "ETHUSDT"), [
    { symbol: "ETHUSDT", date: "2026-07-13" },
    { symbol: "ETHUSDT", date: "2026-07-14" },
  ]);
});

test("does not let a parsed candle cache bypass the official archive checksum", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "binance-vision-checksum-"));
  context.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  const directory = path.join(cacheDirectory, "ETHUSDT", "5m");
  const zipPath = path.join(directory, "ETHUSDT-5m-2026-06.zip");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(zipPath, "corrupt archive", "utf8"),
    writeFile(`${zipPath}.CHECKSUM`, `${"0".repeat(64)}  ETHUSDT-5m-2026-06.zip\n`, "utf8"),
    writeFile(`${zipPath}.candles.json`, JSON.stringify([{
      symbol: "ETHUSDT",
      interval: "5m",
      time: 1_717_200_000,
      open: 3_000,
      high: 3_010,
      low: 2_990,
      close: 3_005,
      volume: 100,
    }]), "utf8"),
  ]);

  const source = new BinanceVisionHistoricalDataSource("https://invalid.example", cacheDirectory);
  await assert.rejects(
    source.loadMonth({ symbol: "ETHUSDT", year: 2026, month: 6 }),
    /Checksum mismatch/,
  );
});
