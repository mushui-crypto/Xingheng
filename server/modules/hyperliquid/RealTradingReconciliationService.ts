import { hyperliquidTestnetNetwork } from "./hyperliquidConfig";
import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import type { RealTradingExchangeReceipt, RealTradingHistoricalOrder } from "./hyperliquidTypes";
import type { RealTradingAuditOutcome, RealTradingIdempotencyState } from "./realTradingAuditTypes";

export type RealTradingPendingReconciliation = {
  userId: string;
  masterAddress: string;
  network: string;
  cloid: string;
  requestId: string;
  actionType: string;
  state: RealTradingIdempotencyState;
  submittedAt: number;
  completedAt?: number | null;
  reconcileAttemptCount?: number | null;
  lastReconcileAttemptAt?: number | null;
  lastReconcileError?: string | null;
};

export type RealTradingReconciliationStore = {
  listPendingRealTradingReconciliations(limit?: number): RealTradingPendingReconciliation[];
  recordRealTradingReconciliationAttempt(requestId: string, attemptedAt: number, error: string | null): void;
  completeRealTradingOrderRequest(
    requestId: string,
    state: Exclude<RealTradingIdempotencyState, "processing">,
    receiptJson: string,
    completedAt: number,
  ): void;
  updateRealTradingAuditReconciliation(
    requestId: string,
    outcome: Exclude<RealTradingAuditOutcome, "pending_reconciliation">,
    input: {
      errorCategory: string | null;
      providerStatus: string | null;
      httpStatus: number;
      message: string | null;
      completedAt: number;
    },
  ): void;
};

type ReconciliationRunReason = "startup" | "interval" | "manual" | "test";
type RequestRecoveryResult =
  | { status: "recovered" }
  | { status: "unresolved" }
  | { status: "failed"; error: string };

export class RealTradingReconciliationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastRunReason: ReconciliationRunReason | null = null;
  private lastScannedPending = 0;
  private lastRecoveredRequests = 0;

  constructor(
    private readonly info: Pick<HyperliquidInfoClient, "getOrderStatus">,
    private readonly store: RealTradingReconciliationStore,
    private readonly options: { intervalMs?: number; batchSize?: number; autoStart?: boolean } = {},
  ) {}

  start() {
    if (this.options.autoStart === false || this.timer) return;
    void this.runOnce("startup");
    this.timer = setInterval(() => void this.runOnce("interval"), readIntervalMs(this.options.intervalMs));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async triggerOnce() {
    return this.runOnce("manual");
  }

  getHealth(now = Date.now()) {
    return {
      enabled: this.options.autoStart !== false,
      running: this.running,
      network: hyperliquidTestnetNetwork,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastCompletedAt: this.lastCompletedAt,
      lastRunReason: this.lastRunReason,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastScannedPending: this.lastScannedPending,
      lastRecoveredRequests: this.lastRecoveredRequests,
      nextCheckAt: this.timer && this.lastAttemptAt ? this.lastAttemptAt + readIntervalMs(this.options.intervalMs) : null,
      stale: this.lastAttemptAt !== null && now - this.lastAttemptAt > readIntervalMs(this.options.intervalMs) * 3,
    };
  }

  async runOnce(reason: ReconciliationRunReason = "test") {
    if (this.running) {
      return { skipped: true, reason: "single_flight" as const, recoveredRequests: 0, scannedPending: 0 };
    }
    this.running = true;
    this.lastAttemptAt = Date.now();
    this.lastRunReason = reason;
    try {
      const pending = this.store.listPendingRealTradingReconciliations(readBatchSize(this.options.batchSize));
      this.lastScannedPending = pending.length;
      const groups = groupByRequest(pending);
      let recoveredRequests = 0;
      const failedErrors: string[] = [];
      for (const rows of groups.values()) {
        const result = await this.tryRecoverRequest(rows);
        if (result.status === "recovered") {
          recoveredRequests += 1;
        } else if (result.status === "failed") {
          failedErrors.push(result.error);
        }
      }
      this.lastRecoveredRequests = recoveredRequests;
      if (failedErrors.length) {
        this.consecutiveFailures += 1;
        this.lastError = aggregateReconciliationErrors(failedErrors);
        console.warn("[real-trading] reconciliation run degraded", {
          recoveredRequests,
          failedRequests: failedErrors.length,
          error: this.lastError,
        });
        return {
          skipped: false,
          recoveredRequests,
          scannedPending: pending.length,
          failedRequests: failedErrors.length,
          error: this.lastError,
        };
      }
      this.lastSuccessAt = Date.now();
      this.consecutiveFailures = 0;
      this.lastError = null;
      return { skipped: false, recoveredRequests, scannedPending: pending.length, failedRequests: 0 };
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = sanitizeReconciliationError(error);
      console.warn("[real-trading] reconciliation run failed", { error: this.lastError });
      return { skipped: false, recoveredRequests: 0, scannedPending: this.lastScannedPending, failedRequests: 1, error: this.lastError };
    } finally {
      this.running = false;
    }
  }

  private async tryRecoverRequest(rows: RealTradingPendingReconciliation[]): Promise<RequestRecoveryResult> {
    const first = rows[0];
    if (!first || first.network !== hyperliquidTestnetNetwork || first.actionType !== "order") return { status: "unresolved" };
    const attemptedAt = Date.now();
    try {
      const statuses = await Promise.all(rows.map((row) => this.info.getOrderStatus(row.masterAddress, row.cloid)));
      if (!statuses.length || statuses.some((status) => status.status !== "order" || !status.order)) {
        this.store.recordRealTradingReconciliationAttempt(first.requestId, attemptedAt, null);
        return { status: "unresolved" };
      }
      const timestamp = Date.now();
      const receipt = buildRecoveredReceipt(first, statuses.map((status) => status.order!));
      this.store.recordRealTradingReconciliationAttempt(first.requestId, timestamp, null);
      this.store.completeRealTradingOrderRequest(first.requestId, "accepted", JSON.stringify(receipt), timestamp);
      this.store.updateRealTradingAuditReconciliation(first.requestId, "accepted", {
        errorCategory: null,
        providerStatus: "reconciled_order_status",
        httpStatus: 200,
        message: "已通过 Hyperliquid orderStatus 权威对账恢复。",
        completedAt: timestamp,
      });
      this.lastCompletedAt = timestamp;
      console.info("[real-trading] pending request reconciled", {
        requestId: first.requestId,
        network: hyperliquidTestnetNetwork,
        cloidCount: rows.length,
      });
      return { status: "recovered" };
    } catch (error) {
      const safeError = sanitizeReconciliationError(error);
      this.store.recordRealTradingReconciliationAttempt(first.requestId, attemptedAt, safeError);
      console.warn("[real-trading] pending request reconciliation failed", {
        requestId: first.requestId,
        network: hyperliquidTestnetNetwork,
        error: safeError,
      });
      return { status: "failed", error: safeError };
    }
  }
}

function buildRecoveredReceipt(
  row: RealTradingPendingReconciliation,
  orders: RealTradingHistoricalOrder[],
): RealTradingExchangeReceipt {
  const timestamp = Date.now();
  return {
    ok: true,
    network: hyperliquidTestnetNetwork,
    result: {
      status: "ok",
      response: {
        type: "reconciled_order_status",
        orders,
      },
    },
    timestamp,
    requestId: row.requestId,
    actionType: row.actionType,
    submittedAt: row.submittedAt,
    accepted: true,
    rejected: false,
    outcome: "accepted",
    needsReconciliation: false,
    errorCode: null,
    retryable: false,
    reconcileRequired: false,
    orderStatuses: orders.map((order, index) => ({
      index,
      status: "accepted" as const,
      providerStatus: normalizeProviderOrderStatus(order.status),
      oid: order.oid,
      message: null,
    })),
  };
}

function normalizeProviderOrderStatus(status: string | null) {
  const normalized = String(status ?? "").replace(/[\s_-]/g, "").toLowerCase();
  if (normalized === "filled") return "filled" as const;
  if (normalized === "open" || normalized === "resting") return "resting" as const;
  return "unknown" as const;
}

function groupByRequest(rows: RealTradingPendingReconciliation[]) {
  const groups = new Map<string, RealTradingPendingReconciliation[]>();
  rows.forEach((row) => {
    const group = groups.get(row.requestId) ?? [];
    group.push(row);
    groups.set(row.requestId, group);
  });
  return groups;
}

function readIntervalMs(value: unknown) {
  const parsed = Number(value ?? process.env.REAL_TRADING_RECONCILIATION_INTERVAL_MS);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.min(300_000, Math.max(30_000, Math.floor(parsed)));
}

function readBatchSize(value: unknown) {
  const parsed = Number(value ?? process.env.REAL_TRADING_RECONCILIATION_BATCH_SIZE);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(500, Math.max(1, Math.floor(parsed)));
}

export function sanitizeReconciliationError(error: unknown) {
  return sanitizeReconciliationText(error instanceof Error ? error.message : "provider unavailable");
}

function sanitizeReconciliationText(value: string) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/file:\/\/\/?[^\s"'<>]+/gi, "[path]")
    .replace(/\b(signature|nonce|private[_-]?key|mnemonic|raw[_-]?payload|token|secret)\s*[:=]\s*[^\s"'<>]+/gi, "$1=[secret]")
    .replace(/(?:^|[\s"'(=])(?:\/|\.\/|\.\.\/)[^\s"'<>]+/g, (match) => match[0].trim() ? "[path]" : `${match[0]}[path]`)
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, "[address]")
    .replace(/\b0x[a-fA-F0-9]{32,}\b/g, "[hex]")
    .slice(0, 240);
}

function aggregateReconciliationErrors(errors: string[]) {
  const unique = [...new Set(errors.map(sanitizeReconciliationText).filter(Boolean))].slice(0, 3);
  const more = errors.length > unique.length ? ` (+${errors.length - unique.length} more)` : "";
  return `${unique.join(" | ")}${more}`.slice(0, 240);
}
