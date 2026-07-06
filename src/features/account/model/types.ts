import type { WalletAccountType } from "../../../api/walletApi";
import { accountSections } from "./constants";

export type AccountSection = (typeof accountSections)[number];
export type QuickAction = "deposit" | "withdraw" | "transfer" | "internal-transfer" | "exchange";
export type TransferAccount = Extract<WalletAccountType, "wallet" | "funding" | "realTrading">;
export type LedgerTab = "ledger" | "deposits" | "withdrawals" | "transfers";
export type TradeOrderFilter = "all" | "buy" | "sell" | "filled" | "rejected";

export type OverviewFundingRow = {
  id: string;
  type: string;
  amount: number;
  asset: string;
  time: number;
  status: string;
};

export type EthereumProvider = {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (eventName: "accountsChanged" | "chainChanged", handler: (...args: unknown[]) => void) => void;
  removeListener?: (eventName: "accountsChanged" | "chainChanged", handler: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}
