import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, type Eip1193Provider, type HDNodeWallet } from "ethers";
import { HyperliquidSessionSigner, normalizeSdkError } from "./hyperliquidSdk";
import {
  WalletNetworkRequiredError,
  WalletNetworkSwitchRejectedError,
  hyperliquidSignatureChain,
  subscribeWalletChainChanged,
  switchToHyperliquidSignatureNetwork,
} from "./walletNetwork";

test("wrong wallet network blocks approveAgent before signing or backend requests", async () => {
  const masterWallet = Wallet.createRandom();
  const walletProvider = createWalletProvider(masterWallet, { initialChainId: "0x3e7" });
  const originalFetch = globalThis.fetch;
  let backendRequests = 0;

  globalThis.fetch = async () => {
    backendRequests += 1;
    throw new Error("Unexpected backend request");
  };

  try {
    await assert.rejects(
      HyperliquidSessionSigner.create(walletProvider.provider, masterWallet.address),
      (error: unknown) => error instanceof WalletNetworkRequiredError
        && error.currentChainId === "0x3e7",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(walletProvider.state.signRequests, 0);
  assert.equal(backendRequests, 0);
});

test("switching to Arbitrum Sepolia emits fixed Testnet approveAgent and preserves updateLeverage", async () => {
  const masterWallet = Wallet.createRandom();
  const walletProvider = createWalletProvider(masterWallet, { initialChainId: "0x3e7" });
  const capturedActions: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { action: Record<string, unknown> };
    capturedActions.push(request.action);
    return successfulExchangeResponse();
  };

  try {
    await switchToHyperliquidSignatureNetwork(walletProvider.provider);
    const signer = await HyperliquidSessionSigner.create(walletProvider.provider, masterWallet.address);
    await signer.approveAgent();
    await signer.updateLeverage(7, 5, "isolated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(walletProvider.state.chainId, hyperliquidSignatureChain.chainId);
  assert.equal(capturedActions.length, 2);
  assert.equal(capturedActions[0]?.type, "approveAgent");
  assert.equal(capturedActions[0]?.hyperliquidChain, "Testnet");
  assert.equal(capturedActions[0]?.signatureChainId, hyperliquidSignatureChain.chainId);
  assert.deepEqual(capturedActions[1], {
    asset: 7,
    isCross: false,
    leverage: 5,
    type: "updateLeverage",
  });
});

test("unknown Arbitrum Sepolia network is added with the frozen product configuration", async () => {
  const masterWallet = Wallet.createRandom();
  const walletProvider = createWalletProvider(masterWallet, {
    initialChainId: "0x3e7",
    switchErrors: [{ code: 4902, message: "Unrecognized chain" }],
  });

  const chainId = await switchToHyperliquidSignatureNetwork(walletProvider.provider);

  assert.equal(chainId, hyperliquidSignatureChain.chainId);
  assert.equal(walletProvider.state.switchRequests, 1);
  assert.deepEqual(walletProvider.state.addRequests, [{
    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
    chainId: "0x66eee",
    chainName: "Arbitrum Sepolia",
    nativeCurrency: {
      decimals: 18,
      name: "ETH",
      symbol: "ETH",
    },
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
  }]);
  assert.equal(walletProvider.state.signRequests, 0);
});

test("wallet switch rejection stays distinct from signature rejection", async () => {
  const masterWallet = Wallet.createRandom();
  const walletProvider = createWalletProvider(masterWallet, {
    initialChainId: "0x3e7",
    switchErrors: [{ code: 4001, message: "User rejected switch" }],
  });

  await assert.rejects(
    switchToHyperliquidSignatureNetwork(walletProvider.provider),
    WalletNetworkSwitchRejectedError,
  );
  assert.equal(walletProvider.state.addRequests.length, 0);
  assert.equal(walletProvider.state.signRequests, 0);
});

test("chainChanged subscription supports session cleanup and removes listeners", () => {
  const masterWallet = Wallet.createRandom();
  const walletProvider = createWalletProvider(masterWallet, { initialChainId: "0x66eee" });
  const observedChains: Array<string | null> = [];
  const cleanup = subscribeWalletChainChanged(walletProvider.provider, (chainId) => {
    observedChains.push(chainId);
  });

  walletProvider.emitChainChanged("0x3e7");
  cleanup();
  walletProvider.emitChainChanged("0x66eee");

  assert.deepEqual(observedChains, ["0x3e7"]);
});

test("SDK errors distinguish rejection, chain mismatch, and generic signing failure", () => {
  assert.equal(normalizeSdkError({ code: 4001, message: "Request failed" }), "用户拒绝了本地签名。");
  assert.equal(normalizeSdkError({ cause: { code: 4001 }, message: "Signing failed" }), "用户拒绝了本地签名。");
  assert.equal(normalizeSdkError({ code: "ACTION_REJECTED", message: "Action rejected" }), "用户拒绝了本地签名。");
  assert.equal(
    normalizeSdkError(new Error('Provided chainId "421614" must match the active chainId "999"')),
    "签名链与当前钱包网络不一致，请重试授权。",
  );
  assert.equal(
    normalizeSdkError(new Error("Failed to sign the typed data using the wallet")),
    "钱包签名失败，请重试。",
  );
  assert.equal(
    normalizeSdkError({ errorCode: "RT_ACCOUNT_NOT_ACTIVATED", message: "Hyperliquid Testnet 账户未激活。" }),
    "该钱包尚未激活 Hyperliquid Testnet 交易账户，请先完成 Testnet 账户激活后再授权 Agent。",
  );
  assert.equal(
    normalizeSdkError({ code: "RT_ACCOUNT_NOT_ACTIVATED", message: "兼容旧字段。" }),
    "该钱包尚未激活 Hyperliquid Testnet 交易账户，请先完成 Testnet 账户激活后再授权 Agent。",
  );
});

type MockWalletProvider = {
  emitChainChanged: (chainId: string) => void;
  provider: Eip1193Provider;
  state: {
    addRequests: Array<Record<string, unknown>>;
    chainId: string;
    signRequests: number;
    switchRequests: number;
  };
};

function createWalletProvider(
  wallet: HDNodeWallet,
  options: {
    initialChainId: string;
    switchErrors?: unknown[];
  },
): MockWalletProvider {
  const chainChangedListeners = new Set<(chainId: string) => void>();
  const switchErrors = [...(options.switchErrors ?? [])];
  const state = {
    addRequests: [] as Array<Record<string, unknown>>,
    chainId: options.initialChainId,
    signRequests: 0,
    switchRequests: 0,
  };
  const provider: Eip1193Provider = {
    async request(request) {
      switch (request.method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [wallet.address];
        case "eth_chainId":
          return state.chainId;
        case "wallet_switchEthereumChain": {
          state.switchRequests += 1;
          const nextError = switchErrors.shift();
          if (nextError) {
            throw nextError;
          }
          const [params] = request.params as [{ chainId: string }];
          state.chainId = params.chainId;
          return null;
        }
        case "wallet_addEthereumChain": {
          const [params] = request.params as [Record<string, unknown>];
          state.addRequests.push(params);
          state.chainId = String(params.chainId);
          return null;
        }
        case "eth_signTypedData_v4": {
          state.signRequests += 1;
          const [, rawPayload] = request.params as [string, string];
          const payload = JSON.parse(rawPayload) as {
            domain: Record<string, unknown>;
            message: Record<string, unknown>;
            primaryType: string;
            types: Record<string, Array<{ name: string; type: string }>>;
          };
          const { EIP712Domain: _domainType, ...types } = payload.types;
          return wallet.signTypedData(payload.domain, types, payload.message);
        }
        default:
          throw new Error(`Unexpected provider method: ${request.method}`);
      }
    },
  };
  const eventedProvider = provider as Eip1193Provider & {
    on: (event: string, listener: (chainId: string) => void) => void;
    removeListener: (event: string, listener: (chainId: string) => void) => void;
  };
  eventedProvider.on = (event, listener) => {
    if (event === "chainChanged") {
      chainChangedListeners.add(listener);
    }
  };
  eventedProvider.removeListener = (event, listener) => {
    if (event === "chainChanged") {
      chainChangedListeners.delete(listener);
    }
  };

  return {
    emitChainChanged(chainId) {
      state.chainId = chainId;
      chainChangedListeners.forEach((listener) => listener(chainId));
    },
    provider,
    state,
  };
}

function successfulExchangeResponse(): Response {
  return new Response(JSON.stringify({
    network: "hyperliquid-testnet",
    ok: true,
    result: { response: { type: "default" }, status: "ok" },
    timestamp: Date.now(),
  }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
