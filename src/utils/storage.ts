export const storageKeys = {
  users: "xingheng.users",
  auth: "xingheng.auth",
  adminAuth: "xingheng.adminAuth",
  rememberedCredentials: "xingheng.rememberedCredentials",
  config: "xingheng.config",
  tradeSymbols: "xingheng.tradeSymbols.v2",
  marketQuotes: "xingheng.marketQuotes.v2",
} as const;

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}
