import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExecutionCapabilityRegistry, executionCapability } from "../cex/ExecutionCapabilityRegistry";
import { createTradingRules } from "../cex/TradingRules";
import type { TradingRulesAdapter } from "../cex/TradingRulesAdapter";
import { OkxIntentExecutionCapability } from "./OkxIntentExecutionCapability";
import {
  OkxRealExecutionTestPreparation,
  type OkxRealExecutionReadinessSource,
} from "./OkxRealExecutionTestPreparation";
import type {
  OkxAccountIdentity,
  OkxPerpetualPosition,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;

test("prepares the three OKX real execution validation scenarios without provider mutation", async () => {
  const fakeCapability = new FakeOkxExecutionService();
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("okx", new OkxIntentExecutionCapability(fakeCapability)));
  const readiness = new FakeReadinessSource();
  const service = new OkxRealExecutionTestPreparation(
    registry,
    readiness,
    new FakeTradingRules(),
    {
      now: () => now,
      createIntentId: (scenarioId, role) => `intent-${scenarioId}-${role}`,
      createExecutionId: (scenarioId, role) => `execution-${scenarioId}-${role}`,
    },
  );

  const result = await service.prepare({
    userId: "user-a",
    accountId: "okx:account-user-a",
  });

  assert.deepEqual(result.executionPath, [
    "ExecutionIntent",
    "ExecutionCoordinator",
    "ExecutionCapabilityRegistry",
    "OKX ExecutionCapability",
    "ExecutionRecord",
  ]);
  assert.equal(result.providerMutations, 0);
  assert.equal(result.authorization, "PENDING_MANUAL_AUTHORIZATION");
  assert.equal(result.accountReadiness.credentialBinding, "PASS");
  assert.equal(result.scenarios.length, 3);
  assert.deepEqual(result.scenarios.map((scenario) => scenario.scenarioId), [
    "OKX_SPOT_BUY_PERP_SHORT",
    "OKX_PERP_LONG",
    "OKX_PERP_SHORT",
  ]);

  const spotPerp = result.scenarios[0]!;
  assert.equal(spotPerp.status, "BLOCKED_PRECONDITION_FAILED");
  assert.deepEqual(spotPerp.blockers, [
    "SPOT_BUY: BLOCKED_UNSUPPORTED_OKX_SPOT_EXECUTION_CAPABILITY",
  ]);
  assert.equal(spotPerp.legs[0]!.canonicalInstrumentId, "DOGE-USDT-SPOT");
  assert.equal(spotPerp.legs[0]!.venueInstrument.instId, "DOGE-USDT");
  assert.equal(spotPerp.legs[0]!.quantityPlan.plannedVenueQuantity, undefined);
  assert.equal(spotPerp.legs[0]!.intentDraft.instrumentId, "DOGE-USDT-SPOT");
  assert.equal(spotPerp.legs[0]!.closeIntentDraft, null);
  assert.equal(spotPerp.legs[1]!.canonicalInstrumentId, "DOGE-USDT-PERP");
  assert.equal(spotPerp.legs[1]!.venueInstrument.instId, "DOGE-USDT-SWAP");
  assert.equal(spotPerp.legs[1]!.intentDraft.side, "sell");
  assert.equal(spotPerp.legs[1]!.intentDraft.orderConstraints.reduceOnly, false);
  assert.equal(spotPerp.legs[1]!.closeIntentDraft?.side, "buy");
  assert.equal(spotPerp.legs[1]!.closeIntentDraft?.orderConstraints.reduceOnly, true);
  assert.equal(spotPerp.legs[1]!.executionRecordDraft.status, "CREATED");
  assert.equal(spotPerp.legs[1]!.closeExecutionRecordDraft?.status, "CREATED");

  const perpLong = result.scenarios[1]!;
  assert.equal(perpLong.status, "READY_FOR_MANUAL_AUTHORIZATION");
  assert.equal(perpLong.legs[0]!.intentDraft.side, "buy");
  assert.equal(perpLong.legs[0]!.closeIntentDraft?.side, "sell");

  const perpShort = result.scenarios[2]!;
  assert.equal(perpShort.status, "READY_FOR_MANUAL_AUTHORIZATION");
  assert.equal(perpShort.legs[0]!.intentDraft.side, "sell");
  assert.equal(perpShort.legs[0]!.closeIntentDraft?.side, "buy");

  for (const scenario of result.scenarios) {
    for (const leg of scenario.legs) {
      assert.equal(leg.intentDraft.venue, "okx");
      assert.equal(leg.executionRecordDraft.venue, "okx");
      assert.equal(leg.quantityPlan.plannedAssetQuantity.quantity.includes("e"), false);
      assert.equal(typeof leg.quantityPlan.estimatedNotionalUsdt, "string");
    }
  }
  assert.deepEqual(readiness.accountCalls, [{ userId: "user-a", accountId: "okx:account-user-a" }]);
  assert.equal(readiness.providerMutations, 0);
  assert.equal(fakeCapability.executeCalls.length, 0);
});

test("preparation fails closed when open orders exist for a planned leg", async () => {
  const readiness = new FakeReadinessSource({
    openOrders: [order("DOGE-USDT-SWAP")],
  });
  const service = new OkxRealExecutionTestPreparation(
    okxRegistry(),
    readiness,
    new FakeTradingRules(),
    { now: () => now },
  );

  const result = await service.prepare({
    userId: "user-a",
    accountId: "okx:account-user-a",
    scenarios: [{
      scenarioId: "OKX_PERP_SHORT",
      legs: [{
        role: "PERPETUAL_SHORT",
        instrumentId: "DOGE-USDT-PERP",
        side: "sell",
        quantityInput: { mode: "ASSET_QUANTITY", quantity: "10" },
        quote: { bid: "0.1", ask: "0.11", fetchedAt: now },
      }],
    }],
  });

  assert.equal(result.scenarios[0]!.status, "BLOCKED_PRECONDITION_FAILED");
  assert.deepEqual(result.scenarios[0]!.blockers, [
    "PERPETUAL_SHORT: BLOCKED_OPEN_ORDERS_PRESENT",
  ]);
  assert.equal(result.providerMutations, 0);
  assert.equal(readiness.providerMutations, 0);
});

test("preparation requires OKX capability registry lookup and preserves read-only source boundaries", async () => {
  const service = new OkxRealExecutionTestPreparation(
    new ExecutionCapabilityRegistry(),
    new FakeReadinessSource(),
    new FakeTradingRules(),
    { now: () => now },
  );

  await assert.rejects(
    () => service.prepare({ userId: "user-a", accountId: "okx:account-user-a" }),
    /Execution capability is not registered for venue: okx/u,
  );

  const source = readFileSync(new URL("./OkxRealExecutionTestPreparation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.\.\/binance|placeOrder|cancelOrder|close\(|LIVE_TRADING_ENABLED|BINANCE_KILL_SWITCH/u);
});

function okxRegistry() {
  return new ExecutionCapabilityRegistry()
    .register(executionCapability("okx", new OkxIntentExecutionCapability(new FakeOkxExecutionService())));
}

class FakeOkxExecutionService {
  readonly executeCalls: unknown[] = [];

  async execute(input: unknown) {
    this.executeCalls.push(input);
    return {
      executionAttemptId: "must-not-be-called",
      state: "SUBMITTED" as const,
    };
  }
}

class FakeTradingRules implements Pick<TradingRulesAdapter, "getTradingRules"> {
  readonly calls: string[] = [];

  async getTradingRules(instrument: Parameters<TradingRulesAdapter["getTradingRules"]>[0]) {
    this.calls.push(instrument.instId);
    if (instrument.category === "spot") {
      return createTradingRules({
        quantityStep: "0.1",
        minQuantity: "0.1",
        priceTick: "0.0001",
        minNotional: "1",
        precision: {},
      });
    }
    return createTradingRules({
      quantityStep: "1",
      minQuantity: "1",
      priceTick: "0.0001",
      minNotional: "1",
      contractSize: "1",
      precision: {},
    });
  }
}

class FakeReadinessSource implements OkxRealExecutionReadinessSource {
  readonly accountCalls: Array<{ userId: string; accountId: string }> = [];
  readonly openOrderCalls: Array<{ userId: string; accountId: string; instId: string }> = [];
  readonly positionCalls: Array<{ userId: string; accountId: string; instId: string }> = [];
  readonly providerMutations = 0;
  private readonly openOrders: readonly OkxProviderOrder[];

  constructor(options: Readonly<{ openOrders?: readonly OkxProviderOrder[] }> = {}) {
    this.openOrders = options.openOrders ?? [];
  }

  async verifyAccount(input: { userId: string; accountId: string }) {
    this.accountCalls.push(input);
    return {
      credentialBinding: "PASS" as const,
      accountIdentity: "PASS" as const,
      account: account(input.accountId),
      providerMutations: 0 as const,
    };
  }

  async readOpenOrders(input: { userId: string; accountId: string; instId: string }) {
    this.openOrderCalls.push(input);
    return this.openOrders.filter((value) => value.instId === input.instId);
  }

  async readPositions(input: { userId: string; accountId: string; instId: string }) {
    this.positionCalls.push(input);
    return [position(input.instId)];
  }
}

function account(accountId: string): OkxAccountIdentity {
  return {
    accountId,
    accountFingerprint: accountId.slice("okx:".length),
    uidHash: `${accountId}:uid-hash`,
    accountLevel: "3",
  };
}

function position(instId: string): OkxPerpetualPosition {
  return {
    instId,
    side: "flat",
    quantity: "0",
    averagePrice: null,
    markPrice: "0.1",
    liquidationPrice: null,
    updatedAt: now,
  };
}

function order(instId: string): OkxProviderOrder {
  return {
    instId,
    ordId: "9001",
    clOrdId: "sxokxopen000000000000000000000",
    status: "SUBMITTED",
    statusReason: null,
    rawState: "live",
    requestedQuantity: "10",
    filledQuantity: "0",
    averagePrice: null,
    fee: "0",
    updatedAt: now,
  };
}
