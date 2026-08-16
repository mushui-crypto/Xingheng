import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import {
  ExecutionMutationSafetyError,
  ExecutionMutationSafetyGuard,
} from "../cex/ExecutionMutationSafetyGuard";
import { OkxProviderError } from "./OkxClient";
import { InMemoryOkxExecutionOrderReferenceStore } from "./OkxExecutionOrderReferenceStore";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import { OkxIntentExecutionServiceRegistry } from "./OkxIntentExecutionServiceRegistry";
import { okxTestQuantityRulesSource } from "./OkxTestFixtures";
import type {
  OkxAccountIdentity,
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const expectedAccountId = "okx:provider-account-a";

test("matching OKX Provider UID identity allows a fake placeOrder mutation", async () => {
  const provider = new FakeOkxProviderClient(identity(expectedAccountId));
  const { runtime } = fixture(provider, "execution-identity-match");

  const result = await runtime.execute(intent());

  assert.equal(result.execution.status, "SUCCEEDED");
  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(provider.identityReads, 1);
  assert.equal(provider.placeMutations, 1);
  assert.deepEqual(provider.events, ["identity", "place"]);
});

test("closed mutation guard blocks OKX Provider identity reads and placeOrder", async () => {
  const provider = new FakeOkxProviderClient(identity(expectedAccountId));
  const { runtime } = fixture(provider, "execution-identity-guard-closed", false);

  const result = await runtime.execute(intent());

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(provider.identityReads, 0);
  assert.equal(provider.placeMutations, 0);
  assert.deepEqual(provider.events, []);
});

test("mismatched OKX Provider UID identity fails closed before placeOrder", async () => {
  const provider = new FakeOkxProviderClient(identity("okx:provider-account-b"));
  const { runtime, records } = fixture(provider, "execution-identity-mismatch");

  const result = await runtime.execute(intent());

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(records.updated.at(-1)?.status, "UNKNOWN");
  assert.equal(provider.identityReads, 1);
  assert.equal(provider.placeMutations, 0);
  assert.deepEqual(provider.events, ["identity"]);
});

test("OKX Provider identity query failure fails closed before placeOrder", async () => {
  const provider = new FakeOkxProviderClient(
    new OkxProviderError("provider_transport_error", "fake identity transport failure"),
  );
  const { runtime } = fixture(provider, "execution-identity-query-failure");

  const result = await runtime.execute(intent());

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(provider.identityReads, 1);
  assert.equal(provider.placeMutations, 0);
  assert.deepEqual(provider.events, ["identity"]);
});

test("invalid OKX API Key fails closed before placeOrder", async () => {
  const provider = new FakeOkxProviderClient(
    new OkxProviderError("credential_validation_failed", "fake invalid API Key", "50113"),
  );
  const { runtime } = fixture(provider, "execution-invalid-api-key");

  const result = await runtime.execute(intent());

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(provider.identityReads, 1);
  assert.equal(provider.placeMutations, 0);
  assert.deepEqual(provider.events, ["identity"]);
});

test("cancel revalidates OKX Provider UID before every fake mutation", async () => {
  const provider = new FakeOkxProviderClient(identity(expectedAccountId));
  const { runtime } = fixture(provider, "execution-cancel-identity");
  const executed = await runtime.execute(intent());
  assert.equal(executed.execution.status, "SUCCEEDED");

  provider.identityResult = identity("okx:provider-account-b");
  await assert.rejects(
    () => runtime.cancel("user-a", "execution-cancel-identity"),
    (error: unknown) => error instanceof ExecutionMutationSafetyError
      && error.category === "provider_identity_invalid",
  );
  assert.equal(provider.cancelMutations, 0);

  provider.identityResult = identity(expectedAccountId);
  const cancelled = await runtime.cancel("user-a", "execution-cancel-identity");

  assert.equal(cancelled.observation.state, "CANCEL_REQUESTED");
  assert.equal(provider.identityReads, 3);
  assert.equal(provider.placeMutations, 1);
  assert.equal(provider.cancelMutations, 1);
  assert.deepEqual(provider.events, ["identity", "place", "identity", "identity", "cancel"]);
});

function fixture(
  provider: FakeOkxProviderClient,
  executionId: string,
  liveTradingEnabled = true,
) {
  const records = new MemoryExecutionRecordStore();
  const registry = new OkxIntentExecutionServiceRegistry(new MemoryCredentialStore(), {
    clientFactory: () => provider,
  });
  const runtime = new OkxIntentExecutionRuntime(
    registry,
    records,
    new InMemoryOkxExecutionOrderReferenceStore(),
    {
      createExecutionId: () => executionId,
      clock: () => now,
      quantityRulesSource: okxTestQuantityRulesSource(now),
      mutationSafetyGuard: new ExecutionMutationSafetyGuard({
        liveTradingEnabled,
        killSwitchActive: false,
      }),
    },
  );
  return { runtime, records };
}

class FakeOkxProviderClient {
  identityReads = 0;
  placeMutations = 0;
  cancelMutations = 0;
  readonly events: string[] = [];

  constructor(public identityResult: OkxAccountIdentity | Error) {}

  async getAccountIdentity() {
    this.identityReads += 1;
    this.events.push("identity");
    if (this.identityResult instanceof Error) throw this.identityResult;
    return this.identityResult;
  }

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeMutations += 1;
    this.events.push("place");
    return {
      instId: request.instId,
      ordId: "9001",
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
      status: "PENDING_CONFIRMATION",
      statusReason: null,
      rawState: "live",
      requestedQuantity: "125",
      filledQuantity: "0",
      averagePrice: null,
      fee: "0",
      updatedAt: now,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelMutations += 1;
    this.events.push("cancel");
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
    };
  }
}

class MemoryCredentialStore {
  findSummary(userId: string, venue: "okx") {
    assert.equal(userId, "user-a");
    assert.equal(venue, "okx");
    return {
      userId,
      venue,
      accountId: expectedAccountId,
      accountFingerprint: "provider-account-a",
      maskedApiKey: "okx-...-key",
      environment: "test" as const,
      permissions: { trade: true, executionEnabled: true },
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async loadForExecution(userId: string, venue: "okx") {
    assert.equal(userId, "user-a");
    assert.equal(venue, "okx");
    return {
      apiKey: "fake-okx-api-key",
      apiSecret: "fake-okx-api-secret",
      passphrase: "fake-okx-passphrase",
    };
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore {
  readonly updated: ExecutionRecord[] = [];
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord) {
    this.records.set(key(record.userId, record.executionId), record);
  }

  update(record: ExecutionRecord) {
    this.updated.push(record);
    this.records.set(key(record.userId, record.executionId), record);
  }

  loadForUser(userId: string, executionId: string) {
    return this.records.get(key(userId, executionId)) ?? null;
  }
}

function intent() {
  return createExecutionIntent({
    intentId: "intent-okx-provider-identity",
    userId: "user-a",
    venue: "okx",
    accountId: expectedAccountId,
    instrumentId: "DOGE-USDT-PERP",
    side: "buy",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "12.5",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

function identity(accountId: string): OkxAccountIdentity {
  return {
    accountId,
    accountFingerprint: accountId.slice("okx:".length),
    uidHash: `${accountId.slice("okx:".length)}-uid-hash`,
    accountLevel: "3",
  };
}

function key(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}
