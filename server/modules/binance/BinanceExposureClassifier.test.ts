import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBinanceEntryExposure,
  classifyBinanceExposure,
} from "./BinanceExposureClassifier";
import { snapshotFixture } from "./binanceTestFixtures";

test("classifies flat and spot dust only when both quantity and notional are below minimums", () => {
  assert.equal(classifyBinanceEntryExposure(snapshotFixture()).classification, "FLAT");
  const dust = classifyBinanceEntryExposure(snapshotFixture({
    existingSpotQuantityXaut: 0.000096,
    spotAvailableQuantityXaut: 0.000096,
    spotFreeXaut: 0.000096,
  }));
  assert.equal(dust.classification, "FLAT_WITH_DUST");
  assert.equal(dust.rulesValid, true);
  assert.equal(dust.blockingReason, null);
  assert.equal(dust.requiresAcknowledgement, false);
});

test("either spot quantity or notional threshold makes total exposure tradable", () => {
  const quantityBranch = classifyBinanceEntryExposure(snapshotFixture({
    existingSpotQuantityXaut: 0.001,
    spot: { ...snapshotFixture().spot, bid: 1 },
  }));
  const notionalBranch = classifyBinanceEntryExposure(snapshotFixture({
    existingSpotQuantityXaut: 0.0005,
    spot: { ...snapshotFixture().spot, bid: 10_000 },
  }));
  assert.equal(quantityBranch.classification, "TRADABLE_EXPOSURE");
  assert.equal(notionalBranch.classification, "TRADABLE_EXPOSURE");
});

test("total spot exposure cannot be downgraded by dust-sized available or free quantities", () => {
  const summary = classifyBinanceEntryExposure(snapshotFixture({
    existingSpotQuantityXaut: 0.002,
    spotAvailableQuantityXaut: 0.00001,
    spotFreeXaut: 0.00001,
    spotLockedXaut: 0.00199,
  }));
  assert.equal(summary.classification, "TRADABLE_EXPOSURE");
  assert.equal(summary.requiresAcknowledgement, true);
  assert.equal(summary.spot.totalQuantityXaut, 0.002);
  assert.equal(summary.spot.freeQuantityXaut, 0.00001);
  assert.equal(summary.spot.lockedQuantityXaut, 0.00199);
});

test("perpetual exposure at minimum quantity requires acknowledgement for long and short", () => {
  for (const direction of ["long", "short"] as const) {
    const summary = classifyBinanceEntryExposure(snapshotFixture({
      existingPerpetualQuantityXaut: direction === "long" ? 0.001 : -0.001,
      perpetualPositionSide: direction,
    }));
    assert.equal(summary.classification, "TRADABLE_EXPOSURE");
    assert.equal(summary.requiresAcknowledgement, true);
    assert.equal(summary.perpetual.quantityXaut, 0.001);
    assert.equal(summary.perpetual.direction, direction);
  }
});

test("invalid trading rules and inconsistent perpetual direction fail closed", () => {
  for (const summary of [
    classifyBinanceEntryExposure(snapshotFixture({
      spot: { ...snapshotFixture().spot, minOrderQty: Number.NaN },
    })),
    classifyBinanceEntryExposure(snapshotFixture({
      spot: { ...snapshotFixture().spot, minNotionalUsd: 0 },
    })),
    classifyBinanceEntryExposure(snapshotFixture({
      spot: { ...snapshotFixture().spot, bid: -1 },
    })),
    classifyBinanceEntryExposure(snapshotFixture({
      perpetual: { ...snapshotFixture().perpetual, minOrderQty: 0 },
    })),
    classifyBinanceEntryExposure(snapshotFixture({
      existingPerpetualQuantityXaut: 0.001,
      perpetualPositionSide: "flat",
    })),
  ]) {
    assert.equal(summary.classification, "TRADABLE_EXPOSURE");
    assert.equal(summary.rulesValid, false);
    assert.equal(summary.blockingReason, "INVALID_TRADING_RULES");
    assert.equal(summary.requiresAcknowledgement, false);
  }
});

test("final exposure classification uses the same total rules and treats open orders as residual", () => {
  assert.equal(classifyBinanceExposure(snapshotFixture({
    existingSpotQuantityXaut: 0.000096,
  })), "FLAT_WITH_DUST");
  assert.equal(classifyBinanceExposure(snapshotFixture({
    existingSpotQuantityXaut: 0.0005,
    spot: { ...snapshotFixture().spot, bid: 10_000 },
  })), "TRADABLE_RESIDUAL");
  assert.equal(classifyBinanceExposure(snapshotFixture({
    openPerpetualOrderCount: 1,
  })), "TRADABLE_RESIDUAL");
});
