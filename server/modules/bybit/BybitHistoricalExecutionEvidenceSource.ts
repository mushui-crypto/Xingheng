import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  HistoricalExecutionEvidenceRequest,
  HistoricalExecutionEvidenceSource,
} from "../arbitrage-execution/HistoricalExecutionEvidence";
import { BybitClient } from "./BybitClient";
import { BybitInstrumentMappingAdapter } from "./BybitInstrumentMapping";
import { bybitOrderLinkIdFor } from "./BybitIntentExecutionService";

type CredentialStore = Pick<UserExchangeCredentialStore, "findSummary" | "loadForAccountRead">;
type EvidenceClient = Pick<BybitClient, "readHistoricalOrderEvidence" | "readActiveOrderCount">;

export class BybitHistoricalExecutionEvidenceSource implements HistoricalExecutionEvidenceSource {
  readonly venue = "bybit" as const;
  private readonly instruments = new BybitInstrumentMappingAdapter();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly clientFactory: (credential: Readonly<{ apiKey: string; apiSecret: string }>) => EvidenceClient =
      (credential) => new BybitClient(() => credential),
  ) {}

  async verify(request: HistoricalExecutionEvidenceRequest) {
    const { instance, executionRecord } = request;
    if (executionRecord.venue !== this.venue || instance.userId !== executionRecord.userId) {
      throw new Error("Historical execution evidence identity does not match Bybit.");
    }
    const summary = this.credentials.findSummary(instance.userId, this.venue);
    if (!summary || summary.accountId !== executionRecord.accountId) {
      throw new Error("Historical execution evidence account binding is unavailable.");
    }
    const secret = await this.credentials.loadForAccountRead(instance.userId, this.venue);
    const client = this.clientFactory({ apiKey: secret.apiKey, apiSecret: secret.apiSecret });
    const instrument = this.instruments.resolve(executionRecord.instrumentId).venueInstrument;
    const orderLinkId = bybitOrderLinkIdFor({
      userId: executionRecord.userId,
      accountId: executionRecord.accountId,
      intentId: executionRecord.intentId,
    });
    const exact = await client.readHistoricalOrderEvidence({
      category: instrument.category,
      symbol: instrument.symbol,
      orderLinkId,
      startedAt: executionRecord.createdAt,
    });
    const activeCounts = await Promise.all(instance.legs
      .filter((leg) => leg.venue === this.venue)
      .map((leg) => {
        const binding = this.instruments.resolve(leg.instrumentId).venueInstrument;
        return client.readActiveOrderCount(binding.category, binding.symbol);
      }));
    return Object.freeze({
      recoveryAnchorRequiredBeforeMutation: true,
      exactOrderEvidence: exact.exactOrderEvidence,
      activeOrderEvidence: activeCounts.every((count) => count === 0) ? "NONE" as const : "PRESENT" as const,
      checkedAt: exact.checkedAt,
    });
  }
}
