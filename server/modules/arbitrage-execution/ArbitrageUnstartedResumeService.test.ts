import assert from "node:assert/strict";
import test from "node:test";
import {
  ArbitrageUnstartedResumeError,
  ArbitrageUnstartedResumeService,
} from "./ArbitrageUnstartedResumeService";
import { openingSetupSourcePlanId } from "./ArbitrageOpeningSetup";

const setup = {
  opportunityId: "op-doge",
  horizonDays: 90 as const,
  quantityInput: { mode: "NOTIONAL_USDT" as const, amountUsdt: "15" },
  executionMode: "EXECUTION_PRIORITY" as const,
};

const instance = {
  arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL",
  sourcePlanId: openingSetupSourcePlanId(setup),
  legs: [
    { legId: "spot", role: "LONG", venue: "okx", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "10.010237" },
    { legId: "perp", role: "SHORT", venue: "okx", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "10" },
  ],
};

const draft = {
  opportunityId: setup.opportunityId,
  horizonDays: setup.horizonDays,
  executionMode: setup.executionMode,
  quantityInput: setup.quantityInput,
  strategyType: "SPOT_PERPETUAL",
  legs: [
    { legId: "spot", role: "LONG", side: "buy", venue: "okx", instrumentId: "DOGE-USDT-SPOT",
      planning: { status: "PLANNED", plan: { plannedAssetQuantity: { quantity: "9.998" } } } },
    { legId: "perp", role: "SHORT", side: "sell", venue: "okx", instrumentId: "DOGE-USDT-PERP",
      planning: { status: "PLANNED", plan: { plannedAssetQuantity: { quantity: "9" } } } },
  ],
};

test("restores an eligible instance setup and revalidates it through the authoritative Draft service", async () => {
  const calls: unknown[] = [];
  const service = new ArbitrageUnstartedResumeService({
    get: () => instance as any,
    readUnstartedOpeningSetup: () => setup,
  }, {
    preview: async (userId, input) => {
      calls.push({ userId, input });
      return draft as any;
    },
  });

  const result = await service.load("user-a", "arbitrage-1");
  assert.equal(result.instance, instance);
  assert.equal(result.setup, setup);
  assert.deepEqual(calls, [{ userId: "user-a", input: setup }]);
});

test("NOTIONAL_USDT planned quantity drift is fresh planning, not resume identity drift", async () => {
  const service = new ArbitrageUnstartedResumeService({
    get: () => instance as any,
    readUnstartedOpeningSetup: () => setup,
  }, { preview: async () => draft as any });

  const result = await service.load("user-a", "arbitrage-1");
  assert.equal(result.instance.legs[0].plannedQuantity, "10.010237");
  assert.equal((result.draft.legs[0].planning as any).plan.plannedAssetQuantity.quantity, "9.998");
  assert.equal((result.draft.legs[1].planning as any).plan.plannedAssetQuantity.quantity, "9");
});

test("ASSET_QUANTITY planned quantity drift is accepted with the same original setup identity", async () => {
  const assetSetup = {
    ...setup,
    quantityInput: { mode: "ASSET_QUANTITY" as const, quantity: "60" },
  };
  const assetInstance = {
    ...instance,
    sourcePlanId: openingSetupSourcePlanId(assetSetup),
    legs: instance.legs.map((leg) => ({ ...leg, plannedQuantity: "60" })),
  };
  const assetDraft = {
    ...draft,
    quantityInput: assetSetup.quantityInput,
    legs: [
      { ...draft.legs[0], planning: { status: "PLANNED", plan: { plannedAssetQuantity: { quantity: "59.5" } } } },
      { ...draft.legs[1], planning: { status: "PLANNED", plan: { plannedAssetQuantity: { quantity: "59" } } } },
    ],
  };
  const service = new ArbitrageUnstartedResumeService({
    get: () => assetInstance as any,
    readUnstartedOpeningSetup: () => assetSetup,
  }, { preview: async () => assetDraft as any });

  const result = await service.load("user-a", "arbitrage-1");
  assert.equal(result.instance.arbitrageId, "arbitrage-1");
  assert.deepEqual(result.setup.quantityInput, { mode: "ASSET_QUANTITY", quantity: "60" });
});

test("fresh rules may make the restored setup unavailable without changing instance identity", async () => {
  const unavailableDraft = {
    ...draft,
    allLegsExecutable: false,
    legs: [
      { ...draft.legs[0], executionAvailable: true },
      { ...draft.legs[1], executionAvailable: false,
        planning: { status: "UNAVAILABLE", errorCode: "QUANTITY_STEP_MISMATCH" } },
    ],
  };
  const service = new ArbitrageUnstartedResumeService({
    get: () => instance as any,
    readUnstartedOpeningSetup: () => setup,
  }, { preview: async () => unavailableDraft as any });

  const result = await service.load("user-a", "arbitrage-1");
  assert.equal(result.instance.arbitrageId, "arbitrage-1");
  assert.equal(result.draft.allLegsExecutable, false);
});

test("instances with execution facts or missing persisted setup fail closed before Draft reads", async () => {
  let previewCalls = 0;
  const service = new ArbitrageUnstartedResumeService({
    get: () => instance as any,
    readUnstartedOpeningSetup: () => null,
  }, {
    preview: async () => { previewCalls += 1; return draft as any; },
  });
  await assert.rejects(
    () => service.load("user-a", "arbitrage-1"),
    (error) => error instanceof ArbitrageUnstartedResumeError
      && error.category === "arbitrage_resume_not_available",
  );
  assert.equal(previewCalls, 0);
});

test("current Draft identity drift cannot turn the existing instance into another opportunity", async () => {
  const service = new ArbitrageUnstartedResumeService({
    get: () => instance as any,
    readUnstartedOpeningSetup: () => setup,
  }, {
    preview: async () => ({ ...draft, legs: [{ ...draft.legs[0], instrumentId: "BTC-USDT-SPOT" }, draft.legs[1]] }) as any,
  });
  await assert.rejects(
    () => service.load("user-a", "arbitrage-1"),
    (error) => error instanceof ArbitrageUnstartedResumeError
      && error.category === "arbitrage_instance_mismatch",
  );
});
