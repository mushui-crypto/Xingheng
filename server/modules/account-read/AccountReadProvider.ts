import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";
import type { UserExchangeCredentialSecret } from "../credentials/UserExchangeCredentialStore";
import type { VenueAccountReadSnapshot } from "./AccountReadTypes";

export interface AccountReadProvider {
  readonly venue: ExchangeVenue;
  readAccount(): Promise<VenueAccountReadSnapshot>;
  dispose(): void | Promise<void>;
}

export interface AccountReadProviderFactory {
  readonly venue: ExchangeVenue;
  create(secret: UserExchangeCredentialSecret): AccountReadProvider;
}
