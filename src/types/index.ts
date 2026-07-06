export type UserStatus = "active" | "disabled";
export type MarketStatus = "connected" | "stale" | "disconnected";
export type CandleInterval = "1m" | "5m" | "15m" | "1h";
export type TradeSide = "buy" | "sell";

export type User = {
  id: string;
  email: string;
  nickname?: string;
  status: UserStatus;
  createdAt: string;
};

export type AuthState = {
  currentUserId: string | null;
  isLoggedIn: boolean;
};

export type AdminAuthState = {
  isAdminLoggedIn: boolean;
};
