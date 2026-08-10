import assert from "node:assert/strict";
import test from "node:test";
import {
  assessOpportunity,
  BinanceFundingArbitrageStrategy,
} from "./BinanceFundingArbitrageStrategy";
import { BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT } from "./BinanceExecutionPolicy";
import type { BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceOrderManager } from "./BinanceOrderManager";
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

test("tradable existing spot requires strict acknowledgement before any order attempt", async () => {
  const snapshot = snapshotFixture({ existingSpotQuantityXaut: 0.002 });
  let placeCalls = 0;
  const orders = {
    syncPositions: async () => snapshot,
    place: async () => { placeCalls += 1; throw new Error("must not place"); },
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(orders, tradingConfigFixture());

  await assert.rejects(() => strategy.enter({
    idempotencyKey: "existing-no-ack",
    executionPriceMode: "MARKET",
  }), /requires explicit/u);
  assert.equal(placeCalls, 0);
});

test("invalid venue rules reject even a strict exposure acknowledgement before any order attempt", async () => {
  const snapshot = snapshotFixture({
    existingSpotQuantityXaut: 0.002,
    spot: { ...snapshotFixture().spot, minOrderQty: Number.NaN },
  });
  let placeCalls = 0;
  const orders = {
    syncPositions: async () => snapshot,
    place: async () => { placeCalls += 1; throw new Error("must not place"); },
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(orders, tradingConfigFixture());

  await assert.rejects(() => strategy.enter({
    idempotencyKey: "invalid-rules-with-ack",
    executionPriceMode: "MARKET",
    existingExposureRiskAcknowledgement: BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
  }), /trading rules are invalid/u);
  assert.equal(placeCalls, 0);
});

test("spot dust needs no acknowledgement and strict acknowledgement permits tradable exposure to reach the guard", async (t) => {
  for (const scenario of [
    { name: "dust", snapshot: snapshotFixture({ existingSpotQuantityXaut: 0.000096 }), acknowledgement: undefined },
    {
      name: "tradable acknowledged",
      snapshot: snapshotFixture({ existingSpotQuantityXaut: 0.002 }),
      acknowledgement: BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      let guardCalls = 0;
      const zeroFill = providerOrderFixture("Cancelled", 0);
      const orders = {
        syncPositions: async () => scenario.snapshot,
        place: async (_input: unknown, guard?: () => void | Promise<void>) => {
          await guard?.();
          guardCalls += 1;
          return zeroFill;
        },
      } as unknown as BinanceOrderManager;
      const strategy = new BinanceFundingArbitrageStrategy(orders, tradingConfigFixture());
      const result = await strategy.enter({
        idempotencyKey: `entry-${scenario.name}`,
        executionPriceMode: "IOC_LIMIT",
        ...(scenario.acknowledgement ? { existingExposureRiskAcknowledgement: scenario.acknowledgement } : {}),
      });
      assert.equal(result.state, "not_filled");
      assert.equal(guardCalls, 1);
    });
  }
});

test("first-leg guard rejects account, total exposure, direction, classification, or open-order drift before mutation", async (t) => {
  const cases = [
    { name: "account", initial: snapshotFixture(), changed: snapshotFixture({ accountId: "binance:changed" }) },
    { name: "spot total", initial: snapshotFixture(), changed: snapshotFixture({ existingSpotQuantityXaut: 0.0001 }) },
    {
      name: "direction",
      initial: snapshotFixture({ existingPerpetualQuantityXaut: 0.001, perpetualPositionSide: "long" }),
      changed: snapshotFixture({ existingPerpetualQuantityXaut: 0.001, perpetualPositionSide: "short" }),
    },
    {
      name: "classification",
      initial: snapshotFixture({ existingSpotQuantityXaut: 0.000096 }),
      changed: snapshotFixture({ existingSpotQuantityXaut: 0.001 }),
    },
    { name: "open order", initial: snapshotFixture(), changed: snapshotFixture({ openSpotOrderCount: 1 }) },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let snapshotReads = 0;
      let providerMutations = 0;
      let exitCalls = 0;
      const orders = {
        syncPositions: async () => snapshotReads++ === 0 ? scenario.initial : scenario.changed,
        place: async (_input: unknown, guard?: () => void | Promise<void>) => {
          await guard?.();
          providerMutations += 1;
          return providerOrderFixture("Filled", 0.01);
        },
        reconcile: async () => ({ reconciled: [], snapshot: scenario.changed, orders: [] }),
        listOrders: () => [],
      } as unknown as BinanceOrderManager;
      const strategy = new BinanceFundingArbitrageStrategy(orders, tradingConfigFixture());
      strategy.exit = async () => {
        exitCalls += 1;
        return { state: "closed", spot: null, perpetual: null, snapshot: snapshotFixture() };
      };
      await assert.rejects(() => strategy.enter({
        idempotencyKey: `drift-${scenario.name}`,
        executionPriceMode: "MARKET",
        existingExposureRiskAcknowledgement: BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
      }), /changed before provider mutation/u);
      assert.equal(providerMutations, 0);
      assert.equal(exitCalls, 0);
    });
  }
});

test("IOC zero fill returns not_filled without second leg, timer, reconciliation, or recovery", async () => {
  const snapshot = snapshotFixture();
  const calls: string[] = [];
  const zeroFill: BinanceProviderOrder = {
    orderId: "ioc-zero",
    orderLinkId: "ioc-zero",
    status: "Cancelled",
    requestedQuantityXaut: 0.01,
    filledQuantityXaut: 0,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: Date.now(),
  };
  const orders = {
    syncPositions: async () => snapshot,
    place: async (input: Record<string, unknown>) => {
      calls.push(String(input.category));
      assert.equal(input.executionPriceMode, "IOC_LIMIT");
      return zeroFill;
    },
    reconcile: async () => { calls.push("reconcile"); },
    listOrders: () => [],
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(
    orders,
    tradingConfigFixture(),
  );

  const result = await strategy.enter({
    idempotencyKey: "zero-fill",
    executionPriceMode: "IOC_LIMIT",
  });

  assert.equal(result.state, "not_filled");
  assert.deepEqual(calls, ["spot"]);
});

test("entry mutation anomaly with unresolved order reconciles and forbids compensation", async () => {
  const snapshot = snapshotFixture();
  let reconciliationCalls = 0;
  let placeCalls = 0;
  const orders = {
    syncPositions: async () => snapshot,
    place: async () => {
      placeCalls += 1;
      throw new Error("provider transport anomaly");
    },
    reconcile: async () => {
      reconciliationCalls += 1;
      return { reconciled: [], snapshot, orders: [] };
    },
    listOrders: () => [{
      idempotencyKey: "unknown-entry:spot-entry",
      status: "processing",
      order: null,
    }],
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(
    orders,
    tradingConfigFixture(),
  );

  await assert.rejects(
    () => strategy.enter({
      idempotencyKey: "unknown-entry",
      executionPriceMode: "MARKET",
    }),
    /blocked until authoritative reconciliation/u,
  );
  assert.equal(reconciliationCalls, 1);
  assert.equal(placeCalls, 1);
});

test("zero fill with acknowledged pre-existing exposure never triggers total-account exit", async () => {
  const snapshot = snapshotFixture({
    existingSpotQuantityXaut: 0.002,
    spotFreeXaut: 0.002,
    spotAvailableQuantityXaut: 0.002,
  });
  let exitCalls = 0;
  let reconciliationCalls = 0;
  const orders = {
    syncPositions: async () => snapshot,
    place: async (_input: unknown, guard?: () => void | Promise<void>) => {
      await guard?.();
      return providerOrderFixture("Cancelled", 0);
    },
    reconcile: async () => { reconciliationCalls += 1; },
    listOrders: () => [],
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(orders, tradingConfigFixture());
  strategy.exit = async () => {
    exitCalls += 1;
    return { state: "closed", spot: null, perpetual: null, snapshot };
  };

  const result = await strategy.enter({
    idempotencyKey: "existing-zero-fill",
    executionPriceMode: "IOC_LIMIT",
    existingExposureRiskAcknowledgement: BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
  });
  assert.equal(result.state, "not_filled");
  assert.equal(reconciliationCalls, 0);
  assert.equal(exitCalls, 0);
});

test("second-leg guard anchors the confirmed first-leg snapshot and recovers on later drift", async () => {
  const flat = snapshotFixture();
  const afterFirst = snapshotFixture({
    existingSpotQuantityXaut: 0.01,
    spotFreeXaut: 0.01,
    spotAvailableQuantityXaut: 0.01,
  });
  const drifted = snapshotFixture({
    existingSpotQuantityXaut: 0.011,
    spotFreeXaut: 0.011,
    spotAvailableQuantityXaut: 0.011,
  });
  const snapshots = [flat, flat, afterFirst, drifted, drifted, flat];
  let snapshotIndex = 0;
  let providerMutations = 0;
  let recoveryCalls = 0;
  const spotOrder = providerOrderFixture("Filled", 0.01);
  const orders = {
    syncPositions: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!,
    place: async (input: Record<string, unknown>, guard?: () => void | Promise<void>) => {
      await guard?.();
      providerMutations += 1;
      if (input.category === "spot") return spotOrder;
      return providerOrderFixture("Filled", 0.01);
    },
    reconcile: async () => ({ reconciled: [], snapshot: drifted, orders: [] }),
    listOrders: () => [{
      idempotencyKey: "second-leg-drift:spot-entry",
      status: "completed",
      order: spotOrder,
    }],
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(orders, tradingConfigFixture());
  strategy.exit = async () => {
    recoveryCalls += 1;
    return { state: "closed", spot: null, perpetual: null, snapshot: flat };
  };

  await assert.rejects(() => strategy.enter({
    idempotencyKey: "second-leg-drift",
    executionPriceMode: "MARKET",
  }), /changed before provider mutation/u);
  assert.equal(providerMutations, 1);
  assert.equal(recoveryCalls, 1);
});

test("confirmed 0.002 versus 0.00199 is within the Binance XAUT residual tolerance", async () => {
  const snapshot = snapshotFixture();
  const fills = [0.002, 0.00199];
  let placeCalls = 0;
  const orders = {
    syncPositions: async () => snapshot,
    place: async () => {
      const filledQuantityXaut = fills[placeCalls++]!;
      return {
        orderId: `tolerance-${placeCalls}`,
        orderLinkId: `tolerance-${placeCalls}`,
        status: "Filled",
        requestedQuantityXaut: 0.002,
        filledQuantityXaut,
        averagePrice: 1_000,
        feeUsd: 0,
        updatedAt: Date.now(),
      } satisfies BinanceProviderOrder;
    },
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(
    orders,
    tradingConfigFixture(),
  );

  const result = await strategy.enter({
    idempotencyKey: "within-residual-tolerance",
    executionPriceMode: "MARKET",
  });

  assert.equal(result.state, "hedged");
  assert.equal(placeCalls, 2);
});

test("confirmed residual above tolerance reconciles account exposure and recovers instead of returning hedged", async () => {
  const flat = snapshotFixture();
  const exposed = snapshotFixture({
    existingSpotQuantityXaut: 0.01,
    spotAvailableQuantityXaut: 0.01,
    spotFreeXaut: 0.01,
    existingPerpetualQuantityXaut: 0.00998,
    perpetualPositionSide: "short",
  });
  let exposurePresent = true;
  let placeCalls = 0;
  let reconciliationCalls = 0;
  let recoveryCalls = 0;
  const orders = {
    syncPositions: async () => placeCalls === 0 || !exposurePresent ? flat : exposed,
    place: async () => {
      placeCalls += 1;
      const filledQuantityXaut = placeCalls === 1 ? 0.01 : 0.00998;
      return {
        orderId: `residual-${placeCalls}`,
        orderLinkId: `residual-${placeCalls}`,
        status: "Filled",
        requestedQuantityXaut: 0.01,
        filledQuantityXaut,
        averagePrice: 1_000,
        feeUsd: 0,
        updatedAt: Date.now(),
      } satisfies BinanceProviderOrder;
    },
    reconcile: async () => {
      reconciliationCalls += 1;
      return { reconciled: [], snapshot: exposed, orders: [] };
    },
    listOrders: () => [
      { idempotencyKey: "above-residual-tolerance:spot-entry", status: "completed", order: providerOrderFixture("Filled", 0.01) },
      { idempotencyKey: "above-residual-tolerance:perpetual-entry", status: "completed", order: providerOrderFixture("Filled", 0.00998) },
    ],
  } as unknown as BinanceOrderManager;
  const strategy = new BinanceFundingArbitrageStrategy(
    orders,
    tradingConfigFixture(),
  );
  strategy.exit = async () => {
    recoveryCalls += 1;
    exposurePresent = false;
    return { state: "closed", spot: null, perpetual: null, snapshot: flat };
  };

  await assert.rejects(() => strategy.enter({
    idempotencyKey: "above-residual-tolerance",
    executionPriceMode: "MARKET",
  }), /exceeded the confirmed XAUT residual tolerance/u);
  assert.equal(reconciliationCalls, 1);
  assert.equal(recoveryCalls, 1);
});

function providerOrderFixture(
  status: BinanceProviderOrder["status"],
  filledQuantityXaut: number,
): BinanceProviderOrder {
  return {
    orderId: `strategy-${status}`,
    orderLinkId: `strategy-${status}`,
    status,
    requestedQuantityXaut: 0.01,
    filledQuantityXaut,
    averagePrice: filledQuantityXaut > 0 ? 1_000 : null,
    feeUsd: 0,
    updatedAt: Date.now(),
  };
}
