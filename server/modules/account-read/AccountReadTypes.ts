import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";

export type AccountReadAccountType = "spot" | "derivatives" | "unified" | "unknown";

export type VenueAccountReadBalance = {
  asset: string;
  accountType: AccountReadAccountType;
  total: number;
  available: number | null;
  locked: number | null;
};

export type AccountReadBalance = VenueAccountReadBalance & {
  estimatedValueUsdt: number | null;
  valuationStatus: "VALUED" | "UNAVAILABLE";
};

export type AccountReadCapabilityStatus = "ENABLED" | "DISABLED" | "UNKNOWN";

export type AccountReadPerpetualPosition = {
  side: "long" | "short" | "flat";
  baseQuantity: string;
  updatedAt: number | null;
};

export type AccountReadPerpetualPositions = {
  symbol: string;
  holdMode: string | null;
  long: AccountReadPerpetualPosition;
  short: AccountReadPerpetualPosition;
};

export type VenueAccountReadSnapshot = {
  venue: ExchangeVenue;
  accountId: string;
  accountFingerprint: string;
  uidHash: string | null;
  accountTypes: AccountReadAccountType[];
  accountMode: string | null;
  connection: {
    status: "connected";
    checkedAt: number;
  };
  credentialValidation: {
    status: "validated";
    checkedAt: number;
  };
  balances: VenueAccountReadBalance[];
  perpetualPositions?: AccountReadPerpetualPositions;
  permissions: {
    read: AccountReadCapabilityStatus;
    spotTrade: AccountReadCapabilityStatus;
    derivativesTrade: AccountReadCapabilityStatus;
    withdraw: AccountReadCapabilityStatus;
    ipRestricted: AccountReadCapabilityStatus;
  };
  capabilities: {
    spotAccount: AccountReadCapabilityStatus;
    derivativesAccount: AccountReadCapabilityStatus;
    positionModeSupported: AccountReadCapabilityStatus;
  };
  latestSyncAt: number;
};

export type AccountReadSnapshot = Omit<VenueAccountReadSnapshot, "balances"> & {
  balances: AccountReadBalance[];
  estimatedTotalValueUsdt: number | null;
  valuationCoverage: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
};
