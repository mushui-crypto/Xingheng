import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAsset } from "../cex/Asset";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ExecutionIntent, ExecutionVenue } from "../cex/ExecutionIntent";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";
import type { ArbitrageExecutionDraft } from "./ArbitrageExecutionDraft";
import {
  ArbitrageExecutionCommandError,
  ArbitrageExecutionCommandService,
} from "./ArbitrageExecutionCommandService";
import type { FormalExecutionRuntime } from "./FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistry,
  formalExecutionRuntime,
} from "./FormalExecutionRuntimeRegistry";

const now = 1_800_000_000_000;

test("final confirmation replans authoritatively, creates both real legs, and is idempotent", async (t) => {
  const fixture = setup(t);
  const request = finalRequest();

  const first = await fixture.service.confirm("user-a", request);
  const replay = await fixture.service.confirm("user-a", request);

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.instance.arbitrageId, first.instance.arbitrageId);
  assert.equal(first.instance.status, "OPENING");
  assert.deepEqual(first.instance.legs.map((leg) => ({
    role: leg.role,
    venue: leg.venue,
    instrumentId: leg.instrumentId,
    plannedQuantity: leg.plannedQuantity,
  })), [
    { role: "LONG", venue: "binance", instrumentId: "BTC-USDT-SPOT", plannedQuantity: "0.001" },
    { role: "SHORT", venue: "binance", instrumentId: "BTC-USDT-PERP", plannedQuantity: "0.001" },
  ]);
  assert.equal(fixture.drafts.calls.length, 2);
  assert.equal(fixture.runtime.calls.length, 0);
});

test("capability failure and stale replanning fail closed before provider mutation", async (t) => {
  const unavailable = setup(t, { draft: draft(false) });
  await assert.rejects(
    () => unavailable.service.confirm("user-a", finalRequest()),
    /未同时满足执行能力/u,
  );
  assert.equal(unavailable.store.listActive("user-a").length, 0);
  assert.equal(unavailable.runtime.calls.length, 0);

  const stale = setup(t);
  const created = await stale.service.confirm("user-a", finalRequest());
  stale.drafts.value = draft(true, "0.002");
  await assert.rejects(
    () => stale.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg")),
    /不一致/u,
  );
  assert.equal(stale.runtime.calls.length, 0);
  assert.equal(stale.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 0);
  assert.equal(stale.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
});

test("claim failure without a persisted reference closes the empty opening instance and preserves the claim error", async (t) => {
  const fixture = setup(t, { claimFailure: "before" });
  const created = await fixture.service.confirm("user-a", finalRequest());

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg")),
    /synthetic claim failure/u,
  );
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 0);
  const restarted = fixture.restart();
  assert.equal(restarted.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
});

test("claim conflict from another instance closes only the still-empty current instance", async (t) => {
  const fixture = setup(t, { createIntentId: () => "shared-claim-intent" });
  const current = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "current" }));
  const other = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "other" }));
  fixture.store.claimExecutionReference("user-a", other.instance.arbitrageId, {
    legId: "long-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: "shared-claim-intent",
    requestedQuantity: "0.001",
    createdAt: now,
  });

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(current.instance.arbitrageId, "long-leg")),
    /already claimed/u,
  );
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", current.instance.arbitrageId)?.status, "FAILED");
  assert.equal(fixture.store.get("user-a", other.instance.arbitrageId)?.status, "OPENING");
  assert.equal(fixture.store.get("user-a", other.instance.arbitrageId)?.executionReferences.length, 1);
});

test("claim failure with a raced persisted reference never cleans up", async (t) => {
  const fixture = setup(t, { claimFailure: "after" });
  const created = await fixture.service.confirm("user-a", finalRequest());

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg"),
  );
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(result.idempotentReplay, true);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "OPENING");
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 1);
});

test("NOTIONAL_USDT allows normal execution quantity drift while preserving the confirmed budget", async (t) => {
  const fixture = setup(t, { draft: notionalDraft("100", "100", "8") });
  const created = await fixture.service.confirm("user-a", finalRequest({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" },
  }));
  fixture.drafts.value = notionalDraft("90", "90", "8");
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);

  const result = await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    "notional-drift",
    { quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" } },
  ));

  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "90");
  assert.equal(result.instance.legs[0].plannedQuantity, "100");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "90");
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("NOTIONAL_USDT rejects an execution plan that exceeds the confirmed budget", async (t) => {
  const fixture = setup(t, { draft: notionalDraft("100", "100", "8") });
  const created = await fixture.service.confirm("user-a", finalRequest({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" },
  }));
  fixture.drafts.value = notionalDraft("120", "120", "9");

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "long-leg",
      "notional-over-budget",
      { quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" } },
    )),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "execution_capability_unavailable",
  );
  assert.equal(fixture.runtime.calls.length, 0);
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
});

test("BASE_QUANTITY remains frozen when the latest quote changes", async (t) => {
  const fixture = setup(t, { draft: draft(true, "100") });
  const created = await fixture.service.confirm("user-a", finalRequest({
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
  }));
  fixture.drafts.value = draft(true, "90");

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "long-leg",
      "base-quantity-drift",
      { quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" } },
    )),
    /不一致/u,
  );
  assert.equal(fixture.runtime.calls.length, 0);
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
});

test("NOTIONAL_USDT keeps identity checks strict while ignoring only planned quantity drift", async (t) => {
  const scenarios = [
    {
      name: "target notional",
      request: { quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "10" } },
      draft: notionalDraft("100", "100", "8"),
    },
    {
      name: "strategy",
      request: { quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" } },
      draft: { ...notionalDraft("100", "100", "8"), strategyType: "PERPETUAL_PERPETUAL" as const },
    },
    {
      name: "instrument",
      request: { quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" } },
      draft: {
        ...notionalDraft("100", "100", "8"),
        legs: [
          { ...notionalDraft("100", "100", "8").legs[0], instrumentId: "ETH-USDT-SPOT" },
          notionalDraft("100", "100", "8").legs[1],
        ],
      },
    },
    {
      name: "side",
      request: { quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" } },
      draft: {
        ...notionalDraft("100", "100", "8"),
        legs: [notionalDraft("100", "100", "8").legs[0], {
          ...notionalDraft("100", "100", "8").legs[1],
          side: "buy" as const,
        }],
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (child) => {
      const fixture = setup(child, { draft: notionalDraft("100", "100", "8") });
      const created = await fixture.service.confirm("user-a", finalRequest({
        confirmationId: `notional-identity-${scenario.name}`,
        quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" },
      }));
      fixture.drafts.value = scenario.draft;

      await assert.rejects(
        () => fixture.service.executeLeg("user-a", legRequest(
          created.instance.arbitrageId,
          "long-leg",
          `notional-identity-${scenario.name}`,
          { confirmationId: `notional-identity-${scenario.name}`, ...scenario.request },
        )),
        /不一致/u,
      );
      assert.equal(fixture.runtime.calls.length, 0);
      assert.equal(fixture.runtime.providerMutations, 0);
      assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
    });
  }
});

test("pre-mutation planning failure closes an empty OPENING instance without a reference", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.drafts.value = planningFailureDraft();

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg")),
    /未同时满足执行能力/u,
  );
  assert.equal(fixture.runtime.calls.length, 0);
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 0);
  assert.equal(fixture.store.listActive("user-a").length, 0);
  assert.equal(fixture.store.listHistory("user-a").length, 1);
});

test("an unregistered formal runtime fails closed before claiming an execution reference", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  const service = fixture.createService(new FormalExecutionRuntimeRegistry());

  await assert.rejects(
    () => service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg")),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "execution_capability_unavailable",
  );
  assert.equal(fixture.runtime.calls.length, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.status, "FAILED");
});

test("an eligible OKX Draft leg enters the registered OKX Formal runtime", async (t) => {
  const fixture = setup(t, {
    draft: draft(true, "0.001", ["binance", "okx"]),
    runtimeVenues: ["binance", "okx"],
    credentialVenues: ["binance", "okx"],
  });
  const created = await fixture.service.confirm("user-a", finalRequest());

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg"),
  );

  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.venue, "okx");
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("user-selected first leg claims before runtime and confirmed result updates managed quantity", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => {
    const claimed = fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences[0];
    assert.equal(claimed?.status, "CLAIMED");
    assert.equal(claimed?.executionIntentId, intent.intentId);
    return runtimeResult(intent, "CONFIRMED", "0.001");
  };

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg"),
  );

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.arbitrageId, created.instance.arbitrageId);
  assert.equal(fixture.runtime.calls[0]?.legId, "short-leg");
  assert.equal(fixture.runtime.calls[0]?.side, "sell");
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "0.001");
  assert.equal(result.instance.legs[1].confirmedOpenedQuantity, "0.001");
  assert.equal(result.instance.status, "RESIDUAL");
  assert.equal(result.secondLegAllowed, true);
  assert.equal(result.executionRecord.status, "CONFIRMED");
});

test("partial first leg is retained as RESIDUAL and never enables or auto-runs the second leg", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0004");

  const partial = await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  assert.equal(partial.instance.status, "RESIDUAL");
  assert.equal(partial.instance.legs[0].confirmedOpenedQuantity, "0.0004");
  assert.equal(partial.secondLegAllowed, false);
  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-command")),
    /第一腿尚未完整确认/u,
  );
  assert.equal(fixture.runtime.calls.length, 1);
});

test("cancelled-with-partial fill remains FAILED execution evidence with managed residual exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.0002");

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg"),
  );

  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.executionRecord.confirmedQuantity, "0.0002");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0.0002");
  assert.equal(result.instance.status, "RESIDUAL");
  assert.equal(result.secondLegAllowed, false);
});

test("FAILED and UNKNOWN first-leg facts preserve the instance and block the second leg", async (t) => {
  for (const status of ["FAILED", "UNKNOWN"] as const) {
    const fixture = setup(t);
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `confirmation-${status}` }));
    fixture.runtime.onExecute = (intent) => runtimeResult(intent, status, "0");
    const first = await fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "long-leg",
      `command-${status}`,
      { confirmationId: `confirmation-${status}` },
    ));
    assert.ok(fixture.store.get("user-a", created.instance.arbitrageId));
    assert.equal(first.instance.status, "OPENING");
    assert.equal(first.secondLegAllowed, false);
    assert.equal(first.instance.executionReferences[0]?.status, status);
    await assert.rejects(
      () => fixture.service.executeLeg("user-a", legRequest(
        created.instance.arbitrageId,
        "short-leg",
        `second-${status}`,
        { confirmationId: `confirmation-${status}` },
      )),
      /第一腿尚未完整确认/u,
    );
  }
});

test("unattributable UNKNOWN result preserves zero evidence without fabricating a fill", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg"),
  );

  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.executionRecord.confirmedQuantity, "0");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(result.secondLegAllowed, false);
});

test("the second leg requires a separate command and both confirmed legs reach HOLDING", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");

  const first = await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  assert.equal(first.secondLegAllowed, true);
  assert.equal(fixture.runtime.calls.length, 1);
  const second = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg", "second-command"),
  );
  assert.equal(fixture.runtime.calls.length, 2);
  assert.equal(second.instance.status, "HOLDING");
  assert.equal(second.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(second.instance.legs[1].confirmedOpenedQuantity, "0.001");
});

test("second leg uses confirmed first-leg exposure instead of a drifted latest budget plan", async (t) => {
  const fixture = setup(t, {
    draft: draftWithLegQuantities("114.711786", "110"),
    spotExposure: "114.597074",
    planningContext: (venue, instrumentId, current) => ({
      instrument: {
        instrumentId,
        providerSymbol: current.planning.status === "PLANNED" ? current.planning.plan.providerSymbol : "",
        baseAsset: current.planning.status === "PLANNED"
          ? current.planning.plan.plannedAssetQuantity.asset
          : createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }),
        quoteAsset: "USDT",
        settlementAsset: "USDT",
        marketType: "perpetual",
        contractType: "linear_perpetual",
        quantityUnit: "contract",
        status: "trading",
      },
      tradingRules: {
        quantityStep: "1",
        minQuantity: "1",
        contractSize: "10",
        priceTick: "0.1",
        minNotional: "5",
        precision: {},
      },
      quote: { bid: "0.069", ask: "0.07", fetchedAt: now },
    }),
  });
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.drafts.value = draftWithLegQuantities("111", "110");

  const second = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg", "second-command"),
  );

  assert.equal(fixture.runtime.calls[1]?.quantity.quantity, "110");
  assert.equal(second.instance.executionReferences[0]?.confirmedQuantity, "114.711786");
  assert.equal(second.instance.legs[0].confirmedOpenedQuantity, "114.597074");
  assert.equal(second.instance.legs[0].plannedQuantity, "114.597074");
  assert.equal(second.instance.legs[1].plannedQuantity, "110");
  assert.equal(second.instance.legs[1].confirmedOpenedQuantity, "110");
  assert.equal(second.instance.maxResidualBaseQuantity, "4.597074");
  assert.equal(second.instance.status, "HOLDING");
  assert.equal(fixture.drafts.calls.length, 2, "second leg must not rerun the original budget preview");
  assert.equal(fixture.drafts.createCalls.length, 1, "second leg still revalidates Draft identity and capability");
});

test("restart reuses a prepared second-leg hedge instead of replanning with changed venue rules", async (t) => {
  let rulesReads = 0;
  const fixture = setup(t, {
    draft: draftWithLegQuantities("114.711786", "110"),
    spotExposure: "114.597074",
    planningContext: (_venue, instrumentId, current) => {
      rulesReads += 1;
      return {
        instrument: {
          instrumentId,
          providerSymbol: current.planning.status === "PLANNED" ? current.planning.plan.providerSymbol : "",
          baseAsset: current.planning.status === "PLANNED"
            ? current.planning.plan.plannedAssetQuantity.asset
            : createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }),
          quoteAsset: "USDT",
          settlementAsset: "USDT",
          marketType: "perpetual",
          contractType: "linear_perpetual",
          quantityUnit: "contract",
          status: "trading",
        },
        tradingRules: {
          quantityStep: "1",
          minQuantity: "1",
          contractSize: "20",
          priceTick: "0.1",
          minNotional: "5",
          precision: {},
        },
        quote: { bid: "0.069", ask: "0.07", fetchedAt: now },
      };
    },
  });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "restart-hedge" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    "first-command",
    { confirmationId: "restart-hedge" },
  ));
  const firstReference = fixture.store.get("user-a", created.instance.arbitrageId)!.executionReferences[0]!;
  fixture.store.prepareSecondLegHedge("user-a", created.instance.arbitrageId, {
    firstExecutionIntentId: firstReference.executionIntentId,
    secondLegId: "short-leg",
    targetBaseQuantity: "114.597074",
    executableBaseQuantity: "110",
    updatedAt: now + 1,
  });

  const restarted = fixture.restart();
  const result = await restarted.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "short-leg",
    "second-command",
    { confirmationId: "restart-hedge" },
  ));

  assert.equal(rulesReads, 0, "recovery must not reload rules to replace the frozen executable quantity");
  assert.equal(fixture.runtime.calls.length, 2, "recovery must execute the second leg exactly once");
  assert.equal(fixture.runtime.calls[1]?.quantity.quantity, "110");
  assert.equal(result.instance.legs[0].plannedQuantity, "114.597074");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "114.597074");
  assert.equal(result.instance.legs[1].plannedQuantity, "110");
  assert.equal(result.instance.maxResidualBaseQuantity, "4.597074");
  assert.equal(result.instance.status, "HOLDING");
});

test("second-leg hedge below the venue minimum fails closed without a second mutation", async (t) => {
  const fixture = setup(t, {
    draft: draftWithLegQuantities("5", "5"),
    spotExposure: "5",
    planningContext: (_venue, instrumentId, current) => ({
      instrument: {
        instrumentId,
        providerSymbol: current.planning.status === "PLANNED" ? current.planning.plan.providerSymbol : "",
        baseAsset: current.planning.status === "PLANNED"
          ? current.planning.plan.plannedAssetQuantity.asset
          : createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }),
        quoteAsset: "USDT",
        settlementAsset: "USDT",
        marketType: "perpetual",
        contractType: "linear_perpetual",
        quantityUnit: "base",
        status: "trading",
      },
      tradingRules: {
        quantityStep: "1",
        minQuantity: "10",
        priceTick: "0.1",
        minNotional: "5",
        precision: {},
      },
      quote: { bid: "1", ask: "1", fetchedAt: now },
    }),
  });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "below-minimum" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    "first-command",
    { confirmationId: "below-minimum" },
  ));

  await assert.rejects(
    fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "short-leg",
      "second-command",
      { confirmationId: "below-minimum" },
    )),
    /最小合法数量/u,
  );
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 1);
});

test("second-leg revalidation still rejects identity and side drift after first-leg confirmation", async (t) => {
  for (const scenario of ["instrument", "venue", "side", "account"] as const) {
    await t.test(scenario, async (child) => {
      const fixture = setup(child, {
        runtimeVenues: ["binance", "okx"],
        credentialVenues: ["binance", "okx"],
      });
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `identity-${scenario}` }));
      fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
      await fixture.service.executeLeg("user-a", legRequest(
        created.instance.arbitrageId,
        "long-leg",
        "first-command",
        { confirmationId: `identity-${scenario}` },
      ));
      const changed = draft(true);
      const short = changed.legs[1];
      fixture.drafts.value = {
        ...changed,
        legs: [changed.legs[0], {
          ...short,
          ...(scenario === "instrument" ? { instrumentId: "ETH-USDT-PERP" } : {}),
          ...(scenario === "venue" ? { venue: "okx" as const } : {}),
          ...(scenario === "side" ? { side: "buy" as const } : {}),
        }],
      };
      if (scenario === "account") fixture.accountIds.set("binance", "binance:account-b");

      await assert.rejects(
        fixture.service.executeLeg("user-a", legRequest(
          created.instance.arbitrageId,
          "short-leg",
          "second-command",
          { confirmationId: `identity-${scenario}` },
        )),
        /不一致/u,
      );
      assert.equal(fixture.runtime.calls.length, 1);
    });
  }
});

test("duplicate leg confirmation returns the existing reference without a second mutation", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  const request = legRequest(created.instance.arbitrageId, "long-leg");

  const first = await fixture.service.executeLeg("user-a", request);
  const replay = await fixture.service.executeLeg("user-a", request);

  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.executionRecord.intentId, first.executionRecord.intentId);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("foreign users and non-instance legs are rejected without runtime access", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  await assert.rejects(
    () => fixture.service.executeLeg("user-b", legRequest(created.instance.arbitrageId, "long-leg")),
    /不存在或不属于/u,
  );
  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "foreign-leg")),
    /不属于当前套利实例/u,
  );
  assert.equal(fixture.runtime.calls.length, 0);
});

test("client-controlled provider fields and complete intents are rejected", async (t) => {
  const fixture = setup(t);
  await assert.rejects(
    () => fixture.service.confirm("user-a", { ...finalRequest(), providerSymbol: "BTCUSDT" }),
    /不允许的字段：providerSymbol/u,
  );
  await assert.rejects(
    () => fixture.service.confirm("user-a", { ...finalRequest(), executionIntent: { intentId: "client-intent" } }),
    /不允许的字段：executionIntent/u,
  );
  assert.equal(fixture.store.listActive("user-a").length, 0);
  assert.equal(fixture.runtime.calls.length, 0);
});

test("LIVE/kill-switch deterministic pre-mutation blocks remain FAILED and never enable a second leg", async (t) => {
  for (const venue of ["binance", "okx", "bybit"] as const) {
    for (const gate of ["LIVE_TRADING_ENABLED=false", "KILL_SWITCH=true"] as const) {
      const confirmationId = `${venue}-${gate}`;
      const fixture = setup(t, {
        draft: draft(true, "0.001", [venue, venue]),
        runtimeVenues: [venue],
        credentialVenues: [venue],
      });
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId }));
      fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0", "NOT_DISPATCHED");
      const result = await fixture.service.executeLeg("user-a", legRequest(
        created.instance.arbitrageId,
        "long-leg",
        gate,
        { confirmationId },
      ));
      assert.equal(result.executionRecord.status, "FAILED");
      assert.equal(result.instance.status, "FAILED");
      assert.equal(result.instance.executionReferences.length, 1);
      assert.equal(result.secondLegAllowed, false);
      assert.equal(fixture.runtime.providerMutations, 0);
      await assert.rejects(
        () => fixture.service.executeLeg("user-a", legRequest(
          created.instance.arbitrageId,
          "short-leg",
          `second-${gate}`,
          { confirmationId },
        )),
        /Terminal arbitrage instance|终态|不能/u,
      );
      assert.equal(fixture.runtime.calls.length, 1);
    }
  }
});

test("PENDING and UNKNOWN reconciliation recover full Decimal fills and unlock only a complete first leg", async (t) => {
  for (const initialStatus of ["PENDING_CONFIRMATION", "UNKNOWN"] as const) {
    await t.test(initialStatus, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest());
      fixture.runtime.onExecute = (intent) => runtimeResult(intent, initialStatus, initialStatus === "UNKNOWN" ? null : "0");
      await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
      fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");

      const recovered = await fixture.service.reconcileLeg("user-a", {
        arbitrageId: created.instance.arbitrageId,
        legId: "long-leg",
      });

      assert.equal(recovered.executionRecord.status, "CONFIRMED");
      assert.equal(recovered.executionRecord.confirmedQuantity, "0.001");
      assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.001");
      assert.equal(recovered.secondLegAllowed, true);
      assert.equal(fixture.runtime.reconcileCalls.length, 1);
    });
  }
});

test("reconciliation selects the unique unresolved closing reference when a leg has opening history", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-command"));

  const closeIntentId = "close-short-command";
  const closeTime = now + 2;
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "short-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: closeIntentId,
    requestedQuantity: "0.0005",
    createdAt: closeTime,
  });
  const shortLeg = created.instance.legs[1];
  const pending = recoveryRecord(closeIntentId, shortLeg, {
    executionId: "record-close-short",
    createdAt: closeTime,
    updatedAt: closeTime,
  });
  fixture.runtime.records.set(pending.executionId, pending);
  fixture.store.linkExecutionRecord("user-a", created.instance.arbitrageId, closeIntentId, pending.executionId, closeTime);
  fixture.store.applyExecutionResult("user-a", created.instance.arbitrageId, {
    executionIntentId: closeIntentId,
    status: "PENDING_CONFIRMATION",
    confirmedQuantity: "0.0002",
    updatedAt: closeTime,
  });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.0005");

  const result = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "short-leg",
  });

  assert.equal(result.executionRecord.intentId, closeIntentId);
  assert.equal(result.executionRecord.confirmedQuantity, "0.0005");
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "0.0005");
  assert.equal(result.instance.legs[1].confirmedOpenedQuantity, "0.001");
  assert.equal(fixture.runtime.calls.length, 2, "reconciliation must not place a new order");
});

test("CLAIMED closing reference reuses link recovery and never places another order", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-command"));

  const closeIntentId = "interrupted-close-short";
  const closeTime = now + 2;
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "short-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: closeIntentId,
    requestedQuantity: "0.0005",
    createdAt: closeTime,
  });
  const localRecord = recoveryRecord(closeIntentId, created.instance.legs[1], {
    executionId: "record-interrupted-close",
    createdAt: closeTime,
    updatedAt: closeTime,
  });
  fixture.runtime.records.set(localRecord.executionId, localRecord);
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.0005");

  const result = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "short-leg",
  });

  assert.equal(result.instance.executionReferences.at(-1)?.executionRecordId, localRecord.executionId);
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "0.0005");
  assert.equal(fixture.runtime.calls.length, 2, "link recovery must not retry provider mutation");
});

test("PENDING and UNKNOWN reconciliation preserve partial Decimal fills and keep second leg disabled", async (t) => {
  for (const initialStatus of ["PENDING_CONFIRMATION", "UNKNOWN"] as const) {
    await t.test(initialStatus, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest());
      fixture.runtime.onExecute = (intent) => runtimeResult(intent, initialStatus, initialStatus === "UNKNOWN" ? null : "0.0001");
      await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
      fixture.runtime.onReconcile = (record) => reconciliationResult(
        record,
        "PENDING_CONFIRMATION",
        "0.000456789012345678",
      );

      const recovered = await fixture.service.reconcileLeg("user-a", {
        arbitrageId: created.instance.arbitrageId,
        legId: "long-leg",
      });

      assert.equal(recovered.executionRecord.confirmedQuantity, "0.000456789012345678");
      assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.000456789012345678");
      assert.equal(recovered.secondLegAllowed, false);
    });
  }
});

test("UNKNOWN reconciliation retains prior evidence when provider quantity remains unknowable", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0004");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "UNKNOWN", null);

  const recovered = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(recovered.executionRecord.status, "UNKNOWN");
  assert.equal(recovered.executionRecord.confirmedQuantity, "0.0004");
  assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.0004");
  assert.equal(recovered.secondLegAllowed, false);
});

test("cancelled-with-partial reconciliation preserves exposure and becomes terminal idempotently", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "FAILED", "0.0006");
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };

  const recovered = await fixture.service.reconcileLeg("user-a", request);
  const replay = await fixture.service.reconcileLeg("user-a", request);

  assert.equal(recovered.executionRecord.status, "FAILED");
  assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.0006");
  assert.equal(replay.instance.legs[0].confirmedOpenedQuantity, "0.0006");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("concurrent reconciliation shares one provider query and cannot double-count exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.runtime.onReconcile = async (record) => {
    await gate;
    return reconciliationResult(record, "PENDING_CONFIRMATION", "0.0007");
  };
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };
  const first = fixture.service.reconcileLeg("user-a", request);
  const second = fixture.service.reconcileLeg("user-a", request);
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(left.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(right.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("reconciliation enforces user/reference ownership and query failures never mutate exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };

  await assert.rejects(() => fixture.service.reconcileLeg("user-b", request), /不存在或不属于/u);
  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", { ...request, legId: "short-leg" }),
    /不存在唯一可核验/u,
  );
  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", { ...request, providerOrderId: "untrusted-order" }),
    /不允许的字段/u,
  );
  fixture.runtime.onReconcile = async () => { throw new Error("provider GET failed"); };
  await assert.rejects(() => fixture.service.reconcileLeg("user-a", request), /核验暂不可用/u);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("manual reconciliation metadata survives the formal CommandService boundary", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.runtime.onReconcile = async () => {
    throw new ManualReconciliationRequiredError(
      "intent:intent-user-a",
      "Stored Binance provider orderId is invalid.",
    );
  };

  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", {
      arbitrageId: created.instance.arbitrageId,
      legId: "long-leg",
    }),
    (error: unknown) => error instanceof ArbitrageExecutionCommandError
      && error.category === "manual_reconciliation_required"
      && error.manualReconciliation?.manualReconciliationRequired === true
      && error.manualReconciliation.idempotencyKey === "intent:intent-user-a"
      && error.manualReconciliation.reason === "Stored Binance provider orderId is invalid.",
  );
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("CLAIMED reference recovers a unique local record and attributes confirmed or partial Decimal fills", async (t) => {
  for (const scenario of [
    { name: "confirmed", status: "CONFIRMED" as const, quantity: "0.001" },
    { name: "partial", status: "PENDING_CONFIRMATION" as const, quantity: "0.000456789012345678" },
    { name: "canceled-with-partial", status: "FAILED" as const, quantity: "0.0002" },
  ]) {
    await t.test(scenario.name, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `recovery-${scenario.name}` }));
      const seeded = seedInterruptedExecution(fixture, created.instance, "long-leg", `intent-${scenario.name}`);
      fixture.runtime.onReconcile = (record) => reconciliationResult(record, scenario.status, scenario.quantity);

      const recovered = await fixture.service.reconcileLeg("user-a", {
        arbitrageId: created.instance.arbitrageId,
        legId: "long-leg",
      });

      const reference = recovered.instance.executionReferences[0]!;
      assert.equal(reference.executionRecordId, seeded.executionId);
      assert.equal(reference.confirmedQuantity, scenario.quantity);
      assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, scenario.quantity);
      assert.equal(recovered.secondLegAllowed, scenario.status === "CONFIRMED");
      assert.equal(fixture.runtime.calls.length, 0);
      assert.equal(fixture.runtime.reconcileCalls.length, 1);
      assert.equal(fixture.runtime.providerMutations, 0);
    });
  }
});

test("CLAIMED UNKNOWN record recovers its link without fabricating confirmed quantity", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  const seeded = seedInterruptedExecution(fixture, created.instance, "long-leg", "intent-unknown", { status: "UNKNOWN" });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "UNKNOWN", null);

  const recovered = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(recovered.instance.executionReferences[0]?.executionRecordId, seeded.executionId);
  assert.equal(recovered.instance.executionReferences[0]?.status, "UNKNOWN");
  assert.equal(recovered.instance.executionReferences[0]?.confirmedQuantity, "0");
  assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(recovered.secondLegAllowed, false);
});

test("link recovery terminalizes a persisted pre-mutation FAILED record without Provider reconciliation", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  const seeded = seedInterruptedExecution(
    fixture,
    created.instance,
    "long-leg",
    "intent-not-dispatched",
    { status: "FAILED" },
  );

  const recovered = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(recovered.executionRecord.executionId, seeded.executionId);
  assert.equal(recovered.executionRecord.status, "FAILED");
  assert.equal(recovered.executionRecord.confirmedQuantity, "0");
  assert.equal(recovered.instance.status, "FAILED");
  assert.equal(recovered.instance.executionReferences.length, 1);
  assert.equal(fixture.runtime.reconcileCalls.length, 0);
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("missing or multiple local records fail closed without provider access", async (t) => {
  for (const scenario of ["missing", "multiple"] as const) {
    await t.test(scenario, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `recovery-${scenario}` }));
      const intentId = `intent-${scenario}`;
      fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
        legId: "long-leg",
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: intentId,
        requestedQuantity: "0.001",
        createdAt: now,
      });
      if (scenario === "multiple") {
        const leg = created.instance.legs[0];
        fixture.runtime.records.set("record-a", recoveryRecord(intentId, leg, { executionId: "record-a" }));
        fixture.runtime.records.set("record-b", recoveryRecord(intentId, leg, { executionId: "record-b" }));
      }

      await assert.rejects(
        () => fixture.service.reconcileLeg("user-a", { arbitrageId: created.instance.arbitrageId, legId: "long-leg" }),
        (error) => error instanceof ArbitrageExecutionCommandError
          && error.category === (scenario === "missing"
            ? "execution_recovery_record_not_found"
            : "execution_recovery_identity_conflict"),
      );
      assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences[0]?.executionRecordId, null);
      assert.equal(fixture.runtime.reconcileCalls.length, 0);
      assert.equal(fixture.runtime.providerMutations, 0);
    });
  }
});

test("recovery rejects user, account, venue, and instrument identity conflicts", async (t) => {
  const mismatches = [
    { name: "intent", overrides: { intentId: "another-intent" } },
    { name: "user", overrides: { userId: "user-b" } },
    { name: "account", overrides: { accountId: "binance:account-b" } },
    { name: "venue", overrides: { venue: "okx" as const } },
    { name: "instrument", overrides: { instrumentId: "ETH-USDT-SPOT" } },
  ];
  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `recovery-${mismatch.name}` }));
      const intentId = `intent-${mismatch.name}`;
      const leg = created.instance.legs[0];
      fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
        legId: leg.legId,
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: intentId,
        requestedQuantity: "0.001",
        createdAt: now,
      });
      const conflicting = recoveryRecord(intentId, leg, mismatch.overrides);
      fixture.runtime.records.set("record-conflict", conflicting);
      if (mismatch.name === "intent") fixture.runtime.recoveryCandidates = [conflicting];

      await assert.rejects(
        () => fixture.service.reconcileLeg("user-a", { arbitrageId: created.instance.arbitrageId, legId: leg.legId }),
        (error) => error instanceof ArbitrageExecutionCommandError
          && error.category === "execution_recovery_identity_conflict",
      );
      assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences[0]?.executionRecordId, null);
      assert.equal(fixture.runtime.reconcileCalls.length, 0);
    });
  }
});

test("repeated and concurrent link recovery cannot double-count exposure", async (t) => {
  const repeated = setup(t);
  const created = await repeated.service.confirm("user-a", finalRequest({ confirmationId: "recovery-repeated" }));
  seedInterruptedExecution(repeated, created.instance, "long-leg", "intent-repeated");
  repeated.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };
  const first = await repeated.service.reconcileLeg("user-a", request);
  const replay = await repeated.service.reconcileLeg("user-a", request);
  assert.equal(first.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(replay.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(repeated.runtime.reconcileCalls.length, 1);

  const concurrent = setup(t);
  const concurrentCreated = await concurrent.service.confirm("user-a", finalRequest({ confirmationId: "recovery-concurrent" }));
  seedInterruptedExecution(concurrent, concurrentCreated.instance, "long-leg", "intent-concurrent");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  concurrent.runtime.onReconcile = async (record) => {
    await gate;
    return reconciliationResult(record, "PENDING_CONFIRMATION", "0.0007");
  };
  const concurrentRequest = { arbitrageId: concurrentCreated.instance.arbitrageId, legId: "long-leg" };
  const left = concurrent.service.reconcileLeg("user-a", concurrentRequest);
  const right = concurrent.createService().reconcileLeg("user-a", concurrentRequest);
  release();
  const [leftResult, rightResult] = await Promise.all([left, right]);
  assert.equal(leftResult.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(rightResult.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(concurrent.runtime.reconcileCalls.length, 2);
  assert.equal(concurrent.runtime.providerMutations, 0);
});

test("recovered partial link continues through the existing reconciliation flow", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  seedInterruptedExecution(fixture, created.instance, "long-leg", "intent-continue");
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "PENDING_CONFIRMATION", "0.0004");
  await fixture.service.reconcileLeg("user-a", { arbitrageId: created.instance.arbitrageId, legId: "long-leg" });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");

  const completed = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(completed.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(completed.instance.executionReferences[0]?.status, "CONFIRMED");
  assert.equal(completed.secondLegAllowed, true);
  assert.equal(fixture.runtime.reconcileCalls.length, 2);
});

class FakeDraftService {
  readonly calls: unknown[] = [];
  readonly createCalls: unknown[] = [];
  constructor(public value: ArbitrageExecutionDraft) {}
  async createDraft(userId: string, input: unknown) {
    this.createCalls.push({ userId, input });
    return {
      ...this.value,
      legs: this.value.legs.map((leg) => ({
        ...leg,
        planning: { status: "NOT_REQUESTED" as const },
        executionAvailable: false,
      })) as unknown as ArbitrageExecutionDraft["legs"],
      allLegsExecutable: false,
    };
  }
  async preview(userId: string, input: unknown) {
    this.calls.push({ userId, input });
    return this.value;
  }
}

class FakeRuntime implements FormalExecutionRuntime {
  readonly calls: ExecutionIntent[] = [];
  readonly reconcileCalls: Array<{ userId: string; executionId: string }> = [];
  readonly records = new Map<string, ExecutionRecord>();
  recoveryCandidates: readonly ExecutionRecord[] | null = null;
  providerMutations = 0;
  onExecute: (intent: ExecutionIntent) => ReturnType<typeof runtimeResult> = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  onReconcile: (record: ExecutionRecord) => ReturnType<typeof reconciliationResult> | Promise<ReturnType<typeof reconciliationResult>> = (record) => reconciliationResult(record, "UNKNOWN", null);
  async execute(intent: ExecutionIntent) {
    this.calls.push(intent);
    const result = this.onExecute(intent);
    this.records.set(result.executionRecord.executionId, result.executionRecord);
    return result;
  }
  async reconcile(userId: string, executionId: string) {
    this.reconcileCalls.push({ userId, executionId });
    const record = this.records.get(executionId);
    if (!record || record.userId !== userId) throw new Error("ExecutionRecord unavailable");
    const result = await this.onReconcile(record);
    this.records.set(executionId, result.executionRecord);
    return result;
  }
  async cancel(): ReturnType<FormalExecutionRuntime["cancel"]> {
    throw new Error("not used");
  }
  findByIntentId(intentId: string) {
    return this.recoveryCandidates
      ?? [...this.records.values()].filter((record) => record.intentId === intentId);
  }
}

function setup(t: TestContext, options: {
  draft?: ArbitrageExecutionDraft;
  runtimeVenues?: readonly ExecutionVenue[];
  credentialVenues?: readonly ExecutionVenue[];
  spotExposure?: string;
  claimFailure?: "before" | "after";
  createIntentId?: (userId: string, arbitrageId: string, legId: string, commandId: string) => string;
  planningContext?: (
    venue: ExecutionVenue,
    instrumentId: string,
    leg: ArbitrageExecutionDraft["legs"][number],
  ) => Promise<import("./ArbitrageExecutionPlanningContext").ArbitrageExecutionPlanningContext>
    | import("./ArbitrageExecutionPlanningContext").ArbitrageExecutionPlanningContext;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "stellax-command-test-"));
  const dbPath = join(directory, "test.sqlite");
  let activeStore = new ArbitrageInstanceStore({ dbPath });
  t.after(() => {
    activeStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const drafts = new FakeDraftService(options.draft ?? draft(true));
  const runtime = new FakeRuntime();
  const runtimes = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", runtime));
  for (const venue of options.runtimeVenues ?? []) {
    if (venue !== "binance") runtimes.register(formalExecutionRuntime(venue, runtime));
  }
  const credentials = {
    accountIds: new Map<ExecutionVenue, string>(),
    findSummary: (userId: string, venue: string) => {
      if (userId !== "user-a") return null;
      const configuredVenues = options.credentialVenues ?? ["binance"];
      if (!configuredVenues.includes(venue as ExecutionVenue)) return null;
      return { accountId: credentials.accountIds.get(venue as ExecutionVenue) ?? `${venue}:account-a` } as any;
    },
  };
  const createServiceFor = (
    store: ArbitrageInstanceStore,
    runtimeRegistry = runtimes,
  ) => new ArbitrageExecutionCommandService(
    drafts,
    options.claimFailure
      ? new Proxy(store, {
        get(target, property, receiver) {
          if (property !== "claimExecutionReference") return Reflect.get(target, property, receiver);
          return (...args: Parameters<ArbitrageInstanceStore["claimExecutionReference"]>) => {
            if (options.claimFailure === "before") throw new Error("synthetic claim failure");
            target.claimExecutionReference(...args);
            throw new Error("synthetic claim failure");
          };
        },
      })
      : store,
    credentials,
    runtime,
    runtimeRegistry,
    {
      contexts: {
        load: async (venue, instrumentId) => {
          const current = drafts.value.legs.find((leg) => leg.venue === venue && leg.instrumentId === instrumentId);
          if (!current || current.planning.status !== "PLANNED" || !current.quote || !current.tradingRules) {
            throw new Error("planning context unavailable");
          }
          if (options.planningContext) return options.planningContext(venue, instrumentId, current);
          return {
            instrument: {
              instrumentId,
              providerSymbol: current.planning.plan.providerSymbol,
              baseAsset: current.planning.plan.plannedAssetQuantity.asset,
              quoteAsset: "USDT",
              ...(current.marketType === "perpetual" ? { settlementAsset: "USDT" } : {}),
              marketType: current.marketType,
              contractType: current.marketType === "spot" ? "spot" as const : "linear_perpetual" as const,
              quantityUnit: "base" as const,
              status: "trading" as const,
            },
            tradingRules: current.tradingRules,
            quote: { ...current.quote, fetchedAt: current.quote.updatedAt },
          };
        },
      },
      spotAttributions: {
        binance: {
          readAttributableBaseQuantity: async (_userId, request) =>
            options.spotExposure ?? request.grossConfirmedQuantity,
        },
      },
    },
    {
      clock: () => now,
      createIntentId: options.createIntentId,
      intentTtlMs: 30_000,
    },
  );
  const createService = (runtimeRegistry = runtimes) => createServiceFor(activeStore, runtimeRegistry);
  const service = createService();
  const restart = () => {
    activeStore.close();
    activeStore = new ArbitrageInstanceStore({ dbPath });
    return { store: activeStore, service: createService() };
  };
  return {
    drafts,
    runtime,
    service,
    store: activeStore,
    createService,
    restart,
    accountIds: credentials.accountIds,
  };
}

function finalRequest(overrides: Record<string, unknown> = {}) {
  return {
    confirmationId: "confirmation-1",
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.001" },
    executionMode: "PRICE_PRIORITY",
    confirmed: true,
    ...overrides,
  };
}

function legRequest(arbitrageId: string, legId: string, commandId = "first-command", overrides: Record<string, unknown> = {}) {
  return { ...finalRequest(overrides), arbitrageId, legId, commandId };
}

function runtimeResult(
  intent: ExecutionIntent,
  status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN",
  confirmedQuantity: string | null,
  mutationDisposition?: "NOT_DISPATCHED",
) {
  return Object.freeze({
    executionRecord: createExecutionRecord({
      executionId: `record-${intent.intentId}`,
      intentId: intent.intentId,
      userId: intent.userId,
      venue: intent.venue,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      status,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    }),
    confirmedQuantity,
    ...(mutationDisposition === undefined ? {} : { mutationDisposition }),
  });
}

function reconciliationResult(
  record: ExecutionRecord,
  status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN",
  confirmedQuantity: string | null,
) {
  return Object.freeze({
    executionRecord: createExecutionRecord({ ...record, status, updatedAt: record.updatedAt + 1 }),
    confirmedQuantity,
  });
}

function seedInterruptedExecution(
  fixture: ReturnType<typeof setup>,
  instance: Awaited<ReturnType<ArbitrageExecutionCommandService["confirm"]>>["instance"],
  legId: string,
  intentId: string,
  recordOverrides: Partial<ExecutionRecord> = {},
) {
  const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
  fixture.store.claimExecutionReference("user-a", instance.arbitrageId, {
    legId,
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: intentId,
    requestedQuantity: leg.plannedQuantity,
    createdAt: now,
  });
  const record = recoveryRecord(intentId, leg, recordOverrides);
  fixture.runtime.records.set(record.executionId, record);
  return record;
}

function recoveryRecord(
  intentId: string,
  leg: Awaited<ReturnType<ArbitrageExecutionCommandService["confirm"]>>["instance"]["legs"][number],
  overrides: Partial<ExecutionRecord> = {},
) {
  return createExecutionRecord({
    executionId: `record-${intentId}`,
    intentId,
    userId: "user-a",
    venue: leg.venue,
    accountId: leg.accountId,
    instrumentId: leg.instrumentId,
    status: "PENDING_CONFIRMATION",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function draft(
  allAvailable: boolean,
  quantity = "0.001",
  venues: readonly [ExecutionVenue, ExecutionVenue] = ["binance", "binance"],
): ArbitrageExecutionDraft {
  const leg = (role: "LONG" | "SHORT", instrumentId: string, venue: ExecutionVenue) => ({
    legId: role === "LONG" ? "long-leg" : "short-leg",
    role,
    venue,
    instrumentId,
    providerSymbol: venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
    side: role === "LONG" ? "buy" as const : "sell" as const,
    marketType: instrumentId.endsWith("SPOT") ? "spot" as const : "perpetual" as const,
    quote: { bid: "99999", ask: "100001", updatedAt: now },
    tradingRules: { quantityStep: "0.001", minQuantity: "0.001", priceTick: "0.1", minNotional: "5", precision: {} },
    capability: allAvailable
      ? { status: "AVAILABLE" as const, reasonCode: "AVAILABLE" as const }
      : { status: "UNAVAILABLE" as const, reasonCode: "CREDENTIAL_NOT_CONFIGURED" as const },
    planning: {
      status: "PLANNED" as const,
      plan: {
        instrumentId,
        providerSymbol: venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
        baseAsset: "BTC",
        quantityInput: { mode: "ASSET_QUANTITY" as const, quantity },
        sizingPrice: role === "LONG" ? "100001" : "99999",
        plannedAssetQuantity: { asset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }), quantity },
        estimatedNotionalUsdt: role === "LONG" ? "100.001" : "99.999",
        generatedAt: now,
      },
    },
    executionAvailable: allAvailable,
  });
  return {
    opportunityId: "opportunity-1",
    sourceIdentity: `arbitrage-dashboard:opportunity-1:${now}`,
    sourceSnapshotGeneratedAt: now,
    horizonDays: 90,
    strategyType: "SPOT_PERPETUAL",
    quantityInput: { mode: "ASSET_QUANTITY", quantity },
    legs: [leg("LONG", "BTC-USDT-SPOT", venues[0]), leg("SHORT", "BTC-USDT-PERP", venues[1])],
    allLegsExecutable: allAvailable,
    generatedAt: now,
  };
}

function draftWithLegQuantities(firstQuantity: string, secondQuantity: string): ArbitrageExecutionDraft {
  const base = draft(true, firstQuantity);
  const second = base.legs[1];
  if (second.planning.status !== "PLANNED") throw new Error("test draft is not planned");
  return {
    ...base,
    legs: [base.legs[0], {
      ...second,
      planning: {
        status: "PLANNED",
        plan: {
          ...second.planning.plan,
          quantityInput: { mode: "ASSET_QUANTITY", quantity: secondQuantity },
          plannedAssetQuantity: {
            ...second.planning.plan.plannedAssetQuantity,
            quantity: secondQuantity,
          },
        },
      },
    }],
  };
}

function notionalDraft(firstQuantity: string, secondQuantity: string, estimatedNotionalUsdt: string): ArbitrageExecutionDraft {
  const base = draft(true, firstQuantity);
  const quantities = [firstQuantity, secondQuantity] as const;
  return {
    ...base,
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" },
    legs: base.legs.map((leg, index) => {
      if (leg.planning.status !== "PLANNED") throw new Error("test draft is not planned");
      return {
        ...leg,
        planning: {
          status: "PLANNED" as const,
          plan: {
            ...leg.planning.plan,
            quantityInput: { mode: "NOTIONAL_USDT" as const, amountUsdt: "8" },
            plannedAssetQuantity: { ...leg.planning.plan.plannedAssetQuantity, quantity: quantities[index]! },
            estimatedNotionalUsdt,
          },
        },
      };
    }) as unknown as ArbitrageExecutionDraft["legs"],
  };
}

function planningFailureDraft(): ArbitrageExecutionDraft {
  const base = draft(true);
  return {
    ...base,
    allLegsExecutable: false,
    legs: base.legs.map((leg) => ({
      ...leg,
      executionAvailable: false,
      planning: { status: "ERROR" as const, errorCode: "QUOTE_STALE" as const },
    })) as unknown as ArbitrageExecutionDraft["legs"],
  };
}
