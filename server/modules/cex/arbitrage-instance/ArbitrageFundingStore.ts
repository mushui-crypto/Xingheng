import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArbitrageFundingFact, FundingHistoryCoverage } from "./FundingAccounting";

export class ArbitrageFundingStore {
  private readonly db: DatabaseSync;

  constructor(options: Readonly<{ dbPath?: string }> = {}) {
    const dbPath = options.dbPath ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  recordFact(fact: ArbitrageFundingFact) {
    validateFact(fact);
    const existing = this.db.prepare("SELECT * FROM arbitrage_funding_facts WHERE providerFundingId = ?")
      .get(fact.providerFundingId) as unknown as FundingFactRow | undefined;
    if (existing) {
      const persisted = factFromRow(existing);
      const conflict = providerFieldsConflict(persisted, fact);
      const weakerReplay = !conflict && weakerProviderEvidence(persisted, fact);
      const merged = Object.freeze({
        ...fact,
        positionSideOrBucket: fact.positionSideOrBucket ?? persisted.positionSideOrBucket,
        providerPositionSize: fact.providerPositionSize ?? persisted.providerPositionSize,
        amountUsdt: conflict ? null : weakerReplay ? persisted.amountUsdt : fact.amountUsdt,
        arbitrageId: conflict ? null : weakerReplay ? persisted.arbitrageId : fact.arbitrageId,
        attributionStatus: conflict ? "INCOMPLETE" as const
          : weakerReplay ? persisted.attributionStatus : fact.attributionStatus,
        integrityStatus: conflict || persisted.integrityStatus === "CONFLICT"
          ? "CONFLICT" as const : fact.integrityStatus,
        createdAt: persisted.createdAt,
      });
      const safe = merged.integrityStatus === "CONFLICT"
        ? Object.freeze({ ...merged, amountUsdt: null, arbitrageId: null, attributionStatus: "INCOMPLETE" as const })
        : merged;
      this.db.prepare(`UPDATE arbitrage_funding_facts SET
        venue = ?, accountId = ?, instrumentId = ?, positionSideOrBucket = ?, providerPositionSize = ?,
        settlementTime = ?, amount = ?, asset = ?, amountUsdt = ?, arbitrageId = ?,
        attributionStatus = ?, integrityStatus = ? WHERE providerFundingId = ?`).run(
          safe.venue, safe.accountId, safe.instrumentId, safe.positionSideOrBucket,
          safe.providerPositionSize, safe.settlementTime, safe.amount, safe.asset, safe.amountUsdt,
          safe.arbitrageId, safe.attributionStatus, safe.integrityStatus, safe.providerFundingId,
        );
      return safe;
    }
    this.db.prepare(`INSERT INTO arbitrage_funding_facts (
      providerFundingId, venue, accountId, instrumentId, positionSideOrBucket, providerPositionSize,
      settlementTime, amount, asset, amountUsdt, arbitrageId, attributionStatus, integrityStatus, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fact.providerFundingId, fact.venue, fact.accountId, fact.instrumentId,
      fact.positionSideOrBucket, fact.providerPositionSize, fact.settlementTime, fact.amount, fact.asset,
      fact.amountUsdt, fact.arbitrageId, fact.attributionStatus, fact.integrityStatus, fact.createdAt,
    );
    return fact;
  }

  listFacts(venue: string, accountId: string, instrumentId: string) {
    const rows = this.db.prepare(`SELECT * FROM arbitrage_funding_facts
      WHERE venue = ? AND accountId = ? AND instrumentId = ?
      ORDER BY settlementTime ASC, providerFundingId ASC`).all(
      identifier(venue), identifier(accountId), identifier(instrumentId),
    ) as unknown as FundingFactRow[];
    return Object.freeze(rows.map(factFromRow));
  }

  readCoverage(venue: string, accountId: string, instrumentId: string): FundingHistoryCoverage | null {
    const row = this.db.prepare(`SELECT * FROM arbitrage_funding_history_coverage
      WHERE venue = ? AND accountId = ? AND instrumentId = ?`).get(
      identifier(venue), identifier(accountId), identifier(instrumentId),
    ) as unknown as FundingCoverageRow | undefined;
    return row ? coverageFromRow(row) : null;
  }

  recordCoverage(coverage: FundingHistoryCoverage) {
    validateCoverage(coverage);
    const existing = this.readCoverage(coverage.venue, coverage.accountId, coverage.instrumentId);
    if (existing && coverage.coveredFrom > existing.coveredThrough + 1) {
      throw new Error("Funding history coverage cannot contain an unproven gap.");
    }
    const combined = Object.freeze({
      ...coverage,
      coveredFrom: existing ? Math.min(existing.coveredFrom, coverage.coveredFrom) : coverage.coveredFrom,
      coveredThrough: existing ? Math.max(existing.coveredThrough, coverage.coveredThrough) : coverage.coveredThrough,
      lastSuccessfulReadAt: Math.max(existing?.lastSuccessfulReadAt ?? 0, coverage.lastSuccessfulReadAt),
      paginationComplete: Boolean(coverage.paginationComplete && (existing?.paginationComplete ?? true)),
    });
    this.db.prepare(`INSERT INTO arbitrage_funding_history_coverage (
      venue, accountId, instrumentId, coveredFrom, coveredThrough,
      lastSuccessfulReadAt, paginationComplete
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(venue, accountId, instrumentId) DO UPDATE SET
      coveredFrom=excluded.coveredFrom, coveredThrough=excluded.coveredThrough,
      lastSuccessfulReadAt=excluded.lastSuccessfulReadAt,
      paginationComplete=excluded.paginationComplete`).run(
      combined.venue, combined.accountId, combined.instrumentId, combined.coveredFrom,
      combined.coveredThrough, combined.lastSuccessfulReadAt, combined.paginationComplete ? 1 : 0,
    );
    return combined;
  }

  close() { this.db.close(); }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS arbitrage_funding_facts (
      providerFundingId TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      positionSideOrBucket TEXT,
      providerPositionSize TEXT,
      settlementTime INTEGER NOT NULL,
      amount TEXT NOT NULL,
      asset TEXT NOT NULL,
      amountUsdt TEXT,
      arbitrageId TEXT,
      attributionStatus TEXT NOT NULL CHECK(attributionStatus IN ('ATTRIBUTED','AMBIGUOUS','INCOMPLETE')),
      integrityStatus TEXT NOT NULL CHECK(integrityStatus IN ('VERIFIED','CONFLICT')),
      createdAt INTEGER NOT NULL,
      FOREIGN KEY(arbitrageId) REFERENCES arbitrage_instances(arbitrageId)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_arbitrage_funding_context
      ON arbitrage_funding_facts(venue, accountId, instrumentId, settlementTime);
    CREATE INDEX IF NOT EXISTS idx_arbitrage_funding_instance
      ON arbitrage_funding_facts(arbitrageId, settlementTime);
    CREATE TABLE IF NOT EXISTS arbitrage_funding_history_coverage (
      venue TEXT NOT NULL,
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      coveredFrom INTEGER NOT NULL,
      coveredThrough INTEGER NOT NULL,
      lastSuccessfulReadAt INTEGER NOT NULL,
      paginationComplete INTEGER NOT NULL CHECK(paginationComplete IN (0,1)),
      PRIMARY KEY(venue, accountId, instrumentId)
    ) STRICT;`);
    const columnRows = this.db.prepare("PRAGMA table_info(arbitrage_funding_facts)").all() as unknown as Array<{ name: string }>;
    const columns = new Set(columnRows.map(({ name }) => name));
    if (!columns.has("providerPositionSize")) {
      this.db.exec("ALTER TABLE arbitrage_funding_facts ADD COLUMN providerPositionSize TEXT;");
    }
    if (!columns.has("integrityStatus")) {
      this.db.exec("ALTER TABLE arbitrage_funding_facts ADD COLUMN integrityStatus TEXT NOT NULL DEFAULT 'VERIFIED' CHECK(integrityStatus IN ('VERIFIED','CONFLICT')); ");
    }
    this.db.exec(`UPDATE arbitrage_funding_facts
      SET amountUsdt = NULL, arbitrageId = NULL, attributionStatus = 'INCOMPLETE'
      WHERE providerPositionSize IS NULL;`);
  }
}

type FundingFactRow = Omit<ArbitrageFundingFact, "attributionStatus" | "integrityStatus"> & {
  attributionStatus: string; integrityStatus: string;
};
type FundingCoverageRow = Omit<FundingHistoryCoverage, "paginationComplete"> & { paginationComplete: number };

function factFromRow(row: FundingFactRow): ArbitrageFundingFact {
  if (row.attributionStatus !== "ATTRIBUTED" && row.attributionStatus !== "AMBIGUOUS"
    && row.attributionStatus !== "INCOMPLETE") throw new Error("Funding attribution status is invalid.");
  if (row.integrityStatus !== "VERIFIED" && row.integrityStatus !== "CONFLICT") {
    throw new Error("Funding integrity status is invalid.");
  }
  return Object.freeze({ ...row, attributionStatus: row.attributionStatus, integrityStatus: row.integrityStatus });
}
function coverageFromRow(row: FundingCoverageRow): FundingHistoryCoverage {
  return Object.freeze({ ...row, paginationComplete: row.paginationComplete === 1 });
}
function validateFact(fact: ArbitrageFundingFact) {
  for (const value of [fact.providerFundingId, fact.venue, fact.accountId, fact.instrumentId, fact.amount, fact.asset]) {
    identifier(value);
  }
  timestamp(fact.settlementTime); timestamp(fact.createdAt);
  decimal(fact.amount); if (fact.amountUsdt !== null) decimal(fact.amountUsdt);
  if (fact.providerPositionSize !== null) decimal(fact.providerPositionSize);
  if (fact.integrityStatus !== "VERIFIED" && fact.integrityStatus !== "CONFLICT") {
    throw new Error("Funding integrity status is invalid.");
  }
  if (fact.integrityStatus === "CONFLICT" && (fact.amountUsdt !== null || fact.arbitrageId !== null
    || fact.attributionStatus !== "INCOMPLETE")) throw new Error("Conflicting funding fact must fail closed.");
  if (fact.attributionStatus === "ATTRIBUTED" && (fact.arbitrageId === null
    || fact.positionSideOrBucket === null || fact.providerPositionSize === null
    || fact.integrityStatus !== "VERIFIED")) {
    throw new Error("Attributed funding fact requires complete verified evidence.");
  }
}
function validateCoverage(value: FundingHistoryCoverage) {
  identifier(value.venue); identifier(value.accountId); identifier(value.instrumentId);
  timestamp(value.coveredFrom); timestamp(value.coveredThrough); timestamp(value.lastSuccessfulReadAt);
  if (!value.paginationComplete || value.coveredThrough < value.coveredFrom) {
    throw new Error("Funding history coverage is incomplete.");
  }
}
function providerFieldsConflict(left: ArbitrageFundingFact, right: ArbitrageFundingFact) {
  return left.venue !== right.venue || left.accountId !== right.accountId
    || left.instrumentId !== right.instrumentId || knownConflict(left.positionSideOrBucket, right.positionSideOrBucket)
    || knownConflict(left.providerPositionSize, right.providerPositionSize)
    || left.settlementTime !== right.settlementTime || left.amount !== right.amount || left.asset !== right.asset;
}
function knownConflict(left: string | null, right: string | null) { return left !== null && right !== null && left !== right; }
function weakerProviderEvidence(left: ArbitrageFundingFact, right: ArbitrageFundingFact) {
  return (left.positionSideOrBucket !== null && right.positionSideOrBucket === null)
    || (left.providerPositionSize !== null && right.providerPositionSize === null);
}
function identifier(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 300) throw new Error("Funding identifier is invalid.");
  return text;
}
function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Funding timestamp is invalid.");
}
function decimal(value: string) {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) throw new Error("Funding amount is invalid.");
}
