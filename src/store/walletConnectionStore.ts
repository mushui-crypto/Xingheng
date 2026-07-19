import { create } from "zustand";
import { discoverInjectedEthereumProvider, type Eip1193Provider } from "../shared/wallet/eip1193";

type WalletConnectionStore = {
  address: string;
  busy: boolean;
  error: string;
  initialized: boolean;
  provider: Eip1193Provider | null;
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  initialize: () => Promise<void>;
};

let initialization: Promise<void> | null = null;
let subscribedProvider: Eip1193Provider | null = null;

export const useWalletConnectionStore = create<WalletConnectionStore>((set, get) => ({
  address: "",
  busy: false,
  error: "",
  initialized: false,
  provider: null,
  initialize: async () => {
    if (get().initialized) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const provider = await discoverInjectedEthereumProvider();
      bindAccountsChanged(provider);
      if (!provider) {
        set({ initialized: true, provider: null });
        return;
      }
      const accounts = await provider.request({ method: "eth_accounts" }).catch(() => []);
      set({
        address: readFirstAddress(accounts),
        error: "",
        initialized: true,
        provider,
      });
    })().finally(() => {
      initialization = null;
    });
    return initialization;
  },
  connect: async () => {
    set({ busy: true, error: "" });
    try {
      const provider = get().provider ?? await discoverInjectedEthereumProvider();
      if (!provider) throw new Error("未检测到浏览器钱包。请安装或启用支持 EIP-1193 的钱包。");
      bindAccountsChanged(provider);
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const address = readFirstAddress(accounts);
      if (!address) throw new Error("钱包未返回账户地址。");
      set({ address, busy: false, error: "", initialized: true, provider });
      return address;
    } catch (error) {
      const message = error instanceof Error ? error.message : "钱包连接失败。";
      set({ busy: false, error: message });
      throw new Error(message);
    }
  },
  disconnect: async () => {
    if (get().busy) return;
    set({ busy: true, error: "" });
    try {
      await get().provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Permission revocation is optional across EIP-1193 providers; local session state is still cleared.
    } finally {
      set({ address: "", busy: false, error: "" });
    }
  },
}));

function bindAccountsChanged(provider: Eip1193Provider | null) {
  if (!provider || provider === subscribedProvider) return;
  subscribedProvider = provider;
  provider.on?.("accountsChanged", (accounts) => {
    useWalletConnectionStore.setState({ address: readFirstAddress(accounts), error: "" });
  });
}

function readFirstAddress(accounts: unknown) {
  return Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
}
