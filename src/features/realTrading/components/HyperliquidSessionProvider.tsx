import { createContext, useContext, type ReactNode } from "react";
import { useAuthStore } from "../../../store/authStore";
import { useWalletConnectionStore } from "../../../store/walletConnectionStore";
import {
  useHyperliquidSessionSignerController,
  type HyperliquidSessionController,
} from "../lib/useHyperliquidSessionSigner";

const HyperliquidSessionContext = createContext<HyperliquidSessionController | null>(null);

export function HyperliquidSessionProvider({ children }: { children: ReactNode }) {
  const userId = useAuthStore((state) => state.currentUserId);
  const provider = useWalletConnectionStore((state) => state.provider);
  const walletAddress = useWalletConnectionStore((state) => state.address);
  const controller = useHyperliquidSessionSignerController(provider, walletAddress, userId);

  return (
    <HyperliquidSessionContext.Provider value={controller}>
      {children}
    </HyperliquidSessionContext.Provider>
  );
}

export function useHyperliquidSessionSigner() {
  const controller = useContext(HyperliquidSessionContext);
  if (!controller) {
    throw new Error("useHyperliquidSessionSigner 必须在 HyperliquidSessionProvider 内使用。");
  }
  return controller;
}
