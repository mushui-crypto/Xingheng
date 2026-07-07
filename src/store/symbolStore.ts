import { create } from "zustand";
import type { QuoteStatus, TradeSymbol } from "../types/market";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";

type SymbolDraft = Omit<TradeSymbol, "id" | "quoteStatus" | "createdAt" | "updatedAt">;

type SymbolStore = {
  symbols: TradeSymbol[];
  getSymbolConfig: (symbol: string) => TradeSymbol | null;
  visibleSymbols: () => TradeSymbol[];
  addSymbol: (draft: SymbolDraft) => void;
  updateSymbol: (id: string, draft: SymbolDraft) => void;
  setTradeStatus: (id: string, tradeStatus: TradeSymbol["tradeStatus"]) => void;
  deleteSymbol: (id: string) => void;
  setQuoteStatus: (symbol: string, quoteStatus: QuoteStatus) => void;
  setSymbolsFromBackend: (symbols: TradeSymbol[]) => void;
  resetSymbols: () => void;
};

const now = new Date().toISOString();

export const defaultTradeSymbols: TradeSymbol[] = [
  {
    id: "SYM-BTCUSDT",
    symbol: "BTCUSDT",
    displayName: "BTC Perpetual",
    apiSymbol: "BTC",
    providerMarketId: "BTC",
    providerCoin: "BTC",
    sourceDex: "main",
    sourceType: "main",
    category: "crypto",
    digits: 2,
    spread: 10,
    leverage: 20,
    contractSize: 1,
    minLot: 0.001,
    maxLot: 10,
    lotStep: 0.001,
    tradeStatus: "enabled",
    quoteStatus: "stale",
    isVisible: true,
    createdAt: now,
    updatedAt: now,
  },
];

function persist(symbols: TradeSymbol[]) {
  writeStorage(storageKeys.tradeSymbols, symbols);
}

function loadMarketSymbols() {
  const saved = readStorage<unknown>(storageKeys.tradeSymbols, defaultTradeSymbols);
  const stored = Array.isArray(saved) ? saved.filter(isTradeSymbolRecord) : defaultTradeSymbols;
  const supported = new Set(defaultTradeSymbols.map((symbol) => symbol.symbol));
  const migrated = defaultTradeSymbols.map((defaultSymbol) => {
    const previous = stored.find((symbol) => symbol.symbol === defaultSymbol.symbol);
    return {
      ...defaultSymbol,
      tradeStatus: previous?.tradeStatus ?? defaultSymbol.tradeStatus,
      quoteStatus: previous?.quoteStatus ?? defaultSymbol.quoteStatus,
      isVisible: previous?.isVisible ?? defaultSymbol.isVisible,
      createdAt: previous?.createdAt ?? defaultSymbol.createdAt,
      updatedAt: previous?.updatedAt ?? defaultSymbol.updatedAt,
    };
  });

  if (
    stored.length !== migrated.length ||
    stored.some((symbol) => !supported.has(symbol.symbol)) ||
    JSON.stringify(stored) !== JSON.stringify(migrated)
  ) {
    persist(migrated);
  }

  return migrated;
}

function isTradeSymbolRecord(value: unknown): value is TradeSymbol {
  if (!value || typeof value !== "object") {
    return false;
  }

  const symbol = value as Partial<TradeSymbol>;
  return (
    typeof symbol.symbol === "string" &&
    typeof symbol.apiSymbol === "string" &&
    typeof symbol.providerMarketId === "string" &&
    typeof symbol.providerCoin === "string" &&
    typeof symbol.sourceDex === "string" &&
    (symbol.sourceType === "main" || symbol.sourceType === "hip3")
  );
}

export const useSymbolStore = create<SymbolStore>((set, get) => ({
  symbols: loadMarketSymbols(),
  getSymbolConfig: (symbol) =>
    get().symbols.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase()) ?? null,
  visibleSymbols: () => get().symbols.filter((item) => item.isVisible && item.tradeStatus !== "disabled"),
  addSymbol: (draft) => {
    const timestamp = new Date().toISOString();
    const symbol: TradeSymbol = {
      ...draft,
      id: `SYM-${Date.now().toString(36).toUpperCase()}`,
      symbol: draft.symbol.trim().toUpperCase(),
      apiSymbol: draft.apiSymbol.trim().toUpperCase(),
      quoteStatus: "stale",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const symbols = [symbol, ...get().symbols];
    persist(symbols);
    set({ symbols });
  },
  updateSymbol: (id, draft) => {
    const timestamp = new Date().toISOString();
    const symbols = get().symbols.map((item) =>
      item.id === id
        ? {
            ...item,
            ...draft,
            symbol: draft.symbol.trim().toUpperCase(),
            apiSymbol: draft.apiSymbol.trim().toUpperCase(),
            updatedAt: timestamp,
          }
        : item,
    );
    persist(symbols);
    set({ symbols });
  },
  setTradeStatus: (id, tradeStatus) => {
    const symbols = get().symbols.map((item) =>
      item.id === id ? { ...item, tradeStatus, updatedAt: new Date().toISOString() } : item,
    );
    persist(symbols);
    set({ symbols });
  },
  deleteSymbol: (id) => {
    const symbols = get().symbols.map((item) =>
      item.id === id ? { ...item, isVisible: false, tradeStatus: "disabled" as const, updatedAt: new Date().toISOString() } : item,
    );
    persist(symbols);
    set({ symbols });
  },
  setQuoteStatus: (symbol, quoteStatus) => {
    const current = get().symbols.find((item) => item.symbol === symbol);
    if (current?.quoteStatus === quoteStatus) {
      return;
    }
    const symbols = get().symbols.map((item) => (item.symbol === symbol ? { ...item, quoteStatus } : item));
    persist(symbols);
    set({ symbols });
  },
  setSymbolsFromBackend: (backendSymbols) => {
    const current = get().symbols;
    const symbols = backendSymbols.map((symbol) => {
      const previous = current.find((item) => item.symbol === symbol.symbol);
      return {
        ...symbol,
        quoteStatus: previous?.quoteStatus ?? symbol.quoteStatus,
        createdAt: previous?.createdAt ?? symbol.createdAt,
        updatedAt: new Date().toISOString(),
      };
    });
    persist(symbols);
    set({ symbols });
  },
  resetSymbols: () => {
    persist(defaultTradeSymbols);
    set({ symbols: defaultTradeSymbols });
  },
}));
