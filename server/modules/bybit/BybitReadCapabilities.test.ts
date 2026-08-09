import assert from "node:assert/strict";
import test from "node:test";
import { BybitFundingRate } from "./BybitFundingRate";
import { BybitInstrumentCatalog } from "./BybitInstrumentCatalog";
import type { BybitFundingTicker, BybitLinearPerpetualInstrument } from "./BybitReadTypes";

const fetchedAt = 1_800_000_000_000;
const instrumentId = "bybit:perpetual:linear:BTC:USDT:USDT";
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
