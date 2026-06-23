import { fetchTicker } from "../api/market";
import type { Quote, TradeSymbol } from "../types/market";
import { getQuoteStatus } from "../utils/marketStatus";
import { calculateBidAsk, roundByDigits } from "../utils/price";

const fallbackLast: Record<string, number> = {
  BTCUSDT: 64000,
};

export async function refreshQuoteFromPublicApi(symbolConfig: TradeSymbol, previous?: Quote | null): Promise<Quote> {
  try {
    const ticker = await fetchTicker(symbolConfig.apiSymbol || symbolConfig.symbol);
    const last = normalizePrice(ticker.last ?? previous?.last ?? fallbackLast[symbolConfig.symbol] ?? 1, symbolConfig.digits);
    const apiBid = ticker.bid;
    const apiAsk = ticker.ask;
    const generated = calculateBidAsk(last, symbolConfig.spread, symbolConfig.digits);
    const bid = Number.isFinite(apiBid) && Number(apiBid) > 0 ? roundByDigits(Number(apiBid), symbolConfig.digits) : generated.bid;
    const ask = Number.isFinite(apiAsk) && Number(apiAsk) > bid ? roundByDigits(Number(apiAsk), symbolConfig.digits) : generated.ask;
    const open = previous?.open ?? ticker.last ?? last;
    const quote: Quote = {
      symbol: symbolConfig.symbol,
      apiSymbol: symbolConfig.apiSymbol,
      last,
      bid,
      ask,
      spread: roundByDigits(ask - bid, symbolConfig.digits),
      change: roundByDigits(last - open, symbolConfig.digits),
      changePercent: open > 0 ? Number((((last - open) / open) * 100).toFixed(2)) : 0,
      high: previous?.high ? Math.max(previous.high, last) : last,
      low: previous?.low ? Math.min(previous.low, last) : last,
      open,
      timestamp: ticker.timestamp ?? Date.now(),
      localUpdatedAt: new Date().toISOString(),
      source: ticker.source ?? "public_api",
      status: ticker.status === "stale" ? "stale" : ticker.status === "disconnected" ? "error" : "normal",
    };

    return { ...quote, status: getQuoteStatus(quote) };
  } catch {
    return buildFallbackQuote(symbolConfig, previous, "error");
  }
}

export function buildFallbackQuote(symbolConfig: TradeSymbol, previous?: Quote | null, status: Quote["status"] = "normal") {
  const base = previous?.last ?? fallbackLast[symbolConfig.symbol] ?? 100;
  const drift = (Math.random() - 0.5) * symbolConfig.spread * 1.6;
  const last = normalizePrice(base + drift, symbolConfig.digits);
  const { bid, ask } = calculateBidAsk(last, symbolConfig.spread, symbolConfig.digits);
  const open = previous?.open ?? last;
  const quote: Quote = {
    symbol: symbolConfig.symbol,
    apiSymbol: symbolConfig.apiSymbol,
    last,
    bid,
    ask,
    spread: roundByDigits(ask - bid, symbolConfig.digits),
    change: roundByDigits(last - open, symbolConfig.digits),
    changePercent: open > 0 ? Number((((last - open) / open) * 100).toFixed(2)) : 0,
    high: previous?.high ? Math.max(previous.high, last) : last,
    low: previous?.low ? Math.min(previous.low, last) : last,
    open,
    timestamp: Date.now(),
    localUpdatedAt: new Date().toISOString(),
    source: "local_fallback",
    status,
  };

  return { ...quote, status: getQuoteStatus(quote) };
}

function normalizePrice(value: number, digits: number) {
  const safe = Number.isFinite(value) && value > 0 ? value : 1;
  return roundByDigits(safe, digits);
}
