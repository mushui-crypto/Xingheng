import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionMutationSafetyGuard,
  ExecutionMutationSafetyError,
  executionMutationSafetyConfigFromEnvironment,
} from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { OkxIntentExecutionService } from "./OkxIntentExecutionService";
import { okxTestQuantityRulesSource } from "./OkxTestFixtures";
import type { OkxCancelOrderRequest, OkxCancelOrderResult, OkxGetOrderRequest, OkxPlaceOrderRequest, OkxProviderOrder } from "./OkxTypes";

const now = 1_800_000_000_000;

test("LIVE=false blocks OKX placeOrder before fake provider mutation", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: false }),
  });

  await assert.rejects(() => service.execute(intent()), (error: unknown) =>
    error instanceof ExecutionMutationSafetyError && error.category === "live_trading_disabled");
  assert.equal(client.placeCalls, 0);
});

test("kill switch blocks OKX placeOrder before fake provider mutation", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: true }),
  });

  await assert.rejects(() => service.execute(intent()), (error: unknown) =>
    error instanceof ExecutionMutationSafetyError && error.category === "kill_switch_active");
  assert.equal(client.placeCalls, 0);
});

test("halted OKX allows only an internally classified DECREASE placeOrder", async () => {
  const client = new FakeClient();
  const guard = new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: true });
  const closing = new OkxIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
    mutationSafetyGuard: guard,
    mutationEffect: "DECREASE",
  });
  await closing.execute(createExecutionIntent({
    ...intent(),
    intentId: "intent-okx-close-halted",
    side: "sell",
    orderConstraints: { reduceOnly: true },
  }));
  assert.equal(client.placeCalls, 1);

  const ordinary = new OkxIntentExecutionService(new FakeClient(), {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
    mutationSafetyGuard: guard,
  });
  await assert.rejects(() => ordinary.execute(intent()), ExecutionMutationSafetyError);
});

test("provider identity hook blocks OKX placeOrder before fake provider mutation", async () => {
  const client = new FakeClient();
  const service = new OkxIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
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
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
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
    instrumentId: "DOGE-USDT-PERP",
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

test("unconfigured or closed OKX switches block placeOrder without inheriting open Binance switches", async (t) => {
  for (const fixture of [
    {
      name: "OKX switches unconfigured",
      environment: { LIVE_TRADING_ENABLED: "true", BINANCE_KILL_SWITCH: "false" },
    },
    {
      name: "OKX live disabled",
      environment: {
        LIVE_TRADING_ENABLED: "true",
        BINANCE_KILL_SWITCH: "false",
        OKX_LIVE_TRADING_ENABLED: "false",
        OKX_KILL_SWITCH: "false",
      },
    },
    {
      name: "OKX kill switch active",
      environment: {
        LIVE_TRADING_ENABLED: "true",
        BINANCE_KILL_SWITCH: "false",
        OKX_LIVE_TRADING_ENABLED: "true",
        OKX_KILL_SWITCH: "true",
      },
    },
  ] as const) {
    await t.test(fixture.name, async () => {
      const client = new FakeClient();
      const service = serviceWithEnvironment(client, fixture.environment);

      await assert.rejects(
        () => service.execute(intent()),
        (error: unknown) => error instanceof ExecutionMutationSafetyError
          && /OKX_(?:LIVE_TRADING_ENABLED|KILL_SWITCH)/u.test(error.message),
      );
      assert.equal(client.placeCalls, 0);
    });
  }
});

test("open OKX switches allow fake mutation regardless of Binance switch state", async (t) => {
  for (const binance of [
    { LIVE_TRADING_ENABLED: "false", BINANCE_KILL_SWITCH: "true" },
    { LIVE_TRADING_ENABLED: "true", BINANCE_KILL_SWITCH: "false" },
  ] as const) {
    await t.test(`Binance ${binance.LIVE_TRADING_ENABLED}/${binance.BINANCE_KILL_SWITCH}`, async () => {
      const client = new FakeClient();
      const service = serviceWithEnvironment(client, {
        ...binance,
        OKX_LIVE_TRADING_ENABLED: "true",
        OKX_KILL_SWITCH: "false",
      });

      await service.execute(intent());
      assert.equal(client.placeCalls, 1);
    });
  }
});

test("changing OKX switches does not change the Binance safety state", async () => {
  const context = {
    venue: "binance",
    operation: "placeOrder",
    userId: "user-1",
    accountId: "binance:account-1",
    instrumentId: "DOGE-USDT-PERP",
    providerInstrumentId: "DOGEUSDT",
  } as const;

  for (const binance of [
    {
      environment: { LIVE_TRADING_ENABLED: "true", BINANCE_KILL_SWITCH: "false" },
      allowed: true,
    },
    {
      environment: { LIVE_TRADING_ENABLED: "false", BINANCE_KILL_SWITCH: "true" },
      allowed: false,
    },
  ] as const) {
    for (const okx of [
      { OKX_LIVE_TRADING_ENABLED: "false", OKX_KILL_SWITCH: "true" },
      { OKX_LIVE_TRADING_ENABLED: "true", OKX_KILL_SWITCH: "false" },
    ] as const) {
      const guard = guardForEnvironment({ ...binance.environment, ...okx });
      assert.deepEqual(guard.status("binance"), {
        liveTradingEnabled: binance.allowed,
        killSwitchActive: !binance.allowed,
      });
      if (binance.allowed) {
        await guard.assertAllowed(context);
      } else {
        await assert.rejects(() => guard.assertAllowed(context), ExecutionMutationSafetyError);
      }
    }
  }
});

test("OKX known-order cancel remains allowed while halted and still validates identity", async () => {
  const executionIntent = intent();
  const lookup = {
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: "sxokxidentity000000000000000000",
  } as const;
  const context = {
    userId: executionIntent.userId,
    accountId: executionIntent.accountId,
    instrumentId: executionIntent.instrumentId,
  };
  const blockedClient = new FakeClient();
  const blocked = serviceWithEnvironment(blockedClient, {
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
    OKX_LIVE_TRADING_ENABLED: "true",
    OKX_KILL_SWITCH: "true",
  });

  await blocked.cancel(lookup, context);
  assert.equal(blockedClient.cancelCalls, 1);

  const allowedClient = new FakeClient();
  const allowed = serviceWithEnvironment(allowedClient, {
    LIVE_TRADING_ENABLED: "false",
    BINANCE_KILL_SWITCH: "true",
    OKX_LIVE_TRADING_ENABLED: "true",
    OKX_KILL_SWITCH: "false",
  });
  await allowed.cancel(lookup, context);
  assert.equal(allowedClient.cancelCalls, 1);

  const invalidClient = new FakeClient();
  const invalid = new OkxIntentExecutionService(invalidClient, {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({
      liveTradingEnabled: false,
      killSwitchActive: true,
      validateProviderIdentity: () => { throw new Error("wrong account"); },
    }),
  });
  await assert.rejects(() => invalid.cancel(lookup, context), (error: unknown) =>
    error instanceof ExecutionMutationSafetyError && error.category === "provider_identity_invalid");
  assert.equal(invalidClient.cancelCalls, 0);
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
    positionDirection: "LONG",
    side: "buy",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "12.5" },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

function serviceWithEnvironment(
  client: FakeClient,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return new OkxIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource: okxTestQuantityRulesSource(now),
    mutationSafetyGuard: guardForEnvironment(environment),
  });
}

function guardForEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  return new ExecutionMutationSafetyGuard(
    executionMutationSafetyConfigFromEnvironment(environment),
  );
}
