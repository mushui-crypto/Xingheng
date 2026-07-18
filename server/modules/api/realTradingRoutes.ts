import { randomUUID } from "node:crypto";
import type express from "express";
import { sendBadRequest } from "./httpResponses";
import { normalizeAddress, normalizeCloid, normalizeRealTradingSymbol } from "../hyperliquid/HyperliquidInfoClient";
import { RealTradingExchangeSubmissionError, type HyperliquidExchangeProxy } from "../hyperliquid/HyperliquidExchangeProxy";
import type { HyperliquidInfoClient } from "../hyperliquid/HyperliquidInfoClient";
import type { RealTradingOrderStateService } from "../hyperliquid/RealTradingOrderStateService";
import type { RealTradingRealtimeTokenService } from "../hyperliquid/RealTradingRealtimeTokenService";
import type { RealTradingReconciliationService } from "../hyperliquid/RealTradingReconciliationService";
import type { RealTradingRiskGuard } from "../hyperliquid/RealTradingRiskGuard";
import type { RealTradingUserStreamManager } from "../hyperliquid/RealTradingUserStreamManager";
import type { RealTradingAuditRecord } from "../hyperliquid/realTradingAuditTypes";

type RealTradingRouteDependencies = {
  app: express.Express;
  info: HyperliquidInfoClient;
  exchange: HyperliquidExchangeProxy;
  orderState: RealTradingOrderStateService;
  realtimeTokens: RealTradingRealtimeTokenService;
  auditStore: {
    findRealTradingAudit(userId: string, input: { requestId?: string | null; cloid?: string | null }): unknown;
    listUserRealTradingReconciliationRecords?(userId: string): unknown[];
    getRealTradingOperationsSummary?(now?: number, windowMs?: number): unknown;
  };
  risk?: RealTradingRiskGuard;
  userStreams?: RealTradingUserStreamManager;
  reconciliation?: RealTradingReconciliationService;
};

export function registerRealTradingRoutes({
  app,
  info,
  exchange,
  orderState,
  realtimeTokens,
  auditStore,
  risk,
  userStreams,
  reconciliation,
}: RealTradingRouteDependencies) {
  const exchangeRateLimit = createRealTradingRateLimiter();

  app.get("/api/real-trading/market/symbols", async (_request, response) => {
    try {
      response.json(await info.getSymbols());
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/summary", async (request, response) => {
    try {
      response.json(await info.getSummary(normalizeRealTradingSymbol(request.query.symbol)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/orderbook", async (request, response) => {
    try {
      response.json(await info.getOrderbook(normalizeRealTradingSymbol(request.query.symbol)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/trades", async (request, response) => {
    try {
      response.json(await info.getTrades(normalizeRealTradingSymbol(request.query.symbol)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/candles", async (request, response) => {
    try {
      response.json(await info.getCandles(
        normalizeRealTradingSymbol(request.query.symbol),
        String(request.query.interval ?? "1m"),
        request.query.limit,
      ));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/account/summary", async (request, response) => {
    try {
      response.json(await info.getAccountSummary(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/account/fees", async (request, response) => {
    try {
      response.json(await info.getFees(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/positions", async (request, response) => {
    try {
      response.json(await info.getPositions(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/open", async (request, response) => {
    try {
      response.json(await info.getOpenOrders(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/history", async (request, response) => {
    try {
      response.json(await info.getOrderHistory(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/state", async (request, response) => {
    try {
      response.json(await orderState.read(
        normalizeAddress(request.query.address),
        normalizeOptionalSequence(request.query.afterSequence),
      ));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/status", async (request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await info.getOrderStatus(
        normalizeAddress(request.query.address),
        normalizeCloid(request.query.cloid),
      ));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/reconciliation", (request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      const records = auditStore.listUserRealTradingReconciliationRecords?.(request.user!.id) ?? [];
      response.json({ network: "hyperliquid-testnet", records: records.map(toPublicRealTradingReconciliationRecord) });
    } catch {
      response.status(500).json({
        network: "hyperliquid-testnet",
        message: "真实交易对账状态读取失败。",
        errorCode: "RT_RECONCILIATION_UNAVAILABLE",
      });
    }
  });

  app.get("/api/real-trading/orders/audit", (request, response) => {
    try {
      const requestId = typeof request.query.requestId === "string" ? request.query.requestId.trim() : "";
      const cloid = typeof request.query.cloid === "string" ? normalizeCloid(request.query.cloid) : "";
      if ((!requestId && !cloid) || (requestId && cloid)) {
        response.status(400).json({ message: "requestId 与 cloid 必须且只能提供一个。", errorCode: "RT_INVALID_REQUEST" });
        return;
      }
      const audit = auditStore.findRealTradingAudit(request.user!.id, { requestId, cloid });
      if (!audit) {
        response.status(404).json({ message: "未找到对应的真实交易审计记录。", errorCode: "RT_AUDIT_NOT_FOUND" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(toPublicRealTradingOrderAudit(audit as RealTradingAuditRecord));
    } catch {
      response.status(400).json({ message: "审计查询参数不正确。", errorCode: "RT_INVALID_REQUEST" });
    }
  });

  app.post("/api/real-trading/realtime/token", (request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(realtimeTokens.issue(request.user!.id, request.body?.address));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/real-trading/exchange", exchangeRateLimit, async (request, response) => {
    const requestId = randomUUID();
    const submittedAt = Date.now();
    try {
      response.json(await exchange.forward(request.body, {
        requestId,
        submittedAt,
        userId: request.user!.id,
      }));
    } catch (error) {
      if (error instanceof RealTradingExchangeSubmissionError) {
        response.status(error.httpStatus).json(error.receipt);
        return;
      }
      response.status(500).json({
        ok: false,
        network: "hyperliquid-testnet",
        requestId,
        actionType: "unknown",
        submittedAt,
        timestamp: Date.now(),
        accepted: false,
        rejected: true,
        outcome: "rejected",
        needsReconciliation: false,
        message: "真实交易请求处理失败。",
      });
    }
  });

  app.get("/api/admin/real-trading/operations", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const now = Date.now();
    const reconciliationHealth = reconciliation?.getHealth(now) ?? { enabled: false, status: "unavailable" };
    const userStreamHealth = userStreams?.getHealth(now) ?? { status: "unavailable" };
    const operations = auditStore.getRealTradingOperationsSummary?.(now) ?? {
      pendingCount: "unavailable",
      autoRecoverablePendingCount: "unavailable",
      manualReviewPendingCount: "unavailable",
      oldestPendingSubmittedAt: null,
      oldestPendingAgeMs: null,
      recentCounts: [],
      auditCleanup: "unavailable",
    };
    response.json({
      network: "hyperliquid-testnet",
      status: deriveRealTradingOperationsStatus(reconciliationHealth, userStreamHealth, operations),
      generatedAt: now,
      reconciliation: reconciliationHealth,
      userStreams: userStreamHealth,
      risk: risk?.getHealth() ?? { status: "unavailable" },
      operations,
      mainnetReadinessGaps: [
        "Mainnet 入口、配置开关和部署变量尚未冻结。",
        "真实资金、Builder fee、资金划转与提现类 exchange action 仍被禁止。",
        "需要独立完成受控 Testnet 签名动作回归、风控参数复核、审计保留与告警策略确认。",
        "需要重新评估法律合规、KYC/AML、用户风险披露与生产级事故响应流程。",
      ],
    });
  });
}

function deriveRealTradingOperationsStatus(reconciliation: any, userStreams: any, operations: any) {
  if (reconciliation?.status === "unavailable" || userStreams?.status === "unavailable" || operations?.pendingCount === "unavailable") {
    return "unavailable";
  }
  if (
    Number(reconciliation?.consecutiveFailures ?? 0) > 0
    || reconciliation?.stale === true
    || Number(operations?.manualReviewPendingCount ?? 0) > 0
    || Number(operations?.idempotencyPendingWithoutAuditCount ?? 0) > 0
    || hasDegradedStream(userStreams)
  ) {
    return "degraded";
  }
  return "ok";
}

function hasDegradedStream(userStreams: any) {
  const streams = Array.isArray(userStreams?.streams) ? userStreams.streams : [];
  return streams.some((stream: any) => stream?.stale === true || stream?.reconnecting === true || stream?.status === "stale" || stream?.status === "reconnecting");
}

export function toPublicRealTradingOrderAudit(audit: RealTradingAuditRecord) {
  const reconcileRequired = audit.outcome === "pending_reconciliation" || audit.outcome === "partial";
  const orderState = audit.outcome === "pending_reconciliation" ? "submitted" : audit.outcome;
  return {
    requestId: audit.requestId,
    cloid: audit.clientOrderIds.length === 1 ? audit.clientOrderIds[0] : null,
    cloids: audit.clientOrderIds,
    orderState,
    errorCategory: audit.errorCategory,
    retryable: false,
    reconcileRequired,
    timestamp: audit.completedAt,
  };
}

export function toPublicRealTradingReconciliationRecord(record: any) {
  const clientOrderIds = Array.isArray(record?.clientOrderIds)
    ? record.clientOrderIds.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const autoRecoverable = record?.autoRecoverable === true;
  return {
    requestId: String(record?.requestId ?? ""),
    actionType: String(record?.actionType ?? "unknown").slice(0, 64),
    submittedAt: typeof record?.submittedAt === "number" ? record.submittedAt : null,
    clientOrderIds,
    autoRecoverable,
    manualReview: record?.manualReview === true || !autoRecoverable,
    lastReconcileAttemptAt: typeof record?.lastReconcileAttemptAt === "number" ? record.lastReconcileAttemptAt : null,
    errorCategory: typeof record?.errorCategory === "string" ? record.errorCategory.slice(0, 80) : null,
    blockingScope: record?.blockingScope === "manual_review" ? "manual_review" : "new_risk",
  };
}

function normalizeOptionalSequence(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("afterSequence 必须是非负安全整数。");
  return sequence;
}

function createRealTradingRateLimiter() {
  const windowMs = 60_000;
  const configuredMax = Number(process.env.REAL_TRADING_EXCHANGE_RATE_LIMIT_MAX);
  const max = Number.isFinite(configuredMax) && configuredMax >= 1
    ? Math.min(300, Math.floor(configuredMax))
    : 30;
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const key = `${request.user?.id ?? "anonymous"}:${request.ip || request.socket.remoteAddress || "unknown"}`;
    const current = attempts.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    entry.count += 1;
    attempts.set(key, entry);
    if (attempts.size > 10_000) {
      for (const [storedKey, value] of attempts) {
        if (value.resetAt <= now) attempts.delete(storedKey);
      }
    }
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      const requestId = randomUUID();
      response.setHeader("Retry-After", String(retryAfter));
      response.status(429).json({
        ok: false,
        network: "hyperliquid-testnet",
        requestId,
        actionType: typeof request.body?.action?.type === "string" ? request.body.action.type.slice(0, 64) : "unknown",
        submittedAt: now,
        timestamp: now,
        accepted: false,
        rejected: true,
        outcome: "rejected",
        needsReconciliation: false,
        message: "真实交易请求过于频繁，请稍后再试。",
      });
      return;
    }
    next();
  };
}
