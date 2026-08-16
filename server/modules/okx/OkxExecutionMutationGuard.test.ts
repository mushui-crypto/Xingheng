import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionMutationSafetyGuard, ExecutionMutationSafetyError } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { OkxIntentExecutionService } from "./OkxIntentExecutionService";
import type { OkxCancelOrderRequest, OkxCancelOrderResult, OkxGetOrderRequest, OkxPlaceOrderRequest, OkxProviderOrder } from "./OkxTypes";

const now = 1_800_000_000_000;

test("LIVE=false blocks OKX placeOrder before fake provider mutation", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: false }),
  });

  await assert.rejects(() => service.execute(intent()), (error: unknown) =>
    error instanceof ExecutionMutationSafetyError && error.category === "live_trading_disabled");
  assert.equal(client.placeCalls, 0);
});

test("kill switch blocks OKX placeOrder before fake provider mutation", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: true }),
  });

  await assert.rejects(() => service.execute(intent()), (error: unknown) =>
    error instanceof ExecutionMutationSafetyError && error.category === "kill_switch_active");
  assert.equal(client.placeCalls, 0);
});

test("provider identity hook blocks OKX placeOrder before fake provider mutation", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({
      liveTradingEnabled: true,
      killSwitchActive: false,
      validateProviderIdentity: () => { throw new Error("OKX UID binding is not verified."); },
    }),
  });

  await assert.rejects(() => service.execute(intent()), (error: unknown) =>
    error instanceof ExecutionMutationSafetyError && error.category === "provider_identity_invalid");
  assert.equal(client.placeCalls, 0);
});

test("enabled gates allow OKX placeOrder and cancelOrder to reach a fake provider", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({
      liveTradingEnabled: true,
      killSwitchActive: false,
      validateProviderIdentity: (context) => {
        assert.equal(context.venue, "okx");
        assert.equal(context.providerInstrumentId, "DOGE-USDT-SWAP");
      },
    }),
  });
  const executionIntent = intent();

  await service.execute(executionIntent);
  await service.cancel({
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: "sxokxidentity000000000000000000",
  }, {
    userId: executionIntent.userId,
    accountId: executionIntent.accountId,
    instrumentId: executionIntent.instrumentId,
  });

  assert.equal(client.placeCalls, 1);
  assert.equal(client.cancelCalls, 1);
});

class FakeClient {
  placeCalls = 0;
  cancelCalls = 0;

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeCalls += 1;
    return { instId: request.instId, ordId: "9001", clOrdId: request.clOrdId };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelCalls += 1;
    return { instId: request.instId, ordId: request.ordId ?? "9001", clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000" };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
      status: "SUBMITTED",
      statusReason: null,
      rawState: "live",
      requestedQuantity: "12.5",
      filledQuantity: "0",
      averagePrice: null,
      fee: "0",
      updatedAt: now,
    };
  }
}

function intent() {
  return createExecutionIntent({
    intentId: "intent-okx-guard",
    userId: "user-1",
    venue: "okx",
    accountId: "okx:account-1",
    instrumentId: "DOGE-USDT-PERP",
    side: "buy",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "12.5" },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}
