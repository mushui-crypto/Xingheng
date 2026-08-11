import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionRecord } from "../ExecutionRecord";
import type { ExecutionQueryObservation } from "../ExecutionQueryCapability";
import type { FundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";
import { FundingArbitrageExecutionCoordinator } from "./FundingArbitrageExecutionCoordinator";
import { FundingLegExecutionStateBridge } from "./FundingLegExecutionStateBridge";

const now = 1_800_000_000_000;
const bridge = new FundingLegExecutionStateBridge();

test("confirmed execution updates the linked funding leg", () => {
  const updated = apply(startedState(), "leg-long", execution("long", "CONFIRMED"), {
    state: "CONFIRMED",
    filledBaseQuantity: "0.002",
    observedAt: now + 2,
  });

  const leg = updated.legs[0];
  assert.equal(leg.status, "TERMINAL");
  assert.equal(leg.remoteObservation, "FILLED");
  assert.equal(leg.confirmedExecutedQuantity, "0.002");
  assert.equal(leg.remainingQuantity, "0");
});

test("unknown execution enters funding reconciliation without losing known fill quantity", () => {
  const partial = apply(startedState(), "leg-long", execution("long", "PENDING_CONFIRMATION"), {
    state: "PENDING_CONFIRMATION",
    filledBaseQuantity: "0.001",
    observedAt: now + 2,
  });
  const updated = apply(partial, "leg-long", execution("long", "UNKNOWN", now + 2), {
    state: "UNKNOWN",
    filledBaseQuantity: "0",
    observedAt: now + 3,
  });

  assert.equal(updated.legs[0].status, "PENDING_RECONCILIATION");
  assert.equal(updated.legs[0].remoteObservation, "UNKNOWN_REMOTE_STATE");
  assert.equal(updated.legs[0].confirmedExecutedQuantity, "0.001");
  assert.equal(updated.status, "PENDING_RECONCILIATION");
});

test("partial fill quantity maps to ACTIVE funding leg state", () => {
  const updated = apply(startedState(), "leg-long", execution("long", "PENDING_CONFIRMATION"), {
    state: "PENDING_CONFIRMATION",
    filledBaseQuantity: "0.0015",
    observedAt: now + 2,
  });

  assert.equal(updated.legs[0].status, "ACTIVE");
  assert.equal(updated.legs[0].remoteObservation, "OPEN");
  assert.equal(updated.legs[0].confirmedExecutedQuantity, "0.0015");
  assert.equal(updated.legs[0].remainingQuantity, "0.0005");
});

test("two equal confirmed leg executions derive HEDGED", () => {
  const long = apply(startedState(), "leg-long", execution("long", "CONFIRMED"), confirmed("0.002", now + 2));
  const hedged = apply(long, "leg-short", execution("short", "CONFIRMED", now + 2), confirmed("0.002", now + 3));

  assert.equal(hedged.status, "HEDGED");
  assert.equal(hedged.residualExposure.residualQuantity, "0");
});

test("mismatched confirmed quantities derive RESIDUAL", () => {
  const long = apply(startedState(), "leg-long", execution("long", "CONFIRMED"), confirmed("0.002", now + 2));
  const residual = apply(long, "leg-short", execution("short", "CONFIRMED", now + 2), confirmed("0.0015", now + 3));

  assert.equal(residual.status, "RESIDUAL");
  assert.equal(residual.residualExposure.residualQuantity, "0.0005");
});

test("failed execution becomes a failed funding leg without a fill", () => {
  const updated = apply(startedState(), "leg-long", execution("long", "FAILED"), {
    state: "FAILED",
    filledBaseQuantity: "0",
    observedAt: now + 2,
  });

  assert.equal(updated.legs[0].status, "FAILED");
  assert.equal(updated.legs[0].remoteObservation, "REJECTED");
  assert.equal(updated.legs[0].confirmedExecutedQuantity, "0");
  assert.equal(updated.status, "FAILED");
});

test("rejects user and link identity mismatch without provider access", () => {
  const record = execution("long", "CONFIRMED");
  const observation = confirmed("0.002", now + 2);

  assert.throws(
    () => bridge.apply(input(startedState(), "leg-long", record, observation, { authenticatedUserId: "user-b" })),
    /userId does not match/u,
  );
  assert.throws(
    () => bridge.apply(input(startedState(), "leg-long", record, observation, {
      link: { executionIntentId: "another-intent", executionRecordId: record.executionId },
    })),
    /link does not match/u,
  );
});

test("bridge is pure and has no provider or execution dependency", () => {
  const source = readFileSync(new URL("./FundingLegExecutionStateBridge.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Client|Runtime|OrderManager|fetch\(|cancel|placeOrder|execute\(/u);
  assert.doesNotMatch(source, /scheduler|worker|queue|retry|setInterval|setTimeout/iu);
});

function apply(
  state: ReturnType<typeof startedState>,
  legId: string,
  record: ReturnType<typeof execution>,
  observation: ExecutionQueryObservation,
) {
  return bridge.apply(input(state, legId, record, observation));
}

function input(
  fundingState: ReturnType<typeof startedState>,
  legId: string,
  executionRecord: ReturnType<typeof execution>,
  observation: ExecutionQueryObservation,
  overrides: Partial<Parameters<FundingLegExecutionStateBridge["apply"]>[0]> = {},
) {
  return {
    authenticatedUserId: "user-a",
    fundingState,
    legId,
    link: {
      executionIntentId: executionRecord.intentId,
      executionRecordId: executionRecord.executionId,
    },
    executionRecord,
    observation,
    ...overrides,
  };
}

function startedState() {
  const coordinator = new FundingArbitrageExecutionCoordinator();
  const created = coordinator.createExecution(fundingIntent());
  return coordinator.transition(created, { type: "START_EXECUTION", occurredAt: now + 1 });
}

function execution(
  suffix: "long" | "short",
  status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN",
  updatedAt = now + 1,
) {
  return createExecutionRecord({
    executionId: `execution-${suffix}`,
    intentId: `execution-intent-${suffix}`,
    executionAttemptId: `execution-intent-${suffix}`,
    remoteOrderId: `remote-${suffix}`,
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status,
    createdAt: now,
    updatedAt,
  });
}

function confirmed(filledBaseQuantity: string, observedAt: number): ExecutionQueryObservation {
  return { state: "CONFIRMED", filledBaseQuantity, observedAt };
}

function fundingIntent(): FundingArbitrageExecutionIntent {
  return {
    intentId: "funding-intent-1",
    sourcePlanId: "plan-1",
    strategyType: "PERPETUAL_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    constraints: { maxResidualBaseQuantity: "0" },
    createdAt: now,
    expiresAt: now + 60_000,
    legs: [
      {
        legId: "leg-long",
        role: "long",
        venue: "binance",
        instrumentId: "XAUT-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.002",
      },
      {
        legId: "leg-short",
        role: "short",
        venue: "okx",
        instrumentId: "XAUT-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.002",
      },
    ],
  };
}
