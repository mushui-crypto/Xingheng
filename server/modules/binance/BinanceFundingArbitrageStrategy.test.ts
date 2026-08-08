import assert from "node:assert/strict";
import test from "node:test";
import { assessOpportunity, hasBlockingEntryExposure } from "./BinanceFundingArbitrageStrategy";
import { snapshotFixture, tradingConfigFixture } from "./binanceTestFixtures";

test("funding strategy requires positive funding, bounded basis, and minimum net APR", () => {
  assert.equal(assessOpportunity(snapshotFixture(), tradingConfigFixture()).eligible, true);
  assert.deepEqual(
    assessOpportunity(snapshotFixture({ perpetual: { ...snapshotFixture().perpetual, fundingRate: -0.0001 } }), tradingConfigFixture()).reasons,
    ["funding_not_positive", "net_apr_too_low"],
  );
  assert.ok(assessOpportunity(
    snapshotFixture({ perpetual: { ...snapshotFixture().perpetual, bid: 1_020 } }),
    tradingConfigFixture(),
  ).reasons.includes("entry_basis_too_wide"));
});

test("entry can temporarily allow only untradeable spot dust", () => {
  const dust = snapshotFixture({
    existingSpotQuantityXaut: 0.000098,
    spotAvailableQuantityXaut: 0.000098,
    spotFreeXaut: 0.000098,
  });
  assert.equal(hasBlockingEntryExposure(dust, false), true);
  assert.equal(hasBlockingEntryExposure(dust, true), false);

  const tradableSpot = snapshotFixture({
    existingSpotQuantityXaut: 0.01,
    spotAvailableQuantityXaut: 0.01,
    spotFreeXaut: 0.01,
  });
  assert.equal(hasBlockingEntryExposure(tradableSpot, true), true);

  const perpetualExposure = snapshotFixture({ existingPerpetualQuantityXaut: 0.001 });
  assert.equal(hasBlockingEntryExposure(perpetualExposure, true), true);
});
