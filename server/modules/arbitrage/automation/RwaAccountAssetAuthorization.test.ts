import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertAccountAssetAuthorizationPreview,
  createAccountAssetAuthorization,
  createAccountAssetAuthorizationPreview,
  publicAccountAssetAuthorization,
  RwaAccountAssetAuthorizationError,
  validateAccountAssetAuthorization,
  validateAccountAssetAuthorizationPreview,
} from "./RwaAccountAssetAuthorization";
import {
  requireRwaAutomationExecutionProfile,
  RwaAutomationAssetProfileError,
} from "./RwaAutomationAssetProfile";
import type { RwaProviderPreflightSnapshot } from "./RwaNeutralExecutionTypes";

const now = 1_800_000_000_000;
const profile = requireRwaAutomationExecutionProfile("xaut", "bybit");

test("authorization preview binds exact account asset policy quantities orders and bounds", () => {
  const preview = createAccountAssetAuthorizationPreview({
    profile,
    snapshot: snapshot(),
    orders: [
      { category: "linear", orderId: "perp-1", clientOrderId: "manual-2", symbol: "XAUTUSDT" },
      { category: "spot", orderId: "spot-1", clientOrderId: "manual-1", symbol: "XAUTUSDT" },
    ],
    now,
  });
  assert.equal(validateAccountAssetAuthorizationPreview(preview), preview);
  assert.equal(preview.spotQuantity, 0.3);
  assert.equal(preview.spotAvailableQuantity, 0.2);
  assert.equal(preview.spotLockedQuantity, 0.1);
  assert.equal(preview.perpetualQuantity, 0.25);
  assert.equal(preview.perpetualSide, "short");
  assert.equal(preview.spotOrderCount, 1);
  assert.equal(preview.perpetualOrderCount, 1);
  assert.equal(preview.maxManagedNotionalUsd, 2_310);
  assert.match(preview.notice, /全部 XAUT/);
  assert.match(preview.notice, /不会立即下单、撤单或接管/);
});

test("preview tampering expiry and provider state changes fail closed", () => {
  const original = preview();
  assert.throws(
    () => validateAccountAssetAuthorizationPreview({ ...original, spotQuantity: 9 }),
    authorizationError("asset_authorization_preview_invalid"),
  );
  const { previewDigest: _previewDigest, ...extendedPayload } = {
    ...original,
    expiresAt: original.expiresAt + 1,
  };
  assert.throws(
    () => validateAccountAssetAuthorizationPreview({
      ...extendedPayload,
      previewDigest: createHash("sha256").update(JSON.stringify(extendedPayload)).digest("hex"),
    }),
    authorizationError("asset_authorization_preview_invalid"),
  );
  assert.throws(
    () => assertAccountAssetAuthorizationPreview({
      provided: original,
      current: preview({ spotAvailableQuantityXaut: 0.19, existingSpotQuantityXaut: 0.29 }),
      now: now + 1,
    }),
    authorizationError("asset_authorization_preview_changed"),
  );
  assert.throws(
    () => assertAccountAssetAuthorizationPreview({
      provided: original,
      current: original,
      now: original.expiresAt,
    }),
    authorizationError("asset_authorization_preview_changed"),
  );
});

test("stored authorization is exact bound and public form excludes raw ownership identifiers", () => {
  const authorization = createAccountAssetAuthorization({
    userDomain: "0123456789abcdef",
    venue: "bybit",
    accountId: "provider-account-id",
    accountFingerprint: "account-fingerprint",
    assetId: "xaut",
    preview: preview(),
    now: now + 10,
  });
  assert.equal(validateAccountAssetAuthorization(authorization), authorization);
  const publicValue = publicAccountAssetAuthorization(authorization);
  assert.equal("accountId" in publicValue, false);
  assert.equal("userDomain" in publicValue, false);
  assert.equal(publicValue.assetId, "xaut");
  assert.throws(
    () => validateAccountAssetAuthorization({ ...authorization, policyDigest: "0".repeat(64) }),
    authorizationError("asset_authorization_invalid"),
  );
  const { profileId: _profileId, ...partial } = authorization;
  assert.throws(
    () => validateAccountAssetAuthorization(partial),
    authorizationError("asset_authorization_invalid"),
  );
});

test("reserved and unknown assets cannot create an authorization profile", () => {
  for (const assetId of ["btc", "eth", "sol", "unknown"]) {
    assert.throws(
      () => requireRwaAutomationExecutionProfile(assetId, "bybit"),
      (error: unknown) => error instanceof RwaAutomationAssetProfileError
        && ["asset_profile_disabled", "asset_profile_unknown"].includes(error.category),
    );
  }
});

function preview(overrides: Partial<RwaProviderPreflightSnapshot> = {}) {
  return createAccountAssetAuthorizationPreview({
    profile,
    snapshot: snapshot(overrides),
    orders: [
      { category: "spot", orderId: "spot-1", clientOrderId: "manual-1", symbol: "XAUTUSDT" },
      { category: "linear", orderId: "perp-1", clientOrderId: "manual-2", symbol: "XAUTUSDT" },
    ],
    now,
  });
}

function snapshot(overrides: Partial<RwaProviderPreflightSnapshot> = {}): RwaProviderPreflightSnapshot {
  return {
    accountId: "provider-account-id",
    accountFingerprint: "account-fingerprint",
    fetchedAt: now,
    accountMode: "uta",
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      ipRestricted: true,
      uta: true,
      ownerSubaccount: true,
    },
    availableUsdt: 5_000,
    existingSpotQuantityXaut: 0.3,
    spotAvailableQuantityXaut: 0.2,
    spotLockedQuantityXaut: 0.1,
    existingPerpetualQuantityXaut: 0.25,
    perpetualPositionSide: "short",
    openSpotOrderCount: 1,
    openPerpetualOrderCount: 1,
    spot: {
      status: "Trading",
      minOrderQty: 0.00001,
      qtyStep: 0.00001,
      minNotionalUsd: 5,
      priceTick: 0.01,
      bid: 4_199,
      ask: 4_200,
    },
    perpetual: {
      status: "Trading",
      minOrderQty: 0.001,
      qtyStep: 0.001,
      minNotionalUsd: 5,
      priceTick: 0.01,
      bid: 4_199,
      ask: 4_200,
      mark: 4_199.5,
      fundingRate: 0.0001,
      fundingIntervalHours: 8,
      liquidationDistancePercent: null,
    },
    fees: { spotTakerBps: 10, perpetualTakerBps: 10 },
    ...overrides,
  };
}

function authorizationError(category: string) {
  return (error: unknown) => error instanceof RwaAccountAssetAuthorizationError
    && error.category === category;
}
