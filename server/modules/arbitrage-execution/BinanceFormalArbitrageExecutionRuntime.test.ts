import assert from "node:assert/strict";
import test from "node:test";
import { createAsset } from "../cex/Asset";
import { ExecutionPreMutationFailure } from "../cex/ExecutionCapability";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecordFromIntent, createExecutionRecord } from "../cex/ExecutionRecord";
import { assertExecutionIdentityContract, assertFormalResultContract } from "../cex/RuntimeLifecycleContractAssertions";
import { BinanceFormalArbitrageExecutionRuntime } from "./BinanceFormalArbitrageExecutionRuntime";

const now = 1_800_000_000_000;

test("formal adapter delegates and preserves the runtime's authoritative Decimal fill", async () => {
  const intent = executionIntent();
  let received = null;
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      received = value;
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-1", value),
          status: "CONFIRMED",
        }),
        execution: executionResult("0.001234567890123456789"),
      };
    },
  });
  const result = await adapter.execute(intent);
  assert.equal(received, intent);
  assert.equal(result.confirmedQuantity, "0.001234567890123456789");
  assert.equal(result.executionRecord.status, "CONFIRMED");
  assertExecutionIdentityContract(result.executionRecord, intent);
  assertFormalResultContract({ result, expectedQuantity: "0.001234567890123456789" });
});

test("partial and cancelled-with-partial production records retain exact Decimal fills", async () => {
  for (const [status, quantity] of [
    ["PENDING_CONFIRMATION", "0.000456789012345678"],
    ["FAILED", "0.000123456789012345"],
  ] as const) {
    const intent = executionIntent();
    const adapter = new BinanceFormalArbitrageExecutionRuntime({
      async cancel() { throw new Error("unused"); },
      async reconcile() { throw new Error("unused"); },
      async execute(value) {
        return {
          executionRecord: createExecutionRecord({
            ...createExecutionRecordFromIntent(`record-${status}`, value),
            status,
          }),
          execution: executionResult(quantity),
        };
      },
    });
    const result = await adapter.execute(intent);
    assert.equal(result.confirmedQuantity, quantity);
    assert.equal(result.executionRecord.status, status);
  }
});

test("unknown production results expose no fabricated confirmed quantity", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-unknown", value),
          status: "UNKNOWN",
        }),
        execution: executionResult(undefined),
      };
    },
  });
  const result = await adapter.execute(intent);
  assert.equal(result.confirmedQuantity, null);
  assert.equal(result.executionRecord.status, "UNKNOWN");
});

test("deterministic FAILED without a Provider attempt carries authoritative zero quantity", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-pre-mutation-failed", value),
          status: "FAILED",
        }),
        execution: {
          step: {
            status: "CALL_FAILED",
            result: null,
            error: new ExecutionPreMutationFailure("deterministic rejection"),
          },
        } as any,
      };
    },
  });

  const result = await adapter.execute(intent);

  assert.equal(result.confirmedQuantity, "0");
  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.mutationDisposition, "NOT_DISPATCHED");
});

test("FAILED without explicit pre-mutation proof does not fabricate zero quantity", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-unproven-failed", value),
          status: "FAILED",
        }),
        execution: executionResult(undefined),
      };
    },
  });

  const result = await adapter.execute(intent);

  assert.equal(result.confirmedQuantity, null);
  assert.equal(result.mutationDisposition, undefined);
});

test("maps a failed capability to a safe shared diagnostic without changing UNKNOWN semantics", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-diagnostic", value),
          status: "UNKNOWN",
        }),
        execution: {
          status: "CALL_FAILED",
          step: { status: "CALL_FAILED", result: null, error: Object.assign(
            new Error("authorization=secret-value provider_response_invalid"),
            { category: "provider_response_invalid" },
          ) },
        },
      } as any;
    },
  });
  const result = await adapter.execute(intent);
  assert.deepEqual(result.diagnostic, {
    category: "provider_response_invalid",
    stage: "execution-capability",
    errorType: "Error",
    sanitizedMessage: "authorization=[redacted]",
  });
  assert.equal(result.executionRecord.status, "UNKNOWN");
});

test("does not create a diagnostic for a successful capability result", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent("record-success", value), status: "CONFIRMED" }),
        execution: { status: "SUCCEEDED", step: { status: "SUCCEEDED", result: { confirmedQuantity: "1" } } },
      } as any;
    },
  });
  assert.equal((await adapter.execute(intent)).diagnostic, undefined);
});

test("reduces an unclassified Error to a generic safe diagnostic", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent("record-generic", value), status: "UNKNOWN" }),
        execution: { status: "CALL_FAILED", step: { status: "CALL_FAILED", result: null, error: new Error("secret=do-not-leak") } },
      } as any;
    },
  });
  const result = await adapter.execute(intent);
  assert.deepEqual(result.diagnostic, {
    category: "execution_failed",
    stage: "execution-capability",
    errorType: "Error",
    sanitizedMessage: "Execution capability failed.",
  });
});

test("does not trust an unknown provider category message", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent("record-unknown-category", value), status: "UNKNOWN" }),
        execution: {
          status: "CALL_FAILED",
          step: {
            status: "CALL_FAILED",
            result: null,
            error: Object.assign(new Error("untrusted payload secret=do-not-leak"), { category: "anything" }),
          },
        },
      } as any;
    },
  });
  const result = await adapter.execute(intent);
  assert.equal(result.diagnostic?.category, "anything");
  assert.equal(result.diagnostic?.sanitizedMessage, "Execution capability failed.");
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /untrusted|do-not-leak/u);
});

test("redacts multi-word, Bearer, quoted, and JSON credential values as whole fields", async () => {
  const messages = [
    'passphrase="top secret value"',
    "password='multi word value'",
    "secret = abc def ghi",
    "Authorization: Bearer abc.def.ghi",
    'authorization = "Bearer abc.def.ghi"',
    '{"apiKey":"key-value","secret":"secret value","passphrase":"pass phrase","authorization":"Bearer token.value"}',
  ];
  for (const [index, message] of messages.entries()) {
    const adapter = new BinanceFormalArbitrageExecutionRuntime({
      async cancel() { throw new Error("unused"); },
      async reconcile() { throw new Error("unused"); },
      async execute(value) {
        return {
          executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent(`record-sanitize-${index}`, value), status: "UNKNOWN" }),
          execution: { status: "CALL_FAILED", step: { status: "CALL_FAILED", result: null, error: Object.assign(new Error(message), { category: "provider_response_invalid" }) } },
        } as any;
      },
    });
    const diagnostic = (await adapter.execute(executionIntent())).diagnostic!;
    assert.doesNotMatch(diagnostic.sanitizedMessage, /top secret value|multi word value|abc def ghi|abc\.def\.ghi|key-value|secret value|pass phrase|token\.value/u);
  }
});

test("preserves ordinary non-sensitive diagnostic text", async () => {
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent("record-ordinary", value), status: "UNKNOWN" }),
        execution: {
          status: "CALL_FAILED",
          step: { status: "CALL_FAILED", result: null, error: Object.assign(new Error("provider response was invalid"), { category: "provider_response_invalid" }) },
        },
      } as any;
    },
  });
  assert.equal((await adapter.execute(executionIntent())).diagnostic?.sanitizedMessage, "provider response was invalid");
});

test("formal reconciliation maps authoritative Decimal observations and UNKNOWN to null", async () => {
  const record = createExecutionRecord({
    ...createExecutionRecordFromIntent("record-reconcile", executionIntent()),
    status: "PENDING_CONFIRMATION",
  });
  for (const observation of [
    { state: "CONFIRMED", filledBaseQuantity: "0.001234567890123456789", observedAt: now + 1 },
    { state: "PENDING_CONFIRMATION", filledBaseQuantity: "0.000456789012345678", observedAt: now + 2 },
    { state: "FAILED", filledBaseQuantity: "0.000123456789012345", observedAt: now + 3 },
    { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now + 4 },
  ] as const) {
    const adapter = new BinanceFormalArbitrageExecutionRuntime({
      async cancel() { throw new Error("unused"); },
      async execute() { throw new Error("unused"); },
      async reconcile(userId, executionId) {
        assert.equal(userId, "user-a");
        assert.equal(executionId, record.executionId);
        return { executionRecord: createExecutionRecord({ ...record, status: observation.state, updatedAt: observation.observedAt }), observation, terminalShortCircuit: false };
      },
    });
    const result = await adapter.reconcile("user-a", record.executionId);
    assert.equal(result.confirmedQuantity, observation.state === "UNKNOWN" ? null : observation.filledBaseQuantity);
    assert.equal(result.executionRecord.status, observation.state);
  }
});

test("formal cancel delegates without exposing provider-native fields", async () => {
  const intent = executionIntent();
  const executionRecord = createExecutionRecord({
    ...createExecutionRecordFromIntent("record-cancel", intent),
    status: "PENDING_CONFIRMATION",
  });
  const observation = { state: "CANCEL_REQUESTED" as const, observedAt: now + 1 };
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async execute() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async cancel(userId, executionId) {
      assert.equal(userId, intent.userId);
      assert.equal(executionId, executionRecord.executionId);
      return { executionRecord, observation };
    },
  });

  const result = await adapter.cancel(intent.userId, executionRecord.executionId);
  assert.deepEqual(result, { executionRecord, observation });
  assert.deepEqual(Object.keys(result).sort(), ["executionRecord", "observation"]);
});

function executionResult(confirmedQuantity: string | undefined) {
  return {
    step: {
      result: confirmedQuantity === undefined ? null : { confirmedQuantity },
    },
  } as any;
}

function executionIntent() {
  return createExecutionIntent({
    intentId: "intent-1",
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-a",
    instrumentId: "BTC-USDT-PERP",
    side: "buy",
    quantity: { asset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }), quantity: "0.00123456789" },
    orderConstraints: { reduceOnly: false },
    executionMode: "PRICE_PRIORITY",
    createdAt: now,
    expiresAt: now + 30_000,
  });
}
