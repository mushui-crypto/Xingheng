import { ExchangeClient, type IRequestTransport } from "@nktkas/hyperliquid";
import { BrowserProvider, Wallet, type Eip1193Provider, type HDNodeWallet, type JsonRpcSigner } from "ethers";
import { forwardSignedRealTradingExchange, type RealTradingMarginMode } from "../../../api/realTrading";

const agentName = "StellaX Session";

export type HyperliquidLimitOrderInput = {
  asset: number;
  isBuy: boolean;
  market: boolean;
  price: string;
  reduceOnly: boolean;
  size: string;
};

export type HyperliquidTriggerOrderInput = {
  asset: number;
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
    const response = await forwardSignedRealTradingExchange({
      network: "hyperliquid-testnet",
      masterAddress: this.masterAddress,
      action: signed.action as Record<string, unknown>,
      nonce: Number(signed.nonce),
      signature: signed.signature,
      vaultAddress: typeof signed.vaultAddress === "string" ? signed.vaultAddress : null,
      expiresAfter: typeof signed.expiresAfter === "number" ? signed.expiresAfter : null,
    });
    if (!response.ok) {
      throw new Error(response.message || "Hyperliquid Testnet 拒绝了交易请求。");
    }
    return response.result as T;
  }
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
    this.masterExchange = new ExchangeClient({ transport, wallet: masterSigner });
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
