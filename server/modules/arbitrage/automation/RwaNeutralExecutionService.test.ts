import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import { RwaNeutralExecutionError, RwaNeutralExecutionService } from "./RwaNeutralExecutionService";
import type {
  RwaBybitTradingClient,
  RwaProviderOrder,
  RwaProviderOrderRequest,
  RwaProviderPreflightSnapshot,
  RwaStrategyPnlSnapshot,
} from "./RwaNeutralExecutionTypes";

const accountId = "bybit:test-account";
const accountFingerprint = "test-account";

test("eligible opportunity executes a two-leg hedge once and idempotent retry sends no duplicate orders", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const input = {
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:test:0001",
    };
    const first = await harness.service.execute(input) as any;
    assert.equal(first.state, "hedged");
    assert.equal(first.hedgedQuantityXaut, 0.002);
    assert.equal(harness.client.spotQuantity, 0.002);
    assert.equal(harness.client.perpetualQuantity, 0.002);
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
    ]);
    const writes = harness.client.requests.length;
    const repeated = await harness.service.execute(input) as any;
    assert.equal(repeated.executionId, first.executionId);
    assert.equal(harness.client.requests.length, writes);
    const stateRaw = await readFile(harness.statePath, "utf8");
    assert.doesNotMatch(stateRaw, new RegExp(challenge.challengeToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await harness.cleanup();
  }
});

test("negative funding blocks arbitrage_entry before any provider write", async () => {
  const harness = await createHarness({ fundingRate: -0.0000281 });
  try {
    await assert.rejects(
      harness.service.preflight(opportunity(true), accountId),
      (error: unknown) => {
        assert.ok(error instanceof RwaNeutralExecutionError);
        assert.equal(error.category, "preflight_rejected");
        const report = error.details?.report as any;
        assert.equal(report.fundingRate, -0.0000281);
        assert.equal(report.checks.find((item: any) => item.name === "funding_direction")?.passed, false);
        return true;
      },
    );
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);
  } finally {
    await harness.cleanup();
  }
});

test("manual_entry keeps private safety checks but treats funding and return thresholds as warnings through execution", async () => {
  const harness = await createHarness({ fundingRate: -0.0000281 });
  try {
    const challenge = await harness.service.preflight(opportunity(false), accountId, "manual_entry");
    assert.equal(challenge.report.action, "manual_entry");
    assert.equal(challenge.report.mode, "manual_entry");
    assert.equal(challenge.report.passed, true);
    assert.ok(!challenge.report.checks.some((item) =>
      item.name === "funding_direction" || item.name === "entry_basis" || item.name === "net_apr"));
    assert.match(challenge.report.warnings.join(" "), /Funding.*自行决策/);

    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:manual:negative-funding",
    }) as any;

    assert.equal(result.state, "hedged");
    assert.equal(harness.client.leverageWrites, 1);
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("manual_entry still rejects insufficient private balance before provider writes", async () => {
  const harness = await createHarness({ availableUsdt: 0 });
  try {
    await assert.rejects(
      harness.service.preflight(opportunity(false), accountId, "manual_entry"),
      (error: unknown) => {
        assert.ok(error instanceof RwaNeutralExecutionError);
        assert.equal(error.category, "preflight_rejected");
        const report = error.details?.report as any;
        assert.equal(report.mode, "manual_entry");
        assert.equal(report.checks.find((item: any) => item.name === "balance")?.passed, false);
        return true;
      },
    );
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);
  } finally {
    await harness.cleanup();
  }
});

test("second-leg failure cancels and exits the filled spot leg instead of leaving one-leg exposure", async () => {
  const harness = await createHarness({ failSecondLeg: true });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:test:failure",
    }) as any;
    assert.equal(result.state, "failed");
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
    assert.equal(harness.client.spotQuantity, 0);
    assert.equal(harness.client.perpetualQuantity, 0);
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
      ["spot", "Sell"],
    ]);
    assert.ok(harness.client.cancelScopes.length >= 1);
  } finally {
    await harness.cleanup();
  }
});

test("restart disarms an unused challenge and never reaches provider writes", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const restarted = new RwaNeutralExecutionService(harness.store, () => harness.client, () => harness.now, () => false);
    await assert.rejects(
      restarted.execute({
        accountId,
        challengeId: challenge.challengeId,
        challengeToken: challenge.challengeToken,
        idempotencyKey: "entry:test:restart",
      }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "restart_disarmed",
    );
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("credential validation rejects withdraw permission and never persists the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-execution-permission-"));
  const store = new RwaAutomationPersistentStore({
    userId: "user-a",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credentials.enc.json"),
    statePath: join(directory, "state.json"),
  });
  const client = new FakeBybitClient({ withdraw: true });
  const service = new RwaNeutralExecutionService(store, () => client, () => 1_800_000_000_000);
  try {
    await assert.rejects(
      service.putCredentials({ apiKey: "owner-api-key", apiSecret: "owner-secret-value" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "permission_rejected",
    );
    assert.equal(await store.hasCredentials(), false);
    assert.doesNotMatch(JSON.stringify(await service.getCredentialStatus()), /owner-secret-value/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing IP whitelist is a high-risk warning, not an activation or preflight blocker", async () => {
  const harness = await createHarness({ ipRestricted: false });
  try {
    const status = await harness.service.getCredentialStatus();
    assert.equal(status.lifecycleStatus, "active");
    assert.equal(status.ipWhitelistConfigured, false);
    assert.match(status.warnings.join(" "), /IP 白名单/);
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    assert.match(challenge.report.warnings.join(" "), /IP 白名单/);
  } finally {
    await harness.cleanup();
  }
});

test("preflight and execute revalidate the selected account permissions", async () => {
  const harness = await createHarness();
  try {
    const before = harness.client.validateCalls;
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    assert.ok(harness.client.validateCalls > before);
    const afterPreflight = harness.client.validateCalls;
    await harness.service.execute({ accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey: "entry:permission:1" });
    assert.ok(harness.client.validateCalls > afterPreflight);
  } finally {
    await harness.cleanup();
  }
});

test("credential key provider failure blocks new-risk controls and provider writes", async () => {
  const harness = await createHarness();
  const executeHarness = await createHarness();
  try {
    harness.keyProvider.failCategory = "credential_key_provider_unavailable";
    await assert.rejects(
      harness.service.updateConfig({ accountId, strategyEnabled: true }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_key_provider_unavailable",
    );
    let state = await harness.store.readState();
    assert.equal(state.config.globalExecutionEnabled, false);
    assert.equal(state.config.strategyEnabled, false);
    assert.equal(state.config.killSwitchActive, true);

    await assert.rejects(
      harness.service.setKillSwitch(false, accountId),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_key_provider_unavailable",
    );

    state = await harness.store.readState();
    state.config.globalExecutionEnabled = true;
    state.config.strategyEnabled = true;
    state.config.killSwitchActive = false;
    await harness.store.writeState(state);
    await assert.rejects(
      harness.service.preflight(opportunity(true), accountId),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_key_provider_unavailable",
    );
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);

    const challenge = await executeHarness.service.preflight(opportunity(true), accountId);
    executeHarness.keyProvider.failCategory = "credential_key_provider_unavailable";
    const execution = await executeHarness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:kms-failure",
    }) as any;
    assert.equal(execution.state, "manual_intervention");
    assert.equal(execution.errorCategory, "credential_key_provider_unavailable");
    assert.equal(executeHarness.client.requests.length, 0);
    assert.equal(executeHarness.client.leverageWrites, 0);
  } finally {
    await harness.cleanup();
    await executeHarness.cleanup();
  }
});

test("credential deletion is blocked while strategy exposure exists and succeeds after close-all", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({ accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey: "entry:delete:1" });
    await assert.rejects(
      harness.service.deleteCredentials({ accountId }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "credential_delete_blocked",
    );
    assert.equal(await harness.store.hasCredentials(), true);
    await harness.service.closeAll({ accountId, idempotencyKey: "close:delete:1" });
    const deleted = await harness.service.deleteCredentials({ accountId }) as any;
    assert.equal(deleted.ok, true);
    assert.equal(await harness.store.hasCredentials(), false);
    assert.equal(deleted.credentials.lifecycleStatus, "unconfigured");
  } finally {
    await harness.cleanup();
  }
});

test("invalid credentials refuse unsafe deletion and return manual intervention guidance", async () => {
  const harness = await createHarness();
  try {
    harness.client.accessUnavailable = true;
    await assert.rejects(
      harness.service.deleteCredentials({ accountId }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_delete_manual_intervention"
        && /人工撤单和平仓/.test(error.message),
    );
    assert.equal(await harness.store.hasCredentials(), true);
    const state = await harness.store.readState();
    assert.equal(state.config.killSwitchActive, true);
    assert.match(state.credentialAlert ?? "", /人工撤单和平仓/);
  } finally {
    await harness.cleanup();
  }
});

test("failed credential rotation keeps the previous encrypted credential active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-rotation-"));
  const store = new RwaAutomationPersistentStore({ userId: "user-a", keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credentials.enc.json"), statePath: join(directory, "state.json") });
  const validClient = new FakeBybitClient();
  const service = new RwaNeutralExecutionService(store, (credentials) => {
    if (credentials.apiKey.includes("new")) return { ...validClient, validateAccess: async () => { throw new Error("candidate rejected secret=hidden"); } } as any;
    return validClient;
  }, () => 1_800_000_000_000, () => false);
  try {
    await service.putCredentials({ apiKey: "old-api-key-123", apiSecret: "old-secret-value-123" });
    await assert.rejects(service.putCredentials({ apiKey: "new-api-key-123", apiSecret: "new-secret-value-123" }));
    assert.deepEqual(await store.loadCredentials(), { apiKey: "old-api-key-123", apiSecret: "old-secret-value-123" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("close-all retries partial exits and confirms provider exposure is zero", async () => {
  const harness = await createHarness({ partialClose: true });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({ accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey: "entry:partial-close" });
    const closed = await harness.service.closeAll({ accountId, idempotencyKey: "close:partial-close" }) as any;
    assert.equal(closed.state, "closed");
    assert.equal(harness.client.spotQuantity, 0);
    assert.equal(harness.client.perpetualQuantity, 0);
    assert.equal(harness.client.closeFillAttempts.spot, 2);
    assert.equal(harness.client.closeFillAttempts.linear, 2);
  } finally {
    await harness.cleanup();
  }
});

async function createHarness(options: {
  fundingRate?: number;
  failSecondLeg?: boolean;
  ipRestricted?: boolean;
  partialClose?: boolean;
  availableUsdt?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-execution-"));
  const credentialPath = join(directory, "credentials.enc.json");
  const statePath = join(directory, "state.json");
  const keyProvider = new FakeCredentialKeyProvider();
  const store = new RwaAutomationPersistentStore({
    userId: "user-a",
    keyProvider,
    credentialPath,
    statePath,
  });
  const now = 1_800_000_000_000;
  const client = new FakeBybitClient({ ...options, now });
  const service = new RwaNeutralExecutionService(store, () => client, () => now, () => false);
  await service.putCredentials({ apiKey: "owner-api-key-123", apiSecret: "owner-secret-value-123" });
  await service.updateConfig({ accountId, globalExecutionEnabled: true, strategyEnabled: true });
  await service.setKillSwitch(false, accountId);
  return {
    service,
    client,
    keyProvider,
    store,
    statePath,
    now,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class FakeBybitClient implements RwaBybitTradingClient {
  readonly requests: RwaProviderOrderRequest[] = [];
  readonly cancelScopes: string[] = [];
  spotQuantity = 0;
  perpetualQuantity = 0;
  leverageWrites = 0;
  validateCalls = 0;
  accessUnavailable = false;
  readonly closeFillAttempts = { spot: 0, linear: 0 };
  private orderCounter = 0;
  private readonly orders = new Map<string, RwaProviderOrderRequest>();
  private readonly fundingRate: number;
  private readonly failSecondLeg: boolean;
  private readonly withdraw: boolean;
  private readonly ipRestricted: boolean;
  private readonly partialClose: boolean;
  private readonly availableUsdt: number;
  private readonly now: number;

  constructor(options: {
    fundingRate?: number;
    failSecondLeg?: boolean;
    withdraw?: boolean;
    ipRestricted?: boolean;
    partialClose?: boolean;
    availableUsdt?: number;
    now?: number;
  } = {}) {
    this.fundingRate = options.fundingRate ?? 0.0002;
    this.failSecondLeg = options.failSecondLeg ?? false;
    this.withdraw = options.withdraw ?? false;
    this.ipRestricted = options.ipRestricted ?? true;
    this.partialClose = options.partialClose ?? false;
    this.availableUsdt = options.availableUsdt ?? 25;
    this.now = options.now ?? 1_800_000_000_000;
  }

  async validateAccess() {
    this.validateCalls += 1;
    if (this.accessUnavailable) throw new Error("simulated revoked credential secret=must-not-leak");
    return { permissions: permissions(this.withdraw, this.ipRestricted), accountMode: "uta" as const, accountId, accountFingerprint };
  }

  async readPreflightSnapshot(): Promise<RwaProviderPreflightSnapshot> {
    return {
      accountId,
      accountFingerprint,
      fetchedAt: this.now,
      accountMode: "uta",
      permissions: permissions(this.withdraw, this.ipRestricted),
      availableUsdt: this.availableUsdt,
      existingSpotQuantityXaut: 0,
      existingPerpetualQuantityXaut: 0,
      spot: { status: "Trading", minOrderQty: 0.00001, qtyStep: 0.00001, minNotionalUsd: 5, priceTick: 0.01, bid: 4129, ask: 4130 },
      perpetual: {
        status: "Trading",
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.1,
        bid: 4128,
        ask: 4129,
        mark: 4128.5,
        fundingRate: this.fundingRate,
        fundingIntervalHours: 4,
        liquidationDistancePercent: null,
      },
      fees: { spotTakerBps: 1, perpetualTakerBps: 1 },
    };
  }

  async setPerpetualLeverage(_leverage: 1) {
    this.leverageWrites += 1;
  }

  async placeOrder(request: RwaProviderOrderRequest) {
    this.requests.push(request);
    if (this.failSecondLeg && request.category === "linear" && request.side === "Sell") {
      throw new Error("simulated second-leg failure secret=must-not-leak");
    }
    const orderId = `order-${++this.orderCounter}`;
    this.orders.set(orderId, request);
    return { orderId, orderLinkId: request.orderLinkId };
  }

  async awaitOrder(_category: "spot" | "linear", orderId: string, _deadlineAt: number) {
    const request = this.orders.get(orderId)!;
    const closing = (request.category === "spot" && request.side === "Sell") || (request.category === "linear" && request.side === "Buy");
    let filledQuantity = request.quantityXaut;
    if (this.partialClose && closing) {
      this.closeFillAttempts[request.category] += 1;
      if (this.closeFillAttempts[request.category] === 1) filledQuantity = request.quantityXaut / 2;
    }
    if (request.category === "spot") {
      this.spotQuantity += request.side === "Buy" ? filledQuantity : -filledQuantity;
    } else {
      this.perpetualQuantity += request.side === "Sell" ? filledQuantity : -filledQuantity;
    }
    return { ...order(orderId, request, this.now), status: filledQuantity < request.quantityXaut ? "PartiallyFilled" as const : "Filled" as const,
      filledQuantityXaut: filledQuantity };
  }

  async cancelOrder() {}

  async cancelStrategyOrders(scope: string) {
    this.cancelScopes.push(scope);
  }

  async readStrategyPnl(): Promise<RwaStrategyPnlSnapshot> {
    const spotMark = 4130;
    const perpMark = 4128;
    return {
      accountId,
      accountFingerprint,
      strategyId: "bybit-xaut-spot-perp-v1",
      capturedAt: this.now,
      legs: {
        spot: { kind: "spot_long", quantityXaut: Math.max(0, this.spotQuantity), averageEntryPrice: 4130, markPrice: spotMark, notionalUsd: Math.max(0, this.spotQuantity) * spotMark, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
        perpetual: { kind: "perpetual_short", quantityXaut: Math.max(0, this.perpetualQuantity), averageEntryPrice: 4128, markPrice: perpMark, notionalUsd: Math.max(0, this.perpetualQuantity) * perpMark, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
      },
      netDeltaXaut: this.spotQuantity - this.perpetualQuantity,
      netDeltaUsd: this.spotQuantity * spotMark - this.perpetualQuantity * perpMark,
      entryBasisBps: -4.8,
      currentBasisBps: -4.8,
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

function permissions(withdraw = false, ipRestricted = true) {
  return { read: true, spotTrade: true, contractTrade: true, withdraw, uta: true, ipRestricted, ownerSubaccount: true };
}

function order(orderId: string, request: RwaProviderOrderRequest, updatedAt: number): RwaProviderOrder {
  return {
    orderId,
    orderLinkId: request.orderLinkId,
    status: "Filled",
    requestedQuantityXaut: request.quantityXaut,
    filledQuantityXaut: request.quantityXaut,
    averagePrice: request.limitPrice,
    feeUsd: 0.001,
    updatedAt,
  };
}

function opportunity(eligible: boolean): ArbitrageOpportunity {
  const leg = (kind: "spot" | "perpetual") => ({
    id: `bybit-xaut-${kind}`,
    venue: "bybit" as const,
    venueLabel: "Bybit",
    symbol: "XAUTUSDT",
    asset: "XAUT" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 4128,
    ask: 4130,
    fundingRate: kind === "perpetual" ? 0.0002 : null,
    fundingIntervalHours: kind === "perpetual" ? 4 : null,
    currentFundingApr: kind === "perpetual" ? 43 : 0,
    historicalFundingApr: kind === "perpetual" ? 12 : 0,
    nextFundingTime: null,
  });
  return {
    id: "bybit-xaut-spot--bybit-xaut-perp",
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
    capacityUsd: 1000,
    score: 80,
    historicalQualityScore: 80,
    confidence: "high",
    confidenceLabel: "高",
    opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率驱动",
    recommendation: "recommended",
    entryStatus: eligible ? "favorable" : "cautious",
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
    automationEligible: eligible,
    automationDisqualifiers: eligible ? [] : ["blocked"],
  };
}
