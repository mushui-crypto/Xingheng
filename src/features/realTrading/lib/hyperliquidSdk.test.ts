import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, type Eip1193Provider, type HDNodeWallet } from "ethers";
import { HyperliquidSessionSigner } from "./hyperliquidSdk";

test("frontend session signer emits Testnet approveAgent and preserves updateLeverage fields", async () => {
  const masterWallet = Wallet.createRandom();
  const provider = createWalletProvider(masterWallet);
  const capturedActions: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { action: Record<string, unknown> };
    capturedActions.push(request.action);
    return new Response(JSON.stringify({
      network: "hyperliquid-testnet",
      ok: true,
      result: { response: { type: "default" }, status: "ok" },
      timestamp: Date.now(),
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  };

  try {
    const signer = await HyperliquidSessionSigner.create(provider, masterWallet.address);
    await signer.approveAgent();
    await signer.updateLeverage(7, 5, "isolated");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedActions.length, 2);
  assert.equal(capturedActions[0]?.type, "approveAgent");
  assert.equal(capturedActions[0]?.hyperliquidChain, "Testnet");
  assert.equal(capturedActions[0]?.signatureChainId, "0x66eee");
  assert.deepEqual(capturedActions[1], {
    asset: 7,
    isCross: false,
    leverage: 5,
    type: "updateLeverage",
  });
});

function createWalletProvider(wallet: HDNodeWallet): Eip1193Provider {
  return {
    async request(request) {
      switch (request.method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [wallet.address];
        case "eth_chainId":
          return "0x1";
        case "eth_signTypedData_v4": {
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
}
