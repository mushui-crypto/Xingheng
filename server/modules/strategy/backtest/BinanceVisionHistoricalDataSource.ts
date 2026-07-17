import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Candle } from "../../../types";

const execFileAsync = promisify(execFile);
const defaultBaseUrl = "https://data.binance.vision/data/futures/um/monthly/klines";
const defaultDailyBaseUrl = "https://data.binance.vision/data/futures/um/daily/klines";

export type BinanceVisionMonthRequest = {
  symbol: SupportedResearchSymbol;
  year: number;
  month: number;
};

export type BinanceVisionDayRequest = {
  symbol: SupportedResearchSymbol;
  date: string;
};

export type HistoricalDataQuality = {
  source: "binance_vision_usdm";
  market: SupportedResearchSymbol;
  interval: "5m";
  files: string[];
  checksumVerified: boolean;
  candleCount: number;
  duplicateCount: number;
  missingBarCount: number;
  firstCandleTime: number | null;
  lastCandleTime: number | null;
};

export class BinanceVisionHistoricalDataSource {
  constructor(
    private baseUrl = defaultBaseUrl,
    private cacheDirectory = path.resolve(".cache/strategy/binance-vision"),
    private dailyBaseUrl = defaultDailyBaseUrl,
  ) {}

  async loadMonths(requests: BinanceVisionMonthRequest[]) {
    if (requests.length === 0) throw new Error("At least one Binance Vision month is required.");
    const market = requests[0].symbol;
    if (requests.some((request) => request.symbol !== market)) throw new Error("A research dataset may only contain one market.");
    const all: Candle[] = [];
    const files: string[] = [];
    for (const request of requests) {
      const result = await this.loadMonth(request);
      all.push(...result.candles);
      files.push(result.fileName);
    }
    const { candles, duplicateCount } = normalizeCandles(all);
    const quality: HistoricalDataQuality = {
      source: "binance_vision_usdm",
      market,
      interval: "5m",
      files,
      checksumVerified: true,
      candleCount: candles.length,
      duplicateCount,
      missingBarCount: countMissingBars(candles),
      firstCandleTime: candles[0]?.time ?? null,
      lastCandleTime: candles.at(-1)?.time ?? null,
    };
    return { candles, quality };
  }

  async loadMonth(request: BinanceVisionMonthRequest) {
    validateMonth(request);
    const month = String(request.month).padStart(2, "0");
    const fileName = `${request.symbol}-5m-${request.year}-${month}.zip`;
    const directory = path.join(this.cacheDirectory, request.symbol, "5m");
    const zipPath = path.join(directory, fileName);
    const checksumPath = `${zipPath}.CHECKSUM`;
    const csvCachePath = `${zipPath}.candles-v2.json`;
    const csvCacheChecksumPath = `${csvCachePath}.SOURCE_SHA256`;
    await mkdir(directory, { recursive: true });

    await Promise.all([
      ensureDownloaded(`${this.baseUrl}/${request.symbol}/5m/${fileName}`, zipPath),
      ensureDownloaded(`${this.baseUrl}/${request.symbol}/5m/${fileName}.CHECKSUM`, checksumPath),
    ]);
    const archiveChecksum = await verifyChecksum(zipPath, checksumPath);

    const [cached, cachedSourceChecksum] = await Promise.all([
      readFile(csvCachePath, "utf8").then((value) => JSON.parse(value) as Candle[]).catch(() => null),
      readFile(csvCacheChecksumPath, "utf8").then((value) => value.trim()).catch(() => null),
    ]);
    if (cached?.length && cachedSourceChecksum === archiveChecksum) {
      return { fileName, candles: normalizeCandles(cached).candles };
    }

    const { stdout } = await execFileAsync("unzip", ["-p", zipPath], { maxBuffer: 128 * 1024 * 1024 });
    const candles = parseBinanceKlines(stdout, request.symbol);
    if (candles.length === 0) throw new Error(`Binance Vision file ${fileName} contains no valid candles.`);
    await Promise.all([
      writeFile(csvCachePath, `${JSON.stringify(candles)}\n`, "utf8"),
      writeFile(csvCacheChecksumPath, `${archiveChecksum}\n`, "utf8"),
    ]);
    return { fileName, candles };
  }

  async loadDays(requests: BinanceVisionDayRequest[]) {
    if (requests.length === 0) throw new Error("At least one Binance Vision day is required.");
    const market = requests[0].symbol;
    if (requests.some((request) => request.symbol !== market)) throw new Error("A research dataset may only contain one market.");
    const all: Candle[] = [];
    const files: string[] = [];
    for (const request of requests) {
      const result = await this.loadDay(request);
      all.push(...result.candles);
      files.push(result.fileName);
    }
    const { candles, duplicateCount } = normalizeCandles(all);
    const quality: HistoricalDataQuality = {
      source: "binance_vision_usdm",
      market,
      interval: "5m",
      files,
      checksumVerified: true,
      candleCount: candles.length,
      duplicateCount,
      missingBarCount: countMissingBars(candles),
      firstCandleTime: candles[0]?.time ?? null,
      lastCandleTime: candles.at(-1)?.time ?? null,
    };
    return { candles, quality };
  }

  async loadDay(request: BinanceVisionDayRequest) {
    validateDay(request);
    const fileName = `${request.symbol}-5m-${request.date}.zip`;
    const directory = path.join(this.cacheDirectory, request.symbol, "5m", "daily");
    const zipPath = path.join(directory, fileName);
    const checksumPath = `${zipPath}.CHECKSUM`;
    const csvCachePath = `${zipPath}.candles-v2.json`;
    const csvCacheChecksumPath = `${csvCachePath}.SOURCE_SHA256`;
    await mkdir(directory, { recursive: true });

    await Promise.all([
      ensureDownloaded(`${this.dailyBaseUrl}/${request.symbol}/5m/${fileName}`, zipPath),
      ensureDownloaded(`${this.dailyBaseUrl}/${request.symbol}/5m/${fileName}.CHECKSUM`, checksumPath),
    ]);
    const archiveChecksum = await verifyChecksum(zipPath, checksumPath);

    const [cached, cachedSourceChecksum] = await Promise.all([
      readFile(csvCachePath, "utf8").then((value) => JSON.parse(value) as Candle[]).catch(() => null),
      readFile(csvCacheChecksumPath, "utf8").then((value) => value.trim()).catch(() => null),
    ]);
    if (cached?.length && cachedSourceChecksum === archiveChecksum) {
      return { fileName, candles: normalizeCandles(cached).candles };
    }

    const { stdout } = await execFileAsync("unzip", ["-p", zipPath], { maxBuffer: 16 * 1024 * 1024 });
    const candles = parseBinanceKlines(stdout, request.symbol);
    if (candles.length === 0) throw new Error(`Binance Vision file ${fileName} contains no valid candles.`);
    await Promise.all([
      writeFile(csvCachePath, `${JSON.stringify(candles)}\n`, "utf8"),
      writeFile(csvCacheChecksumPath, `${archiveChecksum}\n`, "utf8"),
    ]);
    return { fileName, candles };
  }
}

export function monthRange(start: string, end: string, symbol: SupportedResearchSymbol = "BTCUSDT"): BinanceVisionMonthRequest[] {
  const [startYear, startMonth] = parseYearMonth(start);
  const [endYear, endMonth] = parseYearMonth(end);
  const requests: BinanceVisionMonthRequest[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    requests.push({ symbol, year, month });
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return requests;
}

export function dayRange(start: string, end: string, symbol: SupportedResearchSymbol = "BTCUSDT"): BinanceVisionDayRequest[] {
  const startTime = parseDate(start);
  const endTime = parseDate(end);
  if (startTime > endTime) throw new Error("Daily research start must not be after end.");
  const requests: BinanceVisionDayRequest[] = [];
  for (let time = startTime; time <= endTime; time += 24 * 60 * 60 * 1000) {
    requests.push({ symbol, date: new Date(time).toISOString().slice(0, 10) });
  }
  return requests;
}

async function ensureDownloaded(url: string, target: string) {
  const existing = await readFile(target).catch(() => null);
  if (existing?.length) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Binance Vision download failed: ${response.status} ${url}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function verifyChecksum(zipPath: string, checksumPath: string) {
  const checksumText = await readFile(checksumPath, "utf8");
  const expected = checksumText.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid checksum file: ${checksumPath}`);
  const actual = crypto.createHash("sha256").update(await readFile(zipPath)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${path.basename(zipPath)}.`);
  return actual;
}

export function parseBinanceKlines(csv: string, symbol = "BTCUSDT") {
  const candles: Candle[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = line.split(",");
    const openTime = Number(columns[0]);
    const open = Number(columns[1]);
    const high = Number(columns[2]);
    const low = Number(columns[3]);
    const close = Number(columns[4]);
    const volume = Number(columns[5]);
    const quoteVolume = Number(columns[7]);
    const tradeCount = Number(columns[8]);
    const takerBuyBaseVolume = Number(columns[9]);
    const takerBuyQuoteVolume = Number(columns[10]);
    if (![
      openTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume,
      tradeCount,
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
    ].every(Number.isFinite)) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) continue;
    if (
      volume < 0 || quoteVolume < 0 || tradeCount < 0 ||
      takerBuyBaseVolume < 0 || takerBuyQuoteVolume < 0 ||
      takerBuyBaseVolume > volume + 1e-9 || takerBuyQuoteVolume > quoteVolume + 1e-6
    ) continue;
    candles.push({
      symbol,
      interval: "5m",
      time: Math.trunc(openTime / 1000),
      open,
      high,
      low,
      close,
      volume,
      quoteVolume,
      tradeCount: Math.trunc(tradeCount),
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
    });
  }
  return normalizeCandles(candles).candles;
}

function normalizeCandles(candles: Candle[]) {
  const byTime = new Map<number, Candle>();
  let duplicateCount = 0;
  for (const candle of candles) {
    if (byTime.has(candle.time)) duplicateCount += 1;
    byTime.set(candle.time, candle);
  }
  return { candles: [...byTime.values()].sort((left, right) => left.time - right.time), duplicateCount };
}

function countMissingBars(candles: Candle[]) {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}

function validateMonth(request: BinanceVisionMonthRequest) {
  if (!supportedResearchSymbols.includes(request.symbol)) throw new Error("Research only permits approved Binance USD-M perpetual symbols.");
  if (!Number.isInteger(request.year) || request.year < 2020 || request.year > 2100) throw new Error("Invalid Binance Vision year.");
  if (!Number.isInteger(request.month) || request.month < 1 || request.month > 12) throw new Error("Invalid Binance Vision month.");
}

function validateDay(request: BinanceVisionDayRequest) {
  if (!supportedResearchSymbols.includes(request.symbol)) throw new Error("Research only permits approved Binance USD-M perpetual symbols.");
  parseDate(request.date);
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date ${value}; expected YYYY-MM-DD.`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`Invalid date ${value}.`);
  return time;
}

export type SupportedResearchSymbol = "BTCUSDT" | "ETHUSDT";
const supportedResearchSymbols: SupportedResearchSymbol[] = ["BTCUSDT", "ETHUSDT"];

function parseYearMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid month ${value}; expected YYYY-MM.`);
  return [Number(match[1]), Number(match[2])] as const;
}
