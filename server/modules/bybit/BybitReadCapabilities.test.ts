import assert from "node:assert/strict";
import test from "node:test";
import { BybitFundingRate } from "./BybitFundingRate";
import { BybitInstrumentCatalog } from "./BybitInstrumentCatalog";
import { BybitMarketData, createBybitTickerSource } from "./BybitMarketData";
import type { BybitFundingTicker, BybitLinearPerpetualInstrument, BybitMarketTicker } from "./BybitReadTypes";

const fetchedAt = 1_800_000_000_000;
const instrumentId = "BTC-USDT-PERP";
const rawInstrument: BybitLinearPerpetualInstrument = {
  symbol: "BTCUSDT",
  contractType: "LinearPerpetual",
  status: "Trading",
  baseCoin: "BTC",
  quoteCoin: "USDT",
  settleCoin: "USDT",
  priceFilter: { tickSize: "0.1" },
  lotSizeFilter: { minNotionalValue: "5", minOrderQty: "0.001", qtyStep: "0.001" },
};

test("Bybit catalog maps nested price and lot filters", async () => {
  const catalog = new BybitInstrumentCatalog(async () => ({ instruments: [rawInstrument], fetchedAt }));

  assert.deepEqual(await catalog.listInstruments(), [{
    instrumentId,
    venue: "bybit",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: "BTCUSDT",
    providerLocator: { category: "linear" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: 0.1,
    quantityStep: 0.001,
    minQuantity: 0.001,
    minNotional: 5,
    status: "trading",
    fetchedAt,
  }]);
});

test("Bybit catalog keeps XAUTUSDT when another instrument has an invalid asset", async () => {
  const diagnostics: unknown[] = [];
  const xaut = { ...rawInstrument, symbol: "XAUTUSDT", baseCoin: "XAUT" };
  const catalog = new BybitInstrumentCatalog(async () => ({
    instruments: [{ ...rawInstrument, baseCoin: "bad-asset" }, xaut],
    fetchedAt,
  }), (diagnostic) => diagnostics.push(diagnostic));

  const instruments = await catalog.listInstruments();
  assert.equal(instruments.length, 1);
  assert.equal(instruments[0]?.instrumentId, "XAUT-USDT-PERP");
  assert.equal(instruments[0]?.contractSize, 1);
  assert.deepEqual(diagnostics, [{
    venue: "bybit",
    skipped: 1,
    reasons: { invalid_instrument: 1 },
  }]);
});

test("Bybit ticker supplies funding, interval, next time, and mark price", async () => {
  const rawFunding: BybitFundingTicker = {
    symbol: rawInstrument.symbol,
    fundingRate: "-0.00005",
    fundingIntervalHour: "8",
    nextFundingTime: "1800028800000",
    markPrice: "65000.5",
  };
  const funding = new BybitFundingRate(
    async () => ({ fundingRate: rawFunding, fetchedAt }),
    [{ instrumentId, providerSymbol: rawInstrument.symbol }],
  );

  assert.deepEqual(await funding.getFundingRate(instrumentId), {
    venue: "bybit",
    instrumentId,
    rate: -0.00005,
    intervalHours: 8,
    nextFundingAt: 1_800_028_800_000,
    markPrice: 65000.5,
    fetchedAt,
  });
});

test("Bybit funding rejects an unbound canonical instrument without a provider read", async () => {
  let reads = 0;
  const funding = new BybitFundingRate(async () => {
    reads += 1;
    throw new Error("unexpected read");
  }, []);

  await assert.rejects(() => funding.getFundingRate(instrumentId), /Unsupported Bybit funding instrument/u);
  assert.equal(reads, 0);
});

test("Bybit market data maps bid and ask to canonical top of book", async () => {
  const rawTicker: BybitMarketTicker = {
    symbol: rawInstrument.symbol,
    bid1Price: "65000.1",
    ask1Price: "65000.2",
  };
  let reads = 0;
  const marketData = new BybitMarketData(async (symbol) => {
    reads += 1;
    assert.equal(symbol, rawInstrument.symbol);
    return { ticker: rawTicker, fetchedAt };
  }, [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  assert.deepEqual(await marketData.getTopOfBook(instrumentId), {
    venue: "bybit",
    instrumentId,
    bid: 65000.1,
    ask: 65000.2,
    markPrice: null,
    depthUsd: null,
    fetchedAt,
  });
  assert.equal(reads, 1);
});

test("Bybit market data rejects an unbound canonical instrument without a provider read", async () => {
  let reads = 0;
  const marketData = new BybitMarketData(async () => {
    reads += 1;
    throw new Error("unexpected read");
  }, []);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Unsupported Bybit market data instrument/u);
  assert.equal(reads, 0);
});

test("Bybit market data validates provider symbol and decimal price fields", async () => {
  const marketData = new BybitMarketData(async () => ({
    ticker: { symbol: "ETHUSDT", bid1Price: "65000.1", ask1Price: "65000.2" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Unexpected Bybit ticker symbol/u);

  const invalidPrice = new BybitMarketData(async () => ({
    ticker: { symbol: rawInstrument.symbol, bid1Price: "0", ask1Price: "65000.2" },
    fetchedAt,
  }), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => invalidPrice.getTopOfBook(instrumentId), /Invalid Bybit bid1Price/u);
});

test("Bybit market data rejects an empty provider ticker response", async () => {
  const marketData = new BybitMarketData(async () => ({
    ticker: null,
    fetchedAt,
  } as never), [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Bybit ticker response is empty/u);
});

test("Bybit market data propagates provider read failures", async () => {
  const marketData = new BybitMarketData(async () => {
    throw new Error("Bybit ticker read failed");
  }, [{ instrumentId, providerSymbol: rawInstrument.symbol }]);

  await assert.rejects(() => marketData.getTopOfBook(instrumentId), /Bybit ticker read failed/u);
});

test("Bybit ticker source reads the public linear ticker endpoint for the mapped provider symbol", async () => {
  let requestedUrl = "";
  const rawTicker: BybitMarketTicker = {
    symbol: rawInstrument.symbol,
    bid1Price: "65000.1",
    ask1Price: "65000.2",
  };
  const source = createBybitTickerSource({
    baseUrl: "https://bybit.example.test",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json({ retCode: 0, result: { list: [rawTicker] } });
    },
  });
  const before = Date.now();
  const snapshot = await source(rawInstrument.symbol);
  const after = Date.now();

  assert.deepEqual(snapshot.ticker, rawTicker);
  assert.equal(Number.isInteger(snapshot.fetchedAt), true);
  assert.equal(snapshot.fetchedAt >= before, true);
  assert.equal(snapshot.fetchedAt <= after, true);
  assert.equal(requestedUrl, "https://bybit.example.test/v5/market/tickers?category=linear&symbol=BTCUSDT");
});

test("Bybit ticker source fails clearly for public API errors and empty data", async () => {
  const rejected = createBybitTickerSource({
    fetchImpl: async () => Response.json({ retCode: 10001, retMsg: "symbol invalid", result: { list: [] } }),
  });

  await assert.rejects(() => rejected(rawInstrument.symbol), /Bybit ticker response rejected: 10001/u);

  const empty = createBybitTickerSource({
    fetchImpl: async () => Response.json({ retCode: 0, result: { list: [] } }),
  });

  await assert.rejects(() => empty(rawInstrument.symbol), /Bybit ticker response is empty/u);
});
