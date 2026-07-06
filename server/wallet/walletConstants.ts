import type { FundingOrderType, WalletAccountType, WalletNetwork } from "../types";

export const defaultUserId = "demo-user";
export const asset = "USDT";
export const depositNetwork: WalletNetwork = "BSC_TESTNET";
export const simulationAccountLimit = 5;
export const simulationInitialBalance = 100_000;
export const simulationResetCooldownMs = 24 * 60 * 60 * 1000;

export type TransferSide = WalletAccountType;
export type NormalizedTransferSide = "wallet" | "funding" | "simulation" | "realTrading";
export type FundingOrderFilter = "all" | "deposit" | "withdrawal" | "transfer" | FundingOrderType;
