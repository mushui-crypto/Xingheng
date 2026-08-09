import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PerpetualPerpetualFundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";
import { FundingArbitrageExecutionCoordinator } from "./FundingArbitrageExecutionCoordinator";

const now = 1_800_000_000_000;
const coordinator = new FundingArbitrageExecutionCoordinator();

test("creates a CREATED execution state from an intent", () => {
  const intent = perpetualIntent();
  const state = coordinator.createExecution(intent);
  assert.equal(state.intentId, intent.intentId);
  assert.equal(state.status, "CREATED");
  assert.equal(state.legs.length, 2);
});

test("transitions CREATED to EXECUTING", () => {
  const created = coordinator.createExecution(perpetualIntent());
  const executing = coordinator.transition(created, { type: "START_EXECUTION", occurredAt: now + 1 });
  assert.equal(executing.status, "EXECUTING");
  assert.equal(created.status, "CREATED");
});

test("transitions to HEDGED only after both legs reach planned confirmed quantity", () => {
  const executing = startExecution();
  const longFilled = coordinator.transition(executing, {
    type: "LEG_CONFIRMED_FILLED",
    legId: executing.legs[0].legId,
    confirmedExecutedQuantity: "0.12",
    occurredAt: now + 2,
  });
  assert.equal(longFilled.status, "RESIDUAL");

  const hedged = coordinator.transition(longFilled, {
    type: "LEG_CONFIRMED_FILLED",
    legId: executing.legs[1].legId,
    confirmedExecutedQuantity: "0.120000",
    occurredAt: now + 3,
  });
  assert.equal(hedged.status, "HEDGED");
  assert.equal(hedged.residualExposure.residualQuantity, "0");
});

test("a single confirmed leg creates RESIDUAL", () => {
  const executing = startExecution();
  const residual = coordinator.transition(executing, {
    type: "LEG_CONFIRMED_FILLED",
    legId: executing.legs[0].legId,
    confirmedExecutedQuantity: "0.12",
    occurredAt: now + 2,
  });
  assert.equal(residual.status, "RESIDUAL");
  assert.equal(residual.residualExposure.residualQuantity, "0.12");
});

test("partial confirmed fills calculate decimal-safe residual quantity", () => {
  const executing = startExecution();
  const longPartial = coordinator.transition(executing, {
    type: "LEG_CONFIRMED_PARTIAL",
    legId: executing.legs[0].legId,
    confirmedExecutedQuantity: "0.07000000",
    occurredAt: now + 2,
  });
  const bothPartial = coordinator.transition(longPartial, {
    type: "LEG_CONFIRMED_PARTIAL",
    legId: executing.legs[1].legId,
    confirmedExecutedQuantity: "0.02",
    occurredAt: now + 3,
  });

  assert.equal(bothPartial.status, "RESIDUAL");
  assert.equal(bothPartial.residualExposure.residualQuantity, "0.05");
  assert.equal(bothPartial.legs[0].remainingQuantity, "0.05");
  assert.equal(bothPartial.legs[1].remainingQuantity, "0.1");
});

test("unknown remote state enters reconciliation and can resolve to HEDGED", () => {
  const executing = startExecution();
  const longFilled = coordinator.transition(executing, {
    type: "LEG_CONFIRMED_FILLED",
    legId: executing.legs[0].legId,
    confirmedExecutedQuantity: "0.12",
    occurredAt: now + 2,
  });
  const unknown = coordinator.transition(longFilled, {
    type: "LEG_REMOTE_UNKNOWN",
    legId: executing.legs[1].legId,
    occurredAt: now + 3,
  });
  assert.equal(unknown.status, "PENDING_RECONCILIATION");

  const reconciled = coordinator.transition(unknown, {
    type: "LEG_RECONCILIATION_RESOLVED",
    legId: executing.legs[1].legId,
    confirmedExecutedQuantity: "0.12",
    remoteObservation: "FILLED",
    occurredAt: now + 4,
  });
  assert.equal(reconciled.status, "HEDGED");
});

test("unknown remote state cannot transition directly to FAILED", () => {
  const executing = startExecution();
  const unknown = coordinator.transition(executing, {
    type: "LEG_REMOTE_UNKNOWN",
    legId: executing.legs[0].legId,
    occurredAt: now + 2,
  });
  assert.throws(
    () => coordinator.transition(unknown, { type: "MARK_FAILED", occurredAt: now + 3 }),
    /cannot transition directly to FAILED/u,
  );
  assert.equal(unknown.status, "PENDING_RECONCILIATION");
});

test("execution cannot be marked complete without confirmed fills", () => {
  const executing = startExecution();
  assert.throws(
    () => coordinator.transition(executing, { type: "MARK_COMPLETE", occurredAt: now + 2 }),
    /without a confirmed quantity hedge/u,
  );
  assert.equal(executing.status, "EXECUTING");
});

test("transitions return new state objects without mutating prior state", () => {
  const created = coordinator.createExecution(perpetualIntent());
  const executing = coordinator.transition(created, { type: "START_EXECUTION", occurredAt: now + 1 });
  const submitting = coordinator.transition(executing, {
    type: "LEG_SUBMIT_STARTED",
    legId: executing.legs[0].legId,
    occurredAt: now + 2,
  });

  assert.notEqual(executing, created);
  assert.notEqual(submitting, executing);
  assert.equal(created.status, "CREATED");
  assert.equal(executing.legs[0].status, "NOT_STARTED");
  assert.equal(submitting.legs[0].status, "PENDING_SUBMIT");
});

test("coordinator imports only the Intent and Execution State boundaries", () => {
  const source = readFileSync(
    new URL("./FundingArbitrageExecutionCoordinator.ts", import.meta.url),
    "utf8",
  );
  const importPaths = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(importPaths, [
    "./FundingArbitrageExecutionIntent",
    "./FundingArbitrageExecutionState",
  ]);
});

function startExecution() {
  const created = coordinator.createExecution(perpetualIntent());
  return coordinator.transition(created, { type: "START_EXECUTION", occurredAt: now + 1 });
}

function perpetualIntent(): PerpetualPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "intent-phase-6b",
    sourcePlanId: "plan-phase-5",
    strategyType: "PERPETUAL_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.001", maxLegStartSkewMs: 500 },
    legs: [
      {
        legId: "leg-long",
        role: "long",
        venue: "binance",
        instrumentId: "binance:perpetual:linear:BTC:USDT:USDT",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.12",
      },
      {
        legId: "leg-short",
        role: "short",
        venue: "okx",
        instrumentId: "okx:perpetual:linear:BTC:USDT:USDT",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.12",
      },
    ],
  };
}
