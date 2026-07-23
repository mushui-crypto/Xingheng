import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomationConsoleContractError,
  createUserAutomationConsoleClient,
  isCredentialActivationReady,
  isAccountMismatchError,
  presentAutomationConsoleError,
} from "./arbitrageAutomationConsole";
import { createFakeAutomationConsoleClient } from "./arbitrageAutomationConsole.fake";
import { createAutomationConsoleFixture } from "../features/arbitrageAutomation/model/controlConsoleFixture";
import type { AutomationPreflight, AutomationPreflightResult } from "../features/arbitrageAutomation/model/controlConsoleTypes";

test("fake console loads without fetch and exposes zero eligible candidates", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
  try {
    const snapshot = await createFakeAutomationConsoleClient().load();
    assert.equal(fetchCalls, 0);
    assert.equal(snapshot.source, "user_api");
    assert.equal(snapshot.summary.eligibleCandidateCount, 0);
    assert.equal(snapshot.candidates.some((candidate) => candidate.automationEligible), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safety-blocked candidate cannot generate either preflight mode", async () => {
  const client = createFakeAutomationConsoleClient();
  await assert.rejects(() => client.requestPreflight("cand-xaut-bybit-blocked", "manual_entry"), (error: unknown) => {
    assert.equal(error instanceof AutomationConsoleContractError && error.status, 409);
    assert.equal(error instanceof AutomationConsoleContractError && error.category, "safety_opportunity_blocked");
    return true;
  });
});

test("safe candidate below automatic strategy conditions can request manual preflight only", async () => {
  const client = createFakeAutomationConsoleClient();
  const manual = await client.requestPreflight("cand-xaut-bybit-01", "manual_entry");
  assert.equal(manual.mode, "manual_entry");
  await assert.rejects(() => client.requestPreflight("cand-xaut-bybit-01", "arbitrage_entry"), (error: unknown) => {
    assert.equal(error instanceof AutomationConsoleContractError && error.category, "automation_opportunity_blocked");
    return true;
  });
});

test("eligible contract fixture completes preflight and only returns a simulated receipt", async () => {
  const snapshot = createAutomationConsoleFixture();
  snapshot.candidates[0] = { ...snapshot.candidates[0], automationEligible: true, automationDisqualifiers: [] };
  snapshot.summary.eligibleCandidateCount = 1;
  snapshot.globalExecutionEnabled = true;
  snapshot.killSwitchActive = false;
  snapshot.strategyEnabled = true;
  const client = createFakeAutomationConsoleClient(snapshot);
  const preflight = await client.requestPreflight(snapshot.candidates[0].id, "arbitrage_entry");
  assertExecutionPreflight(preflight);
  assert.equal(preflight.exactLegs.length, 2);
  assert.equal(preflight.mode, "arbitrage_entry");
  const receipt = await client.confirmExecution(preflight.challengeId);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.simulated, true);
  assert.match(receipt.message, /未发送任何真实订单/);
});

test("Binance credential validation returns masked read-only metadata and never returns the secret", async () => {
  const client = createFakeAutomationConsoleClient();
  const secret = "fixture-secret-value";
  const result = await client.validateCredential({ accountId: null, venue: "binance", note: "fixture", apiKey: "fixture-api-key-1234", secret, ipWhitelist: ["203.0.113.0/28"], defaultExecutionAccount: false, assetStatisticsEnabled: true });
  assert.match(result.maskedKey ?? "", /1234$/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.permissions.withdraw, false);
  assert.equal(result.enabled, false);
  assert.equal(result.status, "connected");
  assert.equal(result.canAuthorize, true);
  assert.equal(result.canExecute, false);
  assert.equal(result.accountMode, "single_asset_one_way");
});

test("missing IP is a warning, while withdraw permission remains a hard activation block", async () => {
  const client = createFakeAutomationConsoleClient();
  const withoutIp = await client.validateCredential({ accountId: null, venue: "bybit", note: "no ip", apiKey: "fixture-api-key-1234", secret: "fixture-secret-value", ipWhitelist: [], defaultExecutionAccount: false, assetStatisticsEnabled: true });
  assert.equal(withoutIp.verificationChecks.find((check) => check.id === "ip_bound")?.status, "warning");
  assert.equal(isCredentialActivationReady(withoutIp), true);

  const unsafeWithdraw = { ...withoutIp, permissions: { ...withoutIp.permissions, withdraw: true } };
  assert.equal(isCredentialActivationReady(unsafeWithdraw), false);
});

test("failed credential rotation does not replace the existing connection", async () => {
  const snapshot = createAutomationConsoleFixture();
  const existing = snapshot.credentials.find((credential) => credential.venue === "bybit");
  assert.ok(existing);
  const client = createFakeAutomationConsoleClient(snapshot);

  await assert.rejects(() => client.validateCredential({
    accountId: existing.accountId,
    venue: "bybit",
    note: "invalid rotation",
    apiKey: "short",
    secret: "short",
    ipWhitelist: ["203.0.113.0/28"],
    defaultExecutionAccount: false,
    assetStatisticsEnabled: false,
  }), (error: unknown) => {
    assert.equal(error instanceof AutomationConsoleContractError && error.status, 422);
    return true;
  });

  const afterFailure = (await client.load()).credentials.find((credential) => credential.venue === "bybit");
  assert.equal(afterFailure?.accountId, existing.accountId);
  assert.equal(afterFailure?.maskedKey, existing.maskedKey);
  assert.equal(afterFailure?.defaultExecutionAccount, existing.defaultExecutionAccount);
});

test("credential deletion is blocked by exposure and clears execution readiness after success", async () => {
  const blockedSnapshot = createAutomationConsoleFixture();
  const blocked = blockedSnapshot.credentials.find((credential) => credential.status !== "unconfigured");
  assert.ok(blocked);
  assert.ok(blocked.accountId);
  const blockedAccountId = blocked.accountId;
  blocked.openPositionCount = 1;
  const blockedClient = createFakeAutomationConsoleClient(blockedSnapshot);
  await assert.rejects(() => blockedClient.deleteCredential(blockedAccountId), (error: unknown) => {
    assert.equal(error instanceof AutomationConsoleContractError && error.status, 409);
    return true;
  });

  const removableSnapshot = createAutomationConsoleFixture();
  const removable = removableSnapshot.credentials.find((credential) => credential.status !== "unconfigured");
  assert.ok(removable);
  assert.ok(removable.accountId);
  removable.activeOrderCount = 0;
  removable.openPositionCount = 0;
  removableSnapshot.globalExecutionEnabled = true;
  removableSnapshot.strategyEnabled = true;
  const removableClient = createFakeAutomationConsoleClient(removableSnapshot);
  await removableClient.deleteCredential(removable.accountId);
  const afterDelete = await removableClient.load();
  const deleted = afterDelete.credentials.find((credential) => credential.venue === removable.venue);
  assert.equal(deleted?.status, "unconfigured");
  assert.equal(deleted?.maskedKey, null);
  assert.equal(deleted?.defaultExecutionAccount, false);
  assert.equal(afterDelete.globalExecutionEnabled, false);
  assert.equal(afterDelete.strategyEnabled, false);
});

test("parameter validation enforces server-provided ranges in the draft model", async () => {
  const snapshot = createAutomationConsoleFixture();
  const client = createFakeAutomationConsoleClient(snapshot);
  const draft = Object.fromEntries(snapshot.parameters.map((parameter) => [parameter.id, parameter.value]));
  await assert.doesNotReject(() => client.validateParameters(draft));
  draft["minimum-apr"] = 101;
  await assert.rejects(() => client.validateParameters(draft), (error: unknown) => {
    assert.equal(error instanceof AutomationConsoleContractError && error.status, 422);
    return true;
  });
});

test("user contract errors keep distinct 401, 403, 409, 422, 429 and 503 feedback", () => {
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(401, "session")).title, /登录/);
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(403, "forbidden")).title, /权限/);
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(409, "conflict")).title, /状态/);
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(422, "invalid")).title, /校验/);
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(429, "limited", 12)).message, /12 秒/);
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(503, "down")).title, /不可用/);
});

test("real user API client sends account-scoped writes without userId and keeps apiSecret write-only", async () => {
  const calls: CapturedRequest[] = [];
  const secret = "fixture-only-api-secret";
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    assert.equal(snapshot.source, "user_api");
    assert.equal(snapshot.credentials.find((item) => item.venue === "bitget")?.status, "not_implemented");
    assert.equal(snapshot.candidates[0].netApr, 0.125);
    assert.equal(snapshot.candidates[0].favorableDayRatio, 0.8);
    assert.equal(snapshot.candidates[0].safetyEligible, true);
    assert.deepEqual(snapshot.candidates[0].safetyDisqualifiers, []);

    const credential = await client.validateCredential({
      accountId: snapshot.credentials[0].accountId,
      venue: "bybit",
      note: "not-sent",
      apiKey: "fixture-api-key",
      secret,
      ipWhitelist: ["192.0.2.10"],
      defaultExecutionAccount: true,
      assetStatisticsEnabled: true,
    });
    assert.equal(JSON.stringify(credential).includes(secret), false);
    assert.equal("apiSecret" in credential, false);

    const preflight = await client.requestPreflight("opportunity-bybit-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    await client.confirmExecution(preflight.challengeId);
    await client.validateParameters(Object.fromEntries(snapshot.parameters.map((parameter) => [parameter.id, parameter.value])));
    await client.performSafetyAction({ type: "toggle_strategy", enabled: true });
    await client.performSafetyAction({ type: "kill_switch" });
    await client.closePosition("bybit:position-1");
    await client.performSafetyAction({ type: "close_all" });
    await client.deleteCredential("bybit:fixture-account");
  });

  for (const call of calls) {
    assert.equal(call.url.includes("userId"), false);
    assert.equal(JSON.stringify(call.body ?? {}).includes("userId"), false);
  }
  const credentialWrite = calls.find((call) => call.url.endsWith("/venues/bybit/credentials") && call.method === "PUT");
  assert.deepEqual(credentialWrite?.body, { apiKey: "fixture-api-key", apiSecret: secret });
  assert.equal(credentialWrite?.url.includes(secret), false);
  assert.equal(JSON.stringify(credentialWrite?.body).includes('"secret"'), false);
  const preflightWrite = calls.find((call) => call.url.endsWith("/preflight") && call.method === "POST");
  assert.equal(preflightWrite?.body?.mode, "arbitrage_entry");

  const configWrite = calls.find((call) => call.url.endsWith("/venues/bybit/config") && call.method === "PUT" && "maxUnhedgedMs" in (call.body ?? {}));
  assert.equal(configWrite?.body?.maxUnhedgedMs, 5_000);
  for (const call of calls.filter((item) => item.method !== "GET" && !item.url.endsWith("/venues/bybit/credentials"))) {
    assert.equal(call.body?.accountId, "bybit:fixture-account");
  }
});

test("real user API client sends manual_entry only for a safety-eligible candidate", async () => {
  const calls: CapturedRequest[] = [];
  const candidate = {
    ...eligibleOpportunity(),
    automationEligible: false,
    automationDisqualifiers: ["当前收益条件未达到自动策略要求"],
  };
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    assert.equal(snapshot.candidates[0].safetyEligible, true);
    assert.equal(snapshot.candidates[0].automationEligible, false);
    const preflight = await client.requestPreflight(candidate.id, "manual_entry");
    assertExecutionPreflight(preflight);
    assert.equal(preflight.mode, "manual_entry");
    assert.deepEqual(preflight.warnings, ["当前 Funding 不利", "当前净收益未达到自动策略条件", "基差超过自动策略范围"]);
    assert.ok(preflight.confirmations.includes("已阅读并接受上述手动决策风险"));
  }, undefined, undefined, candidate);

  const preflightWrite = calls.find((call) => call.url.endsWith("/preflight") && call.method === "POST");
  assert.equal(preflightWrite?.body?.mode, "manual_entry");
});

test("Binance maps to authorization plus Shadow checks while all provider writes stay disabled", async () => {
  const calls: CapturedRequest[] = [];
  const secret = "binance-fixture-secret";
  const candidate = binanceOpportunity();
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const snapshot = await client.load();
    const binance = snapshot.credentials.find((item) => item.venue === "binance");
    assert.ok(binance);
    assert.equal(binance.canAuthorize, true);
    assert.equal(binance.canRunReadOnlyPreflight, true);
    assert.equal(binance.canExecute, false);
    assert.equal(binance.phase, "phase_1_read_only_shadow");
    assert.equal(binance.permissions.spotAccount, true);
    assert.equal(binance.permissions.futuresAccount, true);
    assert.equal(binance.permissions.positionModeSupported, true);
    assert.equal(binance.productAvailability?.status, "available");

    const validated = await client.validateCredential({
      accountId: binance.accountId,
      venue: "binance",
      note: "not-sent",
      apiKey: "binance-fixture-key",
      secret,
      passphrase: "must-not-be-sent",
      ipWhitelist: [],
      defaultExecutionAccount: false,
      assetStatisticsEnabled: false,
    });
    assert.equal(validated.canExecute, false);
    assert.equal(JSON.stringify(validated).includes(secret), false);

    const result = await client.requestPreflight(candidate.id, "arbitrage_entry");
    assert.equal("kind" in result && result.kind, "shadow_check");
    if ("kind" in result) {
      assert.equal(result.marketChecksPassed, true);
      assert.equal(result.checks[0]?.id, "product_pair");
      assert.equal(result.productAvailability?.spotSymbol, "XAUTUSDT");
      assert.equal("challengeId" in result, false);
    }
    await assert.rejects(() => client.confirmExecution("binance-never-issued"), (error: unknown) => (
      error instanceof AutomationConsoleContractError && error.category === "challenge_invalid"
    ));
  }, undefined, undefined, candidate, {
    status: 409,
    body: binanceShadowError(),
  });

  const credentialWrite = calls.find((call) => call.url.endsWith("/venues/binance/credentials") && call.method === "PUT");
  assert.deepEqual(credentialWrite?.body, { apiKey: "binance-fixture-key", apiSecret: secret });
  assert.equal(credentialWrite?.url.includes(secret), false);
  assert.equal(calls.some((call) => call.url.endsWith("/execute")), false);
  assert.equal(calls.some((call) => call.url.endsWith("/close-all")), false);
});

test("Binance venue capability does not enable preflight for a candidate without adapter support", async () => {
  const calls: CapturedRequest[] = [];
  const unsupportedCandidate = {
    ...binanceOpportunity(),
    id: "opportunity-binance-paxg-unavailable",
    adapterImplemented: false,
    longLeg: { venue: "binance", symbol: "PAXGUSDT", asset: "PAXG", kind: "spot" },
    shortLeg: { venue: "binance", symbol: "PAXGUSDT", asset: "PAXG", kind: "perpetual" },
  } satisfies OpportunityFixture;

  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    const loaded = await client.load();
    const candidate = loaded.candidates.find((item) => item.id === unsupportedCandidate.id);
    assert.ok(candidate);
    assert.equal(candidate.adapterImplemented, false);
    assert.equal(candidate.canRunReadOnlyPreflight, false);
    assert.equal(candidate.canExecute, false);
    await assert.rejects(() => client.requestPreflight(candidate.id, "manual_entry"), (error: unknown) => (
      error instanceof AutomationConsoleContractError && error.category === "venue_not_implemented"
    ));
  }, undefined, undefined, unsupportedCandidate);

  assert.equal(calls.some((call) => call.url.endsWith("/preflight")), false);
});

test("Binance Shadow rejection exposes only whitelisted report fields and safe errors", async () => {
  const candidate = binanceOpportunity();
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const result = await client.requestPreflight(candidate.id, "manual_entry");
    assert.equal("kind" in result && result.kind, "shadow_check");
    if ("kind" in result) {
      assert.equal(result.marketChecksPassed, false);
      assert.equal(result.checks.some((check) => !check.passed), true);
      assert.equal(JSON.stringify(result).includes("server-private-field"), false);
      assert.equal(JSON.stringify(result).includes("userId"), false);
    }
  }, undefined, undefined, candidate, {
    status: 409,
    body: binanceShadowError(false),
  });

  const unsafeMessage = presentAutomationConsoleError(
    new AutomationConsoleContractError(400, "raw provider error with binance-fixture-secret", null, "provider_credential_invalid"),
  );
  assert.doesNotMatch(unsafeMessage.message, /binance-fixture-secret|raw provider/i);
  assert.match(presentAutomationConsoleError(new AutomationConsoleContractError(501, "writes off", null, "binance_provider_writes_disabled")).title, /未开放/);
});

test("unimplemented venues and server contract errors remain distinct", async () => {
  const calls: CapturedRequest[] = [];
  await withAutomationFetch(calls, async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    await assert.rejects(() => client.validateCredential({
      accountId: null,
      venue: "bitget",
      note: "",
      apiKey: "fixture-api-key",
      secret: "fixture-only-secret",
      ipWhitelist: [],
      defaultExecutionAccount: false,
      assetStatisticsEnabled: false,
    }), (error: unknown) => error instanceof AutomationConsoleContractError && error.status === 501 && error.category === "venue_not_implemented");
  });
  assert.equal(calls.some((call) => call.url.includes("/venues/bitget/credentials") && call.method === "PUT"), false);

  for (const response of [
    { status: 409, category: "account_mismatch" },
    { status: 422, category: "credential_invalid" },
    { status: 429, category: "rate_limited", retryAfter: "17" },
    { status: 503, category: "credential_store_unavailable" },
  ]) {
    await withAutomationFetch([], async () => {
      const client = createUserAutomationConsoleClient();
      await client.load();
      await assert.rejects(() => client.validateCredential({
        accountId: "bybit:fixture-account",
        venue: "bybit",
        note: "",
        apiKey: "fixture-api-key",
        secret: "fixture-only-secret",
        ipWhitelist: [],
        defaultExecutionAccount: false,
        assetStatisticsEnabled: false,
      }), (error: unknown) => {
        assert.equal(error instanceof AutomationConsoleContractError && error.status, response.status);
        assert.equal(error instanceof AutomationConsoleContractError && error.category, response.category);
        if (response.status === 409) assert.equal(isAccountMismatchError(error), true);
        if (response.status === 429) assert.equal(error instanceof AutomationConsoleContractError && error.retryAfterSeconds, 17);
        return true;
      });
    }, response);
  }
});

test("expired or repeated execution challenges fail closed after one server rejection", async () => {
  let executeCalls = 0;
  await withAutomationFetch([], async () => {
    const client = createUserAutomationConsoleClient();
    await client.load();
    const preflight = await client.requestPreflight("opportunity-bybit-xaut", "arbitrage_entry");
    assertExecutionPreflight(preflight);
    await assert.rejects(() => client.confirmExecution(preflight.challengeId), (error: unknown) => error instanceof AutomationConsoleContractError && error.category === "challenge_invalid");
    await assert.rejects(() => client.confirmExecution(preflight.challengeId), (error: unknown) => error instanceof AutomationConsoleContractError && error.category === "challenge_invalid");
  }, undefined, () => { executeCalls += 1; });
  assert.equal(executeCalls, 1);
});

type CapturedRequest = { url: string; method: string; body: Record<string, any> | null };
type OpportunityFixture = Omit<ReturnType<typeof eligibleOpportunity>, "automationDisqualifiers" | "safetyDisqualifiers"> & {
  automationDisqualifiers: string[];
  safetyDisqualifiers: string[];
};

async function withAutomationFetch(
  calls: CapturedRequest[],
  run: () => Promise<void>,
  credentialError?: { status: number; category: string; retryAfter?: string },
  onExecute?: () => void,
  opportunity: OpportunityFixture = eligibleOpportunity(),
  preflightResponse?: { status: number; body: unknown },
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : null;
    calls.push({ url, method, body });
    if (url.includes("/credentials") && method === "PUT" && credentialError) {
      return jsonResponse({ category: credentialError.category, message: "fixture contract error" }, credentialError.status, credentialError.retryAfter);
    }
    if (url.endsWith("/preflight") && method === "POST" && preflightResponse) {
      return jsonResponse(preflightResponse.body, preflightResponse.status);
    }
    if (url.endsWith("/execute") && method === "POST" && onExecute) {
      onExecute();
      return jsonResponse({ category: "challenge_invalid", message: "challenge 已过期或已使用。" }, 409);
    }
    return automationResponse(url, method, opportunity);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function automationResponse(url: string, method: string, opportunity: OpportunityFixture): Response {
  if (url.endsWith("/venues")) return jsonResponse(venueStatuses());
  if (url.endsWith("/opportunities")) return jsonResponse({ generatedAt: Date.now(), eligibleCount: opportunity.automationEligible ? 1 : 0, items: [opportunity] });
  if (url.endsWith("/positions")) return jsonResponse({ items: [fixturePosition()] });
  if (url.endsWith("/pnl")) return jsonResponse({ venues: [] });
  if (url.endsWith("/audit")) return jsonResponse({ venues: [] });
  if (url.endsWith("/venues/bybit/config") && method === "GET") return jsonResponse(fixtureConfig());
  if (url.endsWith("/venues/bybit/credentials") && method === "PUT") return jsonResponse(venueStatuses()[0]);
  if (url.endsWith("/venues/binance/credentials") && method === "PUT") return jsonResponse(venueStatuses()[2]);
  if (url.endsWith("/preflight")) return jsonResponse({ challengeId: "challenge-fixture", challengeToken: "one-time-fixture-token", expiresAt: Date.now() + 60_000, report: { quantityXaut: 0.002, totalBudgetUsd: 25, estimatedCapitalRequiredUsd: 25, referenceSpotAsk: 3_360, referencePerpetualBid: 3_361, warnings: ["当前 Funding 不利", "当前净收益未达到自动策略条件", "基差超过自动策略范围"] } });
  return jsonResponse({ ok: true, message: "fixture accepted" });
}

function venueStatuses() {
  return (["bybit", "bitget", "binance", "okx"] as const).map((venue) => ({
    venue,
    implemented: venue === "bybit" || venue === "binance",
    enabled: venue === "bybit",
    phase: venue === "bybit" ? "execution_capable" : venue === "binance" ? "phase_1_read_only_shadow" : undefined,
    providerWritesEnabled: venue === "bybit",
    productAvailability: venue === "binance" ? {
      available: true,
      status: "available",
      spotSymbol: "XAUTUSDT",
      perpetualSymbol: "XAUTUSDT",
      checkedAt: Date.now(),
      message: null,
    } : undefined,
    credential: venue === "bybit" ? {
      stored: true,
      accountId: "bybit:fixture-account",
      accountFingerprint: "fixture-fingerprint",
      masterKeyConfigured: true,
      maskedApiKey: "BYB••••TURE",
      connectionStatus: "verified",
      lifecycleStatus: "active",
      accountMode: "uta",
      permissions: { read: true, spotTrade: true, contractTrade: true, withdraw: false },
      lastVerifiedAt: Date.now(),
      message: null,
      ipWhitelistConfigured: false,
      warnings: ["未绑定 IP 白名单。"],
    } : venue === "binance" ? {
      stored: true,
      accountId: "binance:fixture-account",
      accountFingerprint: "binance-fixture-fingerprint",
      masterKeyConfigured: true,
      maskedApiKey: "BIN••••TURE",
      connectionStatus: "verified",
      lifecycleStatus: "active",
      accountMode: "single_asset_one_way",
      permissions: {
        read: true,
        spotTrade: true,
        contractTrade: true,
        withdraw: false,
        spotAccount: true,
        futuresAccount: true,
        positionModeSupported: true,
      },
      lastVerifiedAt: Date.now(),
      message: null,
      ipWhitelistConfigured: false,
      warnings: ["未绑定 IP 白名单。"],
    } : {
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
  }));
}

function fixtureConfig() {
  return { accountId: "bybit:fixture-account", defaultAccountId: "bybit:fixture-account", globalExecutionEnabled: false, strategyEnabled: false, killSwitchActive: true, serverGlobalKillSwitchActive: false, maxStrategyCapitalUsd: 100, maxEntryBasisBps: 18, maxCombinedSlippageBps: 12, minNetAprPercent: 8, minLiquidationDistancePercent: 40, maxUnhedgedMs: 5_000 };
}

function eligibleOpportunity() {
  return { id: "opportunity-bybit-xaut", venue: "bybit", adapterImplemented: true, safetyEligible: true, safetyDisqualifiers: [], automationEligible: true, automationDisqualifiers: [], netApr: 12.5, persistenceRatio: 0.8, entryBasisBps: null, longLeg: { venue: "bybit", symbol: "XAUTUSDT", asset: "XAUT", kind: "spot" }, shortLeg: { venue: "bybit", symbol: "XAUTUSDT", asset: "XAUT", kind: "perpetual" } };
}

function binanceOpportunity(): OpportunityFixture {
  return {
    id: "opportunity-binance-xaut",
    venue: "binance",
    adapterImplemented: true,
    safetyEligible: true,
    safetyDisqualifiers: [],
    automationEligible: true,
    automationDisqualifiers: [],
    netApr: 9.2,
    persistenceRatio: 0.76,
    entryBasisBps: null,
    longLeg: { venue: "binance", symbol: "XAUTUSDT", asset: "XAUT", kind: "spot" },
    shortLeg: { venue: "binance", symbol: "XAUTUSDT", asset: "XAUT", kind: "perpetual" },
  };
}

function binanceShadowError(passed = true) {
  return {
    category: passed ? "binance_provider_writes_disabled" : "preflight_rejected",
    message: passed ? "Binance 第一阶段只完成 Shadow/preflight。" : "Binance Shadow/preflight 未通过。",
    report: {
      userId: "must-not-reach-ui",
      accountId: "must-not-be-copied-from-report",
      accountFingerprint: "server-private-field",
      venue: "binance",
      phase: "phase_1_read_only_shadow",
      providerWritesEnabled: false,
      productAvailability: {
        available: true,
        status: "available",
        spotSymbol: "XAUTUSDT",
        perpetualSymbol: "XAUTUSDT",
        checkedAt: Date.now(),
        message: null,
      },
      quantityXaut: 0.002,
      totalBudgetUsd: 25,
      estimatedCapitalRequiredUsd: 13.5,
      estimatedSpotNotionalUsd: 6.7,
      estimatedPerpetualNotionalUsd: 6.7,
      referenceSpotAsk: 3_360,
      referencePerpetualBid: 3_361,
      entryBasisBps: 2.9,
      fundingRate: 0.0001,
      estimatedNetAprPercent: 8.6,
      checks: [
        { id: "product_pair", passed: true, actual: true, expected: true, message: "XAUTUSDT 双腿必须可用。" },
        { id: "position_mode", passed, actual: passed, expected: true, message: "第一阶段只接受 one-way 持仓模式。" },
      ],
      warnings: ["未绑定固定 IP 白名单。"],
      marketChecksPassed: passed,
      generatedAt: Date.now(),
      message: passed ? "市场检查通过，但不签发 challenge。" : "市场或账户检查未通过。",
      unknownPrivateValue: "server-private-field",
    },
  };
}

function assertExecutionPreflight(result: AutomationPreflightResult): asserts result is AutomationPreflight {
  assert.equal("kind" in result, false, "expected an execution challenge, received a Shadow report");
}

function fixturePosition() {
  return { positionId: "bybit:position-1", accountId: "bybit:fixture-account", venue: "bybit", strategyId: "bybit-xaut-spot-perp-v1", capturedAt: Date.now(), legs: { spot: { quantityXaut: 0.002, averageEntryPrice: 3_360, markPrice: 3_361, notionalUsd: 6.72 }, perpetual: { quantityXaut: 0.002, averageEntryPrice: 3_361, markPrice: 3_360, notionalUsd: 6.72 } }, netDeltaUsd: 0, currentBasisBps: 3, realizedPnlUsd: 0, unrealizedPnlUsd: 0.004, fundingPnlUsd: 0, feesUsd: 0.01, slippageUsd: 0.01, netPnlUsd: -0.016 };
}

function jsonResponse(body: unknown, status = 200, retryAfter?: string) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) } });
}
