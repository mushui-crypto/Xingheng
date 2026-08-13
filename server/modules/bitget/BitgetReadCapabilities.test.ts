import assert from "node:assert/strict";
import test from "node:test";
import { BitgetFundingRate } from "./BitgetFundingRate";
import { BitgetInstrumentCatalog } from "./BitgetInstrumentCatalog";
import { BitgetMarketData, createBitgetTickerSource } from "./BitgetMarketData";
import type { BitgetFundingRateRecord, BitgetMarketTicker, BitgetUsdtPerpetualInstrument } from "./BitgetReadTypes";

const fetchedAt = 1_800_000_000_000;
const instrumentId = "BTC-USDT-PERP";
const rawInstrument: BitgetUsdtPerpetualInstrument = {
  symbol: "BTCUSDT",
  baseCoin: "BTC",
  quoteCoin: "USDT",
  minTradeNum: "0.0001",
  minTradeUSDT: "5",
  priceEndStep: "1",
  pricePlace: "1",
  sizeMultiplier: "0.0001",
  symbolType: "perpetual",
  symbolStatus: "normal",
};

test("Bitget catalog maps multiplier fields as base-quantity increments", async () => {
  const catalog = new BitgetInstrumentCatalog(async () => ({ instruments: [rawInstrument], fetchedAt }));

  assert.deepEqual(await catalog.listInstruments(), [{
    instrumentId,
    venue: "bitget",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: "BTCUSDT",
    providerLocator: { category: "USDT-FUTURES" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: 0.1,
    quantityStep: 0.0001,
    minQuantity: 0.0001,
    minNotional: 5,
    status: "trading",
    fetchedAt,
  }]);
});

test("Bitget catalog uses production contract fields and isolates unsupported rows", async () => {
  const diagnostics: unknown[] = [];
  const xaut = {
    ...rawInstrument,
    symbol: "XAUTUSDT",
    baseCoin: "XAUT",
    minTradeNum: "0.01",
    priceEndStep: "1",
    pricePlace: "2",
    sizeMultiplier: "0.01",
  };
  const catalog = new BitgetInstrumentCatalog(async () => ({
    instruments: [
      { ...rawInstrument, symbolType: "delivery" },
      { ...rawInstrument, baseCoin: "bad-asset" },
      xaut,
    ],
    fetchedAt,
  }), (diagnostic) => diagnostics.push(diagnostic));

  const instruments = await catalog.listInstruments();
  assert.equal(instruments.length, 1);
  assert.deepEqual(instruments[0], {
    instrumentId: "XAUT-USDT-PERP",
    venue: "bitget",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: "XAUTUSDT",
    providerLocator: { category: "USDT-FUTURES" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: 0.01,
    quantityStep: 0.01,
    minQuantity: 0.01,
    minNotional: 5,
    status: "trading",
    fetchedAt,
  });
  assert.deepEqual(diagnostics, [{
    venue: "bitget",
    skipped: 2,
    reasons: { unsupported_instrument_type: 1, invalid_instrument: 1 },
  }]);
});

test("Bitget funding maps its hour interval and nextUpdate without a mark price", async () => {
  const rawFunding: BitgetFundingRateRecord = {
    symbol: rawInstrument.symbol,
    fundingRate: "0.000071",
    fundingRateInterval: "8",
    nextUpdate: "1800028800000",
  };
  const funding = new BitgetFundingRate(
    async () => ({ fundingRate: rawFunding, fetchedAt }),
    [{ instrumentId, providerSymbol: rawInstrument.symbol }],
  );

  assert.deepEqual(await funding.getFundingRate(instrumentId), {
    venue: "bitget",
    instrumentId,
    rate: 0.000071,
    intervalHours: 8,
    nextFundingAt: 1_800_028_800_000,
    markPrice: null,
    fetchedAt,
  });
});

test("Bitget funding validates the returned provider symbol", async () => {
  const funding = new BitgetFundingRate(async () => ({
      fundingRate: { symbol: "ETHUSDT", fundingRate: "0.0001", fundingRateInterval: "8", nextUpdate: "1800028800000" },
      fetchedAt,
    }), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => funding.getFundingRate(instrumentId), /Unexpected Bitget funding symbol/u);
});

test("Bitget market data maps bid and ask to canonical top of book", async () => {
  const rawTicker: BitgetMarketTicker = {
    symbol: rawInstrument.symbol,
    bidPr: "65000.1",
    askPr: "65000.2",
  };
  let reads = 0;
  const marketData = new BitgetMarketData(async (symbol) => {
    reads += 1;
    assert.equal(symbol, rawInstrument.symbol);
    return { ticker: rawTicker, fetchedAt };
  }, [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  assert.deepEqual(await marketData.getTopOfBook(instrumentId), {
    venue: "bitget",
    instrumentId,
    bid: 65000.1,
    ask: 65000.2,
    markPrice: null,
    depthUsd: null,
    fetchedAt,
  });
  assert.equal(reads, 1);
});

test("Bitget market data rejects an unbound canonical instrument without a provider read", async () => {
  let reads = 0;
  const marketData = new BitgetMarketData(async () => {
    reads += 1;
    throw new Error("unexpected read");
  }, []);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Unsupported Bitget market data instrument/u);
  assert.equal(reads, 0);
});

test("Bitget market data validates provider symbol and decimal price fields", async () => {
  const marketData = new BitgetMarketData(async () => ({
    ticker: { symbol: "ETHUSDT", bidPr: "65000.1", askPr: "65000.2" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Unexpected Bitget ticker symbol/u);

  const invalidPrice = new BitgetMarketData(async () => ({
    ticker: { symbol: rawInstrument.symbol, bidPr: "0", askPr: "65000.2" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => invalidPrice.getTopOfBook(instrumentId), /Invalid Bitget bidPr/u);
});

test("Bitget market data rejects an empty provider ticker response", async () => {
  const marketData = new BitgetMarketData(async () => ({
    ticker: null,
    fetchedAt,
  } as never), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Bitget ticker response is empty/u);
});

test("Bitget market data propagates provider read failures", async () => {
  const marketData = new BitgetMarketData(async () => {
    throw new Error("Bitget ticker read failed");
  }, [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Bitget ticker read failed/u);
});

test("Bitget ticker source reads the public USDT futures ticker endpoint for the mapped provider symbol", async () => {
  let requestedUrl = "";
  const rawTicker: BitgetMarketTicker = {
    symbol: rawInstrument.symbol,
    bidPr: "65000.1",
    askPr: "65000.2",
  };
  const source = createBitgetTickerSource({
    baseUrl: "https://bitget.example.test",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json({ code: "00000", data: [rawTicker] });
    },
  });
  const before = Date.now();
  const snapshot = await source(rawInstrument.symbol);
  const after = Date.now();

  assert.deepEqual(snapshot.ticker, rawTicker);
  assert.equal(Number.isInteger(snapshot.fetchedAt), true);
  assert.equal(snapshot.fetchedAt >= before, true);
  assert.equal(snapshot.fetchedAt <= after, true);
  assert.equal(requestedUrl, "https://bitget.example.test/api/v2/mix/market/ticker?symbol=BTCUSDT&productType=USDT-FUTURES");
});

test("Bitget ticker source fails clearly for public API errors and empty data", async () => {
  const rejected = createBitgetTickerSource({
    fetchImpl: async () => Response.json({ code: "40034", msg: "symbol invalid", data: [] }),
  });

  await assert.rejects(() => rejected(rawInstrument.symbol), /Bitget ticker response rejected: 40034/u);

  const empty = createBitgetTickerSource({
    fetchImpl: async () => Response.json({ code: "00000", data: [] }),
  });

  await assert.rejects(() => empty(rawInstrument.symbol), /Bitget ticker response is empty/u);
});
