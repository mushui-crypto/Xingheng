import type { Quote, QuoteStatus } from "../types/market";

export function isQuoteValid(quote: Quote): boolean {
  return (
    quote.last > 0 &&
    quote.bid > 0 &&
    quote.ask > 0 &&
    quote.ask > quote.bid &&
    Number.isFinite(quote.timestamp) &&
    quote.timestamp > 0
  );
}

export function isQuoteStale(quote: Quote, staleSeconds: number): boolean {
  return Date.now() - new Date(quote.localUpdatedAt).getTime() > staleSeconds * 1000;
}

export function getQuoteStatus(quote: Quote, staleSeconds = 30): QuoteStatus {
  if (!isQuoteValid(quote)) {
    return "error";
  }

  if (quote.status === "delayed") {
    return "delayed";
  }

  if (isQuoteStale(quote, staleSeconds)) {
    return "stale";
  }

  return "normal";
}
