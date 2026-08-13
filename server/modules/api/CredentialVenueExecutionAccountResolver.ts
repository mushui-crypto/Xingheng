import type { ExecutionVenue } from "../cex/ExecutionIntent";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import {
  UserExchangeCredentialStoreError,
  type UserExchangeCredentialStore,
} from "../credentials/UserExchangeCredentialStore";
import type { VenueExecutionAccountResolver } from "./FundingArbitrageManualExecutionService";

export class CredentialVenueExecutionAccountResolver implements VenueExecutionAccountResolver {
  constructor(
    private readonly credentials: Pick<UserExchangeCredentialStore, "findSummary">,
  ) {}

  async resolve(userId: string, venue: ExecutionVenue, instrumentId: string) {
    const normalizedUserId = identifier(userId, "userId");
    const instrument = canonicalInstrumentFromId(instrumentId);
    if (instrument.baseAsset !== "XAUT") {
      throw new UserExchangeCredentialStoreError(
        "credential_not_configured",
        "Instrument is not configured for manual execution.",
      );
    }
    const summary = this.credentials.findSummary(normalizedUserId, venue);
    if (!summary) {
      throw new UserExchangeCredentialStoreError(
        "credential_not_configured",
        "Exchange credential is not configured for the authenticated user.",
      );
    }
    return Object.freeze({
      accountId: summary.accountId,
      quantityAsset: Object.freeze({ symbol: "XAUT", type: "RWA_ASSET" as const }),
    });
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new UserExchangeCredentialStoreError("credential_not_configured", `${name} is invalid.`);
  }
  return value.trim();
}
