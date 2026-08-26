import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ExecutionMutationSafetyError,
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
} from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { OkxIntentCancellationCapability } from "./OkxIntentCancellationCapability";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  type OkxExecutionOrderReference,
} from "./OkxExecutionOrderReferenceStore";
import { OkxFormalArbitrageExecutionRuntime } from "./OkxFormalArbitrageExecutionRuntime";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;

test("OKX formal cancel traverses the runtime and OKX capability before provider mutation", async () => {
  const provider = new FakeOkxCancellationService();
  let capabilityCreations = 0;
  const { runtime, records } = fixture(provider, {
    createCancelCapability(service, reference) {
      capabilityCreations += 1;
      return new OkxIntentCancellationCapability(service, reference);
    },
  });
  const formalRuntime = new OkxFormalArbitrageExecutionRuntime(runtime);

  const result = await formalRuntime.cancel("user-a", "execution-okx-cancel");

  assert.equal(capabilityCreations, 1);
  assert.equal(result.observation.state, "CANCEL_REQUESTED");
  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(records.updated.length, 1);
  assert.equal(provider.identityValidations, 1);
  assert.equal(provider.cancelMutations, 1);
  assert.deepEqual(provider.cancelRequests, [{
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: "sxokxformalcancel00000000000001",
  }]);
  assert.deepEqual(Object.keys(result).sort(), ["executionRecord", "observation"]);
  assert.equal(JSON.stringify(result).includes("ordId"), false);
  assert.equal(JSON.stringify(result).includes("instId"), false);
});

test("OKX provider cancel failure does not fabricate a successful local state", async () => {
  const provider = new FakeOkxCancellationService();
  provider.cancelError = new Error("fake OKX cancel transport failure");
  const { runtime, records } = fixture(provider);

  await assert.rejects(
    () => runtime.cancel("user-a", "execution-okx-cancel"),
    /fake OKX cancel transport failure/u,
  );

  assert.equal(provider.identityValidations, 1);
  assert.equal(provider.cancelMutations, 1);
  assert.equal(records.updated.length, 0);
  assert.equal(records.current().status, "PENDING_CONFIRMATION");
});

test("OKX provider identity failure blocks cancel mutation", async () => {
  const provider = new FakeOkxCancellationService();
  provider.identityError = new Error("fake OKX identity mismatch");
  const { runtime, records } = fixture(provider);

  await assert.rejects(
    () => runtime.cancel("user-a", "execution-okx-cancel"),
    (error: unknown) => error instanceof ExecutionMutationSafetyError
      && error.category === "provider_identity_invalid",
  );

  assert.equal(provider.identityValidations, 1);
  assert.equal(provider.cancelMutations, 0);
  assert.equal(records.updated.length, 0);
});

test("closed OKX safety switches still allow known-order cancel after identity validation", async () => {
  const provider = new FakeOkxCancellationService();
  const { runtime, records } = fixture(provider, {
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({
      liveTradingEnabled: false,
      killSwitchActive: true,
    }),
  });

  await runtime.cancel("user-a", "execution-okx-cancel");

  assert.equal(provider.identityValidations, 1);
  assert.equal(provider.cancelMutations, 1);
  assert.equal(records.updated.length, 1);
});

test("missing or mismatched OKX order references block cancel mutation", async (context) => {
  await context.test("missing complete reference", async () => {
    const provider = new FakeOkxCancellationService();
    const { runtime, records } = fixture(provider, {}, false);

    await assert.rejects(
      () => runtime.cancel("user-a", "execution-okx-cancel"),
      /order reference is missing/u,
    );
    assert.equal(provider.identityValidations, 0);
    assert.equal(provider.cancelMutations, 0);
    assert.equal(records.updated.length, 0);
  });

  await context.test("reference identity mismatch", async () => {
    const provider = new FakeOkxCancellationService();
    const references = new InMemoryOkxExecutionOrderReferenceStore();
    references.create(orderReference({ intentId: "intent-other" }));
    const { runtime, records } = fixture(provider, {}, references);

    await assert.rejects(
      () => runtime.cancel("user-a", "execution-okx-cancel"),
      /does not match the ExecutionRecord/u,
    );
    assert.equal(provider.identityValidations, 0);
    assert.equal(provider.cancelMutations, 0);
    assert.equal(records.updated.length, 0);
  });
});

test("OKX formal and runtime layers contain no direct provider cancel transport", () => {
  const formalSource = readFileSync(
    new URL("./OkxFormalArbitrageExecutionRuntime.ts", import.meta.url),
    "utf8",
  );
  const runtimeSource = readFileSync(new URL("./OkxIntentExecutionRuntime.ts", import.meta.url), "utf8");
  const capabilitySource = readFileSync(
    new URL("./OkxIntentCancellationCapability.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(formalSource, /OkxClient|cancelOrder|\.service\.cancel/u);
  assert.doesNotMatch(runtimeSource, /cancelOrder|service\.cancel/u);
  assert.match(capabilitySource, /service\.cancel/u);
});

function fixture(
  provider: FakeOkxCancellationService,
  options: ConstructorParameters<typeof OkxIntentExecutionRuntime>[3] = {},
  referenceInput: InMemoryOkxExecutionOrderReferenceStore | boolean = true,
) {
  const records = new MemoryExecutionRecordStore(executionRecord());
  const references = referenceInput instanceof InMemoryOkxExecutionOrderReferenceStore
    ? referenceInput
    : new InMemoryOkxExecutionOrderReferenceStore();
  if (referenceInput === true) references.create(orderReference());
  const runtime = new OkxIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    references,
    {
      clock: () => now + 1,
      mutationSafetyGuard: new ExecutionMutationSafetyGuard({
        liveTradingEnabled: true,
        killSwitchActive: false,
      }),
      ...options,
    },
  );
  return { runtime, records };
}

class FakeOkxCancellationService {
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  identityValidations = 0;
  identityError: Error | null = null;
  cancelError: Error | null = null;

  get cancelMutations() {
    return this.cancelRequests.length;
  }

  executionAccountIdentity() {
    return { accountId: "okx:account-user-a" };
  }

  validateExecutionProviderIdentity(_context: ExecutionMutationContext) {
    this.identityValidations += 1;
    if (this.identityError) throw this.identityError;
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    if (this.cancelError) throw this.cancelError;
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxformalcancel00000000000001",
    };
  }

  async placeOrder(_request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    throw new Error("unused fake placeOrder");
  }

  async getOrder(_request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    throw new Error("unused fake getOrder");
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore {
  readonly updated: ExecutionRecord[] = [];
  private record: ExecutionRecord;

  constructor(record: ExecutionRecord) {
    this.record = record;
  }

  create(record: ExecutionRecord) {
    this.record = record;
  }

  update(record: ExecutionRecord) {
    this.updated.push(record);
    this.record = record;
  }

  loadForUser(userId: string, executionId: string) {
    return this.record.userId === userId && this.record.executionId === executionId
      ? this.record
      : null;
  }

  current() {
    return this.record;
  }
}

function executionRecord(): ExecutionRecord {
  return createExecutionRecord({
    executionId: "execution-okx-cancel",
    intentId: "intent-okx-cancel",
    executionAttemptId: "intent-okx-cancel",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    remoteOrderId: "9001",
    createdAt: now,
    updatedAt: now,
  });
}

function orderReference(
  overrides: Partial<OkxExecutionOrderReference> = {},
): OkxExecutionOrderReference {
  return {
    executionId: "execution-okx-cancel",
    intentId: "intent-okx-cancel",
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: "sxokxformalcancel00000000000001",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
