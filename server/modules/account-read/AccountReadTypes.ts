import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";

export type VenueAccountReadBalance = {
  asset: string;
  accountType: "spot" | "derivatives";
  total: number;
  available: number;
  locked: number | null;
};

export type AccountReadBalance = VenueAccountReadBalance & {
  estimatedValueUsdt: number | null;
  valuationStatus: "VALUED" | "UNAVAILABLE";
};

export type AccountReadCapabilityStatus = "ENABLED" | "DISABLED" | "UNKNOWN";

export type VenueAccountReadSnapshot = {
  venue: ExchangeVenue;
  accountId: string;
  accountFingerprint: string;
  uidHash: string | null;
  accountTypes: Array<"spot" | "derivatives">;
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
