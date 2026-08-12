import { BinanceClient } from "../binance/BinanceClient";
import type { BinanceReadOnlyAccountSnapshot } from "../binance/BinanceTypes";
import type { UserExchangeCredentialSecret } from "../credentials/UserExchangeCredentialStore";
import type { AccountReadProvider, AccountReadProviderFactory } from "./AccountReadProvider";

type BinanceReadOnlyClient = {
  readAccountSnapshot(): Promise<BinanceReadOnlyAccountSnapshot>;
};

export class BinanceAccountReadProvider implements AccountReadProvider {
  readonly venue = "binance" as const;

  constructor(private client: BinanceReadOnlyClient | null) {}

  async readAccount() {
    const client = this.client;
    if (!client) throw new Error("Binance account read provider has been disposed.");
    const snapshot = await client.readAccountSnapshot();
    const accountTypes = [...new Set(snapshot.balances.map((balance) => balance.accountType))];
    return {
      venue: this.venue,
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      uidHash: snapshot.uidSnapshot ?? null,
      accountTypes,
      accountMode: snapshot.accountMode,
      connection: { status: "connected" as const, checkedAt: snapshot.fetchedAt },
      credentialValidation: { status: "validated" as const, checkedAt: snapshot.fetchedAt },
      balances: snapshot.balances,
      permissions: {
        read: status(snapshot.permissions.read),
        spotTrade: status(snapshot.permissions.spotTrade),
        derivativesTrade: status(snapshot.permissions.contractTrade),
        withdraw: status(snapshot.permissions.withdraw),
        ipRestricted: status(snapshot.permissions.ipRestricted),
      },
      capabilities: {
        spotAccount: "UNKNOWN" as const,
        derivativesAccount: "UNKNOWN" as const,
        positionModeSupported: status(snapshot.permissions.positionModeSupported),
      },
      latestSyncAt: snapshot.fetchedAt,
    };
  }

  dispose() {
    this.client = null;
  }
}

function status(value: boolean) {
  return value ? "ENABLED" as const : "DISABLED" as const;
}

export class BinanceAccountReadProviderFactory implements AccountReadProviderFactory {
  readonly venue = "binance" as const;

  constructor(
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BinanceReadOnlyClient =
      (secret) => new BinanceClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret }),
  ) {}

  create(secret: UserExchangeCredentialSecret) {
    return new BinanceAccountReadProvider(this.clientFactory(secret));
  }
}
