import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ArbitrageDashboardSnapshot, ArbitrageOpportunity } from "../arbitrage/arbitrageTypes";
import { ArbitrageExecutionCommandService } from "../arbitrage-execution/ArbitrageExecutionCommandService";
import { ArbitrageExecutionDraftService } from "../arbitrage-execution/ArbitrageExecutionDraftService";
import { FormalExecutionRuntimeRegistry, formalExecutionRuntime } from "../arbitrage-execution/FormalExecutionRuntimeRegistry";
import {
  createVerifiedManagedCloseNativeExecutionRules,
  type FormalExecutionRuntime,
  type FormalManagedCloseExecutionContext,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { ArbitrageExecutionPlanningContextSource } from "../arbitrage-execution/ArbitrageExecutionPlanningContext";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordRecoveryStore, ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { ExecutionCoordinator } from "../cex/ExecutionCoordinator";
import { createVerifiedExecutionProviderIdentity, ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { createAsset } from "../cex/Asset";
import type { ExecutionQuantityPlanningInstrument } from "../cex/ExecutionQuantityPlanner";
import { createTradingRules } from "../cex/TradingRules";
import {
  UnifiedRealTradingTestCommand,
  unifiedRealTradingTestExecutionId,
  type UnifiedRealTradingTestRequest,
} from "../cex/UnifiedRealTradingTestCommand";
import { BybitFormalArbitrageExecutionRuntime } from "./BybitFormalArbitrageExecutionRuntime";
import { BybitIntentExecutionCapability } from "./BybitIntentExecutionCapability";
import { InMemoryBybitExecutionOrderReferenceStore } from "./BybitExecutionOrderReferenceStore";
import { BybitIntentExecutionRuntime, type BybitIntentRuntimeService } from "./BybitIntentExecutionRuntime";
import { BybitIntentExecutionService, bybitOrderLinkIdFor } from "./BybitIntentExecutionService";
import { BybitRealTradingTestVenuePreparation } from "./BybitRealTradingTestVenuePreparation";
import type {
  BybitCancelOrderRequest,
  BybitGetOrderRequest,
  BybitPlaceOrderRequest,
  BybitProviderOrder,
} from "./BybitTypes";

const now = 1_800_000_000_000;
const openGuard = () => new ExecutionMutationSafetyGuard({
  liveTradingEnabled: false,
  killSwitchActive: true,
  venues: { bybit: { liveTradingEnabled: true, killSwitchActive: false } },
});

test("Bybit service maps Spot/Linear BUY/SELL, quantity, marketUnit, positionIdx, and reduceOnly", async (t) => {
  for (const scenario of [
    { instrumentId: "DOGE-USDT-SPOT", side: "buy", reduceOnly: false, category: "spot", providerSide: "Buy", marketUnit: "baseCoin" },
    { instrumentId: "DOGE-USDT-SPOT", side: "sell", reduceOnly: false, category: "spot", providerSide: "Sell", marketUnit: "baseCoin" },
    { instrumentId: "DOGE-USDT-PERP", side: "buy", reduceOnly: false, category: "linear", providerSide: "Buy", positionIdx: 0 },
    { instrumentId: "DOGE-USDT-PERP", side: "sell", reduceOnly: true, category: "linear", providerSide: "Sell", positionIdx: 0 },
  ] as const) {
    await t.test(`${scenario.category} ${scenario.side}`, async () => {
      const provider = new FakeBybitRuntimeService("bybit:account-a");
      const service = new BybitIntentExecutionService(provider, serviceOptions());
      const intent = executionIntent(scenario);
      const result = await service.execute(intent);
      const request = provider.placeRequests[0]!;
      assert.equal(result.state, "SUBMITTED");
      assert.equal(result.confirmedQuantity, "0");
      assert.equal(request.category, scenario.category);
      assert.equal(request.side, scenario.providerSide);
      assert.equal(request.qty, "100");
      assert.equal(request.orderLinkId, bybitOrderLinkIdFor(intent));
      assert.equal(request.marketUnit, "marketUnit" in scenario ? scenario.marketUnit : undefined);
      assert.equal(request.positionIdx, "positionIdx" in scenario ? scenario.positionIdx : undefined);
      assert.equal(request.reduceOnly, scenario.category === "linear" ? scenario.reduceOnly : undefined);
      assert.equal(provider.identityValidations, 0);
      assert.equal(provider.positionModeReads, scenario.category === "linear" ? 1 : 0);
    });
  }
});

test("Bybit HEDGE close uses reduceOnly plus the target positionIdx and rejects the wrong side", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  provider.readLinearPositionMode = async () => "HEDGE";
  const service = new BybitIntentExecutionService(provider, {
    ...serviceOptions(),
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: true }),
    mutationEffect: "DECREASE",
  });
  await service.execute(executionIntent({ side: "buy", positionDirection: "SHORT", reduceOnly: true }));
  assert.equal(provider.placeRequests[0]?.side, "Buy");
  assert.equal(provider.placeRequests[0]?.positionIdx, 2);
  assert.equal(provider.placeRequests[0]?.reduceOnly, true);

  const invalid = new FakeBybitRuntimeService("bybit:account-a");
  invalid.readLinearPositionMode = async () => "HEDGE";
  await assert.rejects(() => new BybitIntentExecutionService(invalid, serviceOptions()).execute(executionIntent({
    side: "buy", positionDirection: "LONG", reduceOnly: true,
  })), /does not reduce/u);
  assert.equal(invalid.placeRequests.length, 0);
});

test("Bybit managed close consumes verified rules, mode, bucket, and identity without duplicate Provider reads", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  provider.readLinearPositionMode = async () => { provider.positionModeReads += 1; return "HEDGE"; };
  let rulesReads = 0;
  const intent = executionIntent({ side: "buy", positionDirection: "SHORT", reduceOnly: true });
  const service = new BybitIntentExecutionService(provider, {
    ...serviceOptions(),
    quantityRulesSource: async () => { rulesReads += 1; return null; },
    mutationEffect: "DECREASE",
    verifiedCloseContext: verifiedBybitCloseContext(intent),
  });

  await service.execute(intent);

  assert.equal(rulesReads, 0);
  assert.equal(provider.positionModeReads, 0);
  assert.equal(provider.identityValidations, 0);
  assert.equal(provider.placeRequests.length, 1);
  assert.equal(provider.placeRequests[0]?.positionIdx, 2);
  assert.equal(provider.placeRequests[0]?.qty, "100");
});

test("Bybit managed close fails closed on stale or scope-mismatched verified context without dispatch", async () => {
  for (const context of [
    verifiedBybitCloseContext(executionIntent({ side: "buy", positionDirection: "SHORT", reduceOnly: true }), now - 15_001),
    verifiedBybitCloseContext(executionIntent({ side: "buy", positionDirection: "SHORT", reduceOnly: true }), now, "other-account"),
  ]) {
    const provider = new FakeBybitRuntimeService("bybit:account-a");
    const intent = executionIntent({ side: "buy", positionDirection: "SHORT", reduceOnly: true });
    const service = new BybitIntentExecutionService(provider, {
      ...serviceOptions(), mutationEffect: "DECREASE", verifiedCloseContext: context,
    });
    await assert.rejects(() => service.execute(intent), /invalid|stale|outside/u);
    assert.equal(provider.placeRequests.length, 0);
  }
});

test("Bybit HEDGE LONG and SHORT openings preserve positionIdx and omit close semantics", async () => {
  for (const fixture of [
    { direction: "LONG" as const, side: "buy" as const, providerSide: "Buy" as const, positionIdx: 1 as const },
    { direction: "SHORT" as const, side: "sell" as const, providerSide: "Sell" as const, positionIdx: 2 as const },
  ]) {
    const provider = new FakeBybitRuntimeService("bybit:account-a");
    provider.readLinearPositionMode = async () => "HEDGE";
    const result = await new BybitIntentExecutionService(provider, serviceOptions()).execute(executionIntent({
      side: fixture.side,
      positionDirection: fixture.direction,
      reduceOnly: false,
    }));

    assert.equal(provider.placeRequests[0]?.side, fixture.providerSide);
    assert.equal(provider.placeRequests[0]?.positionIdx, fixture.positionIdx);
    assert.equal(provider.placeRequests[0]?.reduceOnly, false);
    assert.equal(result.positionIdx, fixture.positionIdx);
    assert.equal(result.positionMode, "HEDGE");
    assert.equal(result.positionDirection, fixture.direction);
  }
});

test("Bybit ACK never becomes CONFIRMED and authoritative query handles partial fill, terminal fill, UNKNOWN, and identity mismatch", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  const recovery: unknown[] = [];
  const service = new BybitIntentExecutionService(provider, {
    ...serviceOptions(),
    persistRecoveryReference: (value) => { recovery.push(value); },
  });
  const intent = executionIntent({ instrumentId: "DOGE-USDT-PERP", side: "buy", reduceOnly: false });
  const accepted = await service.execute(intent);
  assert.equal(accepted.state, "SUBMITTED");
  assert.equal(recovery.length, 1);
  const lookup = {
    instrumentId: intent.instrumentId,
    category: accepted.category,
    symbol: accepted.symbol,
    orderId: accepted.providerOrderId,
    orderLinkId: accepted.clientOrderId,
    expectedProviderQuantity: accepted.expectedProviderQuantity,
    expectedSide: accepted.expectedSide,
    positionIdx: 0 as const,
  };

  provider.orderStatus = "PENDING_CONFIRMATION";
  provider.filledQuantity = "40";
  let queried = await service.query(lookup);
  assert.equal(queried.observation.state, "PENDING_CONFIRMATION");
  assert.equal(queried.observation.filledBaseQuantity, "40");

  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "100";
  queried = await service.query(lookup);
  assert.equal(queried.observation.state, "CONFIRMED");

  provider.orderStatus = "UNKNOWN";
  queried = await service.query(lookup);
  assert.equal(queried.observation.state, "UNKNOWN");

  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "100";
  provider.orderSideOverride = "Sell";
  queried = await service.query(lookup);
  assert.equal(queried.observation.state, "UNKNOWN");
  assert.match(queried.statusReason ?? "", /side/u);
});

test("Bybit HEDGE authoritative query confirms only the persisted target positionIdx", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  provider.readLinearPositionMode = async () => "HEDGE";
  const service = new BybitIntentExecutionService(provider, serviceOptions());
  const accepted = await service.execute(executionIntent({
    side: "sell",
    positionDirection: "SHORT",
    reduceOnly: false,
  }));
  const lookup = {
    instrumentId: "DOGE-USDT-PERP",
    category: accepted.category,
    symbol: accepted.symbol,
    orderId: accepted.providerOrderId,
    orderLinkId: accepted.clientOrderId,
    expectedProviderQuantity: accepted.expectedProviderQuantity,
    expectedSide: accepted.expectedSide,
    positionIdx: accepted.positionIdx,
    positionMode: accepted.positionMode,
    positionDirection: accepted.positionDirection,
  };
  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "100";

  assert.equal((await service.query(lookup)).observation.state, "CONFIRMED");
  provider.orderPositionIdxOverride = 1;
  const wrongBucket = await service.query(lookup);
  assert.equal(wrongBucket.observation.state, "UNKNOWN");
  assert.equal(wrongBucket.observation.filledBaseQuantity, "0");
  assert.match(wrongBucket.statusReason ?? "", /positionIdx/u);
  provider.orderPositionIdxOverride = 2;
  provider.orderReduceOnlyOverride = true;
  const wrongSemantic = await service.query(lookup);
  assert.equal(wrongSemantic.observation.state, "UNKNOWN");
  assert.equal(wrongSemantic.observation.filledBaseQuantity, "0");
  assert.match(wrongSemantic.statusReason ?? "", /reduceOnly/u);
});

test("Bybit position mode, LIVE switch, and kill switch fail closed before fake Provider mutation", async (t) => {
  await t.test("positionIdx is not one-way", async () => {
    const provider = new FakeBybitRuntimeService("bybit:account-a");
    provider.positionModeResult = 1;
    const service = new BybitIntentExecutionService(provider as never, serviceOptions());
    const result = await new ExecutionCoordinator(new BybitIntentExecutionCapability(service), () => now)
      .execute(executionIntent({ instrumentId: "DOGE-USDT-PERP" }));
    assert.equal(result.executionState.status, "FAILED");
    assert.equal(provider.placeRequests.length, 0);
  });
  for (const state of [
    { liveTradingEnabled: false, killSwitchActive: false, message: /BYBIT_LIVE_TRADING_ENABLED|LIVE_TRADING_ENABLED/u },
    { liveTradingEnabled: true, killSwitchActive: true, message: /BYBIT_KILL_SWITCH|kill switch/u },
  ]) {
    await t.test(`${state.liveTradingEnabled}/${state.killSwitchActive}`, async () => {
      const provider = new FakeBybitRuntimeService("bybit:account-a");
      const service = new BybitIntentExecutionService(provider, {
        ...serviceOptions(),
        mutationSafetyGuard: new ExecutionMutationSafetyGuard({
          liveTradingEnabled: false,
          killSwitchActive: true,
          venues: { bybit: state },
        }),
      });
      const result = await new ExecutionCoordinator(new BybitIntentExecutionCapability(service), () => now)
        .execute(executionIntent({ instrumentId: "DOGE-USDT-PERP" }));
      assert.equal(result.executionState.status, "FAILED");
      assert.match(result.step.status === "CALL_FAILED" && result.step.error instanceof Error
        ? result.step.error.message
        : "", state.message);
      assert.equal(provider.placeRequests.length, 0);
    });
  }
});

test("halted Bybit allows trusted managed closes and known-order cancel but blocks ordinary SELL", async () => {
  const halted = new ExecutionMutationSafetyGuard({
    liveTradingEnabled: false,
    killSwitchActive: true,
    venues: { bybit: { liveTradingEnabled: false, killSwitchActive: true } },
  });
  for (const instrumentId of ["DOGE-USDT-PERP", "DOGE-USDT-SPOT"] as const) {
    const provider = new FakeBybitRuntimeService("bybit:account-a");
    const service = new BybitIntentExecutionService(provider, {
      ...serviceOptions(), mutationSafetyGuard: halted, mutationEffect: "DECREASE",
    });
    await service.execute(executionIntent({
      instrumentId,
      side: "sell",
      ...(instrumentId.endsWith("-PERP") ? { positionDirection: "LONG", reduceOnly: true } : {}),
    }));
    assert.equal(provider.placeRequests.length, 1);
  }

  const ordinaryProvider = new FakeBybitRuntimeService("bybit:account-a");
  const ordinary = new BybitIntentExecutionService(ordinaryProvider, {
    ...serviceOptions(), mutationSafetyGuard: halted,
  });
  await assert.rejects(() => ordinary.execute(executionIntent({ instrumentId: "DOGE-USDT-SPOT", side: "sell" })));
  assert.equal(ordinaryProvider.placeRequests.length, 0);

  const cancelProvider = new FakeBybitRuntimeService("bybit:account-a");
  const cancel = new BybitIntentExecutionService(cancelProvider, {
    ...serviceOptions(), mutationSafetyGuard: halted,
  });
  await cancel.cancel({
    instrumentId: "DOGE-USDT-PERP", category: "linear", symbol: "DOGEUSDT",
    orderId: "bybit-order-1", orderLinkId: "bybit-link-1", expectedProviderQuantity: "100",
    expectedSide: "Sell", positionIdx: 0, positionMode: "ONE_WAY", positionDirection: "LONG",
  }, { userId: "user-a", accountId: "bybit:account-a", instrumentId: "DOGE-USDT-PERP" });
  assert.equal(cancelProvider.cancelRequests.length, 1);
});

test("Bybit Provider write uncertainty remains UNKNOWN after the mutation call begins", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  provider.placeFailure = new Error("Provider write outcome is uncertain.");
  const service = new BybitIntentExecutionService(provider, serviceOptions());

  const result = await new ExecutionCoordinator(new BybitIntentExecutionCapability(service), () => now)
    .execute(executionIntent({ instrumentId: "DOGE-USDT-PERP" }));

  assert.equal(result.executionState.status, "UNKNOWN");
  assert.equal(provider.placeRequests.length, 1);
});

test("Bybit formal runtime exposes NOT_DISPATCHED for a safety rejection without a Provider mutation", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  const records = new InMemoryRecoveryRecordStore();
  const references = new InMemoryBybitExecutionOrderReferenceStore();
  const runtime = new BybitIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    references,
    {
      ...serviceOptions(),
      mutationSafetyGuard: new ExecutionMutationSafetyGuard({
        liveTradingEnabled: false,
        killSwitchActive: true,
        venues: { bybit: { liveTradingEnabled: false, killSwitchActive: true } },
      }),
      createExecutionId: () => "execution-bybit-not-dispatched",
    },
  );

  const result = await new BybitFormalArbitrageExecutionRuntime(runtime).execute(executionIntent());

  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.confirmedQuantity, "0");
  assert.equal(result.mutationDisposition, "NOT_DISPATCHED");
  assert.equal(provider.placeRequests.length, 0);
});

test("Bybit runtime promotion preserves HEDGE mode, direction, and positionIdx", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  provider.readLinearPositionMode = async () => "HEDGE";
  const records = new InMemoryRecoveryRecordStore();
  const references = new InMemoryBybitExecutionOrderReferenceStore();
  const runtime = new BybitIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    references,
    { ...serviceOptions(), createExecutionId: () => "execution-bybit-hedge-promotion" },
  );

  const result = await runtime.execute(executionIntent({
    side: "sell",
    positionDirection: "SHORT",
    reduceOnly: false,
  }));

  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.orderReference?.positionMode, "HEDGE");
  assert.equal(result.orderReference?.positionDirection, "SHORT");
  assert.equal(result.orderReference?.positionIdx, 2);
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-bybit-hedge-promotion"), null);
});

test("Bybit HEDGE recovery does not promote Provider evidence from another positionIdx", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  await provider.placeOrder({
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Sell",
    orderType: "Market",
    qty: "100",
    orderLinkId: "bybit-hedge-recovery",
    reduceOnly: false,
    positionIdx: 2,
    positionMode: "HEDGE",
    positionDirection: "SHORT",
  });
  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "100";
  provider.orderPositionIdxOverride = 1;
  const record = createExecutionRecord({
    executionId: "execution-bybit-hedge-recovery",
    intentId: "intent-bybit-hedge-recovery",
    executionAttemptId: "intent-bybit-hedge-recovery",
    userId: "user-a",
    venue: "bybit",
    accountId: "bybit:account-a",
    instrumentId: "DOGE-USDT-PERP",
    status: "UNKNOWN",
    createdAt: now,
    updatedAt: now,
  });
  const records = new InMemoryRecoveryRecordStore();
  records.create(record);
  const references = new InMemoryBybitExecutionOrderReferenceStore();
  references.createRecovery({
    executionId: record.executionId,
    intentId: record.intentId,
    userId: record.userId,
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    category: "linear",
    symbol: "DOGEUSDT",
    orderLinkId: "bybit-hedge-recovery",
    expectedProviderQuantity: "100",
    expectedSide: "Sell",
    positionIdx: 2,
    positionMode: "HEDGE",
    positionDirection: "SHORT",
    createdAt: now,
    updatedAt: now,
  });
  const runtime = new BybitIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    references,
    serviceOptions(),
  );

  const result = await runtime.reconcile("user-a", record.executionId);

  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.orderReference, null);
  assert.equal(await references.loadForUser("user-a", record.executionId), null);
  assert.equal((await references.loadRecoveryForUser("user-a", record.executionId))?.positionIdx, 2);
});

test("Bybit normal business Command reaches the formal chain while positionIdx remains a dynamic fail-closed preflight", async (t) => {
  for (const [mode, expectedPlaceCount, expectedStatus] of [
    [0, 1, "PENDING_CONFIRMATION"],
    [1, 0, "FAILED"],
    [2, 0, "FAILED"],
    [null, 0, "FAILED"],
  ] as const) {
    await t.test(`positionIdx=${mode ?? "unknown"}`, async () => {
      const fixture = businessCommandFixture(mode);
      t.after(() => fixture.close());
      const confirmation = await fixture.command.confirm("user-a", {
        confirmationId: "business-confirmation-1",
        opportunityId: "business-opportunity-1",
        horizonDays: 90,
        quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
        executionMode: "EXECUTION_PRIORITY",
        confirmed: true,
      });
      const result = await fixture.command.executeLeg("user-a", {
        confirmationId: "business-confirmation-1",
        opportunityId: "business-opportunity-1",
        horizonDays: 90,
        quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
        executionMode: "EXECUTION_PRIORITY",
        confirmed: true,
        arbitrageId: confirmation.instance.arbitrageId,
        legId: "bybit-perp-leg",
        commandId: "business-command-1",
      });
      assert.equal(result.executionRecord.status, expectedStatus);
      assert.equal(fixture.provider.placeRequests.length, expectedPlaceCount);
    });
  }
});

test("Bybit disabled or incomplete credential is rejected by Draft before the business Command", async () => {
  const fixture = businessCommandFixture(0, { executionEnabled: false });
  try {
  const draft = await fixture.drafts.preview("user-a", {
    opportunityId: "business-opportunity-1",
    horizonDays: 90,
    executionMode: "EXECUTION_PRIORITY",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
  });
  assert.equal(draft.legs.find((leg) => leg.venue === "bybit")?.executionAvailable, false);
  assert.equal(fixture.provider.placeRequests.length, 0);
  } finally {
    fixture.close();
  }
});

test("Unified command uses the actual Bybit Formal/Intent/Coordinator/Capability chain and restart recovery never duplicates place", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  const records = new InMemoryRecoveryRecordStore();
  const references = new InMemoryBybitExecutionOrderReferenceStore();
  const request: UnifiedRealTradingTestRequest = {
    requestId: "bybit-restart-1",
    userId: "user-a",
    venue: "bybit",
    instrumentId: "DOGE-USDT-PERP",
    side: "buy",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
    reduceOnly: false,
    executionMode: "EXECUTION_PRIORITY",
    executeLive: true,
  };
  const preparation = bybitPreparation();
  const first = command(provider, records, references, preparation);
  const firstResult = await first.run(request);
  assert.equal(firstResult.action, "EXECUTED");
  assert.equal(firstResult.runtimeResult?.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(provider.placeRequests.length, 1);
  assert.equal(provider.identityValidations, 1);

  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "100";
  const recreated = command(provider, records, references, preparation);
  const secondResult = await recreated.run(request);
  assert.equal(secondResult.action, "RECONCILED");
  assert.equal(secondResult.runtimeResult?.executionRecord.status, "CONFIRMED");
  assert.equal(secondResult.runtimeResult?.confirmedQuantity, "100");
  assert.equal(provider.placeRequests.length, 1);
  assert.equal(provider.getOrderRequests.length, 1);

  await assert.rejects(
    () => recreated.run({ ...request, side: "sell" }),
    /semantics do not match/u,
  );
  assert.equal(provider.placeRequests.length, 1);
});

test("Unified PREVIEW performs zero mutation and runtime cancellation uses the persisted exact identity", async () => {
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  const records = new InMemoryRecoveryRecordStore();
  const references = new InMemoryBybitExecutionOrderReferenceStore();
  const preparation = bybitPreparation();
  const previewRequest: UnifiedRealTradingTestRequest = {
    requestId: "bybit-preview-1", userId: "user-a", venue: "bybit", instrumentId: "DOGE-USDT-SPOT",
    side: "sell", quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" }, reduceOnly: false,
    executionMode: "EXECUTION_PRIORITY", executeLive: false,
  };
  const preview = await command(provider, records, references, preparation).run(previewRequest);
  assert.equal(preview.action, "PREVIEW");
  assert.equal(provider.placeRequests.length, 0);

  const live = command(provider, records, references, preparation);
  const executed = await live.run({ ...previewRequest, requestId: "bybit-cancel-1", executeLive: true });
  const executionId = executed.runtimeResult!.executionRecord.executionId;
  const runtime = runtimeFor(provider, records, references);
  const cancelled = await runtime.cancel("user-a", executionId);
  assert.equal(cancelled.observation.state, "CANCEL_REQUESTED");
  assert.equal(provider.cancelRequests.length, 1);
  assert.equal(provider.cancelRequests[0]?.orderId, executed.runtimeResult?.executionRecord.remoteOrderId);
});

function command(
  provider: FakeBybitRuntimeService,
  records: InMemoryRecoveryRecordStore,
  references: InMemoryBybitExecutionOrderReferenceStore,
  preparation: BybitRealTradingTestVenuePreparation,
) {
  const formal = new BybitFormalArbitrageExecutionRuntime(runtimeFor(provider, records, references));
  const runtimes = new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("bybit", formal));
  return new UnifiedRealTradingTestCommand(runtimes, records, [preparation], { now: () => now });
}

function runtimeFor(
  provider: FakeBybitRuntimeService,
  records: InMemoryRecoveryRecordStore,
  references: InMemoryBybitExecutionOrderReferenceStore,
) {
  return new BybitIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    references,
    { ...serviceOptions(), createExecutionId: unifiedRealTradingTestExecutionId },
  );
}

function bybitPreparation() {
  return new BybitRealTradingTestVenuePreparation(
    { findSummary: () => ({ accountId: "bybit:account-a", permissions: { executionEnabled: true } }) as never },
    {
      now: () => now,
      tradingRules: { getTradingRules: async () => ({ quantityStep: "1", minQuantity: "1", priceTick: "0.0001", precision: {} }) },
      tickerSource: async (category, symbol) => ({ category, symbol, bid: "0.1", ask: "0.11", fetchedAt: now }),
    },
  );
}

function serviceOptions() {
  return {
    clock: () => now,
    mutationSafetyGuard: openGuard(),
    quantityRulesSource: async (category: "spot" | "linear", symbol: string) => ({
      category,
      symbol,
      status: "Trading",
      baseCoin: symbol.slice(0, -4),
      quoteCoin: "USDT",
      settleCoin: category === "linear" ? "USDT" : null,
      qtyStep: "1",
      minOrderQty: "1",
      minNotionalValue: "1",
      fetchedAt: now,
    }),
    persistRecoveryReference: () => undefined,
  } as const;
}

function verifiedBybitCloseContext(
  intent: ExecutionIntent,
  verifiedAt = now,
  accountId = intent.accountId,
): FormalManagedCloseExecutionContext {
  return Object.freeze({
    verifiedAt,
    positionMode: "HEDGE",
    side: intent.side,
    positionDirection: "SHORT",
    actualSignedNetQuantity: null,
    actualLongQuantity: "0",
    actualShortQuantity: "100",
    safeClosableQuantity: "100",
    managedQuantityCeiling: "100",
    legalizedCloseQuantity: "100",
    reduceOnly: true,
    verifiedProviderIdentity: createVerifiedExecutionProviderIdentity({
      userId: intent.userId, venue: "bybit", accountId,
      executionIntentId: intent.intentId, verifiedAt,
    }),
    verifiedNativeExecutionRules: createVerifiedManagedCloseNativeExecutionRules({
      userId: intent.userId, accountId, venue: "bybit",
      canonicalInstrumentId: intent.instrumentId, providerInstrumentId: "DOGEUSDT",
      executionIntentId: intent.intentId, instrumentState: "live", contractType: "linear",
      contractValueCurrency: "DOGE", settlementAsset: "USDT", contractValue: "1",
      lotSize: "1", minimumSize: "1", minimumNotional: "5",
      canonicalSafeCloseQuantity: "100", legalizedCanonicalCloseQuantity: "100",
      providerNativeQuantity: "100", verifiedAt,
    }),
  });
}

function executionIntent(input: Partial<{
  instrumentId: string; side: "buy" | "sell"; reduceOnly: boolean; positionDirection: "LONG" | "SHORT";
}> = {}): ExecutionIntent {
  const instrumentId = input.instrumentId ?? "DOGE-USDT-PERP";
  return createExecutionIntent({
    intentId: `intent-${instrumentId}-${input.side ?? "buy"}-${input.reduceOnly ?? false}`,
    userId: "user-a",
    venue: "bybit",
    accountId: "bybit:account-a",
    instrumentId,
    ...(instrumentId.endsWith("-PERP")
      ? { positionDirection: input.positionDirection ?? (input.side === "buy" ? "LONG" as const : "SHORT" as const) }
      : {}),
    side: input.side ?? "buy",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "100" },
    orderConstraints: { reduceOnly: input.reduceOnly ?? false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

class FakeBybitRuntimeService implements BybitIntentRuntimeService {
  readonly placeRequests: BybitPlaceOrderRequest[] = [];
  readonly getOrderRequests: BybitGetOrderRequest[] = [];
  readonly cancelRequests: BybitCancelOrderRequest[] = [];
  identityValidations = 0;
  positionModeReads = 0;
  positionModeResult: 0 | 1 | 2 | null = 0;
  orderStatus: BybitProviderOrder["status"] = "PENDING_CONFIRMATION";
  filledQuantity = "0";
  orderSideOverride?: "Buy" | "Sell";
  orderPositionIdxOverride?: 0 | 1 | 2;
  orderReduceOnlyOverride?: boolean;
  placeFailure?: Error;
  readLinearPositionMode?: () => Promise<"ONE_WAY" | "HEDGE">;
  private lastOrder?: BybitPlaceOrderRequest;

  constructor(private readonly accountId: string) {}
  executionAccountIdentity() { return { accountId: this.accountId }; }
  validateExecutionProviderIdentity() { this.identityValidations += 1; }
  async getLinearPositionIdx() {
    this.positionModeReads += 1;
    if (this.positionModeResult !== 0) throw new Error("Bybit Linear execution requires positionIdx=0.");
    return 0 as const;
  }
  async placeOrder(request: BybitPlaceOrderRequest) {
    this.placeRequests.push(request);
    this.lastOrder = request;
    if (this.placeFailure) throw this.placeFailure;
    return { category: request.category, symbol: request.symbol, orderId: "bybit-order-1", orderLinkId: request.orderLinkId };
  }
  async getOrder(request: BybitGetOrderRequest): Promise<BybitProviderOrder> {
    this.getOrderRequests.push(request);
    const placed = this.lastOrder;
    if (!placed) throw new Error("No fake Bybit order exists.");
    return {
      category: request.category,
      symbol: request.symbol,
      orderId: request.orderId ?? "bybit-order-1",
      orderLinkId: request.orderLinkId,
      side: this.orderSideOverride ?? placed.side,
      status: this.orderStatus,
      statusReason: null,
      rawStatus: this.orderStatus === "CONFIRMED" ? "Filled" : this.orderStatus === "UNKNOWN" ? "Mystery" : "PartiallyFilled",
      requestedQuantity: placed.qty,
      filledQuantity: this.filledQuantity,
      averagePrice: this.filledQuantity === "0" ? null : "0.1",
      fee: "0",
      feeCurrency: null,
      ...(placed.positionIdx === undefined
        ? {}
        : { positionIdx: this.orderPositionIdxOverride ?? placed.positionIdx }),
      ...(placed.reduceOnly === undefined ? {} : { reduceOnly: this.orderReduceOnlyOverride ?? placed.reduceOnly }),
      ...(placed.marketUnit === undefined ? {} : { marketUnit: placed.marketUnit }),
      updatedAt: now,
    };
  }
  async cancelOrder(request: BybitCancelOrderRequest) {
    this.cancelRequests.push(request);
    return { category: request.category, symbol: request.symbol, orderId: request.orderId ?? "bybit-order-1", orderLinkId: request.orderLinkId };
  }
}

function businessCommandFixture(
  positionModeResult: 0 | 1 | 2 | null,
  bybitOverrides: Readonly<Record<string, boolean>> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "stellax-bybit-business-"));
  const instances = new ArbitrageInstanceStore({ dbPath: join(directory, "instances.sqlite") });
  const records = new InMemoryRecoveryRecordStore();
  const references = new InMemoryBybitExecutionOrderReferenceStore();
  const provider = new FakeBybitRuntimeService("bybit:account-a");
  provider.positionModeResult = positionModeResult;
  const bybitRuntime = new BybitIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    references,
    { ...serviceOptions(), createExecutionId: unifiedRealTradingTestExecutionId },
  );
  const unused: FormalExecutionRuntime = {
    execute: async () => { throw new Error("unexpected non-Bybit mutation"); },
    reconcile: async () => { throw new Error("unexpected non-Bybit reconciliation"); },
    cancel: async () => { throw new Error("unexpected non-Bybit cancellation"); },
  };
  const runtimes = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", unused))
    .register(formalExecutionRuntime("bybit", new BybitFormalArbitrageExecutionRuntime(bybitRuntime)));
  const credentials = {
    findSummary: (_userId: string, venue: string) => venue === "bybit"
      ? { accountId: "bybit:account-a", permissions: {
          executionEnabled: true, providerVerified: true, read: true, contractTrade: true,
          withdraw: false, ipRestricted: true, accountLevelSupported: true, ...bybitOverrides,
        } } as never
      : { accountId: "binance:account-a", permissions: {} } as never,
    loadForExecution: async (_userId: string, venue: string) => ({
      apiKey: `${venue}-key`, apiSecret: `${venue}-secret`,
    }),
  };
  const contexts: ArbitrageExecutionPlanningContextSource = {
    load: async (venue, instrumentId) => {
      const perpetual = instrumentId.endsWith("-PERP");
      const instrument: ExecutionQuantityPlanningInstrument = Object.freeze({
        instrumentId,
        providerSymbol: "DOGEUSDT",
        baseAsset: createAsset({ symbol: "DOGE", type: "DIGITAL_ASSET" }),
        quoteAsset: "USDT",
        ...(perpetual ? { settlementAsset: "USDT" } : {}),
        marketType: perpetual ? "perpetual" : "spot",
        contractType: perpetual ? "linear_perpetual" : "spot",
        quantityUnit: "base",
        status: "trading",
      });
      return Object.freeze({
        instrument,
        tradingRules: createTradingRules({ quantityStep: "1", minQuantity: "1", priceTick: "0.01", minNotional: "1", precision: {} }),
        quote: Object.freeze({ bid: "0.1", ask: "0.1", fetchedAt: Date.now() }),
      });
    },
  };
  const drafts = new ArbitrageExecutionDraftService(
    { getSnapshot: async (horizonDays: 90 | 365) => businessSnapshot(horizonDays) },
    contexts,
    credentials,
    runtimes,
    () => now,
  );
  const command = new ArbitrageExecutionCommandService(
    drafts,
    instances,
    credentials,
    records,
    runtimes,
    { evaluate: async (_userId, instance) => instance.legs
      .filter((leg) => leg.instrumentId.endsWith("-PERP"))
      .map((leg) => ({
        legId: leg.legId,
        targetDirection: leg.role,
        positionMode: "ONE_WAY" as const,
        currentSignedNetQuantity: "0",
        openingAttributionSafe: true,
        reason: "ONE_WAY_FLAT" as const,
        checkedAt: now,
      })) },
    { contexts, spotAttributions: {}, continuationSafety: {
      loadFreshVerification: async () => null,
      evaluate: async () => { throw new Error("not used"); },
    } },
    { clock: () => now, intentTtlMs: 30_000 },
  );
  return {
    command,
    drafts,
    provider,
    close() { instances.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function businessSnapshot(horizonDays: 90 | 365): ArbitrageDashboardSnapshot {
  const leg = (venue: "binance" | "bybit", kind: "spot" | "perpetual", id: string) => ({
    id, venue, venueLabel: venue, symbol: "DOGEUSDT", asset: "DOGE" as const, kind,
    quoteAsset: "USDT" as const, settlementAsset: "USDT" as const, bid: 0.1, ask: 0.1,
    fundingRate: kind === "perpetual" ? 0.0001 : null,
    fundingIntervalHours: kind === "perpetual" ? 8 : null,
    currentFundingApr: kind === "perpetual" ? 10 : 0,
    historicalFundingApr: kind === "perpetual" ? 8 : 0,
    nextFundingTime: kind === "perpetual" ? now + 3_600_000 : null,
  });
  const opportunity: ArbitrageOpportunity = {
    id: "business-opportunity-1", longLeg: leg("binance", "perpetual", "binance-perp-leg"),
    shortLeg: leg("bybit", "perpetual", "bybit-perp-leg"), strategyType: "cross_venue_arbitrage",
    strategyLabel: "套利", matchQuality: "exact", matchLabel: "精确匹配", currentGrossApr: 10,
    historicalGrossApr: 8, netApr: 5, persistenceRatio: 0.8, annualizedTradingCostApr: 2,
    roundTripCostBps: 10, entryBasisBps: 0, capacityUsd: 100_000, score: 80,
    historicalQualityScore: 75, confidence: "high", confidenceLabel: "高", opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率", recommendation: "watch", entryStatus: "favorable",
    scoreBreakdown: { conservativeNetReturn: 1, driverStrength: 1, persistence: 1, costEfficiency: 1, liquidity: 1, confidence: 1 },
    disqualifiers: [], warnings: [], automationEligible: false, automationDisqualifiers: [],
  };
  return {
    horizonDays, generatedAt: now - 1_000, markets: [], opportunities: [opportunity],
    summary: { bestScore: 80, bestNetApr: 5, eligibleOpportunityCount: 1, connectedVenueCount: 2,
      totalVenueCount: 5, trackedMarketCount: 2, usdcUsdtPrice: null, stablecoinBasisBps: null },
    warnings: [],
  };
}

class InMemoryRecoveryRecordStore implements ExecutionRecordStore, ExecutionRecordRecoveryStore {
  private readonly records = new Map<string, ExecutionRecord>();
  create(record: ExecutionRecord) {
    if (this.records.has(record.executionId)) throw new Error("ExecutionRecord already exists.");
    this.records.set(record.executionId, record);
  }
  update(record: ExecutionRecord) {
    if (!this.records.has(record.executionId)) throw new Error("ExecutionRecord not found.");
    this.records.set(record.executionId, record);
  }
  loadForUser(userId: string, executionId: string) {
    const record = this.records.get(executionId);
    return record?.userId === userId ? record : null;
  }
  findByIntentId(intentId: string) {
    return [...this.records.values()].filter((record) => record.intentId === intentId);
  }
}
