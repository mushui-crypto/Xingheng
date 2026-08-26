import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RecoveryAnomalyClassification =
  | "RECOVERABLE"
  | "MANUAL_REVIEW_REQUIRED"
  | "DATA_INTEGRITY_ERROR";

export type RecoveryAnomalySeverity = "P1" | "P2" | "INFO";

export type RecoveryAnomalyRecommendedAction =
  | "RECONCILE_EXISTING_EXECUTION"
  | "REVIEW_PROVIDER_HISTORY"
  | "REVIEW_SPOT_ATTRIBUTION"
  | "REVIEW_DUPLICATE_RECORDS"
  | "DATABASE_INTEGRITY_REVIEW"
  | "NO_AUTOMATIC_ACTION";

export type RecoveryAnomaly = Readonly<{
  code: string;
  classification: RecoveryAnomalyClassification;
  severity: RecoveryAnomalySeverity;
  arbitrageId?: string;
  legId?: string;
  executionIntentId?: string;
  executionRecordId?: string;
  description: string;
  recommendedAction: RecoveryAnomalyRecommendedAction;
}>;

export type RecoveryAnomalyScanResult = Readonly<{
  classification: "SAFE" | RecoveryAnomalyClassification;
  historicalAnomalies: number;
  manualReview: number;
  recoverable: number;
  integrityErrors: number;
  anomalies: readonly RecoveryAnomaly[];
}>;

type ReferenceRow = Readonly<{
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string | null;
  requestedQuantity: string;
  confirmedQuantity: string;
  status: string;
  phase: string;
  quantityEffect: string;
}>;

type ExecutionRow = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  venue: string;
  accountId: string;
  instrumentId: string;
  state: string;
  remoteOrderId?: string | null;
}>;

type JoinedReferenceRow = ReferenceRow & ExecutionRow & Readonly<{
  ownerUserId: string;
  legVenue: string;
  legAccountId: string;
  legInstrumentId: string;
}>;

const terminalStatuses = new Set(["CONFIRMED", "FAILED"]);

/**
 * Pure local anomaly detector. It intentionally owns no Provider capability and
 * opens SQLite read-only, so scan() cannot mutate execution or venue state.
 */
export class ArbitrageRecoveryAnomalyDetector {
  private readonly dbPath: string;

  constructor(options: Readonly<{ dbPath?: string }> = {}) {
    this.dbPath = options.dbPath
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
  }

  scan(options: Readonly<{ userId?: string }> = {}): RecoveryAnomalyScanResult {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const anomalies = [
        ...this.scanRecordAndReferenceStructure(db),
        ...this.scanTerminalWorkflow(db),
        ...this.scanReferenceQuantities(db),
        ...this.scanVenueReferences(db),
        ...this.scanBinanceReferences(db),
        ...this.scanSpotAttribution(db),
        ...this.scanManagementReleases(db),
      ];
      const scoped = options.userId === undefined
        ? anomalies
        : anomalies.filter((item) => item.arbitrageId !== undefined
          && ownsArbitrage(db, item.arbitrageId, options.userId!));
      const frozen = Object.freeze(scoped.map((item) => Object.freeze(item)));
      const integrityErrors = frozen.filter(({ classification }) => classification === "DATA_INTEGRITY_ERROR").length;
      const manualReview = frozen.filter(({ classification }) => classification === "MANUAL_REVIEW_REQUIRED").length;
      const recoverable = frozen.filter(({ classification }) => classification === "RECOVERABLE").length;
      return Object.freeze({
        classification: integrityErrors > 0
          ? "DATA_INTEGRITY_ERROR"
          : manualReview > 0
            ? "MANUAL_REVIEW_REQUIRED"
            : recoverable > 0
              ? "RECOVERABLE"
              : "SAFE",
        historicalAnomalies: frozen.length,
        manualReview,
        recoverable,
        integrityErrors,
        anomalies: frozen,
      });
    } finally {
      db.close();
    }
  }

  private scanRecordAndReferenceStructure(db: DatabaseSync): RecoveryAnomaly[] {
    const anomalies: RecoveryAnomaly[] = [];
    const duplicates = db.prepare(`SELECT intentId, COUNT(*) AS recordCount
      FROM execution_records GROUP BY intentId HAVING COUNT(*) > 1`).all() as Array<{
        intentId: string;
        recordCount: number;
      }>;
    for (const duplicate of duplicates) {
      anomalies.push(anomaly({
        code: "DUPLICATE_EXECUTION_INTENT_RECORDS",
        classification: "MANUAL_REVIEW_REQUIRED",
        severity: "P1",
        executionIntentId: duplicate.intentId,
        description: `Execution intent has ${duplicate.recordCount} records; no record was selected automatically.`,
        recommendedAction: "REVIEW_DUPLICATE_RECORDS",
      }));
    }

    const broken = db.prepare(`SELECT reference.*, owner.userId AS ownerUserId,
        leg.venue AS legVenue, leg.accountId AS legAccountId, leg.instrumentId AS legInstrumentId
      FROM arbitrage_execution_references reference
      JOIN arbitrage_instances owner ON owner.arbitrageId = reference.arbitrageId
      JOIN arbitrage_instance_legs leg
        ON leg.arbitrageId = reference.arbitrageId AND leg.legId = reference.legId
      LEFT JOIN execution_records record ON record.executionId = reference.executionRecordId
      WHERE reference.status != 'CLAIMED' AND (
        reference.executionRecordId IS NULL OR record.executionId IS NULL
      )`).all() as unknown as Array<ReferenceRow & { ownerUserId: string }>;
    for (const reference of broken) {
      anomalies.push(anomaly({
        code: "BROKEN_EXECUTION_REFERENCE_LINK",
        classification: "DATA_INTEGRITY_ERROR",
        severity: "P1",
        arbitrageId: reference.arbitrageId,
        legId: reference.legId,
        executionIntentId: reference.executionIntentId,
        ...(reference.executionRecordId === null ? {} : { executionRecordId: reference.executionRecordId }),
        description: "Non-CLAIMED arbitrage reference does not resolve to its declared ExecutionRecord.",
        recommendedAction: "DATABASE_INTEGRITY_REVIEW",
      }));
    }

    const claimedWithRecord = db.prepare(`SELECT reference.arbitrageId, reference.legId,
        reference.executionIntentId, reference.executionRecordId,
        COUNT(record.executionId) AS recordCount
      FROM arbitrage_execution_references reference
      LEFT JOIN execution_records record ON record.intentId = reference.executionIntentId
      WHERE reference.status = 'CLAIMED'
      GROUP BY reference.arbitrageId, reference.legId, reference.executionIntentId,
        reference.executionRecordId
      HAVING reference.executionRecordId IS NOT NULL OR COUNT(record.executionId) > 0`).all() as Array<{
          arbitrageId: string;
          legId: string;
          executionIntentId: string;
          executionRecordId: string | null;
          recordCount: number;
        }>;
    for (const row of claimedWithRecord) {
      anomalies.push(anomaly({
        code: "CLAIMED_EXECUTION_RECORD_LINK_MISSING",
        classification: row.recordCount === 1 ? "RECOVERABLE" : "MANUAL_REVIEW_REQUIRED",
        severity: "P1",
        arbitrageId: row.arbitrageId,
        legId: row.legId,
        executionIntentId: row.executionIntentId,
        ...(row.executionRecordId === null ? {} : { executionRecordId: row.executionRecordId }),
        description: "CLAIMED reference is not the normal no-record state; a record identity exists without a valid LINKED projection.",
        recommendedAction: row.recordCount === 1
          ? "RECONCILE_EXISTING_EXECUTION"
          : "REVIEW_DUPLICATE_RECORDS",
      }));
    }

    const linked = db.prepare(`SELECT reference.*, owner.userId AS ownerUserId,
        leg.venue AS legVenue, leg.accountId AS legAccountId, leg.instrumentId AS legInstrumentId,
        record.executionId, record.intentId, record.userId, record.venue, record.accountId,
        record.instrumentId, record.state
      FROM arbitrage_execution_references reference
      JOIN arbitrage_instances owner ON owner.arbitrageId = reference.arbitrageId
      JOIN arbitrage_instance_legs leg
        ON leg.arbitrageId = reference.arbitrageId AND leg.legId = reference.legId
      JOIN execution_records record ON record.executionId = reference.executionRecordId`).all() as unknown as JoinedReferenceRow[];
    for (const row of linked) {
      if (row.intentId !== row.executionIntentId || row.userId !== row.ownerUserId
        || row.venue !== row.legVenue || row.accountId !== row.legAccountId
        || row.instrumentId !== row.legInstrumentId) {
        anomalies.push(anomaly({
          code: "EXECUTION_RECORD_IDENTITY_MISMATCH",
          classification: "DATA_INTEGRITY_ERROR",
          severity: "P1",
          arbitrageId: row.arbitrageId,
          legId: row.legId,
          executionIntentId: row.executionIntentId,
          executionRecordId: row.executionRecordId!,
          description: "ExecutionRecord immutable identity conflicts with its arbitrage reference or leg.",
          recommendedAction: "DATABASE_INTEGRITY_REVIEW",
        }));
      }
      if (terminalStatuses.has(row.status) || terminalStatuses.has(row.state)) {
        if (row.status !== row.state) {
          const terminalConflict = terminalStatuses.has(row.status) && terminalStatuses.has(row.state);
          anomalies.push(anomaly({
            code: "EXECUTION_RECORD_REFERENCE_STATUS_CONFLICT",
            classification: terminalConflict ? "MANUAL_REVIEW_REQUIRED" : "RECOVERABLE",
            severity: "P1",
            arbitrageId: row.arbitrageId,
            legId: row.legId,
            executionIntentId: row.executionIntentId,
            executionRecordId: row.executionRecordId!,
            description: `Terminal execution status conflict: reference=${row.status}, record=${row.state}.`,
            recommendedAction: terminalConflict ? "REVIEW_PROVIDER_HISTORY" : "RECONCILE_EXISTING_EXECUTION",
          }));
        }
      }
    }

    // An unmatched ExecutionRecord is only known to be arbitrage-owned when an
    // execution command fingerprint independently identifies the same intent.
    const orphanRecords = db.prepare(`SELECT record.executionId, record.intentId,
        command.arbitrageId, command.legId
      FROM execution_records record
      JOIN arbitrage_command_idempotency command
        ON command.referenceId = record.intentId
       AND command.operationType IN ('EXECUTION_OPEN', 'EXECUTION_CLOSE')
      LEFT JOIN arbitrage_execution_references reference
        ON reference.executionIntentId = record.intentId
      WHERE reference.executionIntentId IS NULL`).all() as Array<{
        executionId: string;
        intentId: string;
        arbitrageId: string;
        legId: string;
      }>;
    for (const row of orphanRecords) {
      anomalies.push(anomaly({
        code: "ORPHAN_ARBITRAGE_EXECUTION_RECORD",
        classification: "MANUAL_REVIEW_REQUIRED",
        severity: "P1",
        arbitrageId: row.arbitrageId,
        legId: row.legId,
        executionIntentId: row.intentId,
        executionRecordId: row.executionId,
        description: "Arbitrage command evidence identifies an ExecutionRecord whose intent has no arbitrage reference.",
        recommendedAction: "DATABASE_INTEGRITY_REVIEW",
      }));
    }
    return anomalies;
  }

  private scanReferenceQuantities(db: DatabaseSync): RecoveryAnomaly[] {
    const anomalies: RecoveryAnomaly[] = [];
    const rows = db.prepare(`SELECT arbitrageId, legId, executionIntentId, executionRecordId,
      requestedQuantity, confirmedQuantity, status, phase, quantityEffect
      FROM arbitrage_execution_references WHERE status = 'CONFIRMED'`).all() as unknown as ReferenceRow[];
    for (const row of rows) {
      const comparison = compareDecimals(row.confirmedQuantity, row.requestedQuantity);
      if (comparison === null || comparison > 0) {
        anomalies.push(quantityAnomaly(row, "INVALID_CONFIRMED_CEILING",
          "CONFIRMED quantity exceeds requested quantity or is not a canonical unsigned decimal."));
      } else if (comparison < 0) {
        anomalies.push(quantityAnomaly(row, "LEGACY_PARTIAL_CONFIRMED",
          "Legacy CONFIRMED reference contains less than its requested quantity."));
      }
    }
    return anomalies;
  }

  private scanTerminalWorkflow(db: DatabaseSync): RecoveryAnomaly[] {
    const rows = db.prepare(`SELECT owner.arbitrageId, reference.legId,
        reference.executionIntentId, reference.executionRecordId, reference.status
      FROM arbitrage_instances owner
      JOIN arbitrage_execution_references reference ON reference.arbitrageId = owner.arbitrageId
      WHERE owner.status IN ('CLOSED', 'FAILED')
        AND reference.status IN ('CLAIMED', 'LINKED', 'PENDING_CONFIRMATION', 'UNKNOWN')`).all() as Array<{
          arbitrageId: string;
          legId: string;
          executionIntentId: string;
          executionRecordId: string | null;
          status: string;
        }>;
    return rows.map((row) => anomaly({
      code: "TERMINAL_INSTANCE_UNRESOLVED_EXECUTION",
      classification: "MANUAL_REVIEW_REQUIRED",
      severity: "P1",
      arbitrageId: row.arbitrageId,
      legId: row.legId,
      executionIntentId: row.executionIntentId,
      ...(row.executionRecordId === null ? {} : { executionRecordId: row.executionRecordId }),
      description: `Terminal arbitrage lifecycle retains unresolved execution status ${row.status}.`,
      recommendedAction: "RECONCILE_EXISTING_EXECUTION",
    }));
  }

  private scanVenueReferences(db: DatabaseSync): RecoveryAnomaly[] {
    if (!tableExists(db, "execution_order_references")) return [];
    const anomalies: RecoveryAnomaly[] = [];
    const rows = db.prepare(`SELECT venueReference.executionId, venueReference.userId,
        venueReference.venue, venueReference.referencePayload,
        record.executionId AS recordId, record.intentId, record.userId AS recordUserId,
        record.venue AS recordVenue, record.accountId, record.instrumentId, record.remoteOrderId
      FROM execution_order_references venueReference
      LEFT JOIN execution_records record ON record.executionId = venueReference.executionId`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const executionId = String(row.executionId);
      if (row.recordId === null) {
        anomalies.push(anomaly({
          code: "ORPHAN_VENUE_ORDER_REFERENCE",
          classification: "DATA_INTEGRITY_ERROR",
          severity: "P1",
          executionRecordId: executionId,
          description: "Venue order reference has no backing ExecutionRecord.",
          recommendedAction: "DATABASE_INTEGRITY_REVIEW",
        }));
        continue;
      }
      const payload = parseObject(row.referencePayload);
      const identityMatches = row.userId === row.recordUserId && row.venue === row.recordVenue
        && payload !== null && payload.intentId === row.intentId
        && payload.accountId === row.accountId && payload.instrumentId === row.instrumentId
        && venuePayloadIdentityValid(String(row.venue), payload, row.remoteOrderId);
      if (!identityMatches) {
        anomalies.push(anomaly({
          code: "VENUE_ORDER_REFERENCE_IDENTITY_MISMATCH",
          classification: "DATA_INTEGRITY_ERROR",
          severity: "P1",
          executionIntentId: String(row.intentId),
          executionRecordId: executionId,
          description: "Venue order reference immutable identity conflicts with its ExecutionRecord.",
          recommendedAction: "DATABASE_INTEGRITY_REVIEW",
        }));
      }
    }
    return anomalies;
  }

  private scanBinanceReferences(db: DatabaseSync): RecoveryAnomaly[] {
    if (!tableExists(db, "binance_personal_orders")) return [];
    const records = db.prepare(`SELECT executionId, intentId, userId, accountId, venue, remoteOrderId
      FROM execution_records WHERE venue = 'binance'`).all() as ExecutionRow[];
    const byReservation = new Map(records.map((record) => [binanceReservationKey(record), record]));
    const rows = db.prepare(`SELECT idempotencyKey, providerOrderId FROM binance_personal_orders
      WHERE idempotencyKey LIKE 'execution-intent:%'`).all() as Array<{
        idempotencyKey: string;
        providerOrderId: string | null;
      }>;
    return rows.flatMap((row) => {
      const record = byReservation.get(row.idempotencyKey);
      if (!record) return [anomaly({
        code: "ORPHAN_BINANCE_ORDER_REFERENCE",
        classification: "DATA_INTEGRITY_ERROR",
        severity: "P1",
        description: "Binance execution-intent reservation cannot be matched to any Binance ExecutionRecord.",
        recommendedAction: "DATABASE_INTEGRITY_REVIEW",
      })];
      if (record.remoteOrderId && row.providerOrderId && record.remoteOrderId !== row.providerOrderId) {
        return [anomaly({
          code: "BINANCE_ORDER_REFERENCE_IDENTITY_MISMATCH",
          classification: "DATA_INTEGRITY_ERROR",
          severity: "P1",
          executionIntentId: record.intentId,
          executionRecordId: record.executionId,
          description: "Binance provider order identity conflicts with its ExecutionRecord.",
          recommendedAction: "DATABASE_INTEGRITY_REVIEW",
        })];
      }
      return [];
    });
  }

  private scanSpotAttribution(db: DatabaseSync): RecoveryAnomaly[] {
    const anomalies: RecoveryAnomaly[] = [];
    const duplicates = db.prepare(`SELECT arbitrageId, legId, executionIntentId,
        COUNT(*) AS evidenceCount
      FROM arbitrage_spot_opening_attribution_evidence
      GROUP BY arbitrageId, executionIntentId HAVING COUNT(*) > 1`).all() as Array<{
          arbitrageId: string;
          legId: string;
          executionIntentId: string;
          evidenceCount: number;
        }>;
    for (const row of duplicates) {
      anomalies.push(anomaly({
        code: "DUPLICATE_SPOT_ATTRIBUTION_EVIDENCE",
        classification: "MANUAL_REVIEW_REQUIRED",
        severity: "P1",
        arbitrageId: row.arbitrageId,
        legId: row.legId,
        executionIntentId: row.executionIntentId,
        description: `Spot opening has ${row.evidenceCount} immutable attribution evidence rows.`,
        recommendedAction: "REVIEW_SPOT_ATTRIBUTION",
      }));
    }
    const missing = db.prepare(`SELECT reference.arbitrageId, reference.legId,
        reference.executionIntentId, reference.executionRecordId
      FROM arbitrage_execution_references reference
      JOIN arbitrage_instance_legs leg
        ON leg.arbitrageId = reference.arbitrageId AND leg.legId = reference.legId
      LEFT JOIN arbitrage_spot_opening_attribution_evidence evidence
        ON evidence.arbitrageId = reference.arbitrageId
       AND evidence.executionIntentId = reference.executionIntentId
      WHERE leg.instrumentId LIKE '%-SPOT' AND reference.phase = 'OPENING'
        AND reference.quantityEffect = 'INCREASE' AND reference.status = 'CONFIRMED'
        AND reference.confirmedQuantity = reference.requestedQuantity
        AND evidence.executionIntentId IS NULL`).all() as Array<ReferenceRow>;
    for (const row of missing) {
      anomalies.push(anomaly({
        code: "MISSING_SPOT_ATTRIBUTION_EVIDENCE",
        classification: "RECOVERABLE",
        severity: "P1",
        arbitrageId: row.arbitrageId,
        legId: row.legId,
        executionIntentId: row.executionIntentId,
        ...(row.executionRecordId === null ? {} : { executionRecordId: row.executionRecordId }),
        description: "Fully confirmed Spot opening has no immutable attribution evidence.",
        recommendedAction: "REVIEW_SPOT_ATTRIBUTION",
      }));
    }

    const evidenceRows = db.prepare(`SELECT evidence.*, reference.executionRecordId AS referenceRecordId,
        reference.requestedQuantity, reference.confirmedQuantity, reference.status,
        reference.phase, reference.quantityEffect, leg.venue AS legVenue,
        leg.accountId AS legAccountId, leg.instrumentId AS legInstrumentId,
        record.intentId AS recordIntentId, record.userId AS recordUserId,
        record.venue AS recordVenue, record.accountId AS recordAccountId,
        record.instrumentId AS recordInstrumentId, owner.userId AS ownerUserId
      FROM arbitrage_spot_opening_attribution_evidence evidence
      LEFT JOIN arbitrage_execution_references reference
        ON reference.arbitrageId = evidence.arbitrageId
       AND reference.executionIntentId = evidence.executionIntentId
      LEFT JOIN arbitrage_instance_legs leg
        ON leg.arbitrageId = evidence.arbitrageId AND leg.legId = evidence.legId
      LEFT JOIN arbitrage_instances owner ON owner.arbitrageId = evidence.arbitrageId
      LEFT JOIN execution_records record ON record.executionId = evidence.executionRecordId`).all() as Array<Record<string, unknown>>;
    for (const row of evidenceRows) {
      const identityMatches = row.referenceRecordId === row.executionRecordId
        && row.legVenue === row.venue && row.legAccountId === row.accountId
        && row.legInstrumentId === row.instrumentId
        && row.recordIntentId === row.executionIntentId && row.recordUserId === row.ownerUserId
        && row.recordVenue === row.venue && row.recordAccountId === row.accountId
        && row.recordInstrumentId === row.instrumentId
        && row.source === "PROVIDER_ORDER_FILLS";
      if (!identityMatches) {
        anomalies.push(spotAnomaly(row, "SPOT_ATTRIBUTION_IDENTITY_CONFLICT",
          "Spot attribution immutable identity conflicts with its reference, leg, or ExecutionRecord.",
          "DATA_INTEGRITY_ERROR"));
      }
      const attributableVsConfirmed = compareDecimals(String(row.attributableBaseQuantity), String(row.confirmedQuantity));
      const validReference = row.status === "CONFIRMED" && row.phase === "OPENING"
        && row.quantityEffect === "INCREASE"
        && compareDecimals(String(row.confirmedQuantity), String(row.requestedQuantity)) === 0;
      if (!validReference || attributableVsConfirmed === null || attributableVsConfirmed > 0
        || compareDecimals(String(row.attributableBaseQuantity), "0") !== 1) {
        anomalies.push(spotAnomaly(row, "SPOT_ATTRIBUTION_QUANTITY_CONFLICT",
          "Spot attribution quantity or full-confirmed opening invariant is invalid.",
          "MANUAL_REVIEW_REQUIRED"));
      }
    }
    return anomalies;
  }

  private scanManagementReleases(db: DatabaseSync): RecoveryAnomaly[] {
    const rows = db.prepare(`SELECT release.*, leg.venue AS legVenue,
        leg.accountId AS legAccountId, leg.instrumentId AS legInstrumentId,
        owner.userId AS ownerUserId
      FROM arbitrage_leg_management_releases release
      LEFT JOIN arbitrage_instance_legs leg
        ON leg.arbitrageId = release.arbitrageId AND leg.legId = release.legId
      LEFT JOIN arbitrage_instances owner ON owner.arbitrageId = release.arbitrageId`).all() as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const quantity = compareDecimals(String(row.releasedQuantity), "0");
      const valid = row.legVenue === row.venue && row.legAccountId === row.accountId
        && row.legInstrumentId === row.instrumentId && row.ownerUserId === row.requestedByUserId
        && row.reason === "USER_CONFIRMED_STOP_MANAGEMENT" && row.source === "AUTHENTICATED_API"
        && quantity === 1 && typeof row.requestedAt === "number" && typeof row.confirmedAt === "number"
        && row.confirmedAt >= row.requestedAt
        && (row.positionMode === "ONE_WAY" || row.positionMode === "HEDGE")
        && validUnsigned(row.actualQuantity) && validUnsigned(row.actualLongQuantity)
        && validUnsigned(row.actualShortQuantity)
        && (row.actualSignedNetQuantity === null || validSigned(String(row.actualSignedNetQuantity)))
        && (row.availableQuantity === null || validUnsigned(String(row.availableQuantity)))
        && typeof row.realityCheckedAt === "number";
      return valid ? [] : [anomaly({
        code: "MANAGEMENT_RELEASE_IDENTITY_CONFLICT",
        classification: "DATA_INTEGRITY_ERROR",
        severity: "P1",
        arbitrageId: String(row.arbitrageId),
        legId: String(row.legId),
        description: "Management Release immutable identity or intrinsic record facts are invalid.",
        recommendedAction: "DATABASE_INTEGRITY_REVIEW",
      })];
    });
  }
}

function quantityAnomaly(row: ReferenceRow, code: string, description: string): RecoveryAnomaly {
  return anomaly({
    code,
    classification: code === "LEGACY_PARTIAL_CONFIRMED" ? "MANUAL_REVIEW_REQUIRED" : "DATA_INTEGRITY_ERROR",
    severity: "P1",
    arbitrageId: row.arbitrageId,
    legId: row.legId,
    executionIntentId: row.executionIntentId,
    ...(row.executionRecordId === null ? {} : { executionRecordId: row.executionRecordId }),
    description,
    recommendedAction: "REVIEW_PROVIDER_HISTORY",
  });
}

function spotAnomaly(
  row: Record<string, unknown>,
  code: string,
  description: string,
  classification: RecoveryAnomalyClassification,
): RecoveryAnomaly {
  return anomaly({
    code,
    classification,
    severity: "P1",
    arbitrageId: String(row.arbitrageId),
    legId: String(row.legId),
    executionIntentId: String(row.executionIntentId),
    executionRecordId: String(row.executionRecordId),
    description,
    recommendedAction: classification === "DATA_INTEGRITY_ERROR"
      ? "DATABASE_INTEGRITY_REVIEW"
      : "REVIEW_SPOT_ATTRIBUTION",
  });
}

function anomaly(value: RecoveryAnomaly): RecoveryAnomaly {
  return value;
}

function tableExists(db: DatabaseSync, table: string) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function ownsArbitrage(db: DatabaseSync, arbitrageId: string, userId: string) {
  return db.prepare("SELECT 1 FROM arbitrage_instances WHERE arbitrageId = ? AND userId = ?")
    .get(arbitrageId, userId) !== undefined;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function venuePayloadIdentityValid(
  venue: string,
  payload: Record<string, unknown>,
  remoteOrderId: unknown,
) {
  const completeOrderId = venue === "okx" ? payload.ordId : payload.orderId;
  const clientIdentity = venue === "okx" ? payload.clOrdId
    : venue === "bybit" ? payload.orderLinkId
      : venue === "bitget" ? payload.clientOid
        : undefined;
  const venueShape = venue === "okx"
    ? typeof payload.instId === "string"
    : (venue === "bybit" || venue === "bitget")
      ? typeof payload.category === "string" && typeof payload.symbol === "string"
      : false;
  if (!venueShape || typeof clientIdentity !== "string" || clientIdentity.length === 0) return false;
  if (payload.recovery !== undefined) return typeof payload.recovery === "string";
  if (typeof completeOrderId !== "string" || completeOrderId.length === 0) return false;
  return remoteOrderId === null || remoteOrderId === undefined || remoteOrderId === completeOrderId;
}

function compareDecimals(left: string, right: string): -1 | 0 | 1 | null {
  const parsedLeft = decimal(left);
  const parsedRight = decimal(right);
  if (!parsedLeft || !parsedRight) return null;
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  const leftValue = parsedLeft.coefficient * (10n ** BigInt(scale - parsedLeft.scale));
  const rightValue = parsedRight.coefficient * (10n ** BigInt(scale - parsedRight.scale));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function decimal(value: string) {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function validUnsigned(value: unknown) {
  return typeof value === "string" && decimal(value) !== null;
}

function validSigned(value: string) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
}

function binanceReservationKey(record: Pick<ExecutionRow, "userId" | "accountId" | "intentId">) {
  const identity = `${record.userId}\u0000${record.accountId}\u0000${record.intentId}`;
  return `execution-intent:${createHash("sha256").update(identity).digest("hex")}`;
}
