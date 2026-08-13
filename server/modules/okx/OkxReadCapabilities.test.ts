import assert from "node:assert/strict";
import test from "node:test";
import { OkxFundingRate } from "./OkxFundingRate";
import { OkxInstrumentCatalog } from "./OkxInstrumentCatalog";
import { createOkxTickerSource, OkxMarketData } from "./OkxMarketData";
import type { OkxFundingRateRecord, OkxSwapInstrument, OkxTickerRecord } from "./OkxReadTypes";

const fetchedAt = 1_800_000_000_000;
const instrumentId = "BTC-USDT-PERP";
const rawInstrument: OkxSwapInstrument = {
  instType: "SWAP",
  instId: "BTC-USDT-SWAP",
  uly: "BTC-USDT",
  settleCcy: "USDT",
  ctType: "linear",
  ctVal: "0.01",
  ctValCcy: "BTC",
  tickSz: "0.1",
  lotSz: "1",
  minSz: "1",
  state: "live",
};

test("OKX catalog preserves contract-denominated quantity semantics", async () => {
  const catalog = new OkxInstrumentCatalog(async () => ({ instruments: [rawInstrument], fetchedAt }));

  assert.deepEqual(await catalog.listInstruments(), [{
    instrumentId,
    venue: "okx",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: "BTC-USDT-SWAP",
    providerLocator: { instType: "SWAP" },
    quantityUnit: "contract",
    contractSize: 0.01,
    priceTick: 0.1,
    quantityStep: 1,
    minQuantity: 1,
    minNotional: null,
    status: "trading",
    fetchedAt,
  }]);
});

test("OKX catalog skips inverse contracts without losing supported linear contracts", async () => {
  const diagnostics: unknown[] = [];
  const catalog = new OkxInstrumentCatalog(async () => ({
    instruments: [{ ...rawInstrument, ctType: "inverse" }, rawInstrument],
    fetchedAt,
  }), (diagnostic) => diagnostics.push(diagnostic));

  const instruments = await catalog.listInstruments();
  assert.equal(instruments.length, 1);
  assert.equal(instruments[0]?.instrumentId, instrumentId);
  assert.equal(instruments[0]?.contractSize, 0.01);
  assert.deepEqual(diagnostics, [{
    venue: "okx",
    skipped: 1,
    reasons: { unsupported_contract_type: 1 },
  }]);
});

test("OKX current funding maps its two future settlement timestamps without a mark price", async () => {
  const rawFunding: OkxFundingRateRecord = {
    instType: "SWAP",
    instId: rawInstrument.instId,
    fundingRate: "0.0001",
    fundingTime: "1800028800000",
    nextFundingTime: "1800057600000",
  };
  let reads = 0;
  const funding = new OkxFundingRate(async (symbol) => {
    reads += 1;
    assert.equal(symbol, rawInstrument.instId);
    return { fundingRate: rawFunding, fetchedAt };
  }, [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  assert.deepEqual(await funding.getFundingRate(instrumentId), {
    venue: "okx",
    instrumentId,
    rate: 0.0001,
    intervalHours: 8,
    nextFundingAt: 1_800_028_800_000,
    markPrice: null,
    fetchedAt,
  });
  assert.equal(reads, 1);
});

test("OKX funding rejects an unbound canonical instrument without a provider read", async () => {
  let reads = 0;
  const funding = new OkxFundingRate(async () => {
    reads += 1;
    throw new Error("unexpected read");
  }, []);

  await assert.rejects(() => funding.getFundingRate(instrumentId), /Unsupported OKX funding instrument/u);
  assert.equal(reads, 0);
});

test("OKX market data maps bid, ask, and provider timestamp to canonical top of book", async () => {
  const rawTicker: OkxTickerRecord = {
    instType: "SWAP",
    instId: rawInstrument.instId,
    bidPx: "65000.1",
    askPx: "65000.2",
    ts: "1800000000123",
  };
  let reads = 0;
  const marketData = new OkxMarketData(async (symbol) => {
    reads += 1;
    assert.equal(symbol, rawInstrument.instId);
    return { ticker: rawTicker, fetchedAt };
  }, [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  assert.deepEqual(await marketData.getTopOfBook(instrumentId), {
    venue: "okx",
    instrumentId,
    bid: 65000.1,
    ask: 65000.2,
    markPrice: null,
    depthUsd: null,
    fetchedAt: 1_800_000_000_123,
  });
  assert.equal(reads, 1);
});

test("OKX market data rejects an unbound canonical instrument without a provider read", async () => {
  let reads = 0;
  const marketData = new OkxMarketData(async () => {
    reads += 1;
    throw new Error("unexpected read");
  }, []);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Unsupported OKX market data instrument/u);
  assert.equal(reads, 0);
});

test("OKX market data validates provider symbol and price fields", async () => {
  const marketData = new OkxMarketData(async () => ({
    ticker: { instType: "SWAP", instId: "ETH-USDT-SWAP", bidPx: "65000.1", askPx: "65000.2", ts: "1800000000123" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Unexpected OKX ticker symbol/u);

  const invalidPrice = new OkxMarketData(async () => ({
    ticker: { instType: "SWAP", instId: rawInstrument.instId, bidPx: "0", askPx: "65000.2", ts: "1800000000123" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  await assert.rejects(() => invalidPrice.getTopOfBook(instrumentId), /Invalid OKX bidPx/u);
});

test("OKX market data rejects an empty provider ticker response", async () => {
  const marketData = new OkxMarketData(async () => ({
    ticker: null,
    fetchedAt,
  } as never), [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /OKX ticker response is empty/u);
});

test("OKX market data rejects an invalid provider timestamp", async () => {
  const marketData = new OkxMarketData(async () => ({
    ticker: { instType: "SWAP", instId: rawInstrument.instId, bidPx: "65000.1", askPx: "65000.2", ts: "bad-ts" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Invalid OKX ticker ts/u);
});

test("OKX market data propagates provider read failures", async () => {
  const marketData = new OkxMarketData(async () => {
    throw new Error("OKX ticker read failed");
  }, [{ instrumentId, providerSymbol: rawInstrument.instId }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /OKX ticker read failed/u);
});

test("OKX ticker source reads the public ticker endpoint for the mapped provider symbol", async () => {
  let requestedUrl = "";
  const rawTicker: OkxTickerRecord = {
    instType: "SWAP",
    instId: rawInstrument.instId,
    bidPx: "65000.1",
    askPx: "65000.2",
    ts: "1800000000123",
  };
  const source = createOkxTickerSource({
    baseUrl: "https://okx.example.test",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json({ code: "0", data: [rawTicker] });
    },
  });
  const before = Date.now();
  const snapshot = await source(rawInstrument.instId);
  const after = Date.now();

  assert.deepEqual(snapshot.ticker, rawTicker);
  assert.equal(Number.isInteger(snapshot.fetchedAt), true);
  assert.equal(snapshot.fetchedAt >= before, true);
  assert.equal(snapshot.fetchedAt <= after, true);
  assert.equal(requestedUrl, "https://okx.example.test/api/v5/market/ticker?instId=BTC-USDT-SWAP");
});

test("OKX ticker source fails clearly for public API errors and empty data", async () => {
  const rejected = createOkxTickerSource({
    fetchImpl: async () => Response.json({ code: "50011", msg: "Invalid instId", data: [] }),
  });

  await assert.rejects(() => rejected(rawInstrument.instId), /OKX ticker response rejected: 50011/u);

  const empty = createOkxTickerSource({
    fetchImpl: async () => Response.json({ code: "0", data: [] }),
  });

  await assert.rejects(() => empty(rawInstrument.instId), /OKX ticker response is empty/u);
});
