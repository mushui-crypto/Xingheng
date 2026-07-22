import assert from "node:assert/strict";
import test from "node:test";
import { createFundingClock } from "./fundingClock";

test("all funding countdowns share one timer and release it after the final unsubscribe", () => {
  let intervalCallback: (() => void) | null = null;
  let intervalCount = 0;
  let clearedTimer: number | null = null;
  const clock = createFundingClock({
    now: () => 1_700_000_000_000,
    isVisible: () => true,
    setInterval: (callback) => {
      intervalCallback = callback;
      intervalCount += 1;
      return 17;
    },
    clearInterval: (timer) => {
      clearedTimer = timer;
    },
  });

  let firstUpdates = 0;
  let secondUpdates = 0;
  const unsubscribeFirst = clock.subscribe(() => { firstUpdates += 1; });
  const unsubscribeSecond = clock.subscribe(() => { secondUpdates += 1; });

  assert.equal(intervalCount, 1);
  assert.ok(intervalCallback);
  (intervalCallback as () => void)();
  assert.deepEqual([firstUpdates, secondUpdates], [1, 1]);

  unsubscribeFirst();
  assert.equal(clearedTimer, null);
  unsubscribeSecond();
  assert.equal(clearedTimer, 17);
});

test("the funding clock does not notify React subscribers while the page is hidden", () => {
  let visible = false;
  let now = 1_700_000_000_000;
  let intervalCallback: (() => void) | null = null;
  const clock = createFundingClock({
    now: () => now,
    isVisible: () => visible,
    setInterval: (callback) => {
      intervalCallback = callback;
      return 23;
    },
    clearInterval: () => undefined,
  });

  let updates = 0;
  const unsubscribe = clock.subscribe(() => { updates += 1; });
  now += 1_000;
  assert.ok(intervalCallback);
  (intervalCallback as () => void)();
  assert.equal(updates, 0);
  assert.equal(clock.getSnapshot(), 1_700_000_000_000);

  visible = true;
  (intervalCallback as () => void)();
  assert.equal(updates, 1);
  assert.equal(clock.getSnapshot(), now);
  unsubscribe();
});
