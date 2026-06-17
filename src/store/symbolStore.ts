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
  resetSymbols: () => void;
};

const now = new Date().toISOString();

export const defaultTradeSymbols: TradeSymbol[] = [
  {
    id: "SYM-XAUUSD",
    symbol: "XAUUSD",
    displayName: "Gold",
    apiSymbol: "XAUUSD",
    category: "metal",
    digits: 2,
    spread: 0.3,
    leverage: 100,
    contractSize: 100,
    minLot: 0.01,
    maxLot: 10,
    lotStep: 0.01,
    tradeStatus: "enabled",
    quoteStatus: "stale",
    isVisible: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "SYM-EURUSD",
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    apiSymbol: "EURUSD",
    category: "forex",
    digits: 5,
    spread: 0.00012,
    leverage: 100,
    contractSize: 100000,
    minLot: 0.01,
    maxLot: 20,
    lotStep: 0.01,
    tradeStatus: "enabled",
    quoteStatus: "stale",
    isVisible: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "SYM-BTCUSDT",
    symbol: "BTCUSDT",
    displayName: "Bitcoin / USDT",
    apiSymbol: "BTCUSDT",
    category: "crypto",
    digits: 2,
    spread: 10,
    leverage: 20,
    contractSize: 1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
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

export const useSymbolStore = create<SymbolStore>((set, get) => ({
  symbols: readStorage<TradeSymbol[]>(storageKeys.tradeSymbols, defaultTradeSymbols),
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
  resetSymbols: () => {
    persist(defaultTradeSymbols);
    set({ symbols: defaultTradeSymbols });
  },
}));
