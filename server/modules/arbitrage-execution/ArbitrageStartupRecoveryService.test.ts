import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { UnresolvedExecutionRecoveryCandidate } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { ArbitrageExecutionCommandError } from "./ArbitrageExecutionCommandService";
import {
  ArbitrageStartupRecoveryService,
  type StartupRecoveryLogger,
} from "./ArbitrageStartupRecoveryService";

test("startup recovery serially reconciles all four venue candidates and classifies outcomes", async () => {
  const candidates = [
    candidate("binance", "CLAIMED", "intent-claimed", 1),
    candidate("okx", "LINKED", "intent-linked", 2),
    candidate("bybit", "PENDING_CONFIRMATION", "intent-pending", 3, "40"),
    candidate("bitget", "UNKNOWN", "intent-unknown", 4),
  ];
  const calls: string[] = [];
  let providerMutations = 0;
  const logs = logger();
  const service = new ArbitrageStartupRecoveryService(
    { listUnresolvedExecutionReferencesForRecovery: () => candidates },
    {
      reconcileLeg: async (_userId: string, input: any) => {
        calls.push(input.executionIntentId);
        if (input.executionIntentId === "intent-claimed") {
          throw new ArbitrageExecutionCommandError(
            "execution_recovery_record_not_found",
            "record missing",
          );
        }
        if (input.executionIntentId === "intent-linked") return confirmation("PENDING_CONFIRMATION", "0");
        if (input.executionIntentId === "intent-pending") return confirmation("FAILED", "70");
        return confirmation("UNKNOWN", "0");
      },
    } as any,
    logs.value,
  );

  const result = await service.runOnce();

  assert.deepEqual(calls, candidates.map(({ executionIntentId }) => executionIntentId));
  assert.deepEqual(result.outcomes.map(({ outcome }) => outcome), [
    "MANUAL_REVIEW_REQUIRED", "STILL_PENDING", "RECOVERED", "STILL_UNKNOWN",
  ]);
  assert.deepEqual(result.outcomes.map(({ newConfirmedQuantity }) => newConfirmedQuantity), ["0", "0", "70", "0"]);
  assert.deepEqual({
    candidates: result.candidates,
    recovered: result.recovered,
    stillPending: result.stillPending,
    stillUnknown: result.stillUnknown,
    manualReview: result.manualReview,
  }, { candidates: 4, recovered: 1, stillPending: 1, stillUnknown: 1, manualReview: 1 });
  assert.equal(result.source, "SYSTEM_RECOVERY");
  assert.equal(providerMutations, 0);
  assert.equal(logs.infos.length, 1);
  assert.equal(logs.warnings.length, 1);
  assert.equal(JSON.stringify(logs).includes("record missing"), false);
});

test("one candidate Provider outage is isolated and later candidates still recover", async () => {
  const candidates = [
    candidate("binance", "UNKNOWN", "provider-outage", 1),
    candidate("okx", "UNKNOWN", "provider-recovers", 2),
  ];
  const calls: string[] = [];
  const logs = logger();
  const service = new ArbitrageStartupRecoveryService(
    { listUnresolvedExecutionReferencesForRecovery: () => candidates },
    {
      reconcileLeg: async (_userId: string, input: any) => {
        calls.push(input.executionIntentId);
        if (input.executionIntentId === "provider-outage") throw new Error("secret Provider payload");
        return confirmation("CONFIRMED", "100");
      },
    } as any,
    logs.value,
  );

  const result = await service.runOnce();

  assert.deepEqual(calls, ["provider-outage", "provider-recovers"]);
  assert.deepEqual(result.outcomes.map(({ outcome }) => outcome), ["STILL_UNKNOWN", "RECOVERED"]);
  assert.equal(result.recovered, 1);
  assert.equal(result.stillUnknown, 1);
  assert.equal(JSON.stringify(logs).includes("secret Provider payload"), false);
});

test("repeated one-shot run is idempotent when the first projection removes the candidate", async () => {
  const unresolved = candidate("bitget", "UNKNOWN", "bitget-25204", 1, "40");
  let current: readonly UnresolvedExecutionRecoveryCandidate[] = [unresolved];
  let reconcileCalls = 0;
  const logs = logger();
  const service = new ArbitrageStartupRecoveryService(
    { listUnresolvedExecutionReferencesForRecovery: () => current },
    {
      reconcileLeg: async () => {
        reconcileCalls += 1;
        current = [];
        return confirmation("CONFIRMED", "100");
      },
    } as any,
    logs.value,
  );

  const first = await service.runOnce();
  const replay = await service.runOnce();

  assert.equal(first.recovered, 1);
  assert.equal(replay.candidates, 0);
  assert.equal(reconcileCalls, 1);
  assert.equal(logs.infos.length, 2);
});

test("local no-record proof writes FAILED0 audit facts without calling Provider reconciliation", async () => {
  const claimed = candidate("binance", "CLAIMED", "local-proof", 1);
  let reconciliations = 0;
  const logs = logger();
  const service = new ArbitrageStartupRecoveryService(
    {
      listUnresolvedExecutionReferencesForRecovery: () => [claimed],
      terminalizeClaimedReferenceWithLocalNotDispatchedProof: () => ({
        executionReferences: [{
          executionIntentId: claimed.executionIntentId,
          status: "FAILED",
          confirmedQuantity: "0",
        }],
      } as never),
    },
    { reconcileLeg: async () => { reconciliations += 1; return confirmation("UNKNOWN", "0"); } } as never,
    logs.value,
    {
      evaluate: async () => ({
        result: "PROVEN_NOT_DISPATCHED",
        source: "LOCAL_PRE_DISPATCH_PROOF",
        reason: "LOCAL_NO_EXECUTION_RECORD",
        checkedAt: 123,
      }),
    },
  );

  const result = await service.runOnce([claimed]);

  assert.equal(reconciliations, 0);
  assert.equal(result.outcomes[0]?.newStatus, "FAILED");
  assert.equal(result.outcomes[0]?.newConfirmedQuantity, "0");
  assert.equal(result.outcomes[0]?.reason, "LOCAL_NO_EXECUTION_RECORD");
  const audit = JSON.stringify(logs.infos[0]);
  assert.match(audit, /LOCAL_PRE_DISPATCH_PROOF/u);
  assert.match(audit, /LOCAL_NO_EXECUTION_RECORD/u);
  assert.match(audit, /"providerMutationCount":0/u);
});

test("server freezes candidates before listen, then starts one-shot recovery and catches batch failure", () => {
  const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const discoveryAt = source.indexOf("arbitrageStartupRecovery.discoverCandidates()");
  const listenAt = source.indexOf("const server = app.listen");
  const recoveryAt = source.indexOf("arbitrageStartupRecovery.runOnce(startupRecoveryCandidates)", listenAt);
  assert.ok(discoveryAt >= 0);
  assert.ok(listenAt > discoveryAt);
  assert.ok(recoveryAt > listenAt);
  assert.match(source.slice(recoveryAt), /\.catch\(\(\) => \{/u);
  assert.match(source.slice(recoveryAt), /server remains online/u);
});

function candidate(
  venue: UnresolvedExecutionRecoveryCandidate["venue"],
  status: UnresolvedExecutionRecoveryCandidate["status"],
  executionIntentId: string,
  createdAt: number,
  confirmedQuantity = "0",
): UnresolvedExecutionRecoveryCandidate {
  return Object.freeze({
    userId: "user-a",
    arbitrageId: `arbitrage-${executionIntentId}`,
    legId: "long-leg",
    executionIntentId,
    executionRecordId: status === "CLAIMED" ? null : `record-${executionIntentId}`,
    status,
    phase: "OPENING",
    quantityEffect: "INCREASE",
    requestedQuantity: "100",
    confirmedQuantity,
    venue,
    accountId: `${venue}:account-a`,
    instrumentId: "DOGE-USDT-PERP",
    role: "LONG",
    createdAt,
    updatedAt: createdAt,
  });
}

function confirmation(status: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN", confirmedQuantity: string) {
  return {
    executionRecord: {
      executionId: "record-1",
      intentId: "intent-1",
      status,
      plannedQuantity: "100",
      confirmedQuantity,
      verifiedAt: 1,
    },
  } as any;
}

function logger() {
  const infos: unknown[] = [];
  const warnings: unknown[] = [];
  const value: StartupRecoveryLogger = {
    info: (message, facts) => { infos.push({ message, facts }); },
    warn: (message, facts) => { warnings.push({ message, facts }); },
  };
  return { value, infos, warnings };
}
