import { useCallback, useEffect, useRef, useState } from "react";
import type { Eip1193Provider } from "ethers";
import { getHyperliquidReconciliationReceipt, HyperliquidSessionSigner, isHyperliquidPendingReconciliationError, normalizeSdkError } from "./hyperliquidSdk";
import {
  hyperliquidSignatureChain,
  subscribeWalletChainChanged,
  switchToHyperliquidSignatureNetwork,
  WalletNetworkRequiredError,
  WalletNetworkSwitchRejectedError,
} from "./walletNetwork";
import { resolveHyperliquidSessionIdentityChange, type HyperliquidSessionIdentity } from "./sessionIdentity";

export type HyperliquidSessionState = "idle" | "initializing" | "authorizing" | "authorized" | "submitting";
export type HyperliquidSessionMessageTone = "error" | "success" | "";

export type HyperliquidActionResult = {
  completed: boolean;
  error?: string;
  reconciliationRequired?: boolean;
  reconciliationRequestId?: string;
  reconciliationCloids?: string[];
  result?: unknown;
};

export type HyperliquidSessionController = {
  authorize: () => Promise<HyperliquidSessionSigner | null>;
  authorized: boolean;
  busy: boolean;
  message: string;
  messageTone: HyperliquidSessionMessageTone;
  networkGate: HyperliquidNetworkGateState;
  cancelNetworkSwitch: () => void;
  runAction: (action: (signer: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => Promise<boolean>;
  runActionResult: (action: (signer: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => Promise<HyperliquidActionResult>;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  signer: HyperliquidSessionSigner | null;
  state: HyperliquidSessionState;
  switchNetwork: () => Promise<boolean>;
};

export type HyperliquidNetworkGateState = {
  currentChainId: string | null;
  error: string;
  open: boolean;
  switching: boolean;
};

export function useHyperliquidSessionSignerController(
  provider: Eip1193Provider | null,
  walletAddress: string,
  userId: string | null,
): HyperliquidSessionController {
  const [state, setState] = useState<HyperliquidSessionState>("idle");
  const [signer, setSigner] = useState<HyperliquidSessionSigner | null>(null);
  const [message, setMessageValue] = useState("");
  const [messageTone, setMessageTone] = useState<HyperliquidSessionMessageTone>("");
  const [networkGate, setNetworkGate] = useState<HyperliquidNetworkGateState>({ currentChainId: null, error: "", open: false, switching: false });
  const sessionGenerationRef = useRef(0);
  const signerRef = useRef<HyperliquidSessionSigner | null>(null);
  const stateRef = useRef<HyperliquidSessionState>("idle");
  const sessionIdentityRef = useRef<HyperliquidSessionIdentity<Eip1193Provider>>({ provider, userId, walletAddress });

  useEffect(() => {
    signerRef.current = signer;
    stateRef.current = state;
  }, [signer, state]);

  useEffect(() => {
    const currentIdentity = { provider, userId, walletAddress };
    const identityChange = resolveHyperliquidSessionIdentityChange(
      sessionIdentityRef.current,
      currentIdentity,
      signerRef.current !== null || stateRef.current !== "idle",
    );
    sessionIdentityRef.current = currentIdentity;
    if (!identityChange.changed) return;

    sessionGenerationRef.current += 1;
    setSigner(null);
    setState("idle");
    setNetworkGate({ currentChainId: null, error: "", open: false, switching: false });
    setMessageValue(identityChange.message);
    setMessageTone("");
  }, [provider, userId, walletAddress]);

  useEffect(() => {
    if (!provider) return;
    return subscribeWalletChainChanged(provider, (chainId) => {
      sessionGenerationRef.current += 1;
      setSigner(null);
      setState("idle");
      setNetworkGate({
        currentChainId: chainId,
        error: "",
        open: chainId !== hyperliquidSignatureChain.chainId,
        switching: false,
      });
      setMessageValue(chainId === hyperliquidSignatureChain.chainId
        ? "钱包已切换到 Arbitrum Sepolia，请重新确认原操作。"
        : "钱包网络已变化，Agent 授权需要 Arbitrum Sepolia。");
      setMessageTone("");
    });
  }, [provider]);

  const cancelNetworkSwitch = useCallback(() => {
    if (networkGate.switching) return;
    setNetworkGate((current) => ({ ...current, error: "", open: false }));
  }, [networkGate.switching]);

  const switchNetwork = useCallback(async () => {
    if (!provider) return false;
    setNetworkGate((current) => ({ ...current, error: "", switching: true }));
    try {
      const chainId = await switchToHyperliquidSignatureNetwork(provider);
      sessionGenerationRef.current += 1;
      setSigner(null);
      setState("idle");
      setNetworkGate({ currentChainId: chainId, error: "", open: false, switching: false });
      setMessageValue("钱包已切换到 Arbitrum Sepolia，请重新确认原操作以完成 Agent 授权。");
      setMessageTone("");
      return true;
    } catch (error) {
      const message = error instanceof WalletNetworkSwitchRejectedError ? error.message : error instanceof Error ? error.message : "钱包网络切换失败，请重试。";
      setNetworkGate((current) => ({ ...current, error: message, open: true, switching: false }));
      return false;
    }
  }, [provider]);

  const setMessage = useCallback((nextMessage: string) => {
    setMessageValue(nextMessage);
    setMessageTone(nextMessage ? "success" : "");
  }, []);

  const setError = useCallback((nextMessage: string) => {
    setMessageValue(nextMessage);
    setMessageTone(nextMessage ? "error" : "");
  }, []);

  const authorize = useCallback(async () => {
    if (!provider || !walletAddress) {
      setError("未检测到钱包签名器。");
      return null;
    }
    setMessageValue("");
    setMessageTone("");
    try {
      const generation = sessionGenerationRef.current;
      setState("initializing");
      const nextSigner = await HyperliquidSessionSigner.create(provider, walletAddress);
      setState("authorizing");
      await nextSigner.approveAgent();
      if (generation !== sessionGenerationRef.current) return null;
      setSigner(nextSigner);
      setState("authorized");
      setMessage(`会话 API wallet 已授权：${nextSigner.agentAddress.slice(0, 6)}...${nextSigner.agentAddress.slice(-4)}`);
      return nextSigner;
    } catch (error) {
      setSigner(null);
      setState("idle");
      if (error instanceof WalletNetworkRequiredError) {
        setNetworkGate({ currentChainId: error.currentChainId, error: "", open: true, switching: false });
        return null;
      }
      setError(normalizeSdkError(error));
      return null;
    }
  }, [provider, setError, setMessage, walletAddress]);

  const runActionResult = useCallback(async (action: (activeSigner: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string): Promise<HyperliquidActionResult> => {
    const activeSigner = signer ?? await authorize();
    if (!activeSigner) return { completed: false, error: "会话签名器未授权。" };
    setMessageValue("");
    setMessageTone("");
    setState("submitting");
    try {
      const result = await action(activeSigner);
      setState("authorized");
      setMessage(successMessage);
      return { completed: true, result };
    } catch (error) {
      setState("authorized");
      const normalizedError = normalizeSdkError(error);
      setError(normalizedError);
      const receipt = getHyperliquidReconciliationReceipt(error);
      return {
        completed: false,
        error: normalizedError,
        reconciliationRequired: isHyperliquidPendingReconciliationError(error),
        reconciliationRequestId: receipt?.requestId,
        reconciliationCloids: receipt?.cloids ?? (receipt?.cloid ? [receipt.cloid] : undefined),
      };
    }
  }, [authorize, setError, setMessage, signer]);

  const runAction = useCallback(async (action: (activeSigner: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => (
    await runActionResult(action, successMessage)
  ).completed, [runActionResult]);

  return {
    authorize,
    authorized: Boolean(signer) && (state === "authorized" || state === "submitting"),
    busy: state === "initializing" || state === "authorizing" || state === "submitting",
    cancelNetworkSwitch,
    message,
    messageTone,
    networkGate,
    runAction,
    runActionResult,
    setError,
    setMessage,
    signer,
    state,
    switchNetwork,
  };
}
