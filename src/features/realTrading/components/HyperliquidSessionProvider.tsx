import { createContext, useContext, type ReactNode } from "react";
import { useRuntimeEnvironment } from "../../runtimeEnvironment/RuntimeEnvironmentProvider";
import { runtimeEnvironmentAllowsSensitiveOperations } from "../../runtimeEnvironment/runtimeEnvironmentState";
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
  const { state: runtimeEnvironment } = useRuntimeEnvironment();
  const sensitiveEnvironmentReady = runtimeEnvironmentAllowsSensitiveOperations(runtimeEnvironment);
  const controller = useHyperliquidSessionSignerController(
    sensitiveEnvironmentReady ? provider : null,
    sensitiveEnvironmentReady ? walletAddress : "",
    sensitiveEnvironmentReady ? userId : null,
  );

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
