import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import { RwaBinanceAutomationConnector } from "./RwaBinanceAutomationConnector";
import { RwaBinanceAutomationService } from "./RwaBinanceAutomationService";
import type {
  RwaBinanceClient,
  RwaBinanceCredentials,
  RwaBinancePermissions,
  RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";
import { createNeutralExecutionRecord } from "./RwaNeutralHedgeExecutionEngine";
import type { RwaProviderOrder, RwaProviderOrderRequest, RwaStrategyPnlSnapshot } from "./RwaNeutralExecutionTypes";

const masterKey = "11".repeat(32);
const now = 20_000;

test("Binance credentials remain user-isolated, default disabled, and reject withdrawal permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-automation-"));
  try {
    const client = new FakeBinanceClient();
    const first = service(directory, "user-a", client);
    const second = service(directory, "user-b", client);
    const connector = new RwaBinanceAutomationConnector(first);

    await first.putCredentials({ apiKey: "fake-key-a", apiSecret: "fake-secret-a" });
    const firstStatus = await connector.getStatus();
    const secondStatus = await second.getCredentialStatus();
    assert.equal(firstStatus.implemented, true);
    assert.equal(firstStatus.enabled, false);
    assert.equal(firstStatus.phase, "execution_capable");
    assert.equal(firstStatus.providerWritesEnabled, true);
    assert.equal((firstStatus.productAvailability as any).available, true);
    assert.equal(firstStatus.credential.lifecycleStatus, "active");
    assert.equal(firstStatus.credential.maskedApiKey?.includes("fake-secret-a"), false);
    assert.equal(secondStatus.lifecycleStatus, "unconfigured");

    const rejectedClient = new FakeBinanceClient({ permissions: permissions({ withdraw: true }) });
    const rejected = service(directory, "user-c", rejectedClient);
    await assert.rejects(
      rejected.putCredentials({ apiKey: "fake-key-c", apiSecret: "must-not-leak" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "permission_rejected"
        && !error.message.includes("must-not-leak"),
    );
    assert.equal((await rejected.getCredentialStatus()).stored, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance credential validation wraps synchronous client construction failures without leaking secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-client-factory-failure-"));
  try {
    const keyProvider = new FakeCredentialKeyProvider();
    const store = new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
      userId: "user-a",
      venue: "binance",
      keyProvider,
      credentialPath: join(directory, "credentials.json"),
      statePath: join(directory, "state.json"),
    });
    const service = new RwaBinanceAutomationService(
      store,
      (credentials) => {
        if (credentials.apiKey) {
          throw new Error("Authorization: Bearer sync-secret file:///tmp/binance.json apiKey leaked-key");
        }
        return new FakeBinanceClient();
      },
      () => now,
      () => false,
    );

    await assert.rejects(
      service.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "provider_unavailable"
        && error.message === "Binance 凭证校验失败。",
    );
    assert.equal((await service.getCredentialStatus()).stored, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance fixed IP verification gates credential rotation and every new-risk control entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-ip-gates-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "original-key", apiSecret: "original-secret" });
    const originalStatus = await current.getCredentialStatus();
    const accountId = originalStatus.accountId!;

    client.setPermissions({ ipRestricted: false });
    await assert.rejects(
      current.putCredentials({ apiKey: "replacement-key", apiSecret: "replacement-secret" }),
      permissionRejectedWithoutSecret,
    );
    client.setPermissions({ ipRestricted: true });
    const retained = await current.getCredentialStatus();
    assert.equal(retained.lifecycleStatus, "active");
    assert.equal(retained.maskedApiKey, originalStatus.maskedApiKey);

    client.setPermissions({ ipRestricted: false });
    await assert.rejects(
      current.updateConfig({ accountId, globalExecutionEnabled: true }),
      permissionRejectedWithoutSecret,
    );
    await assert.rejects(
      current.setKillSwitch(false, accountId),
      permissionRejectedWithoutSecret,
    );
    assert.equal((await current.getConfig()).globalExecutionEnabled, false);
    assert.equal((await current.getConfig()).killSwitchActive, true);

    client.setPermissions({ ipRestricted: true });
    await current.updateConfig({ accountId, globalExecutionEnabled: true, strategyEnabled: true });
    await current.setKillSwitch(false, accountId);
    client.setPermissions({ ipRestricted: false });
    await assert.rejects(
      current.preflight(opportunity(), accountId, "manual_entry"),
      permissionRejectedWithoutSecret,
    );
    assert.equal(client.writeCount, 0);
    assert.equal((await current.getConfig()).killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance execute rechecks fixed IP verification after challenge issuance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-ip-execute-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    client.setPermissions({ ipRestricted: false });

    const execution = await current.execute(executeInput(accountId, challenge, "binance:ip-recheck:1"));
    assert.notEqual(execution.state, "hedged");
    assert.equal(client.writeCount, 0);
    assert.equal((await current.getConfig()).killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance credential status warns when provider enables IP restriction but does not return ipList", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-ip-warning-"));
  try {
    const client = new FakeBinanceClient();
    client.setIpWhitelistVerificationMode("provider_restriction_only");
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const status = await current.getCredentialStatus();
    assert.equal(status.ipWhitelistConfigured, true);
    assert.match(status.warnings.join(" "), /未返回完整 ipList/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance preflight remains read-only and execute establishes the whitelisted hedge combination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-preflight-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await current.getCredentialStatus()).accountId;
    assert.ok(accountId);

    await current.updateConfig({ accountId, globalExecutionEnabled: true, strategyEnabled: true });
    await current.setKillSwitch(false, accountId!);

    client.snapshot.fetchedAt = 1;
    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any).checks.some((item: any) => item.name === "freshness" && !item.passed),
    );

    client.snapshot.fetchedAt = now;
    client.snapshot.perpetual.minOrderQty = 0.01;
    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any).checks.some((item: any) => item.name === "perpetual_minimum" && !item.passed),
    );
    client.snapshot.perpetual.minOrderQty = 0.001;

    const challenge = await current.preflight(opportunity(), accountId!, "manual_entry");
    assert.equal(client.writeCount, 0);
    assert.equal(challenge.report.providerWritesEnabled, true);
    assert.equal(challenge.report.totalBudgetUsd, 25);
    assert.equal(challenge.report.estimatedCapitalRequiredUsd <= challenge.report.totalBudgetUsd, true);
    assert.equal(
      challenge.report.estimatedSpotNotionalUsd + challenge.report.estimatedPerpetualNotionalUsd
        < challenge.report.totalBudgetUsd,
      true,
    );
    assert.equal(
      challenge.report.checks.some((item) =>
        item.name === "strategy_cap" && item.limit === 300 && item.passed),
      true,
    );
    const execution = await current.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "binance:entry:1",
    });
    assert.equal(execution.state, "hedged");
    assert.equal(client.writeCount, 3);
    const repeated = await current.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "binance:entry:1",
    });
    assert.equal(repeated.executionId, execution.executionId);
    assert.equal(client.writeCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance first provider mutation failure creates no orders or strategy exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-first-write-failure-"));
  try {
    const client = new FakeBinanceClient({ failLeverage: true });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:first-write-failure:1"));
    assert.equal(execution.state, "failed");
    assert.equal(client.writeCount, 1);
    assert.equal(client.placedRequests.length, 0);
    const pnl = await client.readStrategyPnl();
    assert.equal(pnl.legs.spot.quantityXaut, 0);
    assert.equal(pnl.legs.perpetual.quantityXaut, 0);
    assert.equal(pnl.openOrders.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance partial spot fill sizes the perpetual side from authoritative fill quantity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-partial-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: [0.5, 1] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:partial:1"));
    assert.equal(execution.state, "hedged");
    assert.equal(execution.hedgedQuantityXaut, 0.001);
    assert.equal(client.placedRequests[1]?.category, "linear");
    assert.equal(client.placedRequests[1]?.quantityXaut, 0.001);
    assert.equal(client.cancelCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance perpetual-side failure exits the filled spot side and leaves no strategy exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-compensation-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: [1, "throw", 1] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:compensate:1"));
    assert.equal(execution.state, "failed");
    const pnl = await client.readStrategyPnl();
    assert.equal(pnl.legs.spot.quantityXaut, 0);
    assert.equal(pnl.legs.perpetual.quantityXaut, 0);
    assert.equal(client.strategyCancelScopes.length > 0, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance exit failure enters manual intervention and activates the user kill switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-exit-failure-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["throw"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    const execution = await current.closeAll({
      accountId,
      idempotencyKey: "binance:close-failure:1",
    });
    assert.equal(execution.state, "manual_intervention");
    assert.equal((await current.getConfig()).killSwitchActive, true);
    const pnl = await client.readStrategyPnl();
    assert.equal(pnl.legs.spot.quantityXaut, 0.002);
    assert.equal(pnl.legs.perpetual.quantityXaut, 0.002);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance authoritative order timeout cancels the order and never creates an unhedged position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-timeout-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["new"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:timeout:1"));
    assert.equal(execution.state, "failed");
    assert.equal(client.cancelCount > 0, true);
    assert.equal((await client.readStrategyPnl()).netDeltaXaut, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance close-all retries partial exits and restart recovery disarms persisted execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-recovery-"));
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    await seedTrackedHedge(store, accountId, 0.002);
    client.fillPlan.push(0.5, 1, 1);
    const closed = await current.closeAll({ accountId, idempotencyKey: "binance:close:1" });
    assert.equal(closed.state, "closed");
    assert.equal(client.cancelCount, 1);
    assert.equal((await client.readStrategyPnl()).netDeltaXaut, 0);

    client.seedStrategyExposure(0.002, 0.002);
    const state = await store.readState();
    const pending = createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: `rwa${store.userDomain}`,
      idempotencyKey: `${store.userDomain}:restart-pending`,
      challengeId: "restart-pending",
      now,
    });
    pending.state = "compensating";
    pending.spotOrder = providerOrder("restart-spot", `${pending.orderLinkPrefix}s1`, 0.002);
    pending.perpetualOrders.push(providerOrder("restart-perp", `${pending.orderLinkPrefix}p1`, 0.002));
    pending.strategyPosition = {
      coverage: "complete",
      spotRemainingXaut: 0.002,
      perpetualRemainingXaut: 0.002,
      updatedAt: now,
    };
    state.executions.push(pending);
    await store.writeState(state);
    const restarted = new RwaBinanceAutomationService(store, () => client, () => now, () => false);
    await restarted.initialize();
    const restoredState = await store.readState();
    assert.equal(restoredState.executions.at(-1)?.state, "closed");
    assert.equal((await client.readStrategyPnl()).netDeltaXaut, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance close-all refuses an unexplained authoritative spot delta, including dust", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-close-dust-"));
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    await seedTrackedHedge(store, accountId, 0.002);
    client.setAuthoritativeExposure({ spotFreeXaut: 0.001998, perpetualQuantityXaut: 0.002 });
    const writesBefore = client.placedRequests.length;
    const closed = await current.closeAll({ accountId, idempotencyKey: "binance:close:dust:1" }) as any;
    assert.equal(closed.state, "manual_intervention");
    assert.equal(closed.errorCategory, "strategy_ownership_ambiguous");
    assert.equal(client.placedRequests.length, writesBefore);
    assert.equal(client.strategyCancelScopes.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance close-all blocks same-net external activity and incomplete attribution before writes", async () => {
  for (const mode of ["external", "incomplete"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `xingheng-binance-attribution-${mode}-`));
    try {
      const client = new FakeBinanceClient();
      const { current, store } = serviceHarness(directory, "user-a", client);
      const accountId = await activate(current);
      client.seedStrategyExposure(0.002, 0.002);
      await seedTrackedHedge(store, accountId, 0.002);
      if (mode === "external") client.externalPositionActivity = true;
      else client.attributionCoverage = "incomplete";
      const closed = await current.closeAll({
        accountId,
        idempotencyKey: `binance:close:attribution:${mode}`,
      }) as any;
      assert.equal(closed.state, "manual_intervention");
      assert.equal(closed.errorCategory, "strategy_ownership_ambiguous");
      assert.equal(client.placedRequests.length, 0);
      assert.equal(client.strategyCancelScopes.length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Binance persists base-asset fees and automatically exits the exact net spot position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-net-position-"));
  try {
    const client = new FakeBinanceClient({ spotBuyBaseFeeXaut: 0.000002 });
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const opened = await current.execute(executeInput(accountId, challenge, "binance:net-position:open")) as any;
    assert.equal(opened.state, "hedged");
    const openedState = await store.readState();
    assert.equal(openedState.executions.at(-1)?.strategyPosition.spotRemainingXaut, 0.001998);
    assert.equal(openedState.executions.at(-1)?.strategyPosition.perpetualRemainingXaut, 0.002);

    const closed = await current.closeAll({
      accountId,
      idempotencyKey: "binance:net-position:close",
    }) as any;
    assert.equal(closed.state, "partial_closed");
    assert.equal(
      client.placedRequests.filter((request) => request.category === "spot" && request.side === "Sell").at(-1)?.quantityXaut,
      0.0019,
    );
    assert.equal(closed.reconciliation?.dustResidual?.spot?.quantityXaut, 0.000098);
    const closedState = await store.readState();
    const sourceExecution = closedState.executions.find((item) => item.executionId === opened.executionId);
    assert.equal(sourceExecution?.strategyPosition.spotRemainingXaut, 0.000098);
    assert.equal(sourceExecution?.strategyPosition.perpetualRemainingXaut, 0);
    assert.equal(sourceExecution?.state, "partial_closed");
    assert.equal(closedState.config.killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function seedTrackedHedge(
  store: RwaAutomationPersistentStore<any, any>,
  accountId: string,
  quantityXaut: number,
) {
  const state = await store.readState();
  const execution = createNeutralExecutionRecord({
    userId: "user-a",
    accountId,
    userOrderPrefix: `rwa${store.userDomain}`,
    idempotencyKey: `${store.userDomain}:seed:${state.executions.length}`,
    challengeId: `seed:${state.executions.length}`,
    now,
  });
  execution.state = "hedged";
  execution.hedgedQuantityXaut = quantityXaut;
  execution.strategyPosition = {
    coverage: "complete",
    spotRemainingXaut: quantityXaut,
    perpetualRemainingXaut: quantityXaut,
    updatedAt: now,
  };
  state.executions.push(execution);
  await store.writeState(state);
}

function providerOrder(orderId: string, orderLinkId: string, quantityXaut: number): RwaProviderOrder {
  return {
    orderId,
    orderLinkId,
    status: "Filled",
    requestedQuantityXaut: quantityXaut,
    filledQuantityXaut: quantityXaut,
    averagePrice: 4_000,
    feeUsd: 0,
    updatedAt: now,
  };
}

test("Binance reconciliation detects external manual fill and finalize closes manual intervention safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-reconcile-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["throw"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    const failed = await current.closeAll({ accountId, idempotencyKey: "binance:close:manual:1" }) as any;
    assert.match(failed.state, /manual_intervention|partial_closed/);

    client.setAuthoritativeExposure({
      spotFreeXaut: 0.000098,
      spotLockedXaut: 0,
      perpetualQuantityXaut: 0,
      openSpotOrderCount: 0,
      openPerpetualOrderCount: 0,
    });
    const preview = await current.getReconciliation({ accountId, reconciliationId: failed.executionId }) as any;
    assert.equal(preview.items[0]?.canFinalize, true);
    assert.equal(preview.items[0]?.recommendedAction, "manual_finalize");
    assert.equal(preview.items[0]?.dustResidual?.spot?.quantityXaut, 0.000098);

    const finalized = await current.finalizeReconciliation({
      accountId,
      reconciliationId: failed.executionId,
      idempotencyKey: "binance:finalize:1",
    }) as any;
    assert.equal(finalized.state, "reconciled");
    assert.equal(finalized.reconciliation?.canFinalize, true);

    const readCountBeforeReplay = client.readCount;
    const replayed = await current.finalizeReconciliation({
      accountId,
      reconciliationId: failed.executionId,
      idempotencyKey: "binance:finalize:1",
    }) as any;
    assert.equal(replayed.state, "reconciled");
    assert.equal(client.readCount, readCountBeforeReplay);

    await assert.rejects(
      current.finalizeReconciliation({
        accountId,
        reconciliationId: failed.executionId,
        idempotencyKey: "binance:finalize:2",
      }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "reconciliation_already_finalized",
    );

    const restarted = service(directory, "user-a", client);
    const restartedReplay = await restarted.finalizeReconciliation({
      accountId,
      reconciliationId: failed.executionId,
      idempotencyKey: "binance:finalize:1",
    }) as any;
    assert.equal(restartedReplay.state, "reconciled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance reconciliation stays fail-closed when tradable residual, open orders, or stale snapshot remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-reconcile-blocked-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["throw"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    const failed = await current.closeAll({ accountId, idempotencyKey: "binance:close:blocked:1" }) as any;
    const preview = await current.getReconciliation({ accountId }) as any;
    assert.equal(preview.items[0]?.canFinalize, false);
    assert.match(String(preview.items[0]?.blockingReasons?.join(" ")), /现货侧仍存在可交易余额/);

    client.setAuthoritativeExposure({ spotFreeXaut: 0.00005, openSpotOrderCount: 1, perpetualQuantityXaut: 0 });
    const previewWithOrders = await current.getReconciliation({ accountId, reconciliationId: failed.executionId }) as any;
    assert.equal(previewWithOrders.items[0]?.canFinalize, false);
    assert.match(String(previewWithOrders.items[0]?.blockingReasons?.join(" ")), /活动委托/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance rejects kill switches, account mismatch, unknown fields, and non-XAUT opportunities before writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-guards-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await current.getCredentialStatus()).accountId!;
    await assert.rejects(
      current.preflight(opportunity(), accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "global_execution_disabled",
    );
    await current.updateConfig({ accountId, globalExecutionEnabled: true, strategyEnabled: true });
    await current.setKillSwitch(false, accountId);
    await assert.rejects(
      current.preflight(opportunity(), "binance:other-account", "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "account_mismatch",
    );
    const unsupported = opportunity();
    unsupported.longLeg.asset = "PAXG";
    await assert.rejects(
      current.preflight(unsupported, accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "adapter_opportunity_unsupported",
    );
    await assert.rejects(
      current.execute({ accountId, challengeId: "x", challengeToken: "y", idempotencyKey: "valid-key", symbol: "BTCUSDT" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "invalid_request",
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance KMS failure blocks execute and restart recovery without provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-kms-failure-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflight(opportunity(), accountId, "manual_entry");
    harness.keyProvider.failCategory = "credential_key_provider_unavailable";

    const execution = await harness.current.execute(executeInput(accountId, challenge, "binance:kms-failure:1")) as any;
    assert.equal(execution.state, "manual_intervention");
    assert.equal(execution.errorCategory, "credential_key_provider_unavailable");
    assert.equal(client.writeCount, 0);
    let state = await harness.store.readState();
    assert.equal(state.config.globalExecutionEnabled, false);
    assert.equal(state.config.strategyEnabled, false);
    assert.equal(state.config.killSwitchActive, true);

    harness.keyProvider.failCategory = null;
    state.executions = [createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: "rwa-recovery-test",
      idempotencyKey: "binance:recovery:kms-failure",
      challengeId: "recovery-challenge",
      now,
    })];
    await harness.store.writeState(state);
    harness.keyProvider.failCategory = "credential_key_provider_permission_denied";
    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();
    state = await harness.store.readState();
    assert.equal(state.executions[0]?.state, "manual_intervention");
    assert.equal(state.executions[0]?.errorCategory, "credential_key_provider_unavailable");
    assert.equal(state.config.killSwitchActive, true);
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function service(directory: string, userId: string, client: FakeBinanceClient) {
  return serviceHarness(directory, userId, client).current;
}

function serviceHarness(directory: string, userId: string, client: FakeBinanceClient) {
  const keyProvider = new FakeCredentialKeyProvider();
  const store = new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
    userId,
    venue: "binance",
    keyProvider,
    credentialPath: join(directory, `${userId}-credentials.json`),
    statePath: join(directory, `${userId}-state.json`),
  });
  return { current: new RwaBinanceAutomationService(store, () => client, () => now, () => false), store, keyProvider };
}

async function activate(current: RwaBinanceAutomationService) {
  await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
  const accountId = (await current.getCredentialStatus()).accountId!;
  await current.updateConfig({ accountId, globalExecutionEnabled: true, strategyEnabled: true });
  await current.setKillSwitch(false, accountId);
  return accountId;
}

function executeInput(accountId: string, challenge: { challengeId: string; challengeToken: string }, idempotencyKey: string) {
  return { accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey };
}

class FakeBinanceClient implements RwaBinanceClient {
  readCount = 0;
  writeCount = 0;
  readonly access: {
    accountId: string;
    accountFingerprint: string;
    accountMode: "single_asset_one_way";
    permissions: RwaBinancePermissions;
    ipWhitelistVerificationMode?: "provider_list_exact" | "provider_restriction_only";
  };
  snapshot: RwaBinancePreflightSnapshot;
  private orderSequence = 0;
  private readonly requests = new Map<string, RwaProviderOrderRequest>();
  private spotQuantity = 0;
  private perpetualQuantity = 0;
  readonly fillPlan: Array<number | "throw" | "new">;
  readonly failLeverage: boolean;
  readonly placedRequests: RwaProviderOrderRequest[] = [];
  readonly strategyCancelScopes: string[] = [];
  cancelCount = 0;
  private readonly spotBuyBaseFeeXaut: number;
  attributionCoverage: "complete" | "incomplete" = "complete";
  externalPositionActivity = false;

  constructor(input: {
    permissions?: RwaBinancePermissions;
    fillPlan?: Array<number | "throw" | "new">;
    failLeverage?: boolean;
    spotBuyBaseFeeXaut?: number;
  } = {}) {
    this.fillPlan = [...input.fillPlan ?? []];
    this.failLeverage = input.failLeverage ?? false;
    this.spotBuyBaseFeeXaut = input.spotBuyBaseFeeXaut ?? 0;
    const currentPermissions = input.permissions ?? permissions();
    this.access = {
      accountId: "binance:test-account",
      accountFingerprint: "test-account",
      accountMode: "single_asset_one_way" as const,
      permissions: currentPermissions,
    };
    this.snapshot = {
      ...this.access,
      fetchedAt: now,
      productAvailability: {
        available: true,
        status: "available",
        spotSymbol: "XAUTUSDT",
        perpetualSymbol: "XAUTUSDT",
        checkedAt: now,
        message: null,
      },
      spotAvailableUsdt: 20,
      futuresAvailableUsdt: 20,
      spotFreeXaut: 0,
      spotLockedXaut: 0,
      availableUsdt: 40,
      existingSpotQuantityXaut: 0,
      existingPerpetualQuantityXaut: 0,
      openSpotOrderCount: 0,
      openPerpetualOrderCount: 0,
      spot: {
        status: "Trading",
        minOrderQty: 0.0001,
        qtyStep: 0.0001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 4_129,
        ask: 4_130,
        depthUsd: 100_000,
      },
      perpetual: {
        status: "Trading",
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 4_128,
        ask: 4_129,
        depthUsd: 100_000,
        mark: 4_128.5,
        fundingRate: 0.0002,
        fundingIntervalHours: 4,
        nextFundingTime: now + 3_600_000,
        liquidationDistancePercent: null,
      },
      fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
    };
  }

  async validateAccess() {
    this.readCount += 1;
    return this.access;
  }

  setIpWhitelistVerificationMode(mode: "provider_list_exact" | "provider_restriction_only") {
    this.access.ipWhitelistVerificationMode = mode;
  }

  setPermissions(overrides: Partial<RwaBinancePermissions>) {
    Object.assign(this.access.permissions, overrides);
  }

  async readPreflightSnapshot() {
    this.readCount += 1;
    return structuredClone(this.snapshot);
  }

  async readProductAvailability() {
    this.readCount += 1;
    return this.snapshot.productAvailability;
  }

  async setPerpetualLeverage() {
    this.writeCount += 1;
    if (this.failLeverage) throw new Error("fake leverage mutation rejected");
  }

  async placeOrder(request: RwaProviderOrderRequest) {
    this.writeCount += 1;
    const orderId = String(++this.orderSequence);
    this.requests.set(orderId, request);
    this.placedRequests.push(request);
    return { orderId, orderLinkId: request.orderLinkId };
  }

  async awaitOrder(_category: "spot" | "linear", orderId: string): Promise<RwaProviderOrder> {
    const request = this.requests.get(orderId)!;
    const behavior = this.fillPlan.shift() ?? 1;
    if (behavior === "throw") throw new Error("fake provider rejected order");
    const fillRatio = behavior === "new" ? 0 : behavior;
    const filledQuantityXaut = request.quantityXaut * fillRatio;
    const positionQuantityXaut = request.category === "spot" && request.side === "Buy"
      ? Math.max(0, filledQuantityXaut - this.spotBuyBaseFeeXaut)
      : filledQuantityXaut;
    if (request.category === "spot") {
      this.spotQuantity += request.side === "Buy" ? positionQuantityXaut : -positionQuantityXaut;
      this.snapshot.spotFreeXaut = Math.max(0, this.snapshot.spotFreeXaut + (request.side === "Buy" ? positionQuantityXaut : -positionQuantityXaut));
      this.snapshot.existingSpotQuantityXaut = Math.max(0, this.snapshot.spotFreeXaut + this.snapshot.spotLockedXaut);
    } else {
      this.perpetualQuantity += request.side === "Sell" ? filledQuantityXaut : -filledQuantityXaut;
      this.snapshot.existingPerpetualQuantityXaut = Math.max(0, this.perpetualQuantity);
    }
    return {
      orderId,
      orderLinkId: request.orderLinkId,
      status: behavior === "new" ? "New" : fillRatio < 1 ? "PartiallyFilled" : "Filled",
      requestedQuantityXaut: request.quantityXaut,
      filledQuantityXaut,
      positionQuantityXaut,
      averagePrice: request.limitPrice,
      feeUsd: 0.001,
      updatedAt: now,
    };
  }

  async cancelOrder() {
    this.writeCount += 1;
    this.cancelCount += 1;
  }

  async cancelStrategyOrders(scope: string) {
    this.strategyCancelScopes.push(scope);
  }

  async readPositionAttribution(input: {
    strategyOrderPrefix: string;
    strategyOrderPrefixes: string[];
    since: number;
  }) {
    return {
      coverage: this.attributionCoverage,
      externalPositionActivity: this.externalPositionActivity,
      checkedFrom: input.since,
      checkedThrough: now,
    };
  }

  seedStrategyExposure(spotQuantity: number, perpetualQuantity: number) {
    this.spotQuantity = spotQuantity;
    this.perpetualQuantity = perpetualQuantity;
    this.snapshot.spotFreeXaut = Math.max(0, spotQuantity);
    this.snapshot.spotLockedXaut = 0;
    this.snapshot.existingSpotQuantityXaut = Math.max(0, spotQuantity);
    this.snapshot.existingPerpetualQuantityXaut = Math.max(0, perpetualQuantity);
  }

  setAuthoritativeExposure(input: {
    spotFreeXaut?: number;
    spotLockedXaut?: number;
    perpetualQuantityXaut?: number;
    openSpotOrderCount?: number;
    openPerpetualOrderCount?: number;
  }) {
    if (input.spotFreeXaut !== undefined) this.snapshot.spotFreeXaut = input.spotFreeXaut;
    if (input.spotLockedXaut !== undefined) this.snapshot.spotLockedXaut = input.spotLockedXaut;
    this.snapshot.existingSpotQuantityXaut = this.snapshot.spotFreeXaut + this.snapshot.spotLockedXaut;
    if (input.perpetualQuantityXaut !== undefined) {
      this.snapshot.existingPerpetualQuantityXaut = input.perpetualQuantityXaut;
      this.perpetualQuantity = input.perpetualQuantityXaut;
    }
    if (input.openSpotOrderCount !== undefined) this.snapshot.openSpotOrderCount = input.openSpotOrderCount;
    if (input.openPerpetualOrderCount !== undefined) this.snapshot.openPerpetualOrderCount = input.openPerpetualOrderCount;
  }

  async readStrategyPnl(): Promise<RwaStrategyPnlSnapshot> {
    return {
      accountId: this.access.accountId,
      accountFingerprint: this.access.accountFingerprint,
      strategyId: "binance-xaut-spot-perp-v1",
      capturedAt: now,
      legs: {
        spot: side("spot_long", this.spotQuantity),
        perpetual: side("perpetual_short", this.perpetualQuantity),
      },
      netDeltaXaut: this.spotQuantity - this.perpetualQuantity,
      netDeltaUsd: 0,
      entryBasisBps: null,
      currentBasisBps: null,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      fundingPnlUsd: 0,
      feesUsd: 0,
      slippageUsd: 0,
      netPnlUsd: 0,
      openOrders: [],
    };
  }
}

function side(kind: "spot_long" | "perpetual_short", quantityXaut: number) {
  return {
    kind,
    quantityXaut: Math.max(0, quantityXaut),
    averageEntryPrice: quantityXaut > 0 ? 4_130 : null,
    markPrice: 4_130,
    notionalUsd: Math.max(0, quantityXaut) * 4_130,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
  };
}

function permissions(overrides: Partial<RwaBinancePermissions> = {}): RwaBinancePermissions {
  return {
    read: true,
    spotTrade: true,
    contractTrade: true,
    withdraw: false,
    ipRestricted: true,
    spotAccount: true,
    futuresAccount: true,
    positionModeSupported: true,
    ...overrides,
  };
}

function permissionRejectedWithoutSecret(error: unknown) {
  return error instanceof RwaNeutralExecutionError
    && error.category === "permission_rejected"
    && !error.message.includes("replacement-secret");
}

function opportunity(): ArbitrageOpportunity {
  const leg = (kind: "spot" | "perpetual") => ({
    id: `binance-xaut-${kind}`,
    venue: "binance" as const,
    venueLabel: "Binance",
    symbol: "XAUTUSDT",
    asset: "XAUT" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 4_128,
    ask: 4_130,
    fundingRate: kind === "perpetual" ? 0.0002 : null,
    fundingIntervalHours: kind === "perpetual" ? 4 : null,
    currentFundingApr: kind === "perpetual" ? 43 : 0,
    historicalFundingApr: kind === "perpetual" ? 12 : 0,
    nextFundingTime: null,
  });
  return {
    id: "binance-xaut-spot--binance-xaut-perp",
    longLeg: leg("spot"),
    shortLeg: leg("perpetual"),
    strategyType: "same_venue_neutral",
    strategyLabel: "同所中性",
    matchQuality: "exact",
    matchLabel: "同一资产",
    currentGrossApr: 10,
    historicalGrossApr: 10,
    netApr: 9,
    persistenceRatio: 0.8,
    annualizedTradingCostApr: 1,
    roundTripCostBps: 20,
    entryBasisBps: -4.8,
    capacityUsd: 1_000,
    score: 80,
    historicalQualityScore: 80,
    confidence: "high",
    confidenceLabel: "高",
    opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率驱动",
    recommendation: "recommended",
    entryStatus: "favorable",
    scoreBreakdown: {
      conservativeNetReturn: 20,
      driverStrength: 20,
      persistence: 20,
      costEfficiency: 5,
      liquidity: 10,
      confidence: 5,
    },
    disqualifiers: [],
    warnings: [],
    automationEligible: true,
    automationDisqualifiers: [],
  };
}
