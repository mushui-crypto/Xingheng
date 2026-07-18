import type { Eip1193Provider } from "ethers";

export const hyperliquidSignatureChain = {
  blockExplorerUrls: ["https://sepolia.arbiscan.io"],
  chainId: "0x66eee",
  chainName: "Arbitrum Sepolia",
  nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
  rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
} as const;

export class WalletNetworkRequiredError extends Error {
  readonly currentChainId: string;

  constructor(currentChainId: string) {
    super("Agent 授权需要先切换到 Arbitrum Sepolia。");
    this.name = "WalletNetworkRequiredError";
    this.currentChainId = currentChainId;
  }
}

export class WalletNetworkSwitchRejectedError extends Error {
  constructor() {
    super("已取消钱包网络切换。");
    this.name = "WalletNetworkSwitchRejectedError";
  }
}

type EventedEip1193Provider = Eip1193Provider & {
  on?: (event: "chainChanged", listener: (chainId: unknown) => void) => void;
  removeListener?: (event: "chainChanged", listener: (chainId: unknown) => void) => void;
};

export async function assertHyperliquidSignatureNetwork(provider: Eip1193Provider) {
  const currentChainId = await readWalletChainId(provider);
  if (currentChainId !== hyperliquidSignatureChain.chainId) {
    throw new WalletNetworkRequiredError(currentChainId);
  }
  return currentChainId;
}

export async function readWalletChainId(provider: Eip1193Provider) {
  return normalizeWalletChainId(await provider.request({ method: "eth_chainId" }));
}

export function normalizeWalletChainId(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("无法读取当前钱包网络，请重试。");
  }
  return `0x${BigInt(value).toString(16)}`;
}

export async function switchToHyperliquidSignatureNetwork(provider: Eip1193Provider) {
  try {
    await requestSwitch(provider);
  } catch (error) {
    const code = findProviderErrorCode(error);
    if (isUserRejectedCode(code)) throw new WalletNetworkSwitchRejectedError();
    if (code !== "4902") throw new Error("钱包网络切换失败，请重试。");

    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ ...hyperliquidSignatureChain }],
      });
    } catch (addError) {
      if (isUserRejectedCode(findProviderErrorCode(addError))) throw new WalletNetworkSwitchRejectedError();
      throw new Error("无法添加 Arbitrum Sepolia，请检查钱包后重试。");
    }

    if (await readWalletChainId(provider) !== hyperliquidSignatureChain.chainId) {
      try {
        await requestSwitch(provider);
      } catch (switchError) {
        if (isUserRejectedCode(findProviderErrorCode(switchError))) throw new WalletNetworkSwitchRejectedError();
        throw new Error("钱包网络切换失败，请重试。");
      }
    }
  }

  const currentChainId = await readWalletChainId(provider);
  if (currentChainId !== hyperliquidSignatureChain.chainId) {
    throw new Error("钱包仍未切换到 Arbitrum Sepolia，请重试。");
  }
  return currentChainId;
}

export function subscribeWalletChainChanged(provider: Eip1193Provider, listener: (chainId: `0x${string}` | null) => void) {
  const eventedProvider = provider as EventedEip1193Provider;
  if (!eventedProvider.on) return () => undefined;
  const handleChainChanged = (value: unknown) => {
    try {
      listener(normalizeWalletChainId(value));
    } catch {
      listener(null);
    }
  };
  eventedProvider.on("chainChanged", handleChainChanged);
  return () => eventedProvider.removeListener?.("chainChanged", handleChainChanged);
}

export function formatWalletNetwork(chainId: string | null) {
  if (!chainId) return "未知网络";
  if (chainId === hyperliquidSignatureChain.chainId) return "Arbitrum Sepolia · 421614";
  try {
    return `Chain ID ${BigInt(chainId).toString(10)}`;
  } catch {
    return chainId;
  }
}

function requestSwitch(provider: Eip1193Provider) {
  return provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hyperliquidSignatureChain.chainId }],
  });
}

function findProviderErrorCode(error: unknown) {
  const visited = new Set<object>();
  function visit(value: unknown, depth: number): string | null {
    if (!value || typeof value !== "object" || depth > 4 || visited.has(value)) return null;
    visited.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.code === "number" || typeof record.code === "string") return String(record.code).toLowerCase();
    return visit(record.cause, depth + 1) ?? visit(record.error, depth + 1) ?? visit(record.info, depth + 1);
  }
  return visit(error, 0);
}

function isUserRejectedCode(code: string | null) {
  return code === "4001" || code === "action_rejected";
}
