import { useCallback, useEffect, useState } from "react";
import type { Eip1193Provider } from "ethers";
import { getHyperliquidReconciliationReceipt, HyperliquidSessionSigner, isHyperliquidPendingReconciliationError, normalizeSdkError } from "./hyperliquidSdk";

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
  runAction: (action: (signer: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => Promise<boolean>;
  runActionResult: (action: (signer: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => Promise<HyperliquidActionResult>;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  signer: HyperliquidSessionSigner | null;
  state: HyperliquidSessionState;
};

export function useHyperliquidSessionSigner(provider: Eip1193Provider | null, walletAddress: string): HyperliquidSessionController {
  const [state, setState] = useState<HyperliquidSessionState>("idle");
  const [signer, setSigner] = useState<HyperliquidSessionSigner | null>(null);
  const [message, setMessageValue] = useState("");
  const [messageTone, setMessageTone] = useState<HyperliquidSessionMessageTone>("");

  useEffect(() => {
    setSigner(null);
    setState("idle");
    setMessageValue(walletAddress ? "钱包地址已变化，需要重新初始化会话签名器。" : "");
    setMessageTone("");
  }, [provider, walletAddress]);

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
      setState("initializing");
      const nextSigner = await HyperliquidSessionSigner.create(provider, walletAddress);
      setState("authorizing");
      await nextSigner.approveAgent();
      setSigner(nextSigner);
      setState("authorized");
      setMessage(`会话 API wallet 已授权：${nextSigner.agentAddress.slice(0, 6)}...${nextSigner.agentAddress.slice(-4)}`);
      return nextSigner;
    } catch (error) {
      setSigner(null);
      setState("idle");
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
    authorized: state === "authorized" || state === "submitting",
    busy: state === "initializing" || state === "authorizing" || state === "submitting",
    message,
    messageTone,
    runAction,
    runActionResult,
    setError,
    setMessage,
    signer,
    state,
  };
}
