import type {
  CanonicalAccountSnapshot,
  CanonicalFundingRate,
  CanonicalInstrument,
  CanonicalOrder,
  CanonicalOrderRequest,
  CanonicalOrderScope,
  CanonicalTopOfBook,
  CexVenue,
} from "./CexCanonicalModels";

export interface InstrumentCatalogPort {
  readonly venue: CexVenue;
  getInstrument(instrumentId: string): Promise<CanonicalInstrument | null>;
  listInstruments(): Promise<CanonicalInstrument[]>;
}

export interface MarketDataPort {
  readonly venue: CexVenue;
  getTopOfBook(instrumentId: string): Promise<CanonicalTopOfBook>;
}

export interface FundingRatePort {
  readonly venue: CexVenue;
  getFundingRate(instrumentId: string): Promise<CanonicalFundingRate>;
}

export interface AccountReadPort {
  readonly venue: CexVenue;
  getAccountSnapshot(): Promise<CanonicalAccountSnapshot>;
}

export interface OrderExecutionPort {
  readonly venue: CexVenue;
  placeOrder(request: CanonicalOrderRequest): Promise<{ providerOrderId: string; clientOrderId: string }>;
  cancelOrder(scope: CanonicalOrderScope, providerOrderId: string): Promise<void>;
}

export interface OrderQueryPort {
  readonly venue: CexVenue;
  findByClientOrderId(scope: CanonicalOrderScope, clientOrderId: string): Promise<CanonicalOrder | null>;
  awaitOrder(scope: CanonicalOrderScope, providerOrderId: string, deadlineAt: number): Promise<CanonicalOrder>;
}
