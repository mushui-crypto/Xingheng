export const storageKeys = {
  users: "xingheng.users",
  auth: "xingheng.auth",
  adminAuth: "xingheng.adminAuth",
  rememberedEmail: "xingheng.rememberedEmail",
  config: "xingheng.config",
  tradeSymbols: "xingheng.tradeSymbols.v2",
  marketQuotes: "xingheng.marketQuotes.v2",
} as const;

removeLegacySensitiveStorage();

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

function removeLegacySensitiveStorage() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem("xingheng.rememberedCredentials");
    sanitizeAuthStorage("xingheng.auth", ["currentUserId", "isLoggedIn"]);
    sanitizeAuthStorage("xingheng.adminAuth", ["isAdminLoggedIn"]);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function sanitizeAuthStorage(key: string, allowedKeys: string[]) {
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const sanitized = Object.fromEntries(allowedKeys.map((allowedKey) => [allowedKey, parsed[allowedKey]]));
  window.localStorage.setItem(key, JSON.stringify(sanitized));
}
