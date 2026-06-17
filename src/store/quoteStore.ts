import { create } from "zustand";
import { refreshQuoteFromPublicApi } from "../services/marketDataService";
import type { Quote } from "../types/market";
import { getQuoteStatus } from "../utils/marketStatus";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";
import { useSymbolStore } from "./symbolStore";

type QuoteStore = {
  quotes: Quote[];
  getQuoteBySymbol: (symbol: string) => Quote | null;
  refreshQuote: (symbol: string) => Promise<Quote | null>;
  refreshAllQuotes: () => Promise<void>;
  updateStatuses: () => void;
};

function persist(quotes: Quote[]) {
  writeStorage(storageKeys.marketQuotes, quotes);
}

export const useQuoteStore = create<QuoteStore>((set, get) => ({
  quotes: readStorage<Quote[]>(storageKeys.marketQuotes, []),
  getQuoteBySymbol: (symbol) =>
    get().quotes.find((quote) => quote.symbol.toUpperCase() === symbol.toUpperCase()) ?? null,
  refreshQuote: async (symbol) => {
    const symbolConfig = useSymbolStore.getState().getSymbolConfig(symbol);
    if (!symbolConfig) {
      return null;
    }

    const previous = get().getQuoteBySymbol(symbolConfig.symbol);
    const quote = await refreshQuoteFromPublicApi(symbolConfig, previous);
    const quotes = [quote, ...get().quotes.filter((item) => item.symbol !== quote.symbol)];
    persist(quotes);
    set({ quotes });
    useSymbolStore.getState().setQuoteStatus(quote.symbol, quote.status);
    return quote;
  },
  refreshAllQuotes: async () => {
    const symbols = useSymbolStore.getState().symbols.filter((item) => item.isVisible);
    for (const symbol of symbols) {
      await get().refreshQuote(symbol.symbol);
    }
  },
  updateStatuses: () => {
    const quotes = get().quotes.map((quote) => ({ ...quote, status: getQuoteStatus(quote) }));
    const changed = quotes.some((quote, index) => quote.status !== get().quotes[index]?.status);
    if (!changed) {
      return;
    }
    persist(quotes);
    set({ quotes });
    quotes.forEach((quote) => useSymbolStore.getState().setQuoteStatus(quote.symbol, quote.status));
  },
}));
