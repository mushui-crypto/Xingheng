import { createHash } from "node:crypto";
import {
  BitgetAccountReadClient,
  BitgetAccountReadError,
  type BitgetAccountReadSnapshot,
} from "../bitget/BitgetAccountReadClient";
import type { UserExchangeCredentialSecret } from "../credentials/UserExchangeCredentialStore";
import type { AccountReadAccountType, AccountReadCapabilityStatus } from "./AccountReadTypes";
import type { AccountReadProvider, AccountReadProviderFactory } from "./AccountReadProvider";

type BitgetReadOnlyClient = {
  readAccountSnapshot(): Promise<BitgetAccountReadSnapshot>;
  dispose?(): void | Promise<void>;
};

export class BitgetAccountReadProvider implements AccountReadProvider {
  readonly venue = "bitget" as const;

  constructor(private client: BitgetReadOnlyClient | null) {}

  async readAccount() {
    const client = this.client;
    if (!client) throw new Error("Bitget account read provider has been disposed.");
    const snapshot = await client.readAccountSnapshot();
    const mode = accountMode(snapshot);
    const uidHash = createHash("sha256").update(`bitget:${snapshot.uid}`).digest("hex");
    return {
      venue: this.venue,
      accountId: `bitget:${uidHash.slice(0, 16)}`,
      accountFingerprint: uidHash.slice(0, 16),
      uidHash,
      accountTypes: [mode.accountType],
      accountMode: mode.accountMode,
      connection: { status: "connected" as const, checkedAt: snapshot.fetchedAt },
      credentialValidation: { status: "validated" as const, checkedAt: snapshot.fetchedAt },
      balances: snapshot.balances.map((balance) => ({ ...balance, accountType: mode.accountType })),
      permissions: {
        read: readPermission(snapshot.permType),
        spotTrade: tradePermission(snapshot.permType, snapshot.permissions),
        derivativesTrade: tradePermission(snapshot.permType, snapshot.permissions),
        withdraw: namedPermission(snapshot.permissions, "withdraw"),
        ipRestricted: ipRestrictionStatus(snapshot.boundIps),
      },
      capabilities: {
        spotAccount: accountCapability(snapshot.accountMode),
        derivativesAccount: accountCapability(snapshot.accountMode),
        positionModeSupported: positionModeCapability(snapshot.holdMode),
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

function tradePermission(
  permType: string | null,
  permissions: string[] | null,
): AccountReadCapabilityStatus {
  if (permType === null || permissions === null) return "UNKNOWN";
  if (normalizePermissionType(permType) !== "read-and-write") return "DISABLED";
  return permissions.some((value) => value.trim().toLowerCase() === "uta_trade") ? "ENABLED" : "DISABLED";
}

function normalizePermissionType(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "read_and_write" ? "read-and-write" : normalized;
}

function accountCapability(accountMode: string): AccountReadCapabilityStatus {
  const normalized = accountMode.trim().toLowerCase();
  if (normalized === "unified" || normalized === "hybrid") return "ENABLED";
  if (normalized === "upgrading" || normalized === "switching") return "DISABLED";
  return "UNKNOWN";
}

function positionModeCapability(holdMode: string | null): AccountReadCapabilityStatus {
  if (holdMode === null) return "UNKNOWN";
  const normalized = holdMode.trim().toLowerCase();
  if (normalized === "one_way_mode" || normalized === "hedge_mode") return "ENABLED";
  return "UNKNOWN";
}

function readPermission(value: string | null): AccountReadCapabilityStatus {
  if (value === null) return "UNKNOWN";
  const normalized = normalizePermissionType(value);
  return normalized === "read-only" || normalized === "read-and-write" ? "ENABLED" : "UNKNOWN";
}

function namedPermission(values: string[] | null, permission: string): AccountReadCapabilityStatus {
  if (values === null) return "UNKNOWN";
  return values.some((value) => value.trim().toLowerCase() === permission) ? "ENABLED" : "DISABLED";
}

function ipRestrictionStatus(value: string | null): AccountReadCapabilityStatus {
  if (value === null) return "UNKNOWN";
  return value.trim() ? "ENABLED" : "DISABLED";
}

export class BitgetAccountReadProviderFactory implements AccountReadProviderFactory {
  readonly venue = "bitget" as const;

  constructor(
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BitgetReadOnlyClient = (secret) => {
      const passphrase = secret.passphrase?.trim();
      if (!passphrase) {
        throw new BitgetAccountReadError(
          "credential_validation_failed",
          "Bitget account read requires a credential passphrase.",
        );
      }
      return new BitgetAccountReadClient({
        apiKey: secret.apiKey,
        apiSecret: secret.apiSecret,
        passphrase,
      });
    },
  ) {}

  create(secret: UserExchangeCredentialSecret) {
    return new BitgetAccountReadProvider(this.clientFactory(secret));
  }
}

function accountMode(snapshot: BitgetAccountReadSnapshot): {
  accountType: AccountReadAccountType;
  accountMode: string;
} {
  const mode = snapshot.accountMode.trim().toLowerCase();
  const detail = [mode, snapshot.accountLevel, snapshot.assetMode]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase())
    .join(":");
  if (mode === "unified" || mode === "hybrid") {
    return { accountType: "unified", accountMode: detail };
  }
  return { accountType: "unknown", accountMode: detail || "unknown" };
}
