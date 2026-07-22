import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArbitrageDashboardService,
  ArbitrageRefreshCooldownError,
} from "./ArbitrageDashboardService";
import type { ArbitrageDashboardSnapshot } from "./arbitrageTypes";

describe("ArbitrageDashboardService cache and refresh control", () => {
  it("reuses a fresh 20 second snapshot for ordinary requests", async () => {
    let now = 1_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      snapshotLoader: async (horizonDays) => snapshot(horizonDays, ++loads),
    });

    const first = await service.getSnapshot(90);
    now += 19_999;
    const second = await service.getSnapshot(90);

    assert.equal(loads, 1);
    assert.equal(second, first);
  });

  it("merges in-flight ordinary requests for the same horizon", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      snapshotLoader: async (horizonDays) => {
        loads += 1;
        await gate;
        return snapshot(horizonDays, loads);
      },
    });

    const first = service.getSnapshot(90);
    const second = service.getSnapshot(90);
    release();

    assert.equal(await first, await second);
    assert.equal(loads, 1);
  });

  it("serves the old snapshot when refresh cooldown is hit", async () => {
    let now = 10_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      forcedRefreshCooldownMs: 10_000,
      snapshotLoader: async (horizonDays) => snapshot(horizonDays, ++loads),
    });

    const cached = await service.getSnapshot(90);
    const refreshed = await service.getSnapshot(90, true);
    now += 1_000;
    const cooledDown = await service.getSnapshot(90, true);

    assert.equal(loads, 2);
    assert.notEqual(refreshed, cached);
    assert.equal(cooledDown, refreshed);
  });

  it("returns a cooldown error when refresh cooldown is hit without a snapshot", async () => {
    let now = 20_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      forcedRefreshCooldownMs: 10_000,
      snapshotLoader: async (horizonDays) => snapshot(horizonDays, ++loads),
    });

    await service.getSnapshot(90, true);
    now += 1_000;

    await assert.rejects(
      () => service.getSnapshot(365, true),
      (error) => error instanceof ArbitrageRefreshCooldownError && error.retryAfterSeconds === 9,
    );
    assert.equal(loads, 1);
  });

  it("cleans up in-flight requests after loader failures", async () => {
    let attempts = 0;
    const service = new ArbitrageDashboardService({
      snapshotLoader: async (horizonDays) => {
        attempts += 1;
        if (attempts === 1) throw new Error("upstream failed");
        return snapshot(horizonDays, attempts);
      },
    });

    await assert.rejects(() => service.getSnapshot(90), /upstream failed/);
    const recovered = await service.getSnapshot(90);

    assert.equal(attempts, 2);
    assert.equal(recovered.generatedAt, 2);
  });
});

function snapshot(horizonDays: 90 | 365, generatedAt: number): ArbitrageDashboardSnapshot {
  return {
    horizonDays,
    generatedAt,
    markets: [],
    opportunities: [],
    summary: {
      bestScore: null,
      bestNetApr: null,
      eligibleOpportunityCount: 0,
      connectedVenueCount: 0,
      totalVenueCount: 5,
      trackedMarketCount: 0,
      usdcUsdtPrice: null,
      stablecoinBasisBps: null,
    },
    warnings: [],
  };
}
