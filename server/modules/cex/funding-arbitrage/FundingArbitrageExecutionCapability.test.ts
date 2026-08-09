import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  FundingArbitrageExecutionCapability,
  FundingArbitrageSubmitLegRequest,
} from "./FundingArbitrageExecutionCapability";

test("the capability expresses both legs using canonical execution inputs", async () => {
  const submitted: FundingArbitrageSubmitLegRequest[] = [];
  const capability = fixtureCapability(submitted);
  const requests: readonly [FundingArbitrageSubmitLegRequest, FundingArbitrageSubmitLegRequest] = [
    {
      executionId: "execution-1",
      executionAttemptId: "attempt-long-1",
      legId: "leg-long",
      role: "long",
      venue: "binance",
      instrumentId: "binance:perpetual:linear:BTC:USDT:USDT",
      marketType: "perpetual",
      targetDeltaBaseQuantity: "0.12",
    },
    {
      executionId: "execution-1",
      executionAttemptId: "attempt-short-1",
      legId: "leg-short",
      role: "short",
      venue: "okx",
      instrumentId: "okx:perpetual:linear:BTC:USDT:USDT",
      marketType: "perpetual",
      targetDeltaBaseQuantity: "0.12000000",
    },
  ];

  const attempts = await Promise.all(requests.map((request) => capability.submitLeg(request)));
  assert.deepEqual(submitted, requests);
  assert.equal(attempts.length, 2);
  assert.deepEqual(Object.keys(attempts[0]!), ["executionAttemptId"]);
  assert.equal(attempts[0]!.executionAttemptId, requests[0].executionAttemptId);
  assert.equal(attempts[1]!.executionAttemptId, requests[1].executionAttemptId);
  assert.equal(typeof requests[0].targetDeltaBaseQuantity, "string");
  assert.equal(typeof requests[1].targetDeltaBaseQuantity, "string");
});

test("the caller supplies attempt identity before submit and repeated submits preserve it", async () => {
  const submitted: FundingArbitrageSubmitLegRequest[] = [];
  const capability = fixtureCapability(submitted);
  const request: FundingArbitrageSubmitLegRequest = {
    executionId: "execution-repeat",
    executionAttemptId: "attempt-fixed-before-submit",
    legId: "leg-long",
    role: "long",
    venue: "binance",
    instrumentId: "binance:perpetual:linear:BTC:USDT:USDT",
    marketType: "perpetual",
    targetDeltaBaseQuantity: "0.12",
  };

  const first = await capability.submitLeg(request);
  const second = await capability.submitLeg(request);
  assert.equal(first.executionAttemptId, request.executionAttemptId);
  assert.equal(second.executionAttemptId, request.executionAttemptId);
  assert.deepEqual(submitted, [request, request]);
});

test("submit, query, cancel, and reconcile capability methods exist", async () => {
  const capability = fixtureCapability([]);
  assert.equal(typeof capability.submitLeg, "function");
  assert.equal(typeof capability.queryLegState, "function");
  assert.equal(typeof capability.cancelLeg, "function");
  assert.equal(typeof capability.reconcileLeg, "function");

  const reference = { executionId: "execution-1", legId: "leg-long", executionAttemptId: "attempt-1" };
  const queried = await capability.queryLegState(reference);
  const canceled = await capability.cancelLeg(reference);
  const reconciled = await capability.reconcileLeg(reference);
  assert.equal(queried.observation, "OPEN");
  assert.equal(canceled.result, "CANCEL_REQUESTED");
  assert.equal(reconciled.observation, "FILLED");
});

test("the capability source contains no execution implementation fields or dependencies", () => {
  const source = readFileSync(
    new URL("./FundingArbitrageExecutionCapability.ts", import.meta.url),
    "utf8",
  );
  const forbiddenFields = [
    "apiKey",
    "credential",
    "accountId",
    "clientOrderId",
    "providerSymbol",
    "endpoint",
    "httpRequest",
    "signature",
    "orderType",
    "price",
    "slippage",
  ];
  for (const field of forbiddenFields) assert.doesNotMatch(source, new RegExp(field, "iu"));
  assert.doesNotMatch(source, /randomUUID|createHash/u);

  const importPaths = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(importPaths, [
    "../CexCanonicalModels",
    "./FundingArbitrageExecutionState",
  ]);
});

test("the coordinator remains independent of concrete venues and the capability", () => {
  const source = readFileSync(
    new URL("./FundingArbitrageExecutionCoordinator.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /binance|okx|bitget|bybit/iu);
  assert.doesNotMatch(source, /FundingArbitrageExecutionCapability/u);
});

function fixtureCapability(
  submitted: FundingArbitrageSubmitLegRequest[],
): FundingArbitrageExecutionCapability {
  return {
    async submitLeg(request) {
      submitted.push(request);
      return { executionAttemptId: request.executionAttemptId };
    },
    async queryLegState(request) {
      return {
        executionAttemptId: request.executionAttemptId,
        observation: "OPEN",
        confirmedExecutedQuantity: "0.05",
        observedAt: 1_800_000_000_001,
      };
    },
    async cancelLeg(request) {
      return {
        executionAttemptId: request.executionAttemptId,
        result: "CANCEL_REQUESTED",
        observedAt: 1_800_000_000_002,
      };
    },
    async reconcileLeg(request) {
      return {
        executionAttemptId: request.executionAttemptId,
        observation: "FILLED",
        confirmedExecutedQuantity: "0.12",
        observedAt: 1_800_000_000_003,
      };
    },
  };
}
