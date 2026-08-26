import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAsset } from "../cex/Asset";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { activeManagedQuantity } from "../cex/arbitrage-instance/ArbitrageInstance";
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
import { ProviderMutationSerializer } from "./ProviderMutationSerializer";
import { ArbitrageStartupRecoveryService } from "./ArbitrageStartupRecoveryService";
import { LocalNotDispatchedEvidenceEvaluator } from "./LocalNotDispatchedEvidenceEvaluator";
import { ArbitrageHedgeStartService } from "./ArbitrageHedgeStartService";
import { ArbitrageOpeningSafetyEvaluator } from "./ArbitrageOpeningSafetyEvaluator";
import { OpeningContinuationSafetyEvaluator } from "./OpeningContinuationSafetyEvaluator";
import type {
  ArbitrageLegVerificationResult,
  ArbitragePositionVerificationResult,
} from "../cex/arbitrage-instance/ArbitragePositionVerification";
import { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import { createPositionSnapshot } from "../cex/position/PositionSnapshot";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";

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

test("opening preflight blocks a Spot first leg when the ONE_WAY perpetual leg is opposite", async (t) => {
  const safety = mutableOpeningSafety("opposite");
  const fixture = setup(t, { openingSafety: safety });
  const created = await fixture.service.confirm("user-a", finalRequest());

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg")),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "opening_attribution_unsafe",
  );

  const instance = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(fixture.runtime.calls.length, 0);
  assert.equal(instance.executionReferences.length, 0);
  assert.deepEqual(instance.legs.map((leg) => leg.confirmedOpenedQuantity), ["0", "0"]);
  assert.equal(instance.status, "OPENING");
});

test("opening preflight fails closed for UNKNOWN or a missing perpetual safety result", async (t) => {
  for (const scenario of ["unknown", "missing"] as const) {
    const openingSafety = scenario === "unknown"
      ? mutableOpeningSafety("unknown")
      : { evaluate: async () => [] as const };
    const fixture = setup(t, { openingSafety });
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `preflight-${scenario}` }));

    await assert.rejects(
      () => fixture.service.executeLeg("user-a", legRequest(
        created.instance.arbitrageId,
        "long-leg",
        `preflight-${scenario}`,
      )),
      (error) => error instanceof ArbitrageExecutionCommandError
        && error.category === "opening_attribution_unsafe",
    );

    const instance = fixture.store.get("user-a", created.instance.arbitrageId)!;
    assert.equal(fixture.runtime.calls.length, 0, scenario);
    assert.equal(instance.executionReferences.length, 0, scenario);
    assert.deepEqual(instance.legs.map((leg) => leg.confirmedOpenedQuantity), ["0", "0"], scenario);
  }
});

test("perpetual first leg rechecks at mutation time and rejects FLAT or same-direction drift to opposite", async (t) => {
  for (const initial of ["flat", "same"] as const) {
    const safety = mutableOpeningSafety(initial);
    const fixture = setup(t, { draft: sameInstrumentPerpetualDraft(), openingSafety: safety });
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `perp-first-${initial}` }));
    safety.afterFirstRead = "opposite";

    await assert.rejects(
      () => fixture.service.executeLeg("user-a", legRequest(
        created.instance.arbitrageId,
        "short-leg",
        `perp-first-${initial}`,
      )),
      (error) => error instanceof ArbitrageExecutionCommandError
        && error.category === "opening_attribution_unsafe",
    );

    const instance = fixture.store.get("user-a", created.instance.arbitrageId)!;
    assert.equal(safety.calls, 2);
    assert.equal(fixture.runtime.calls.length, 0);
    assert.equal(instance.executionReferences.length, 0);
    assert.equal(instance.legs[1]?.confirmedOpenedQuantity, "0");
  }
});

test("perpetual second leg fails before mutation when Reality becomes opposite after the Spot fill", async (t) => {
  const safety = mutableOpeningSafety("flat");
  const fixture = setup(t, { openingSafety: safety });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "perp-second-drift" }));
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    "spot-first",
  ));
  safety.current = "opposite";

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "short-leg",
      "perp-second",
    )),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "opening_attribution_unsafe",
  );

  const instance = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(instance.executionReferences.length, 1);
  assert.equal(instance.legs[0]?.confirmedOpenedQuantity, "0.001");
  assert.equal(instance.legs[1]?.confirmedOpenedQuantity, "0");
  assert.equal(instance.status, "RESIDUAL");
});

test("HEDGE perpetual opening is not blocked by the ONE_WAY attribution gate", async (t) => {
  const safety = mutableOpeningSafety("hedge");
  const fixture = setup(t, { draft: sameInstrumentPerpetualDraft(), openingSafety: safety });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "hedge-opening" }));

  const result = await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "short-leg",
    "hedge-perp-first",
  ));

  assert.equal(safety.calls, 2);
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(result.instance.legs[1]?.confirmedOpenedQuantity, "0.001");
});

test("different commandIds cannot concurrently open the same instance leg twice", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  const entered = deferred<void>();
  const release = deferred<void>();
  fixture.runtime.onExecute = async (intent) => {
    entered.resolve();
    await release.promise;
    return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  };

  const first = fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "open-a"));
  await entered.promise;
  const second = fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "open-b"));
  release.resolve();
  const outcomes = await Promise.allSettled([first, second]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 1);
});

test("two instance legs cannot concurrently acquire first-opening ownership", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  const release = deferred<void>();
  fixture.runtime.onExecute = async (intent) => {
    await release.promise;
    return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  };
  const requests = [
    fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "first-long")),
    fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "first-short")),
  ];
  await Promise.resolve();
  release.resolve();
  const outcomes = await Promise.allSettled(requests);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("cross-instance opposite ONE_WAY openings serialize and the waiter re-reads Reality", async (t) => {
  let signedReality = "0";
  let preflightReads = 0;
  const bothPreflights = deferred<void>();
  const openingSafety = {
    async evaluate(_userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance) {
      if (signedReality === "0" && preflightReads < 2) {
        preflightReads += 1;
        if (preflightReads === 2) bothPreflights.resolve();
        await bothPreflights.promise;
      }
      return openingResults(instance, signedReality);
    },
  };
  const fixture = setup(t, { draft: sameInstrumentPerpetualDraft(), openingSafety });
  fixture.runtime.onExecute = async (intent) => {
    const result = runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
    signedReality = intent.side === "buy" ? intent.quantity.quantity : `-${intent.quantity.quantity}`;
    return result;
  };
  const a = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "instance-a" }));
  const b = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "instance-b" }));
  const outcomes = await Promise.allSettled([
    fixture.service.executeLeg("user-a", legRequest(a.instance.arbitrageId, "long-leg", "open-long")),
    fixture.service.executeLeg("user-a", legRequest(b.instance.arbitrageId, "short-leg", "open-short")),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("cross-instance same-direction ONE_WAY openings serialize without over-blocking", async (t) => {
  let signedReality = "0";
  const openingSafety = {
    evaluate: async (_userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance) =>
      openingResults(instance, signedReality),
  };
  const fixture = setup(t, { openingSafety });
  fixture.runtime.onExecute = async (intent) => {
    if (intent.instrumentId.endsWith("-PERP")) {
      signedReality = signedReality === "0" ? `-${intent.quantity.quantity}` : "-0.002";
    }
    return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  };
  const a = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "same-a" }));
  const b = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "same-b" }));
  await fixture.service.executeLeg("user-a", legRequest(a.instance.arbitrageId, "long-leg", "same-spot-a"));
  await fixture.service.executeLeg("user-a", legRequest(b.instance.arbitrageId, "long-leg", "same-spot-b"));
  fixture.runtime.calls.length = 0;
  const outcomes = await Promise.allSettled([
    fixture.service.executeLeg("user-a", legRequest(a.instance.arbitrageId, "short-leg", "same-short-a")),
    fixture.service.executeLeg("user-a", legRequest(b.instance.arbitrageId, "short-leg", "same-short-b")),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 2);
  assert.equal(fixture.runtime.calls.length, 2);
});

test("unresolved risk-increasing opening blocks another instance until terminal", async (t) => {
  const fixture = setup(t, { draft: sameInstrumentPerpetualDraft() });
  const a = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "pending-a" }));
  const b = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "pending-b" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0004");
  await fixture.service.executeLeg("user-a", legRequest(a.instance.arbitrageId, "long-leg", "pending-open"));
  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(b.instance.arbitrageId, "long-leg", "blocked-open")),
    /unresolved risk-increasing opening/u,
  );
  assert.equal(fixture.runtime.calls.length, 1);
});

test("second-leg continuation failure preserves the first execution and prevents mutation", async (t) => {
  let continuationStatus: "SUPPORTED" | "UNSUPPORTED" = "SUPPORTED";
  const fixture = setup(t, {
    continuationSafety: {
      evaluate: async (_userId, instance, firstExecutionIntentId) => {
        const first = instance.executionReferences.find((reference) => reference.executionIntentId === firstExecutionIntentId)!;
        return Object.freeze({ firstLegId: first.legId, activeAttributedExposure: first.confirmedQuantity,
          status: continuationStatus, reason: continuationStatus === "SUPPORTED"
            ? "FIRST_LEG_REALITY_SUPPORTED" as const : "FIRST_LEG_REALITY_INSUFFICIENT" as const, checkedAt: now });
      },
    },
  });
  const created = await fixture.service.confirm("user-a", finalRequest());
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "first-open"));
  continuationStatus = "UNSUPPORTED";
  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-open")),
    (error) => error instanceof ArbitrageExecutionCommandError && error.category === "second_leg_not_allowed",
  );
  const current = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(current.legs[1].confirmedOpenedQuantity, "0");
  assert.equal(current.legs[0].confirmedOpenedQuantity, "0.001");
});

test("direct per-leg command cannot bypass SPOT_PERPETUAL Spot-first ordering", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  await assert.rejects(
    () => fixture.service.executeLeg(
      "user-a",
      legRequest(created.instance.arbitrageId, "short-leg", "illegal-perpetual-first"),
    ),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "invalid_execution_confirmation",
  );
  assert.equal(fixture.runtime.calls.length, 0);
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 0);
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

test("OKX PRICE_PRIORITY capability loss blocks Confirm and one-click Start before runtime mutation", async (t) => {
  const confirmBlocked = setup(t, {
    draft: okxPriceUnsupportedDraft(),
    runtimeVenues: ["okx"],
    credentialVenues: ["binance", "okx"],
  });
  await assert.rejects(
    () => confirmBlocked.service.confirm("user-a", finalRequest()),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "execution_capability_unavailable",
  );
  assert.equal(confirmBlocked.runtime.calls.length, 0);
  assert.equal(confirmBlocked.runtime.providerMutations, 0);
  assert.deepEqual(confirmBlocked.drafts.calls, [{
    userId: "user-a",
    input: {
      opportunityId: "opportunity-1",
      horizonDays: 90,
      executionMode: "PRICE_PRIORITY",
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.001" },
    },
  }]);

  const startBlocked = setup(t, {
    draft: draft(true, "0.001", ["binance", "okx"]),
    runtimeVenues: ["okx"],
    credentialVenues: ["binance", "okx"],
  });
  const legacy = await startBlocked.service.confirm("user-a", finalRequest());
  startBlocked.drafts.value = okxPriceUnsupportedDraft();
  const orchestration = new ArbitrageHedgeStartService(startBlocked.store, startBlocked.service);
  const stopped = await orchestration.start("user-a", legacy.instance.arbitrageId, {
    hedgeCommandId: "okx-price-start",
    firstLegId: "long-leg",
    ...finalRequest(),
  });
  assert.equal(stopped.status, "STOPPED_SAFETY");
  assert.equal(startBlocked.runtime.calls.length, 0);
  assert.equal(startBlocked.runtime.providerMutations, 0);
});

test("second-leg revalidation blocks newly unsupported OKX PRICE_PRIORITY without a second mutation", async (t) => {
  const fixture = setup(t, {
    draft: draft(true, "0.001", ["binance", "okx"]),
    runtimeVenues: ["okx"],
    credentialVenues: ["binance", "okx"],
  });
  const created = await fixture.service.confirm("user-a", finalRequest());
  await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg", "okx-price-first"),
  );
  assert.equal(fixture.runtime.calls.length, 1);

  fixture.drafts.value = okxPriceUnsupportedDraft();
  await assert.rejects(
    () => fixture.service.executeLeg(
      "user-a",
      legRequest(created.instance.arbitrageId, "short-leg", "okx-price-second"),
    ),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "execution_capability_unavailable",
  );
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.providerMutations, 0);
  assert.equal(
    fixture.store.get("user-a", created.instance.arbitrageId)?.legs[1].confirmedOpenedQuantity,
    "0",
  );
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
    /already claimed|unresolved risk-increasing opening/u,
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
  const executionPriorityDraft = {
    ...sameInstrumentPerpetualDraft("binance", "okx"),
    executionMode: "EXECUTION_PRIORITY" as const,
  };
  const fixture = setup(t, {
    draft: executionPriorityDraft,
    runtimeVenues: ["binance", "okx"],
    credentialVenues: ["binance", "okx"],
  });
  const created = await fixture.service.confirm("user-a", finalRequest({ executionMode: "EXECUTION_PRIORITY" }));

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg", "first-command", {
      executionMode: "EXECUTION_PRIORITY",
    }),
  );

  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.venue, "okx");
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("OKX EXECUTION_PRIORITY remains available through Confirm and one-click Start", async (t) => {
  const executionPriorityDraft = {
    ...sameInstrumentPerpetualDraft("okx"),
    executionMode: "EXECUTION_PRIORITY" as const,
  };
  const fixture = setup(t, {
    draft: executionPriorityDraft,
    runtimeVenues: ["okx"],
    credentialVenues: ["okx"],
  });
  const request = finalRequest({
    confirmationId: "okx-execution-priority",
    executionMode: "EXECUTION_PRIORITY",
  });
  const created = await fixture.service.confirm("user-a", request);
  const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);
  const result = await orchestration.start("user-a", created.instance.arbitrageId, {
    ...request,
    hedgeCommandId: "okx-execution-priority-start",
    firstLegId: "long-leg",
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(fixture.runtime.calls.length, 2);
  assert.equal(fixture.runtime.calls.every((intent) => intent.executionMode === "EXECUTION_PRIORITY"), true);
});

test("Spot first leg claims before runtime and confirmed result updates managed quantity", async (t) => {
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
    legRequest(created.instance.arbitrageId, "long-leg"),
  );

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.arbitrageId, created.instance.arbitrageId);
  assert.equal(fixture.runtime.calls[0]?.legId, "long-leg");
  assert.equal(fixture.runtime.calls[0]?.side, "buy");
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "0.001");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0.001");
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

test("one-click orchestration reuses executeLeg twice and reaches HOLDING", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "one-click-happy" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service, { clock: () => now + 100 });

  const result = await orchestration.start("user-a", created.instance.arbitrageId, {
    ...finalRequest({ confirmationId: "one-click-happy" }),
    hedgeCommandId: "one-click-happy-command",
    firstLegId: "long-leg",
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.instanceStatus, "HOLDING");
  assert.deepEqual(fixture.runtime.calls.map(({ legId }) => legId), ["long-leg", "short-leg"]);
  assert.equal(fixture.drafts.calls.length, 2, "Confirm and Start must use separate authoritative previews");
  assert.equal(fixture.drafts.createCalls.length, 1, "second-leg planning must load a fresh request-local Draft");

  const replay = await orchestration.start("user-a", created.instance.arbitrageId, {
    ...finalRequest({ confirmationId: "one-click-happy" }),
    hedgeCommandId: "one-click-happy-command",
    firstLegId: "long-leg",
  });
  assert.equal(replay.status, "COMPLETED");
  assert.equal(fixture.runtime.calls.length, 2);
  await assert.rejects(
    () => orchestration.start("user-a", created.instance.arbitrageId, {
      ...finalRequest({ confirmationId: "one-click-happy", opportunityId: "changed-opportunity" }),
      hedgeCommandId: "one-click-happy-command",
      firstLegId: "long-leg",
    }),
    (error) => error instanceof ArbitrageExecutionCommandError && error.category === "idempotency_conflict",
  );
});

test("second-leg mutation shares one fresh canonical verification across independent safety evaluators", async (t) => {
  let verificationCalls = 0;
  let continuationInput: ArbitragePositionVerificationResult | null | undefined;
  let openingInput: ArbitragePositionVerificationResult | null | undefined;
  const verifier = {
    verify: async (_userId: string, arbitrageId: string) => {
      verificationCalls += 1;
      const reality = (overrides: Partial<ArbitrageLegVerificationResult>): ArbitrageLegVerificationResult => ({
        arbitrageId,
        legId: "long-leg",
        expectedManagedQuantity: "0.001",
        actualQuantity: "0.001",
        actualSignedNetQuantity: "0.001",
        positionMode: "ONE_WAY",
        actualLongQuantity: "0.001",
        actualShortQuantity: "0",
        availableQuantity: "0.001",
        verificationStatus: "MATCHED",
        reason: null,
        checkedAt: now + verificationCalls,
        ...overrides,
      });
      return Object.freeze({
        arbitrageId,
        checkedAt: now + verificationCalls,
        legs: Object.freeze([
          reality({}),
          reality({
            legId: "short-leg",
            expectedManagedQuantity: "0",
            actualQuantity: "0",
            actualSignedNetQuantity: "0",
            actualLongQuantity: "0",
            availableQuantity: null,
          }),
        ]) as readonly [ArbitrageLegVerificationResult, ArbitrageLegVerificationResult],
      });
    },
  };
  const continuation = new OpeningContinuationSafetyEvaluator(verifier as never);
  const opening = new ArbitrageOpeningSafetyEvaluator(verifier as never);
  const fixture = setup(t, {
    continuationSafety: {
      loadFreshVerification: (userId, instance) => continuation.loadFreshVerification(userId, instance),
      evaluate: async (userId, instance, firstExecutionIntentId, input) => {
        continuationInput = input;
        return continuation.evaluate(userId, instance, firstExecutionIntentId, input);
      },
    },
    openingSafety: {
      evaluate: async (userId, instance, input) => {
        if (input !== undefined) openingInput = input;
        return opening.evaluate(userId, instance, input);
      },
    },
  });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "shared-fresh" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);

  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "shared-first"));
  assert.equal(verificationCalls, 2, "preflight and first mutation must remain independent");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "shared-second"));

  assert.equal(verificationCalls, 3, "second mutation must perform exactly one fresh verification");
  assert.ok(continuationInput);
  assert.strictEqual(openingInput, continuationInput);
  assert.equal(fixture.runtime.calls.length, 2);
});

test("full-full same-account Start performs six request-local credential unwrap sites for all venues", async (t) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await t.test(venue, async (child) => {
      let unwraps = 0;
      let opening!: ArbitrageOpeningSafetyEvaluator;
      let continuation!: OpeningContinuationSafetyEvaluator;
      const fixture = setup(child, {
        draft: draft(true, "0.001", [venue, venue]),
        runtimeVenues: [venue],
        credentialVenues: [venue],
        openingSafety: { evaluate: (userId, instance, input) => opening.evaluate(userId, instance, input) },
        continuationSafety: {
          loadFreshVerification: (userId, instance) => continuation.loadFreshVerification(userId, instance),
          evaluate: (userId, instance, firstExecutionIntentId, input) =>
            continuation.evaluate(userId, instance, firstExecutionIntentId, input),
        },
        spotAttribution: {
          readAttributableBaseQuantity: async (_userId, request) => {
            unwraps += 1;
            return request.grossConfirmedQuantity;
          },
        },
      });
      const verifier = new ArbitragePositionVerificationService(
        {
          getById: (userId, arbitrageId) => fixture.store.get(userId, arbitrageId),
          listActive: () => [],
        },
        {
          findSummary: (userId, requestedVenue) => ({ userId, venue: requestedVenue,
            accountId: `${requestedVenue}:account-a`, accountFingerprint: "fingerprint", maskedApiKey: "****",
            environment: "development", permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now }),
          loadForAccountRead: async () => {
            unwraps += 1;
            return { apiKey: "key", apiSecret: "secret", passphrase: "passphrase" };
          },
        },
        [{
          venue,
          create: () => ({
            venue,
            readLeg: async (leg) => ({
              snapshot: createPositionSnapshot({
                venue,
                accountId: leg.accountId,
                instrumentId: leg.instrumentId,
                side: leg.instrumentId.endsWith("-SPOT") ? "LONG" : "FLAT",
                quantity: leg.instrumentId.endsWith("-SPOT") ? "0.001" : "0",
                fetchedAt: now,
              }),
              ...(leg.instrumentId.endsWith("-SPOT") ? { availableQuantity: "0.001" } : {}),
            }),
            dispose: () => undefined,
          }),
        }],
        () => now,
      );
      opening = new ArbitrageOpeningSafetyEvaluator(verifier);
      continuation = new OpeningContinuationSafetyEvaluator(verifier);
      fixture.runtime.onExecute = (intent) => {
        unwraps += 1;
        return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
      };
      const confirmationId = `kms-count-${venue}`;
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId }));
      const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);

      const result = await orchestration.start("user-a", created.instance.arbitrageId, {
        ...finalRequest({ confirmationId }),
        hedgeCommandId: `kms-count-command-${venue}`,
        firstLegId: "long-leg",
      });

      assert.equal(result.status, "COMPLETED");
      assert.equal(unwraps, 6);
      assert.equal(fixture.runtime.calls.length, 2);
    });
  }
});

test("one-click full-full critical path records T1-T5 without an orchestration delay", async (t) => {
  const milliseconds = (end: bigint, start: bigint) => Number(end - start) / 1_000_000;
  for (let run = 1; run <= 10; run += 1) {
    await t.test(`fake provider run ${run}`, async (child) => {
      const marks: Partial<Record<"t1" | "t2" | "t3" | "t4" | "t5", bigint>> = {};
      const fixture = setup(child, {
        continuationSafety: {
          loadFreshVerification: async () => {
            marks.t3 = process.hrtime.bigint();
            return null;
          },
          evaluate: async (_userId, instance, firstExecutionIntentId) => {
            const first = instance.executionReferences.find((reference) =>
              reference.executionIntentId === firstExecutionIntentId)!;
            return Object.freeze({
              firstLegId: first.legId,
              activeAttributedExposure: first.confirmedQuantity,
              status: "SUPPORTED" as const,
              reason: "FIRST_LEG_REALITY_SUPPORTED" as const,
              checkedAt: now,
            });
          },
        },
      });
      const confirmationId = `one-click-timeline-${run}`;
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId }));
      let projectionCount = 0;
      let contextLoadStarted: bigint | undefined;
      let planningReady: bigint | undefined;
      let runtimePreparationStarted: bigint | undefined;
      const applyExecutionResult = fixture.store.applyExecutionResult.bind(fixture.store);
      fixture.store.applyExecutionResult = ((...args: Parameters<typeof applyExecutionResult>) => {
        const projected = applyExecutionResult(...args);
        projectionCount += 1;
        if (projectionCount === 1) marks.t2 = process.hrtime.bigint();
        return projected;
      }) as typeof fixture.store.applyExecutionResult;
      const createDraft = fixture.drafts.createDraft.bind(fixture.drafts);
      fixture.drafts.createDraft = async (...args: Parameters<typeof createDraft>) => {
        contextLoadStarted = process.hrtime.bigint();
        const loaded = await createDraft(...args);
        marks.t4 = process.hrtime.bigint();
        return loaded;
      };
      const prepareSecondLegHedge = fixture.store.prepareSecondLegHedge.bind(fixture.store);
      fixture.store.prepareSecondLegHedge = ((...args: Parameters<typeof prepareSecondLegHedge>) => {
        const prepared = prepareSecondLegHedge(...args);
        planningReady = process.hrtime.bigint();
        return prepared;
      }) as typeof fixture.store.prepareSecondLegHedge;
      const runtimeExecute = fixture.runtime.execute.bind(fixture.runtime);
      let runtimeExecutions = 0;
      fixture.runtime.execute = async (intent) => {
        runtimeExecutions += 1;
        if (runtimeExecutions === 2) runtimePreparationStarted = process.hrtime.bigint();
        return runtimeExecute(intent);
      };
      fixture.runtime.onExecute = (intent) => {
        if (fixture.runtime.calls.length === 1) marks.t1 = process.hrtime.bigint();
        else marks.t5 = process.hrtime.bigint();
        return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
      };
      const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);

      const result = await orchestration.start("user-a", created.instance.arbitrageId, {
        ...finalRequest({ confirmationId }),
        hedgeCommandId: `one-click-timeline-command-${run}`,
        firstLegId: "long-leg",
      });

      assert.equal(result.status, "COMPLETED");
      assert.equal(fixture.runtime.calls.length, 2);
      assert.ok(marks.t1 && marks.t2 && marks.t3 && marks.t4 && marks.t5);
      assert.ok(contextLoadStarted && planningReady && runtimePreparationStarted);
      assert.ok(marks.t1 <= marks.t2);
      // Planning is deliberately completed before entering serialization ownership;
      // the mutation-stage Reality verification is then the final gate before dispatch.
      assert.ok(marks.t2 <= marks.t4);
      assert.ok(marks.t4 <= marks.t3);
      assert.ok(marks.t3 <= marks.t5);
      child.diagnostic(JSON.stringify({ run,
        "T2-T1-ms": milliseconds(marks.t2, marks.t1),
        "T3-T2-ms": milliseconds(marks.t3, marks.t2),
        "T4-T3-ms": milliseconds(marks.t4, marks.t3),
        "T5-T4-ms": milliseconds(marks.t5, marks.t4),
        "T5-T2-ms": milliseconds(marks.t5, marks.t2),
        "second-context-load-ms": milliseconds(marks.t4, contextLoadStarted),
        "quantity-planning-ms": milliseconds(planningReady, marks.t4),
        "fake-runtime-preparation-ms": milliseconds(marks.t5, runtimePreparationStarted),
      }));
    });
  }
});

test("full-full Start establishes a SQLite store-method hot-path baseline", async (t) => {
  const fixture = setup(t);
  const confirmationId = "sqlite-hot-path";
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId }));
  const counts = new Map<string, number>();
  const store = fixture.store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of [
    "get",
    "readCommandReplay",
    "claimExecutionReference",
    "linkExecutionRecord",
    "applyExecutionResult",
    "prepareSecondLegHedge",
    "readSpotOpeningAttributionEvidence",
    "recordSpotOpeningAttributionEvidence",
  ]) {
    const original = store[method]!.bind(fixture.store);
    store[method] = (...args: unknown[]) => {
      counts.set(method, (counts.get(method) ?? 0) + 1);
      return original(...args);
    };
  }
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);

  const result = await orchestration.start("user-a", created.instance.arbitrageId, {
    ...finalRequest({ confirmationId }),
    hedgeCommandId: "sqlite-hot-path-command",
    firstLegId: "long-leg",
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(fixture.runtime.calls.length, 2);
  t.diagnostic(JSON.stringify(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))));
});

test("one-click orchestration is mutation-idempotent and stops safely for all four venues", async (t) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await t.test(venue, async (child) => {
      const happy = setup(child, {
        draft: sameInstrumentPerpetualDraft(venue),
        runtimeVenues: [venue],
        credentialVenues: [venue],
      });
      const created = await happy.service.confirm("user-a", finalRequest({ confirmationId: `${venue}-full` }));
      happy.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
      const orchestration = new ArbitrageHedgeStartService(happy.store, happy.service);
      const request = {
        ...finalRequest({ confirmationId: `${venue}-full` }),
        hedgeCommandId: `${venue}-full-command`,
        firstLegId: "long-leg",
      };
      assert.equal((await orchestration.start("user-a", created.instance.arbitrageId, request)).status, "COMPLETED");
      assert.equal((await orchestration.start("user-a", created.instance.arbitrageId, request)).status, "COMPLETED");
      assert.deepEqual(happy.runtime.calls.map(({ venue: calledVenue }) => calledVenue), [venue, venue]);
      assert.deepEqual(happy.runtime.calls.map(({ positionDirection }) => positionDirection), ["LONG", "SHORT"]);

      const stopped = setup(child, {
        draft: sameInstrumentPerpetualDraft(venue),
        runtimeVenues: [venue],
        credentialVenues: [venue],
      });
      const stoppedInstance = await stopped.service.confirm(
        "user-a",
        finalRequest({ confirmationId: `${venue}-unknown` }),
      );
      stopped.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);
      const stoppedOrchestration = new ArbitrageHedgeStartService(stopped.store, stopped.service);
      const stoppedResult = await stoppedOrchestration.start("user-a", stoppedInstance.instance.arbitrageId, {
        ...finalRequest({ confirmationId: `${venue}-unknown` }),
        hedgeCommandId: `${venue}-unknown-command`,
        firstLegId: "long-leg",
      });
      assert.equal(stoppedResult.status, "STOPPED_FIRST_LEG_UNKNOWN");
      assert.equal(stopped.runtime.calls.length, 1);
      assert.equal(stopped.store.get("user-a", stoppedInstance.instance.arbitrageId)?.executionReferences.length, 1);
    });
  }
});

test("one-click orchestration preserves continuation and second-leg OpeningSafety gates", async (t) => {
  await t.test("continuation safety", async (child) => {
    let continuationStatus: "SUPPORTED" | "UNSUPPORTED" = "SUPPORTED";
    const fixture = setup(child, { continuationSafety: { evaluate: async () => ({
      firstLegId: "long-leg", activeAttributedExposure: "0.001", status: continuationStatus,
      reason: continuationStatus === "SUPPORTED" ? "FIRST_LEG_REALITY_SUPPORTED" : "FIRST_LEG_REALITY_INSUFFICIENT",
      checkedAt: now,
    }) } });
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "one-click-continuation" }));
    fixture.runtime.onExecute = (intent) => {
      if (intent.legId === "long-leg") continuationStatus = "UNSUPPORTED";
      return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
    };
    const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);
    const result = await orchestration.start("user-a", created.instance.arbitrageId, {
      ...finalRequest({ confirmationId: "one-click-continuation" }), hedgeCommandId: "one-click-continuation-command",
      firstLegId: "long-leg",
    });
    assert.equal(result.status, "STOPPED_SAFETY");
    assert.equal(fixture.runtime.calls.length, 1);
  });

  await t.test("perpetual opening safety after Reality drift", async (child) => {
    const safety = mutableOpeningSafety("flat");
    const fixture = setup(child, { openingSafety: safety });
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "one-click-drift" }));
    fixture.runtime.onExecute = (intent) => {
      if (intent.legId === "long-leg") safety.current = "opposite";
      return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
    };
    const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);
    const result = await orchestration.start("user-a", created.instance.arbitrageId, {
      ...finalRequest({ confirmationId: "one-click-drift" }), hedgeCommandId: "one-click-drift-command",
      firstLegId: "long-leg",
    });
    assert.equal(result.status, "STOPPED_SAFETY");
    assert.equal(fixture.runtime.calls.length, 1);
  });
});

test("explicit terminal-partial continuation hedges attributable exposure without retrying the first leg", async (t) => {
  const fixture = setup(t, { draft: draft(true, "0.002") });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "partial-continue",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } }));
  fixture.runtime.onExecute = (intent) => runtimeResult(
    intent,
    fixture.runtime.calls.length === 1 ? "FAILED" : "CONFIRMED",
    fixture.runtime.calls.length === 1 ? "0.001" : intent.quantity.quantity,
  );

  const first = await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    "partial-first",
    { confirmationId: "partial-continue", quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } },
  ));
  assert.equal(first.executionRecord.status, "FAILED");
  assert.equal(first.executionRecord.confirmedQuantity, "0.001");

  const continuationRequest = {
    ...finalRequest({ confirmationId: "partial-continue", quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } }),
    commandId: "partial-continue-command",
  };
  const completed = await fixture.service.continuePartialHedge(
    "user-a",
    created.instance.arbitrageId,
    continuationRequest,
  );

  assert.deepEqual(fixture.runtime.calls.map(({ legId, quantity }) => ({ legId, quantity: quantity.quantity })), [
    { legId: "long-leg", quantity: "0.002" },
    { legId: "short-leg", quantity: "0.001" },
  ]);
  assert.equal(completed.instance.executionReferences[0]?.status, "FAILED");
  assert.equal(completed.instance.executionReferences[0]?.confirmedQuantity, "0.001");
  assert.equal(completed.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(completed.instance.legs[1].confirmedOpenedQuantity, "0.001");
  assert.equal(fixture.drafts.createCalls.length, 1, "partial continue must load its own fresh Draft context");

  const replay = await fixture.service.continuePartialHedge(
    "user-a",
    created.instance.arbitrageId,
    continuationRequest,
  );
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fixture.runtime.calls.length, 2);
  await assert.rejects(
    () => fixture.service.continuePartialHedge("user-a", created.instance.arbitrageId, {
      ...continuationRequest, executionMode: "EXECUTION_PRIORITY",
    }),
    (error) => error instanceof ArbitrageExecutionCommandError && error.category === "idempotency_conflict",
  );
  assert.equal(fixture.runtime.calls.length, 2);
});

test("different commandIds racing terminal-partial continue can claim only one second execution", async (t) => {
  const fixture = setup(t, { draft: draft(true, "0.002") });
  const created = await fixture.service.confirm("user-a", finalRequest({
    confirmationId: "partial-concurrent",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" },
  }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    "partial-concurrent-first",
    { confirmationId: "partial-concurrent", quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } },
  ));

  const entered = deferred<void>();
  const release = deferred<void>();
  fixture.runtime.onExecute = async (intent) => {
    entered.resolve();
    await release.promise;
    return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  };
  const continuation = (commandId: string) => fixture.service.continuePartialHedge(
    "user-a",
    created.instance.arbitrageId,
    {
      ...finalRequest({
        confirmationId: "partial-concurrent",
        quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" },
      }),
      commandId,
    },
  );
  const first = continuation("partial-concurrent-a");
  await entered.promise;
  const second = continuation("partial-concurrent-b");
  release.resolve();
  const outcomes = await Promise.allSettled([first, second]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(fixture.runtime.calls.length, 2, "one first-leg order plus exactly one second-leg order");
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 2);
});

test("terminal-partial continuation fails before second Provider mutation when fresh Reality is unsupported", async (t) => {
  let freshReads = 0;
  const fixture = setup(t, { draft: draft(true, "0.002"), continuationSafety: {
    loadFreshVerification: async () => {
      freshReads += 1;
      return null;
    },
    evaluate: async () => ({
      firstLegId: "long-leg", activeAttributedExposure: "0.001", status: "UNSUPPORTED",
      reason: "FIRST_LEG_REALITY_INSUFFICIENT", checkedAt: now,
    }),
  } });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "partial-reality",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId, "long-leg", "partial-reality-first", { confirmationId: "partial-reality",
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } },
  ));

  await assert.rejects(
    () => fixture.service.continuePartialHedge("user-a", created.instance.arbitrageId, {
      ...finalRequest({ confirmationId: "partial-reality", quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.002" } }),
      commandId: "partial-reality-continue",
    }),
    (error) => error instanceof ArbitrageExecutionCommandError && error.category === "second_leg_not_allowed",
  );
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(freshReads, 1, "manual partial continuation must load a new mutation-time context");
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 1);
});

test("Spot terminal-partial continuation uses attributable base exposure rather than gross fill", async (t) => {
  const fixture = setup(t, { draft: draft(true, "0.003"), spotExposure: "0.001" });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "spot-partial",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.003" } }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent,
    fixture.runtime.calls.length === 1 ? "FAILED" : "CONFIRMED",
    fixture.runtime.calls.length === 1 ? "0.002" : intent.quantity.quantity);
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId, "long-leg", "spot-partial-first", { confirmationId: "spot-partial",
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.003" } },
  ));

  const completed = await fixture.service.continuePartialHedge("user-a", created.instance.arbitrageId, {
    ...finalRequest({ confirmationId: "spot-partial", quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.003" } }),
    commandId: "spot-partial-continue",
  });

  assert.deepEqual(fixture.runtime.calls.map(({ legId, quantity }) => [legId, quantity.quantity]), [
    ["long-leg", "0.003"], ["short-leg", "0.001"],
  ]);
  assert.equal(completed.instance.executionReferences[0]?.confirmedQuantity, "0.002");
  assert.equal(completed.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(fixture.store.readSpotOpeningAttributionEvidence(
    "user-a", created.instance.arbitrageId, "long-leg",
  )[0]?.attributableBaseQuantity, "0.001");
});

test("confirmed Spot first leg persists opening attribution evidence", async (t) => {
  const fixture = setup(t, { spotExposure: "0.00099" });
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);

  const completed = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg", "spot-first-command"),
  );

  const spotReference = completed.instance.executionReferences.find((reference) => reference.legId === "long-leg")!;
  assert.deepEqual(
    fixture.store.readSpotOpeningAttributionEvidence("user-a", created.instance.arbitrageId, "long-leg")
      .map(({ attributableBaseQuantity, executionIntentId }) => ({ attributableBaseQuantity, executionIntentId })),
    [{ attributableBaseQuantity: "0.00099", executionIntentId: spotReference.executionIntentId }],
  );
});

test("second leg uses confirmed first-leg exposure instead of a drifted latest budget plan", async (t) => {
  let duplicateContextLoads = 0;
  const fixture = setup(t, {
    draft: draftWithLegQuantities("114.711786", "110"),
    spotExposure: "114.597074",
    planningContext: async () => {
      duplicateContextLoads += 1;
      throw new Error("same-stage context must come from the authoritative Draft");
    },
  });
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  const latest = draftWithLegQuantities("111", "110");
  fixture.drafts.value = {
    ...latest,
    legs: [latest.legs[0], {
      ...latest.legs[1],
      tradingRules: { quantityStep: "10", minQuantity: "10",
        priceTick: "0.1", minNotional: "5", precision: {} },
      quote: { bid: "0.069", ask: "0.07", updatedAt: now },
    }],
  };

  const second = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg", "second-command"),
  );

  assert.equal(fixture.runtime.calls[1]?.quantity.quantity, "110");
  assert.equal(second.instance.executionReferences[0]?.confirmedQuantity, "114.711786");
  assert.equal(second.instance.legs[0].confirmedOpenedQuantity, "114.597074");
  assert.equal(duplicateContextLoads, 0);
  assert.equal(second.instance.legs[0].plannedQuantity, "114.597074");
  assert.equal(second.instance.legs[1].plannedQuantity, "110");
  assert.equal(second.instance.legs[1].confirmedOpenedQuantity, "110");
  assert.equal(second.instance.maxResidualBaseQuantity, "4.597074");
  assert.equal(second.instance.status, "HOLDING");
  assert.deepEqual(
    fixture.store.readSpotOpeningAttributionEvidence("user-a", created.instance.arbitrageId, "long-leg")
      .map(({ attributableBaseQuantity, executionIntentId, source }) => ({
        attributableBaseQuantity, executionIntentId, source,
      })),
    [{
      attributableBaseQuantity: "114.597074",
      executionIntentId: second.instance.executionReferences[0]?.executionIntentId,
      source: "PROVIDER_ORDER_FILLS",
    }],
  );
  assert.equal(fixture.drafts.calls.length, 2, "second leg must not rerun the original budget preview");
  assert.equal(fixture.drafts.createCalls.length, 1, "second leg still revalidates Draft identity and capability");
});

test("second-leg Draft context fails closed when its quote has expired without refetching outside the stage", async (t) => {
  let fallbackLoads = 0;
  const fixture = setup(t, {
    planningContext: async () => {
      fallbackLoads += 1;
      throw new Error("expired context must not silently fall back");
    },
  });
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "stale-second-context" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  await fixture.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId, "long-leg", "stale-context-first", { confirmationId: "stale-second-context" },
  ));
  fixture.drafts.value = {
    ...fixture.drafts.value,
    legs: [fixture.drafts.value.legs[0], {
      ...fixture.drafts.value.legs[1],
      quote: { ...fixture.drafts.value.legs[1].quote!, updatedAt: now - 10_001 },
    }],
  };

  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId, "short-leg", "stale-context-second", { confirmationId: "stale-second-context" },
    )),
    (error) => error instanceof ArbitrageExecutionCommandError
      && error.category === "execution_capability_unavailable",
  );
  assert.equal(fallbackLoads, 0);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("full-full Start removes one duplicate planning rules and quote load for all venues", async (t) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await t.test(venue, async (child) => {
      let rulesLoads = 0;
      let quoteLoads = 0;
      let duplicatePlanningLoads = 0;
      const fixture = setup(child, {
        draft: draft(true, "0.001", ["binance", venue]),
        runtimeVenues: [venue],
        credentialVenues: ["binance", venue],
        planningContext: async () => {
          duplicatePlanningLoads += 1;
          rulesLoads += 1;
          quoteLoads += 1;
          throw new Error("same-stage duplicate planning load");
        },
      });
      const preview = fixture.drafts.preview.bind(fixture.drafts);
      fixture.drafts.preview = async (...args: Parameters<typeof preview>) => {
        rulesLoads += 2;
        quoteLoads += 2;
        return preview(...args);
      };
      const createDraft = fixture.drafts.createDraft.bind(fixture.drafts);
      fixture.drafts.createDraft = async (...args: Parameters<typeof createDraft>) => {
        rulesLoads += 2;
        quoteLoads += 2;
        return createDraft(...args);
      };
      const confirmationId = `rules-count-${venue}`;
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId }));
      rulesLoads = 0;
      quoteLoads = 0;
      fixture.runtime.onExecute = (intent) => {
        rulesLoads += 1;
        quoteLoads += 1;
        return runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
      };
      const orchestration = new ArbitrageHedgeStartService(fixture.store, fixture.service);

      const result = await orchestration.start("user-a", created.instance.arbitrageId, {
        ...finalRequest({ confirmationId }),
        hedgeCommandId: `rules-count-command-${venue}`,
        firstLegId: "long-leg",
      });

      assert.equal(result.status, "COMPLETED");
      assert.equal(duplicatePlanningLoads, 0);
      assert.equal(rulesLoads, 6);
      assert.equal(quoteLoads, 6);
    });
  }
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
  const belowMinimum = draftWithLegQuantities("5", "5");
  const fixture = setup(t, {
    draft: {
      ...belowMinimum,
      legs: [belowMinimum.legs[0], {
        ...belowMinimum.legs[1],
        tradingRules: { quantityStep: "1", minQuantity: "10", priceTick: "0.1",
          minNotional: "5", precision: {} },
        quote: { bid: "1", ask: "1", updatedAt: now },
      }],
    },
    spotExposure: "5",
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

test("Open command fingerprint survives restart, normalizes decimals, and rejects changed business payload", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  const commandId = "durable-open-fingerprint";
  const first = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg", commandId),
  );
  const restarted = fixture.restart();

  const normalizedReplay = await restarted.service.executeLeg("user-a", legRequest(
    created.instance.arbitrageId,
    "long-leg",
    commandId,
    { quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.001000" } },
  ));
  assert.equal(normalizedReplay.idempotentReplay, true);
  assert.equal(normalizedReplay.executionRecord.intentId, first.executionRecord.intentId);
  assert.equal(fixture.runtime.calls.length, 1);

  await assert.rejects(
    () => restarted.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "long-leg",
      commandId,
      { executionMode: "EXECUTION_PRIORITY" },
    )),
    (error: unknown) => error instanceof ArbitrageExecutionCommandError
      && error.category === "idempotency_conflict",
  );
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
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
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

test("startup one-shot reuses opening reconciliation and is idempotent without another mutation", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "startup-opening" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0004");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "startup-open"));
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");
  const mutationCount = fixture.runtime.calls.length;
  const startup = new ArbitrageStartupRecoveryService(fixture.store, fixture.service, silentRecoveryLogger());

  const recovered = await startup.runOnce();
  const replay = await startup.runOnce();

  const current = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(recovered.recovered, 1);
  assert.equal(replay.candidates, 0);
  assert.equal(current.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(current.executionReferences[0]?.status, "CONFIRMED");
  assert.equal(fixture.runtime.calls.length, mutationCount);
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("startup local proof terminalizes a pre-start CLAIMED opening without record or Provider mutation", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "local-proof-opening" }));
  const intentId = "local-proof-opening-intent";
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "long-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: intentId,
    requestedQuantity: "0.001",
    createdAt: now + 1,
  });
  const startup = new ArbitrageStartupRecoveryService(
    fixture.store,
    fixture.service,
    silentRecoveryLogger(),
    new LocalNotDispatchedEvidenceEvaluator(fixture.runtime, () => now + 2),
  );
  const preListenSnapshot = startup.discoverCandidates();

  const result = await startup.runOnce(preListenSnapshot);

  const terminal = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(result.outcomes[0]?.reason, "LOCAL_NO_EXECUTION_RECORD");
  assert.equal(terminal.status, "FAILED");
  assert.equal(terminal.executionReferences[0]?.status, "FAILED");
  assert.equal(terminal.executionReferences[0]?.executionRecordId, null);
  assert.equal(terminal.executionReferences[0]?.confirmedQuantity, "0");
  assert.equal(terminal.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(fixture.runtime.calls.length, 0);

  const next = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "after-local-proof" }));
  assert.doesNotThrow(() => fixture.store.claimExecutionReference("user-a", next.instance.arbitrageId, {
    legId: "long-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: "after-local-proof-intent",
    requestedQuantity: "0.001",
    createdAt: now + 3,
  }));
});

test("startup local proof never re-executes a second leg or changes first-leg exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "local-proof-second" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "local-proof-first"));
  const mutationCount = fixture.runtime.calls.length;
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "short-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: "local-proof-second-intent",
    requestedQuantity: "0.001",
    createdAt: now + 2,
  });
  const startup = new ArbitrageStartupRecoveryService(
    fixture.store,
    fixture.service,
    silentRecoveryLogger(),
    new LocalNotDispatchedEvidenceEvaluator(fixture.runtime, () => now + 3),
  );

  await startup.runOnce(startup.discoverCandidates());

  const current = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(current.status, "RESIDUAL");
  assert.deepEqual(current.legs.map(({ confirmedOpenedQuantity }) => confirmedOpenedQuantity), ["0.001", "0"]);
  assert.equal(current.executionReferences.at(-1)?.status, "FAILED");
  assert.equal(fixture.runtime.calls.length, mutationCount);
});

test("startup local proof terminalizes a CLAIMED close at zero without changing managed exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "local-proof-close" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "local-proof-long"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "local-proof-short"));
  const mutationCount = fixture.runtime.calls.length;
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "long-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: "local-proof-close-intent",
    requestedQuantity: "0.001",
    createdAt: now + 3,
  });
  const startup = new ArbitrageStartupRecoveryService(
    fixture.store,
    fixture.service,
    silentRecoveryLogger(),
    new LocalNotDispatchedEvidenceEvaluator(fixture.runtime, () => now + 4),
  );

  await startup.runOnce(startup.discoverCandidates());

  const current = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(current.status, "RESIDUAL");
  assert.equal(current.legs[0].confirmedClosedQuantity, "0");
  assert.equal(activeManagedQuantity(current, current.legs[0]), "0.001");
  assert.equal(current.executionReferences.at(-1)?.status, "FAILED");
  assert.equal(fixture.runtime.calls.length, mutationCount);
});

test("startup one-shot projects only the new close cumulative delta and never sends a remainder close", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "startup-close" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "startup-long-open"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "startup-short-open"));
  const closeIntentId = "startup-close-intent";
  const closeTime = now + 10;
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "long-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: closeIntentId,
    requestedQuantity: "0.001",
    createdAt: closeTime,
  });
  const record = recoveryRecord(closeIntentId, created.instance.legs[0], {
    executionId: "startup-close-record",
    createdAt: closeTime,
    updatedAt: closeTime,
  });
  fixture.runtime.records.set(record.executionId, record);
  fixture.store.linkExecutionRecord(
    "user-a", created.instance.arbitrageId, closeIntentId, record.executionId, closeTime,
  );
  fixture.store.applyExecutionResult("user-a", created.instance.arbitrageId, {
    executionIntentId: closeIntentId,
    status: "PENDING_CONFIRMATION",
    confirmedQuantity: "0.0004",
    updatedAt: closeTime,
  });
  fixture.runtime.onReconcile = (current) => reconciliationResult(current, "FAILED", "0.0007");
  const mutationCount = fixture.runtime.calls.length;

  const result = await new ArbitrageStartupRecoveryService(
    fixture.store,
    fixture.service,
    silentRecoveryLogger(),
  ).runOnce();

  const current = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(result.recovered, 1);
  assert.equal(current.legs[0].confirmedClosedQuantity, "0.0007");
  assert.equal(current.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(fixture.runtime.calls.length, mutationCount);
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("startup one-shot leaves an UNKNOWN second leg unresolved and never re-executes it", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "startup-second-leg" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(
    intent,
    intent.instrumentId.endsWith("SPOT") ? "CONFIRMED" : "UNKNOWN",
    intent.instrumentId.endsWith("SPOT") ? intent.quantity.quantity : null,
  );
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg", "startup-first-leg"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "startup-second-leg"));
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "UNKNOWN", null);
  const mutationCount = fixture.runtime.calls.length;

  const result = await new ArbitrageStartupRecoveryService(
    fixture.store,
    fixture.service,
    silentRecoveryLogger(),
  ).runOnce();

  const current = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(result.stillUnknown, 1);
  assert.equal(current.executionReferences.at(-1)?.status, "UNKNOWN");
  assert.equal(current.legs[1].confirmedOpenedQuantity, "0");
  assert.equal(fixture.runtime.calls.length, mutationCount);
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("startup snapshot correction preserves a Management Release responsibility cutoff", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "startup-release" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.0004");
  const opening = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg", "startup-release-open"),
  );
  const leg = opening.instance.legs[0];
  const released = fixture.store.releaseLegManagement("user-a", created.instance.arbitrageId, {
    releaseId: "startup-release-id",
    commandId: "startup-release-command",
    operationType: "MANAGEMENT_RELEASE",
    businessPayloadFingerprint: "startup-release-fingerprint",
    arbitrageId: created.instance.arbitrageId,
    legId: leg.legId,
    releasedQuantity: "0.0004",
    reason: "USER_CONFIRMED_STOP_MANAGEMENT",
    source: "AUTHENTICATED_API",
    requestedByUserId: "user-a",
    requestedAt: now + 10,
    confirmedAt: now + 11,
    venue: leg.venue,
    accountId: leg.accountId,
    instrumentId: leg.instrumentId,
    positionMode: "ONE_WAY",
    actualQuantity: "0",
    actualSignedNetQuantity: "0",
    actualLongQuantity: "0",
    actualShortQuantity: "0",
    availableQuantity: null,
    realityCheckedAt: now + 10,
  }).instance;
  assert.equal(released.status, "CLOSED");
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "FAILED", "0.0007");
  const startupSnapshot = [{
    userId: "user-a",
    arbitrageId: created.instance.arbitrageId,
    legId: leg.legId,
    executionIntentId: opening.executionRecord.intentId,
    executionRecordId: opening.executionRecord.executionId,
    status: "UNKNOWN" as const,
    phase: "OPENING" as const,
    quantityEffect: "INCREASE" as const,
    requestedQuantity: "0.001",
    confirmedQuantity: "0.0004",
    venue: leg.venue,
    accountId: leg.accountId,
    instrumentId: leg.instrumentId,
    role: leg.role,
    createdAt: now,
    updatedAt: now,
  }];

  const result = await new ArbitrageStartupRecoveryService(
    { listUnresolvedExecutionReferencesForRecovery: () => startupSnapshot },
    fixture.service,
    silentRecoveryLogger(),
  ).runOnce();

  const corrected = fixture.store.get("user-a", created.instance.arbitrageId)!;
  assert.equal(result.recovered, 1);
  assert.equal(corrected.status, "CLOSED");
  assert.equal(corrected.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(activeManagedQuantity(corrected, corrected.legs[0]), "0");
  assert.equal(corrected.managementReleases?.length, 1);
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
  assert.equal(fixture.runtime.reconcileCalls.length, 2);
});

test("FAILED terminal reconciliation projects only the newly observed cumulative fill", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.0004");
  const first = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg"),
  );
  const executionIntentId = first.executionRecord.intentId;
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "FAILED", "0.0007");

  const corrected = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
    executionIntentId,
  });
  const replay = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
    executionIntentId,
  });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");
  const fullFillWins = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
    executionIntentId,
  });

  assert.equal(corrected.executionRecord.status, "FAILED");
  assert.equal(corrected.executionRecord.confirmedQuantity, "0.0007");
  assert.equal(corrected.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(replay.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fullFillWins.executionRecord.status, "CONFIRMED");
  assert.equal(fullFillWins.executionRecord.confirmedQuantity, "0.001");
  assert.equal(fullFillWins.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(fullFillWins.secondLegAllowed, true);
  assert.equal(fixture.runtime.reconcileCalls.length, 3);
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("CLOSED historical reconcile corrects one explicit execution without reopening mutation workflow", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.0004");
  const opening = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg", "historical-opening-command"),
  );
  const executionIntentId = opening.executionRecord.intentId;
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "long-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: "known-terminal-close",
    requestedQuantity: "0.0004",
    createdAt: now + 10,
  });
  fixture.store.linkExecutionRecord(
    "user-a", created.instance.arbitrageId, "known-terminal-close", "known-terminal-close-record", now + 11,
  );
  const closed = fixture.store.applyExecutionResult("user-a", created.instance.arbitrageId, {
    executionIntentId: "known-terminal-close",
    status: "CONFIRMED",
    confirmedQuantity: "0.0004",
    updatedAt: now + 12,
  });
  assert.equal(closed.status, "CLOSED");
  const mutationCount = fixture.runtime.calls.length;
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "FAILED", "0.0007");

  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", {
      arbitrageId: created.instance.arbitrageId,
      legId: "long-leg",
    }),
    (error: unknown) => error instanceof ArbitrageExecutionCommandError
      && error.category === "arbitrage_execution_reference_not_found",
  );
  const corrected = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
    executionIntentId,
  });

  assert.equal(corrected.instance.status, "CLOSED");
  assert.equal(corrected.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(corrected.instance.legs[0].confirmedClosedQuantity, "0.0004");
  assert.equal(corrected.executionRecord.status, "FAILED");
  assert.equal(corrected.secondLegAllowed, false);
  assert.equal(fixture.runtime.calls.length, mutationCount);
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
  assert.equal(fixture.runtime.providerMutations, 0);
  await assert.rejects(
    () => fixture.service.executeLeg(
      "user-a",
      legRequest(created.instance.arbitrageId, "short-leg", "forbidden-after-history"),
    ),
    /Terminal arbitrage instance|不能继续自动推进|第一腿尚未完整确认/u,
  );
  assert.equal(fixture.runtime.calls.length, mutationCount);
});

test("FAILED historical reconcile is read-only and preserves terminal workflow", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: "failed-history" }));
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.0004");
  const opening = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg", "failed-history-open"),
  );
  const legacyDb = new DatabaseSync(fixture.dbPath);
  legacyDb.prepare(`UPDATE arbitrage_instances SET status = 'FAILED', updatedAt = ?
    WHERE arbitrageId = ?`).run(now + 20, created.instance.arbitrageId);
  legacyDb.close();
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "FAILED", "0.0007");
  const mutationCount = fixture.runtime.calls.length;

  const corrected = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
    executionIntentId: opening.executionRecord.intentId,
  });

  assert.equal(corrected.instance.status, "FAILED");
  assert.equal(corrected.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(corrected.secondLegAllowed, false);
  assert.equal(fixture.runtime.calls.length, mutationCount);
  assert.equal(fixture.runtime.providerMutations, 0);
  await assert.rejects(
    () => fixture.service.executeLeg(
      "user-a",
      legRequest(created.instance.arbitrageId, "short-leg", "forbidden-failed-history"),
    ),
    /Terminal arbitrage instance|不能继续自动推进|第一腿尚未完整确认/u,
  );
  assert.equal(fixture.runtime.calls.length, mutationCount);
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
  assert.equal(repeated.runtime.reconcileCalls.length, 2);

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
  onExecute: (intent: ExecutionIntent) => ReturnType<typeof runtimeResult> | Promise<ReturnType<typeof runtimeResult>> =
    (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  onReconcile: (record: ExecutionRecord) => ReturnType<typeof reconciliationResult> | Promise<ReturnType<typeof reconciliationResult>> = (record) => reconciliationResult(record, "UNKNOWN", null);
  async execute(intent: ExecutionIntent) {
    this.calls.push(intent);
    const result = await this.onExecute(intent);
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
  spotAttribution?: SpotOpeningAttributionSource;
  claimFailure?: "before" | "after";
  createIntentId?: (userId: string, arbitrageId: string, legId: string, commandId: string) => string;
  planningContext?: (
    venue: ExecutionVenue,
    instrumentId: string,
    leg: ArbitrageExecutionDraft["legs"][number],
  ) => Promise<import("./ArbitrageExecutionPlanningContext").ArbitrageExecutionPlanningContext>
    | import("./ArbitrageExecutionPlanningContext").ArbitrageExecutionPlanningContext;
  openingSafety?: Readonly<{
    evaluate(userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance,
      input?: import("../cex/arbitrage-instance/ArbitragePositionVerification").ArbitragePositionVerificationResult | null): Promise<readonly import("./ArbitrageOpeningSafetyEvaluator").ArbitrageOpeningSafetyResult[]>;
  }>;
  continuationSafety?: Readonly<{
    loadFreshVerification?(userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance): Promise<import("../cex/arbitrage-instance/ArbitragePositionVerification").ArbitragePositionVerificationResult | null>;
    evaluate(userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance,
      firstExecutionIntentId: string,
      input?: import("../cex/arbitrage-instance/ArbitragePositionVerification").ArbitragePositionVerificationResult | null): Promise<import("./OpeningContinuationSafetyEvaluator").OpeningContinuationSafetyResult>;
  }>;
  mutationSerializer?: ProviderMutationSerializer;
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
    options.openingSafety ?? alwaysSafeOpening(),
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
      spotAttributions: Object.fromEntries(
        (["binance", "okx", "bybit", "bitget"] as const).map((venue) => [venue, options.spotAttribution ?? {
          readAttributableBaseQuantity: async (_userId, request) =>
            options.spotExposure ?? request.grossConfirmedQuantity,
        }]),
      ),
      continuationSafety: {
        loadFreshVerification: options.continuationSafety?.loadFreshVerification
          ?? (async () => null),
        evaluate: options.continuationSafety?.evaluate ?? (async (_userId, instance, firstExecutionIntentId) => {
          const first = instance.executionReferences.find((reference) =>
            reference.executionIntentId === firstExecutionIntentId)!;
          return Object.freeze({
            firstLegId: first.legId,
            activeAttributedExposure: first.confirmedQuantity,
            status: "SUPPORTED" as const,
            reason: "FIRST_LEG_REALITY_SUPPORTED" as const,
            checkedAt: now,
          });
        }),
      },
    },
    {
      clock: () => now,
      createIntentId: options.createIntentId,
      intentTtlMs: 30_000,
      mutationSerializer: options.mutationSerializer,
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
    dbPath,
    drafts,
    runtime,
    service,
    store: activeStore,
    createService,
    restart,
    accountIds: credentials.accountIds,
  };
}

function alwaysSafeOpening() {
  return {
    evaluate: async (_userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance) => Object.freeze(
      instance.legs.filter((leg) => leg.instrumentId.endsWith("-PERP")).map((leg) => Object.freeze({
        legId: leg.legId,
        targetDirection: leg.role,
        positionMode: "ONE_WAY" as const,
        currentSignedNetQuantity: "0",
        openingAttributionSafe: true,
        reason: "ONE_WAY_FLAT" as const,
        checkedAt: now,
      })),
    ),
  };
}

type OpeningReality = "flat" | "same" | "opposite" | "unknown" | "hedge";

function mutableOpeningSafety(initial: OpeningReality) {
  return {
    current: initial,
    afterFirstRead: null as OpeningReality | null,
    calls: 0,
    async evaluate(_userId: string, instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance) {
      this.calls += 1;
      const state = this.calls > 1 && this.afterFirstRead !== null ? this.afterFirstRead : this.current;
      return Object.freeze(instance.legs.filter((leg) => leg.instrumentId.endsWith("-PERP")).map((leg) => {
        const signed = state === "flat" ? "0"
          : state === "same" ? leg.role === "SHORT" ? "-30" : "30"
            : state === "opposite" ? leg.role === "SHORT" ? "30" : "-30"
              : null;
        return Object.freeze({
          legId: leg.legId,
          targetDirection: leg.role,
          positionMode: state === "unknown" ? null : state === "hedge" ? "HEDGE" as const : "ONE_WAY" as const,
          currentSignedNetQuantity: signed,
          openingAttributionSafe: state === "flat" || state === "same" || state === "hedge",
          reason: state === "flat" ? "ONE_WAY_FLAT" as const
            : state === "same" ? "ONE_WAY_SAME_DIRECTION" as const
              : state === "opposite" ? "ONE_WAY_OPPOSITE_DIRECTION" as const
                : state === "hedge" ? "HEDGE_BUCKET_ISOLATED" as const
                  : "PROVIDER_REALITY_UNKNOWN" as const,
          checkedAt: now + this.calls,
        });
      }));
    },
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

function silentRecoveryLogger() {
  return { info: () => undefined, warn: () => undefined };
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
    tradingRules: { quantityStep: venue === "okx" && instrumentId.endsWith("PERP") ? "1" : "0.001",
      minQuantity: venue === "okx" && instrumentId.endsWith("PERP") ? "1" : "0.001",
      ...(venue === "okx" && instrumentId.endsWith("PERP") ? { contractSize: "0.001" } : {}),
      priceTick: "0.1", minNotional: "5", precision: {} },
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
    executionMode: "PRICE_PRIORITY",
    strategyType: "SPOT_PERPETUAL",
    quantityInput: { mode: "ASSET_QUANTITY", quantity },
    legs: [leg("LONG", "BTC-USDT-SPOT", venues[0]), leg("SHORT", "BTC-USDT-PERP", venues[1])],
    allLegsExecutable: allAvailable,
    generatedAt: now,
  };
}

function okxPriceUnsupportedDraft(): ArbitrageExecutionDraft {
  const base = draft(true, "0.001", ["binance", "okx"]);
  return {
    ...base,
    executionMode: "PRICE_PRIORITY",
    legs: [
      base.legs[0],
      {
        ...base.legs[1],
        capability: { status: "UNAVAILABLE", reasonCode: "EXECUTION_MODE_NOT_SUPPORTED" },
        executionAvailable: false,
      },
    ],
    allLegsExecutable: false,
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

function sameInstrumentPerpetualDraft(
  firstVenue: ExecutionVenue = "binance",
  secondVenue: ExecutionVenue = firstVenue,
): ArbitrageExecutionDraft {
  const base = draft(true, "0.001", [firstVenue, secondVenue]);
  return {
    ...base,
    strategyType: "PERPETUAL_PERPETUAL",
    legs: base.legs.map((leg) => ({
      ...leg,
      instrumentId: "BTC-USDT-PERP",
      marketType: "perpetual" as const,
      providerSymbol: leg.venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
      planning: leg.planning.status === "PLANNED" ? {
        ...leg.planning,
        plan: { ...leg.planning.plan, instrumentId: "BTC-USDT-PERP",
          providerSymbol: leg.venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT" },
      } : leg.planning,
    })) as unknown as ArbitrageExecutionDraft["legs"],
  };
}

function openingResults(
  instance: import("../cex/arbitrage-instance/ArbitrageInstance").ArbitrageInstance,
  signedReality: string,
) {
  return Object.freeze(instance.legs.filter((leg) => leg.instrumentId.endsWith("-PERP")).map((leg) => {
    const flat = signedReality === "0";
    const currentShort = signedReality.startsWith("-");
    const same = flat || (leg.role === "SHORT") === currentShort;
    return Object.freeze({
      legId: leg.legId,
      targetDirection: leg.role,
      positionMode: "ONE_WAY" as const,
      currentSignedNetQuantity: signedReality,
      openingAttributionSafe: same,
      reason: flat ? "ONE_WAY_FLAT" as const
        : same ? "ONE_WAY_SAME_DIRECTION" as const : "ONE_WAY_OPPOSITE_DIRECTION" as const,
      checkedAt: now,
    });
  }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
