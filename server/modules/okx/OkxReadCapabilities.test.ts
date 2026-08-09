import assert from "node:assert/strict";
import test from "node:test";
import { OkxFundingRate } from "./OkxFundingRate";
import { OkxInstrumentCatalog } from "./OkxInstrumentCatalog";
import type { OkxFundingRateRecord, OkxSwapInstrument } from "./OkxReadTypes";

const fetchedAt = 1_800_000_000_000;
const instrumentId = "okx:perpetual:linear:BTC:USDT:USDT";
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
