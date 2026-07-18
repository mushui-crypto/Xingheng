import { createHash } from "node:crypto";
import { hyperliquidTestnetNetwork } from "./hyperliquidConfig";
import type {
  RealTradingAuditOutcome,
  RealTradingAuditRecord,
  RealTradingIdempotencyReservation,
  RealTradingIdempotencyResult,
  RealTradingIdempotencyState,
} from "./realTradingAuditTypes";
import type { RealTradingExchangeReceipt, RealTradingExchangeRequest } from "./hyperliquidTypes";
import { normalizeAddress } from "./HyperliquidInfoClient";
import type { RealTradingRiskGuard } from "./RealTradingRiskGuard";
import type {
  RealTradingAgentBindingStore,
  RealTradingSignatureVerifier,
  VerifiedExchangeSigner,
} from "./HyperliquidSignatureVerifier";

const requestTimeoutMs = 15_000;
const allowedExchangeActionTypes = new Set(["order", "cancel", "updateLeverage", "approveAgent"]);
const forbiddenActionWords = [
  "withdraw", "transfer", "staking", "builder", "fee", "usdClassTransfer",
  "spotSend", "sendAsset", "subAccountTransfer",
];
const sensitiveKeyPattern = /(signature|private.?key|mnemonic|seed|secret|raw.?payload|signed.?payload)/i;

type ExchangeStore = {
  saveRealTradingAudit(record: RealTradingAuditRecord): void;
  findRealTradingAgentBinding?: RealTradingAgentBindingStore["findRealTradingAgentBinding"];
  upsertRealTradingAgentBinding?: RealTradingAgentBindingStore["upsertRealTradingAgentBinding"];
  reserveRealTradingOrderRequest?(reservation: RealTradingIdempotencyReservation): RealTradingIdempotencyResult;
  completeRealTradingOrderRequest?(
    requestId: string,
    state: Exclude<RealTradingIdempotencyState, "processing">,
    receiptJson: string,
    completedAt: number,
  ): void;
  releaseRealTradingOrderRequest?(requestId: string): void;
};

type ExchangeForwardContext = { requestId: string; userId: string; submittedAt?: number };

export class RealTradingExchangeSubmissionError extends Error {
  constructor(readonly httpStatus: number, readonly receipt: RealTradingExchangeReceipt) {
    super(receipt.message ?? "真实交易请求失败。");
  }
}

export class HyperliquidExchangeProxy {
  constructor(
    private readonly baseUrl: string,
    private readonly risk?: RealTradingRiskGuard,
    private readonly store?: ExchangeStore,
    private readonly signatureVerifier?: RealTradingSignatureVerifier,
  ) {}

  async forward(input: unknown, context: ExchangeForwardContext): Promise<RealTradingExchangeReceipt> {
    const submittedAt = context.submittedAt ?? Date.now();
    let request: RealTradingExchangeRequest | null = null;
    let actionType = extractActionType(input);
    let clientOrderIds: string[] = [];
    let providerRequestStarted = false;
    let idempotencyReserved = false;
    let riskRelease: (() => void) | null = null;
    let verifiedSigner: VerifiedExchangeSigner | null = null;
    try {
      request = normalizeExchangeRequest(input);
      actionType = String(request.action.type);
      assertAllowedAction(request.action);
      verifiedSigner = this.signatureVerifier?.verify(request, {
        userId: context.userId,
        bindings: toAgentBindingStore(this.store),
      }) ?? null;
      clientOrderIds = actionType === "order" ? extractClientOrderIds(request.action) : [];
      if (actionType === "order") {
        if (!this.store?.reserveRealTradingOrderRequest) {
          throw new Error("真实订单幂等存储不可用，暂不允许下单。");
        }
        const reservation = this.store.reserveRealTradingOrderRequest({
          requestId: context.requestId,
          userId: context.userId,
          network: hyperliquidTestnetNetwork,
          masterAddress: request.masterAddress,
          clientOrderIds,
          requestFingerprint: fingerprintAction(request.action),
          actionType: "order",
          submittedAt,
        });
        if (reservation.kind === "existing") {
          const stored = parseStoredReceipt(reservation.receiptJson);
          if (stored && reservation.state !== "processing" && reservation.state !== "pending_reconciliation") return stored;
          const receipt = pendingReceipt({
            requestId: reservation.requestId === "conflict" ? context.requestId : reservation.requestId,
            actionType,
            submittedAt: reservation.submittedAt,
            message: reservation.requestId === "conflict"
              ? "部分 cloid 已被其他请求占用，订单未转发。"
              : "相同 cloid 的请求正在处理或等待权威对账，订单未重复转发。",
            status: 409,
          });
          this.writeAudit(auditRecord({
            context,
            request,
            actionType,
            clientOrderIds,
            outcome: "pending_reconciliation",
            errorCategory: "duplicate_cloid",
            providerStatus: reservation.state,
            httpStatus: 409,
            submittedAt,
            completedAt: receipt.timestamp,
          }));
          throw new RealTradingExchangeSubmissionError(409, receipt);
        }
        idempotencyReserved = true;
      }
      riskRelease = this.risk ? await this.risk.reserveAllowed(request) : null;

      console.info("[real-trading] forwarding signed exchange action", {
        requestId: context.requestId,
        network: request.network,
        actionType,
        clientOrderIds,
        masterAddress: maskAddress(request.masterAddress),
        vaultAddress: request.vaultAddress ? maskAddress(request.vaultAddress) : null,
      });
      providerRequestStarted = true;
      const response = await fetch(new URL("/exchange", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: request.action,
          nonce: request.nonce,
          signature: request.signature,
          vaultAddress: request.vaultAddress ?? null,
          ...(request.expiresAfter ? { expiresAfter: request.expiresAfter } : {}),
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const rawResult = await response.json().catch(() => ({ status: "err" }));
      const result = redactSensitiveValue(rawResult);
      const classification = classifyProviderResponse(
        response.ok,
        result,
        actionType,
        expectedProviderStatusCount(request.action),
      );
      const timestamp = Date.now();
      const receipt: RealTradingExchangeReceipt = {
        ok: classification.outcome === "accepted",
        network: hyperliquidTestnetNetwork,
        result,
        ...(classification.outcome !== "accepted"
          ? { status: response.status, message: classification.publicMessage }
          : {}),
        timestamp,
        requestId: context.requestId,
        actionType,
        submittedAt,
        accepted: classification.accepted,
        rejected: classification.rejected,
        outcome: classification.outcome,
        needsReconciliation: classification.outcome === "partial",
        errorCode: classification.outcome === "accepted" ? null : "RT_PROVIDER_REJECTED",
        retryable: false,
        reconcileRequired: classification.outcome === "partial",
        ...(classification.orderStatuses.length ? { orderStatuses: classification.orderStatuses } : {}),
      };
      if (classification.outcome === "accepted" && verifiedSigner?.kind === "master" && verifiedSigner.agentAddress) {
        this.store?.upsertRealTradingAgentBinding?.({
          userId: context.userId,
          masterAddress: verifiedSigner.masterAddress,
          agentAddress: verifiedSigner.agentAddress,
          approvedAt: timestamp,
          updatedAt: timestamp,
        });
      }
      this.completeIdempotency(context.requestId, classification.outcome, receipt, timestamp, idempotencyReserved);
      this.writeAudit(auditRecord({
        context,
        request,
        actionType,
        clientOrderIds,
        outcome: classification.outcome,
        errorCategory: classification.outcome === "accepted" ? null : `provider_${classification.outcome}`,
        providerStatus: extractProviderStatus(result),
        httpStatus: response.status,
        submittedAt,
        completedAt: timestamp,
      }));
      return receipt;
    } catch (error) {
      if (error instanceof RealTradingExchangeSubmissionError) throw error;
      if (!providerRequestStarted && idempotencyReserved) {
        this.store?.releaseRealTradingOrderRequest?.(context.requestId);
        idempotencyReserved = false;
      }
      const timestamp = Date.now();
      const outcome: RealTradingAuditOutcome = providerRequestStarted ? "pending_reconciliation" : "rejected";
      const local = classifyLocalFailure(error);
      const httpStatus = providerRequestStarted ? 504 : local.httpStatus;
      const errorCategory = providerRequestStarted ? "provider_transport_unknown" : categorizeLocalError(error);
      const receipt: RealTradingExchangeReceipt = {
        ok: false,
        network: hyperliquidTestnetNetwork,
        status: httpStatus,
        message: providerRequestStarted
          ? "Hyperliquid Testnet 请求结果未知，请使用 cloid 获取权威快照后再处理，禁止盲目重试。"
          : safeLocalErrorMessage(error),
        timestamp,
        requestId: context.requestId,
        actionType,
        submittedAt,
        accepted: false,
        rejected: !providerRequestStarted,
        outcome,
        needsReconciliation: providerRequestStarted,
        errorCode: providerRequestStarted ? "RT_UPSTREAM_TIMEOUT" : local.code,
        retryable: false,
        reconcileRequired: providerRequestStarted,
      };
      this.completeIdempotency(context.requestId, outcome, receipt, timestamp, idempotencyReserved);
      this.writeAudit(auditRecord({
        context,
        request,
        actionType,
        clientOrderIds,
        outcome,
        errorCategory,
        providerStatus: providerRequestStarted ? "unknown" : "local_rejection",
        httpStatus,
        submittedAt,
        completedAt: timestamp,
      }));
      throw new RealTradingExchangeSubmissionError(httpStatus, receipt);
    } finally {
      riskRelease?.();
    }
  }

  private completeIdempotency(
    requestId: string,
    state: Exclude<RealTradingIdempotencyState, "processing">,
    receipt: RealTradingExchangeReceipt,
    completedAt: number,
    reserved: boolean,
  ) {
    if (!reserved) return;
    this.store?.completeRealTradingOrderRequest?.(requestId, state, JSON.stringify(receipt), completedAt);
  }

  private writeAudit(record: RealTradingAuditRecord) {
    try {
      // Audit messages are category-only by design; never persist provider/request text.
      this.store?.saveRealTradingAudit({ ...record, message: record.errorCategory ? publicCategoryMessage(record.errorCategory) : null });
    } catch (error) {
      console.error("[real-trading] audit write failed", {
        requestId: record.requestId,
        actionType: record.actionType,
        errorCategory: "audit_storage_error",
      });
    }
  }
}

function toAgentBindingStore(store?: ExchangeStore): RealTradingAgentBindingStore | undefined {
  if (!store?.findRealTradingAgentBinding || !store.upsertRealTradingAgentBinding) return undefined;
  return {
    findRealTradingAgentBinding: store.findRealTradingAgentBinding.bind(store),
    upsertRealTradingAgentBinding: store.upsertRealTradingAgentBinding.bind(store),
  };
}

export function normalizeExchangeRequest(input: unknown): RealTradingExchangeRequest {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (value.network !== hyperliquidTestnetNetwork) throw new Error("真实交易第一阶段只允许 hyperliquid-testnet。");
  const action = value.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("exchange action 必须是对象。");
  const nonce = Number(value.nonce);
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("exchange nonce 不正确。");
  if (!value.signature || typeof value.signature !== "object") throw new Error("exchange signature 缺失。");
  const vaultAddress = value.vaultAddress === undefined || value.vaultAddress === null || value.vaultAddress === ""
    ? null : normalizeAddress(value.vaultAddress);
  if (vaultAddress !== null) throw new Error("当前产品不支持 vaultAddress 真实交易。");
  const expiresAfter = value.expiresAfter === undefined || value.expiresAfter === null || value.expiresAfter === ""
    ? null : Number(value.expiresAfter);
  if (expiresAfter !== null && (!Number.isSafeInteger(expiresAfter) || expiresAfter <= 0)) {
    throw new Error("exchange expiresAfter 不正确。");
  }
  return {
    masterAddress: normalizeAddress(value.masterAddress),
    network: value.network,
    action: action as Record<string, unknown>,
    nonce,
    signature: value.signature,
    vaultAddress,
    expiresAfter,
  };
}

function assertAllowedAction(action: Record<string, unknown>) {
  const type = String(action.type ?? "");
  if (!allowedExchangeActionTypes.has(type)) throw new Error(`exchange action ${type || "(empty)"} 暂不允许。`);
  if (type === "approveAgent") assertApproveAgentAction(action);
  if (type === "updateLeverage") assertUpdateLeverageAction(action);
  const lowerPayload = JSON.stringify(action).toLowerCase();
  if (forbiddenActionWords.some((word) => lowerPayload.includes(word.toLowerCase()))) {
    throw new Error("资金转移、staking、builder fee 等 exchange action 暂不允许。");
  }
}

function assertApproveAgentAction(action: Record<string, unknown>) {
  if (action.hyperliquidChain !== "Testnet") throw new Error("approveAgent 仅允许 Hyperliquid Testnet。");
  normalizeAddress(action.agentAddress);
}

function assertUpdateLeverageAction(action: Record<string, unknown>) {
  if (!Number.isSafeInteger(action.asset) || Number(action.asset) < 0) throw new Error("updateLeverage asset 必须是非负安全整数。");
  if (typeof action.isCross !== "boolean") throw new Error("updateLeverage isCross 必须是布尔值。");
  if (!Number.isSafeInteger(action.leverage) || Number(action.leverage) < 1) throw new Error("updateLeverage leverage 必须是正安全整数。");
}

function extractClientOrderIds(action: Record<string, unknown>) {
  if (!Array.isArray(action.orders) || action.orders.length === 0) throw new Error("order action 必须包含至少一笔订单。");
  const ids = action.orders.map((order) => {
    const cloid = (order as Record<string, unknown>)?.c;
    if (typeof cloid !== "string" || !/^0x[a-fA-F0-9]{32}$/.test(cloid)) {
      throw new Error("每笔真实订单必须包含 0x + 32 位十六进制 cloid。");
    }
    return cloid.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new Error("同一批订单的 cloid 不得重复。");
  return ids;
}

function classifyProviderResponse(httpOk: boolean, result: any, actionType: string, expectedOrderCount: number) {
  const orderStatuses = normalizeOrderStatuses(result, actionType);
  const hasPerItemStatuses = actionType === "order" || actionType === "cancel";
  const acceptedCount = hasPerItemStatuses ? orderStatuses.filter((item) => item.status === "accepted").length : 0;
  const rejectedCount = hasPerItemStatuses ? orderStatuses.filter((item) => item.status === "rejected").length : 0;
  let outcome: "accepted" | "rejected" | "partial";
  const strictShape = actionType === "order"
    ? result?.status === "ok" && result?.response?.type === "order" && orderStatuses.length === expectedOrderCount
    : actionType === "approveAgent" || actionType === "updateLeverage"
      ? result?.status === "ok" && result?.response?.type === "default"
      : actionType === "cancel"
        ? result?.status === "ok"
          && result?.response?.type === "cancel"
          && Array.isArray(result?.response?.data?.statuses)
          && orderStatuses.length === expectedOrderCount
        : false;
  if (!httpOk || !strictShape || result?.status === "err" || result?.response?.type === "error") outcome = "rejected";
  else if (acceptedCount > 0 && rejectedCount > 0) outcome = "partial";
  else if (rejectedCount > 0) outcome = "rejected";
  else outcome = "accepted";
  return {
    outcome,
    accepted: outcome === "accepted" || outcome === "partial",
    rejected: outcome === "rejected" || outcome === "partial",
    orderStatuses,
    publicMessage: outcome === "partial"
      ? "批量订单部分被接受，必须按逐订单状态和权威快照对账。"
      : "Hyperliquid Testnet 拒绝了交易请求。",
  };
}

function normalizeOrderStatuses(result: any, actionType: string): NonNullable<RealTradingExchangeReceipt["orderStatuses"]> {
  const statuses = result?.response?.data?.statuses;
  if (!Array.isArray(statuses)) return [];
  return statuses.map((value: any, index: number) => {
    if (actionType === "cancel" && typeof value === "string" && value.trim().toLowerCase() === "success") {
      return { index, status: "accepted", providerStatus: "unknown", oid: null, message: null } as const;
    }
    if (value && typeof value === "object" && "error" in value) {
      return { index, status: "rejected", providerStatus: "error", oid: null, message: "provider_order_rejection" } as const;
    }
    const providerStatus = value && typeof value === "object" && "filled" in value
      ? "filled" : value && typeof value === "object" && "resting" in value ? "resting" : "unknown";
    const detail = value?.filled ?? value?.resting ?? {};
    return providerStatus === "unknown"
      ? { index, status: "rejected", providerStatus, oid: null, message: "provider_order_shape_invalid" } as const
      : { index, status: "accepted", providerStatus, oid: detail.oid ?? null, message: null } as const;
  });
}

function expectedProviderStatusCount(action: Record<string, unknown>) {
  if (action.type === "order" && Array.isArray(action.orders)) return action.orders.length;
  if (action.type === "cancel" && Array.isArray(action.cancels)) return action.cancels.length;
  return 0;
}

function extractProviderStatus(result: unknown) {
  return result && typeof result === "object" && "status" in result ? String((result as any).status ?? "") || null : null;
}

function pendingReceipt(input: Pick<RealTradingExchangeReceipt, "requestId" | "actionType" | "submittedAt" | "message" | "status">): RealTradingExchangeReceipt {
  return {
    ok: false,
    network: hyperliquidTestnetNetwork,
    timestamp: Date.now(),
    accepted: false,
    rejected: false,
    outcome: "pending_reconciliation",
    needsReconciliation: true,
    errorCode: "RT_IDEMPOTENCY_CONFLICT",
    retryable: false,
    reconcileRequired: true,
    ...input,
  };
}

function parseStoredReceipt(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as RealTradingExchangeReceipt;
    return parsed?.network === hyperliquidTestnetNetwork ? parsed : null;
  } catch {
    return null;
  }
}

function auditRecord(input: {
  context: ExchangeForwardContext;
  request: RealTradingExchangeRequest | null;
  actionType: string;
  clientOrderIds: string[];
  outcome: RealTradingAuditOutcome;
  errorCategory: string | null;
  providerStatus: string | null;
  httpStatus: number;
  submittedAt: number;
  completedAt: number;
}): RealTradingAuditRecord {
  return {
    requestId: input.context.requestId,
    userId: input.context.userId,
    network: hyperliquidTestnetNetwork,
    masterAddress: input.request?.masterAddress ?? null,
    actionType: input.actionType,
    clientOrderIds: input.clientOrderIds,
    outcome: input.outcome,
    errorCategory: input.errorCategory,
    providerStatus: input.providerStatus,
    httpStatus: input.httpStatus,
    message: null,
    submittedAt: input.submittedAt,
    completedAt: input.completedAt,
  };
}

function categorizeLocalError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("cloid")) return "invalid_or_duplicate_cloid";
  if (message.includes("风险") || message.includes("权益") || message.includes("敞口") || message.includes("杠杆") || message.includes("委托")) return "risk_rejection";
  if (message.includes("签名") || message.includes("nonce") || message.includes("action") || message.includes("network")) return "validation_rejection";
  return "local_rejection";
}

function classifyLocalFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("暂不允许") || message.includes("不支持 vaultAddress") || message.includes("Mainnet")) {
    return { code: "RT_ACTION_NOT_ALLOWED", httpStatus: 403 };
  }
  if (message.includes("cloid") || message.includes("幂等")) return { code: "RT_IDEMPOTENCY_CONFLICT", httpStatus: 409 };
  if (message.includes("过期") || message.includes("stale") || message.includes("断开")) {
    return { code: "RT_RISK_STALE_MARKET", httpStatus: 409 };
  }
  if (message.includes("权益") || message.includes("敞口") || message.includes("杠杆") || message.includes("委托") || message.includes("reduce-only") || message.includes("持仓")) {
    return { code: "RT_RISK_LIMIT_EXCEEDED", httpStatus: 422 };
  }
  return { code: "RT_INVALID_REQUEST", httpStatus: 400 };
}

function fingerprintAction(action: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(sortValue(action))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, sortValue(item)]));
}

function safeLocalErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "真实交易请求校验失败。";
  if (message.includes("signatureChainId")) {
    return "请使用 Hyperliquid Testnet 签名参数 signatureChainId=0x66eee 后重试。";
  }
  if (message.includes("签名账户与 masterAddress 不一致")) {
    return "签名钱包与声明的主账户不一致，请切换到对应主钱包后重试。";
  }
  if (message.includes("尚未授权此 Hyperliquid API wallet")) {
    return "当前账户尚未完成 Hyperliquid API wallet 授权，请先完成 Agent 授权。";
  }
  if (message.includes("不是当前用户已授权的 API wallet")) {
    return "签名使用的 API wallet 与当前账户已授权 Agent 不一致，请重新授权或切换钱包。";
  }
  if (message.includes("signature 格式不正确") || message.includes("signature 缺失")) {
    return "真实交易签名格式不正确，请重新签名后重试。";
  }
  if (containsSensitiveErrorMaterial(message)) {
    return "真实交易请求校验失败，请重新授权或签名后重试。";
  }
  const redacted = redactErrorText(message).trim();
  return redacted ? redacted.slice(0, 300) : "真实交易请求校验失败。";
}

function containsSensitiveErrorMaterial(value: string) {
  const sensitiveExplicitAssignmentPattern = /["']?\b(?:r|s|v|signature|private(?:[_-]?key)?|mnemonic|seed|secret|raw[\s_-]?payload|signed[\s_-]?payload|payload|token|bearer|authorization)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?[^"'\s<>},\]]+/i;
  const sensitiveSpaceAssignmentPattern = /\b(?:r|s|v|private(?:[_-]?key)?|mnemonic|seed|secret|raw[\s_-]?payload|signed[\s_-]?payload|payload|token|bearer|authorization)\b\s+["']?[^"'\s<>},\]]+/i;
  const authorizationBearerPattern = /["']?\bauthorization\b["']?\s*(?:[:=]|\s+)\s*["']?bearer\s+[^"'\s<>},\]]+/i;
  return sensitiveExplicitAssignmentPattern.test(value)
    || sensitiveSpaceAssignmentPattern.test(value)
    || authorizationBearerPattern.test(value);
}

function redactErrorText(value: string) {
  const sensitiveExplicitAssignmentPattern = /(["']?\b(?:r|s|v|signature|private(?:[_-]?key)?|mnemonic|seed|secret|raw[\s_-]?payload|signed[\s_-]?payload|payload|token)\b["']?\s*[:=]\s*)["']?[^"'\s<>},\]]+["']?/gi;
  const sensitiveSpaceAssignmentPattern = /\b(r|s|v|private(?:[_-]?key)?|mnemonic|seed|secret|raw[\s_-]?payload|signed[\s_-]?payload|payload|token|bearer|authorization)\b\s+["']?[^"'\s<>},\]]+["']?/gi;
  const authorizationBearerPattern = /(["']?\bauthorization\b["']?\s*(?:[:=]|\s+)\s*)["']?bearer\s+[^"'\s<>},\]]+["']?/gi;
  const bearerCredentialPattern = /(["']?\bbearer\b["']?\s*(?:[:=]|\s+)\s*)["']?[^"'\s<>},\]]+["']?/gi;
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/file:\/\/\/?[^\s"'<>]+/gi, "[path]")
    .replace(/(?:^|[\s"'(=])(?:\/|\.\/|\.\.\/)[^\s"'<>]+/g, (match) => match[0].trim() ? "[path]" : `${match[0]}[path]`)
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, "[address]")
    .replace(/\b0x[a-fA-F0-9]{32,}\b/g, "[hex]")
    .replace(authorizationBearerPattern, "$1[redacted]")
    .replace(bearerCredentialPattern, "$1[redacted]")
    .replace(sensitiveExplicitAssignmentPattern, "$1[redacted]")
    .replace(sensitiveSpaceAssignmentPattern, "$1=[redacted]");
}

function publicCategoryMessage(category: string) {
  const messages: Record<string, string> = {
    provider_transport_unknown: "上游结果未知，等待权威对账。",
    provider_rejected: "上游明确拒绝。",
    provider_partial: "上游批次部分成功，等待逐订单对账。",
    duplicate_cloid: "cloid 重复或正在处理。",
    risk_rejection: "服务端风险策略拒绝。",
    validation_rejection: "请求契约校验拒绝。",
    invalid_or_duplicate_cloid: "cloid 校验拒绝。",
    local_rejection: "服务端本地拒绝。",
  };
  return messages[category] ?? "真实交易请求未被接受。";
}

function redactSensitiveValue(value: unknown, depth = 0): any {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSensitiveValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return sensitiveKeyPattern.test(value) ? "[redacted]" : value.slice(0, 500);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveKeyPattern.test(key))
    .map(([key, nested]) => [key, redactSensitiveValue(nested, depth + 1)]));
}

function extractActionType(input: unknown) {
  const type = (input as any)?.action?.type;
  return typeof type === "string" && type.trim() ? type.trim().slice(0, 64) : "unknown";
}

function maskAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
