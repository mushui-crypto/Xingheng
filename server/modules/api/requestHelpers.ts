import type express from "express";
import type { TradeSide, WalletAccountType } from "../../types";

export function getUserId(request: express.Request) {
  return request.user?.id ?? "demo-user";
}

export function getSimulationAccountId(request: express.Request) {
  const value = request.body?.simulationAccountId ?? request.query.simulationAccountId;
  return typeof value === "string" ? value.trim() : undefined;
}

export function normalizeSide(value: unknown): TradeSide {
  if (value !== "buy" && value !== "sell") {
    throw new Error("订单方向必须是 buy 或 sell。");
  }
  return value;
}

export function normalizeWalletAccountType(value: unknown): WalletAccountType {
  if (value !== "wallet" && value !== "funding" && value !== "trading" && value !== "simulation" && value !== "realTrading") {
    throw new Error("账户类型必须是 wallet、funding、trading、simulation 或 realTrading。");
  }
  return value;
}
