import assert from "node:assert/strict";
import test from "node:test";
import { createPositionSnapshot, type PositionSnapshot } from "./PositionSnapshot";
import {
  reduceOnlyEligible,
  signedCurrentNet,
  verifyExecutionDelta,
  verifyPosition,
  type ExpectedPosition,
} from "./PositionVerification";

const now = 1_800_000_000_000;

test("matches a LONG canonical position", () => {
  const result = verifyPosition(
    expected({ side: "LONG", quantity: "1.25" }),
    snapshot({ side: "LONG", quantity: "1.25" }),
  );

  assert.deepEqual(result, {
    status: "MATCHED",
    directionMatches: true,
    quantityMatches: true,
    quantityDifference: "0",
    reason: null,
  });
});

test("matches a SHORT canonical position", () => {
  const result = verifyPosition(
    expected({ side: "SHORT", quantity: "0.002" }),
    snapshot({ side: "SHORT", quantity: "0.002" }),
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.directionMatches, true);
  assert.equal(result.quantityMatches, true);
});

test("matches a FLAT canonical position", () => {
  const result = verifyPosition(
    expected({ side: "FLAT", quantity: "0" }),
    snapshot({ side: "FLAT", quantity: "0" }),
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.quantityDifference, "0");
});

test("derives canonical signed current net without provider fields", () => {
  assert.equal(signedCurrentNet(snapshot({ side: "LONG", quantity: "20" })), "20");
  assert.equal(signedCurrentNet(snapshot({ side: "SHORT", quantity: "20" })), "-20");
  assert.equal(signedCurrentNet(snapshot({ side: "FLAT", quantity: "0" })), "0");
});

test("determines reduceOnly eligibility from the managed slice being reversed", () => {
  for (const scenario of [
    { currentNet: "-15", managedSliceToReverse: "-10", expected: true },
    { currentNet: "-5", managedSliceToReverse: "-10", expected: false },
    { currentNet: "100", managedSliceToReverse: "-10", expected: false },
    { currentNet: "-10", managedSliceToReverse: "-10", expected: true },
    { currentNet: "-9.999999999999999999", managedSliceToReverse: "-10", expected: false },
    { currentNet: "15", managedSliceToReverse: "10", expected: true },
    { currentNet: "5", managedSliceToReverse: "10", expected: false },
    { currentNet: "-100", managedSliceToReverse: "10", expected: false },
    { currentNet: "10", managedSliceToReverse: "10", expected: true },
    { currentNet: "9.999999999999999999", managedSliceToReverse: "10", expected: false },
  ]) {
    assert.equal(
      reduceOnlyEligible(scenario.currentNet, scenario.managedSliceToReverse),
      scenario.expected,
      `${scenario.currentNet} / ${scenario.managedSliceToReverse}`,
    );
  }
});

test("reports quantity mismatch outside tolerance", () => {
  const result = verifyPosition(
    expected({ quantity: "1", tolerance: "0.001" }),
    snapshot({ quantity: "1.001000000000000001" }),
  );

  assert.deepEqual(result, {
    status: "MISMATCH",
    directionMatches: true,
    quantityMatches: false,
    quantityDifference: "0.001000000000000001",
    reason: null,
  });
});

test("reports direction mismatch for an otherwise equal quantity", () => {
  const result = verifyPosition(
    expected({ side: "LONG", quantity: "2" }),
    snapshot({ side: "SHORT", quantity: "2" }),
  );

  assert.equal(result.status, "MISMATCH");
  assert.equal(result.directionMatches, false);
  assert.equal(result.quantityMatches, true);
});

test("includes the exact tolerance boundary", () => {
  const result = verifyPosition(
    expected({ quantity: "1", tolerance: "0.001" }),
    snapshot({ quantity: "1.001" }),
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.quantityMatches, true);
  assert.equal(result.quantityDifference, "0.001");
});

test("returns UNKNOWN when a snapshot is unavailable", () => {
  assert.deepEqual(verifyPosition(expected(), null), {
    status: "UNKNOWN",
    directionMatches: null,
    quantityMatches: null,
    quantityDifference: null,
    reason: "SNAPSHOT_UNAVAILABLE",
  });
});

test("returns UNKNOWN when a snapshot is invalid at the runtime boundary", () => {
  const invalid = {
    ...snapshot(),
    quantity: 1,
  } as unknown as PositionSnapshot;

  assert.equal(verifyPosition(expected(), invalid).status, "UNKNOWN");
  assert.equal(verifyPosition(expected(), invalid).reason, "SNAPSHOT_INVALID");
});

test("returns UNKNOWN when the canonical instrument does not match", () => {
  const result = verifyPosition(
    expected({ instrumentId: "BTC-USDT-PERP" }),
    snapshot({ instrumentId: "ETH-USDT-PERP" }),
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "INSTRUMENT_MISMATCH");
});

test("preserves exact Decimal semantics without floating-point arithmetic", () => {
  const actual = snapshot({
    quantity: "0.3000000000000000000000000000010",
  });
  const result = verifyPosition(
    expected({
      quantity: "0.3",
      tolerance: "0.000000000000000000000000000001",
    }),
    actual,
  );

  assert.equal(actual.quantity, "0.300000000000000000000000000001");
  assert.equal(result.quantityDifference, "0.000000000000000000000000000001");
  assert.equal(result.status, "MATCHED");
});

test("ONE_WAY verifies a delta from a non-flat baseline, including crossing flat", () => {
  const baseline = snapshot({ side: "SHORT", quantity: "10" });
  const result = verifyExecutionDelta({
    instrumentId: "BTC-USDT-PERP",
    positionMode: "ONE_WAY",
    positionDirection: "LONG",
    executionDelta: "20",
    baseline,
    tolerance: "0",
  }, snapshot({ side: "LONG", quantity: "10" }));
  assert.equal(result.status, "MATCHED");
  assert.equal(result.expectedSignedNetQuantity, "10");
  assert.equal(result.observedSignedNetQuantity, "10");
});

test("HEDGE verifies only the selected bucket and ignores unrelated position", () => {
  const baseline = snapshot({
    positionMode: "HEDGE",
    side: "FLAT",
    quantity: "110",
    longQuantity: "100",
    shortQuantity: "10",
    signedNetQuantity: null,
  });
  const result = verifyExecutionDelta({
    instrumentId: "BTC-USDT-PERP",
    positionMode: "HEDGE",
    positionDirection: "SHORT",
    executionDelta: "20",
    baseline,
    tolerance: "0",
  }, snapshot({
    positionMode: "HEDGE",
    side: "FLAT",
    quantity: "130",
    longQuantity: "100",
    shortQuantity: "30",
    signedNetQuantity: null,
  }));
  assert.equal(result.status, "MATCHED");
  assert.equal(result.expectedBucketQuantity, "30");
  assert.equal(result.observedBucketQuantity, "30");
});

test("HEDGE fails when the selected bucket does not contain the expected result", () => {
  const baseline = snapshot({ positionMode: "HEDGE", side: "FLAT", quantity: "100", longQuantity: "100", shortQuantity: "0", signedNetQuantity: null });
  const result = verifyExecutionDelta({
    instrumentId: "BTC-USDT-PERP", positionMode: "HEDGE", positionDirection: "SHORT", executionDelta: "5", baseline, tolerance: "0",
  }, snapshot({ positionMode: "HEDGE", side: "FLAT", quantity: "100", longQuantity: "100", shortQuantity: "0", signedNetQuantity: null }));
  assert.equal(result.status, "MISMATCH");
  assert.equal(result.expectedBucketQuantity, "5");
  assert.equal(result.observedBucketQuantity, "0");
});

test("enforces quantity semantic boundaries", () => {
  assert.throws(
    () => createPositionSnapshot(snapshotInput({ quantity: 0.1 })),
    /unsigned Decimal string/u,
  );
  assert.throws(
    () => createPositionSnapshot(snapshotInput({ quantity: "-1" })),
    /unsigned Decimal string/u,
  );
  assert.throws(
    () => createPositionSnapshot(snapshotInput({ side: "FLAT", quantity: "0.1" })),
    /FLAT position quantity must be zero/u,
  );
  assert.throws(
    () => createPositionSnapshot(snapshotInput({ side: "LONG", quantity: "0" })),
    /must be greater than zero/u,
  );
  assert.throws(
    () => verifyPosition(expected({ tolerance: "-0.1" }), snapshot()),
    /tolerance must be an unsigned Decimal string/u,
  );
});

function snapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return createPositionSnapshot(snapshotInput(overrides));
}

function snapshotInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "BTC-USDT-PERP",
    side: "LONG",
    quantity: "1",
    fetchedAt: now,
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedPosition> = {}): ExpectedPosition {
  return {
    instrumentId: "BTC-USDT-PERP",
    side: "LONG",
    quantity: "1",
    tolerance: "0",
    ...overrides,
  };
}
