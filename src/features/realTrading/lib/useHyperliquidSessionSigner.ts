import { useCallback, useEffect, useState } from "react";
import type { Eip1193Provider } from "ethers";
import { HyperliquidSessionSigner, normalizeSdkError } from "./hyperliquidSdk";

export type HyperliquidSessionState = "idle" | "initializing" | "authorizing" | "authorized" | "submitting";
export type HyperliquidSessionMessageTone = "error" | "success" | "";

export type HyperliquidSessionController = {
  authorize: () => Promise<HyperliquidSessionSigner | null>;
  authorized: boolean;
  busy: boolean;
  message: string;
  messageTone: HyperliquidSessionMessageTone;
  runAction: (action: (signer: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => Promise<boolean>;
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

  const runAction = useCallback(async (action: (activeSigner: HyperliquidSessionSigner) => Promise<unknown>, successMessage: string) => {
    const activeSigner = signer ?? await authorize();
    if (!activeSigner) return false;
    setMessageValue("");
    setMessageTone("");
    setState("submitting");
    try {
      await action(activeSigner);
      setState("authorized");
      setMessage(successMessage);
      return true;
    } catch (error) {
      setState("authorized");
      setError(normalizeSdkError(error));
      return false;
    }
  }, [authorize, setError, setMessage, signer]);

  return {
    authorize,
    authorized: state === "authorized" || state === "submitting",
    busy: state === "initializing" || state === "authorizing" || state === "submitting",
    message,
    messageTone,
    runAction,
    setError,
    setMessage,
    signer,
    state,
  };
}
