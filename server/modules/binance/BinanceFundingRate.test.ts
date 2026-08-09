import assert from "node:assert/strict";
import test from "node:test";
import { BinanceFundingRate } from "./BinanceFundingRate";
import { BINANCE_PERPETUAL_INSTRUMENT_ID, BINANCE_SPOT_INSTRUMENT_ID } from "./BinanceInstrumentCatalog";
import { snapshotFixture } from "./binanceTestFixtures";

test("Binance funding rate maps the perpetual snapshot to the canonical model", async () => {
  const snapshot = snapshotFixture();
  let reads = 0;
  const fundingRate = new BinanceFundingRate({
    readPreflightSnapshot: async () => {
      reads += 1;
      return snapshot;
    },
  });

  assert.deepEqual(await fundingRate.getFundingRate(BINANCE_PERPETUAL_INSTRUMENT_ID), {
    venue: "binance",
    instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
    rate: snapshot.perpetual.fundingRate,
    intervalHours: snapshot.perpetual.fundingIntervalHours,
    nextFundingAt: snapshot.perpetual.nextFundingTime,
    markPrice: snapshot.perpetual.mark,
    fetchedAt: snapshot.fetchedAt,
  });
  assert.equal(reads, 1);
});

test("Binance funding rate rejects spot instruments without a provider read", async () => {
  let reads = 0;
  const fundingRate = new BinanceFundingRate({
    readPreflightSnapshot: async () => {
      reads += 1;
      return snapshotFixture();
    },
  });

  await assert.rejects(
    () => fundingRate.getFundingRate(BINANCE_SPOT_INSTRUMENT_ID),
    /Unsupported Binance funding instrument/u,
  );
  assert.equal(reads, 0);
});
