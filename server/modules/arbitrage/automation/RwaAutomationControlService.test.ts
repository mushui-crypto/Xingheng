import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationConnectorRegistry } from "./RwaAutomationConnectorRegistry";
import { automationErrorResponse, RwaAutomationControlError, RwaAutomationControlService } from "./RwaAutomationControlService";
import type { RwaAutomationConnector, RwaAutomationMode, RwaAutomationVenue, RwaVenueCredentialInput } from "./RwaAutomationTypes";
import { canonicalRequestDigest, StepUpSecurityError } from "../../security/StepUpSecurityService";
import {
  RwaAutomationGovernance,
  RwaAutomationGovernanceError,
  loadRwaAutomationGovernanceConfig,
} from "./RwaAutomationGovernance";

const sessionDomain = "session-domain-a";
const stepUpToken = "step-up-token-a";
const passThroughStepUp = {
  consume: async () => undefined,
  recordCredentialBinding: async () => undefined,
  revokeAutomationScope: () => undefined,
};

test("arbitrage preflight re-reads the server opportunity and blocks ineligible candidates before private connector calls", async () => {
  let privatePreflightCalls = 0;
  const connector = fakeConnector(() => { privatePreflightCalls += 1; });
  const dashboard = {
    async getSnapshot(_horizon: 90, forceRefresh: boolean) {
      assert.equal(forceRefresh, true);
      return dashboardSnapshot(opportunity(false, ["Funding 方向不利", "持续性不足 75%"]));
    },
  };
  const service = new RwaAutomationControlService(dashboard as any, () => new RwaAutomationConnectorRegistry([connector]), passThroughStepUp);

  await assert.rejects(
    service.preflight("user-a", { accountId: "bybit:test-account", opportunityId: "bybit-xaut-spot--bybit-xaut-perp", mode: "arbitrage_entry" }),
    (error: unknown) => error instanceof RwaAutomationControlError && error.category === "automation_opportunity_blocked",
  );
  assert.equal(privatePreflightCalls, 0);
});

test("manual entry bypasses automatic quality gates but still reaches the implemented connector", async () => {
  let receivedMode: RwaAutomationMode | null = null;
  const connector = fakeConnector((mode) => { receivedMode = mode; });
  const dashboard = {
    async getSnapshot() {
      return dashboardSnapshot(opportunity(false, ["Funding 方向不利", "持续性不足 75%"]));
    },
  };
  const service = new RwaAutomationControlService(dashboard as any, () => new RwaAutomationConnectorRegistry([connector]), passThroughStepUp);

  const challenge = await service.preflight("user-a", {
    accountId: "bybit:test-account",
    opportunityId: "bybit-xaut-spot--bybit-xaut-perp",
    mode: "manual_entry",
  });

  assert.equal(receivedMode, "manual_entry");
  assert.equal(challenge.challengeId, "challenge");
});

test("manual entry rejects safety disqualifiers before any private connector call", async () => {
  let privatePreflightCalls = 0;
  const connector = fakeConnector(() => { privatePreflightCalls += 1; });
  const unsafe = opportunity(false);
  unsafe.disqualifiers = ["缺少可执行报价"];
  const service = new RwaAutomationControlService({
    async getSnapshot() { return dashboardSnapshot(unsafe); },
  } as any, () => new RwaAutomationConnectorRegistry([connector]), passThroughStepUp);

  await assert.rejects(
    service.preflight("user-a", {
      accountId: "bybit:test-account",
      opportunityId: unsafe.id,
      mode: "manual_entry",
    }),
    (error: unknown) => error instanceof RwaAutomationControlError && error.category === "safety_opportunity_blocked",
  );
  assert.equal(privatePreflightCalls, 0);
});

test("connectivity smoke cannot be smuggled through arbitrage_entry and unimplemented venues stay disabled", async () => {
  const service = new RwaAutomationControlService({} as any, () => new RwaAutomationConnectorRegistry([]), passThroughStepUp);
  await assert.rejects(
    service.preflight("user-a", { accountId: "bybit:test-account", opportunityId: "anything", mode: "connectivity_smoke" }),
    (error: unknown) => error instanceof RwaAutomationControlError && error.category === "mode_invalid",
  );
  const venues = await service.listVenues("user-a");
  assert.deepEqual(venues.map((item) => [item.venue, item.implemented, item.enabled]), [
    ["bybit", false, false],
    ["bitget", false, false],
    ["binance", false, false],
    ["okx", false, false],
  ]);
});

test("challenge ownership prevents horizontal execution across users", async () => {
  const connector = fakeConnector(() => undefined);
  const dashboard = { async getSnapshot() { return dashboardSnapshot(opportunity(true)); } };
  const service = new RwaAutomationControlService(dashboard as any, () => new RwaAutomationConnectorRegistry([connector]), passThroughStepUp);
  const challenge = await service.preflight("user-a", {
    accountId: "bybit:test-account",
    opportunityId: "bybit-xaut-spot--bybit-xaut-perp",
    mode: "arbitrage_entry",
  });
  await assert.rejects(
    async () => service.execute("user-b", sessionDomain, { accountId: "bybit:test-account", challengeId: challenge.challengeId, stepUpToken }),
    (error: unknown) => error instanceof RwaAutomationControlError && error.category === "challenge_not_found",
  );
});

test("public opportunity projection contains no user credential or account ownership data", async () => {
  const connector = fakeConnector(() => undefined);
  const service = new RwaAutomationControlService({ async getSnapshot() { return dashboardSnapshot(opportunity(true)); } } as any,
    () => new RwaAutomationConnectorRegistry([connector]), passThroughStepUp);
  const projected = await service.listOpportunities("user-private-id");
  assert.doesNotMatch(JSON.stringify(projected), /user-private-id|accountId|maskedApiKey|permissions/);
  assert.equal(projected.items[0]?.safetyEligible, true);
  assert.deepEqual(projected.items[0]?.safetyDisqualifiers, []);
});

test("credential fields are strict per venue and rejected values never reach the connector or error response", async () => {
  const received = new Map<RwaAutomationVenue, RwaVenueCredentialInput[]>();
  const binance = fakeConnector(() => undefined, {
    venue: "binance",
    providerWritesEnabled: false,
    onCredentials: (input) => received.set("binance", [...received.get("binance") ?? [], input]),
  });
  const bybit = fakeConnector(() => undefined, {
    onCredentials: (input) => received.set("bybit", [...received.get("bybit") ?? [], input]),
  });
  const service = new RwaAutomationControlService({} as any, () => new RwaAutomationConnectorRegistry([bybit, binance]), passThroughStepUp);

  await service.putCredentials("user-a", sessionDomain, "binance", { apiKey: "binance-key", apiSecret: "binance-secret", stepUpToken });
  await service.putCredentials("user-a", sessionDomain, "bybit", { apiKey: "bybit-key", apiSecret: "bybit-secret", stepUpToken });
  assert.deepEqual(received.get("binance"), [{ apiKey: "binance-key", apiSecret: "binance-secret" }]);
  assert.deepEqual(received.get("bybit"), [{ apiKey: "bybit-key", apiSecret: "bybit-secret" }]);

  for (const rejected of [
    { apiKey: "binance-key", apiSecret: "binance-secret", passphrase: "must-not-leak-passphrase" },
    { apiKey: "binance-key", apiSecret: "binance-secret", unknownCredential: "must-not-leak-value" },
  ]) {
    let caught: unknown;
    try {
      await service.putCredentials("user-a", sessionDomain, "binance", { ...rejected, stepUpToken });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RwaAutomationControlError);
    const response = automationErrorResponse(caught);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.category, "invalid_request");
    assert.doesNotMatch(JSON.stringify(response), /must-not-leak|binance-secret/);
  }
  assert.equal(received.get("binance")?.length, 1);
});

test("Binance execute fails at the server capability gate before challenge lookup or provider writes", async () => {
  let executeCalls = 0;
  const factory = (userId: string) => {
    const binance = fakeConnector(() => undefined, {
      venue: "binance",
      providerWritesEnabled: false,
      accountId: userId === "user-a" ? "binance:user-a-account" : "binance:user-b-account",
      onExecute: () => { executeCalls += 1; },
    });
    return new RwaAutomationConnectorRegistry([binance]);
  };
  const service = new RwaAutomationControlService(
    {} as any,
    factory,
    passThroughStepUp,
    new RwaAutomationGovernance({
      ...loadRwaAutomationGovernanceConfig({}),
      executeBurstMax: 5,
      executeSustainedMax: 10,
    }),
  );

  for (const input of [
    { accountId: "binance:user-a-account" },
    { accountId: "binance:user-a-account", challengeId: "forged-challenge" },
  ]) {
    await assert.rejects(
      service.execute("user-a", sessionDomain, { ...input, stepUpToken }),
      (error: unknown) => error instanceof RwaAutomationControlError
        && error.statusCode === 501
        && error.category === "binance_provider_writes_disabled",
    );
  }

  await assert.rejects(
    service.execute("user-a", sessionDomain, { accountId: "binance:user-b-account", challengeId: "forged-challenge", stepUpToken }),
    (error: unknown) => error instanceof RwaAutomationControlError && error.category === "challenge_disarmed",
  );
  await assert.rejects(
    service.execute("user-b", sessionDomain, { accountId: "binance:user-a-account", challengeId: "forged-challenge", stepUpToken }),
    (error: unknown) => error instanceof RwaAutomationControlError && error.category === "challenge_disarmed",
  );
  assert.equal(executeCalls, 0);
});

test("Bybit execute retains challenge ownership and connector execution behavior", async () => {
  let executeCalls = 0;
  const connector = fakeConnector(() => undefined, { onExecute: () => { executeCalls += 1; } });
  const service = new RwaAutomationControlService(
    { async getSnapshot() { return dashboardSnapshot(opportunity(true)); } } as any,
    () => new RwaAutomationConnectorRegistry([connector]),
    passThroughStepUp,
  );
  const challenge = await service.preflight("user-a", {
    accountId: "bybit:test-account",
    opportunityId: "bybit-xaut-spot--bybit-xaut-perp",
    mode: "arbitrage_entry",
  });

  await service.execute("user-a", sessionDomain, { accountId: "bybit:test-account", challengeId: challenge.challengeId, stepUpToken });
  assert.equal(executeCalls, 1);
});

test("establishing a hedge requires both preflight challenge and step-up before provider write", async () => {
  let executeCalls = 0;
  let consumedIntent: unknown;
  const connector = fakeConnector(() => undefined, {
    onExecute: () => { executeCalls += 1; },
  });
  const requiredStepUp = {
    consume: async (...args: unknown[]) => {
      consumedIntent = args.at(-1);
      throw new StepUpSecurityError(403, "step_up_required", "该敏感操作需要新的二次身份验证。");
    },
    recordCredentialBinding: async () => undefined,
    revokeAutomationScope: () => undefined,
  };
  const service = new RwaAutomationControlService(
    { async getSnapshot() { return dashboardSnapshot(opportunity(true)); } } as any,
    () => new RwaAutomationConnectorRegistry([connector]),
    requiredStepUp,
  );
  const challenge = await service.preflight("user-a", {
    accountId: "bybit:test-account",
    opportunityId: "bybit-xaut-spot--bybit-xaut-perp",
    mode: "arbitrage_entry",
  });

  await assert.rejects(
    service.execute("user-a", sessionDomain, {
      accountId: "bybit:test-account",
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:missing-step-up",
    }),
    (error: unknown) => error instanceof StepUpSecurityError && error.category === "step_up_required",
  );
  assert.equal(executeCalls, 0);

  await assert.rejects(
    service.execute("user-a", sessionDomain, {
      accountId: "bybit:test-account",
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:step-up-required",
      stepUpToken,
    }),
    (error: unknown) => error instanceof StepUpSecurityError && error.category === "step_up_required",
  );
  assert.equal(executeCalls, 0);
  assert.deepEqual(consumedIntent, {
    operation: "hedge_execute",
    venue: "bybit",
    accountId: "bybit:test-account",
    resourceId: challenge.challengeId,
    requestDigest: canonicalRequestDigest({
      accountId: "bybit:test-account",
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:step-up-required",
    }),
    notionalUsd: null,
  });
});

test("risk-reducing switch actions remain immediate while enabling risk requires step-up", async () => {
  let configCalls = 0;
  let killSwitchCalls = 0;
  let initializeCalls = 0;
  const connector = fakeConnector(() => undefined, {
    accountId: "bybit:test-account",
    onConfig: () => { configCalls += 1; },
    onKillSwitch: () => { killSwitchCalls += 1; },
    onInitialize: () => { initializeCalls += 1; },
  });
  const rejectingStepUp = {
    consume: async () => { throw new StepUpSecurityError(403, "step_up_required", "该敏感操作需要新的二次身份验证。"); },
    recordCredentialBinding: async () => undefined,
    revokeAutomationScope: () => undefined,
  };
  const service = new RwaAutomationControlService({} as any, () => new RwaAutomationConnectorRegistry([connector]), rejectingStepUp);

  await service.updateConfig("user-a", sessionDomain, "bybit", {
    accountId: "bybit:test-account",
    globalExecutionEnabled: false,
    strategyEnabled: false,
  });
  await service.setKillSwitch("user-a", sessionDomain, "bybit", { accountId: "bybit:test-account", active: true });
  assert.equal(configCalls, 1);
  assert.equal(killSwitchCalls, 1);
  assert.equal(initializeCalls, 0, "risk-reducing controls must not wait for recovery initialization");

  await assert.rejects(
    service.updateConfig("user-a", sessionDomain, "bybit", {
      accountId: "bybit:test-account",
      globalExecutionEnabled: true,
      stepUpToken,
    }),
    (error: unknown) => error instanceof StepUpSecurityError && error.category === "step_up_required",
  );
  await assert.rejects(
    service.setKillSwitch("user-a", sessionDomain, "bybit", {
      accountId: "bybit:test-account",
      active: false,
      stepUpToken,
    }),
    (error: unknown) => error instanceof StepUpSecurityError && error.category === "step_up_required",
  );
  assert.equal(configCalls, 1);
  assert.equal(killSwitchCalls, 1);
  assert.equal(initializeCalls, 1);
});

test("credential admission is atomic before step-up and private provider work", async () => {
  let stepUpCalls = 0;
  let providerCalls = 0;
  const connector = fakeConnector(() => undefined, {
    accountId: "bybit:test-account",
    onCredentials: () => { providerCalls += 1; },
  });
  const governor = new RwaAutomationGovernance({
    ...loadRwaAutomationGovernanceConfig({}),
    credentialMax: 1,
  }, () => 10_000);
  const service = new RwaAutomationControlService(
    {} as any,
    () => new RwaAutomationConnectorRegistry([connector]),
    {
      consume: async () => { stepUpCalls += 1; },
      recordCredentialBinding: async () => undefined,
      revokeAutomationScope: () => undefined,
    },
    governor,
    () => 10_000,
  );
  const payload = { apiKey: "key-value", apiSecret: "secret-value", stepUpToken };
  await service.putCredentials("user-a", sessionDomain, "bybit", payload, "203.0.113.10");
  await assert.rejects(
    service.putCredentials("user-a", sessionDomain, "bybit", payload, "203.0.113.10"),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_rate_limited"
      && !JSON.stringify(error).includes("secret-value"),
  );
  assert.equal(stepUpCalls, 1);
  assert.equal(providerCalls, 1);
});

test("request admission rejects before recreating an idle registry or reading account metadata", async () => {
  let now = 10_000;
  let registryCreations = 0;
  let accountMetadataReads = 0;
  let initializeCalls = 0;
  const governor = new RwaAutomationGovernance({
    ...loadRwaAutomationGovernanceConfig({}),
    privateReadMax: 1,
    registryIdleTtlMs: 1,
  }, () => now);
  const service = new RwaAutomationControlService(
    {} as any,
    () => {
      registryCreations += 1;
      return new RwaAutomationConnectorRegistry([fakeConnector(() => undefined, {
        accountId: "bybit:test-account",
        onAccountMetadata: () => { accountMetadataReads += 1; },
        onInitialize: () => { initializeCalls += 1; },
      })]);
    },
    passThroughStepUp,
    governor,
    () => now,
  );

  await service.getVenueStatus("user-a", "bybit", "203.0.113.10");
  now += 2;
  await assert.rejects(
    service.getVenueStatus("user-a", "bybit", "203.0.113.10"),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_rate_limited",
  );
  assert.equal(registryCreations, 1);
  assert.equal(accountMetadataReads, 1);
  assert.equal(initializeCalls, 1);

  await assert.rejects(
    service.resolveStepUpIntent("user-a", {
      operation: "credential_put",
      venue: "bybit",
      accountId: "bybit:test-account",
      resourceId: null,
      requestDigest: "a".repeat(43),
    }, "203.0.113.10"),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_rate_limited",
  );
  assert.equal(registryCreations, 1);
  assert.equal(accountMetadataReads, 1);
  assert.equal(initializeCalls, 1);
});

function fakeConnector(
  onPreflight: (mode: RwaAutomationMode) => void,
  options: {
    venue?: RwaAutomationVenue;
    providerWritesEnabled?: boolean;
    accountId?: string | null;
    onCredentials?: (input: RwaVenueCredentialInput) => void;
    onExecute?: () => void;
    onConfig?: () => void;
    onKillSwitch?: () => void;
    onAccountMetadata?: () => void;
    onInitialize?: () => void;
  } = {},
): RwaAutomationConnector {
  const venue = options.venue ?? "bybit";
  return {
    venue,
    implemented: true,
    providerWritesEnabled: options.providerWritesEnabled ?? true,
    initialize: async () => { options.onInitialize?.(); },
    supports: () => true,
    getConfiguredAccountId: async () => {
      options.onAccountMetadata?.();
      return options.accountId ?? null;
    },
    getStatus: async () => ({ venue, implemented: true, enabled: false, credential: {
      userId: "user-a", stored: Boolean(options.accountId), accountId: options.accountId ?? null, accountFingerprint: null, masterKeyConfigured: true, maskedApiKey: null, connectionStatus: "not_configured",
      lifecycleStatus: "unconfigured", accountMode: null,
      permissions: null, lastVerifiedAt: null, updatedAt: null, message: null,
      ipWhitelistConfigured: null, warnings: [],
    } }),
    putCredentials: async (input) => {
      options.onCredentials?.(input);
      return {
        venue,
        implemented: true,
        enabled: false,
        credential: {
          userId: "user-a", stored: true, accountId: options.accountId ?? `${venue}:test-account`, accountFingerprint: null, masterKeyConfigured: true,
          maskedApiKey: null, connectionStatus: "verified", lifecycleStatus: "active", accountMode: null,
          permissions: null, lastVerifiedAt: null, updatedAt: null, message: null, ipWhitelistConfigured: null, warnings: [],
        },
      };
    },
    deleteCredentials: async () => ({}),
    getConfig: async () => ({}),
    updateConfig: async () => { options.onConfig?.(); return {}; },
    setKillSwitch: async () => { options.onKillSwitch?.(); return {}; },
    getPrivateAccount: async () => ({}),
    getPnl: async () => ({}),
    getAudit: async () => ({}),
    preflight: async (_opportunity, _accountId, mode) => {
      onPreflight(mode);
      return { challengeId: "challenge", challengeToken: "token", expiresAt: 1, report: { mode } };
    },
    execute: async () => { options.onExecute?.(); return {}; },
    closeAll: async () => ({}),
  };
}

function opportunity(eligible: boolean, reasons: string[] = []): ArbitrageOpportunity {
  const leg = (kind: "spot" | "perpetual") => ({
    id: `bybit-xaut-${kind === "spot" ? "spot" : "perp"}`,
    venue: "bybit" as const,
    venueLabel: "Bybit",
    symbol: "XAUTUSDT",
    asset: "XAUT" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 4127,
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
    entryBasisBps: 2,
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
    automationDisqualifiers: reasons,
  };
}

function dashboardSnapshot(item: ArbitrageOpportunity) {
  return {
    horizonDays: 90 as const,
    generatedAt: Date.now(),
    markets: [],
    opportunities: [item],
    summary: {
      bestScore: item.score,
      bestNetApr: item.netApr,
      eligibleOpportunityCount: item.automationEligible ? 1 : 0,
      connectedVenueCount: 1,
      totalVenueCount: 5,
      trackedMarketCount: 2,
      usdcUsdtPrice: 1,
      stablecoinBasisBps: 0,
    },
    warnings: [],
  };
}
