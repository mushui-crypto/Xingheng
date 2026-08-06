import type {
  RwaInstrumentSpec,
  RwaNeutralTradingClient,
  RwaProviderPreflightSnapshot,
  RwaVenueAccountIdentity,
  RwaVenueCredentials,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";
import { XAUT_AUTOMATION_ASSET_PROFILE } from "./RwaAutomationAssetProfile";
import type { RwaBinanceActivityGuard } from "./RwaBinanceActivityGuard";

export const RWA_BINANCE_STRATEGY_ID = "binance-xaut-spot-perp-v1" as const;
export const RWA_BINANCE_SPOT_SYMBOL = "XAUTUSDT" as const;
export const RWA_BINANCE_PERPETUAL_SYMBOL = "XAUTUSDT" as const;
export const RWA_BINANCE_PRODUCT_CACHE_TTL_MS = 30_000;
export const RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS = 10_000;

export type RwaBinanceCredentials = RwaVenueCredentials;

export type RwaBinancePermissions = RwaVenuePermissions & {
  spotAccount: boolean;
  futuresAccount: boolean;
  positionModeSupported: boolean;
};

export type RwaBinanceAccountIdentity = RwaVenueAccountIdentity & {
  uidSnapshot?: string;
  accountMode:
    | "single_asset_one_way"
    | "single_asset_hedge"
    | "multi_assets_one_way"
    | "multi_assets_hedge"
    | "portfolio_margin"
    | "unknown";
  ipWhitelistVerificationMode?: "provider_list_exact" | "provider_restriction_only";
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

export type RwaBinancePreflightSnapshot = RwaProviderPreflightSnapshot<RwaBinancePermissions> & {
  accountId: string;
  accountFingerprint: string;
  uidSnapshot?: string;
  fetchedAt: number;
  accountMode: RwaBinanceAccountIdentity["accountMode"];
  permissions: RwaBinancePermissions;
  productAvailability: RwaBinanceProductAvailability;
  spotAvailableUsdt: number;
  futuresAvailableUsdt: number;
  spotFreeXaut: number;
  spotLockedXaut: number;
  existingSpotQuantityXaut: number;
  existingPerpetualQuantityXaut: number;
  openSpotOrderCount: number;
  openPerpetualOrderCount: number;
  spot: RwaBinanceInstrumentSnapshot;
  perpetual: RwaBinanceInstrumentSnapshot & {
    leverage: number | null;
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

export type RwaBinanceClient = RwaNeutralTradingClient<RwaBinancePermissions, RwaBinancePreflightSnapshot> & {
  readonly requiresProviderActivityStream?: true;
  readProductAvailability(): Promise<RwaBinanceProductAvailability>;
};

export type RwaBinanceClientFactory = (
  credentials: RwaBinanceCredentials,
  activityGuard?: RwaBinanceActivityGuard,
) => RwaBinanceClient;
