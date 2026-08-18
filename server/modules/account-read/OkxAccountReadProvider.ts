import { createHash } from "node:crypto";
import {
  OkxAccountReadClient,
  OkxAccountReadError,
  type OkxAccountReadSnapshot,
} from "../okx/OkxAccountReadClient";
import type { UserExchangeCredentialSecret } from "../credentials/UserExchangeCredentialStore";
import type { AccountReadAccountType, AccountReadCapabilityStatus } from "./AccountReadTypes";
import type { AccountReadProvider, AccountReadProviderFactory } from "./AccountReadProvider";

type OkxReadOnlyClient = {
  readAccountSnapshot(): Promise<OkxAccountReadSnapshot>;
  dispose?(): void | Promise<void>;
};

export class OkxAccountReadProvider implements AccountReadProvider {
  readonly venue = "okx" as const;

  constructor(private client: OkxReadOnlyClient | null) {}

  async readAccount() {
    const client = this.client;
    if (!client) throw new Error("OKX account read provider has been disposed.");
    const snapshot = await client.readAccountSnapshot();
    const mode = accountMode(snapshot.accountLevel);
    const uidHash = createHash("sha256").update(`okx:${snapshot.uid}`).digest("hex");
    const permissions = permissionStatus(snapshot.permissions);
    return {
      venue: this.venue,
      accountId: `okx:${uidHash.slice(0, 16)}`,
      accountFingerprint: uidHash.slice(0, 16),
      uidHash,
      accountTypes: [mode.accountType],
      accountMode: mode.accountMode,
      connection: { status: "connected" as const, checkedAt: snapshot.fetchedAt },
      credentialValidation: { status: "validated" as const, checkedAt: snapshot.fetchedAt },
      balances: snapshot.balances.map((balance) => ({ ...balance, accountType: mode.accountType })),
      permissions: {
        read: permissions.read,
        spotTrade: "UNKNOWN" as const,
        derivativesTrade: "UNKNOWN" as const,
        withdraw: permissions.withdraw,
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

  async dispose() {
    const client = this.client;
    this.client = null;
    await client?.dispose?.();
  }
}

export class OkxAccountReadProviderFactory implements AccountReadProviderFactory {
  readonly venue = "okx" as const;

  constructor(
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => OkxReadOnlyClient = (secret) => {
      const passphrase = secret.passphrase?.trim();
      if (!passphrase) {
        throw new OkxAccountReadError(
          "credential_validation_failed",
          "OKX account read requires a credential passphrase.",
        );
      }
      return new OkxAccountReadClient({
        apiKey: secret.apiKey,
        apiSecret: secret.apiSecret,
        passphrase,
      });
    },
  ) {}

  create(secret: UserExchangeCredentialSecret) {
    return new OkxAccountReadProvider(this.clientFactory(secret));
  }
}

function accountMode(level: string): { accountType: AccountReadAccountType; accountMode: string } {
  if (level === "1") return { accountType: "spot", accountMode: "spot" };
  if (level === "2") return { accountType: "unified", accountMode: "single_currency_margin" };
  if (level === "3") return { accountType: "unified", accountMode: "multi_currency_margin" };
  if (level === "4") return { accountType: "unified", accountMode: "portfolio_margin" };
  return { accountType: "unknown", accountMode: "unknown" };
}

function permissionStatus(value: string | null) {
  if (!value) return { read: "UNKNOWN" as const, withdraw: "UNKNOWN" as const };
  const permissions = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  const known = ["read_only", "trade", "withdraw"].some((permission) => permissions.has(permission));
  if (!known) return { read: "UNKNOWN" as const, withdraw: "UNKNOWN" as const };
  return {
    read: enabledOrDisabled(permissions.has("read_only")),
    withdraw: enabledOrDisabled(permissions.has("withdraw")),
  };
}

function ipRestrictionStatus(value: string | null): AccountReadCapabilityStatus {
  if (value === null) return "UNKNOWN";
  return value.trim() ? "ENABLED" : "DISABLED";
}

function enabledOrDisabled(enabled: boolean) {
  return enabled ? "ENABLED" as const : "DISABLED" as const;
}
