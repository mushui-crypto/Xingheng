import assert from "node:assert/strict";
import test from "node:test";
import { OkxIntentExecutionService, okxClientOrderIdFor } from "./OkxIntentExecutionService";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPerpetualPosition,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const testMutationGuard = () => new ExecutionMutationSafetyGuard({
  liveTradingEnabled: true,
  killSwitchActive: false,
});

test("submits an OKX open long as a market buy on the venue instrument", async () => {
  const client = new FakeOkxExecutionClient();
  const service = new OkxIntentExecutionService(client, { clock: () => now, mutationSafetyGuard: testMutationGuard() });
  const intent = executionIntent({ side: "buy" });

  const result = await service.execute(intent);

  assert.equal(result.state, "SUBMITTED");
  assert.equal(result.confirmedQuantity, "0");
  assert.equal(result.providerOrderId, "7001");
  assert.equal(result.clientOrderId, okxClientOrderIdFor(intent));
  assert.deepEqual(result.orderIdentity, {
    instId: "DOGE-USDT-SWAP",
    ordId: "7001",
    clOrdId: okxClientOrderIdFor(intent),
  });
  assert.deepEqual(client.placeRequests, [{
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "buy",
    ordType: "market",
    quantity: "12.5",
    clOrdId: okxClientOrderIdFor(intent),
    reduceOnly: false,
  }]);
});

test("submits an OKX open short as a market sell", async () => {
  const client = new FakeOkxExecutionClient();
  const intent = executionIntent({ side: "sell", intentId: "intent-short-1" });

  await new OkxIntentExecutionService(client, { mutationSafetyGuard: testMutationGuard() }).execute(intent);

  assert.equal(client.placeRequests[0]?.side, "sell");
  assert.equal(client.placeRequests[0]?.reduceOnly, false);
  assert.equal(client.placeRequests[0]?.instId, "DOGE-USDT-SWAP");
});

test("perpetual close preserves reduceOnly=true at the OKX order boundary", async () => {
  const client = new FakeOkxExecutionClient();
  const intent = executionIntent({
    intentId: "intent-close-1",
    side: "sell",
    orderConstraints: { reduceOnly: true },
  });

  await new OkxIntentExecutionService(client, { mutationSafetyGuard: testMutationGuard() }).execute(intent);

  assert.equal(client.placeRequests[0]?.reduceOnly, true);
  assert.equal(client.placeRequests[0]?.ordType, "market");
});

test("queries map OKX order states and preserve UNKNOWN reason", async () => {
  const client = new FakeOkxExecutionClient();
  const service = new OkxIntentExecutionService(client, { clock: () => now, mutationSafetyGuard: testMutationGuard() });

  for (const fixture of [
    { rawState: "filled", expected: "CONFIRMED", reason: null },
    { rawState: "live", expected: "PENDING_CONFIRMATION", reason: null },
    { rawState: "partially_filled", expected: "PENDING_CONFIRMATION", reason: null },
    { rawState: "cancelled", expected: "FAILED", reason: null },
    { rawState: "rejected", expected: "FAILED", reason: null },
    { rawState: "mystery", expected: "UNKNOWN", reason: "unmapped OKX order state: mystery" },
  ] as const) {
    client.orderState = fixture.rawState;
    const result = await service.query({
      instId: "DOGE-USDT-SWAP",
      ordId: "7001",
      clOrdId: "sxokxidentity000000000000000000",
    });
    assert.equal(result.observation.state, fixture.expected);
    assert.equal(result.statusReason, fixture.reason);
    assert.equal(result.orderIdentity.ordId, "7001");
    assert.equal(result.orderIdentity.clOrdId, "sxokxidentity000000000000000000");
    assert.equal(result.orderIdentity.instId, "DOGE-USDT-SWAP");
  }
});

test("rejects unsupported instruments before provider mutation", async () => {
  const client = new FakeOkxExecutionClient();

  await assert.rejects(
    () => new OkxIntentExecutionService(client, { mutationSafetyGuard: testMutationGuard() }).execute(executionIntent({
      instrumentId: "BTC-USDT-PERP",
      quantity: { asset: { symbol: "BTC", type: "DIGITAL_ASSET" }, quantity: "0.01" },
    })),
    /Unsupported OKX instrument/u,
  );
  assert.equal(client.placeRequests.length, 0);
});

class FakeOkxExecutionClient {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  orderState = "filled";

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return {
      instId: request.instId,
      ordId: "7001",
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "7001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
      status: this.orderState === "filled"
        ? "CONFIRMED"
        : this.orderState === "live"
          ? "SUBMITTED"
          : this.orderState === "partially_filled"
            ? "PENDING_CONFIRMATION"
            : this.orderState === "cancelled" || this.orderState === "rejected"
              ? "FAILED"
              : "UNKNOWN",
      statusReason: this.orderState === "mystery" ? "unmapped OKX order state: mystery" : null,
      rawState: this.orderState,
      requestedQuantity: "12.5",
      filledQuantity: this.orderState === "filled" ? "12.5" : "1.25",
      averagePrice: "0.123",
      fee: "-0.001",
      updatedAt: now + 100,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "7001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
    };
  }

  async getPosition(_instId: string): Promise<readonly OkxPerpetualPosition[]> {
    return [];
  }
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-okx-1",
    userId: "user-1",
    venue: "okx",
    accountId: "okx:account-1",
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
    ...overrides,
  });
}
