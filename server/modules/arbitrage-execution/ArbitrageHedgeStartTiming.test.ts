import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  markHedgeStartTiming,
  measureHedgeStartTiming,
  measureHedgeStartTimingSync,
  persistHedgeStartExecutionRecord,
  recordHedgeReconcileAttempt,
  recordHedgeStartOutcome,
  withHedgeStartLegTiming,
  withHedgeStartTiming,
  type HedgeStartTimingSummary,
} from "./ArbitrageHedgeStartTiming";
import { ProviderMutationSerializer, type ProviderMutationKey } from "./ProviderMutationSerializer";
import {
  tracedProviderFetch,
  tracedProviderJson,
  withProviderCommandTrace,
} from "../cex/ProviderRequestTrace";

type Summary = HedgeStartTimingSummary & Record<string, any>;
const binding = { venue: "binance", accountId: "account-1" } as const;
const mutationKey: ProviderMutationKey = {
  userId: "user-1", venue: "binance", accountId: "account-1", canonicalInstrumentId: "DOGE-USDT-PERP",
};

test("happy path records actual Provider dispatch, ACK, terminal order, and leg gap", async () => {
  let summary: Summary | null = null;
  const transport: typeof fetch = async () => {
    await pause(2);
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  const providerFetch = tracedProviderFetch("binance", transport);
  await withProviderCommandTrace({ userId: "user-1", instanceId: "instance-1", commandId: "hedge-1",
    phase: "START", bindings: [binding] }, () => undefined, () => withHedgeStartTiming(
    { instanceId: "instance-1", commandId: "hedge-1" },
    (_event, facts) => { summary = facts as Summary; },
    async () => {
      await withHedgeStartLegTiming({ leg: "LEG1", childCommandId: "first", venue: "binance", legType: "SPOT" }, async () => {
        const response = await providerFetch("https://api.binance.com/api/v3/order", { method: "POST" });
        await tracedProviderJson(response);
        markHedgeStartTiming("leg1ProjectionCommitted");
        markHedgeStartTiming("leg1TerminalConfirmed");
      });
      await pause(2);
      await withHedgeStartLegTiming({ leg: "LEG2", childCommandId: "second", venue: "binance", legType: "PERPETUAL" }, async () => {
        const response = await providerFetch("https://fapi.binance.com/fapi/v1/order", { method: "POST" });
        await tracedProviderJson(response);
        markHedgeStartTiming("leg2TerminalConfirmed");
        markHedgeStartTiming("lifecycleCommitted");
      });
      recordHedgeStartOutcome("COMPLETED", null);
      markHedgeStartTiming("apiResponseReady");
    },
  ));

  const captured = requiredSummary(summary);
  const milestones = captured.milestonesMs as Record<string, number>;
  assert.ok(milestones.leg1RequestSent < milestones.leg1Ack);
  assert.ok(milestones.leg1Ack <= milestones.leg1TerminalConfirmed);
  assert.ok(milestones.leg1TerminalConfirmed < milestones.leg2RequestSent);
  assert.ok(milestones.leg2RequestSent < milestones.leg2Ack);
  assert.ok(milestones.leg2Ack <= milestones.leg2TerminalConfirmed);
  assert.ok(Math.abs(captured.legGapMs - rounded(milestones.leg2RequestSent - milestones.leg1TerminalConfirmed)) < 0.002);
  assert.equal(captured.outcome, "COMPLETED");
});

test("leg1 reject and partial stop before any leg2 Provider request", async () => {
  for (const outcome of ["STOPPED_FIRST_LEG_FAILED", "STOPPED_FIRST_LEG_PARTIAL"]) {
    const summary = await collect(async () => {
      await withHedgeStartLegTiming({ leg: "LEG1", childCommandId: "first", venue: "okx", legType: "SPOT" }, async () => {
        markHedgeStartTiming("leg1RequestSent");
        markHedgeStartTiming("leg1Ack");
      });
      recordHedgeStartOutcome(outcome, "LEG1_CONFIRM");
      markHedgeStartTiming("apiResponseReady");
    });
    assert.equal((summary.milestonesMs as Record<string, number>).leg2RequestSent, undefined);
    assert.equal(summary.outcome, outcome);
    assert.equal(summary.stoppedStage, "LEG1_CONFIRM");
  }
});

test("leg2 reject retains request and ACK timing without terminal confirmation", async () => {
  const summary = await collect(async () => {
    markHedgeStartTiming("leg1TerminalConfirmed");
    await withHedgeStartLegTiming({ leg: "LEG2", childCommandId: "second", venue: "bybit", legType: "PERPETUAL" }, async () => {
      markHedgeStartTiming("leg2RequestSent");
      markHedgeStartTiming("leg2Ack");
    });
    recordHedgeStartOutcome("STOPPED_SECOND_LEG_FAILED", "LEG2_CONFIRM");
  });
  const milestones = summary.milestonesMs as Record<string, number>;
  assert.equal(typeof milestones.leg2RequestSent, "number");
  assert.equal(typeof milestones.leg2Ack, "number");
  assert.equal(milestones.leg2TerminalConfirmed, undefined);
  assert.equal(summary.stoppedStage, "LEG2_CONFIRM");
});

test("credential and Provider GET aggregation preserves count, total, max, and category", async () => {
  let summary: Summary | null = null;
  const providerFetch = tracedProviderFetch("binance", async () => {
    await pause(1);
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  });
  await withProviderCommandTrace({ userId: "user-1", instanceId: "instance-1", commandId: "hedge-reads",
    phase: "START", bindings: [binding] }, () => undefined, () => withHedgeStartTiming(
    { instanceId: "instance-1", commandId: "hedge-reads" },
    (_event, facts) => { summary = facts as Summary; },
    () => withHedgeStartLegTiming({ leg: "LEG2", childCommandId: "second", venue: "binance", legType: "PERPETUAL" }, async () => {
      await measureHedgeStartTiming("credentialUnwrapMs", () => pause(1));
      await measureHedgeStartTiming("credentialUnwrapMs", () => pause(2));
      await providerFetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
      await providerFetch("https://fapi.binance.com/fapi/v2/positionRisk");
    }),
  ));
  const captured = requiredSummary(summary);
  assert.equal(captured.credentialUnwrapCount, 2);
  assert.ok(captured.credentialUnwrapTotalMs >= captured.credentialUnwrapMaxMs);
  assert.equal(captured.providerReadCount, 2);
  assert.ok(captured.providerReadTotalMs >= captured.providerReadMaxMs);
  assert.equal(captured.providerReadsBySubstage.INSTRUMENT_RULES.count, 1);
  assert.equal(captured.providerReadsBySubstage.POSITION_REALITY.count, 1);
});

test("serializer wait measures lock contention separately", async () => {
  const serializer = new ProviderMutationSerializer();
  let release!: () => void;
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = serializer.runExclusive(mutationKey, async () => {
    acquired();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await acquiredPromise;
  const summaryPromise = collect(() => serializer.runExclusive(mutationKey, async () => undefined));
  await pause(5);
  release();
  await blocker;
  const summary = await summaryPromise;
  assert.ok(summary.mutationSerializerWaitMs >= 4);
});

test("reconcile and persistence metrics remain distinct from ACK timing", async () => {
  const summary = await collect(() => withHedgeStartLegTiming(
    { leg: "LEG2", childCommandId: "second", venue: "okx", legType: "PERPETUAL" },
    async () => {
      markHedgeStartTiming("leg2RequestSent");
      markHedgeStartTiming("leg2Ack");
      recordHedgeReconcileAttempt();
      await measureHedgeStartTiming("reconcileMs", () => pause(2));
      measureHedgeStartTimingSync("executionReferencePersistMs", () => undefined);
      await persistHedgeStartExecutionRecord(async () => { await pause(1); });
      measureHedgeStartTimingSync("projectionCommitMs", () => undefined);
      markHedgeStartTiming("leg2TerminalConfirmed");
    },
  ));
  assert.equal(summary.leg2ReconcileAttempts, 1);
  assert.ok(summary.leg2ReconcileMs >= 1);
  assert.ok(summary.executionRecordPersistMs >= 0.5);
  assert.ok(summary.persistenceMs >= summary.executionRecordPersistMs);
  const milestones = summary.milestonesMs as Record<string, number>;
  assert.ok(milestones.leg2Ack < milestones.leg2TerminalConfirmed);
  assert.ok(milestones.leg2ExecutionRecordPersisted < milestones.leg2TerminalConfirmed);
});

test("logger failure is isolated and concurrent timing contexts do not cross commands", async () => {
  const result = await withHedgeStartTiming({ instanceId: "safe", commandId: "logger-throws" },
    () => { throw new Error("logger unavailable"); }, async () => "business-result");
  assert.equal(result, "business-result");

  const summaries: Summary[] = [];
  await Promise.all(["command-a", "command-b"].map((commandId, index) => withHedgeStartTiming(
    { instanceId: `instance-${index}`, commandId },
    (_event, facts) => { summaries.push(facts as Summary); },
    () => withHedgeStartLegTiming({ leg: "LEG1", childCommandId: `${commandId}-first`, venue: "bitget", legType: "SPOT" }, async () => {
      await pause(index + 1);
      recordHedgeStartOutcome("COMPLETED", null);
    }),
  )));
  assert.deepEqual(new Set(summaries.map(item => item.commandId)), new Set(["command-a", "command-b"]));
  assert.ok(summaries.every(item => String(item.legs.LEG1.childCommandId).startsWith(String(item.commandId))));
});

test("instrumentation overhead remains sub-millisecond per mock command locally", async () => {
  const samples = 100;
  const started = performance.now();
  for (let index = 0; index < samples; index += 1) {
    await withHedgeStartTiming({ instanceId: `instance-${index}`, commandId: `command-${index}` }, null, async () => {
      markHedgeStartTiming("leg1PrepareStart");
      markHedgeStartTiming("apiResponseReady");
    });
  }
  const perCommandMs = (performance.now() - started) / samples;
  assert.ok(perCommandMs < 1, `observed ${perCommandMs.toFixed(3)}ms per command`);
});

async function collect(run: () => Promise<unknown>): Promise<Summary> {
  let summary: Summary | null = null;
  await withHedgeStartTiming({ instanceId: "instance", commandId: "command" },
    (_event, facts) => { summary = facts as Summary; }, run);
  assert.ok(summary);
  return summary;
}

function pause(milliseconds: number) {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function rounded(value: number) { return Math.round(value * 1_000) / 1_000; }

function requiredSummary(value: Summary | null): Summary {
  assert.ok(value);
  return value;
}
