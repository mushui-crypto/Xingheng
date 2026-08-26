import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  type OkxExecutionOrderReference,
} from "./OkxExecutionOrderReferenceStore";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import { okxClientOrderIdFor } from "./OkxIntentExecutionService";
import { mapOkxOrderStatus } from "./OkxClient";
import { okxTestQuantityRulesSource } from "./OkxTestFixtures";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const fakeMutationGuard = () => new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false });
const verificationOptions = (clock = now) => ({
  clock: () => clock,
  mutationSafetyGuard: fakeMutationGuard(),
  quantityRulesSource: okxTestQuantityRulesSource(clock),
});

test("verifies submit chain from ExecutionIntent through registry-backed OKX capability to ExecutionRecord", async () => {
  const service = new FakeOkxVerificationService("okx:account-user-a");
  const records = new FakeExecutionRecordStore();
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxVerificationRegistry(service),
    records,
    references,
    { ...verificationOptions(), createExecutionId: () => "execution-submit-okx" },
  );
  const intent = executionIntent();

  const result = await runtime.execute(intent);

  assert.equal(result.execution.intentId, "intent-submit-okx");
  assert.equal(result.execution.status, "SUCCEEDED");
  assert.equal(result.execution.step.stepId, "execution-capability");
  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.executionRecord.executionAttemptId, "intent-submit-okx");
  assert.equal(result.executionRecord.remoteOrderId, "9001");
  assert.deepEqual(records.created.map((record) => record.status), ["CREATED"]);
  assert.deepEqual(records.updated.map((record) => record.status), ["PENDING_CONFIRMATION"]);
  assert.deepEqual(service.placeRequests, [{
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "buy",
    ordType: "market",
    quantity: "125",
    clOrdId: okxClientOrderIdFor(intent),
    reduceOnly: false,
  }]);
  assert.deepEqual(await references.loadForUser("user-a", "execution-submit-okx"), {
    executionId: "execution-submit-okx",
    intentId: "intent-submit-okx",
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: okxClientOrderIdFor(intent),
    expectedProviderQuantity: "125",
    expectedSide: "buy",
    positionMode: "ONE_WAY",
    positionDirection: "LONG",
    createdAt: now,
    updatedAt: now,
  });
});

test("verifies query path maps OKX filled, partial, failed, and unknown states into ExecutionRecord", async (t) => {
  for (const fixture of [
    { rawState: "filled", expectedRecordState: "CONFIRMED", expectedFilled: "12.5", expectedReason: null },
    { rawState: "partially_filled", expectedRecordState: "PENDING_CONFIRMATION", expectedFilled: "1.2", expectedReason: null },
    { rawState: "rejected", expectedRecordState: "FAILED", expectedFilled: "0", expectedReason: null },
    { rawState: "mystery", expectedRecordState: "UNKNOWN", expectedFilled: "0", expectedReason: "unmapped OKX order state: mystery" },
  ] as const) {
    await t.test(fixture.rawState, async () => {
      const service = new FakeOkxVerificationService("okx:account-user-a");
      service.rawState = fixture.rawState;
      const records = new FakeExecutionRecordStore([executionRecord(fixture.rawState)]);
      const references = new InMemoryOkxExecutionOrderReferenceStore();
      references.create(orderReference(fixture.rawState));
      const runtime = new OkxIntentExecutionRuntime(
        new FakeOkxVerificationRegistry(service),
        records,
        references,
        verificationOptions(now + 1_000),
      );

      const result = await runtime.query("user-a", `execution-query-${fixture.rawState}`);

      assert.equal(result.executionRecord.status, fixture.expectedRecordState);
      assert.equal(result.observation.filledBaseQuantity, fixture.expectedFilled);
      assert.equal(result.statusReason, fixture.expectedReason);
      assert.deepEqual(service.getRequests, [{
        instId: "DOGE-USDT-SWAP",
        ordId: "9001",
        clOrdId: clientOrderIdForSuffix(fixture.rawState),
      }]);
    });
  }
});

test("verifies cancel path uses saved ordId, clOrdId, and instId without schema changes", async () => {
  const service = new FakeOkxVerificationService("okx:account-user-a");
  const records = new FakeExecutionRecordStore([executionRecord("cancel")]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.create(orderReference("cancel"));
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxVerificationRegistry(service),
    records,
    references,
    verificationOptions(now + 2_000),
  );

  const result = await runtime.cancel("user-a", "execution-query-cancel");

  assert.equal(result.observation.state, "CANCEL_REQUESTED");
  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(records.updated.at(-1)?.executionId, "execution-query-cancel");
  assert.deepEqual(service.cancelRequests, [{
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: clientOrderIdForSuffix("cancel"),
  }]);
});

test("verification test does not add production provider wiring", () => {
  const source = readFileSync(new URL("./OkxIntentExecutionRuntime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https:\/\/www\.okx\.com|fetch\(|new OkxClient|LIVE_TRADING_ENABLED|BINANCE_KILL_SWITCH/u);
});

class FakeOkxVerificationRegistry {
  readonly runUserIds: string[] = [];

  constructor(private readonly service: FakeOkxVerificationService) {}

  async run<T>(userId: string, operation: (service: FakeOkxVerificationService) => Promise<T> | T): Promise<T> {
    this.runUserIds.push(userId);
    return operation(this.service);
  }
}

class FakeOkxVerificationService {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  rawState = "live";

  constructor(private readonly accountId: string) {}

  executionAccountIdentity() {
    return { accountId: this.accountId };
  }

  validateExecutionProviderIdentity() {}

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return { instId: request.instId, ordId: "9001", clOrdId: request.clOrdId };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    const mapped = mapOkxOrderStatus(this.rawState);
    const filledQuantity = this.rawState === "filled"
      ? "125"
      : this.rawState === "partially_filled" ? "12" : "0";
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxmissing000000000000000000",
      status: mapped.status,
      statusReason: mapped.reason,
      rawState: this.rawState,
      requestedQuantity: "125",
      filledQuantity,
      averagePrice: filledQuantity === "0" ? null : "0.123",
      fee: "0",
      updatedAt: now + 500,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxmissing000000000000000000",
    };
  }
}

class FakeExecutionRecordStore implements ExecutionRecordStore {
  readonly created: ExecutionRecord[] = [];
  readonly updated: ExecutionRecord[] = [];
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(records: readonly ExecutionRecord[] = []) {
    for (const record of records) this.records.set(key(record.userId, record.executionId), record);
  }

  create(record: ExecutionRecord) {
    this.created.push(record);
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

function key(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}

function executionIntent() {
  return createExecutionIntent({
    intentId: "intent-submit-okx",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
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

function executionRecord(suffix: string) {
  return createExecutionRecord({
    executionId: `execution-query-${suffix}`,
    intentId: `intent-query-${suffix}`,
    executionAttemptId: `intent-query-${suffix}`,
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

function orderReference(suffix: string): OkxExecutionOrderReference {
  return {
    executionId: `execution-query-${suffix}`,
    intentId: `intent-query-${suffix}`,
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: clientOrderIdForSuffix(suffix),
    createdAt: now,
    updatedAt: now,
  };
}

function clientOrderIdForSuffix(suffix: string) {
  return `sxokx${suffix.replace(/_/gu, "").slice(0, 15)}`.padEnd(32, "0");
}
