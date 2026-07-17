import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEthV4ExitPlan,
  buildEthV4SingleTargetPrice,
  completedTrendAt,
  getEthV4EntryWindow,
  resolveEthV4Direction,
  type EthV4TrendSnapshot,
} from "./EthMultiTimeframeSmcIctStrategy";

function trend(direction: EthV4TrendSnapshot["direction"], strengthAtr: number): EthV4TrendSnapshot {
  return { direction, strengthAtr, close: 2_000, ema: 1_995, atr: 10 };
}

test("buildEthV4ExitPlan creates 50% at 1R plus 50% at 1.5R, 2R, or 2.5R for longs", () => {
  for (const finalRewardRisk of [1.5, 2, 2.5] as const) {
    const plan = buildEthV4ExitPlan("long", 1_900, 20, finalRewardRisk);
    assert.deepEqual(plan.targets, [
      {
        price: 1_920,
        quantityFraction: 0.5,
        moveStopToBreakEvenAfterFill: true,
        label: "tp1_1r",
      },
      {
        price: 1_900 + 20 * finalRewardRisk,
        quantityFraction: 0.5,
        label: `tp2_${String(finalRewardRisk).replace(".", "_")}r`,
      },
    ]);
  }
});

test("buildEthV4ExitPlan mirrors the scale-out targets for shorts", () => {
  for (const finalRewardRisk of [1.5, 2, 2.5] as const) {
    const plan = buildEthV4ExitPlan("short", 1_900, 40, finalRewardRisk);
    assert.equal(plan.targets[0].price, 1_860);
    assert.equal(plan.targets[0].quantityFraction, 0.5);
    assert.equal(plan.targets[0].moveStopToBreakEvenAfterFill, true);
    assert.equal(plan.targets[1].price, 1_900 - 40 * finalRewardRisk);
    assert.equal(plan.targets[1].quantityFraction, 0.5);
  }
});

test("buildEthV4SingleTargetPrice creates normal full-position targets for longs", () => {
  assert.equal(buildEthV4SingleTargetPrice("long", 1_900, 20, 1.5), 1_930);
  assert.equal(buildEthV4SingleTargetPrice("long", 1_900, 20, 2), 1_940);
  assert.equal(buildEthV4SingleTargetPrice("long", 1_900, 20, 2.5), 1_950);
});

test("buildEthV4SingleTargetPrice mirrors normal full-position targets for shorts", () => {
  assert.equal(buildEthV4SingleTargetPrice("short", 1_900, 40, 1.5), 1_840);
  assert.equal(buildEthV4SingleTargetPrice("short", 1_900, 40, 2), 1_820);
  assert.equal(buildEthV4SingleTargetPrice("short", 1_900, 40, 2.5), 1_800);
});

test("getEthV4EntryWindow recognizes weekday London and New York windows", () => {
  const london = getEthV4EntryWindow(Date.parse("2026-07-15T06:30:00Z") / 1_000);
  const newYork = getEthV4EntryWindow(Date.parse("2026-07-15T12:30:00Z") / 1_000);
  assert.deepEqual(london, {
    session: "london",
    dateKey: "2026-07-15",
    weekday: "Wed",
    remainingFutureBars: 29,
  });
  assert.deepEqual(newYork, {
    session: "new_york",
    dateKey: "2026-07-15",
    weekday: "Wed",
    remainingFutureBars: 29,
  });
});

test("getEthV4EntryWindow rejects weekends and leaves no future fill bar at 04:55 or 10:55 New York", () => {
  assert.equal(getEthV4EntryWindow(Date.parse("2026-07-18T12:00:00Z") / 1_000), null);
  assert.equal(
    getEthV4EntryWindow(Date.parse("2026-07-15T08:55:00Z") / 1_000)?.remainingFutureBars,
    0,
  );
  assert.equal(
    getEthV4EntryWindow(Date.parse("2026-07-15T14:55:00Z") / 1_000)?.remainingFutureBars,
    0,
  );
});

test("resolveEthV4Direction follows 15m when one HTF agrees and the other countertrend is weak", () => {
  assert.equal(resolveEthV4Direction({
    fifteenMinute: trend("bullish", 0.4),
    oneHour: trend("bullish", 0.5),
    fourHour: trend("bearish", 0.74),
    strongCounterTrendAtr: 0.75,
  }), "bullish");
});

test("resolveEthV4Direction rejects a strong HTF countertrend", () => {
  assert.equal(resolveEthV4Direction({
    fifteenMinute: trend("bullish", 0.4),
    oneHour: trend("bullish", 0.5),
    fourHour: trend("bearish", 0.75),
    strongCounterTrendAtr: 0.75,
  }), "neutral");
});

test("resolveEthV4Direction requires at least one 1h or 4h trend to agree with 15m", () => {
  assert.equal(resolveEthV4Direction({
    fifteenMinute: trend("bullish", 0.4),
    oneHour: trend("neutral", 0),
    fourHour: trend("bearish", 0.2),
    strongCounterTrendAtr: 0.75,
  }), "neutral");
});

test("completedTrendAt reads only the previous completed HTF bucket", () => {
  const previous = trend("bullish", 0.4);
  const unfinished = trend("bearish", 1.2);
  const previousBucket = Date.parse("2026-07-15T09:45:00Z") / 1_000;
  const currentBucket = Date.parse("2026-07-15T10:00:00Z") / 1_000;
  const snapshots = new Map<number, EthV4TrendSnapshot>([
    [previousBucket, previous],
    [currentBucket, unfinished],
  ]);

  assert.equal(
    completedTrendAt(Date.parse("2026-07-15T10:07:00Z") / 1_000, "15m", snapshots),
    previous,
  );
  assert.notEqual(
    completedTrendAt(Date.parse("2026-07-15T10:07:00Z") / 1_000, "15m", snapshots),
    unfinished,
  );
});
