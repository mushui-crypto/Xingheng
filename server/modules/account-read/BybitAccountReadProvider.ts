import { createHash } from "node:crypto";
import {
  BybitAccountReadClient,
  type BybitLinearPositionModeRead,
  type BybitAccountReadSnapshot,
} from "../bybit/BybitAccountReadClient";
import type { UserExchangeCredentialSecret } from "../credentials/UserExchangeCredentialStore";
import type { AccountReadAccountType, AccountReadCapabilityStatus } from "./AccountReadTypes";
import type { AccountReadProvider, AccountReadProviderFactory } from "./AccountReadProvider";

type BybitReadOnlyClient = {
  readAccountSnapshot(): Promise<BybitAccountReadSnapshot>;
  readLinearPositionMode?(symbol: string): Promise<BybitLinearPositionModeRead>;
  dispose?(): void | Promise<void>;
};

export class BybitAccountReadProvider implements AccountReadProvider {
  readonly venue = "bybit" as const;

  constructor(private client: BybitReadOnlyClient | null) {}

  async readAccount() {
    const client = this.client;
    if (!client) throw new Error("Bybit account read provider has been disposed.");
    const snapshot = await client.readAccountSnapshot();
    const mode = accountMode(snapshot.unifiedMarginStatus, snapshot.marginMode);
    const uidHash = createHash("sha256").update(`bybit:${snapshot.uid}`).digest("hex");
    return {
      venue: this.venue,
      accountId: `bybit:${uidHash.slice(0, 16)}`,
      accountFingerprint: uidHash.slice(0, 16),
      uidHash,
      accountTypes: mode.accountTypes,
      accountMode: mode.accountMode,
      connection: { status: "connected" as const, checkedAt: snapshot.fetchedAt },
      credentialValidation: { status: "validated" as const, checkedAt: snapshot.fetchedAt },
      balances: snapshot.balances,
      permissions: {
        read: readPermission(snapshot.readOnly),
        spotTrade: productPermission(snapshot.permissions, ["Spot"], ["SpotTrade"]),
        derivativesTrade: productPermission(
          snapshot.permissions,
          ["ContractTrade", "Options", "Derivatives"],
          ["Order", "OptionsTrade", "DerivativesTrade"],
        ),
        withdraw: productPermission(snapshot.permissions, ["Wallet"], ["Withdraw"]),
        ipRestricted: ipRestrictionStatus(snapshot.boundIps),
      },
      capabilities: {
        spotAccount: "UNKNOWN" as const,
        derivativesAccount: "UNKNOWN" as const,
        positionModeSupported: "UNKNOWN" as const,
      },
      latestSyncAt: snapshot.fetchedAt,
    };
  }

  async readLinearPositionMode(symbol: string) {
    const client = this.client;
    if (!client) throw new Error("Bybit account read provider has been disposed.");
    if (!client.readLinearPositionMode) {
      throw new Error("Bybit Linear position mode read is not implemented.");
    }
    return client.readLinearPositionMode(symbol);
  }

  async dispose() {
    const client = this.client;
    this.client = null;
    await client?.dispose?.();
  }
}

export class BybitAccountReadProviderFactory implements AccountReadProviderFactory {
  readonly venue = "bybit" as const;

  constructor(
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BybitReadOnlyClient = (secret) => (
      new BybitAccountReadClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret })
    ),
  ) {}

  create(secret: UserExchangeCredentialSecret) {
    return new BybitAccountReadProvider(this.clientFactory(secret));
  }
}

function accountMode(
  status: number,
  marginMode: string | null,
): { accountTypes: AccountReadAccountType[]; accountMode: string } {
  const margin = marginMode?.trim().toLowerCase() ?? "unknown_margin";
  if (status === 1) return { accountTypes: ["spot", "derivatives"], accountMode: `classic:${margin}` };
  if (status === 3) return { accountTypes: ["unified"], accountMode: `unified_1:${margin}` };
  if (status === 4) return { accountTypes: ["unified"], accountMode: `unified_1_pro:${margin}` };
  if (status === 5) return { accountTypes: ["unified"], accountMode: `unified_2:${margin}` };
  if (status === 6) return { accountTypes: ["unified"], accountMode: `unified_2_pro:${margin}` };
  return { accountTypes: ["unknown"], accountMode: `unknown:${margin}` };
}

function readPermission(value: number | null): AccountReadCapabilityStatus {
  return value === 0 || value === 1 ? "ENABLED" : "UNKNOWN";
}

function productPermission(
  permissions: Record<string, string[] | null> | null,
  groups: string[],
  enablingValues: string[],
): AccountReadCapabilityStatus {
  if (!permissions) return "UNKNOWN";
  const reported = groups.map((group) => permissions[group]).filter((value) => value !== undefined);
  if (!reported.length || reported.every((value) => value === null)) return "UNKNOWN";
  return reported.some((values) => values?.some((value) => enablingValues.includes(value))) ? "ENABLED" : "DISABLED";
}

function ipRestrictionStatus(value: string[] | null): AccountReadCapabilityStatus {
  if (value === null) return "UNKNOWN";
  return value.length ? "ENABLED" : "DISABLED";
}
