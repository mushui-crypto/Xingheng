import type { HyperliquidSessionState } from "../lib/useHyperliquidSessionSigner";

export type RealTradingSessionPresentation = {
  wallet: string;
  agent: string;
  signer: string;
  tone: "ready" | "pending" | "blocked";
};

export function resolveRealTradingSessionPresentation(input: {
  connected: boolean;
  signerCleared: boolean;
  state: HyperliquidSessionState;
}): RealTradingSessionPresentation {
  if (!input.connected) {
    return { wallet: "未连接", agent: "未授权", signer: "未初始化", tone: "blocked" };
  }
  if (input.state === "initializing") {
    return { wallet: "已连接", agent: "未授权", signer: "正在初始化", tone: "pending" };
  }
  if (input.state === "authorizing") {
    return { wallet: "已连接", agent: "等待授权签名", signer: "仅浏览器会话内存", tone: "pending" };
  }
  if (input.state === "authorized") {
    return { wallet: "已连接", agent: "已授权", signer: "可交易 · 会话内存", tone: "ready" };
  }
  if (input.state === "submitting") {
    return { wallet: "已连接", agent: "已授权", signer: "本地签名中", tone: "pending" };
  }
  if (input.signerCleared) {
    return { wallet: "已连接", agent: "需重新授权", signer: "刷新后已清除", tone: "blocked" };
  }
  return { wallet: "已连接", agent: "未授权", signer: "未初始化", tone: "blocked" };
}
