import { ExchangeClient, type IRequestTransport } from "@nktkas/hyperliquid";
import { BrowserProvider, Wallet, type Eip1193Provider, type HDNodeWallet, type JsonRpcSigner } from "ethers";
import { forwardSignedRealTradingExchange } from "../../../api/realTrading";

const agentName = "StellaX Session";

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

  placeOrder(input: { asset: number; isBuy: boolean; price: string; size: string; reduceOnly: boolean; market: boolean }) {
    return this.agentExchange.order({
      orders: [{
        a: input.asset,
        b: input.isBuy,
        p: input.price,
        s: input.size,
        r: input.reduceOnly,
        t: { limit: { tif: input.market ? "Ioc" : "Gtc" } },
      }],
      grouping: "na",
    });
  }

  cancelOrder(asset: number, oid: number) {
    return this.agentExchange.cancel({ cancels: [{ a: asset, o: oid }] });
  }

  updateLeverage(asset: number, leverage: number) {
    return this.agentExchange.updateLeverage({ asset, isCross: true, leverage });
  }
}

export function normalizeSdkError(error: unknown) {
  const message = error instanceof Error ? error.message : "真实交易操作失败。";
  const lower = message.toLowerCase();
  if (lower.includes("user rejected") || lower.includes("user denied") || lower.includes("4001")) return "用户拒绝了本地签名。";
  if (lower.includes("insufficient") || lower.includes("margin")) return "可用余额或保证金不足。";
  if (lower.includes("allow") || lower.includes("暂不允许")) return "后端安全 allowlist 尚未允许此动作。";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("timeout")) return "网络请求失败，请稍后重试。";
  return message;
}
