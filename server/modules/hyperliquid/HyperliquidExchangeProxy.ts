import { hyperliquidTestnetNetwork } from "./hyperliquidConfig";
import type { RealTradingExchangeRequest } from "./hyperliquidTypes";
import { normalizeAddress } from "./HyperliquidInfoClient";

const requestTimeoutMs = 15_000;
const allowedExchangeActionTypes = new Set(["order", "cancel", "updateLeverage", "approveAgent"]);
const forbiddenActionWords = [
  "withdraw",
  "transfer",
  "staking",
  "builder",
  "fee",
  "usdClassTransfer",
  "spotSend",
  "sendAsset",
  "subAccountTransfer",
];

export class HyperliquidExchangeProxy {
  constructor(private baseUrl: string) {}

  async forward(input: unknown) {
    const request = normalizeExchangeRequest(input);
    assertAllowedAction(request.action);
    console.info("[real-trading] forwarding signed exchange action", {
      network: request.network,
      actionType: request.action.type,
      masterAddress: maskAddress(request.masterAddress),
      vaultAddress: request.vaultAddress ? maskAddress(request.vaultAddress) : null,
    });
    const response = await fetch(new URL("/exchange", this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: request.action,
        nonce: request.nonce,
        signature: request.signature,
        vaultAddress: request.vaultAddress ?? null,
        ...(request.expiresAfter ? { expiresAfter: request.expiresAfter } : {}),
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const result = await response.json().catch(async () => ({ message: (await response.text().catch(() => "")).slice(0, 200) }));
    if (!response.ok) {
      return {
        ok: false,
        network: hyperliquidTestnetNetwork,
        status: response.status,
        message: normalizeProviderError(result),
        timestamp: Date.now(),
      };
    }
    return {
      ok: true,
      network: hyperliquidTestnetNetwork,
      result,
      timestamp: Date.now(),
    };
  }
}

export function normalizeExchangeRequest(input: unknown): RealTradingExchangeRequest {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const network = value.network;
  if (network !== hyperliquidTestnetNetwork) {
    throw new Error("真实交易第一阶段只允许 hyperliquid-testnet。");
  }
  const action = value.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("exchange action 必须是对象。");
  }
  const nonce = Number(value.nonce);
  if (!Number.isSafeInteger(nonce) || nonce <= 0) {
    throw new Error("exchange nonce 不正确。");
  }
  if (!value.signature || typeof value.signature !== "object") {
    throw new Error("exchange signature 缺失。");
  }
  const vaultAddress = value.vaultAddress === undefined || value.vaultAddress === null || value.vaultAddress === ""
    ? null
    : normalizeAddress(value.vaultAddress);
  const expiresAfter = value.expiresAfter === undefined || value.expiresAfter === null || value.expiresAfter === ""
    ? null
    : Number(value.expiresAfter);
  if (expiresAfter !== null && (!Number.isSafeInteger(expiresAfter) || expiresAfter <= 0)) {
    throw new Error("exchange expiresAfter 不正确。");
  }
  return {
    masterAddress: normalizeAddress(value.masterAddress),
    network,
    action: action as Record<string, unknown>,
    nonce,
    signature: value.signature,
    vaultAddress,
    expiresAfter,
  };
}

function assertAllowedAction(action: Record<string, unknown>) {
  const type = String(action.type ?? "");
  if (!allowedExchangeActionTypes.has(type)) {
    throw new Error(`exchange action ${type || "(empty)"} 暂不允许。`);
  }
  if (type === "approveAgent") {
    assertApproveAgentAction(action);
  }
  if (type === "updateLeverage") {
    assertUpdateLeverageAction(action);
  }
  const lowerPayload = JSON.stringify(action).toLowerCase();
  for (const word of forbiddenActionWords) {
    if (lowerPayload.includes(word.toLowerCase())) {
      throw new Error("资金转移、staking、builder fee 等 exchange action 暂不允许。");
    }
  }
}

function assertApproveAgentAction(action: Record<string, unknown>) {
  if (action.hyperliquidChain !== "Testnet") {
    throw new Error("approveAgent 仅允许 Hyperliquid Testnet。");
  }
  normalizeAddress(action.agentAddress);
}

function assertUpdateLeverageAction(action: Record<string, unknown>) {
  if (action.type !== "updateLeverage") {
    throw new Error("updateLeverage action type 不正确。");
  }
  if (!Number.isSafeInteger(action.asset) || Number(action.asset) < 0) {
    throw new Error("updateLeverage asset 必须是大于等于 0 的安全整数。");
  }
  if (typeof action.isCross !== "boolean") {
    throw new Error("updateLeverage isCross 必须是布尔值。");
  }
  if (!Number.isSafeInteger(action.leverage) || Number(action.leverage) < 1 || Number(action.leverage) > 50) {
    throw new Error("updateLeverage leverage 必须是 1 到 50 的安全整数。");
  }
}

function normalizeProviderError(result: unknown) {
  if (result && typeof result === "object" && "message" in result) {
    return String((result as { message?: unknown }).message ?? "Hyperliquid exchange request failed.");
  }
  return "Hyperliquid exchange request failed.";
}

function maskAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
