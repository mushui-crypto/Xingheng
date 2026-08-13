import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NewArbitrageInstance } from "./ArbitrageInstance";
import { ArbitrageInstanceQueryService } from "./ArbitrageInstanceQueryService";
import { ArbitrageInstanceStore } from "./ArbitrageInstanceStore";

const start = 1_800_000_000_000;

test("lists every active lifecycle status for only the authenticated user", () => {
  withQuery(({ store, query }) => {
    seedLifecycleStates(store);
    store.create(instance("foreign-opening", "user-b", start + 60));

    const active = query.listActive("user-a");

    assert.deepEqual(active.map(({ status }) => status), [
      "CLOSING",
      "HOLDING",
      "RESIDUAL",
      "OPENING",
    ]);
    assert.equal(active.every(({ userId }) => userId === "user-a"), true);
    assert.equal(Object.isFrozen(active), true);
  });
});

test("lists CLOSED and FAILED history with page and limit applied in the store", () => {
  withQuery(({ store, query }) => {
    seedLifecycleStates(store);

    const firstPage = query.listHistory("user-a", { page: 1, limit: 1 });
    const secondPage = query.listHistory("user-a", { page: 2, limit: 1 });
    const defaultPage = query.listHistory("user-a");

    assert.deepEqual(firstPage.map(({ arbitrageId, status }) => ({ arbitrageId, status })), [
      { arbitrageId: "closed", status: "CLOSED" },
    ]);
    assert.deepEqual(secondPage.map(({ arbitrageId, status }) => ({ arbitrageId, status })), [
      { arbitrageId: "failed", status: "FAILED" },
    ]);
    assert.deepEqual(defaultPage.map(({ arbitrageId }) => arbitrageId), ["closed", "failed"]);
    assert.equal(Object.isFrozen(firstPage), true);
  });
});

test("gets an owned instance while missing and cross-user ids remain invisible", () => {
  withQuery(({ store, query }) => {
    store.create(instance("owned", "user-a", start));
    store.create(instance("foreign", "user-b", start + 1));

    assert.equal(query.getById("user-a", "owned")?.arbitrageId, "owned");
    assert.equal(query.getById("user-a", "missing"), null);
    assert.equal(query.getById("user-a", "foreign"), null);
    assert.deepEqual(query.listActive("user-b").map(({ arbitrageId }) => arbitrageId), ["foreign"]);
  });
});

test("rejects invalid pagination without querying an unbounded history page", () => {
  withQuery(({ query }) => {
    assert.throws(() => query.listHistory("user-a", { page: 0 }), /page must be a positive integer/u);
    assert.throws(() => query.listHistory("user-a", { limit: 0 }), /limit must be a positive integer/u);
    assert.throws(
      () => query.listHistory("user-a", { page: Number.MAX_SAFE_INTEGER, limit: 2 }),
      /offset is too large/u,
    );
  });
});

test("uses a default history limit of 50 and converts page to a store offset", () => {
  const calls: Array<{ userId: string; limit: number; offset: number }> = [];
  const query = new ArbitrageInstanceQueryService({
    listActive: () => [],
    listHistory(userId, pagination) {
      calls.push({ userId, ...pagination });
      return [];
    },
    get: () => null,
  });

  query.listHistory("user-a");
  query.listHistory("user-a", { page: 3, limit: 10 });

  assert.deepEqual(calls, [
    { userId: "user-a", limit: 50, offset: 0 },
    { userId: "user-a", limit: 10, offset: 20 },
  ]);
});

function seedLifecycleStates(store: ArbitrageInstanceStore) {
  store.create(instance("opening", "user-a", start + 1));

  store.create(instance("residual", "user-a", start + 10));
  execute(store, "user-a", "residual", "long-leg", "residual-long", "OPENING", "INCREASE", "CONFIRMED", "1", start + 11);

  store.create(instance("holding", "user-a", start + 20));
  openBoth(store, "user-a", "holding", start + 21);

  store.create(instance("closing", "user-a", start + 30));
  openBoth(store, "user-a", "closing", start + 31);
  claimAndLink(store, "user-a", "closing", "long-leg", "closing-long", "CLOSING", "DECREASE", start + 40);

  store.create(instance("failed", "user-a", start + 50));
  execute(store, "user-a", "failed", "long-leg", "failed-long", "OPENING", "INCREASE", "FAILED", "0", start + 51);
  execute(store, "user-a", "failed", "short-leg", "failed-short", "OPENING", "INCREASE", "FAILED", "0", start + 54);

  store.create(instance("closed", "user-a", start + 60));
  openBoth(store, "user-a", "closed", start + 61);
  execute(store, "user-a", "closed", "long-leg", "closed-long", "CLOSING", "DECREASE", "CONFIRMED", "1", start + 70);
  execute(store, "user-a", "closed", "short-leg", "closed-short", "CLOSING", "DECREASE", "CONFIRMED", "1", start + 73);
}

function openBoth(store: ArbitrageInstanceStore, userId: string, arbitrageId: string, time: number) {
  execute(store, userId, arbitrageId, "long-leg", `${arbitrageId}-open-long`, "OPENING", "INCREASE", "CONFIRMED", "1", time);
  execute(store, userId, arbitrageId, "short-leg", `${arbitrageId}-open-short`, "OPENING", "INCREASE", "CONFIRMED", "1", time + 3);
}

function execute(
  store: ArbitrageInstanceStore,
  userId: string,
  arbitrageId: string,
  legId: string,
  executionIntentId: string,
  phase: "OPENING" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  status: "CONFIRMED" | "FAILED",
  confirmedQuantity: string,
  time: number,
) {
  claimAndLink(store, userId, arbitrageId, legId, executionIntentId, phase, quantityEffect, time);
  store.applyExecutionResult(userId, arbitrageId, {
    executionIntentId,
    status,
    confirmedQuantity,
    updatedAt: time + 2,
  });
}

function claimAndLink(
  store: ArbitrageInstanceStore,
  userId: string,
  arbitrageId: string,
  legId: string,
  executionIntentId: string,
  phase: "OPENING" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  time: number,
) {
  store.claimExecutionReference(userId, arbitrageId, {
    legId,
    phase,
    quantityEffect,
    executionIntentId,
    requestedQuantity: "1",
    createdAt: time,
  });
  store.linkExecutionRecord(
    userId,
    arbitrageId,
    executionIntentId,
    `${executionIntentId}-record`,
    time + 1,
  );
}

function instance(arbitrageId: string, userId: string, createdAt: number): NewArbitrageInstance {
  return {
    arbitrageId,
    userId,
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: `plan-${arbitrageId}`,
    maxResidualBaseQuantity: "0",
    createdAt,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: `okx:${userId}`,
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: `binance:${userId}`,
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
    ],
  };
}

function withQuery(
  operation: (fixture: {
    store: ArbitrageInstanceStore;
    query: ArbitrageInstanceQueryService;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-instance-query-"));
  const store = new ArbitrageInstanceStore({ dbPath: join(root, "query.sqlite") });
  try {
    operation({ store, query: new ArbitrageInstanceQueryService(store) });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
