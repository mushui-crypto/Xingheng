import type { BinanceStatus } from "../../../api/binancePersonalTrading";
import type { ExchangeCredentialSummary, ExchangeVenue } from "../../../api/exchangeCredentials";

export const exchangeVenues: Array<{ venue: ExchangeVenue; label: string; needsPassphrase: boolean }> = [
  { venue: "binance", label: "Binance", needsPassphrase: false },
  { venue: "bybit", label: "Bybit", needsPassphrase: false },
  { venue: "bitget", label: "Bitget", needsPassphrase: true },
  { venue: "okx", label: "OKX", needsPassphrase: true },
];

export function canEnterBinancePosition(status: BinanceStatus | null) {
  return Boolean(
    status?.credential.configured
    && status.connection.status === "connected"
    && status.risk.liveTradingEnabled
    && !status.risk.killSwitchActive,
  );
}

export function mergeCredentialSummaries(items: ExchangeCredentialSummary[]) {
  const summaries = new Map(items.map((item) => [item.venue, item]));
  return exchangeVenues.map(({ venue }) => summaries.get(venue) ?? {
    venue,
    configured: false,
    implemented: venue === "binance",
    accountId: null,
    accountFingerprint: null,
    maskedApiKey: null,
    permissions: {},
    lastVerifiedAt: null,
    message: null,
  });
}

export function createIdempotencyKey(action: string) {
  return `personal:${action}:${Date.now()}:${crypto.randomUUID()}`;
}
