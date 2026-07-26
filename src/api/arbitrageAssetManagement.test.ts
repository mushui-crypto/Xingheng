import assert from "node:assert/strict";
import test from "node:test";
import {
  assetAuthorizationCreateIntent,
  assetAuthorizationRevokeIntent,
  assetTakeoverStartIntent,
  createAssetManagementClient,
} from "./arbitrageAssetManagement";
import { createFakeAssetManagementClient } from "./arbitrageAssetManagement.fake";
import { canonicalRequestDigest } from "./stepUpSecurity";

test("asset step-up intents bind opaque previews and omit client account identity", async () => {
  const preview = { previewId: "opaque-preview", maxManagedNotionalUsd: 2000 };
  const create = await assetAuthorizationCreateIntent("binance", preview);
  assert.equal(create.operation, "asset_authorization_create");
  assert.equal(create.resourceId, "xaut");
  assert.equal("accountId" in create, false);
  assert.equal(create.authorizationPreview, preview);
  assert.equal(create.requestDigest, await canonicalRequestDigest({ assetId: "xaut", preview }));

  const revoke = await assetAuthorizationRevokeIntent("binance");
  assert.equal(revoke.operation, "asset_authorization_revoke");
  assert.equal("accountId" in revoke, false);
  assert.equal("authorizationPreview" in revoke, false);
  assert.equal(revoke.requestDigest, await canonicalRequestDigest({ assetId: "xaut" }));

  const takeover = await assetTakeoverStartIntent("binance", preview);
  assert.equal(takeover.operation, "asset_takeover_start");
  assert.equal("accountId" in takeover, false);
  assert.equal(takeover.takeoverPreview, preview);
  assert.equal(takeover.requestDigest, await canonicalRequestDigest({ assetId: "xaut", preview }));
});

test("asset API uses strict XAUT paths, bodies, no-store and keeps opaque fields out of UI models", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; cache?: RequestCache }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, cache: init?.cache });
    return Response.json(responseFor(url, method));
  };
  try {
    const client = createAssetManagementClient();
    const authorization = await client.getAuthorization("binance");
    assert.ok(authorization);
    assert.equal("accountFingerprint" in authorization, false);
    assert.equal("authorizationId" in authorization, false);
    assert.equal("policyDigest" in authorization, false);

    const authorizationPreview = await client.previewAuthorization("binance");
    assert.equal("accountFingerprint" in authorizationPreview.view, false);
    assert.equal("previewDigest" in authorizationPreview.view, false);
    assert.equal(authorizationPreview.opaque.accountFingerprint, "internal-fingerprint");
    await client.createAuthorization("binance", authorizationPreview.opaque, "step-up-create");
    await client.revokeAuthorization("binance", "step-up-revoke");

    const takeoverPreview = await client.previewTakeover("binance", { newCapitalUsd: 100, leverage: 2 });
    assert.equal("accountFingerprint" in takeoverPreview.view, false);
    assert.equal("previewId" in takeoverPreview.view, false);
    const started = await client.startTakeover("binance", takeoverPreview.opaque, "step-up-start", "stable-start-key");
    assert.equal(started.takeover.takeoverId, "takeover-fixture");
    assert.equal("userId" in started.takeover, false);
    assert.equal("idempotencyKey" in started.takeover, false);
    assert.ok(started.reconfirmation);
    await client.reconfirmTakeover("binance", started.takeover.takeoverId, started.reconfirmation.opaque);
    await client.getTakeoverStatus("binance", started.takeover.takeoverId);
    const discovered = await client.getCurrentTakeover("binance");
    assert.ok(discovered);
    assert.equal(discovered.requiresReconfirmation, true);
    assert.equal("profileId" in discovered, false);
    assert.equal("authorizationId" in discovered, false);
    assert.equal("providerAcceptedOrderCount" in discovered, false);
    const aborted = await client.abortTakeover("binance", discovered.takeoverId);
    assert.equal(aborted.state, "manual_intervention");

    const exit = await client.previewExit("binance", started.takeover.takeoverId);
    await client.confirmExit("binance", started.takeover.takeoverId, exit.opaque, "stable-exit-key");
    await client.getExitStatus("binance", started.takeover.takeoverId);

    assert.equal(calls.length, 13);
    assert.ok(calls.every((call) => call.url.includes("/assets/xaut/")));
    assert.ok(calls.every((call) => !call.url.includes("userId")));
    assert.ok(calls.every((call) => call.cache === "no-store"));
    assert.deepEqual(calls[1]?.body, {});
    assert.deepEqual(Object.keys(calls[2]?.body ?? {}).sort(), ["preview", "stepUpToken"]);
    assert.deepEqual(calls[3]?.body, { stepUpToken: "step-up-revoke" });
    assert.deepEqual(calls[4]?.body, { newCapitalUsd: 100, leverage: 2 });
    assert.deepEqual(Object.keys(calls[5]?.body ?? {}).sort(), ["idempotencyKey", "preview", "stepUpToken"]);
    assert.deepEqual(calls[6]?.body, { preview: started.reconfirmation?.opaque });
    assert.equal(calls[8]?.method, "GET");
    assert.equal(calls[8]?.body, null);
    assert.match(calls[8]?.url ?? "", /\/takeover\/current$/);
    assert.equal(calls[9]?.method, "POST");
    assert.deepEqual(calls[9]?.body, {});
    assert.match(calls[9]?.url ?? "", /\/takeover\/takeover-fixture\/abort$/);
    assert.deepEqual(calls[10]?.body, {});
    assert.deepEqual(Object.keys(calls[11]?.body ?? {}).sort(), ["idempotencyKey", "preview"]);
    assert.ok(calls.every((call) => !("userId" in (call.body ?? {}))));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit fake covers authorization, calculator, takeover monitor and ordinary exit without HTTP", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected HTTP"); };
  try {
    const client = createFakeAssetManagementClient();
    const authPreview = await client.previewAuthorization("binance");
    const auth = await client.createAuthorization("binance", authPreview.opaque, "fixture-step-up");
    assert.equal(auth.active, true);
    const preview = await client.previewTakeover("binance", { newCapitalUsd: 100, leverage: 2 });
    assert.equal(preview.view.totalManagedCapitalUsd, 200);
    assert.equal(preview.view.recommendedLeverage, 2);
    const start = await client.startTakeover("binance", preview.opaque, "fixture-step-up", "stable-start-key");
    assert.equal(start.takeover.runtime?.phase, "monitoring");
    const discovered = await client.getCurrentTakeover("binance");
    assert.equal(discovered?.takeoverId, start.takeover.takeoverId);
    const exit = await client.previewExit("binance", start.takeover.takeoverId);
    const exited = await client.confirmExit("binance", start.takeover.takeoverId, exit.opaque, "stable-exit-key");
    assert.equal(exited.runtime?.phase, "exited");
    assert.equal(exited.runtime?.residualPerpetualQuantity, 0);
    assert.equal(await client.getCurrentTakeover("binance"), null);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("current takeover discovery accepts null without adding client identity", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json(null);
  };
  try {
    const current = await createAssetManagementClient().getCurrentTakeover("binance");
    assert.equal(current, null);
    assert.match(requestedUrl, /\/venues\/binance\/assets\/xaut\/takeover\/current$/);
    assert.equal(requestedUrl.includes("?"), false);
    assert.equal(requestedInit?.body, undefined);
    assert.equal(requestedInit?.cache, "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function responseFor(url: string, method: string): unknown {
  if (url.endsWith("/authorization") && method === "GET") return authorizationRecord();
  if (url.endsWith("/authorization/preview")) return authorizationPreview();
  if (url.endsWith("/authorization") && method === "PUT") return authorizationRecord();
  if (url.endsWith("/authorization") && method === "DELETE") return { ok: true };
  if (url.endsWith("/takeover/preview")) return takeoverPreview();
  if (url.endsWith("/takeover/start")) return { ...takeoverRecord(), reconfirmationPreview: takeoverPreview() };
  if (url.endsWith("/reconfirm")) return takeoverRecord();
  if (url.endsWith("/takeover/current")) return takeoverDiscovery();
  if (url.endsWith("/abort")) return { ...takeoverDiscovery(), state: "manual_intervention", requiresReconfirmation: false };
  if (url.endsWith("/status")) return takeoverRecord();
  if (url.endsWith("/exit/preview")) return exitPreview();
  if (url.endsWith("/exit/confirm")) return takeoverRecord();
  throw new Error(`unexpected fixture request: ${method} ${url}`);
}

function authorizationRecord() {
  return {
    authorizationId: "internal-authorization", accountFingerprint: "internal-fingerprint",
    venue: "binance", assetId: "xaut", profileId: "internal-profile", policyVersion: "v1",
    policyDigest: "internal-policy", previewDigest: "internal-preview", spotQuantity: 0.02,
    spotAvailableQuantity: 0.02, spotLockedQuantity: 0, perpetualQuantity: 0.01,
    perpetualSide: "short", spotOrderCount: 1, perpetualOrderCount: 1,
    ordersDigest: "internal-orders", maxManagedSpotQuantity: 0.02,
    maxManagedPerpetualQuantity: 0.01, maxManagedNotionalUsd: 100, previewedAt: 1,
    createdAt: 1, revokedAt: null,
  };
}

function authorizationPreview() {
  return {
    previewId: "authorization-preview", venue: "binance", assetId: "xaut",
    profileId: "internal-profile", policyVersion: "v1", policyDigest: "internal-policy",
    notice: "仅授权管理 XAUT。", accountFingerprint: "internal-fingerprint",
    spotQuantity: 0.02, spotAvailableQuantity: 0.02, spotLockedQuantity: 0,
    perpetualQuantity: 0.01, perpetualSide: "short", spotOrderCount: 1,
    perpetualOrderCount: 1, ordersDigest: "internal-orders", maxManagedSpotQuantity: 0.02,
    maxManagedPerpetualQuantity: 0.01, maxManagedNotionalUsd: 100,
    stateDigest: "internal-state", generatedAt: 1, expiresAt: 121_000,
    previewDigest: "internal-preview",
  };
}

function takeoverPreview() {
  const plan = {
    feasible: true, estimatedLiquidationPrice: 5000, liquidationDistancePercent: 40,
    reserveUsd: 50, estimatedFeesUsd: 1, estimatedSlippageUsd: 1,
    requiredAvailableCapitalUsd: 150, currentFundingAprPercent: 8,
    median30dFundingAprPercent: 7, adverseFundingAprPercent: -2,
    currentEstimatedAnnualFundingUsd: 16, median30dEstimatedAnnualFundingUsd: 14,
    adverseEstimatedAnnualFundingUsd: -4, currentReturnOnNewCapitalPercent: 16,
    currentReturnOnTotalManagedPercent: 8,
  };
  return {
    previewId: "takeover-preview", venue: "binance", assetId: "xaut",
    profileId: "internal-profile", authorizationId: "internal-auth", authorizationCreatedAt: 1,
    policyVersion: "v1", policyDigest: "internal-policy", accountFingerprint: "internal-fingerprint",
    newCapitalUsd: 100, totalManagedCapitalUsd: 200, existingManagedCapitalUsd: 100,
    selectedLeverage: 2, recommendedLeverage: 2, spotQuantity: 0.02,
    spotAvailableQuantity: 0.02, spotLockedQuantity: 0, spotValueUsd: 68,
    referenceSpotAsk: 3400, perpetualQuantity: 0.01, perpetualSide: "short",
    perpetualNotionalUsd: 34, referencePerpetualBid: 3400, perpetualInitialMarginUsd: 17,
    perpetualLeverage: 2, targetHedgedQuantity: 0.02, missingSpotQuantity: 0,
    missingPerpetualQuantity: 0.01, residualQuantity: 0, ordersDigest: "internal-orders",
    spotOrderCount: 1, perpetualOrderCount: 1, currentFundingRate: 0.0001,
    median30dFundingRate: 0.00009, adverseFundingRate: -0.00002, maxSlippageBps: 15,
    reserveRatio: 0.25, leveragePlans: [{ ...plan, leverage: 1 }, { ...plan, leverage: 2 }, { ...plan, leverage: 3 }],
    stateDigest: "internal-state", generatedAt: 1, expiresAt: 30_001, previewDigest: "internal-preview",
  };
}

function takeoverRecord() {
  return {
    takeoverId: "takeover-fixture", userId: "internal-user", venue: "binance", assetId: "xaut",
    profileId: "internal-profile", authorizationId: "internal-auth", authorizationCreatedAt: 1,
    policyVersion: "v1", policyDigest: "internal-policy", idempotencyKey: "internal-key",
    previewDigest: "internal-preview", newCapitalUsd: 100, totalManagedCapitalUsd: 200,
    reservedCapitalUsd: 200, leverage: 2, state: "managed", targetHedgedQuantity: 0.02,
    finalSpotQuantity: 0.02, finalPerpetualQuantity: 0.02, residualQuantity: 0,
    errorCategory: null, message: "运行中。", createdAt: 1, updatedAt: 1,
    providerAcceptedOrderCount: 2, cancelledOrderCount: 2, spotOrderCount: 1,
    perpetualOrderCount: 1, runtime: null,
  };
}

function takeoverDiscovery() {
  return {
    takeoverId: "takeover-fixture", venue: "binance", assetId: "xaut",
    profileId: "internal-profile", authorizationId: "internal-auth",
    state: "awaiting_reconfirm", newCapitalUsd: 100, totalManagedCapitalUsd: 200,
    reservedCapitalUsd: 200, leverage: 2, targetHedgedQuantity: 0.02,
    finalSpotQuantity: 0.02, finalPerpetualQuantity: 0.02, residualQuantity: 0,
    errorCategory: null, message: "等待最新状态确认。", createdAt: 1, updatedAt: 1,
    runtime: null, requiresReconfirmation: true,
  };
}

function exitPreview() {
  return {
    previewId: "exit-preview", takeoverId: "takeover-fixture", venue: "binance",
    assetId: "xaut", profileId: "internal-profile", authorizationId: "internal-auth",
    authorizationCreatedAt: 1, spotQuantity: 0.02, spotAvailableQuantity: 0.02,
    spotLockedQuantity: 0, perpetualQuantity: 0.02, perpetualSide: "short",
    ordersDigest: "internal-orders", normalSlippageBps: 15,
    emergencySlippageBps: [15, 30, 50], generatedAt: 1, expiresAt: 30_001,
    previewDigest: "internal-preview",
  };
}
