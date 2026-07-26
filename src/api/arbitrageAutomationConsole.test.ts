import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationConsoleFixture } from "../features/arbitrageAutomation/model/controlConsoleFixture";
import type {
  AutomationPreflight,
  AutomationPreflightResult,
} from "../features/arbitrageAutomation/model/controlConsoleTypes";
import {
  AutomationConsoleContractError,
  credentialDeleteStepUpIntent,
  credentialStepUpIntent,
  createUserAutomationConsoleClient,
  executionStepUpIntent,
  isAccountMismatchError,
  isCredentialActivationReady,
  positionCloseStepUpIntent,
  presentAutomationConsoleError,
  presentCredentialAuthorizationError,
  reconciliationFinalizeStepUpIntent,
  safetyActionStepUpIntent,
} from "./arbitrageAutomationConsole";
import { canonicalRequestDigest } from "./stepUpSecurity";
import { createFakeAutomationConsoleClient } from "./arbitrageAutomationConsole.fake";

test("fake console is explicit test injection and performs no HTTP requests", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected fetch");
  };
  try {
    const snapshot = await createFakeAutomationConsoleClient().load();
    assert.equal(fetchCalls, 0);
    assert.equal(snapshot.source, "user_api");
    assert.equal(snapshot.credentials.find((item) => item.venue === "binance")?.canExecute, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fake Binance flow covers authorization, configuration, kill switch, execution, PnL and close-all", async () => {
  const snapshot = createAutomationConsoleFixture();
  const candidate = snapshot.candidates.find((item) => item.venue === "binance" && item.asset === "XAUT");
  assert.ok(candidate);
  candidate.automationEligible = true;
  candidate.automationDisqualifiers = [];
  candidate.executionReady = true;
  const client = createFakeAutomationConsoleClient(snapshot);

  const credential = await client.validateCredential({
    accountId: candidate.venue === "binance" ? "binance-primary" : null,
    venue: "binance",
    note: "fixture",
    apiKey: "fixture-binance-key",
    secret: "fixture-binance-secret",
    ipWhitelist: [],
    defaultExecutionAccount: true,
    assetStatisticsEnabled: true,
  }, "fixture-step-up-token");
  assert.equal(credential.canExecute, true);
  assert.equal(credential.permissions.withdraw, false);
  assert.equal(JSON.stringify(credential).includes("fixture-binance-secret"), false);

  const draft = Object.fromEntries(
    snapshot.parameters
      .filter((parameter) => parameter.venue === "binance")
      .map((parameter) => [parameter.id, parameter.value]),
  );
  await client.validateParameters("binance", draft);
  await client.performSafetyAction({ type: "toggle_global_execution", venue: "binance", enabled: true }, "fixture-step-up-token");
  await client.performSafetyAction({ type: "toggle_strategy", venue: "binance", enabled: true }, "fixture-step-up-token");
  await client.performSafetyAction({ type: "set_kill_switch", venue: "binance", active: false }, "fixture-step-up-token");

  const preflight = await client.requestPreflight(candidate.id, "arbitrage_entry");
  assertExecutionPreflight(preflight);
  assert.equal(preflight.expiresAt > Date.now(), true);
  assert.equal(preflight.exactLegs.length, 2);
  const execution = await client.confirmExecution(preflight.challengeId, "fixture-step-up-token");
  assert.equal(execution.execution?.state, "hedged");
  assert.equal(execution.execution?.spotOrder?.status, "Filled");
  assert.equal(execution.execution?.perpetualOrders.length, 1);

  const loaded = await client.load();
  assert.ok(Array.isArray(loaded.pnlSeries));
  const closed = await client.performSafetyAction({
    type: "close_all",
    venue: "binance",
    idempotencyKey: "fixture-close-all",
  }, "fixture-step-up-token");
  assert.equal(closed.execution?.state, "closed");
});

test("safety and automation gates reject blocked candidates before HTTP or challenge creation", async () => {
  const client = createFakeAutomationConsoleClient();
  await assert.rejects(
    () => client.requestPreflight("cand-xaut-bybit-blocked", "manual_entry"),
    (error: unknown) => error instanceof AutomationConsoleContractError
      && error.category === "safety_opportunity_blocked",
  );
  await assert.rejects(
    () => client.requestPreflight("cand-xaut-bybit-01", "arbitrage_entry"),
    (error: unknown) => error instanceof AutomationConsoleContractError
      && error.category === "automation_opportunity_blocked",
  );
});

test("real Binance client sends strict account-scoped bodies and maps controlled execution", async () => {
  const calls: CapturedRequest[] = [];
  const secret = "fixture-binance-secret";
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const binance = snapshot.credentials.find((item) => item.venue === "binance");
    assert.ok(binance);
    assert.equal(binance.phase, "execution_capable");
    assert.equal(binance.providerWritesEnabled, true);
    assert.equal(binance.canAuthorize, true);
    assert.equal(binance.canExecute, true);
    assert.equal(binance.enabled, true);
    assert.equal(binance.accountMode, "single_asset_one_way");
    assert.equal(binance.permissions.spotAccount, true);
    assert.equal(binance.permissions.futuresAccount, true);
    assert.equal(binance.permissions.positionModeSupported, true);
    assert.equal(binance.productAvailability?.status, "available");
    assert.equal(binance.accountSnapshot?.spotAvailableUsdt, 120);

    const credential = await client.validateCredential({
      accountId: binance.accountId,
      venue: "binance",
      note: "not-sent",
      apiKey: "fixture-binance-key",
      secret,
      passphrase: "must-not-be-sent",
      ipWhitelist: ["192.0.2.10"],
      defaultExecutionAccount: true,
      assetStatisticsEnabled: true,
    }, "fixture-step-up-token");
    assert.equal(JSON.stringify(credential).includes(secret), false);
    assert.equal("apiSecret" in credential, false);

    const parameters = Object.fromEntries(
      snapshot.parameters
        .filter((parameter) => parameter.venue === "binance")
        .map((parameter) => [parameter.id, parameter.value]),
    );
    await client.validateParameters("binance", parameters);
    await client.performSafetyAction({
      type: "toggle_global_execution",
      venue: "binance",
      enabled: true,
    }, "fixture-step-up-token");
    await client.performSafetyAction({
      type: "toggle_strategy",
      venue: "binance",
      enabled: true,
    }, "fixture-step-up-token");
    await client.performSafetyAction({
      type: "set_kill_switch",
      venue: "binance",
      active: false,
    }, "fixture-step-up-token");

    const preflight = await client.requestPreflight("opportunity-binance-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    assert.equal(preflight.venue, "binance");
    assert.equal(preflight.accountSnapshot?.perpetual?.fundingRate, 0.0001);
    assert.equal(preflight.checks[0]?.id, "permissions");
    const receipt = await client.confirmExecution(preflight.challengeId, "fixture-step-up-token");
    assert.equal(receipt.execution?.state, "hedged");
    assert.equal(receipt.execution?.hedgedQuantityXaut, 0.002);

    const closed = await client.performSafetyAction({
      type: "close_all",
      venue: "binance",
      idempotencyKey: "close-all-fixture",
    }, "fixture-step-up-token");
    assert.equal(closed.execution?.state, "closed");
    const position = snapshot.positionGroups[0];
    assert.ok(position);
    await client.closePosition(position.id, "fixture-position-step-up-token", "close-position-fixture");
    await client.performSafetyAction({
      type: "toggle_global_execution",
      venue: "binance",
      enabled: false,
    });
    await client.performSafetyAction({
      type: "set_kill_switch",
      venue: "binance",
      active: true,
    });
  });

  for (const call of calls) {
    assert.equal(call.url.includes("userId"), false);
    assert.equal(call.url.includes(secret), false);
    assert.equal(JSON.stringify(call.body ?? {}).includes("userId"), false);
  }
  const credentialWrite = findWrite(calls, "/venues/binance/credentials");
  assert.deepEqual(credentialWrite.body, {
    apiKey: "fixture-binance-key",
    apiSecret: secret,
    stepUpToken: "fixture-step-up-token",
  });
  assert.equal(JSON.stringify(credentialWrite.body).includes("passphrase"), false);
  assert.equal(JSON.stringify(credentialWrite.body).includes('"secret"'), false);

  const preflightWrite = findWrite(calls, "/preflight");
  assert.deepEqual(preflightWrite.body, {
    accountId: "binance:fixture-account",
    opportunityId: "opportunity-binance-xaut",
    mode: "arbitrage_entry",
  });

  const executeWrite = findWrite(calls, "/execute");
  assert.deepEqual(Object.keys(executeWrite.body ?? {}).sort(), [
    "accountId",
    "challengeId",
    "challengeToken",
    "idempotencyKey",
    "stepUpToken",
  ]);
  for (const forbidden of ["venue", "symbol", "side", "quantity", "price", "userId"]) {
    assert.equal(forbidden in (executeWrite.body ?? {}), false);
  }

  const closeAll = findWrite(calls, "/venues/binance/close-all");
  assert.deepEqual(closeAll.body, {
    accountId: "binance:fixture-account",
    idempotencyKey: "close-all-fixture",
    stepUpToken: "fixture-step-up-token",
  });
  const positionClose = calls.find((call) => call.method === "POST" && call.url.includes("/positions/") && call.url.endsWith("/close"));
  assert.ok(positionClose);
  assert.deepEqual(positionClose.body, {
    accountId: "binance:fixture-account",
    idempotencyKey: "close-position-fixture",
    stepUpToken: "fixture-position-step-up-token",
  });

  const configWrites = calls.filter((call) => (
    call.method === "PUT"
    && call.url.endsWith("/venues/binance/config")
    && ("globalExecutionEnabled" in (call.body ?? {}) || "strategyEnabled" in (call.body ?? {}))
  ));
  assert.equal(configWrites.length, 3);
  assert.equal(configWrites[0]?.body?.stepUpToken, "fixture-step-up-token");
  assert.equal(configWrites[1]?.body?.stepUpToken, "fixture-step-up-token");
  assert.equal("stepUpToken" in (configWrites[2]?.body ?? {}), false);
  const killSwitchWrites = calls.filter((call) => call.method === "POST" && call.url.endsWith("/venues/binance/kill-switch"));
  assert.equal(killSwitchWrites.length, 2);
  assert.equal(killSwitchWrites[0]?.body?.stepUpToken, "fixture-step-up-token");
  assert.equal("stepUpToken" in (killSwitchWrites[1]?.body ?? {}), false);
});

test("step-up intents bind the exact request body, account, resource and changed parameters", async () => {
  const snapshot = createAutomationConsoleFixture();
  const credentialDraft = {
    accountId: null,
    venue: "binance" as const,
    note: "not-sent",
    apiKey: "fixture-binance-key",
    secret: "fixture-binance-secret",
    passphrase: "must-not-be-sent",
    ipWhitelist: ["192.0.2.10"],
    defaultExecutionAccount: true,
    assetStatisticsEnabled: true,
  };
  const credentialIntent = await credentialStepUpIntent(credentialDraft);
  assert.equal(credentialIntent.operation, "credential_put");
  assert.equal(credentialIntent.accountId, "new-account");
  assert.equal(credentialIntent.resourceId, null);
  assert.equal(
    credentialIntent.requestDigest,
    await canonicalRequestDigest({
      apiKey: "fixture-binance-key",
      apiSecret: "fixture-binance-secret",
    }),
  );
  assert.equal(JSON.stringify(credentialIntent).includes("fixture-binance-secret"), false);

  const connected = snapshot.credentials.find((item) => item.venue === "binance" && item.accountId);
  assert.ok(connected?.accountId);
  const deleteIntent = await credentialDeleteStepUpIntent(snapshot, connected.accountId);
  assert.equal(deleteIntent.operation, "credential_delete");
  assert.equal(deleteIntent.accountId, connected.accountId);

  const candidate = snapshot.candidates.find((item) => item.venue === "binance" && item.asset === "XAUT");
  assert.ok(candidate);
  candidate.executionReady = true;
  const preflightClient = createFakeAutomationConsoleClient(snapshot);
  const preflight = await preflightClient.requestPreflight(candidate.id, "manual_entry");
  assertExecutionPreflight(preflight);
  const executionIntent = await executionStepUpIntent(preflight);
  assert.equal(executionIntent.operation, "hedge_execute");
  assert.equal(executionIntent.resourceId, preflight.challengeId);
  assert.equal(executionIntent.requestDigest.length, 43);
  assert.notEqual(
    executionIntent.requestDigest,
    (await executionStepUpIntent({ ...preflight, challengeToken: `${preflight.challengeToken}-changed` })).requestDigest,
  );

  const enableIntent = await safetyActionStepUpIntent(snapshot, {
    type: "toggle_global_execution",
    venue: connected.venue,
    enabled: true,
  });
  assert.equal(enableIntent?.operation, "execution_enable");
  assert.equal(await safetyActionStepUpIntent(snapshot, {
    type: "toggle_global_execution",
    venue: connected.venue,
    enabled: false,
  }), null);
  assert.equal(await safetyActionStepUpIntent(snapshot, {
    type: "set_kill_switch",
    venue: connected.venue,
    active: true,
  }), null);
  assert.equal((await safetyActionStepUpIntent(snapshot, {
    type: "set_kill_switch",
    venue: connected.venue,
    active: false,
  }))?.operation, "kill_switch_disable");

  const position = snapshot.positionGroups[0];
  assert.ok(position);
  const preparedClose = await positionCloseStepUpIntent(snapshot, position.id);
  assert.equal(preparedClose.intent.operation, "position_close");
  assert.equal(preparedClose.intent.resourceId, position.id);
  assert.equal(
    preparedClose.intent.requestDigest,
    await canonicalRequestDigest({
      positionId: position.id,
      accountId: position.accountId,
      idempotencyKey: preparedClose.idempotencyKey,
    }),
  );

  const preparedFinalize = await reconciliationFinalizeStepUpIntent({
    venue: "binance",
    accountId: "binance:fixture-account",
    reconciliationId: "execution-history",
  });
  assert.equal(preparedFinalize.intent.operation, "reconciliation_finalize");
  assert.equal(preparedFinalize.intent.resourceId, "execution-history");
  assert.equal(
    preparedFinalize.intent.requestDigest,
    await canonicalRequestDigest({
      accountId: "binance:fixture-account",
      reconciliationId: "execution-history",
      idempotencyKey: preparedFinalize.idempotencyKey,
    }),
  );
});

test("manual reconciliation reads authority without writes and finalize stays account scoped", async () => {
  const calls: CapturedRequest[] = [];
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const position = snapshot.positionGroups[0];
    assert.ok(position);
    assert.equal(position.reconciliationId, "execution-history");
    const report = await client.reconcilePosition({
      venue: "binance",
      accountId: "binance:fixture-account",
      reconciliationId: "execution-history",
    });
    assert.ok(report);
    assert.equal(report.authoritativeState.status, "ok");
    assert.equal(report.authoritativeState.legs.spot.quantityXaut, 0.0003);
    assert.equal(report.dustResidual.spot?.reason, "below_min_notional");
    assert.equal(report.canFinalize, true);

    const result = await client.finalizeReconciliation({
      venue: "binance",
      accountId: "binance:fixture-account",
      reconciliationId: report.reconciliationId,
      idempotencyKey: "reconciliation-finalize-fixture",
    }, "fixture-step-up-token");
    assert.equal(result.state, "reconciled");
    assert.equal(result.reconciliation?.reconciliationId, "execution-history");
  });

  const reconcile = calls.find((call) => (
    call.method === "GET"
    && call.url.includes("/venues/binance/reconciliation?")
  ));
  assert.ok(reconcile);
  assert.match(reconcile.url, /accountId=binance%3Afixture-account/);
  assert.match(reconcile.url, /reconciliationId=execution-history/);
  const finalize = findWrite(calls, "/venues/binance/reconciliation/finalize");
  assert.deepEqual(finalize.body, {
    accountId: "binance:fixture-account",
    reconciliationId: "execution-history",
    idempotencyKey: "reconciliation-finalize-fixture",
    stepUpToken: "fixture-step-up-token",
  });
});

test("manual intervention history remains visible after provider positions are empty without reusing recorded capital", async () => {
  const manualExecution = {
    executionId: "execution-manual-history",
    accountId: "binance:fixture-account",
    state: "manual_intervention",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    spotOrder: executionOrder("spot-manual-history"),
    perpetualOrders: [executionOrder("perpetual-manual-history")],
    compensationOrders: [],
    reconciliation: null,
  };
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const group = snapshot.positionGroups.find((item) => item.reconciliationId === manualExecution.executionId);
    assert.ok(group);
    assert.equal(group.executionState, "manual_intervention");
    assert.equal(group.status, "attention");
    assert.equal(group.legs.length, 2);
    assert.equal(snapshot.summary.positionAuthorityIncompleteCount, 1);
    assert.equal(snapshot.summary.totalCapitalUsedUsd, 0);
    assert.equal(snapshot.summary.netDeltaUsd, 0);
  }, {
    positionItems: [],
    pnlHistory: [manualExecution],
  });
});

test("fresh reconciliation from execution history replaces recorded capital in the current summary", async () => {
  const report = reconciliationFixture();
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const group = snapshot.positionGroups.find((item) => item.reconciliationId === report.reconciliationId);
    assert.ok(group);
    assert.equal(group.reconciliation?.authoritativeState.stale, false);
    assert.equal(snapshot.summary.positionAuthorityIncompleteCount, 0);
    assert.equal(snapshot.summary.totalCapitalUsedUsd, 1.008);
    assert.equal(snapshot.summary.netDeltaUsd, 1.008);
  }, {
    positionItems: [],
    pnlHistory: [{
      executionId: report.reconciliationId,
      accountId: "binance:fixture-account",
      state: "manual_intervention",
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      spotOrder: executionOrder("spot-reconciled-history"),
      perpetualOrders: [executionOrder("perpetual-reconciled-history")],
      compensationOrders: [],
      reconciliation: report,
    }],
  });
});

test("finalize keeps backend reconciliation blockers actionable without exposing provider raw data", async () => {
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    await assert.rejects(
      () => client.finalizeReconciliation({
        venue: "binance",
        accountId: "binance:fixture-account",
        reconciliationId: "execution-history",
        idempotencyKey: "reconciliation-blocked-fixture",
      }, "fixture-step-up-token"),
      (error: unknown) => {
        assert.ok(error instanceof AutomationConsoleContractError);
        assert.equal(error.category, "reconciliation_blocked");
        assert.deepEqual(error.details?.blockingReasons, [
          "当前仍存在活动委托，不能人工结案。",
          "现货侧仍存在可交易余额，需先人工卖出。",
        ]);
        const presentation = presentAutomationConsoleError(error);
        assert.equal(presentation.title, "仍不能人工结案");
        assert.match(presentation.message, /活动委托/);
        assert.match(presentation.message, /现货侧仍存在可交易余额/);
        assert.doesNotMatch(presentation.message, /apiKey|signature|raw payload/i);
        return true;
      },
    );
  }, {
    finalizeError: {
      status: 409,
      body: {
        category: "reconciliation_blocked",
        message: "当前对账结果仍不允许人工结案。",
        blockingReasons: [
          "当前仍存在活动委托，不能人工结案。",
          "现货侧仍存在可交易余额，需先人工卖出。",
        ],
      },
    },
  });
});

test("Binance non-XAUT adapter-disabled candidate remains fail-closed with zero preflight requests", async () => {
  const calls: CapturedRequest[] = [];
  const unsupported = {
    ...binanceOpportunity(),
    id: "opportunity-binance-paxg",
    adapterImplemented: false,
    longLeg: { venue: "binance", symbol: "PAXGUSDT", asset: "PAXG", kind: "spot" as const },
    shortLeg: { venue: "binance", symbol: "PAXGUSDT", asset: "PAXG", kind: "perpetual" as const },
  };
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const candidate = snapshot.candidates[0];
    assert.equal(candidate.adapterImplemented, false);
    assert.equal(candidate.canRunReadOnlyPreflight, false);
    assert.equal(candidate.canExecute, false);
    await assert.rejects(
      () => client.requestPreflight(candidate.id, "manual_entry"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "venue_not_implemented",
    );
  }, { opportunity: unsupported });
  assert.equal(calls.some((call) => call.url.endsWith("/preflight")), false);
});

test("execution-not-ready gate prevents a preflight request until server readiness is explicit", async () => {
  const calls: CapturedRequest[] = [];
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const binance = snapshot.candidates[0];
    assert.equal(binance.executionReady, false);
    await assert.rejects(
      () => client.requestPreflight(binance.id, "manual_entry"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "execution_not_ready",
    );
  }, { binanceEnabled: false });
  assert.equal(calls.some((call) => call.url.endsWith("/preflight")), false);
});

test("preflight rejection exposes only whitelisted checks and never creates a challenge", async () => {
  const calls: CapturedRequest[] = [];
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const result = await client.requestPreflight("opportunity-binance-xaut", "manual_entry");
    assert.equal("kind" in result && result.kind, "preflight_rejected");
    if ("kind" in result && result.kind === "preflight_rejected") {
      assert.equal(result.checks.some((check) => !check.passed), true);
      assert.equal(result.checks[0]?.value, true);
      assert.equal(JSON.stringify(result).includes("private-provider-detail"), false);
      assert.equal(JSON.stringify(result).includes("userId"), false);
    }
    await assert.rejects(
      () => client.confirmExecution("not-issued", "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "challenge_invalid",
    );
  }, { preflightError: preflightRejected() });
  assert.equal(calls.some((call) => call.url.endsWith("/execute")), false);
});

test("challenge expiry or server restart disarms local execution and repeated submit sends once", async () => {
  let executeCalls = 0;
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const preflight = await client.requestPreflight("opportunity-binance-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    await assert.rejects(
      () => client.confirmExecution(preflight.challengeId, "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "restart_disarmed",
    );
    await assert.rejects(
      () => client.confirmExecution(preflight.challengeId, "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "challenge_invalid",
    );
  }, {
    executeError: { status: 409, category: "restart_disarmed", message: "restart" },
    onExecute: () => { executeCalls += 1; },
  });
  assert.equal(executeCalls, 1);
});

test("same-account snapshot refresh preserves an unexpired execution challenge", async () => {
  let executeCalls = 0;
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const preflight = await client.requestPreflight("opportunity-binance-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    await client.load();
    const receipt = await client.confirmExecution(preflight.challengeId, "fixture-step-up-token");
    assert.equal(receipt.execution?.state, "hedged");
  }, { onExecute: () => { executeCalls += 1; } });
  assert.equal(executeCalls, 1);
});

test("execution-account change still clears every in-memory challenge", async () => {
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const preflight = await client.requestPreflight("opportunity-binance-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    await client.load();
    await assert.rejects(
      () => client.confirmExecution(preflight.challengeId, "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "challenge_invalid",
    );
  }, {
    venueStatuses: (attempt) => {
      const statuses = venueStatuses(true);
      if (attempt > 1 && statuses[2]?.credential) {
        statuses[2].credential.accountId = "binance:other-account";
      }
      return statuses;
    },
  });
});

test("snapshot refresh removes an expired execution challenge without sending execute", async () => {
  let executeCalls = 0;
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const preflight = await client.requestPreflight("opportunity-binance-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    await client.load();
    await assert.rejects(
      () => client.confirmExecution(preflight.challengeId, "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.category === "challenge_invalid",
    );
  }, {
    preflightExpiresAt: Date.now() - 1,
    onExecute: () => { executeCalls += 1; },
  });
  assert.equal(executeCalls, 0);
});

test("execution and credential errors are stable, category-specific and secret-safe", () => {
  const cases = [
    [new AutomationConsoleContractError(401, "session"), /登录/],
    [new AutomationConsoleContractError(403, "forbidden"), /权限/],
    [new AutomationConsoleContractError(400, "invalid"), /校验/],
    [new AutomationConsoleContractError(409, "changed", null, "preflight_changed"), /实时条件/],
    [new AutomationConsoleContractError(409, "conflict", null, "idempotency_conflict"), /请求标识/],
    [new AutomationConsoleContractError(409, "handling", null, "compensating"), /安全处置/],
    [new AutomationConsoleContractError(409, "manual", null, "manual_intervention"), /人工处理/],
    [new AutomationConsoleContractError(409, "kill", null, "server_kill_switch_active"), /全局急停/],
    [new AutomationConsoleContractError(422, "invalid"), /校验/],
    [new AutomationConsoleContractError(429, "limited", 12), /频繁/],
    [new AutomationConsoleContractError(501, "unavailable"), /未开放/],
    [new AutomationConsoleContractError(503, "down"), /不可用/],
  ] as const;
  for (const [error, expected] of cases) {
    assert.match(`${presentAutomationConsoleError(error).title} ${presentAutomationConsoleError(error).message}`, expected);
  }

  const secretError = presentAutomationConsoleError(
    new AutomationConsoleContractError(
      400,
      "raw provider failure fixture-binance-secret",
      null,
      "provider_credential_invalid",
    ),
  );
  assert.doesNotMatch(secretError.message, /fixture-binance-secret|raw provider/i);
});

test("credential authorization failures keep unconfigured state explicit and actionable", () => {
  const provider = presentCredentialAuthorizationError(
    new AutomationConsoleContractError(502, "Binance unavailable", null, "provider_unavailable"),
    false,
  );
  assert.match(provider.summary, /凭证未保存，账户仍未配置/);
  assert.match(provider.action, /稍后重试/);
  assert.equal(provider.category, "provider_unavailable");

  const permission = presentCredentialAuthorizationError(
    new AutomationConsoleContractError(409, "permission", null, "permission_rejected"),
    false,
  );
  assert.match(permission.action, /读取、现货与 USD-M Futures/);

  const kms = presentCredentialAuthorizationError(
    new AutomationConsoleContractError(503, "kms", null, "credential_key_provider_unavailable"),
    false,
  );
  assert.match(kms.action, /凭证加密服务/);
  assert.match(kms.action, /无需在 Binance 重新创建 Key/);

  const unknown = presentCredentialAuthorizationError(
    new AutomationConsoleContractError(500, "自动套利服务暂不可用。", null, "automation_internal_error"),
    false,
  );
  assert.match(unknown.action, /服务端内部异常/);
  assert.equal(unknown.category, "automation_internal_error");

  const rotation = presentCredentialAuthorizationError(
    new AutomationConsoleContractError(502, "down", null, "provider_unavailable"),
    true,
  );
  assert.match(rotation.summary, /原 API 账户配置保持不变/);
  const tracked = presentCredentialAuthorizationError(
    new AutomationConsoleContractError(
      503,
      "API 凭证验证失败。",
      null,
      "http_503_non_json",
      null,
      "edge-request-503",
    ),
    false,
  );
  assert.equal(tracked.requestId, "edge-request-503");
  assert.match(tracked.action, /非 JSON/);
  assert.doesNotMatch(JSON.stringify([provider, permission, kms, unknown, rotation, tracked]), /fixture-binance-secret/i);
});

test("missing IP remains a warning while withdraw permission is a hard activation block", async () => {
  const credential = await createFakeAutomationConsoleClient().validateCredential({
    accountId: null,
    venue: "binance",
    note: "fixture",
    apiKey: "fixture-binance-key",
    secret: "fixture-binance-secret",
    ipWhitelist: [],
    defaultExecutionAccount: false,
    assetStatisticsEnabled: true,
  }, "fixture-step-up-token");
  assert.equal(credential.verificationChecks.find((check) => check.id === "ip_bound")?.status, "warning");
  assert.equal(isCredentialActivationReady(credential), true);
  assert.equal(isCredentialActivationReady({
    ...credential,
    permissions: { ...credential.permissions, withdraw: true },
  }), false);
});

test("account mismatch remains recognizable so the UI can reload venue state", () => {
  assert.equal(
    isAccountMismatchError(
      new AutomationConsoleContractError(409, "changed", null, "account_mismatch"),
    ),
    true,
  );
});

test("credential PUT preserves route JSON category and request id", async () => {
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    await assert.rejects(
      () => client.validateCredential(binanceCredentialDraft(), "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.status === 502
        && error.category === "provider_credential_invalid"
        && error.requestId === "route-request-1",
    );
  }, {
    credentialPut: () => jsonResponse({
      category: "provider_credential_invalid",
      message: "交易所拒绝了当前 API 凭证。",
    }, 502, { "X-Request-Id": "route-request-1" }),
  });
});

test("credential PUT classifies non-JSON 502 and 503 without exposing the response body", async () => {
  for (const status of [502, 503]) {
    await withAutomationFetch([], async () => {
      const client = createUserAutomationConsoleClient();
      await client.load();
      await assert.rejects(
        () => client.validateCredential(binanceCredentialDraft(), "fixture-step-up-token"),
        (error: unknown) => {
          assert.ok(error instanceof AutomationConsoleContractError);
          assert.equal(error.status, status);
          assert.equal(error.category, `http_${status}_non_json`);
          assert.equal(error.requestId, `edge-${status}`);
          assert.doesNotMatch(error.message, /gateway raw body/i);
          return true;
        },
      );
    }, {
      credentialPut: () => new Response("gateway raw body", {
        status,
        headers: { "Content-Type": "text/html", "X-Correlation-Id": `edge-${status}` },
      }),
    });
  }
});

test("credential PUT classifies AbortError before the route without losing a client request id", async () => {
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    await assert.rejects(
      () => client.validateCredential(binanceCredentialDraft(), "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.status === 0
        && error.category === "request_aborted"
        && Boolean(error.requestId),
    );
  }, {
    credentialPut: () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
});

test("a successful credential response followed by a network failure never reuses the old success", async () => {
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const active = await client.validateCredential(binanceCredentialDraft(), "fixture-step-up-token");
    assert.equal(active.status, "connected");
    await assert.rejects(
      () => client.validateCredential(binanceCredentialDraft(), "fixture-step-up-token"),
      (error: unknown) => error instanceof AutomationConsoleContractError
        && error.status === 0
        && error.category === "network_request_failed"
        && Boolean(error.requestId),
    );
  }, {
    credentialPut: (attempt) => {
      if (attempt === 1) return jsonResponse(venueStatuses(true)[2]);
      throw new TypeError("Failed to fetch");
    },
  });
});

type CapturedRequest = {
  url: string;
  method: string;
  body: Record<string, any> | null;
};

type FetchFixtureOptions = {
  opportunity?: ReturnType<typeof binanceOpportunity>;
  binanceEnabled?: boolean;
  credentialPut?: (attempt: number) => Response | Promise<Response>;
  finalizeError?: { status: number; body: unknown };
  pnlHistory?: unknown[];
  positionItems?: unknown[];
  venueStatuses?: (attempt: number) => ReturnType<typeof venueStatuses>;
  preflightExpiresAt?: number;
  preflightError?: { status: number; body: unknown };
  executeError?: { status: number; category: string; message: string };
  onExecute?: () => void;
};

async function withAutomationFetch(
  calls: CapturedRequest[],
  run: () => Promise<void>,
  options: FetchFixtureOptions = {},
) {
  const originalFetch = globalThis.fetch;
  let credentialPutAttempts = 0;
  let venueStatusAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, any>
      : null;
    calls.push({ url, method, body });

    if (url.endsWith("/venues") && method === "GET" && options.venueStatuses) {
      venueStatusAttempts += 1;
      return jsonResponse(options.venueStatuses(venueStatusAttempts));
    }
    if (url.endsWith("/venues/binance/credentials") && method === "PUT" && options.credentialPut) {
      credentialPutAttempts += 1;
      return options.credentialPut(credentialPutAttempts);
    }
    if (url.endsWith("/preflight") && method === "POST" && options.preflightError) {
      return jsonResponse(options.preflightError.body, options.preflightError.status);
    }
    if (
      url.endsWith("/venues/binance/reconciliation/finalize")
      && method === "POST"
      && options.finalizeError
    ) {
      return jsonResponse(options.finalizeError.body, options.finalizeError.status);
    }
    if (url.endsWith("/execute") && method === "POST") {
      options.onExecute?.();
      if (options.executeError) {
        return jsonResponse({
          category: options.executeError.category,
          message: options.executeError.message,
        }, options.executeError.status);
      }
    }
    return automationResponse(
      url,
      method,
      options.opportunity ?? binanceOpportunity(),
      options.binanceEnabled ?? true,
      options.preflightExpiresAt,
      options.positionItems,
      options.pnlHistory,
    );
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function automationResponse(
  url: string,
  method: string,
  opportunity: ReturnType<typeof binanceOpportunity>,
  binanceEnabled: boolean,
  preflightExpiresAt?: number,
  positionItems: unknown[] = [fixturePosition()],
  pnlHistory: unknown[] = [{
    executionId: "execution-history",
    state: "hedged",
    updatedAt: Date.now(),
    spotOrder: executionOrder("spot-history"),
    perpetualOrders: [executionOrder("perpetual-history")],
    compensationOrders: [],
  }],
) {
  if (url.endsWith("/venues")) return jsonResponse(venueStatuses(binanceEnabled));
  if (url.endsWith("/opportunities")) {
    return jsonResponse({
      generatedAt: Date.now(),
      eligibleCount: opportunity.automationEligible ? 1 : 0,
      items: [opportunity],
    });
  }
  if (url.endsWith("/positions")) return jsonResponse({ items: positionItems });
  if (url.endsWith("/pnl")) {
    return jsonResponse({
      venues: [{
        venue: "binance",
        current: fixturePosition(),
        series: [
          { capturedAt: Date.now() - 60_000, netPnlUsd: 0.01 },
          { capturedAt: Date.now(), netPnlUsd: 0.02 },
        ],
        history: pnlHistory,
      }],
    });
  }
  if (url.endsWith("/audit")) return jsonResponse({ venues: [] });
  if (url.endsWith("/venues/bybit/config") && method === "GET") {
    return jsonResponse(fixtureConfig("bybit", "bybit:fixture-account", false));
  }
  if (url.endsWith("/venues/binance/config") && method === "GET") {
    return jsonResponse(fixtureConfig("binance", "binance:fixture-account", binanceEnabled));
  }
  if (url.endsWith("/venues/bybit/account") && method === "GET") {
    return jsonResponse(privateAccount("bybit", "bybit:fixture-account"));
  }
  if (url.endsWith("/venues/binance/account") && method === "GET") {
    return jsonResponse(privateAccount("binance", "binance:fixture-account"));
  }
  if (url.endsWith("/venues/bybit/credentials") && method === "PUT") {
    return jsonResponse(venueStatuses(binanceEnabled)[0]);
  }
  if (url.endsWith("/venues/binance/credentials") && method === "PUT") {
    return jsonResponse(venueStatuses(binanceEnabled)[2]);
  }
  if (url.endsWith("/preflight") && method === "POST") {
    return jsonResponse({
      challengeId: "challenge-fixture",
      challengeToken: "one-time-fixture-token",
      expiresAt: preflightExpiresAt ?? Date.now() + 60_000,
      report: {
        quantityXaut: 0.002,
        totalBudgetUsd: 25,
        estimatedCapitalRequiredUsd: 13.5,
        estimatedFeesUsd: 0.02,
        estimatedSlippageUsd: 0.01,
        maximumLossUsd: 25,
        referenceSpotAsk: 3_360,
        referencePerpetualBid: 3_361,
        entryBasisBps: 2.9,
        fundingRate: 0.0001,
        estimatedNetAprPercent: 9.2,
        checks: [
          { name: "permissions", passed: true, value: true, limit: true, message: "权限通过。" },
          { name: "depth", passed: true, value: 25_000, limit: 25, message: "深度通过。" },
        ],
        warnings: ["未绑定固定 IP 白名单。"],
      },
    });
  }
  if (url.endsWith("/execute") && method === "POST") {
    return jsonResponse(executionResponse("hedged"));
  }
  if (url.endsWith("/venues/binance/close-all") && method === "POST") {
    return jsonResponse(executionResponse("closed"));
  }
  if (url.includes("/venues/binance/reconciliation?") && method === "GET") {
    return jsonResponse({
      accountId: "binance:fixture-account",
      items: [reconciliationFixture()],
      phase: "execution_capable",
      providerWritesEnabled: true,
    });
  }
  if (url.endsWith("/venues/binance/reconciliation/finalize") && method === "POST") {
    return jsonResponse({
      ...executionResponse("reconciled"),
      reconciliation: reconciliationFixture(),
      message: "交易所账户核对确认仅剩不可交易残余，已按人工结案完成记录。",
    });
  }
  return jsonResponse({ ok: true, message: "fixture accepted" });
}

function reconciliationFixture() {
  return {
    reconciliationId: "execution-history",
    strategyId: "binance-xaut-spot-perp-v1",
    recordedState: "manual_intervention",
    authoritativeState: {
      snapshotAt: Date.now(),
      status: "ok",
      stale: false,
      openOrders: { spot: 0, perpetual: 0, total: 0 },
      legs: {
        spot: {
          quantityXaut: 0.0003,
          freeQuantityXaut: 0.0003,
          markPrice: 3_360,
          minOrderQty: 0.0001,
          minNotionalUsd: 5,
          qtyStep: 0.0001,
        },
        perpetual: {
          quantityXaut: 0,
          freeQuantityXaut: null,
          markPrice: 3_361,
          minOrderQty: 0.001,
          minNotionalUsd: 5,
          qtyStep: 0.001,
        },
      },
    },
    legDiffs: {
      spotQuantityXaut: -0.0017,
      perpetualQuantityXaut: -0.002,
    },
    tradableResidual: { spot: null, perpetual: null },
    dustResidual: {
      spot: {
        quantityXaut: 0.0003,
        notionalUsd: 1.008,
        minOrderQty: 0.0001,
        minNotionalUsd: 5,
        qtyStep: 0.0001,
        tradable: false,
        reason: "below_min_notional",
      },
      perpetual: null,
    },
    recommendedAction: "manual_finalize",
    canFinalize: true,
    blockingReasons: [],
  };
}

function venueStatuses(binanceEnabled: boolean) {
  return (["bybit", "bitget", "binance", "okx"] as const).map((venue) => {
    const implemented = venue === "bybit" || venue === "binance";
    const enabled = venue === "bybit" || (venue === "binance" && binanceEnabled);
    return {
      venue,
      implemented,
      enabled,
      phase: implemented ? "execution_capable" : undefined,
      providerWritesEnabled: implemented,
      productAvailability: venue === "binance"
        ? {
            available: true,
            status: "available",
            spotSymbol: "XAUTUSDT",
            perpetualSymbol: "XAUTUSDT",
            checkedAt: Date.now(),
            message: null,
          }
        : undefined,
      credential: implemented
        ? {
            stored: true,
            accountId: `${venue}:fixture-account`,
            accountFingerprint: `${venue}-fingerprint`,
            masterKeyConfigured: true,
            maskedApiKey: `${venue.toUpperCase()}••••TURE`,
            connectionStatus: "verified",
            lifecycleStatus: "active",
            accountMode: venue === "binance" ? "single_asset_one_way" : "uta",
            permissions: {
              read: true,
              spotTrade: true,
              contractTrade: true,
              withdraw: false,
              spotAccount: venue === "binance" ? true : undefined,
              futuresAccount: venue === "binance" ? true : undefined,
              positionModeSupported: venue === "binance" ? true : undefined,
            },
            lastVerifiedAt: Date.now(),
            message: null,
            ipWhitelistConfigured: false,
            warnings: ["未绑定 IP 白名单。"],
          }
        : {
            stored: false,
            accountId: null,
            accountFingerprint: null,
            masterKeyConfigured: false,
            maskedApiKey: null,
            connectionStatus: "not_implemented",
            lifecycleStatus: "not_implemented",
            accountMode: null,
            permissions: null,
            lastVerifiedAt: null,
            message: "该交易所 adapter 暂未接入。",
            ipWhitelistConfigured: null,
            warnings: [],
          },
    };
  });
}

function fixtureConfig(venue: "bybit" | "binance", accountId: string, enabled: boolean) {
  return {
    venue,
    accountId,
    defaultAccountId: accountId,
    globalExecutionEnabled: enabled,
    strategyEnabled: enabled,
    killSwitchActive: false,
    serverGlobalKillSwitchActive: false,
    maxStrategyCapitalUsd: 100,
    maxEntryBasisBps: 18,
    maxCombinedSlippageBps: 12,
    minNetAprPercent: 8,
    minLiquidationDistancePercent: 40,
    maxUnhedgedMs: 5_000,
  };
}

function privateAccount(venue: "bybit" | "binance", accountId: string) {
  return {
    venue,
    accountId,
    balances: {
      spotAvailableUsdt: 120,
      futuresAvailableUsdt: 110,
      spotXaut: 0,
      perpetualXaut: 0,
    },
    openOrders: { spot: 0, perpetual: 0 },
    instruments: {
      spot: {
        status: "Trading",
        bid: 3_359.9,
        ask: 3_360,
        depthUsd: 25_000,
        minOrderQty: 0.0001,
        qtyStep: 0.0001,
        minNotionalUsd: 5,
        priceTick: 0.01,
      },
      perpetual: {
        status: "Trading",
        bid: 3_361,
        ask: 3_361.2,
        mark: 3_361.1,
        depthUsd: 30_000,
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.1,
        fundingRate: 0.0001,
        fundingIntervalHours: 8,
        nextFundingTime: Date.now() + 3_600_000,
      },
    },
    fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
    fetchedAt: Date.now(),
  };
}

function binanceOpportunity() {
  return {
    id: "opportunity-binance-xaut",
    venue: "binance" as const,
    adapterImplemented: true,
    safetyEligible: true,
    safetyDisqualifiers: [] as string[],
    automationEligible: true,
    automationDisqualifiers: [] as string[],
    netApr: 9.2,
    persistenceRatio: 0.76,
    entryBasisBps: 2.9,
    longLeg: {
      venue: "binance",
      symbol: "XAUTUSDT",
      asset: "XAUT",
      kind: "spot" as const,
    },
    shortLeg: {
      venue: "binance",
      symbol: "XAUTUSDT",
      asset: "XAUT",
      kind: "perpetual" as const,
    },
  };
}

function preflightRejected() {
  return {
    status: 409,
    body: {
      category: "preflight_rejected",
      message: "实时条件未通过。",
      report: {
        venue: "binance",
        phase: "execution_capable",
        providerWritesEnabled: true,
        userId: "must-not-reach-ui",
        privateProviderDetail: "private-provider-detail",
        checks: [
          { name: "permissions", passed: true, value: true, limit: true, message: "权限通过。" },
          { name: "depth", passed: false, value: 2, limit: 25, message: "盘口深度不足。" },
        ],
        warnings: ["盘口深度不足。"],
        generatedAt: Date.now(),
        message: "市场或账户实时检查未通过。",
      },
    },
  };
}

function fixturePosition() {
  return {
    positionId: "binance:position-1",
    accountId: "binance:fixture-account",
    venue: "binance",
    strategyId: "binance-xaut-spot-perp-v1",
    capturedAt: Date.now(),
    legs: {
      spot: {
        quantityXaut: 0.002,
        averageEntryPrice: 3_360,
        markPrice: 3_361,
        notionalUsd: 6.72,
      },
      perpetual: {
        quantityXaut: 0.002,
        averageEntryPrice: 3_361,
        markPrice: 3_360,
        notionalUsd: 6.72,
      },
    },
    netDeltaUsd: 0,
    currentBasisBps: 3,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0.004,
    fundingPnlUsd: 0,
    feesUsd: 0.01,
    slippageUsd: 0.01,
    netPnlUsd: -0.016,
  };
}

function executionOrder(orderId: string) {
  return {
    orderId,
    orderLinkId: `${orderId}-link`,
    status: "Filled",
    requestedQuantityXaut: 0.002,
    filledQuantityXaut: 0.002,
    averagePrice: 3_360,
    feeUsd: 0.01,
    updatedAt: Date.now(),
  };
}

function executionResponse(state: "hedged" | "reconciled" | "closed") {
  return {
    executionId: `execution-${state}`,
    state,
    spotOrder: executionOrder("spot-order"),
    perpetualOrders: [executionOrder("perpetual-order")],
    compensationOrders: [],
    hedgedQuantityXaut: state === "hedged" ? 0.002 : 0,
    unhedgedDurationMs: 900,
    errorCategory: null,
    message: state === "hedged"
      ? "现货侧与永续侧已完成对冲。"
      : "现货与永续对冲组合已退出。",
    createdAt: Date.now() - 900,
    updatedAt: Date.now(),
  };
}

function findWrite(calls: CapturedRequest[], suffix: string) {
  const call = calls.find((item) => item.method !== "GET" && item.url.endsWith(suffix));
  assert.ok(call, `missing write ${suffix}`);
  return call;
}

function assertExecutionPreflight(
  result: AutomationPreflightResult,
): asserts result is AutomationPreflight {
  assert.equal("kind" in result, false, "expected an execution challenge");
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function binanceCredentialDraft() {
  return {
    accountId: "binance:fixture-account",
    venue: "binance" as const,
    note: "",
    apiKey: "fixture-binance-key",
    secret: "fixture-binance-secret",
    ipWhitelist: [],
    defaultExecutionAccount: false,
    assetStatisticsEnabled: false,
  };
}
