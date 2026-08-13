import type { UserExchangeCredentialStore } from "../../credentials/UserExchangeCredentialStore";
import type { FundingOpportunityReadVenue } from "../funding-arbitrage/CanonicalFundingOpportunitySource";
import type { ArbitrageInstanceQueryService } from "./ArbitrageInstanceQueryService";
import { ArbitragePositionVerificationService } from "./ArbitragePositionVerificationService";
import {
  CatalogVerificationInstrumentResolver,
  createVenueArbitrageLegReadProviderFactories,
  type ArbitrageVerificationClientFactories,
} from "./VenueArbitrageLegReadProviders";

export type DefaultArbitragePositionVerificationOptions = Readonly<{
  query: ArbitrageInstanceQueryService;
  credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForAccountRead">;
  readVenues: readonly FundingOpportunityReadVenue[];
  clients?: ArbitrageVerificationClientFactories;
  now?: () => number;
}>;

export function createDefaultArbitragePositionVerificationService(
  options: DefaultArbitragePositionVerificationOptions,
) {
  const instruments = new CatalogVerificationInstrumentResolver(
    options.readVenues.map((venue) => venue.instrumentCatalog),
  );
  return new ArbitragePositionVerificationService(
    options.query,
    options.credentials,
    createVenueArbitrageLegReadProviderFactories(instruments, options.clients),
    options.now,
  );
}
