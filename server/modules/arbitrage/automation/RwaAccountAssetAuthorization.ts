import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  assertRwaAutomationInstrumentRules,
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
  type RwaAutomationAssetId,
  type RwaAutomationResolvedAssetProfile,
} from "./RwaAutomationAssetProfile";
import type {
  RwaProviderPreflightSnapshot,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";
import type { RwaAutomationVenue } from "./RwaAutomationTypes";

export const RWA_ASSET_AUTHORIZATION_PREVIEW_TTL_MS = 120_000;
export const RWA_MAX_ASSET_AUTHORIZATIONS_PER_STATE = 16;

export type RwaAssetOrderReference = {
  category: "spot" | "linear";
  orderId: string;
  clientOrderId: string;
  symbol: string;
};

export type RwaAccountAssetAuthorizationPreview = {
  previewId: string;
  venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
  assetId: RwaAutomationAssetId;
  profileId: string;
  policyVersion: string;
  policyDigest: string;
  notice: string;
  accountFingerprint: string;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  perpetualQuantity: number;
  perpetualSide: "long" | "short" | "flat";
  spotOrderCount: number;
  perpetualOrderCount: number;
  ordersDigest: string;
  maxManagedSpotQuantity: number;
  maxManagedPerpetualQuantity: number;
  maxManagedNotionalUsd: number;
  stateDigest: string;
  generatedAt: number;
  expiresAt: number;
  previewDigest: string;
};

export type RwaAccountAssetAuthorization = {
  authorizationId: string;
  userDomain: string;
  venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
  accountId: string;
  accountFingerprint: string;
  assetId: RwaAutomationAssetId;
  profileId: string;
  policyVersion: string;
  policyDigest: string;
  previewDigest: string;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  perpetualQuantity: number;
  perpetualSide: "long" | "short" | "flat";
  spotOrderCount: number;
  perpetualOrderCount: number;
  ordersDigest: string;
  maxManagedSpotQuantity: number;
  maxManagedPerpetualQuantity: number;
  maxManagedNotionalUsd: number;
  previewedAt: number;
  createdAt: number;
  revokedAt: number | null;
};

export type RwaPublicAccountAssetAuthorization = Omit<
  RwaAccountAssetAuthorization,
  "accountId" | "userDomain"
>;

export class RwaAccountAssetAuthorizationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly category:
      | "asset_authorization_required"
      | "asset_authorization_invalid"
      | "asset_authorization_preview_invalid"
      | "asset_authorization_preview_changed",
    message: string,
  ) {
    super(message);
  }
}

export function createAccountAssetAuthorizationPreview<
  TPermissions extends RwaVenuePermissions,
>(input: {
  profile: RwaAutomationResolvedAssetProfile;
  snapshot: RwaProviderPreflightSnapshot<TPermissions>;
  orders: readonly RwaAssetOrderReference[];
  now: number;
}) {
  assertSnapshotAndOrders(input.profile, input.snapshot, input.orders);
  const state = {
    venue: input.profile.venue.venue,
    assetId: input.profile.asset.assetId,
    profileId: rwaAutomationProfileId(input.profile),
    policyVersion: input.profile.asset.authorizationPolicy.version,
    policyDigest: input.profile.asset.authorizationPolicy.digest,
    notice: input.profile.asset.authorizationPolicy.notice,
    accountFingerprint: input.snapshot.accountFingerprint,
    spotQuantity: input.snapshot.existingSpotQuantityXaut,
    spotAvailableQuantity: input.snapshot.spotAvailableQuantityXaut,
    spotLockedQuantity: input.snapshot.spotLockedQuantityXaut,
    perpetualQuantity: input.snapshot.existingPerpetualQuantityXaut,
    perpetualSide: input.snapshot.perpetualPositionSide,
    spotOrderCount: input.orders.filter((order) => order.category === "spot").length,
    perpetualOrderCount: input.orders.filter((order) => order.category === "linear").length,
    ordersDigest: assetOrdersDigest(input.orders),
    maxManagedSpotQuantity: input.snapshot.existingSpotQuantityXaut,
    maxManagedPerpetualQuantity: input.snapshot.existingPerpetualQuantityXaut,
    maxManagedNotionalUsd:
      input.snapshot.existingSpotQuantityXaut * input.snapshot.spot.ask
      + input.snapshot.existingPerpetualQuantityXaut * input.snapshot.perpetual.ask,
  };
  const generatedAt = input.now;
  const payload = {
    ...state,
    stateDigest: digest(state),
    generatedAt,
    expiresAt: generatedAt + RWA_ASSET_AUTHORIZATION_PREVIEW_TTL_MS,
  };
  const previewId = randomBytes(32).toString("hex");
  const previewDigest = digest({ previewId, ...payload });
  return {
    previewId,
    ...payload,
    previewDigest,
  } satisfies RwaAccountAssetAuthorizationPreview;
}

export function validateAccountAssetAuthorizationPreview(
  value: unknown,
): RwaAccountAssetAuthorizationPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPreview();
  const preview = value as Record<string, unknown>;
  const keys = [
    "accountFingerprint", "assetId", "expiresAt", "generatedAt", "maxManagedNotionalUsd",
    "maxManagedPerpetualQuantity", "maxManagedSpotQuantity", "notice", "ordersDigest",
    "perpetualOrderCount", "perpetualQuantity", "perpetualSide", "policyDigest",
    "policyVersion", "previewDigest", "previewId", "profileId", "spotAvailableQuantity",
    "spotLockedQuantity", "spotOrderCount", "spotQuantity", "stateDigest", "venue",
  ];
  if (
    Object.keys(preview).sort().join(",") !== keys.sort().join(",")
    || !["binance", "bybit"].includes(String(preview.venue))
    || typeof preview.assetId !== "string"
    || typeof preview.profileId !== "string"
    || typeof preview.policyVersion !== "string"
    || typeof preview.notice !== "string" || !preview.notice
    || typeof preview.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(preview.policyDigest)
    || typeof preview.accountFingerprint !== "string" || !preview.accountFingerprint
    || typeof preview.ordersDigest !== "string" || !/^[a-f0-9]{64}$/.test(preview.ordersDigest)
    || typeof preview.stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(preview.stateDigest)
    || typeof preview.previewId !== "string" || !/^[a-f0-9]{64}$/.test(preview.previewId)
    || typeof preview.previewDigest !== "string" || !/^[a-f0-9]{64}$/.test(preview.previewDigest)
    || !["long", "short", "flat"].includes(String(preview.perpetualSide))
    || !numbersValid(preview, previewNumberKeys)
  ) throw invalidPreview();
  const typed = preview as RwaAccountAssetAuthorizationPreview;
  if (
    !Number.isInteger(typed.generatedAt)
    || !Number.isInteger(typed.expiresAt)
    || typed.expiresAt !== typed.generatedAt + RWA_ASSET_AUTHORIZATION_PREVIEW_TTL_MS
    || typed.stateDigest !== digest(previewState(typed))
    || typed.previewDigest !== digestPreview(typed)
  ) throw invalidPreview();
  return typed;
}

export function assertAccountAssetAuthorizationPreview(input: {
  provided: RwaAccountAssetAuthorizationPreview;
  current: RwaAccountAssetAuthorizationPreview;
  now: number;
}) {
  const provided = validateAccountAssetAuthorizationPreview(input.provided);
  const current = validateAccountAssetAuthorizationPreview(input.current);
  if (
    provided.expiresAt <= input.now
    || provided.venue !== current.venue
    || provided.assetId !== current.assetId
    || provided.profileId !== current.profileId
    || provided.policyVersion !== current.policyVersion
    || provided.policyDigest !== current.policyDigest
    || provided.accountFingerprint !== current.accountFingerprint
    || provided.stateDigest !== current.stateDigest
  ) {
    throw new RwaAccountAssetAuthorizationError(
      409,
      "asset_authorization_preview_changed",
      "账户资产状态已变化，请重新获取授权预览并再次完成二次验证。",
    );
  }
}

export function createAccountAssetAuthorization(input: {
  userDomain: string;
  venue: "binance" | "bybit";
  accountId: string;
  accountFingerprint: string;
  assetId: string;
  preview: RwaAccountAssetAuthorizationPreview;
  now: number;
}) {
  const profile = requireRwaAutomationExecutionProfile(input.assetId, input.venue);
  const preview = validateAccountAssetAuthorizationPreview(input.preview);
  if (
    preview.venue !== input.venue
    || preview.assetId !== profile.asset.assetId
    || preview.profileId !== rwaAutomationProfileId(profile)
    || preview.policyVersion !== profile.asset.authorizationPolicy.version
    || preview.policyDigest !== profile.asset.authorizationPolicy.digest
    || preview.notice !== profile.asset.authorizationPolicy.notice
    || preview.accountFingerprint !== input.accountFingerprint
  ) throw invalidPreview();
  return {
    authorizationId: randomUUID(),
    userDomain: input.userDomain,
    venue: input.venue,
    accountId: input.accountId,
    accountFingerprint: input.accountFingerprint,
    assetId: profile.asset.assetId,
    profileId: rwaAutomationProfileId(profile),
    policyVersion: profile.asset.authorizationPolicy.version,
    policyDigest: profile.asset.authorizationPolicy.digest,
    previewDigest: preview.previewDigest,
    spotQuantity: preview.spotQuantity,
    spotAvailableQuantity: preview.spotAvailableQuantity,
    spotLockedQuantity: preview.spotLockedQuantity,
    perpetualQuantity: preview.perpetualQuantity,
    perpetualSide: preview.perpetualSide,
    spotOrderCount: preview.spotOrderCount,
    perpetualOrderCount: preview.perpetualOrderCount,
    ordersDigest: preview.ordersDigest,
    maxManagedSpotQuantity: preview.maxManagedSpotQuantity,
    maxManagedPerpetualQuantity: preview.maxManagedPerpetualQuantity,
    maxManagedNotionalUsd: preview.maxManagedNotionalUsd,
    previewedAt: preview.generatedAt,
    createdAt: input.now,
    revokedAt: null,
  } satisfies RwaAccountAssetAuthorization;
}

export function validateAccountAssetAuthorization(value: unknown): RwaAccountAssetAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidAuthorization();
  const record = value as Record<string, unknown>;
  const keys = [
    "accountFingerprint", "accountId", "assetId", "authorizationId", "createdAt",
    "maxManagedNotionalUsd", "maxManagedPerpetualQuantity", "maxManagedSpotQuantity",
    "ordersDigest", "perpetualOrderCount", "perpetualQuantity", "perpetualSide",
    "policyDigest", "policyVersion", "previewDigest", "previewedAt", "profileId",
    "revokedAt", "spotAvailableQuantity", "spotLockedQuantity", "spotOrderCount",
    "spotQuantity", "userDomain", "venue",
  ];
  if (
    Object.keys(record).sort().join(",") !== keys.sort().join(",")
    || typeof record.authorizationId !== "string" || !record.authorizationId
    || typeof record.userDomain !== "string" || !/^[a-f0-9]{16}$/.test(record.userDomain)
    || !["binance", "bybit"].includes(String(record.venue))
    || typeof record.accountId !== "string" || !record.accountId
    || typeof record.accountFingerprint !== "string" || !record.accountFingerprint
    || typeof record.assetId !== "string"
    || typeof record.profileId !== "string"
    || typeof record.policyVersion !== "string"
    || typeof record.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.policyDigest)
    || typeof record.previewDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.previewDigest)
    || typeof record.ordersDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.ordersDigest)
    || !["long", "short", "flat"].includes(String(record.perpetualSide))
    || !numbersValid(record, authorizationNumberKeys)
    || Number(record.createdAt) < Number(record.previewedAt)
    || !(record.revokedAt === null
      || (Number.isFinite(record.revokedAt) && Number(record.revokedAt) >= Number(record.createdAt)))
  ) throw invalidAuthorization();
  const profile = requireRwaAutomationExecutionProfile(String(record.assetId), String(record.venue));
  if (
    record.profileId !== rwaAutomationProfileId(profile)
    || record.policyVersion !== profile.asset.authorizationPolicy.version
    || record.policyDigest !== profile.asset.authorizationPolicy.digest
  ) throw invalidAuthorization();
  return record as RwaAccountAssetAuthorization;
}

export function revokeAccountAssetAuthorization(
  authorization: RwaAccountAssetAuthorization,
  now: number,
) {
  if (authorization.revokedAt === null) authorization.revokedAt = now;
}

export function invalidateAccountAssetAuthorizations(
  authorizations: RwaAccountAssetAuthorization[],
  now: number,
) {
  for (const authorization of authorizations) revokeAccountAssetAuthorization(authorization, now);
}

export function publicAccountAssetAuthorization(
  authorization: RwaAccountAssetAuthorization,
): RwaPublicAccountAssetAuthorization {
  const {
    accountId: _accountId,
    userDomain: _userDomain,
    ...value
  } = validateAccountAssetAuthorization(authorization);
  return value;
}

export function assetOrdersDigest(orders: readonly RwaAssetOrderReference[]) {
  return digest([...orders]
    .map((order) => ({
      category: order.category,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
    }))
    .sort((left, right) =>
      left.category.localeCompare(right.category)
      || left.orderId.localeCompare(right.orderId)));
}

function assertSnapshotAndOrders<TPermissions extends RwaVenuePermissions>(
  profile: RwaAutomationResolvedAssetProfile,
  snapshot: RwaProviderPreflightSnapshot<TPermissions>,
  orders: readonly RwaAssetOrderReference[],
) {
  assertRwaAutomationInstrumentRules(profile, "spot", snapshot.spot);
  assertRwaAutomationInstrumentRules(profile, "perpetual", snapshot.perpetual);
  if (
    !numbersValid(snapshot as unknown as Record<string, unknown>, [
      "existingSpotQuantityXaut", "spotAvailableQuantityXaut", "spotLockedQuantityXaut",
      "existingPerpetualQuantityXaut",
    ])
    || Math.abs(
      snapshot.existingSpotQuantityXaut
      - snapshot.spotAvailableQuantityXaut
      - snapshot.spotLockedQuantityXaut,
    ) > 1e-9
    || snapshot.fees.spotTakerBps > profile.venue.spotRules.maxTakerFeeBps
    || snapshot.fees.perpetualTakerBps > profile.venue.perpetualRules.maxTakerFeeBps
    || orders.some((order) =>
      !order.orderId
      || !["spot", "linear"].includes(order.category)
      || order.symbol !== (order.category === "spot"
        ? profile.venue.spotSymbol
        : profile.venue.perpetualSymbol))
    || snapshot.openSpotOrderCount !== orders.filter((order) => order.category === "spot").length
    || snapshot.openPerpetualOrderCount !== orders.filter((order) => order.category === "linear").length
  ) throw invalidPreview();
}

const previewNumberKeys = [
  "spotQuantity", "spotAvailableQuantity", "spotLockedQuantity", "perpetualQuantity",
  "spotOrderCount", "perpetualOrderCount", "maxManagedSpotQuantity",
  "maxManagedPerpetualQuantity", "maxManagedNotionalUsd", "generatedAt", "expiresAt",
] as const;
const authorizationNumberKeys = [
  "spotQuantity", "spotAvailableQuantity", "spotLockedQuantity", "perpetualQuantity",
  "spotOrderCount", "perpetualOrderCount", "maxManagedSpotQuantity",
  "maxManagedPerpetualQuantity", "maxManagedNotionalUsd", "previewedAt", "createdAt",
] as const;

function numbersValid(record: Record<string, unknown>, keys: readonly string[]) {
  return keys.every((key) => Number.isFinite(record[key]) && Number(record[key]) >= 0);
}
function digestPreview(preview: RwaAccountAssetAuthorizationPreview) {
  const { previewDigest: _previewDigest, ...payload } = preview;
  return digest(payload);
}
function previewState(preview: RwaAccountAssetAuthorizationPreview) {
  return {
    venue: preview.venue,
    assetId: preview.assetId,
    profileId: preview.profileId,
    policyVersion: preview.policyVersion,
    policyDigest: preview.policyDigest,
    notice: preview.notice,
    accountFingerprint: preview.accountFingerprint,
    spotQuantity: preview.spotQuantity,
    spotAvailableQuantity: preview.spotAvailableQuantity,
    spotLockedQuantity: preview.spotLockedQuantity,
    perpetualQuantity: preview.perpetualQuantity,
    perpetualSide: preview.perpetualSide,
    spotOrderCount: preview.spotOrderCount,
    perpetualOrderCount: preview.perpetualOrderCount,
    ordersDigest: preview.ordersDigest,
    maxManagedSpotQuantity: preview.maxManagedSpotQuantity,
    maxManagedPerpetualQuantity: preview.maxManagedPerpetualQuantity,
    maxManagedNotionalUsd: preview.maxManagedNotionalUsd,
  };
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function invalidPreview() {
  return new RwaAccountAssetAuthorizationError(
    409,
    "asset_authorization_preview_invalid",
    "账户资产授权预览无效或已过期，请重新获取。",
  );
}
function invalidAuthorization() {
  return new RwaAccountAssetAuthorizationError(
    503,
    "asset_authorization_invalid",
    "账户资产授权状态无效，已保持 fail-closed。",
  );
}
