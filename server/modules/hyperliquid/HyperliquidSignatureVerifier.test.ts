import assert from "node:assert/strict";
import test from "node:test";
import { ExchangeClient, type IRequestTransport } from "@nktkas/hyperliquid";
import { ApproveAgentTypes } from "@nktkas/hyperliquid/api/exchange";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { Signature, Wallet } from "ethers";
import {
  HyperliquidSignatureVerifier,
  type RealTradingAgentBinding,
  type RealTradingAgentBindingStore,
} from "./HyperliquidSignatureVerifier";
import type { RealTradingExchangeRequest } from "./hyperliquidTypes";

const verifier = new HyperliquidSignatureVerifier();

test("approveAgent signature must belong to the declared master account", async () => {
  const master = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const nonce = Date.now();
  const action = {
    type: "approveAgent",
    hyperliquidChain: "Testnet",
    signatureChainId: "0x66eee",
    agentAddress: agent.address,
    agentName: "xingheng-p0-test",
    nonce,
  };
  const signature = await master.signTypedData(
    {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number.parseInt(action.signatureChainId, 16),
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    ApproveAgentTypes,
    action,
  );
  const request = exchangeRequest(master.address, action, nonce, signature);

  const verified = verifier.verify(request, { userId: "USR-1" });
  assert.equal(verified.kind, "master");
  assert.equal(verified.masterAddress, master.address.toLowerCase());
  assert.equal(verified.agentAddress, agent.address.toLowerCase());

  assert.throws(
    () => verifier.verify({ ...request, masterAddress: Wallet.createRandom().address }, { userId: "USR-1" }),
    /masterAddress/,
  );
  assert.throws(
    () => verifier.verify({
      ...request,
      action: { ...action, signatureChainId: "0x1" },
    }, { userId: "USR-1" }),
    /signatureChainId/,
  );
});

test("exchange action signer must match the user-bound API wallet", async () => {
  const master = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const nonce = Date.now();
  const action = { type: "cancel", cancels: [{ a: 0, o: 1 }] };
  const actionHash = createL1ActionHash({ action, nonce });
  const signature = await agent.signTypedData(
    {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    { source: "b", connectionId: actionHash },
  );
  const store = new BindingStore({
    userId: "USR-1",
    masterAddress: master.address.toLowerCase(),
    agentAddress: agent.address.toLowerCase(),
    approvedAt: nonce,
    updatedAt: nonce,
  });
  const request = exchangeRequest(master.address, action, nonce, signature);

  const verified = verifier.verify(request, { userId: "USR-1", bindings: store });
  assert.equal(verified.kind, "agent");
  assert.equal(verified.signerAddress, agent.address.toLowerCase());

  assert.throws(
    () => verifier.verify(request, { userId: "USR-2", bindings: store }),
    /尚未授权/,
  );
});

test("verifies the exact approveAgent and order payloads emitted by the Hyperliquid SDK", async () => {
  const master = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const transport = new CapturingExchangeTransport();
  const masterClient = new ExchangeClient({ transport, wallet: master, signatureChainId: "0x66eee" });
  const agentClient = new ExchangeClient({ transport, wallet: agent });

  await masterClient.approveAgent({ agentAddress: agent.address as `0x${string}`, agentName: "StellaX Session" });
  const approve = transport.payloads[0] as RealTradingExchangeRequest;
  const approveVerified = verifier.verify({ ...approve, masterAddress: master.address, network: "hyperliquid-testnet" }, { userId: "USR-sdk" });
  assert.equal(approveVerified.agentAddress, agent.address.toLowerCase());

  const store = new BindingStore({
    userId: "USR-sdk",
    masterAddress: master.address.toLowerCase(),
    agentAddress: agent.address.toLowerCase(),
    approvedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await agentClient.order({
    grouping: "na",
    orders: [{
      a: 0,
      b: true,
      c: "0x00112233445566778899aabbccddeeff",
      p: "60000",
      s: "0.001",
      r: false,
      t: { limit: { tif: "Gtc" } },
    }],
  });
  const order = transport.payloads[1] as RealTradingExchangeRequest;
  const orderVerified = verifier.verify({ ...order, masterAddress: master.address, network: "hyperliquid-testnet" }, {
    userId: "USR-sdk",
    bindings: store,
  });
  assert.equal(orderVerified.signerAddress, agent.address.toLowerCase());
});

function exchangeRequest(
  masterAddress: string,
  action: Record<string, unknown>,
  nonce: number,
  serializedSignature: string,
): RealTradingExchangeRequest {
  const signature = Signature.from(serializedSignature);
  return {
    masterAddress,
    network: "hyperliquid-testnet",
    action,
    nonce,
    signature: { r: signature.r, s: signature.s, v: signature.v },
  };
}

class BindingStore implements RealTradingAgentBindingStore {
  constructor(private readonly binding: RealTradingAgentBinding) {}

  findRealTradingAgentBinding(userId: string, masterAddress: string) {
    return this.binding.userId === userId && this.binding.masterAddress === masterAddress
      ? this.binding
      : undefined;
  }

  upsertRealTradingAgentBinding() {}
}

class CapturingExchangeTransport implements IRequestTransport<"exchange"> {
  readonly isTestnet = true;
  readonly payloads: unknown[] = [];

  async request<T>(_endpoint: "exchange", payload: unknown): Promise<T> {
    this.payloads.push(payload);
    const actionType = (payload as { action?: { type?: string } })?.action?.type;
    return (actionType === "order"
      ? { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } }
      : { status: "ok", response: { type: "default" } }) as T;
  }
}
