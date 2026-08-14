import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  absoluteDifference,
  addUnsignedDecimals,
  compareUnsignedDecimals,
  managedCurrentQuantity,
  normalizePositiveDecimal,
  normalizeSignedDecimal,
  normalizeUnsignedDecimal,
  type ArbitrageExecutionPhase,
  type ArbitrageExecutionReference,
  type ArbitrageExecutionReferenceStatus,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
  type ArbitrageInstanceStatus,
  type ArbitragePnlSummary,
  type ArbitrageQuantityEffect,
  type NewArbitrageInstance,
} from "./ArbitrageInstance";

const ACTIVE_STATUSES: readonly ArbitrageInstanceStatus[] = ["OPENING", "HOLDING", "RESIDUAL", "CLOSING"];
const HISTORY_STATUSES: readonly ArbitrageInstanceStatus[] = ["CLOSED", "FAILED"];
const UNRESOLVED_REFERENCE_STATUSES: readonly ArbitrageExecutionReferenceStatus[] = [
  "CLAIMED",
  "LINKED",
  "PENDING_CONFIRMATION",
  "UNKNOWN",
];

export type ExecutionReferenceClaim = Readonly<{
  legId: string;
  phase: ArbitrageExecutionPhase;
  quantityEffect: ArbitrageQuantityEffect;
  executionIntentId: string;
  requestedQuantity: string;
  createdAt: number;
}>;

export type ExecutionResultUpdate = Readonly<{
  executionIntentId: string;
  status: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  confirmedQuantity: string;
  updatedAt: number;
}>;

export type TargetQuantityUpdate = Readonly<{
  legId: string;
  plannedQuantity: string;
}>;

export type ArbitrageHistoryPageQuery = Readonly<{
  limit: number;
  offset: number;
}>;

type InstanceRow = Readonly<{
  arbitrageId: string;
  userId: string;
  strategyType: string;
  sourcePlanId: string | null;
  maxResidualBaseQuantity: string;
  status: string;
  createdAt: number;
  openedAt: number | null;
  updatedAt: number;
  closedAt: number | null;
  pnlAsset: string | null;
  cumulativeFundingPnl: string | null;
  realizedTradingPnl: string | null;
  feesCosts: string | null;
  cumulativeNetPnl: string | null;
  pnlUpdatedAt: number | null;
}>;

type LegRow = Readonly<{
  arbitrageId: string;
  legId: string;
  role: string;
  venue: string;
  accountId: string;
  instrumentId: string;
  plannedQuantity: string;
  confirmedOpenedQuantity: string;
  confirmedClosedQuantity: string;
}>;

type ReferenceRow = Readonly<{
  arbitrageId: string;
  legId: string;
  phase: string;
  quantityEffect: string;
  executionIntentId: string;
  executionRecordId: string | null;
  requestedQuantity: string;
  confirmedQuantity: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}>;

export class ArbitrageInstanceStore {
  private readonly db: DatabaseSync;

  constructor(options: Readonly<{ dbPath?: string }> = {}) {
    const dbPath = options.dbPath
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  create(input: NewArbitrageInstance): ArbitrageInstance {
    const instance = normalizeNewInstance(input);
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO arbitrage_instances (
        arbitrageId, userId, strategyType, sourcePlanId, maxResidualBaseQuantity,
        status, createdAt, openedAt, updatedAt, closedAt,
        pnlAsset, cumulativeFundingPnl, realizedTradingPnl, feesCosts,
        cumulativeNetPnl, pnlUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, 'OPENING', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`).run(
        instance.arbitrageId,
        instance.userId,
        instance.strategyType,
        instance.sourcePlanId,
        instance.maxResidualBaseQuantity,
        instance.createdAt,
        instance.createdAt,
      );
      const insertLeg = this.db.prepare(`INSERT INTO arbitrage_instance_legs (
        arbitrageId, legId, role, venue, accountId, instrumentId,
        plannedQuantity, confirmedOpenedQuantity, confirmedClosedQuantity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', '0')`);
      for (const leg of instance.legs) {
        insertLeg.run(
          instance.arbitrageId,
          leg.legId,
          leg.role,
          leg.venue,
          leg.accountId,
          leg.instrumentId,
          leg.plannedQuantity,
        );
      }
      return this.requireForUser(instance.userId, instance.arbitrageId);
    });
  }

  get(userId: string, arbitrageId: string): ArbitrageInstance | null {
    const row = this.instanceRow(identifier(userId, "userId"), identifier(arbitrageId, "arbitrageId"));
    return row ? this.instanceFromRow(row) : null;
  }

  listActive(userId: string) {
    return this.listForStatuses(identifier(userId, "userId"), ACTIVE_STATUSES);
  }

  listHistory(userId: string, pagination?: ArbitrageHistoryPageQuery) {
    return this.listForStatuses(
      identifier(userId, "userId"),
      HISTORY_STATUSES,
      pagination === undefined ? undefined : normalizeHistoryPageQuery(pagination),
    );
  }

  claimExecutionReference(
    userId: string,
    arbitrageId: string,
    claim: ExecutionReferenceClaim,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedClaim = normalizeClaim(claim);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot claim another execution.");
      }
      assertPhaseAllowed(instance.status, normalizedClaim.phase);
      if (normalizedClaim.phase === "OPENING" && normalizedClaim.quantityEffect !== "INCREASE") {
        throw new Error("Opening execution must increase managed exposure.");
      }
      if (normalizedClaim.phase === "CLOSING" && normalizedClaim.quantityEffect !== "DECREASE") {
        throw new Error("Closing execution must decrease managed exposure.");
      }
      const leg = instance.legs.find((candidate) => candidate.legId === normalizedClaim.legId);
      if (!leg) throw new Error("Execution reference leg does not belong to the arbitrage instance.");
      if (normalizedClaim.phase === "CLOSING" && instance.executionReferences.some((reference) => (
        reference.legId === normalizedClaim.legId
        && reference.phase === "CLOSING"
        && UNRESOLVED_REFERENCE_STATUSES.includes(reference.status)
      ))) {
        throw new Error("Arbitrage leg already has an unresolved closing execution.");
      }
      try {
        this.db.prepare(`INSERT INTO arbitrage_execution_references (
          arbitrageId, legId, phase, quantityEffect, executionIntentId,
          executionRecordId, requestedQuantity, confirmedQuantity, status, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, '0', 'CLAIMED', ?, ?)`).run(
          normalizedArbitrageId,
          normalizedClaim.legId,
          normalizedClaim.phase,
          normalizedClaim.quantityEffect,
          normalizedClaim.executionIntentId,
          normalizedClaim.requestedQuantity,
          normalizedClaim.createdAt,
          normalizedClaim.createdAt,
        );
      } catch (error) {
        if (isConstraintError(error)) {
          throw new Error("Execution intent is already claimed by an arbitrage instance.");
        }
        throw error;
      }
      if (normalizedClaim.phase === "CLOSING") {
        this.updateInstanceStatus(normalizedUserId, normalizedArbitrageId, "CLOSING", normalizedClaim.createdAt);
      } else {
        this.touchInstance(normalizedUserId, normalizedArbitrageId, normalizedClaim.createdAt);
      }
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  linkExecutionRecord(
    userId: string,
    arbitrageId: string,
    executionIntentId: string,
    executionRecordId: string,
    updatedAt: number,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedIntentId = identifier(executionIntentId, "executionIntentId");
    const normalizedRecordId = identifier(executionRecordId, "executionRecordId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    return this.transaction(() => {
      this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const reference = this.referenceRow(normalizedArbitrageId, normalizedIntentId);
      if (!reference) throw new Error("Execution reference was not found for the arbitrage instance.");
      if (timestampValue < reference.updatedAt) throw new Error("Execution reference time cannot move backwards.");
      if (reference.executionRecordId !== null) {
        if (reference.executionRecordId === normalizedRecordId) {
          return this.requireForUser(normalizedUserId, normalizedArbitrageId);
        }
        throw new Error("Execution reference is already linked to another execution record.");
      }
      try {
        const result = this.db.prepare(`UPDATE arbitrage_execution_references
          SET executionRecordId = ?, status = 'LINKED', updatedAt = ?
          WHERE arbitrageId = ? AND executionIntentId = ? AND executionRecordId IS NULL`).run(
          normalizedRecordId,
          timestampValue,
          normalizedArbitrageId,
          normalizedIntentId,
        );
        if (result.changes !== 1) throw new Error("Execution reference could not be linked.");
      } catch (error) {
        if (isConstraintError(error)) {
          throw new Error("Execution record is already linked to another arbitrage execution.");
        }
        throw error;
      }
      this.touchInstance(normalizedUserId, normalizedArbitrageId, timestampValue);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  applyExecutionResult(
    userId: string,
    arbitrageId: string,
    update: ExecutionResultUpdate,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedUpdate = normalizeExecutionResult(update);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot accept execution results.");
      }
      const reference = this.referenceRow(normalizedArbitrageId, normalizedUpdate.executionIntentId);
      if (!reference) throw new Error("Execution reference was not found for the arbitrage instance.");
      if (reference.executionRecordId === null) {
        throw new Error("Execution reference must link an ExecutionRecord before applying a result.");
      }
      if (normalizedUpdate.updatedAt < reference.updatedAt) {
        throw new Error("Execution result time cannot move backwards.");
      }
      if (reference.status === "CONFIRMED" || reference.status === "FAILED") {
        if (reference.status === normalizedUpdate.status
          && reference.confirmedQuantity === normalizedUpdate.confirmedQuantity) {
          return instance;
        }
        throw new Error("Terminal execution result cannot be changed.");
      }
      if (compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.confirmedQuantity) < 0) {
        throw new Error("Confirmed execution quantity cannot move backwards.");
      }
      if (compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.requestedQuantity) > 0) {
        throw new Error("Confirmed execution quantity cannot exceed requested quantity.");
      }

      const confirmedDelta = subtractForDelta(
        normalizedUpdate.confirmedQuantity,
        reference.confirmedQuantity,
      );
      if (confirmedDelta !== "0") {
        this.applyQuantityDelta(normalizedArbitrageId, reference, confirmedDelta);
      }
      this.db.prepare(`UPDATE arbitrage_execution_references
        SET confirmedQuantity = ?, status = ?, updatedAt = ?
        WHERE arbitrageId = ? AND executionIntentId = ?`).run(
        normalizedUpdate.confirmedQuantity,
        normalizedUpdate.status,
        normalizedUpdate.updatedAt,
        normalizedArbitrageId,
        normalizedUpdate.executionIntentId,
      );

      const next = this.deriveLifecycle(
        this.requireForUser(normalizedUserId, normalizedArbitrageId),
        normalizedUpdate.updatedAt,
      );
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, next);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  updateTargetQuantities(
    userId: string,
    arbitrageId: string,
    updates: readonly TargetQuantityUpdate[],
    updatedAt: number,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    if (!updates.length) throw new Error("At least one target quantity update is required.");
    const normalizedUpdates = updates.map((update) => ({
      legId: identifier(update.legId, "legId"),
      plannedQuantity: normalizePositiveDecimal(update.plannedQuantity, "plannedQuantity"),
    }));
    if (new Set(normalizedUpdates.map(({ legId }) => legId)).size !== normalizedUpdates.length) {
      throw new Error("Target quantity updates contain a duplicate legId.");
    }
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot update target quantities.");
      }
      if (timestampValue < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
      for (const update of normalizedUpdates) {
        const result = this.db.prepare(`UPDATE arbitrage_instance_legs
          SET plannedQuantity = ? WHERE arbitrageId = ? AND legId = ?`).run(
          update.plannedQuantity,
          normalizedArbitrageId,
          update.legId,
        );
        if (result.changes !== 1) throw new Error("Target quantity leg was not found for the arbitrage instance.");
      }
      this.touchInstance(normalizedUserId, normalizedArbitrageId, timestampValue);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  updateCumulativeReturns(
    userId: string,
    arbitrageId: string,
    pnl: ArbitragePnlSummary,
    updatedAt: number,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    const normalizedPnl = normalizePnl(pnl);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (timestampValue < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
      this.db.prepare(`UPDATE arbitrage_instances SET
        pnlAsset = ?, cumulativeFundingPnl = ?, realizedTradingPnl = ?, feesCosts = ?,
        cumulativeNetPnl = ?, pnlUpdatedAt = ?, updatedAt = ?
        WHERE userId = ? AND arbitrageId = ?`).run(
        normalizedPnl.asset,
        normalizedPnl.cumulativeFundingPnl,
        normalizedPnl.realizedTradingPnl,
        normalizedPnl.feesCosts,
        normalizedPnl.cumulativeNetPnl,
        normalizedPnl.updatedAt,
        timestampValue,
        normalizedUserId,
        normalizedArbitrageId,
      );
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  close() {
    this.db.close();
  }

  private listForStatuses(
    userId: string,
    statuses: readonly ArbitrageInstanceStatus[],
    pagination?: ArbitrageHistoryPageQuery,
  ) {
    const placeholders = statuses.map(() => "?").join(", ");
    const query = `SELECT * FROM arbitrage_instances
      WHERE userId = ? AND status IN (${placeholders})
      ORDER BY createdAt DESC, arbitrageId ASC${pagination ? " LIMIT ? OFFSET ?" : ""}`;
    const parameters = pagination
      ? [userId, ...statuses, pagination.limit, pagination.offset]
      : [userId, ...statuses];
    const rows = this.db.prepare(query).all(...parameters) as unknown as InstanceRow[];
    return rows.map((row) => this.instanceFromRow(row));
  }

  private requireForUser(userId: string, arbitrageId: string) {
    const instance = this.get(userId, arbitrageId);
    if (!instance) throw new Error("Arbitrage instance was not found for the authenticated user.");
    return instance;
  }

  private instanceRow(userId: string, arbitrageId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_instances
      WHERE userId = ? AND arbitrageId = ?`).get(userId, arbitrageId) as unknown as InstanceRow | undefined;
  }

  private referenceRow(arbitrageId: string, executionIntentId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_execution_references
      WHERE arbitrageId = ? AND executionIntentId = ?`).get(
      arbitrageId,
      executionIntentId,
    ) as unknown as ReferenceRow | undefined;
  }

  private instanceFromRow(row: InstanceRow): ArbitrageInstance {
    const legs = this.db.prepare(`SELECT * FROM arbitrage_instance_legs
      WHERE arbitrageId = ? ORDER BY CASE role WHEN 'LONG' THEN 0 ELSE 1 END`).all(
      row.arbitrageId,
    ) as unknown as LegRow[];
    if (legs.length !== 2) throw new Error("Persisted arbitrage instance must contain exactly two legs.");
    const references = this.db.prepare(`SELECT * FROM arbitrage_execution_references
      WHERE arbitrageId = ? ORDER BY createdAt ASC, executionIntentId ASC`).all(
      row.arbitrageId,
    ) as unknown as ReferenceRow[];
    return Object.freeze({
      arbitrageId: row.arbitrageId,
      userId: row.userId,
      strategyType: strategyType(row.strategyType),
      sourcePlanId: row.sourcePlanId,
      maxResidualBaseQuantity: normalizeUnsignedDecimal(row.maxResidualBaseQuantity, "maxResidualBaseQuantity"),
      status: instanceStatus(row.status),
      createdAt: row.createdAt,
      openedAt: row.openedAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt,
      legs: Object.freeze(legs.map(legFromRow)) as unknown as readonly [ArbitrageInstanceLeg, ArbitrageInstanceLeg],
      executionReferences: Object.freeze(references.map(referenceFromRow)),
      pnl: Object.freeze({
        asset: row.pnlAsset,
        cumulativeFundingPnl: row.cumulativeFundingPnl,
        realizedTradingPnl: row.realizedTradingPnl,
        feesCosts: row.feesCosts,
        cumulativeNetPnl: row.cumulativeNetPnl,
        updatedAt: row.pnlUpdatedAt,
      }),
    });
  }

  private applyQuantityDelta(arbitrageId: string, reference: ReferenceRow, delta: string) {
    const column = reference.quantityEffect === "INCREASE"
      ? "confirmedOpenedQuantity"
      : "confirmedClosedQuantity";
    const leg = this.db.prepare(`SELECT * FROM arbitrage_instance_legs
      WHERE arbitrageId = ? AND legId = ?`).get(arbitrageId, reference.legId) as unknown as LegRow | undefined;
    if (!leg) throw new Error("Execution reference leg was not found.");
    const current = column === "confirmedOpenedQuantity"
      ? leg.confirmedOpenedQuantity
      : leg.confirmedClosedQuantity;
    const next = addUnsignedDecimals(current, delta);
    if (column === "confirmedClosedQuantity"
      && compareUnsignedDecimals(next, leg.confirmedOpenedQuantity) > 0) {
      throw new Error("Confirmed closed quantity cannot exceed confirmed opened quantity.");
    }
    this.db.prepare(`UPDATE arbitrage_instance_legs SET ${column} = ?
      WHERE arbitrageId = ? AND legId = ?`).run(next, arbitrageId, reference.legId);
  }

  private deriveLifecycle(instance: ArbitrageInstance, updatedAt: number) {
    const quantities = instance.legs.map(managedCurrentQuantity) as [string, string];
    const hasExposure = quantities.some((quantity) => quantity !== "0");
    const bothExposed = quantities.every((quantity) => quantity !== "0");
    const residualWithinThreshold = compareUnsignedDecimals(
      absoluteDifference(quantities[0], quantities[1]),
      instance.maxResidualBaseQuantity,
    ) <= 0;
    const unresolved = instance.executionReferences.some((reference) =>
      UNRESOLVED_REFERENCE_STATUSES.includes(reference.status));

    let status: ArbitrageInstanceStatus;
    if (instance.status === "CLOSING") {
      status = !hasExposure && !unresolved
        ? "CLOSED"
        : unresolved
          ? "CLOSING"
          : "RESIDUAL";
    } else if (hasExposure) {
      status = bothExposed && residualWithinThreshold && !unresolved ? "HOLDING" : "RESIDUAL";
    } else {
      const openingReferences = instance.executionReferences.filter(({ phase }) => phase === "OPENING");
      const attemptedLegIds = new Set(openingReferences.map(({ legId }) => legId));
      const openingTerminated = instance.legs.every(({ legId }) => attemptedLegIds.has(legId))
        && openingReferences.every(({ status: referenceStatus }) =>
          referenceStatus === "CONFIRMED" || referenceStatus === "FAILED");
      status = openingTerminated && !unresolved ? "FAILED" : "OPENING";
    }
    return {
      status,
      openedAt: status === "HOLDING" && instance.openedAt === null ? updatedAt : instance.openedAt,
      closedAt: status === "CLOSED" ? updatedAt : null,
      updatedAt,
    };
  }

  private persistLifecycle(
    userId: string,
    arbitrageId: string,
    lifecycle: Readonly<{
      status: ArbitrageInstanceStatus;
      openedAt: number | null;
      closedAt: number | null;
      updatedAt: number;
    }>,
  ) {
    const result = this.db.prepare(`UPDATE arbitrage_instances
      SET status = ?, openedAt = ?, closedAt = ?, updatedAt = ?
      WHERE userId = ? AND arbitrageId = ?`).run(
      lifecycle.status,
      lifecycle.openedAt,
      lifecycle.closedAt,
      lifecycle.updatedAt,
      userId,
      arbitrageId,
    );
    if (result.changes !== 1) throw new Error("Arbitrage lifecycle update failed.");
  }

  private updateInstanceStatus(
    userId: string,
    arbitrageId: string,
    status: ArbitrageInstanceStatus,
    updatedAt: number,
  ) {
    const instance = this.requireForUser(userId, arbitrageId);
    if (updatedAt < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
    this.persistLifecycle(userId, arbitrageId, {
      status,
      openedAt: instance.openedAt,
      closedAt: null,
      updatedAt,
    });
  }

  private touchInstance(userId: string, arbitrageId: string, updatedAt: number) {
    const instance = this.requireForUser(userId, arbitrageId);
    if (updatedAt < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
    this.db.prepare(`UPDATE arbitrage_instances SET updatedAt = ?
      WHERE userId = ? AND arbitrageId = ?`).run(updatedAt, userId, arbitrageId);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS arbitrage_instances (
      arbitrageId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      strategyType TEXT NOT NULL CHECK (strategyType IN ('PERPETUAL_PERPETUAL', 'SPOT_PERPETUAL')),
      sourcePlanId TEXT,
      maxResidualBaseQuantity TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPENING', 'HOLDING', 'RESIDUAL', 'CLOSING', 'CLOSED', 'FAILED')),
      createdAt INTEGER NOT NULL,
      openedAt INTEGER,
      updatedAt INTEGER NOT NULL,
      closedAt INTEGER,
      pnlAsset TEXT,
      cumulativeFundingPnl TEXT,
      realizedTradingPnl TEXT,
      feesCosts TEXT,
      cumulativeNetPnl TEXT,
      pnlUpdatedAt INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS arbitrage_instances_user_status_created
      ON arbitrage_instances(userId, status, createdAt DESC);

    CREATE TABLE IF NOT EXISTS arbitrage_instance_legs (
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('LONG', 'SHORT')),
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      plannedQuantity TEXT NOT NULL,
      confirmedOpenedQuantity TEXT NOT NULL,
      confirmedClosedQuantity TEXT NOT NULL,
      PRIMARY KEY (arbitrageId, legId),
      UNIQUE (arbitrageId, role),
      FOREIGN KEY (arbitrageId) REFERENCES arbitrage_instances(arbitrageId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_execution_references (
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('OPENING', 'ADJUSTMENT', 'CLOSING')),
      quantityEffect TEXT NOT NULL CHECK (quantityEffect IN ('INCREASE', 'DECREASE')),
      executionIntentId TEXT NOT NULL UNIQUE,
      executionRecordId TEXT UNIQUE,
      requestedQuantity TEXT NOT NULL,
      confirmedQuantity TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'CLAIMED', 'LINKED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'FAILED', 'UNKNOWN'
      )),
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (arbitrageId, executionIntentId),
      FOREIGN KEY (arbitrageId, legId) REFERENCES arbitrage_instance_legs(arbitrageId, legId)
    ) STRICT;`);
  }
}

function normalizeHistoryPageQuery(input: ArbitrageHistoryPageQuery): ArbitrageHistoryPageQuery {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new Error("history limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new Error("history offset must be a non-negative integer.");
  }
  return Object.freeze({ limit: input.limit, offset: input.offset });
}

function normalizeNewInstance(input: NewArbitrageInstance) {
  if (!input || typeof input !== "object") throw new Error("New arbitrage instance is invalid.");
  if (!Array.isArray(input.legs) || input.legs.length !== 2) {
    throw new Error("Arbitrage instance must contain exactly two legs.");
  }
  const legs = input.legs.map((leg) => ({
    legId: identifier(leg.legId, "legId"),
    role: legRole(leg.role),
    venue: venue(leg.venue),
    accountId: identifier(leg.accountId, "accountId"),
    instrumentId: instrumentId(leg.instrumentId),
    plannedQuantity: normalizePositiveDecimal(leg.plannedQuantity, "plannedQuantity"),
  }));
  if (new Set(legs.map(({ legId }) => legId)).size !== 2) {
    throw new Error("Arbitrage instance legId values must be unique.");
  }
  if (new Set(legs.map(({ role }) => role)).size !== 2
    || !legs.some(({ role }) => role === "LONG")
    || !legs.some(({ role }) => role === "SHORT")) {
    throw new Error("Arbitrage instance requires exactly one LONG leg and one SHORT leg.");
  }
  return {
    arbitrageId: identifier(input.arbitrageId, "arbitrageId"),
    userId: identifier(input.userId, "userId"),
    strategyType: strategyType(input.strategyType),
    sourcePlanId: input.sourcePlanId == null ? null : identifier(input.sourcePlanId, "sourcePlanId"),
    maxResidualBaseQuantity: normalizeUnsignedDecimal(
      input.maxResidualBaseQuantity,
      "maxResidualBaseQuantity",
    ),
    createdAt: timestamp(input.createdAt, "createdAt"),
    legs: legs as unknown as NewArbitrageInstance["legs"],
  };
}

function normalizeClaim(claim: ExecutionReferenceClaim): ExecutionReferenceClaim {
  return Object.freeze({
    legId: identifier(claim.legId, "legId"),
    phase: executionPhase(claim.phase),
    quantityEffect: quantityEffect(claim.quantityEffect),
    executionIntentId: identifier(claim.executionIntentId, "executionIntentId"),
    requestedQuantity: normalizePositiveDecimal(claim.requestedQuantity, "requestedQuantity"),
    createdAt: timestamp(claim.createdAt, "createdAt"),
  });
}

function normalizeExecutionResult(update: ExecutionResultUpdate): ExecutionResultUpdate {
  if (update.status !== "PENDING_CONFIRMATION" && update.status !== "CONFIRMED"
    && update.status !== "FAILED" && update.status !== "UNKNOWN") {
    throw new Error("Execution result status is invalid.");
  }
  return Object.freeze({
    executionIntentId: identifier(update.executionIntentId, "executionIntentId"),
    status: update.status,
    confirmedQuantity: normalizeUnsignedDecimal(update.confirmedQuantity, "confirmedQuantity"),
    updatedAt: timestamp(update.updatedAt, "updatedAt"),
  });
}

function normalizePnl(pnl: ArbitragePnlSummary): ArbitragePnlSummary {
  const values = {
    cumulativeFundingPnl: nullableSignedDecimal(pnl.cumulativeFundingPnl, "cumulativeFundingPnl"),
    realizedTradingPnl: nullableSignedDecimal(pnl.realizedTradingPnl, "realizedTradingPnl"),
    feesCosts: nullableSignedDecimal(pnl.feesCosts, "feesCosts"),
    cumulativeNetPnl: nullableSignedDecimal(pnl.cumulativeNetPnl, "cumulativeNetPnl"),
  };
  const hasValue = Object.values(values).some((value) => value !== null);
  if (hasValue && pnl.asset === null) throw new Error("PnL asset is required when a cumulative value is present.");
  if (!hasValue && pnl.asset !== null) throw new Error("PnL asset must be null while all cumulative values are unknown.");
  if (values.cumulativeNetPnl !== null
    && (values.cumulativeFundingPnl === null || values.realizedTradingPnl === null || values.feesCosts === null)) {
    throw new Error("Cumulative net PnL requires all actual component values.");
  }
  return Object.freeze({
    asset: pnl.asset === null ? null : asset(pnl.asset),
    ...values,
    updatedAt: pnl.updatedAt === null ? null : timestamp(pnl.updatedAt, "pnl.updatedAt"),
  });
}

function legFromRow(row: LegRow): ArbitrageInstanceLeg {
  return Object.freeze({
    legId: row.legId,
    role: legRole(row.role),
    venue: venue(row.venue),
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    plannedQuantity: normalizePositiveDecimal(row.plannedQuantity, "plannedQuantity"),
    confirmedOpenedQuantity: normalizeUnsignedDecimal(row.confirmedOpenedQuantity, "confirmedOpenedQuantity"),
    confirmedClosedQuantity: normalizeUnsignedDecimal(row.confirmedClosedQuantity, "confirmedClosedQuantity"),
  });
}

function referenceFromRow(row: ReferenceRow): ArbitrageExecutionReference {
  return Object.freeze({
    arbitrageId: row.arbitrageId,
    legId: row.legId,
    phase: executionPhase(row.phase),
    quantityEffect: quantityEffect(row.quantityEffect),
    executionIntentId: row.executionIntentId,
    executionRecordId: row.executionRecordId,
    requestedQuantity: normalizePositiveDecimal(row.requestedQuantity, "requestedQuantity"),
    confirmedQuantity: normalizeUnsignedDecimal(row.confirmedQuantity, "confirmedQuantity"),
    status: referenceStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function subtractForDelta(left: string, right: string) {
  const normalizedLeft = normalizeUnsignedDecimal(left, "confirmedQuantity");
  const normalizedRight = normalizeUnsignedDecimal(right, "previousConfirmedQuantity");
  const leftParts = decimalParts(normalizedLeft);
  const rightParts = decimalParts(normalizedRight);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftValue = leftParts.value * 10n ** BigInt(scale - leftParts.scale);
  const rightValue = rightParts.value * 10n ** BigInt(scale - rightParts.scale);
  const value = leftValue - rightValue;
  const digits = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function decimalParts(value: string) {
  const [integer, fraction = ""] = value.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function nullableSignedDecimal(value: string | null, name: string) {
  return value === null ? null : normalizeSignedDecimal(value, name);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function asset(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value)) {
    throw new Error("PnL asset is invalid.");
  }
  return value;
}

function instrumentId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(value)) {
    throw new Error("instrumentId must be a canonical instrument id.");
  }
  return value;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}

function strategyType(value: unknown) {
  if (value !== "PERPETUAL_PERPETUAL" && value !== "SPOT_PERPETUAL") {
    throw new Error("Arbitrage strategy type is invalid.");
  }
  return value;
}

function instanceStatus(value: unknown): ArbitrageInstanceStatus {
  if (value !== "OPENING" && value !== "HOLDING" && value !== "RESIDUAL"
    && value !== "CLOSING" && value !== "CLOSED" && value !== "FAILED") {
    throw new Error("Arbitrage instance status is invalid.");
  }
  return value;
}

function legRole(value: unknown): ArbitrageInstanceLeg["role"] {
  if (value !== "LONG" && value !== "SHORT") throw new Error("Arbitrage leg role is invalid.");
  return value;
}

function venue(value: unknown): ArbitrageInstanceLeg["venue"] {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("Arbitrage leg venue is invalid.");
  }
  return value;
}

function executionPhase(value: unknown): ArbitrageExecutionPhase {
  if (value !== "OPENING" && value !== "ADJUSTMENT" && value !== "CLOSING") {
    throw new Error("Arbitrage execution phase is invalid.");
  }
  return value;
}

function quantityEffect(value: unknown): ArbitrageQuantityEffect {
  if (value !== "INCREASE" && value !== "DECREASE") {
    throw new Error("Arbitrage quantity effect is invalid.");
  }
  return value;
}

function referenceStatus(value: unknown): ArbitrageExecutionReferenceStatus {
  if (value !== "CLAIMED" && value !== "LINKED" && value !== "PENDING_CONFIRMATION" && value !== "CONFIRMED"
    && value !== "FAILED" && value !== "UNKNOWN") {
    throw new Error("Arbitrage execution reference status is invalid.");
  }
  return value;
}

function assertPhaseAllowed(status: ArbitrageInstanceStatus, phase: ArbitrageExecutionPhase) {
  const allowed = phase === "OPENING"
    ? status === "OPENING" || status === "RESIDUAL"
    : phase === "ADJUSTMENT"
      ? status === "HOLDING" || status === "RESIDUAL"
      : status === "HOLDING" || status === "RESIDUAL" || status === "CLOSING";
  if (!allowed) throw new Error(`Arbitrage instance status ${status} does not accept ${phase} execution.`);
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique|primary key/iu.test(error.message);
}
