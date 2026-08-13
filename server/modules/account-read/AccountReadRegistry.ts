import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type { AccountReadProviderFactory } from "./AccountReadProvider";
import type { VenueAccountReadSnapshot } from "./AccountReadTypes";
import type { AccountReadValuation } from "./AccountUsdtValuationService";

type CredentialReader = Pick<UserExchangeCredentialStore, "loadForAccountRead">;

export class AccountReadRegistryError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class AccountReadRegistry {
  private readonly factories: ReadonlyMap<ExchangeVenue, AccountReadProviderFactory>;

  constructor(
    private readonly credentials: CredentialReader,
    factories: readonly AccountReadProviderFactory[],
    private readonly valuation?: AccountReadValuation,
  ) {
    this.factories = new Map(factories.map((factory) => [factory.venue, factory]));
  }

  async read(userId: string, venue: ExchangeVenue) {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new AccountReadRegistryError("authentication_required", "User authentication is required.");
    }
    const factory = this.factories.get(venue);
    if (!factory) {
      throw new AccountReadRegistryError(
        "account_read_provider_not_implemented",
        `${venue} private account read is not implemented.`,
      );
    }
    const secret = await this.credentials.loadForAccountRead(normalizedUserId, venue);
    const provider = factory.create(secret);
    let snapshot: VenueAccountReadSnapshot;
    try {
      snapshot = await provider.readAccount();
    } finally {
      await provider.dispose();
    }
    if (!this.valuation) return withoutValuation(snapshot);
    try {
      return await this.valuation.value(snapshot);
    } catch {
      return withoutValuation(snapshot);
    }
  }
}

function withoutValuation(snapshot: VenueAccountReadSnapshot) {
  return {
    ...snapshot,
    balances: snapshot.balances.map((balance) => ({
      ...balance,
      estimatedValueUsdt: null,
      valuationStatus: "UNAVAILABLE" as const,
    })),
    estimatedTotalValueUsdt: null,
    valuationCoverage: "UNAVAILABLE" as const,
  };
}
