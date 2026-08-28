import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { NewArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import {
  ArbitrageUnstartedAbandonError,
  ArbitrageUnstartedAbandonService,
} from "./ArbitrageUnstartedAbandonService";

const now = 1_800_000_000_000;

test("explicitly abandons only an empty unstarted OPENING instance and preserves an audit", (t) => {
  const fixture = setup(t);
  const result = fixture.service.abandon("user-a", request("abandon-1"));

  assert.equal(result.instance.status, "FAILED");
  assert.equal(result.instance.closedAt, null);
  assert.deepEqual(result.instance.legs.map((leg) => [
    leg.confirmedOpenedQuantity,
    leg.confirmedClosedQuantity,
  ]), [["0", "0"], ["0", "0"]]);
  assert.deepEqual(result.instance.executionReferences, []);
  assert.deepEqual(result.instance.managementReleases, []);
  assert.equal(result.audit.previousStatus, "OPENING");
  assert.equal(result.audit.newStatus, "FAILED");
  assert.equal(result.audit.reason, "USER_ABANDONED_BEFORE_EXECUTION");
  assert.equal(result.providerMutationCount, 0);
  assert.deepEqual(fixture.store.listActive("user-a"), []);
  assert.equal(fixture.store.listHistory("user-a")[0]?.arbitrageId, "arbitrage-1");
  assert.equal(fixture.store.listUnstartedArbitrageAbandonmentsForUser("user-a").length, 1);
});

test("same command replays idempotently while a changed instance fingerprint conflicts", (t) => {
  const fixture = setup(t);
  const first = fixture.service.abandon("user-a", request("same-command"));
  const replay = fixture.service.abandon("user-a", request("same-command"));
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fixture.store.listUnstartedArbitrageAbandonmentsForUser("user-a").length, 1);

  fixture.store.create(instance("arbitrage-2"));
  assert.throws(
    () => fixture.service.abandon("user-a", request("same-command", "arbitrage-2")),
    (error: unknown) => error instanceof ArbitrageUnstartedAbandonError
      && error.category === "idempotency_conflict",
  );
  assert.equal(fixture.store.get("user-a", "arbitrage-2")?.status, "OPENING");

  assert.throws(
    () => fixture.store.claimExecutionReference("user-a", "arbitrage-2", {
      commandId: "same-command",
      operationType: "EXECUTION_OPEN",
      businessPayloadFingerprint: "different-operation-fingerprint",
      legId: "long-leg",
      phase: "OPENING",
      quantityEffect: "INCREASE",
      executionIntentId: "different-operation-intent",
      requestedQuantity: "1",
      createdAt: now + 1,
    }),
    /idempotency conflict/i,
  );
  assert.equal(fixture.store.get("user-a", "arbitrage-2")?.executionReferences.length, 0);
});

test("UNKNOWN and every existing execution reference fail closed", (t) => {
  const unknown = setup(t, "arbitrage-unknown");
  reference(unknown.store, "arbitrage-unknown", "intent-unknown", "UNKNOWN", "0", now + 1);
  assert.throws(
    () => unknown.service.abandon("user-a", request("unknown", "arbitrage-unknown")),
    unavailable,
  );
  assert.equal(unknown.store.get("user-a", "arbitrage-unknown")?.status, "OPENING");

  const claimed = setup(t, "arbitrage-claimed");
  claimed.store.claimExecutionReference("user-a", "arbitrage-claimed", {
    legId: "long-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: "intent-claimed",
    requestedQuantity: "1",
    createdAt: now + 1,
  });
  assert.throws(
    () => claimed.service.abandon("user-a", request("claimed", "arbitrage-claimed")),
    unavailable,
  );
});

test("an orphaned execution command prevents abandonment even when no reference is visible", (t) => {
  const fixture = setup(t, "arbitrage-commanded");
  const raw = new DatabaseSync(fixture.dbPath);
  raw.prepare(`INSERT INTO arbitrage_command_idempotency (
    commandId, operationType, requestedByUserId, arbitrageId, legId,
    referenceId, businessPayloadFingerprint, createdAt
  ) VALUES (?, 'EXECUTION_OPEN', 'user-a', ?, 'long-leg', ?, 'fingerprint', ?)`).run(
    "execution-command",
    "arbitrage-commanded",
    "orphan-intent",
    now + 1,
  );
  raw.close();

  assert.equal(fixture.store.get("user-a", "arbitrage-commanded")?.executionReferences.length, 0);
  assert.throws(
    () => fixture.service.abandon("user-a", request("abandon-commanded", "arbitrage-commanded")),
    unavailable,
  );
  assert.equal(fixture.store.get("user-a", "arbitrage-commanded")?.status, "OPENING");
});

test("confirmed quantity, active managed exposure, and terminal lifecycle reject abandonment", (t) => {
  const managed = setup(t, "arbitrage-managed");
  reference(managed.store, "arbitrage-managed", "intent-open", "CONFIRMED", "1", now + 1);
  assert.equal(managed.store.get("user-a", "arbitrage-managed")?.legs[0].confirmedOpenedQuantity, "1");
  assert.throws(
    () => managed.service.abandon("user-a", request("managed", "arbitrage-managed")),
    unavailable,
  );

  const failed = setup(t, "arbitrage-failed");
  failed.store.failEmptyOpening("user-a", "arbitrage-failed", now + 1);
  assert.throws(
    () => failed.service.abandon("user-a", request("failed", "arbitrage-failed")),
    unavailable,
  );

  const closed = setup(t, "arbitrage-closed");
  reference(closed.store, "arbitrage-closed", "long-open", "CONFIRMED", "1", now + 1, "long-leg");
  reference(closed.store, "arbitrage-closed", "short-open", "CONFIRMED", "1", now + 5, "short-leg");
  reference(closed.store, "arbitrage-closed", "long-close", "CONFIRMED", "1", now + 10, "long-leg", "CLOSING", "DECREASE");
  reference(closed.store, "arbitrage-closed", "short-close", "CONFIRMED", "1", now + 15, "short-leg", "CLOSING", "DECREASE");
  assert.equal(closed.store.get("user-a", "arbitrage-closed")?.status, "CLOSED");
  assert.throws(
    () => closed.service.abandon("user-a", request("closed", "arbitrage-closed")),
    unavailable,
  );
});

test("requires authenticated ownership and an exact explicit-confirmation payload", (t) => {
  const fixture = setup(t);
  assert.throws(
    () => fixture.service.abandon("user-b", request("foreign")),
    (error: unknown) => error instanceof ArbitrageUnstartedAbandonError
      && error.category === "arbitrage_instance_not_found",
  );
  for (const input of [
    { arbitrageId: "arbitrage-1", commandId: "missing-confirmation" },
    { arbitrageId: "arbitrage-1", commandId: "false-confirmation", confirmed: false },
    { arbitrageId: "arbitrage-1", commandId: "extra", confirmed: true, quantity: "1" },
  ]) {
    assert.throws(
      () => fixture.service.abandon("user-a", input),
      (error: unknown) => error instanceof ArbitrageUnstartedAbandonError
        && error.category === "invalid_abandon_confirmation",
    );
  }
});

function setup(t: TestContext, arbitrageId = "arbitrage-1") {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-unstarted-abandon-"));
  const dbPath = join(root, "trading.sqlite");
  const store = new ArbitrageInstanceStore({ dbPath });
  store.create(instance(arbitrageId));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    dbPath,
    store,
    service: new ArbitrageUnstartedAbandonService(store, () => now + 100),
  };
}

function instance(arbitrageId: string): NewArbitrageInstance {
  return {
    arbitrageId,
    userId: "user-a",
    strategyType: "SPOT_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.01",
    createdAt: now,
    legs: [
      { legId: "long-leg", role: "LONG", venue: "binance", accountId: "binance:user-a", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "1" },
      { legId: "short-leg", role: "SHORT", venue: "binance", accountId: "binance:user-a", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "1" },
    ],
  };
}

function request(commandId: string, arbitrageId = "arbitrage-1") {
  return { arbitrageId, commandId, confirmed: true };
}

function reference(
  store: ArbitrageInstanceStore,
  arbitrageId: string,
  intentId: string,
  status: "CONFIRMED" | "UNKNOWN",
  confirmedQuantity: string,
  at: number,
  legId = "long-leg",
  phase: "OPENING" | "CLOSING" = "OPENING",
  quantityEffect: "INCREASE" | "DECREASE" = "INCREASE",
) {
  store.claimExecutionReference("user-a", arbitrageId, {
    legId,
    phase,
    quantityEffect,
    executionIntentId: intentId,
    requestedQuantity: "1",
    createdAt: at,
  });
  store.linkExecutionRecord("user-a", arbitrageId, intentId, `record-${intentId}`, at + 1);
  store.applyExecutionResult("user-a", arbitrageId, {
    executionIntentId: intentId,
    status,
    confirmedQuantity,
    updatedAt: at + 2,
  });
}

function unavailable(error: unknown) {
  return error instanceof ArbitrageUnstartedAbandonError
    && error.category === "abandon_unavailable";
}
