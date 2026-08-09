import assert from "node:assert/strict";
import test from "node:test";
import { BitgetFundingRate } from "./BitgetFundingRate";
import { BitgetInstrumentCatalog } from "./BitgetInstrumentCatalog";
import type { BitgetFundingRateRecord, BitgetUsdtPerpetualInstrument } from "./BitgetReadTypes";

const fetchedAt = 1_800_000_000_000;
const instrumentId = "bitget:perpetual:linear:BTC:USDT:USDT";
const rawInstrument: BitgetUsdtPerpetualInstrument = {
  symbol: "BTCUSDT",
  category: "USDT-FUTURES",
  baseCoin: "BTC",
  quoteCoin: "USDT",
  minOrderQty: "0.0001",
  minOrderAmount: "5",
  priceMultiplier: "0.1",
  quantityMultiplier: "0.0001",
  type: "perpetual",
  status: "online",
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
