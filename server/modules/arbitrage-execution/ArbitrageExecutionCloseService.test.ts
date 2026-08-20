import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAsset } from "../cex/Asset";
import { managedCurrentQuantity, managedSignedDelta } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { createTradingRules } from "../cex/TradingRules";
import type { FormalExecutionRuntime } from "./FormalExecutionRuntime";
import { BinanceFormalArbitrageExecutionRuntime } from "./BinanceFormalArbitrageExecutionRuntime";
import { OkxFormalArbitrageExecutionRuntime } from "../okx/OkxFormalArbitrageExecutionRuntime";
import { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { BinanceIntentExecutionRuntimeRegistry } from "../binance/BinanceIntentExecutionRuntime";
import { binanceExecutionIdempotencyKeyFor } from "../binance/BinanceIntentExecutionService";
import type { BinanceGenericExecutionContext } from "../binance/BinanceGenericExecutionReadContext";
import type { BinanceOrderInput } from "../binance/BinanceOrderManager";
import type { BinanceStoredOrder, BinanceStoredOrderIsolation } from "../binance/BinanceOrderStore";
import type { BinanceProviderOrder } from "../binance/BinanceTypes";
import { snapshotFixture } from "../binance/binanceTestFixtures";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { OkxIntentExecutionRuntime } from "../okx/OkxIntentExecutionRuntime";
import { InMemoryOkxExecutionOrderReferenceStore } from "../okx/OkxExecutionOrderReferenceStore";
import { okxTestQuantityRulesSource } from "../okx/OkxTestFixtures";
import type { OkxPlaceOrderRequest, OkxCancelOrderResult, OkxGetOrderRequest, OkxProviderOrder } from "../okx/OkxTypes";
import {
  FormalExecutionRuntimeRegistry,
  formalExecutionRuntime,
} from "./FormalExecutionRuntimeRegistry";
import {
  ArbitrageExecutionCloseError,
  ArbitrageExecutionCloseService,
} from "./ArbitrageExecutionCloseService";
import { ArbitrageExecutionCommandService } from "./ArbitrageExecutionCommandService";

const now = 1_900_000_000_000;

test("LONG perpetual close is authoritative SELL reduceOnly and decreases managed quantity", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "0.4";

  const result = await fixture.service.closeLeg("user-a", request("long-leg", "0.4"));

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.side, "sell");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, true);
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "0.4");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.4");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "1");
  assert.equal(result.instance.executionReferences.at(-1)?.phase, "CLOSING");
  assert.equal(result.instance.executionReferences.at(-1)?.quantityEffect, "DECREASE");
  assert.equal(result.instance.status, "RESIDUAL");
});

test("SHORT perpetual close is authoritative BUY reduceOnly", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "1";

  const result = await fixture.service.closeLeg("user-a", request("short-leg", "1"));

  assert.equal(fixture.runtime.calls[0]?.side, "buy");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, true);
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "1");
  assert.notEqual(result.instance.status, "CLOSED", "one flat leg must not close the two-leg instance");
});

test("SHORT A/B/C/D close reverses the managed delta without re-sizing from current net", async (t) => {
  for (const scenario of [
    { name: "A", currentNet: "-20", reduceOnly: true },
    { name: "B", currentNet: "-120", reduceOnly: true },
    { name: "C", currentNet: "80", reduceOnly: false },
    { name: "D", currentNet: "-10", reduceOnly: false },
  ]) {
    const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: scenario.currentNet });
    fixture.runtime.resultStatus = "CONFIRMED";
    fixture.runtime.confirmedQuantity = "20";

    const result = await fixture.service.closeLeg("user-a", request("short-leg", "20", `short-${scenario.name}`));

    assert.equal(fixture.runtime.calls[0]?.side, "buy", scenario.name);
    assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "20", scenario.name);
    assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, scenario.reduceOnly, scenario.name);
    assert.equal(managedSignedDelta(result.instance.legs[1]), "0", scenario.name);
  }
});

test("partial SHORT close reverses only the requested managed slice and plans the remainder", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "-15" });
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "10";

  const first = await fixture.service.closeLeg("user-a", request("short-leg", "10", "slice-one"));
  assert.equal(fixture.runtime.calls[0]?.side, "buy");
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "10");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, true);
  assert.equal(first.instance.legs[1]?.confirmedOpenedQuantity, "20");
  assert.equal(first.instance.legs[1]?.confirmedClosedQuantity, "10");
  assert.equal(managedSignedDelta(first.instance.legs[1]!), "-10");

  const second = await fixture.service.closeLeg("user-a", request("short-leg", "10", "slice-two"));
  assert.equal(fixture.runtime.calls[1]?.quantity.quantity, "10");
  assert.equal(second.instance.legs[1]?.confirmedClosedQuantity, "20");
  assert.equal(managedSignedDelta(second.instance.legs[1]!), "0");
});

test("Binance formal close preserves CLOSING when the reversal is not reduce-only", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "80", formalVenue: "binance" });
  fixture.binanceService!.providerOrder = realPathBinanceOrder({ filledQuantity: 20, requestedQuantity: 20 });
  const result = await fixture.service.closeLeg("user-a", request("short-leg", "20", "formal-binance-c"));

  assert.equal(fixture.binanceService!.placeInputs[0]?.side, "Buy");
  assert.equal(fixture.binanceService!.placeInputs[0]?.quantity, "20");
  assert.equal(fixture.binanceService!.placeInputs[0]?.reduceOnly, false);
  assert.equal(result.instance.executionReferences.at(-1)?.phase, "CLOSING");
  assert.equal(result.instance.executionReferences.at(-1)?.quantityEffect, "DECREASE");
  assert.equal(result.instance.legs[1]?.confirmedClosedQuantity, "20");
  assert.equal(managedSignedDelta(result.instance.legs[1]!), "0");
});

test("Binance formal close passes a reduce-only managed slice through the real provider boundary", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "-15", formalVenue: "binance" });
  fixture.binanceService!.providerOrder = realPathBinanceOrder({ filledQuantity: 10, requestedQuantity: 10 });
  const result = await fixture.service.closeLeg("user-a", request("short-leg", "10", "formal-binance-reduce-only"));

  assert.equal(fixture.binanceService!.placeInputs[0]?.side, "Buy");
  assert.equal(fixture.binanceService!.placeInputs[0]?.quantity, "10");
  assert.equal(fixture.binanceService!.placeInputs[0]?.reduceOnly, true);
  assert.equal(result.instance.legs[1]?.confirmedClosedQuantity, "10");
  assert.equal(managedSignedDelta(result.instance.legs[1]!), "-10");
});

test("Binance close recovery rebuilds the runtime without a second provider place", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "-120", formalVenue: "binance" });
  fixture.binanceService!.providerOrder = realPathBinanceOrder({ status: "PartiallyFilled", filledQuantity: 10, requestedQuantity: 20 });
  const first = await fixture.service.closeLeg("user-a", request("short-leg", "20", "binance-recovery-close"));
  const placeCount = fixture.binanceService!.providerMutations;
  const firstExecutionId = executionIdOf(first.executionRecord);
  const persistedFirstRecord = fixture.binanceRecords!.loadForUser("user-a", firstExecutionId);
  assert.ok(persistedFirstRecord);
  fixture.binanceService!.providerOrder = { ...fixture.binanceService!.providerOrder, status: "Filled", filledQuantity: 20 };
  fixture.binanceService!.orders.push({
    idempotencyKey: binanceExecutionIdempotencyKeyFor(persistedFirstRecord),
    requestFingerprint: "recovery", clientOrderId: fixture.binanceService!.providerOrder.orderLinkId,
    providerOrderId: fixture.binanceService!.providerOrder.orderId, category: "linear", symbol: "BTCUSDT",
    executionMode: "production_ioc", status: "completed", order: fixture.binanceService!.providerOrder,
    error: null, cancelRequestedAt: null, cancelDispatchState: null, createdAt: now, updatedAt: now + 2_000,
  });
  const restartedRuntime = new BinanceFormalArbitrageExecutionRuntime(new BinanceIntentExecutionRuntime(
    new RealPathBinanceRegistry(fixture.binanceService!),
    { maxSlippageBps: 20 },
    fixture.binanceRecords!,
    { clock: () => now + 2_000 },
  ));
  const commands = new ArbitrageExecutionCommandService(
    {} as never, fixture.store, {} as never, fixture.binanceRecords!,
    new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("binance", restartedRuntime)),
    {} as never,
  );
  const recovered = await commands.reconcileLeg("user-a", { arbitrageId: fixture.arbitrageId, legId: "short-leg" });

  assert.equal(fixture.binanceService!.providerMutations, placeCount);
  assert.equal(recovered.executionRecord.executionId, first.executionRecord.executionId);
  assert.equal(recovered.executionRecord.intentId, first.executionRecord.intentId);
  assert.equal(recovered.instance.legs[1]?.confirmedClosedQuantity, "10");
  assert.equal(managedSignedDelta(recovered.instance.legs[1]!), "-10");
});

test("OKX formal close preserves CLOSING when the reversal crosses the current net", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "-10", formalVenue: "okx", longInstrumentId: "DOGE-USDT-PERP" });
  fixture.okxService!.providerOrder = {
    ...fixture.okxService!.providerOrder,
    status: "CONFIRMED", filledQuantity: "20", requestedQuantity: "20",
  };
  const result = await fixture.service.closeLeg("user-a", request("short-leg", "20", "formal-okx-d"));

  assert.equal(fixture.okxService!.placeRequests[0]?.side, "buy");
  assert.equal(fixture.okxService!.placeRequests[0]?.quantity, "200");
  assert.equal(fixture.okxService!.placeRequests[0]?.reduceOnly, false);
  assert.equal(fixture.okxService!.placeRequests[0]?.tdMode, "cross");
  assert.equal(fixture.okxService!.positionMode, "net_mode");
  assert.equal(fixture.okxService!.identityValidations, 1);
  assert.equal(result.instance.executionReferences.at(-1)?.phase, "CLOSING");
  assert.equal(result.instance.executionReferences.at(-1)?.quantityEffect, "DECREASE");
  assert.equal(result.instance.legs[1]?.confirmedClosedQuantity, "0");
  assert.equal(managedSignedDelta(result.instance.legs[1]!), "-20");
});

test("OKX close recovery reuses the persisted execution identity without a second place", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "-120", formalVenue: "okx", longInstrumentId: "DOGE-USDT-PERP" });
  fixture.okxService!.providerOrder = {
    ...fixture.okxService!.providerOrder,
    status: "CONFIRMED", requestedQuantity: "200", filledQuantity: "200",
  };
  const first = await fixture.service.closeLeg("user-a", request("short-leg", "20", "okx-recovery-close"));
  const placeCount = fixture.okxService!.placeRequests.length;
  const restartedRuntime = new OkxFormalArbitrageExecutionRuntime(new OkxIntentExecutionRuntime(
    new RealPathOkxRegistry(fixture.okxService!),
    fixture.okxRecords!,
    fixture.okxReferences!,
    {
      clock: () => now + 2_000,
      mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false }),
      quantityRulesSource: okxTestQuantityRulesSource(now),
    },
  ));
  const restartedRegistry = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("okx", restartedRuntime));
  const commands = new ArbitrageExecutionCommandService(
    {} as never,
    fixture.store,
    {} as never,
    fixture.okxRecords!,
    restartedRegistry,
    {} as never,
  );
  const recovered = await commands.reconcileLeg("user-a", {
    arbitrageId: fixture.arbitrageId,
    legId: "short-leg",
  });
  const replay = await fixture.service.closeLeg("user-a", request("short-leg", "20", "okx-recovery-close"));

  assert.equal(fixture.okxService!.placeRequests.length, placeCount);
  assert.equal(recovered.executionRecord.executionId, first.executionRecord.executionId);
  assert.equal(recovered.executionRecord.intentId, first.executionRecord.intentId);
  assert.equal(recovered.instance.legs[1]?.confirmedClosedQuantity, "20");
  assert.equal(managedSignedDelta(recovered.instance.legs[1]!), "0");
  assert.equal(replay.instance.legs[1]?.confirmedClosedQuantity, "20");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fixture.okxService!.getRequests.length, 1);
  assert.equal(fixture.okxService!.placeRequests[0]?.reduceOnly, true);
  assert.equal(fixture.okxService!.placeRequests[0]?.tdMode, "cross");
  const firstExecutionId = executionIdOf(first.executionRecord);
  assert.equal(fixture.okxReferences && (await fixture.okxReferences.loadForUser("user-a", firstExecutionId))?.clOrdId,
    fixture.okxService!.placeRequests[0]?.clOrdId);
  assert.equal((await fixture.okxReferences!.loadForUser("user-a", firstExecutionId))?.ordId, "8001");
});

test("partial SHORT close retains only the unfilled managed delta", async (t) => {
  const fixture = setup(t, { quantity: "20", actualSignedNetQuantity: "80" });
  fixture.runtime.resultStatus = "PENDING_CONFIRMATION";
  fixture.runtime.confirmedQuantity = "8";

  const result = await fixture.service.closeLeg("user-a", request("short-leg", "20", "short-partial"));

  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "20");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, false);
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "8");
  assert.equal(managedSignedDelta(result.instance.legs[1]), "-12");
});

test("both fully closed legs reach CLOSED without deleting the instance", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "1";
  await fixture.service.closeLeg("user-a", request("long-leg", "1", "close-long"));
  const closed = await fixture.service.closeLeg("user-a", request("short-leg", "1", "close-short"));

  assert.equal(closed.instance.status, "CLOSED");
  assert.equal(closed.instance.legs[0].confirmedClosedQuantity, "1");
  assert.equal(closed.instance.legs[1].confirmedClosedQuantity, "1");
  assert.ok(fixture.store.get("user-a", fixture.arbitrageId));
});

test("partial and UNKNOWN close retain Decimal evidence and remain reconcilable", async (t) => {
  const partial = setup(t);
  partial.runtime.resultStatus = "PENDING_CONFIRMATION";
  partial.runtime.confirmedQuantity = "0.12345678";
  const partialResult = await partial.service.closeLeg("user-a", request("long-leg", "0.5"));
  assert.equal(partialResult.executionRecord.confirmedQuantity, "0.12345678");
  assert.equal(partialResult.instance.legs[0].confirmedClosedQuantity, "0.12345678");
  assert.equal(partialResult.instance.status, "CLOSING");

  const unknown = setup(t);
  unknown.runtime.resultStatus = "UNKNOWN";
  unknown.runtime.confirmedQuantity = null;
  const unknownResult = await unknown.service.closeLeg("user-a", request("long-leg", "0.5"));
  assert.equal(unknownResult.executionRecord.status, "UNKNOWN");
  assert.equal(unknownResult.instance.legs[0].confirmedClosedQuantity, "0");
  assert.equal(unknownResult.instance.executionReferences.at(-1)?.status, "UNKNOWN");
});

test("unavailable snapshots and exact trading rules fail closed without using account ownership", async (t) => {
  const tooLarge = setup(t);
  await assert.rejects(
    () => tooLarge.service.closeLeg("user-a", request("long-leg", "1.1")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_quantity_unavailable",
  );

  const unavailable = setup(t);
  unavailable.verificationStatus = "UNKNOWN";
  await assert.rejects(
    () => unavailable.service.closeLeg("user-a", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "position_verification_unavailable",
  );

  const flat = setup(t);
  flat.actualQuantity = "0";
  flat.runtime.resultStatus = "CONFIRMED";
  flat.runtime.confirmedQuantity = "0.5";
  await flat.service.closeLeg("user-a", request("long-leg", "0.5"));

  const invalidStep = setup(t);
  await assert.rejects(
    () => invalidStep.service.closeLeg("user-a", request("long-leg", "0.00015")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_quantity_unavailable",
  );
  assert.equal(tooLarge.runtime.calls.length + invalidStep.runtime.calls.length, 0);
});

test("client cannot control side, reduceOnly, account, provider symbol, or another user's instance", async (t) => {
  const fixture = setup(t);
  for (const field of ["side", "reduceOnly", "accountId", "providerSymbol", "userId"]) {
    await assert.rejects(
      () => fixture.service.closeLeg("user-a", { ...request("long-leg", "0.5"), [field]: "malicious" }),
      /不允许的字段/u,
    );
  }
  await assert.rejects(
    () => fixture.service.closeLeg("user-b", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "arbitrage_instance_not_found",
  );
  assert.equal(fixture.runtime.calls.length, 0);
});

test("Spot LONG close is authoritative SELL DECREASE without provider reduceOnly", async (t) => {
  const spot = setup(t, { longInstrumentId: "BTC-USDT-SPOT" });
  spot.runtime.resultStatus = "CONFIRMED";
  spot.runtime.confirmedQuantity = "0.5";
  const result = await spot.service.closeLeg("user-a", request("long-leg", "0.5"));
  assert.equal(spot.runtime.calls[0]?.side, "sell");
  assert.equal(spot.runtime.calls[0]?.orderConstraints.reduceOnly, false);
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.5");
  assert.equal(result.instance.executionReferences.at(-1)?.quantityEffect, "DECREASE");
});

test("Spot and perpetual legs both flat reach CLOSED", async (t) => {
  const fixture = setup(t, { longInstrumentId: "BTC-USDT-SPOT" });
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "1";
  await fixture.service.closeLeg("user-a", request("long-leg", "1", "close-spot"));
  const result = await fixture.service.closeLeg("user-a", request("short-leg", "1", "close-perp"));
  assert.equal(result.instance.status, "CLOSED");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "1");
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "1");
});

test("Spot partial fill only decreases the authoritative confirmed Decimal quantity", async (t) => {
  const fixture = setup(t, { longInstrumentId: "BTC-USDT-SPOT" });
  fixture.runtime.resultStatus = "PENDING_CONFIRMATION";
  fixture.runtime.confirmedQuantity = "0.12345678";
  const result = await fixture.service.closeLeg("user-a", request("long-leg", "0.5", "partial-spot"));
  assert.equal(result.executionRecord.confirmedQuantity, "0.12345678");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.12345678");
  assert.equal(result.instance.status, "CLOSING");
});

test("Spot close requires the requested quantity to be covered by available base balance", async (t) => {
  const spot = setup(t, { longInstrumentId: "BTC-USDT-SPOT" });
  spot.availableBaseQuantity = "0.99999999";
  await assert.rejects(
    () => spot.service.closeLeg("user-a", request("long-leg", "1")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_quantity_unavailable",
  );
  assert.equal(spot.runtime.calls.length, 0);
});

test("DOGE Spot close uses base-commission attribution without borrowing unrelated balance and remains recoverably closable", async (t) => {
  const fixture = setup(t, {
    longInstrumentId: "DOGE-USDT-SPOT",
    quantity: "73",
    quantityStep: "1",
    minQuantity: "72",
    availableBaseQuantity: "73.855",
    attributableBaseQuantity: "72.927",
  });

  await assert.rejects(
    () => fixture.service.closeLeg("user-a", request("long-leg", "73", "unsafe-spot-close")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_quantity_unavailable",
  );
  assert.equal(fixture.runtime.calls.length, 0);

  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "72";
  const spot = await fixture.service.closeLeg("user-a", request("long-leg", "72", "safe-spot-close"));
  assert.equal(fixture.runtime.calls[0]?.side, "sell");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, false);
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "72");
  assert.equal(spot.instance.maxResidualBaseQuantity, "1");
  assert.equal(managedCurrentQuantity(spot.instance.legs[0]), "1");
  assert.equal(spot.instance.status, "RESIDUAL");

  fixture.runtime.confirmedQuantity = "73";
  const closed = await fixture.service.closeLeg("user-a", request("short-leg", "73", "perp-close"));
  assert.equal(fixture.runtime.calls[1]?.side, "buy");
  assert.equal(fixture.runtime.calls[1]?.orderConstraints.reduceOnly, true);
  assert.equal(fixture.runtime.calls[1]?.quantity.quantity, "73");
  assert.equal(closed.instance.status, "CLOSED");
  assert.deepEqual(closed.instance.legs.map(managedCurrentQuantity), ["1", "0"]);
});

test("accepted DOGE Spot residual never permits a partial perpetual close to reach CLOSED", async (t) => {
  const fixture = setup(t, {
    longInstrumentId: "DOGE-USDT-SPOT",
    quantity: "73",
    quantityStep: "1",
    minQuantity: "72",
    availableBaseQuantity: "73.855",
    attributableBaseQuantity: "72.927",
  });
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "72";

  await fixture.service.closeLeg("user-a", request("long-leg", "72", "safe-spot-close-partial-perp"));
  const result = await fixture.service.closeLeg("user-a", request("short-leg", "73", "partial-perp-close"));

  assert.equal(fixture.runtime.calls[1]?.side, "buy");
  assert.equal(fixture.runtime.calls[1]?.orderConstraints.reduceOnly, true);
  assert.equal(fixture.runtime.calls[1]?.quantity.quantity, "73");
  assert.equal(result.instance.status, "RESIDUAL");
  assert.deepEqual(result.instance.legs.map(managedCurrentQuantity), ["1", "1"]);
});

test("Spot commission paid in quote or BNB leaves gross base quantity attributable", async (t) => {
  for (const commissionAsset of ["USDT", "BNB"]) {
    const fixture = setup(t, {
      longInstrumentId: "DOGE-USDT-SPOT",
      quantity: "73",
      quantityStep: "1",
      minQuantity: "1",
      availableBaseQuantity: "73.928",
      attributableBaseQuantity: "73",
    });
    fixture.runtime.resultStatus = "CONFIRMED";
    fixture.runtime.confirmedQuantity = "73";

    const result = await fixture.service.closeLeg("user-a", request("long-leg", "73", `quote-fee-${commissionAsset}`));

    assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "73");
    assert.equal(managedCurrentQuantity(result.instance.legs[0]), "0");
  }
});

test("unknown Spot opening commission fails closed before runtime", async (t) => {
  const fixture = setup(t, { longInstrumentId: "DOGE-USDT-SPOT", attributionError: true });
  await assert.rejects(
    () => fixture.service.closeLeg("user-a", request("long-leg", "1")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "position_verification_unavailable",
  );
  assert.equal(fixture.runtime.calls.length, 0);
});

test("a one-step residual that still satisfies current rules remains RESIDUAL", async (t) => {
  const fixture = setup(t, {
    longInstrumentId: "BTC-USDT-SPOT",
    quantity: "2",
    quantityStep: "1",
    minQuantity: "1",
    attributableBaseQuantity: "2",
    availableBaseQuantity: "2",
  });
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "1";
  const spot = await fixture.service.closeLeg("user-a", request("long-leg", "1", "tradable-spot-residual"));
  assert.equal(spot.instance.maxResidualBaseQuantity, "0");
  assert.equal(spot.instance.status, "RESIDUAL");

  fixture.runtime.confirmedQuantity = "2";
  const afterPerp = await fixture.service.closeLeg("user-a", request("short-leg", "2", "tradable-perp-close"));
  assert.equal(afterPerp.instance.status, "RESIDUAL");
  assert.deepEqual(afterPerp.instance.legs.map(managedCurrentQuantity), ["1", "0"]);
});

test("unsupported venues fail closed before provider mutation", async (t) => {
  const venue = setup(t, { longVenue: "okx" });
  await assert.rejects(
    () => venue.service.closeLeg("user-a", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_capability_unavailable",
  );
  assert.equal(venue.runtime.calls.length, 0);
});

test("duplicate and concurrent close commands cause one runtime mutation", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "0.5";
  fixture.runtime.delay = true;
  const close = request("long-leg", "0.5");
  const [first, replay] = await Promise.all([
    fixture.service.closeLeg("user-a", close),
    fixture.service.closeLeg("user-a", close),
  ]);

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal([first.idempotentReplay, replay.idempotentReplay].filter(Boolean).length, 1);
  assert.equal(fixture.store.get("user-a", fixture.arbitrageId)?.legs[0].confirmedClosedQuantity, "0.5");
  const third = await fixture.service.closeLeg("user-a", close);
  assert.equal(third.idempotentReplay, true);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("concurrent distinct commands cannot claim overlapping closes for the same leg", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "0.5";
  fixture.runtime.delay = true;
  const outcomes = await Promise.allSettled([
    fixture.service.closeLeg("user-a", request("long-leg", "0.5", "close-a")),
    fixture.service.closeLeg("user-a", request("long-leg", "0.5", "close-b")),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.store.get("user-a", fixture.arbitrageId)?.legs[0].confirmedClosedQuantity, "0.5");
});

function setup(
  t: TestContext,
  options: Readonly<{
    longInstrumentId?: "BTC-USDT-SPOT" | "BTC-USDT-PERP" | "DOGE-USDT-SPOT" | "DOGE-USDT-PERP";
    longVenue?: "binance" | "okx";
    quantity?: string;
    quantityStep?: string;
    minQuantity?: string;
    availableBaseQuantity?: string;
    attributableBaseQuantity?: string;
    attributionError?: boolean;
    actualSignedNetQuantity?: string;
    formalVenue?: "binance" | "okx";
  }> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "stellax-close-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ArbitrageInstanceStore({ dbPath: join(directory, "trading.sqlite") });
  const arbitrageId = "arbitrage-close-1";
  const quantity = options.quantity ?? "1";
  store.create({
    arbitrageId,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "source-1",
    maxResidualBaseQuantity: "0",
    createdAt: now - 20,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: options.longVenue ?? options.formalVenue ?? "binance",
        accountId: "account-a",
        instrumentId: options.longInstrumentId ?? "BTC-USDT-PERP",
        plannedQuantity: quantity,
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: options.formalVenue ?? "binance",
        accountId: "account-a",
        instrumentId: options.longInstrumentId?.startsWith("DOGE-") ? "DOGE-USDT-PERP" : "BTC-USDT-PERP",
        plannedQuantity: quantity,
      },
    ],
  });
  openLeg(store, arbitrageId, "long-leg", quantity, now - 18);
  openLeg(store, arbitrageId, "short-leg", quantity, now - 14);

  const runtime = new FakeRuntime();
  const binanceService = options.formalVenue === "binance" ? new RealPathBinanceService() : undefined;
  const okxService = options.formalVenue === "okx" ? new RealPathOkxService() : undefined;
  const binanceRecords = options.formalVenue === "binance" ? new RealPathExecutionRecordStore() : undefined;
  const okxRecords = options.formalVenue === "okx" ? new RealPathExecutionRecordStore() : undefined;
  const okxReferences = options.formalVenue === "okx" ? new InMemoryOkxExecutionOrderReferenceStore() : undefined;
  const formalRuntime = options.formalVenue === "binance"
    ? new BinanceFormalArbitrageExecutionRuntime(new BinanceIntentExecutionRuntime(
        new RealPathBinanceRegistry(binanceService!),
        { maxSlippageBps: 20 },
        binanceRecords!,
        { clock: () => now + 1_000, createExecutionId: () => `binance-close-${options.formalVenue}` },
      ))
    : options.formalVenue === "okx"
      ? new OkxFormalArbitrageExecutionRuntime(new OkxIntentExecutionRuntime(
          new RealPathOkxRegistry(okxService!),
          okxRecords!,
          okxReferences!,
          {
            clock: () => now + 1_000,
            createExecutionId: () => `okx-close-${options.formalVenue}`,
            mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false }),
            quantityRulesSource: okxTestQuantityRulesSource(now),
          },
        ))
      : runtime;
  const runtimes = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime(options.formalVenue ?? "binance", formalRuntime));
  const fixture = {
    verificationStatus: "MATCHED" as "MATCHED" | "MISMATCH" | "UNKNOWN",
    actualQuantity: quantity as string | null,
    actualSignedNetQuantity: options.actualSignedNetQuantity,
    availableBaseQuantity: options.availableBaseQuantity ?? quantity,
    attributableBaseQuantity: options.attributableBaseQuantity ?? quantity,
    attributionError: options.attributionError ?? false,
  };
  let closeClock = now;
  const service = new ArbitrageExecutionCloseService(
    store,
    {
      verify: async () => {
        const current = store.get("user-a", arbitrageId)!;
        return {
          arbitrageId,
          checkedAt: now,
          legs: current.legs.map((leg) => ({
            arbitrageId,
            legId: leg.legId,
            expectedManagedQuantity: managedCurrentQuantity(leg),
            actualQuantity: fixture.actualQuantity,
            actualSignedNetQuantity: fixture.actualSignedNetQuantity
              ?? (leg.role === "SHORT" ? `-${fixture.actualQuantity}` : fixture.actualQuantity),
            verificationStatus: fixture.verificationStatus,
            checkedAt: now,
          })) as any,
        };
      },
    },
    {
      load: async (_venue, instrumentId) => ({
        instrument: {
          instrumentId,
          providerSymbol: instrumentId.startsWith("DOGE-") ? "DOGEUSDT" : "BTCUSDT",
          baseAsset: createAsset({ symbol: instrumentId.startsWith("DOGE-") ? "DOGE" : "BTC", type: "DIGITAL_ASSET" }),
          quoteAsset: "USDT",
          settlementAsset: "USDT",
          marketType: instrumentId.endsWith("-SPOT") ? "spot" : "perpetual",
          contractType: instrumentId.endsWith("-SPOT") ? "spot" : "linear_perpetual",
          quantityUnit: "base",
          status: "trading",
        },
        tradingRules: createTradingRules({
          quantityStep: options.quantityStep ?? "0.0001",
          minQuantity: options.minQuantity ?? "0.0001",
          priceTick: "0.01",
          minNotional: "1",
          contractSize: "1",
          precision: { quantity: instrumentId.startsWith("DOGE-") ? 0 : 4, price: 2 },
        }),
        quote: { bid: instrumentId.startsWith("DOGE-") ? "0.07" : "60000", ask: instrumentId.startsWith("DOGE-") ? "0.071" : "60001", fetchedAt: now },
      }),
    },
    {
      readAvailableBalance: async (_userId, input) => {
        assert.equal(input.accountId, "account-a");
        assert.equal(input.providerSymbol, options.longInstrumentId?.startsWith("DOGE-") ? "DOGEUSDT" : "BTCUSDT");
        assert.equal(input.baseAsset, options.longInstrumentId?.startsWith("DOGE-") ? "DOGE" : "BTC");
        return { availableQuantity: fixture.availableBaseQuantity, checkedAt: now };
      },
    },
    {
      readAttributableBaseQuantity: async (_userId, input) => {
        if (fixture.attributionError) throw new Error("commission unavailable");
        assert.equal(input.accountId, "account-a");
        assert.equal(input.grossConfirmedQuantity, quantity);
        return fixture.attributableBaseQuantity;
      },
    },
    runtimes,
    { clock: () => closeClock += 10, createIntentId: (_user, _arbitrage, leg, command) => `close-${leg}-${command}` },
  );
  return Object.assign(fixture, { service, store, runtime, arbitrageId, binanceService, binanceRecords, okxService, okxRecords, okxReferences, formalRuntime });
}

function openLeg(store: ArbitrageInstanceStore, arbitrageId: string, legId: string, quantity: string, timestamp: number) {
  const intentId = `opening-${legId}`;
  store.claimExecutionReference("user-a", arbitrageId, {
    legId,
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: intentId,
    requestedQuantity: quantity,
    createdAt: timestamp,
  });
  store.linkExecutionRecord("user-a", arbitrageId, intentId, `record-${legId}`, timestamp + 1);
  store.applyExecutionResult("user-a", arbitrageId, {
    executionIntentId: intentId,
    status: "CONFIRMED",
    confirmedQuantity: quantity,
    updatedAt: timestamp + 2,
  });
}

function request(legId: string, quantity: string, commandId = "close-command") {
  return {
    arbitrageId: "arbitrage-close-1",
    legId,
    commandId,
    quantity,
    executionMode: "EXECUTION_PRIORITY" as const,
    confirmed: true,
  };
}

function executionIdOf(record: Readonly<{ executionId: string | null }>) {
  assert.ok(record.executionId, "close execution must have a persisted execution identity");
  return record.executionId;
}

class FakeRuntime implements FormalExecutionRuntime {
  readonly calls: import("../cex/ExecutionIntent").ExecutionIntent[] = [];
  resultStatus: ExecutionRecord["status"] = "CONFIRMED";
  confirmedQuantity: string | null = "0.5";
  delay = false;

  async execute(intent: import("../cex/ExecutionIntent").ExecutionIntent) {
    this.calls.push(intent);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      executionRecord: createExecutionRecord({
        executionId: `record-${intent.intentId}`,
        intentId: intent.intentId,
        userId: intent.userId,
        venue: intent.venue,
        accountId: intent.accountId,
        instrumentId: intent.instrumentId,
        status: this.resultStatus,
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt + 1,
      }),
      confirmedQuantity: this.confirmedQuantity,
    };
  }

  async reconcile(): ReturnType<FormalExecutionRuntime["reconcile"]> {
    throw new Error("not used");
  }

  async cancel(): ReturnType<FormalExecutionRuntime["cancel"]> {
    throw new Error("not used");
  }
}

class RealPathExecutionRecordStore {
  readonly records = new Map<string, ExecutionRecord>();
  create(record: ExecutionRecord) { this.records.set(`${record.userId}\0${record.executionId}`, record); }
  update(record: ExecutionRecord) { this.records.set(`${record.userId}\0${record.executionId}`, record); }
  loadForUser(userId: string, executionId: string) { return this.records.get(`${userId}\0${executionId}`) ?? null; }
  findByIntentId(intentId: string) { return [...this.records.values()].filter((record) => record.intentId === intentId); }
}

class RealPathBinanceRegistry implements BinanceIntentExecutionRuntimeRegistry {
  constructor(private readonly service: RealPathBinanceService) {}
  async run<T>(_userId: string, operation: (service: RealPathBinanceService) => Promise<T> | T) { return operation(this.service); }
}

class RealPathBinanceService {
  readonly placeInputs: BinanceOrderInput[] = [];
  providerOrder: BinanceProviderOrder = realPathBinanceOrder();
  readonly orders: BinanceStoredOrder[] = [];
  readonly isolatedOrders: BinanceStoredOrderIsolation[] = [];
  providerMutations = 0;
  async executionAccountIdentity() {
    const snapshot = await this.account();
    return {
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      uidSnapshot: "test-uid",
      accountMode: "single_asset_one_way" as const,
      ipWhitelistVerificationMode: "provider_list_exact" as const,
      permissions: snapshot.permissions,
    };
  }
  async account() { return snapshotFixture({ accountId: "account-a" }); }
  async loadExecutionReadContext(instrumentId: string): Promise<BinanceGenericExecutionContext> {
    return realPathBinanceContext(instrumentId);
  }
  async placeExecutionOrder(input: BinanceOrderInput) {
    this.placeInputs.push(input); this.providerMutations += 1;
    this.providerOrder = {
      ...this.providerOrder,
      symbol: input.symbol,
      orderLinkId: input.idempotencyKey,
      requestedQuantity: Number(input.quantity),
      requestedBaseQuantity: input.quantity,
    };
    return this.providerOrder;
  }
  executionOrderState(idempotencyKey: string) {
    const order = this.orders.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    return order ? { kind: "found" as const, order } : { kind: "missing" as const };
  }
  async findExecutionOrderByClientOrderId() { return this.providerOrder; }
  async cancelOrder() { this.providerMutations += 1; return this.providerOrder; }
}

function realPathBinanceOrder(overrides: Partial<BinanceProviderOrder> = {}): BinanceProviderOrder {
  return {
    symbol: "BTCUSDT", orderId: "real-path-binance-1", orderLinkId: "real-path-binance-client-1",
    status: "Filled", requestedQuantity: 1, filledQuantity: 1, averagePrice: 60_000, feeUsd: 0,
    updatedAt: now + 1_000, ...overrides,
  };
}

function realPathBinanceContext(instrumentId: string): BinanceGenericExecutionContext {
  return Object.freeze({
    instrument: Object.freeze({
      instrumentId, venue: "binance" as const, providerSymbol: "BTCUSDT",
      baseAsset: { symbol: "BTC", type: "DIGITAL_ASSET" as const }, quoteAsset: "USDT",
      settlementAsset: "USDT", marketType: "perpetual" as const,
      contractType: "linear_perpetual" as const, quantityUnit: "base" as const,
      contractSize: "1" as const, status: "trading" as const,
    }),
    tradingRules: Object.freeze({
      quantityStep: "0.0001", minQuantity: "0.0001", priceTick: "0.1", minNotional: "1",
      precision: Object.freeze({ quantity: 4, price: 1 }),
    }),
    quote: Object.freeze({ bid: "60000", ask: "60001", fetchedAt: now }),
  });
}

class RealPathOkxRegistry {
  constructor(private readonly service: RealPathOkxService) {}
  async run<T>(_userId: string, operation: (service: RealPathOkxService) => Promise<T> | T) { return operation(this.service); }
}

class RealPathOkxService {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  providerOrder: OkxProviderOrder = {
    instId: "DOGE-USDT-SWAP", ordId: "8001", clOrdId: "testclord", status: "CONFIRMED",
    statusReason: null, rawState: "filled", requestedQuantity: "20", filledQuantity: "20",
    averagePrice: "1", fee: "0", updatedAt: now + 1_000,
  };
  providerMutations = 0;
  readonly positionMode = "net_mode" as const;
  identityValidations = 0;
  executionAccountIdentity() { return { accountId: "account-a" }; }
  validateExecutionProviderIdentity() { this.identityValidations += 1; }
  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request); this.providerMutations += 1;
    return { instId: request.instId, ordId: this.providerOrder.ordId, clOrdId: request.clOrdId };
  }
  async getOrder(request: OkxGetOrderRequest) {
    this.getRequests.push(request);
    return { ...this.providerOrder, instId: request.instId, ordId: request.ordId ?? this.providerOrder.ordId, clOrdId: request.clOrdId ?? this.providerOrder.clOrdId };
  }
  async cancelOrder(request: OkxGetOrderRequest): Promise<OkxCancelOrderResult> {
    this.providerMutations += 1; return { instId: request.instId, ordId: this.providerOrder.ordId, clOrdId: request.clOrdId ?? this.providerOrder.clOrdId };
  }
}
