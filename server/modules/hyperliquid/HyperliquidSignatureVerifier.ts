import { ApproveAgentTypes } from "@nktkas/hyperliquid/api/exchange";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { Signature, verifyTypedData } from "ethers";
import type { RealTradingExchangeRequest } from "./hyperliquidTypes";
import { normalizeAddress } from "./HyperliquidInfoClient";

export type RealTradingAgentBinding = {
  userId: string;
  masterAddress: string;
  agentAddress: string;
  approvedAt: number;
  updatedAt: number;
};

export type RealTradingAgentBindingStore = {
  findRealTradingAgentBinding(userId: string, masterAddress: string): RealTradingAgentBinding | undefined;
  upsertRealTradingAgentBinding(binding: RealTradingAgentBinding): void;
};

export type VerifiedExchangeSigner = {
  kind: "master" | "agent";
  masterAddress: string;
  signerAddress: string;
  agentAddress: string | null;
};

export interface RealTradingSignatureVerifier {
  verify(
    request: RealTradingExchangeRequest,
    context: { userId: string; bindings?: RealTradingAgentBindingStore },
  ): VerifiedExchangeSigner;
}

/**
 * Verifies the same EIP-712 data constructed by @nktkas/hyperliquid.
 * No signature or raw payload leaves this method or reaches persistence/logging.
 */
export class HyperliquidSignatureVerifier implements RealTradingSignatureVerifier {
  verify(
    request: RealTradingExchangeRequest,
    context: { userId: string; bindings?: RealTradingAgentBindingStore },
  ): VerifiedExchangeSigner {
    const masterAddress = normalizeAddress(request.masterAddress).toLowerCase();
    const signature = serializeSignature(request.signature);
    if (request.action.type === "approveAgent") {
      const actionNonce = Number(request.action.nonce);
      if (actionNonce !== request.nonce) throw new Error("approveAgent nonce 与请求 nonce 不一致。");
      const signatureChainId = String(request.action.signatureChainId ?? "");
      if (signatureChainId.toLowerCase() !== "0x66eee") {
        throw new Error("approveAgent 仅允许 Hyperliquid Testnet signatureChainId。");
      }
      const signerAddress = verifyTypedData(
        {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: Number.parseInt(signatureChainId, 16),
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        ApproveAgentTypes,
        request.action,
        signature,
      ).toLowerCase();
      if (signerAddress !== masterAddress) throw new Error("approveAgent 签名账户与 masterAddress 不一致。");
      return {
        kind: "master",
        masterAddress,
        signerAddress,
        agentAddress: normalizeAddress(request.action.agentAddress).toLowerCase(),
      };
    }

    if (!context.bindings) throw new Error("真实交易 agent 授权存储不可用。");
    const binding = context.bindings.findRealTradingAgentBinding(context.userId, masterAddress);
    if (!binding) throw new Error("当前用户尚未授权此 Hyperliquid API wallet。");
    const actionHash = createL1ActionHash({
      action: request.action,
      nonce: request.nonce,
      ...(request.vaultAddress ? { vaultAddress: request.vaultAddress as `0x${string}` } : {}),
      ...(request.expiresAfter ? { expiresAfter: request.expiresAfter } : {}),
    });
    const signerAddress = verifyTypedData(
      {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      { source: "b", connectionId: actionHash },
      signature,
    ).toLowerCase();
    if (signerAddress !== binding.agentAddress.toLowerCase()) {
      throw new Error("exchange 签名不是当前用户已授权的 API wallet。");
    }
    return { kind: "agent", masterAddress, signerAddress, agentAddress: binding.agentAddress.toLowerCase() };
  }
}

function serializeSignature(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("exchange signature 缺失。");
  try {
    const record = value as { r?: unknown; s?: unknown; v?: unknown };
    return Signature.from({ r: String(record.r ?? ""), s: String(record.s ?? ""), v: Number(record.v) }).serialized;
  } catch {
    throw new Error("exchange signature 格式不正确。");
  }
}
