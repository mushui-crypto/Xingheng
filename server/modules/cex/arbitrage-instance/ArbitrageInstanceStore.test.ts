import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedCurrentQuantity, type NewArbitrageInstance } from "./ArbitrageInstance";
import { ArbitrageInstanceStore } from "./ArbitrageInstanceStore";

const start = 1_800_000_000_000;

test("creates and reads an isolated OPENING instance with exactly two legs and nullable PnL", () => {
  withStore(({ store }) => {
    const created = store.create(instance());

    assert.equal(created.status, "OPENING");
    assert.equal(created.openedAt, null);
    assert.equal(created.closedAt, null);
    assert.deepEqual(created.legs.map(({ role }) => role), ["LONG", "SHORT"]);
    assert.deepEqual(created.legs.map(managedCurrentQuantity), ["0", "0"]);
    assert.deepEqual(created.pnl, unknownPnl());
    assert.deepEqual(store.get("user-a", "arbitrage-1"), created);
    assert.equal(store.get("user-b", "arbitrage-1"), null);
  });
});

test("rejects a missing leg, duplicate role, and duplicate leg identity", () => {
  withStore(({ store }) => {
    assert.throws(
      () => store.create({ ...instance(), legs: [instance().legs[0]] } as unknown as NewArbitrageInstance),
      /exactly two legs/u,
    );
    assert.throws(
      () => store.create({
        ...instance({ arbitrageId: "arbitrage-roles" }),
        legs: [instance().legs[0], { ...instance().legs[1], role: "LONG" }],
      }),
      /one LONG leg and one SHORT leg/u,
    );
    assert.throws(
      () => store.create({
        ...instance({ arbitrageId: "arbitrage-legs" }),
        legs: [instance().legs[0], { ...instance().legs[1], legId: "long-leg" }],
      }),
      /legId values must be unique/u,
    );
  });
});

test("claims before linking and rejects reusing an executionIntentId across instances", () => {
  withStore(({ store }) => {
    store.create(instance());
    store.create(instance({ arbitrageId: "arbitrage-2" }));

    const claimed = store.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "intent-shared", start + 1));
    assert.equal(claimed.executionReferences[0]?.status, "CLAIMED");
    assert.equal(claimed.executionReferences[0]?.executionRecordId, null);

    assert.throws(
      () => store.claimExecutionReference("user-a", "arbitrage-2", claim("long-leg", "intent-shared", start + 2)),
      /already claimed/u,
    );

    const linked = store.linkExecutionRecord(
      "user-a",
      "arbitrage-1",
      "intent-shared",
      "record-1",
      start + 2,
    );
    assert.equal(linked.executionReferences[0]?.status, "LINKED");
    assert.equal(linked.executionReferences[0]?.executionRecordId, "record-1");
  });
});

test("restricts execution phases while allowing both adjustment quantity effects", () => {
  withStore(({ store }) => {
    store.create(instance());
    assert.throws(
      () => store.claimExecutionReference(
        "user-a",
        "arbitrage-1",
        claim("long-leg", "invalid-close", start + 1, "CLOSING", "DECREASE"),
      ),
      /does not accept CLOSING/u,
    );
    assert.throws(
      () => store.claimExecutionReference(
        "user-a",
        "arbitrage-1",
        claim("long-leg", "invalid-open", start + 1, "OPENING", "DECREASE"),
      ),
      /must increase managed exposure/u,
    );

    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "1", start + 20);
    store.claimExecutionReference(
      "user-a",
      "arbitrage-1",
      claim("long-leg", "adjust-increase", start + 30, "ADJUSTMENT", "INCREASE", "0.1"),
    );
    store.claimExecutionReference(
      "user-a",
      "arbitrage-1",
      claim("short-leg", "adjust-decrease", start + 31, "ADJUSTMENT", "DECREASE", "0.1"),
    );
  });
});

test("uses quantityEffect rather than BUY or SELL semantics for LONG and SHORT opening legs", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    let current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.status, "RESIDUAL");
    assert.equal(current.legs[0].confirmedOpenedQuantity, "1");

    // A SHORT is normally established by SELL, but its managed exposure still increases.
    execute(store, "short-leg", "short-sell-open", "OPENING", "INCREASE", "1", start + 20);
    current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.status, "HOLDING");
    assert.equal(current.legs[1].confirmedOpenedQuantity, "1");
    assert.deepEqual(current.legs.map(managedCurrentQuantity), ["1", "1"]);
    assert.equal(current.openedAt, start + 22);
  });
});

test("uses the instance-frozen residual threshold and preserves openedAt across adjustments", () => {
  withStore(({ store }) => {
    store.create(instance({ maxResidualBaseQuantity: "0.01" }));
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "0.995", start + 20);
    const firstOpenedAt = store.get("user-a", "arbitrage-1")!.openedAt;
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "HOLDING");

    execute(store, "long-leg", "long-increase", "ADJUSTMENT", "INCREASE", "0.1", start + 30);
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "RESIDUAL");
    execute(store, "short-leg", "short-increase", "ADJUSTMENT", "INCREASE", "0.1", start + 40);

    const restored = store.get("user-a", "arbitrage-1")!;
    assert.equal(restored.status, "HOLDING");
    assert.equal(restored.openedAt, firstOpenedAt);
    assert.deepEqual(restored.legs.map(managedCurrentQuantity), ["1.1", "1.095"]);
  });
});

test("keeps incomplete or unmatched exposure as RESIDUAL instead of FAILED", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-failed", "OPENING", "INCREASE", "1", start + 20, "FAILED", "0");

    const current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.status, "RESIDUAL");
    assert.deepEqual(current.legs.map(managedCurrentQuantity), ["1", "0"]);
  });
});

test("records a partial pending fill as managed residual exposure", () => {
  withStore(({ store }) => {
    store.create(instance());
    claimAndLink(store, "long-leg", "long-partial", "OPENING", "INCREASE", "1", start + 10);
    const partial = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-partial",
      status: "PENDING_CONFIRMATION",
      confirmedQuantity: "0.4",
      updatedAt: start + 12,
    });

    assert.equal(partial.status, "RESIDUAL");
    assert.equal(partial.legs[0].confirmedOpenedQuantity, "0.4");
    assert.equal(partial.executionReferences[0]?.status, "PENDING_CONFIRMATION");

    const replay = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-partial",
      status: "PENDING_CONFIRMATION",
      confirmedQuantity: "0.4",
      updatedAt: start + 12,
    });
    assert.equal(replay.legs[0].confirmedOpenedQuantity, "0.4");
  });
});

test("marks a terminated zero-exposure opening as FAILED and lists active/history separately", () => {
  withStore(({ store }) => {
    store.create(instance());
    store.create(instance({ arbitrageId: "arbitrage-active" }));

    execute(store, "long-leg", "long-failed", "OPENING", "INCREASE", "1", start + 10, "FAILED", "0");
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "OPENING");
    execute(store, "short-leg", "short-failed", "OPENING", "INCREASE", "1", start + 20, "FAILED", "0");
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "FAILED");
    assert.deepEqual(store.listActive("user-a").map(({ arbitrageId }) => arbitrageId), ["arbitrage-active"]);
    assert.deepEqual(store.listHistory("user-a").map(({ arbitrageId }) => arbitrageId), ["arbitrage-1"]);
  });
});

test("moves HOLDING through CLOSING to CLOSED only after both managed quantities reach zero", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "1", start + 20);
    const openedAt = store.get("user-a", "arbitrage-1")!.openedAt;

    claimAndLink(store, "long-leg", "long-close", "CLOSING", "DECREASE", "1", start + 30);
    claimAndLink(store, "short-leg", "short-close", "CLOSING", "DECREASE", "1", start + 40);
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "CLOSING");

    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 42,
    });
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "CLOSING");

    const closed = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "short-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 43,
    });
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.openedAt, openedAt);
    assert.equal(closed.closedAt, start + 43);
    assert.deepEqual(closed.legs.map(managedCurrentQuantity), ["0", "0"]);
    assert.deepEqual(store.listHistory("user-a").map(({ arbitrageId }) => arbitrageId), ["arbitrage-1"]);
  });
});

test("rolls back a DECREASE that would exceed this arbitrage instance's managed exposure", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    claimAndLink(store, "long-leg", "bad-close", "CLOSING", "DECREASE", "2", start + 20);

    assert.throws(
      () => store.applyExecutionResult("user-a", "arbitrage-1", {
        executionIntentId: "bad-close",
        status: "CONFIRMED",
        confirmedQuantity: "2",
        updatedAt: start + 23,
      }),
      /cannot exceed confirmed opened quantity/u,
    );
    const current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.legs[0].confirmedClosedQuantity, "0");
    assert.equal(current.executionReferences.find(({ executionIntentId }) => executionIntentId === "bad-close")?.confirmedQuantity, "0");
  });
});

test("isolates every read and mutation by userId plus arbitrageId", () => {
  withStore(({ store }) => {
    store.create(instance());
    assert.equal(store.get("user-b", "arbitrage-1"), null);
    assert.deepEqual(store.listActive("user-b"), []);
    assert.deepEqual(store.listHistory("user-b"), []);
    assert.throws(
      () => store.claimExecutionReference("user-b", "arbitrage-1", claim("long-leg", "foreign", start + 1)),
      /not found for the authenticated user/u,
    );
    assert.throws(
      () => store.updateTargetQuantities("user-b", "arbitrage-1", [{ legId: "long-leg", plannedQuantity: "2" }], start + 1),
      /not found for the authenticated user/u,
    );
    store.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "owned-intent", start + 1));
    assert.throws(
      () => store.linkExecutionRecord("user-b", "arbitrage-1", "owned-intent", "foreign-record", start + 2),
      /not found for the authenticated user/u,
    );
    assert.throws(
      () => store.applyExecutionResult("user-b", "arbitrage-1", {
        executionIntentId: "owned-intent",
        status: "FAILED",
        confirmedQuantity: "0",
        updatedAt: start + 2,
      }),
      /not found for the authenticated user/u,
    );
    assert.throws(
      () => store.updateCumulativeReturns("user-b", "arbitrage-1", unknownPnl(), start + 2),
      /not found for the authenticated user/u,
    );
    assert.equal(store.get("user-a", "arbitrage-1")?.executionReferences.length, 1);
    assert.equal(store.get("user-a", "arbitrage-1")?.executionReferences[0]?.executionRecordId, null);
  });
});

test("updates target quantities without creating a new arbitrage instance", () => {
  withStore(({ store }) => {
    store.create(instance());
    const updated = store.updateTargetQuantities("user-a", "arbitrage-1", [
      { legId: "long-leg", plannedQuantity: "1.2" },
      { legId: "short-leg", plannedQuantity: "1.2" },
    ], start + 1);

    assert.equal(updated.arbitrageId, "arbitrage-1");
    assert.deepEqual(updated.legs.map(({ plannedQuantity }) => plannedQuantity), ["1.2", "1.2"]);
  });
});

test("restores CLOSED lifecycle, quantities, references, timestamps, and nullable PnL after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "1", start + 20);
    first.updateCumulativeReturns("user-a", "arbitrage-1", unknownPnl(), start + 30);
    claimAndLink(first, "long-leg", "long-close", "CLOSING", "DECREASE", "1", start + 40);
    claimAndLink(first, "short-leg", "short-close", "CLOSING", "DECREASE", "1", start + 50);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 52,
    });
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "short-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 53,
    });
    const expected = first.get("user-a", "arbitrage-1");
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      const restored = second.get("user-a", "arbitrage-1");
      assert.deepEqual(restored, expected);
      assert.equal(restored?.status, "CLOSED");
      assert.equal(restored?.openedAt, start + 22);
      assert.equal(restored?.closedAt, start + 53);
      assert.deepEqual(restored?.pnl, unknownPnl());
      assert.equal(restored?.executionReferences.length, 4);
    } finally {
      second.close();
    }
  });
});

test("persists an accepted close safety residual and restores terminal lifecycle after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      legs: [
        { ...instance().legs[0], instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "73" },
        { ...instance().legs[1], plannedQuantity: "73" },
      ],
    }));
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "73", start + 20);
    first.claimExecutionReference("user-a", "arbitrage-1", {
      ...claim("long-leg", "long-close", start + 30, "CLOSING", "DECREASE", "72"),
      acceptedResidualQuantity: "1",
    });
    first.linkExecutionRecord("user-a", "arbitrage-1", "long-close", "long-close-record", start + 31);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close", status: "CONFIRMED", confirmedQuantity: "72", updatedAt: start + 32,
    });
    execute(first, "short-leg", "short-close", "CLOSING", "DECREASE", "73", start + 40);
    const expected = first.get("user-a", "arbitrage-1");
    assert.equal(expected?.status, "CLOSED");
    assert.equal(expected?.maxResidualBaseQuantity, "1");
    assert.deepEqual(expected?.legs.map(managedCurrentQuantity), ["1", "0"]);
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), expected);
    } finally {
      second.close();
    }
  });
});

test("clears the initial planned mismatch tolerance before terminalization unless Spot residual is audited", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      maxResidualBaseQuantity: "1",
      legs: [
        { ...instance().legs[0], instrumentId: "BTC-USDT-SPOT", plannedQuantity: "73" },
        { ...instance().legs[1], instrumentId: "BTC-USDT-PERP", plannedQuantity: "72" },
      ],
    }));
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "72", start + 20);
    assert.equal(first.get("user-a", "arbitrage-1")?.status, "HOLDING");
    assert.equal(first.get("user-a", "arbitrage-1")?.maxResidualBaseQuantity, "1");

    execute(first, "long-leg", "long-close", "CLOSING", "DECREASE", "72", start + 30);
    execute(first, "short-leg", "short-close", "CLOSING", "DECREASE", "72", start + 40);
    const expected = first.get("user-a", "arbitrage-1");
    assert.equal(expected?.maxResidualBaseQuantity, "0");
    assert.equal(expected?.status, "RESIDUAL");
    assert.deepEqual(expected?.legs.map(managedCurrentQuantity), ["1", "0"]);
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), expected);
      assert.equal(second.get("user-a", "arbitrage-1")?.status, "RESIDUAL");
    } finally {
      second.close();
    }
  });
});

test("never applies an accepted Spot residual allowance to a perpetual residual, including after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      legs: [
        { ...instance().legs[0], instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "73" },
        { ...instance().legs[1], instrumentId: "DOGE-USDT-PERP", plannedQuantity: "73" },
      ],
    }));
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "73", start + 20);
    first.claimExecutionReference("user-a", "arbitrage-1", {
      ...claim("long-leg", "long-close", start + 30, "CLOSING", "DECREASE", "72"),
      acceptedResidualQuantity: "1",
    });
    first.linkExecutionRecord("user-a", "arbitrage-1", "long-close", "long-close-record", start + 31);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close", status: "CONFIRMED", confirmedQuantity: "72", updatedAt: start + 32,
    });
    execute(first, "short-leg", "short-close", "CLOSING", "DECREASE", "73", start + 40, "CONFIRMED", "72");
    const expected = first.get("user-a", "arbitrage-1");
    assert.equal(expected?.status, "RESIDUAL");
    assert.equal(expected?.maxResidualBaseQuantity, "1");
    assert.deepEqual(expected?.legs.map(managedCurrentQuantity), ["1", "1"]);
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), expected);
      assert.equal(second.get("user-a", "arbitrage-1")?.status, "RESIDUAL");
    } finally {
      second.close();
    }
  });
});

test("never closes a perpetual-perpetual instance while either perpetual leg has residual exposure", () => {
  withStore(({ store }) => {
    store.create(instance({ maxResidualBaseQuantity: "1", legs: [
      { ...instance().legs[0], plannedQuantity: "73" },
      { ...instance().legs[1], plannedQuantity: "73" },
    ] }));
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "73", start + 20);
    execute(store, "long-leg", "long-close", "CLOSING", "DECREASE", "73", start + 30, "CONFIRMED", "72");
    execute(store, "short-leg", "short-close", "CLOSING", "DECREASE", "73", start + 40);

    const result = store.get("user-a", "arbitrage-1");
    assert.equal(result?.status, "RESIDUAL");
    assert.deepEqual(result?.legs.map(managedCurrentQuantity), ["1", "0"]);
  });
});

test("restores an unfinished execution claim after restart without relying on memory", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    first.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "interrupted-intent", start + 1));
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      const restored = second.get("user-a", "arbitrage-1")!;
      assert.deepEqual(restored.executionReferences, [{
        arbitrageId: "arbitrage-1",
        legId: "long-leg",
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: "interrupted-intent",
        executionRecordId: null,
        requestedQuantity: "1",
        confirmedQuantity: "0",
        status: "CLAIMED",
        createdAt: start + 1,
        updatedAt: start + 1,
      }]);
      assert.equal(restored.status, "OPENING");
    } finally {
      second.close();
    }
  });
});

function instance(overrides: Partial<NewArbitrageInstance> = {}): NewArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1",
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0",
    createdAt: start,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: "okx:account-a",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "binance:account-a",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
    ],
    ...overrides,
  };
}

function claim(
  legId: string,
  executionIntentId: string,
  createdAt: number,
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING" = "OPENING",
  quantityEffect: "INCREASE" | "DECREASE" = "INCREASE",
  requestedQuantity = "1",
) {
  return { legId, phase, quantityEffect, executionIntentId, requestedQuantity, createdAt } as const;
}

function claimAndLink(
  store: ArbitrageInstanceStore,
  legId: string,
  executionIntentId: string,
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  requestedQuantity: string,
  time: number,
) {
  store.claimExecutionReference(
    "user-a",
    "arbitrage-1",
    claim(legId, executionIntentId, time, phase, quantityEffect, requestedQuantity),
  );
  store.linkExecutionRecord(
    "user-a",
    "arbitrage-1",
    executionIntentId,
    `${executionIntentId}-record`,
    time + 1,
  );
}

function execute(
  store: ArbitrageInstanceStore,
  legId: string,
  executionIntentId: string,
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  requestedQuantity: string,
  time: number,
  status: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN" = "CONFIRMED",
  confirmedQuantity = requestedQuantity,
) {
  claimAndLink(store, legId, executionIntentId, phase, quantityEffect, requestedQuantity, time);
  return store.applyExecutionResult("user-a", "arbitrage-1", {
    executionIntentId,
    status,
    confirmedQuantity,
    updatedAt: time + 2,
  });
}

function unknownPnl() {
  return {
    asset: null,
    cumulativeFundingPnl: null,
    realizedTradingPnl: null,
    feesCosts: null,
    cumulativeNetPnl: null,
    updatedAt: null,
  } as const;
}

function withStore(operation: (fixture: { store: ArbitrageInstanceStore; dbPath: string }) => void) {
  withDatabase(({ dbPath }) => {
    const store = new ArbitrageInstanceStore({ dbPath });
    try {
      operation({ store, dbPath });
    } finally {
      store.close();
    }
  });
}

function withDatabase(operation: (fixture: { dbPath: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-instance-store-"));
  try {
    operation({ dbPath: join(root, "arbitrage-instances.sqlite") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
