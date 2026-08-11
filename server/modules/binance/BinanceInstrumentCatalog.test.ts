import assert from "node:assert/strict";
import test from "node:test";
import type { BinanceClientAdapter } from "./BinanceTypes";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
  BinanceInstrumentCatalog,
} from "./BinanceInstrumentCatalog";
import { snapshotFixture } from "./binanceTestFixtures";

test("Binance instrument catalog maps spot and perpetual provider data to canonical instruments", async () => {
  const snapshot = snapshotFixture();
  let reads = 0;
  const catalog = new BinanceInstrumentCatalog({
    readPreflightSnapshot: async () => {
      reads += 1;
      return snapshot;
    },
  } as Pick<BinanceClientAdapter, "readPreflightSnapshot">);

  const instruments = await catalog.listInstruments();

  assert.equal(reads, 1);
  assert.equal(instruments.length, 2);
  assert.deepEqual(instruments[0], {
    instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
    venue: "binance",
    marketType: "spot",
    contractType: "spot",
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: "XAUTUSDT",
    providerLocator: { scope: "spot" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: snapshot.spot.priceTick,
    quantityStep: snapshot.spot.qtyStep,
    minQuantity: snapshot.spot.minOrderQty,
    minNotional: snapshot.spot.minNotionalUsd,
    status: "trading",
    fetchedAt: snapshot.fetchedAt,
  });
  assert.equal(instruments[1]?.instrumentId, BINANCE_PERPETUAL_INSTRUMENT_ID);
  assert.equal(instruments[1]?.marketType, "perpetual");
  assert.equal(instruments[1]?.contractType, "linear_perpetual");
  assert.deepEqual(instruments[1]?.providerLocator, { scope: "futures" });
  assert.equal(instruments[1]?.priceTick, snapshot.perpetual.priceTick);
  assert.equal(instruments[1]?.quantityStep, snapshot.perpetual.qtyStep);
});

test("Binance instrument catalog rejects an unknown canonical id without a provider read", async () => {
  let reads = 0;
  const catalog = new BinanceInstrumentCatalog({
    readPreflightSnapshot: async () => {
      reads += 1;
      return snapshotFixture();
    },
  });

  assert.equal(await catalog.getInstrument("BTC-USDT-PERP"), null);
  assert.equal(reads, 0);
});
