import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
  startVisibilityAwarePolling,
  type VisibilityPollingRuntime,
} from "./visibilityPolling";

class FakeVisibilityPollingRuntime implements VisibilityPollingRuntime {
  visible = true;
  readonly timers = new Map<number, () => void>();
  readonly listeners = new Set<() => void>();
  private nextTimer = 1;

  isVisible = () => this.visible;

  setInterval = (callback: () => void, intervalMs: number) => {
    assert.equal(intervalMs, ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS);
    const timer = this.nextTimer;
    this.nextTimer += 1;
    this.timers.set(timer, callback);
    return timer;
  };

  clearInterval = (timer: number) => {
    this.timers.delete(timer);
  };

  addVisibilityChangeListener = (listener: () => void) => {
    this.listeners.add(listener);
  };

  removeVisibilityChangeListener = (listener: () => void) => {
    this.listeners.delete(listener);
  };

  setVisible(visible: boolean) {
    this.visible = visible;
    for (const listener of [...this.listeners]) listener();
  }

  tick(times = 1) {
    for (let index = 0; index < times; index += 1) {
      for (const callback of [...this.timers.values()]) callback();
    }
  }
}

function simulateDashboardPolling(durationMs: number, pollingIntervalMs: number) {
  const rawSnapshotTtlMs = 20_000;
  const orderbookCacheTtlMs = 30_000;
  const orderbookCount = 90;
  let rawExpiresAt = Number.NEGATIVE_INFINITY;
  let orderbookExpiresAt = Number.NEGATIVE_INFINITY;
  let rawRefreshes = 0;
  let orderbookHits = 0;
  let orderbookMisses = 0;

  for (let now = 0; now < durationMs; now += pollingIntervalMs) {
    if (rawExpiresAt > now) continue;
    rawRefreshes += 1;
    rawExpiresAt = now + rawSnapshotTtlMs;
    if (orderbookExpiresAt > now) {
      orderbookHits += orderbookCount;
      continue;
    }
    orderbookMisses += orderbookCount;
    orderbookExpiresAt = now + orderbookCacheTtlMs;
  }

  return {
    httpPolls: Math.ceil(durationMs / pollingIntervalMs),
    orderbookHits,
    orderbookMisses,
    orderbookProviderFetches: orderbookMisses,
    rawRefreshes,
  };
}

test("dashboard automatic polling interval is 25 seconds", () => {
  assert.equal(ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS, 25_000);
});

test("visible polling starts one 25-second timer and polls on the interval", () => {
  const runtime = new FakeVisibilityPollingRuntime();
  let requests = 0;

  const dispose = startVisibilityAwarePolling(
    () => { requests += 1; },
    ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    runtime,
  );

  assert.equal(requests, 0, "the page's existing mount effect owns the immediate request");
  assert.equal(runtime.timers.size, 1);
  assert.equal(runtime.listeners.size, 1);
  runtime.tick();
  assert.equal(requests, 1);
  dispose();
});

test("25-second polling avoids the 30-second orderbook expiry boundary", () => {
  const durationMs = 10 * 60_000;

  assert.deepEqual(simulateDashboardPolling(durationMs, 30_000), {
    httpPolls: 20,
    orderbookHits: 0,
    orderbookMisses: 1_800,
    orderbookProviderFetches: 1_800,
    rawRefreshes: 20,
  });
  assert.deepEqual(simulateDashboardPolling(durationMs, 25_000), {
    httpPolls: 24,
    orderbookHits: 1_080,
    orderbookMisses: 1_080,
    orderbookProviderFetches: 1_080,
    rawRefreshes: 24,
  });
});

test("hidden pages pause automatic polling for multiple intervals", () => {
  const runtime = new FakeVisibilityPollingRuntime();
  let requests = 0;
  const dispose = startVisibilityAwarePolling(
    () => { requests += 1; },
    ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    runtime,
  );

  runtime.setVisible(false);
  assert.equal(runtime.timers.size, 0);
  runtime.tick(60);
  assert.equal(requests, 0);
  dispose();
});

test("becoming visible refreshes once and restarts a single full interval", () => {
  const runtime = new FakeVisibilityPollingRuntime();
  let requests = 0;
  const dispose = startVisibilityAwarePolling(
    () => { requests += 1; },
    ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    runtime,
  );

  runtime.setVisible(false);
  runtime.setVisible(true);
  assert.equal(requests, 1, "resume performs exactly one immediate refresh");
  assert.equal(runtime.timers.size, 1, "resume replaces rather than accumulates timers");
  runtime.tick();
  assert.equal(requests, 2, "the next request belongs to the restarted interval");
  dispose();
});

test("repeated visibility changes never accumulate timers or listeners", () => {
  const runtime = new FakeVisibilityPollingRuntime();
  let requests = 0;
  const dispose = startVisibilityAwarePolling(
    () => { requests += 1; },
    ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    runtime,
  );

  for (let cycle = 0; cycle < 5; cycle += 1) {
    runtime.setVisible(false);
    assert.equal(runtime.timers.size, 0);
    runtime.setVisible(true);
    assert.equal(runtime.timers.size, 1);
    assert.equal(runtime.listeners.size, 1);
  }

  assert.equal(requests, 5);
  dispose();
});

test("cleanup removes the timer and listener and prevents later requests", () => {
  const runtime = new FakeVisibilityPollingRuntime();
  let requests = 0;
  const dispose = startVisibilityAwarePolling(
    () => { requests += 1; },
    ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    runtime,
  );

  dispose();
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.listeners.size, 0);
  runtime.tick();
  runtime.setVisible(false);
  runtime.setVisible(true);
  assert.equal(requests, 0);
});

test("both dashboard pages keep immediate, horizon-aware and manual refresh behavior", () => {
  const arbitragePage = readFileSync(
    new URL("../../../pages/app/ArbitragePage.tsx", import.meta.url),
    "utf8",
  );
  const analysisPage = readFileSync(
    new URL("../../../pages/app/FundingArbitrageOpportunitiesPage.tsx", import.meta.url),
    "utf8",
  );

  for (const source of [arbitragePage, analysisPage]) {
    assert.match(source, /void load\(\);\s*\}, \[load\]\);/);
    assert.match(source, /startVisibilityAwarePolling\(/);
    assert.match(source, /\(\) => void load\(true\)/);
    assert.match(source, /lifecycleGeneration\.current !== generation/);
  }
  assert.match(arbitragePage, /\}, \[horizonDays\]\);/);
  assert.match(analysisPage, /\}, \[horizonDays, opportunityId\]\);/);
});
