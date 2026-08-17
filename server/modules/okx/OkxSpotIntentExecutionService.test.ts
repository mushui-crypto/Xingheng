import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { OkxSpotExecutionCapability } from "./OkxSpotExecutionCapability";
import { OkxSpotIntentExecutionService } from "./OkxSpotIntentExecutionService";
import type { OkxCancelOrderRequest, OkxCancelOrderResult, OkxGetOrderRequest, OkxPlaceOrderRequest, OkxProviderOrder } from "./OkxTypes";

const now = 1_800_000_000_000;

function rules() {
  return { instType: "SPOT" as const, instId: "DOGE-USDT", baseCcy: "DOGE", quoteCcy: "USDT", lotSz: "0.1", minSz: "1", tickSz: "0.1", state: "live", fetchedAt: now };
}

test("Spot capability submits canonical base sz without an execution balance snapshot", async () => {
  const client = new FakeClient();
  const service = spotService(client);
  const accepted = await new OkxSpotExecutionCapability(service).execute(intent());

  assert.equal(client.placeCalls, 1);
  assert.deepEqual(client.placeRequests[0], {
    instId: "DOGE-USDT", tdMode: "cash", side: "buy", ordType: "market", quantity: "100",
    clOrdId: accepted.clientOrderId, targetCurrency: "base_ccy",
  });
  const observed = await service.query(lookup(accepted));
  assert.equal(observed.observation.state, "CONFIRMED");
  assert.equal(observed.observation.filledBaseQuantity, "100");
});

test("Spot mutation fails closed when recovery persistence is missing", async () => {
  const client = new FakeClient();
  const service = spotService(client, { persistRecoveryReference: undefined });

  await assert.rejects(
    () => service.execute(intent()),
    /recovery reference persistence is required/u,
  );
  assert.equal(client.placeCalls, 0);
});

test("Spot mutation fails closed when recovery anchor persistence fails", async () => {
  const client = new FakeClient();
  const service = spotService(client, {
    persistRecoveryReference: async () => { throw new Error("anchor store unavailable"); },
  });

  await assert.rejects(() => service.execute(intent()), /anchor store unavailable/u);
  assert.equal(client.placeCalls, 0);
});

test("Spot recovery anchor is persisted before Provider placeOrder", async () => {
  const events: string[] = [];
  let persisted: {
    instId: string;
    clOrdId: string;
    expectedProviderQuantity: string;
    expectedSide: "buy" | "sell";
  } | undefined;
  const client = new FakeClient();
  client.placeHook = () => events.push("place");
  const service = spotService(client, {
    persistRecoveryReference: async (reference) => {
      events.push("persist");
      persisted = reference;
    },
  });

  const accepted = await service.execute(intent());
  assert.deepEqual(events, ["persist", "place"]);
  assert.equal(persisted?.instId, "DOGE-USDT");
  assert.equal(persisted?.clOrdId, accepted.clientOrderId);
  assert.equal(persisted?.expectedProviderQuantity, "100");
  assert.equal(persisted?.expectedSide, "buy");
});

test("Spot invalid rules and a closed guard prevent Provider mutation", async () => {
  const unavailableClient = new FakeClient();
  await assert.rejects(
    () => spotService(unavailableClient, { quantityRulesSource: async () => null }).execute(intent()),
    /rules are unavailable/u,
  );
  assert.equal(unavailableClient.placeCalls, 0);

  const blockedClient = new FakeClient();
  await assert.rejects(
    () => spotService(blockedClient, { mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: true }) }).execute(intent()),
  );
  assert.equal(blockedClient.placeCalls, 0);
});

test("Spot accepts Decimal signed base and quote fees without using balance deltas", async () => {
  for (const scenario of [
    { side: "buy" as const, fee: "-0.2", feeCcy: "DOGE" },
    { side: "buy" as const, fee: "0.2", feeCcy: "USDT" },
    { side: "sell" as const, fee: "-0.2", feeCcy: "DOGE" },
    { side: "sell" as const, fee: "0.2", feeCcy: "USDT" },
    { side: "buy" as const, fee: "0", feeCcy: null },
  ]) {
    const client = new FakeClient();
    client.order = scenario;
    const service = spotService(client);
    const accepted = await service.execute(intent({ side: scenario.side }));
    assert.equal((await service.query(lookup(accepted))).observation.state, "CONFIRMED");
  }
});

test("Spot rejects malformed or unattributable fee evidence", async () => {
  for (const order of [
    { fee: "not-a-decimal", feeCcy: "USDT" },
    { fee: "-0.1", feeCcy: null },
    { fee: "-0.1", feeCcy: "OKB" },
  ]) {
    const client = new FakeClient();
    client.order = order;
    const service = spotService(client);
    const result = await service.query(lookup(await service.execute(intent())));
    assert.equal(result.observation.state, "UNKNOWN");
    assert.match(result.statusReason ?? "", /fee evidence/u);
  }
});

test("Spot accepts weighted and rounded average prices that are not on tickSz", async () => {
  for (const averagePrice of ["2.05", "2.050000"]) {
    const client = new FakeClient();
    client.order = { averagePrice };
    const service = spotService(client);
    assert.equal((await service.query(lookup(await service.execute(intent())))).observation.state, "CONFIRMED");
  }
});

test("Spot live and partial fills remain pending with their cumulative canonical quantity", async () => {
  for (const order of [
    { status: "SUBMITTED" as const, rawState: "live", filledQuantity: "0", averagePrice: null },
    { status: "PENDING_CONFIRMATION" as const, rawState: "partially_filled", filledQuantity: "40", averagePrice: "0.1", fee: "-0.08", feeCcy: "USDT" },
  ]) {
    const client = new FakeClient();
    client.order = order;
    const service = spotService(client);
    const result = await service.query(lookup(await service.execute(intent())));
    assert.equal(result.observation.state, "PENDING_CONFIRMATION");
    assert.equal(result.observation.filledBaseQuantity, order.filledQuantity);
  }
});

test("Spot completed partial fills and inconsistent order facts fail closed", async () => {
  for (const order of [
    { status: "CONFIRMED" as const, rawState: "filled", requestedQuantity: "40", filledQuantity: "40", averagePrice: "0.1" },
    { status: "CONFIRMED" as const, rawState: "filled", filledQuantity: "0", averagePrice: null },
    { status: "CONFIRMED" as const, rawState: "filled", filledQuantity: "100", averagePrice: null },
    { status: "PENDING_CONFIRMATION" as const, rawState: "partially_filled", filledQuantity: "40", averagePrice: null },
  ]) {
    const client = new FakeClient();
    client.order = order;
    const service = spotService(client);
    assert.equal((await service.query(lookup(await service.execute(intent())))).observation.state, "UNKNOWN");
  }
});

test("Spot canceled and rejected partial fills retain FAILED residual without repeat mutation", async () => {
  for (const rawState of ["canceled", "rejected"]) {
    const client = new FakeClient();
    client.order = { status: "FAILED", rawState, filledQuantity: "40", averagePrice: null };
    const service = spotService(client);
    const accepted = await service.execute(intent());
    const result = await service.query(lookup(accepted));
    assert.equal(result.observation.state, "FAILED");
    assert.equal(result.observation.filledBaseQuantity, "40");
    assert.equal(client.placeCalls, 1);
  }
});

test("Spot provider order identity mismatch is UNKNOWN", async () => {
  const client = new FakeClient();
  client.order = { clOrdId: "different-client-order" };
  const service = spotService(client);
  assert.equal((await service.query(lookup(await service.execute(intent())))).observation.state, "UNKNOWN");
});

test("Spot Provider side mismatch is UNKNOWN", async () => {
  const client = new FakeClient();
  client.order = { side: "sell" };
  const service = spotService(client);
  assert.equal((await service.query(lookup(await service.execute(intent({ side: "buy" }))))).observation.state, "UNKNOWN");
});

class FakeClient {
  placeCalls = 0;
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  order: Partial<OkxProviderOrder> = {};
  placeHook?: () => void;

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeCalls += 1;
    this.placeRequests.push(request);
    this.placeHook?.();
    return { instId: request.instId, ordId: "1001", clOrdId: request.clOrdId };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    return {
      instId: request.instId, ordId: request.ordId ?? "1001", clOrdId: request.clOrdId ?? "sxokxspot",
      side: "buy", status: "CONFIRMED", statusReason: null, rawState: "filled",
      requestedQuantity: "100", filledQuantity: "100", averagePrice: "0.1", fee: "0", feeCcy: null,
      updatedAt: now, ...this.order,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    return { instId: request.instId, ordId: request.ordId ?? "1001", clOrdId: request.clOrdId ?? "sxokxspot" };
  }
}

function intent(overrides: Partial<ReturnType<typeof createExecutionIntent>> = {}) {
  return createExecutionIntent({
    intentId: "okx-spot-intent", userId: "user-a", venue: "okx", accountId: "okx:account-a",
    instrumentId: "DOGE-USDT-SPOT", side: "buy",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "100" },
    orderConstraints: { reduceOnly: false }, executionMode: "EXECUTION_PRIORITY",
    createdAt: now, expiresAt: now + 60_000, ...overrides,
  });
}

function spotService(client: FakeClient, overrides: Partial<ConstructorParameters<typeof OkxSpotIntentExecutionService>[1]> = {}) {
  return new OkxSpotIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource: async () => rules(),
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false }),
    persistRecoveryReference: async () => {},
    ...overrides,
  });
}

function lookup(accepted: Awaited<ReturnType<OkxSpotIntentExecutionService["execute"]>>) {
  return {
    instrumentId: "DOGE-USDT-SPOT",
    instId: accepted.instId,
    ordId: accepted.providerOrderId,
    clOrdId: accepted.clientOrderId,
    expectedProviderQuantity: accepted.expectedProviderQuantity,
    expectedSide: accepted.expectedSide,
  };
}
