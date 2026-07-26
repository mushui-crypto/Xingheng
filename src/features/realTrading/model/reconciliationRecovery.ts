import type { RealTradingReconciliationRecord } from "../../../api/realTrading";
import type { RealTradingOrderLifecycle } from "./realtimeState";

export type ReconciliationAccess = {
  blocksNewRisk: boolean;
  message: string;
};

export function reconciliationRecordsToLifecycles(
  records: RealTradingReconciliationRecord[],
): RealTradingOrderLifecycle[] {
  return records.map((record) => {
    const firstCloid = record.clientOrderIds[0];
    return {
      actionType: record.actionType,
      autoRecoverable: record.autoRecoverable,
      clientOrderId: firstCloid ?? `audit:${record.requestId}`,
      clientOrderIds: record.clientOrderIds,
      errorCategory: record.errorCategory,
      manualReview: record.manualReview,
      message: reconciliationRecordMessage(record),
      requestId: record.requestId,
      status: "pending_reconciliation",
      submittedAt: record.submittedAt,
      updatedAt: record.lastReconcileAttemptAt ?? record.submittedAt ?? 0,
    };
  });
}

export function resolveReconciliationAccess(
  records: RealTradingReconciliationRecord[],
  error: string,
): ReconciliationAccess {
  if (error) {
    return {
      blocksNewRisk: true,
      message: "待对账状态暂时无法确认，已暂停新增风险动作；撤单与 Reduce-only 安全退出仍可用。",
    };
  }
  if (records.some((record) => record.manualReview || record.blockingScope === "manual_review")) {
    return {
      blocksNewRisk: true,
      message: "存在需要人工核对的交易结果，请勿盲目重试；核对完成前暂停新增风险动作。",
    };
  }
  if (records.length > 0) {
    return {
      blocksNewRisk: true,
      message: "系统正在按 Hyperliquid 返回的最新订单状态自动核对，完成前暂停新增风险动作。",
    };
  }
  return { blocksNewRisk: false, message: "" };
}

export function reconciliationRecordMessage(record: RealTradingReconciliationRecord) {
  if (record.manualReview || record.blockingScope === "manual_review") {
    return "需要人工核对，禁止盲目重试。";
  }
  if (record.autoRecoverable) {
    return "系统正在按交易所返回的最新订单状态自动核对。";
  }
  return "交易结果待核对。";
}
