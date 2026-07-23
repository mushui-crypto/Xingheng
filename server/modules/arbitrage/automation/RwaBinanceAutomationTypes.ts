import type {
  RwaInstrumentSpec,
  RwaVenueAccountIdentity,
  RwaVenueCredentials,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";

export const RWA_BINANCE_STRATEGY_ID = "binance-xaut-spot-perp-v1" as const;
export const RWA_BINANCE_SPOT_SYMBOL = "XAUTUSDT" as const;
export const RWA_BINANCE_PERPETUAL_SYMBOL = "XAUTUSDT" as const;
export const RWA_BINANCE_TOTAL_BUDGET_USD = 25;
export const RWA_BINANCE_PRODUCT_CACHE_TTL_MS = 30_000;
export const RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS = 10_000;

export type RwaBinanceCredentials = RwaVenueCredentials;

export type RwaBinancePermissions = RwaVenuePermissions & {
  spotAccount: boolean;
  futuresAccount: boolean;
  positionModeSupported: boolean;
};

export type RwaBinanceAccountIdentity = RwaVenueAccountIdentity & {
  accountMode:
    | "single_asset_one_way"
    | "single_asset_hedge"
    | "multi_assets_one_way"
    | "multi_assets_hedge"
    | "portfolio_margin"
    | "unknown";
};

export type RwaBinanceProductAvailability = {
  available: boolean;
  status: "available" | "spot_unavailable" | "perpetual_unavailable" | "both_unavailable";
  spotSymbol: typeof RWA_BINANCE_SPOT_SYMBOL;
  perpetualSymbol: typeof RWA_BINANCE_PERPETUAL_SYMBOL;
  checkedAt: number;
  message: string | null;
};

export type RwaBinanceInstrumentSnapshot = RwaInstrumentSpec & {
  bid: number;
  ask: number;
  depthUsd: number;
};

export type RwaBinancePreflightSnapshot = {
  accountId: string;
  accountFingerprint: string;
  fetchedAt: number;
  accountMode: RwaBinanceAccountIdentity["accountMode"];
  permissions: RwaBinancePermissions;
  productAvailability: RwaBinanceProductAvailability;
  spotAvailableUsdt: number;
  futuresAvailableUsdt: number;
  existingSpotQuantityXaut: number;
  existingPerpetualQuantityXaut: number;
  openSpotOrderCount: number;
  openPerpetualOrderCount: number;
  spot: RwaBinanceInstrumentSnapshot;
  perpetual: RwaBinanceInstrumentSnapshot & {
    mark: number;
    fundingRate: number;
    fundingIntervalHours: number;
    nextFundingTime: number | null;
    liquidationDistancePercent: number | null;
  };
  fees: {
    spotTakerBps: number;
    perpetualTakerBps: number;
  };
};

export type RwaBinanceClient = {
  validateAccess(): Promise<RwaBinanceAccountIdentity & { permissions: RwaBinancePermissions }>;
  readPreflightSnapshot(): Promise<RwaBinancePreflightSnapshot>;
  readProductAvailability(): Promise<RwaBinanceProductAvailability>;
};

export type RwaBinanceClientFactory = (credentials: RwaBinanceCredentials) => RwaBinanceClient;

