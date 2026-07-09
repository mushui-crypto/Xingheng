export type UserStatus = "active" | "disabled";
export type MarketStatus = "connected" | "stale" | "disconnected";
export type CandleInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";
export type TradeSide = "buy" | "sell";

export type User = {
  id: string;
  email: string;
  nickname?: string;
  status: UserStatus;
  createdAt: string;
  emailVerifiedAt?: string | null;
};

export type AuthState = {
  currentUserId: string | null;
  isLoggedIn: boolean;
};

export type AdminAuthState = {
  isAdminLoggedIn: boolean;
};
