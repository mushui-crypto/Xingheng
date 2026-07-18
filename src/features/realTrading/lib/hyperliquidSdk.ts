import { ExchangeClient, type IRequestTransport } from "@nktkas/hyperliquid";
import { BrowserProvider, Wallet, type Eip1193Provider, type HDNodeWallet, type JsonRpcSigner } from "ethers";
import { forwardSignedRealTradingExchange, type RealTradingExchangeResponse, type RealTradingMarginMode } from "../../../api/realTrading";
import type { HyperliquidCloid } from "./hyperliquidCloid";

const agentName = "StellaX Session";
const hyperliquidTestnetSignatureChainId = "0x66eee" as const;

export type HyperliquidLimitOrderInput = {
  asset: number;
  cloid: HyperliquidCloid;
  isBuy: boolean;
  market: boolean;
  price: string;
  reduceOnly: boolean;
  size: string;
};

export type HyperliquidTriggerOrderInput = {
  asset: number;
  cloid: HyperliquidCloid;
  isBuy: boolean;
  price: string;
  size: string;
  tpsl: "sl" | "tp";
  triggerPrice: string;
};

class BackendExchangeTransport implements IRequestTransport<"exchange"> {
  readonly isTestnet = true;

  constructor(private readonly masterAddress: string) {}

  async request<T>(endpoint: "exchange", payload: unknown): Promise<T> {
    if (endpoint !== "exchange" || !payload || typeof payload !== "object") {
      throw new Error("只允许发送 Hyperliquid Testnet exchange 请求。");
    }
    const signed = payload as Record<string, unknown>;
    const action = signed.action as Record<string, unknown>;
    const clientRequestId = createRealTradingClientRequestId(action);
    const response = await forwardSignedRealTradingExchange({
      clientRequestId,
      network: "hyperliquid-testnet",
      masterAddress: this.masterAddress,
      action,
      nonce: Number(signed.nonce),
      signature: signed.signature,
      vaultAddress: typeof signed.vaultAddress === "string" ? signed.vaultAddress : null,
      expiresAfter: typeof signed.expiresAfter === "number" ? signed.expiresAfter : null,
    });
    if (isReconciliationResponse(response)) {
      throw new HyperliquidPendingReconciliationError(response.message || "订单结果暂未确认，正在等待交易所对账。", response);
    }
    if (!response.ok) {
      throw new Error(response.message || "Hyperliquid Testnet 拒绝了交易请求。");
    }
    return { result: response.result, stellaxReceipt: response } as T;
  }
}

export class HyperliquidPendingReconciliationError extends Error {
  readonly needsReconciliation = true;
  readonly receipt: RealTradingExchangeResponse;

  constructor(message: string, receipt: RealTradingExchangeResponse) {
    super(message);
    this.name = "HyperliquidPendingReconciliationError";
    this.receipt = receipt;
  }
}

export function isHyperliquidPendingReconciliationError(error: unknown): error is HyperliquidPendingReconciliationError {
  return error instanceof HyperliquidPendingReconciliationError
    || (Boolean(error) && typeof error === "object" && (error as { needsReconciliation?: unknown }).needsReconciliation === true);
}

export function getHyperliquidReconciliationReceipt(error: unknown) {
  if (error instanceof HyperliquidPendingReconciliationError) return error.receipt;
  if (!error || typeof error !== "object") return null;
  const receipt = (error as { receipt?: unknown }).receipt;
  return receipt && typeof receipt === "object" ? receipt as RealTradingExchangeResponse : null;
}

export function createRealTradingClientRequestId(action: Record<string, unknown>) {
  if (action.type === "order" && Array.isArray(action.orders)) {
    const primaryCloid = (action.orders[0] as Record<string, unknown> | undefined)?.c;
    if (typeof primaryCloid === "string" && /^0x[0-9a-fA-F]{32}$/.test(primaryCloid)) {
      return `rt-${primaryCloid.slice(2).toLowerCase()}`;
    }
  }
  const randomId = globalThis.crypto?.randomUUID?.();
  if (!randomId) throw new Error("当前浏览器缺少安全随机数能力，禁止发送真实交易动作。");
  return `rt-${randomId}`;
}

export class HyperliquidSessionSigner {
  readonly agentAddress: string;
  private readonly agentWallet: HDNodeWallet;
  private readonly agentExchange: ExchangeClient;
  private readonly masterExchange: ExchangeClient;

  private constructor(masterAddress: string, masterSigner: JsonRpcSigner) {
    const transport = new BackendExchangeTransport(masterAddress);
    this.agentWallet = Wallet.createRandom();
    this.agentAddress = this.agentWallet.address;
    this.masterExchange = new ExchangeClient({
      transport,
      wallet: masterSigner,
      signatureChainId: hyperliquidTestnetSignatureChainId,
    });
    this.agentExchange = new ExchangeClient({ transport, wallet: this.agentWallet });
  }

  static async create(provider: Eip1193Provider, expectedMasterAddress: string) {
    const browserProvider = new BrowserProvider(provider);
    const masterSigner = await browserProvider.getSigner();
    const masterAddress = await masterSigner.getAddress();
    if (masterAddress.toLowerCase() !== expectedMasterAddress.toLowerCase()) {
      throw new Error("当前钱包账户与页面连接的主账户不一致，请重新连接钱包。");
    }
    return new HyperliquidSessionSigner(masterAddress, masterSigner);
  }

  approveAgent() {
    return this.masterExchange.approveAgent({ agentAddress: this.agentAddress as `0x${string}`, agentName });
  }

  placeOrder(input: HyperliquidLimitOrderInput) {
    return this.placeOrders([input]);
  }

  placeOrders(inputs: HyperliquidLimitOrderInput[]) {
    return this.agentExchange.order({
      orders: inputs.map(toSdkLimitOrder),
      grouping: "na",
    });
  }

  placeOrderWithTpsl(entry: HyperliquidLimitOrderInput, triggers: HyperliquidTriggerOrderInput[]) {
    return this.agentExchange.order(buildEntryTpslOrderRequest(entry, triggers));
  }

  placePositionTpsl(triggers: HyperliquidTriggerOrderInput[]) {
    return this.agentExchange.order(buildPositionTpslOrderRequest(triggers));
  }

  cancelOrder(asset: number, oid: number) {
    return this.cancelOrders([{ asset, oid }]);
  }

  cancelOrders(orders: Array<{ asset: number; oid: number }>) {
    return this.agentExchange.cancel({ cancels: orders.map((order) => ({ a: order.asset, o: order.oid })) });
  }

  updateLeverage(asset: number, leverage: number, marginMode: RealTradingMarginMode = "cross") {
    return this.agentExchange.updateLeverage(buildUpdateLeverageRequest(asset, leverage, marginMode));
  }
}

export function buildUpdateLeverageRequest(asset: number, leverage: number, marginMode: RealTradingMarginMode) {
  return { asset, isCross: marginMode === "cross", leverage };
}

export function submitMarginLeverageUpdate(
  signer: Pick<HyperliquidSessionSigner, "updateLeverage">,
  asset: number,
  leverage: number,
  marginMode: RealTradingMarginMode,
) {
  return signer.updateLeverage(asset, leverage, marginMode);
}

function toSdkLimitOrder(input: HyperliquidLimitOrderInput) {
  return {
    a: input.asset,
    b: input.isBuy,
    c: input.cloid,
    p: input.price,
    s: input.size,
    r: input.reduceOnly,
    t: { limit: { tif: input.market ? "Ioc" as const : "Gtc" as const } },
  };
}

function toSdkTriggerOrder(input: HyperliquidTriggerOrderInput) {
  return {
    a: input.asset,
    b: input.isBuy,
    c: input.cloid,
    p: input.price,
    s: input.size,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: input.triggerPrice, tpsl: input.tpsl } },
  };
}

export function buildEntryTpslOrderRequest(
  entry: HyperliquidLimitOrderInput,
  triggers: HyperliquidTriggerOrderInput[],
) {
  return {
    orders: [toSdkLimitOrder(entry), ...triggers.map(toSdkTriggerOrder)],
    grouping: "normalTpsl" as const,
  };
}

export function buildPositionTpslOrderRequest(triggers: HyperliquidTriggerOrderInput[]) {
  return {
    orders: triggers.map(toSdkTriggerOrder),
    grouping: "positionTpsl" as const,
  };
}

export function normalizeSdkError(error: unknown) {
  const message = error instanceof Error ? error.message : "真实交易操作失败。";
  const lower = message.toLowerCase();
  if (
    lower.includes("user rejected")
    || lower.includes("user denied")
    || lower.includes("failed to sign the typed data using the wallet")
    || lower.includes("4001")
  ) return "用户拒绝了本地签名。";
  if (lower.includes("insufficient") || lower.includes("margin")) return "可用余额或保证金不足。";
  if (lower.includes("allow") || lower.includes("暂不允许")) return "后端安全 allowlist 尚未允许此动作。";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("timeout")) return "网络请求失败，请稍后重试。";
  if (lower.includes("trigger order has unexpected type")) return `TP/SL 订单组合被 Hyperliquid 拒绝：${message}`;
  return message;
}

function isReconciliationResponse(response: {
  lifecycleStatus?: string;
  needsReconciliation?: boolean;
  outcome?: string;
  reconciliationStatus?: string;
  reconcileRequired?: boolean;
}) {
  const status = `${response.lifecycleStatus ?? ""} ${response.reconciliationStatus ?? ""}`.toLowerCase();
  return response.reconcileRequired === true
    || response.needsReconciliation === true
    || response.outcome === "pending_reconciliation"
    || response.outcome === "partial"
    || status.includes("unknown")
    || status.includes("pending_reconciliation")
    || status.includes("needs_reconciliation")
    || status.includes("partial");
}
