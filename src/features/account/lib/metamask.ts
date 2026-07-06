import { bscTestnetChainId, bscTestnetLabel, bscTestnetRpcUrls } from "../model/constants";
import type { EthereumProvider } from "../model/types";

export function getMetaMaskEthereum() {
  const ethereum = window.ethereum;
  if (!ethereum?.isMetaMask) {
    throw new Error("请先安装 MetaMask。");
  }
  return ethereum;
}

export async function requestCurrentMetaMaskAddress(ethereum: EthereumProvider) {
  try {
    await ethereum.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
    if (code === 4001) {
      throw error;
    }
  }

  const walletAddress = await readCurrentMetaMaskAddress(ethereum);
  if (walletAddress) {
    return walletAddress;
  }

  const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
  const fallbackAddress = normalizeMetaMaskAddress(accounts[0]);
  if (!fallbackAddress) {
    throw new Error("未获取到 MetaMask 地址。");
  }
  return fallbackAddress;
}

export async function readCurrentMetaMaskAddress(ethereum: EthereumProvider) {
  const accounts = await ethereum.request({ method: "eth_accounts" }) as string[];
  return normalizeMetaMaskAddress(accounts[0]);
}

export function normalizeMetaMaskAddress(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function ensureBscTestnet(ethereum: EthereumProvider) {
  try {
    const currentChainId = await ethereum.request({ method: "eth_chainId" });
    if (currentChainId === bscTestnetChainId) {
      return;
    }

    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: bscTestnetChainId }],
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
      if (code !== 4902) {
        throw error;
      }
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: bscTestnetChainId,
            chainName: bscTestnetLabel,
            nativeCurrency: { name: "Test BNB", symbol: "tBNB", decimals: 18 },
            rpcUrls: bscTestnetRpcUrls,
            blockExplorerUrls: ["https://testnet.bscscan.com"],
          },
        ],
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/failed to fetch/i.test(message)) {
      throw new Error("BSC Testnet 网络节点暂时无法连接，请检查网络或稍后重试。");
    }
    throw error;
  }
}

export function normalizeWalletError(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const maybeError = error as { code?: number; message?: string };
    if (maybeError.code === 4001) {
      return "用户已取消 MetaMask 操作。";
    }
    if (maybeError.message) {
      return maybeError.message;
    }
  }
  return error instanceof Error ? error.message : "第三方钱包绑定失败。";
}
