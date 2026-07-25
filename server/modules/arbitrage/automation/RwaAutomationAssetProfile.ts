import { createHash } from "node:crypto";
import type { RwaAutomationVenue } from "./RwaAutomationTypes";
import type { RwaProviderActivitySource } from "./RwaNeutralExecutionTypes";

export const RWA_AUTOMATION_ASSET_IDS = ["xaut", "btc", "eth", "sol"] as const;
export type RwaAutomationAssetId = typeof RWA_AUTOMATION_ASSET_IDS[number];
export type RwaAutomationBaseAsset = "XAUT" | "BTC" | "ETH" | "SOL";

export type RwaAutomationRiskLimits = {
  maxOrderNotionalUsd: number;
  maxAssetCapitalUsd: number;
  maxAccountCapitalUsd: number;
  maxGlobalCapitalUsd: number;
};

export type RwaAutomationInstrumentRules = {
  contractUnitBase: number;
  allowedQuantitySteps: readonly number[];
  allowedMinimumQuantities: readonly number[];
  allowedPriceSteps: readonly number[];
  minimumQuantity: number;
  minimumNotionalUsd: number;
  maxTakerFeeBps: number;
};

export type RwaAutomationVenueAssetProfile = {
  venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
  strategyId: string;
  spotSymbol: string;
  perpetualSymbol: string;
  perpetualContract: { kind: "linear"; baseQuantityMultiplier: number };
  spotRules: RwaAutomationInstrumentRules;
  perpetualRules: RwaAutomationInstrumentRules;
  fees: {
    spotPositionChange: "provider_trade_fills";
    perpetualPositionChange: "provider_order_fills";
    quoteAsset: string;
  };
  activitySources: readonly RwaProviderActivitySource[];
};

export type RwaAutomationAssetProfile = {
  schemaVersion: 1;
  assetId: RwaAutomationAssetId;
  executionStatus: "enabled" | "reserved";
  displayName: string;
  baseAsset: RwaAutomationBaseAsset;
  quoteAsset: "USDT";
  hedge: {
    spotSide: "long";
    perpetualSide: "short";
    baseQuantityRatio: 1;
    residualMode: "exchange_constraints";
  };
  currentStageRiskLimits: RwaAutomationRiskLimits | null;
  hedgeToleranceBase: number;
  authorizationPolicy: {
    version: "account-asset-full-management-v1";
    notice: string;
    digest: string;
  };
  venues: readonly RwaAutomationVenueAssetProfile[];
};

export type RwaAutomationResolvedAssetProfile = {
  asset: RwaAutomationAssetProfile;
  venue: RwaAutomationVenueAssetProfile;
};

export type RwaAutomationCapitalExposure = {
  executionId: string;
  userId: string;
  accountId: string;
  assetId: RwaAutomationAssetId;
  profileId: string;
  capitalUsd: number;
};

export type RwaAutomationRiskUsage = {
  orderNotionalUsd: number;
  assetNotionalUsd: number;
  accountNotionalUsd: number;
  globalNotionalUsd: number;
};

export class RwaAutomationAssetProfileError extends Error {
  constructor(
    readonly category: "asset_profile_unknown" | "asset_profile_disabled" | "asset_profile_invalid",
    message: string,
  ) {
    super(message);
  }
}

const ALL_ACTIVITY_SOURCES = [
  "spot_orders", "spot_trades", "perpetual_orders", "perpetual_trades",
  "account_transactions", "internal_transfers", "universal_transfers",
  "deposits", "internal_deposits", "withdrawals", "convert", "dust",
  "balance_adjustments",
] as const satisfies readonly RwaProviderActivitySource[];

const XAUT_V1_RISK_LIMITS: RwaAutomationRiskLimits = {
  maxOrderNotionalUsd: 2_000,
  maxAssetCapitalUsd: 2_000,
  maxAccountCapitalUsd: 2_000,
  maxGlobalCapitalUsd: 2_000,
};

const PROFILE_REGISTRY = new Map<RwaAutomationAssetId, RwaAutomationAssetProfile>([
  ["xaut", profile("xaut", "XAUT", "enabled")],
  ["btc", profile("btc", "BTC", "reserved")],
  ["eth", profile("eth", "ETH", "reserved")],
  ["sol", profile("sol", "SOL", "reserved")],
]);

for (const value of PROFILE_REGISTRY.values()) {
  validateRwaAutomationAssetProfile(value);
  deepFreeze(value);
}

export const XAUT_AUTOMATION_ASSET_PROFILE = requireRwaAutomationAssetProfile("xaut");

export function listRwaAutomationAssetProfiles() {
  return [...PROFILE_REGISTRY.values()] as readonly RwaAutomationAssetProfile[];
}

export function getRwaAutomationAssetProfile(assetId: string) {
  return isAssetId(assetId) ? PROFILE_REGISTRY.get(assetId) ?? null : null;
}

export function requireRwaAutomationAssetProfile(
  assetId: string,
  options: { executionRequired?: boolean } = {},
) {
  const value = getRwaAutomationAssetProfile(assetId);
  if (!value) throw new RwaAutomationAssetProfileError("asset_profile_unknown", "The requested automation asset is not configured.");
  if (options.executionRequired && value.executionStatus !== "enabled") {
    throw new RwaAutomationAssetProfileError("asset_profile_disabled", "The requested automation asset is not enabled for execution.");
  }
  return value;
}

export function requireRwaAutomationVenueAssetProfile(
  assetId: string,
  venue: string,
  options: { executionRequired?: boolean } = {},
) {
  const asset = requireRwaAutomationAssetProfile(assetId, options);
  const value = asset.venues.find((item) => item.venue === venue);
  if (!value) throw new RwaAutomationAssetProfileError("asset_profile_unknown", "The requested venue is not configured for this automation asset.");
  return value;
}

export function requireRwaAutomationExecutionProfile(
  assetId: string,
  venue: string,
): RwaAutomationResolvedAssetProfile {
  return {
    asset: requireRwaAutomationAssetProfile(assetId, { executionRequired: true }),
    venue: requireRwaAutomationVenueAssetProfile(assetId, venue, { executionRequired: true }),
  };
}

export function rwaAutomationProfileId(profile: RwaAutomationResolvedAssetProfile) {
  return `${profile.asset.assetId}:${profile.venue.strategyId}`;
}

export function calculateRwaAutomationNewRiskUsage(input: {
  exposures: readonly RwaAutomationCapitalExposure[];
  profile: RwaAutomationResolvedAssetProfile;
  userId: string;
  accountId: string;
  orderNotionalUsd: number;
  proposedCapitalUsd: number;
}): RwaAutomationRiskUsage {
  const { exposures, profile, userId, accountId, orderNotionalUsd, proposedCapitalUsd } = input;
  if (
    !positiveOrZero(orderNotionalUsd)
    || !positiveOrZero(proposedCapitalUsd)
    || exposures.some((item) =>
      !item.executionId || !item.userId || !item.accountId || !isAssetId(item.assetId)
      || !item.profileId || !positiveOrZero(item.capitalUsd))
  ) throw invalidProfile();
  return {
    orderNotionalUsd,
    assetNotionalUsd: sumCapital(exposures.filter((item) =>
      item.assetId === profile.asset.assetId)) + proposedCapitalUsd,
    accountNotionalUsd: sumCapital(exposures.filter((item) =>
      item.userId === userId && item.accountId === accountId)) + proposedCapitalUsd,
    globalNotionalUsd: sumCapital(exposures) + proposedCapitalUsd,
  };
}

export function mergeRwaAutomationCapitalExposures(
  ...groups: ReadonlyArray<readonly RwaAutomationCapitalExposure[]>
) {
  const merged = new Map<string, RwaAutomationCapitalExposure>();
  for (const group of groups) {
    for (const exposure of group) {
      merged.set(`${exposure.userId}\0${exposure.accountId}\0${exposure.executionId}`, exposure);
    }
  }
  return [...merged.values()];
}

export function validateRwaAutomationAssetProfile(value: RwaAutomationAssetProfile) {
  if (
    value.schemaVersion !== 1 || !isAssetId(value.assetId)
    || !["enabled", "reserved"].includes(value.executionStatus)
    || !/^[A-Z0-9]{2,12}$/.test(value.baseAsset)
    || value.displayName !== value.baseAsset || value.quoteAsset !== "USDT"
    || value.hedge.spotSide !== "long" || value.hedge.perpetualSide !== "short"
    || value.hedge.baseQuantityRatio !== 1
    || value.hedge.residualMode !== "exchange_constraints"
    || !positiveFinite(value.hedgeToleranceBase)
    || value.authorizationPolicy.version !== "account-asset-full-management-v1"
    || value.authorizationPolicy.notice !== authorizationNotice(value.baseAsset)
    || value.authorizationPolicy.digest !== authorizationPolicyDigest(
      value.authorizationPolicy.version,
      value.authorizationPolicy.notice,
    )
    || value.venues.length === 0
  ) throw invalidProfile();
  if (value.executionStatus === "enabled") validateRiskLimits(value.currentStageRiskLimits);
  else if (value.currentStageRiskLimits !== null) throw invalidProfile();

  const venues = new Set<string>();
  for (const venue of value.venues) {
    if (
      venues.has(venue.venue) || !["binance", "bybit"].includes(venue.venue)
      || venue.strategyId !== `${venue.venue}-${value.baseAsset.toLowerCase()}-spot-perp-v1`
      || venue.spotSymbol !== `${value.baseAsset}${value.quoteAsset}`
      || venue.perpetualSymbol !== `${value.baseAsset}${value.quoteAsset}`
      || venue.perpetualContract.kind !== "linear"
      || venue.perpetualContract.baseQuantityMultiplier !== 1
      || !validInstrumentRules(venue.spotRules)
      || !validInstrumentRules(venue.perpetualRules)
      || venue.fees.spotPositionChange !== "provider_trade_fills"
      || venue.fees.perpetualPositionChange !== "provider_order_fills"
      || venue.fees.quoteAsset !== value.quoteAsset
      || new Set(venue.activitySources).size !== venue.activitySources.length
      || !ALL_ACTIVITY_SOURCES.every((source) => venue.activitySources.includes(source))
    ) throw invalidProfile();
    venues.add(venue.venue);
  }
  return value;
}

export function assertRwaAutomationInstrumentRules(
  profile: RwaAutomationResolvedAssetProfile,
  category: "spot" | "perpetual",
  actual: { qtyStep: number; priceTick: number; minOrderQty: number; minNotionalUsd: number },
) {
  const expected = category === "spot" ? profile.venue.spotRules : profile.venue.perpetualRules;
  if (
    !expected.allowedQuantitySteps.includes(actual.qtyStep)
    || !expected.allowedPriceSteps.includes(actual.priceTick)
    || !expected.allowedMinimumQuantities.includes(actual.minOrderQty)
    || Math.abs(actual.minNotionalUsd - expected.minimumNotionalUsd) > 1e-9
  ) throw invalidProfile();
}

export function assertRwaAutomationNewRisk(input: {
  limits: RwaAutomationRiskLimits;
  orderNotionalUsd: number;
  assetNotionalUsd: number;
  accountNotionalUsd: number;
  globalNotionalUsd: number;
}) {
  if (
    [input.orderNotionalUsd, input.assetNotionalUsd, input.accountNotionalUsd, input.globalNotionalUsd]
      .some((value) => !Number.isFinite(value) || value < 0)
    || input.orderNotionalUsd > input.limits.maxOrderNotionalUsd
    || input.assetNotionalUsd > input.limits.maxAssetCapitalUsd
    || input.accountNotionalUsd > input.limits.maxAccountCapitalUsd
    || input.globalNotionalUsd > input.limits.maxGlobalCapitalUsd
  ) throw invalidProfile();
}

function profile(
  assetId: RwaAutomationAssetId,
  baseAsset: RwaAutomationBaseAsset,
  executionStatus: RwaAutomationAssetProfile["executionStatus"],
): RwaAutomationAssetProfile {
  return {
    schemaVersion: 1,
    assetId,
    executionStatus,
    displayName: baseAsset,
    baseAsset,
    quoteAsset: "USDT",
    hedge: { spotSide: "long", perpetualSide: "short", baseQuantityRatio: 1, residualMode: "exchange_constraints" },
    currentStageRiskLimits: executionStatus === "enabled" ? { ...XAUT_V1_RISK_LIMITS } : null,
    hedgeToleranceBase: baseAsset === "XAUT" ? 0.000001 : 0.00000001,
    authorizationPolicy: {
      version: "account-asset-full-management-v1",
      notice: authorizationNotice(baseAsset),
      digest: authorizationPolicyDigest(
        "account-asset-full-management-v1",
        authorizationNotice(baseAsset),
      ),
    },
    venues: [venueProfile("binance", baseAsset), venueProfile("bybit", baseAsset)],
  };
}

function venueProfile(venue: "binance" | "bybit", asset: RwaAutomationBaseAsset): RwaAutomationVenueAssetProfile {
  const spotSteps = asset === "XAUT" ? venue === "bybit" ? [0.00001, 0.0001] : [0.0001] : [0.000001];
  return {
    venue,
    strategyId: `${venue}-${asset.toLowerCase()}-spot-perp-v1`,
    spotSymbol: `${asset}USDT`,
    perpetualSymbol: `${asset}USDT`,
    perpetualContract: { kind: "linear", baseQuantityMultiplier: 1 },
    spotRules: instrumentRules(spotSteps, [0.01]),
    perpetualRules: instrumentRules([0.001], [0.01, 0.1]),
    fees: {
      spotPositionChange: "provider_trade_fills",
      perpetualPositionChange: "provider_order_fills",
      quoteAsset: "USDT",
    },
    activitySources: [...ALL_ACTIVITY_SOURCES],
  };
}

function instrumentRules(quantity: readonly number[], price: readonly number[]): RwaAutomationInstrumentRules {
  return {
    contractUnitBase: 1,
    allowedQuantitySteps: [...quantity],
    allowedMinimumQuantities: [...quantity],
    allowedPriceSteps: [...price],
    minimumQuantity: Math.min(...quantity),
    minimumNotionalUsd: 5,
    maxTakerFeeBps: 20,
  };
}

function validateRiskLimits(value: RwaAutomationRiskLimits | null): asserts value is RwaAutomationRiskLimits {
  if (
    !value || !positiveFinite(value.maxOrderNotionalUsd) || !positiveFinite(value.maxAssetCapitalUsd)
    || !positiveFinite(value.maxAccountCapitalUsd) || !positiveFinite(value.maxGlobalCapitalUsd)
    || value.maxOrderNotionalUsd > value.maxAssetCapitalUsd
    || value.maxAssetCapitalUsd > value.maxAccountCapitalUsd
    || value.maxAccountCapitalUsd > value.maxGlobalCapitalUsd
  ) throw invalidProfile();
}

function validInstrumentRules(value: RwaAutomationInstrumentRules) {
  return value.contractUnitBase === 1
    && value.allowedQuantitySteps.length > 0 && value.allowedQuantitySteps.every(positiveFinite)
    && value.allowedMinimumQuantities.length > 0 && value.allowedMinimumQuantities.every(positiveFinite)
    && value.minimumQuantity === Math.min(...value.allowedMinimumQuantities)
    && value.allowedPriceSteps.length > 0 && value.allowedPriceSteps.every(positiveFinite)
    && positiveFinite(value.minimumQuantity) && positiveFinite(value.minimumNotionalUsd)
    && positiveFinite(value.maxTakerFeeBps);
}

function isAssetId(value: string): value is RwaAutomationAssetId {
  return RWA_AUTOMATION_ASSET_IDS.includes(value as RwaAutomationAssetId);
}
function positiveFinite(value: number) { return Number.isFinite(value) && value > 0; }
function positiveOrZero(value: number) { return Number.isFinite(value) && value >= 0; }
function sumCapital(exposures: readonly RwaAutomationCapitalExposure[]) {
  return exposures.reduce((total, item) => total + item.capitalUsd, 0);
}
function invalidProfile() {
  return new RwaAutomationAssetProfileError("asset_profile_invalid", "The automation asset profile is invalid.");
}
function authorizationNotice(asset: RwaAutomationBaseAsset) {
  return `确认后，未来启用资产接管时，系统可能撤销该交易所账户中的全部 ${asset} 活动订单，并买入、卖出或平掉该账户的全部 ${asset} 现货与永续仓位；包括手工买入、转入或手工开仓的 ${asset}。其他资产不在授权范围内。本次确认只建立授权，不会立即下单、撤单或接管。`;
}
function authorizationPolicyDigest(version: string, notice: string) {
  return createHash("sha256").update(JSON.stringify({ version, notice })).digest("hex");
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
