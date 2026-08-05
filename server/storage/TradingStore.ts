import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccountTransferRecord,
  BalanceAdjustment,
  ChainScanCursor,
  DepositAddress,
  EmailTokenPurpose,
  EmailTokenRecord,
  ExternalWalletBinding,
  FundingAccount,
  FundingLedgerEntry,
  MarketSymbol,
  OnchainDeposit,
  OrderRecord,
  Position,
  SimulationAccount,
  TradingAccount,
  User,
  WithdrawalRequest,
} from "../types";
import type { SessionRole } from "../auth/security";
import type {
  RealTradingAuditOutcome,
  RealTradingAuditRecord,
  RealTradingIdempotencyReservation,
  RealTradingIdempotencyResult,
  RealTradingIdempotencyState,
} from "../modules/hyperliquid/realTradingAuditTypes";
import type { RealTradingAgentBinding } from "../modules/hyperliquid/HyperliquidSignatureVerifier";

const defaultDbPath = resolve(process.cwd(), "server/data/trading.sqlite");

type AccountRow = Omit<TradingAccount, "asset" | "id"> & {
  id?: string | null;
  asset?: TradingAccount["asset"] | null;
  currency?: TradingAccount["asset"] | null;
};
type SimulationAccountRow = Omit<SimulationAccount, "asset" | "lastResetAt"> & {
  asset?: SimulationAccount["asset"] | null;
  currency?: SimulationAccount["asset"] | null;
  lastResetAt?: number | null;
};
type PositionRow = Omit<Position, "source" | "accountId" | "simulationAccountId"> & {
  accountId?: string | null;
  simulationAccountId?: string | null;
  source: Position["source"];
};
type OrderRow = Omit<OrderRecord, "simulated" | "simulationAccountId"> & { simulated: number; simulationAccountId?: string | null };
type AdjustmentRow = BalanceAdjustment;
type FundingAccountRow = Omit<FundingAccount, "available">;
type RealTradingAccountRow = Omit<FundingAccount, "available">;
type DepositAddressRow = DepositAddress;
type ExternalWalletBindingRow = Omit<ExternalWalletBinding, "isDefault"> & { isDefault: number };
type OnchainDepositRow = OnchainDeposit;
type ChainScanCursorRow = ChainScanCursor;
type FundingLedgerRow = FundingLedgerEntry;
type WithdrawalRequestRow = WithdrawalRequest;
type AccountTransferRow = AccountTransferRecord;
type UserRow = User & { password: string; stepUpEnrollmentInvalidatedAt?: number };
type AuthSessionRow = {
  tokenHash: string;
  subjectId: string;
  role: SessionRole;
  expiresAt: number;
  createdAt: number;
};
type MarketSymbolRow = Omit<MarketSymbol, "isVisible" | "iconUrl"> & { isVisible: number };
type EmailTokenRow = Omit<EmailTokenRecord, "userId" | "usedAt"> & {
  userId?: string | null;
  usedAt?: number | null;
};
type RealTradingAuditRow = Omit<RealTradingAuditRecord, "clientOrderIds"> & { clientOrderIds: string };
type RealTradingIdempotencyRow = {
  userId?: string;
  masterAddress?: string;
  network?: string;
  cloid?: string;
  actionType?: string;
  requestId: string;
  state: RealTradingIdempotencyState;
  submittedAt: number;
  receiptJson: string | null;
  requestFingerprint: string;
  completedAt?: number | null;
  reconcileAttemptCount?: number | null;
  lastReconcileAttemptAt?: number | null;
  lastReconcileError?: string | null;
};
type RealTradingAgentBindingRow = RealTradingAgentBinding;

export type BinanceBindingStatus = "active" | "verified_unbound" | "unverified_unbound";
export type BinanceBindingInterventionStatus = "none" | "manual_intervention";
export type BinanceCredentialBinding = {
  userId: string;
  venue: "binance";
  uidSnapshot: string;
  credentialNote: string;
  bindingVersion: number;
  status: BinanceBindingStatus;
  interventionStatus: BinanceBindingInterventionStatus;
  createdAt: number;
  updatedAt: number;
};
export type BinanceRecoveryUnbindResult = {
  receiptId: string;
  operationId: string;
  venue: "binance";
  uidSnapshot: string;
  bindingVersion: number;
  status: "verified_unbound" | "unverified_unbound";
  interventionStatus: BinanceBindingInterventionStatus;
  accountCleared: boolean;
};
export type BinanceRecoveryReceipt = {
  receiptId: string;
  operationId: string;
  userId: string;
  venue: "binance";
  uidSnapshot: string;
  bindingVersion: number;
  operator: string;
  approver: string;
  reason: string;
  result: string;
  timestamp: number;
  digest: string;
};
export type BinanceBindingAuditReceipt = {
  receiptId: string;
  operationId: string;
  userId: string;
  venue: "binance";
  uidSnapshot: string;
  bindingVersion: number;
  operator: string;
  reason: string;
  result: "bound" | "uid_changed" | "credential_note_updated" | "verified_unbound";
  timestamp: number;
  digest: string;
};

export class BinanceBindingStoreError extends Error {
  constructor(readonly category:
    | "binding_active"
    | "binding_not_found"
    | "binding_version_conflict"
    | "idempotency_conflict"
    | "operation_in_progress", message: string) {
    super(message);
  }
}

export class TradingStore {
  private db: DatabaseSync;
  private lastRealTradingAuditMaintenanceAt = 0;
  private lastRealTradingAuditPurgeDeleted = 0;

  constructor(dbPath = process.env.TRADING_DB_PATH ?? defaultDbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.maintainRealTradingAudit();
  }

  transaction<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  findBinanceCredentialBinding(userId: string, venue = "binance") {
    return this.db.prepare(
      "SELECT * FROM binance_credential_bindings WHERE userId = ? AND venue = ?",
    ).get(userId, venue) as BinanceCredentialBinding | undefined;
  }

  bindBinanceCredential(
    userId: string,
    uidSnapshot: string,
    credentialNote = "",
    now = Date.now(),
  ) {
    assertBinanceBindingIdentity(userId, uidSnapshot);
    const normalizedNote = normalizeCredentialNote(credentialNote);
    return this.transaction(() => {
      const existing = this.findBinanceCredentialBinding(userId);
      if (existing) {
        if (existing.status === "active") {
          throw new BinanceBindingStoreError("binding_active", "当前用户已有有效的 Binance Credential Binding。");
        }
        const bindingVersion = existing.bindingVersion + 1;
        this.db.prepare(
          `UPDATE binance_credential_bindings
           SET uidSnapshot = ?, credentialNote = ?, bindingVersion = ?, status = 'active',
               interventionStatus = 'none', updatedAt = ?
           WHERE userId = ? AND venue = 'binance' AND bindingVersion = ? AND status != 'active'`,
        ).run(uidSnapshot, normalizedNote, bindingVersion, now, userId, existing.bindingVersion);
        const binding = this.findBinanceCredentialBinding(userId)!;
        this.insertBinanceBindingAudit({
          userId,
          uidSnapshot,
          bindingVersion,
          operator: userId,
          reason: "credential_rebound",
          result: existing.uidSnapshot === uidSnapshot ? "bound" : "uid_changed",
          timestamp: now,
        });
        return binding;
      }
      this.db.prepare(
        `INSERT INTO binance_credential_bindings (
           userId, venue, uidSnapshot, credentialNote, bindingVersion, status,
           interventionStatus, createdAt, updatedAt
         ) VALUES (?, 'binance', ?, ?, 1, 'active', 'none', ?, ?)`,
      ).run(userId, uidSnapshot, normalizedNote, now, now);
      const binding = this.findBinanceCredentialBinding(userId)!;
      this.insertBinanceBindingAudit({
        userId,
        uidSnapshot,
        bindingVersion: 1,
        operator: userId,
        reason: "credential_bound",
        result: "bound",
        timestamp: now,
      });
      return binding;
    });
  }

  markBinanceVerifiedUnbound(userId: string, uidSnapshot: string, bindingVersion: number, now = Date.now()) {
    return this.transaction(() => {
      const binding = this.findBinanceCredentialBinding(userId);
      if (!binding || binding.uidSnapshot !== uidSnapshot) {
        throw new BinanceBindingStoreError("binding_not_found", "当前用户不存在匹配的 Binance Credential Binding。");
      }
      if (binding.bindingVersion !== bindingVersion || binding.status !== "active") {
        throw new BinanceBindingStoreError("binding_version_conflict", "Binding 已变化，旧解绑请求不能继续执行。");
      }
      const nextVersion = bindingVersion + 1;
      const updated = this.db.prepare(
        `UPDATE binance_credential_bindings
         SET bindingVersion = ?, status = 'verified_unbound', interventionStatus = 'none', updatedAt = ?
         WHERE userId = ? AND venue = 'binance' AND bindingVersion = ? AND status = 'active'`,
      ).run(nextVersion, now, userId, bindingVersion);
      if (Number(updated.changes) !== 1) {
        throw new BinanceBindingStoreError("binding_version_conflict", "Binding 已变化，旧解绑请求不能继续执行。");
      }
      this.insertBinanceBindingAudit({
        userId,
        uidSnapshot,
        bindingVersion: nextVersion,
        operator: userId,
        reason: "credential_unbound",
        result: "verified_unbound",
        timestamp: now,
      });
      return this.findBinanceCredentialBinding(userId)!;
    });
  }

  updateBinanceCredentialNote(userId: string, credentialNote: string, now = Date.now()) {
    const normalizedNote = normalizeCredentialNote(credentialNote);
    return this.transaction(() => {
      const binding = this.findBinanceCredentialBinding(userId);
      if (!binding || binding.status !== "active") {
        throw new BinanceBindingStoreError("binding_not_found", "当前用户不存在有效的 Binance Credential Binding。");
      }
      if (binding.credentialNote === normalizedNote) return binding;
      const updated = this.db.prepare(
        `UPDATE binance_credential_bindings
         SET credentialNote = ?, updatedAt = ?
         WHERE userId = ? AND venue = 'binance' AND bindingVersion = ? AND status = 'active'`,
      ).run(normalizedNote, now, userId, binding.bindingVersion);
      if (Number(updated.changes) !== 1) {
        throw new BinanceBindingStoreError("binding_version_conflict", "Binding 已变化，备注修改不能继续执行。");
      }
      this.insertBinanceBindingAudit({
        userId,
        uidSnapshot: binding.uidSnapshot,
        bindingVersion: binding.bindingVersion,
        operator: userId,
        reason: "credential_note_updated",
        result: "credential_note_updated",
        timestamp: now,
      });
      return this.findBinanceCredentialBinding(userId)!;
    });
  }

  reserveBinanceRecoveryOperation(input: {
    operationId: string;
    userId: string;
    venue: "binance";
    requestDigest: string;
    now?: number;
  }): { kind: "reserved" } | { kind: "completed"; result: BinanceRecoveryUnbindResult } {
    assertOperationId(input.operationId);
    const existing = this.db.prepare(
      "SELECT userId, venue, requestDigest, resultJson FROM binance_binding_operations WHERE operationId = ?",
    ).get(input.operationId) as { userId: string; venue: string; requestDigest: string; resultJson: string | null } | undefined;
    if (existing) {
      if (existing.userId !== input.userId || existing.venue !== input.venue || existing.requestDigest !== input.requestDigest) {
        throw new BinanceBindingStoreError("idempotency_conflict", "operationId 已用于不同的 Recovery Unbind 请求。");
      }
      if (!existing.resultJson) {
        throw new BinanceBindingStoreError("operation_in_progress", "Recovery Unbind 请求正在处理中。");
      }
      return { kind: "completed", result: JSON.parse(existing.resultJson) as BinanceRecoveryUnbindResult };
    }
    try {
      this.db.prepare(
        `INSERT INTO binance_binding_operations (
           operationId, userId, venue, requestDigest, resultJson, createdAt, completedAt
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      ).run(input.operationId, input.userId, input.venue, input.requestDigest, input.now ?? Date.now());
    } catch (error) {
      const raced = this.db.prepare(
        "SELECT 1 FROM binance_binding_operations WHERE operationId = ?",
      ).get(input.operationId);
      if (raced) return this.reserveBinanceRecoveryOperation(input);
      throw error;
    }
    return { kind: "reserved" };
  }

  completeBinanceRecoveryUnbind(input: {
    operationId: string;
    userId: string;
    venue: "binance";
    requestDigest: string;
    uidSnapshot: string;
    bindingVersion: number;
    operator: string;
    approver: string;
    reason: string;
    providerVerifiedFlat: boolean;
    now?: number;
  }): BinanceRecoveryUnbindResult {
    const timestamp = input.now ?? Date.now();
    return this.transaction(() => {
      const operation = this.db.prepare(
        "SELECT userId, venue, requestDigest, resultJson FROM binance_binding_operations WHERE operationId = ?",
      ).get(input.operationId) as { userId: string; venue: string; requestDigest: string; resultJson: string | null } | undefined;
      if (!operation || operation.userId !== input.userId || operation.venue !== input.venue
        || operation.requestDigest !== input.requestDigest) {
        throw new BinanceBindingStoreError("idempotency_conflict", "Recovery Unbind operation reservation 不匹配。");
      }
      if (operation.resultJson) return JSON.parse(operation.resultJson) as BinanceRecoveryUnbindResult;
      const binding = this.findBinanceCredentialBinding(input.userId, input.venue);
      if (!binding) {
        throw new BinanceBindingStoreError("binding_not_found", "当前用户不存在匹配的 Binance Credential Binding。");
      }
      if (binding.bindingVersion !== input.bindingVersion || binding.status !== "active") {
        throw new BinanceBindingStoreError("binding_version_conflict", "Binding 已变化，旧 Recovery Unbind 请求不能继续执行。");
      }
      if (binding.uidSnapshot !== input.uidSnapshot) {
        throw new BinanceBindingStoreError("binding_not_found", "当前用户不存在匹配的 Binance Credential Binding。");
      }
      const bindingVersion = binding.bindingVersion + 1;
      const status = input.providerVerifiedFlat ? "verified_unbound" as const : "unverified_unbound" as const;
      const interventionStatus = input.providerVerifiedFlat ? "none" as const : "manual_intervention" as const;
      const receiptId = randomUUID();
      const result: BinanceRecoveryUnbindResult = {
        receiptId,
        operationId: input.operationId,
        venue: input.venue,
        uidSnapshot: input.uidSnapshot,
        bindingVersion,
        status,
        interventionStatus,
        accountCleared: input.providerVerifiedFlat,
      };
      const receiptCore = {
        receiptId,
        operationId: input.operationId,
        userId: input.userId,
        venue: input.venue,
        uidSnapshot: input.uidSnapshot,
        bindingVersion,
        operator: input.operator,
        approver: input.approver,
        reason: input.reason,
        result: status,
        timestamp,
      };
      const digest = createHash("sha256").update(JSON.stringify(receiptCore)).digest("hex");
      const updated = this.db.prepare(
        `UPDATE binance_credential_bindings
         SET bindingVersion = ?, status = ?, interventionStatus = ?, updatedAt = ?
         WHERE userId = ? AND venue = ? AND bindingVersion = ? AND status = 'active'`,
      ).run(bindingVersion, status, interventionStatus, timestamp, input.userId, input.venue, input.bindingVersion);
      if (Number(updated.changes) !== 1) {
        throw new BinanceBindingStoreError("binding_version_conflict", "Binding 已变化，旧 Recovery Unbind 请求不能继续执行。");
      }
      this.db.prepare(
        `INSERT INTO binance_recovery_receipts (
           receiptId, operationId, userId, venue, uidSnapshot, bindingVersion, operator, approver,
           reason, result, timestamp, digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receiptId, input.operationId, input.userId, input.venue, input.uidSnapshot, bindingVersion,
        input.operator, input.approver, input.reason, status, timestamp, digest,
      );
      this.db.prepare(
        "UPDATE binance_binding_operations SET resultJson = ?, completedAt = ? WHERE operationId = ? AND resultJson IS NULL",
      ).run(JSON.stringify(result), timestamp, input.operationId);
      return result;
    });
  }

  releaseBinanceRecoveryOperation(operationId: string, userId: string, requestDigest: string) {
    this.db.prepare(
      `DELETE FROM binance_binding_operations
       WHERE operationId = ? AND userId = ? AND requestDigest = ? AND resultJson IS NULL`,
    ).run(operationId, userId, requestDigest);
  }

  listBinanceRecoveryReceipts(userId: string) {
    return this.db.prepare(
      "SELECT * FROM binance_recovery_receipts WHERE userId = ? ORDER BY timestamp ASC, receiptId ASC",
    ).all(userId) as BinanceRecoveryReceipt[];
  }

  listBinanceBindingAudit(userId: string) {
    return this.db.prepare(
      "SELECT * FROM binance_binding_audit_receipts WHERE userId = ? ORDER BY sequence ASC",
    ).all(userId) as BinanceBindingAuditReceipt[];
  }

  private insertBinanceBindingAudit(input: Omit<BinanceBindingAuditReceipt,
    "receiptId" | "operationId" | "venue" | "digest">) {
    const receiptId = randomUUID();
    const operationId = randomUUID();
    const core = { receiptId, operationId, ...input, venue: "binance" as const };
    const digest = createHash("sha256").update(JSON.stringify(core)).digest("hex");
    this.db.prepare(
      `INSERT INTO binance_binding_audit_receipts (
         receiptId, operationId, userId, venue, uidSnapshot, bindingVersion,
         operator, reason, result, timestamp, digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId, operationId, input.userId, "binance", input.uidSnapshot, input.bindingVersion,
      input.operator, input.reason, input.result, input.timestamp, digest,
    );
  }

  listAccounts() {
    const rows = this.db.prepare("SELECT * FROM accounts ORDER BY createdAt DESC").all() as AccountRow[];
    return rows.map(toTradingAccount);
  }

  listUsers() {
    return this.db.prepare("SELECT id, email, nickname, status, createdAt, emailVerifiedAt FROM users ORDER BY createdAt DESC").all() as User[];
  }

  findUserByEmail(email: string) {
    return this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  }

  findUserById(id: string) {
    return this.db.prepare("SELECT id, email, nickname, status, createdAt, emailVerifiedAt FROM users WHERE id = ?").get(id) as User | undefined;
  }

  findUserPasswordById(id: string) {
    return this.db.prepare("SELECT id, password FROM users WHERE id = ?").get(id) as Pick<UserRow, "id" | "password"> | undefined;
  }

  getStepUpEnrollmentInvalidatedAt(id: string) {
    const row = this.db.prepare("SELECT stepUpEnrollmentInvalidatedAt FROM users WHERE id = ?").get(id) as
      | Pick<UserRow, "stepUpEnrollmentInvalidatedAt">
      | undefined;
    return Number(row?.stepUpEnrollmentInvalidatedAt ?? 0);
  }

  invalidateStepUpEnrollment(id: string, invalidatedAt = Date.now()) {
    this.db.prepare("UPDATE users SET stepUpEnrollmentInvalidatedAt = ? WHERE id = ?").run(invalidatedAt, id);
  }

  listUserPasswordRecords() {
    return this.db.prepare("SELECT id, password FROM users").all() as Array<Pick<UserRow, "id" | "password">>;
  }

  createUser(user: UserRow) {
    this.db
      .prepare(
        `INSERT INTO users (id, email, password, nickname, status, createdAt, emailVerifiedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, user.email, user.password, user.nickname ?? null, user.status, user.createdAt, user.emailVerifiedAt ?? null);
  }

  updateUserPassword(id: string, password: string) {
    this.db.prepare("UPDATE users SET password = ? WHERE id = ?").run(password, id);
  }

  upsertSeedUser(user: UserRow) {
    const existingById = this.db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow | undefined;
    const existingByEmail = this.db.prepare("SELECT * FROM users WHERE email = ?").get(user.email) as UserRow | undefined;
    const existing = existingById ?? existingByEmail;

    if (!existing) {
      this.createUser(user);
      return;
    }

    if (existing.id !== user.id || existing.email !== user.email) {
      this.db.prepare("UPDATE users SET id = ?, email = ? WHERE id = ?").run(user.id, user.email, existing.id);
    }
  }

  updateUserStatus(id: string, status: User["status"]) {
    this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
    if (status === "disabled") {
      this.invalidateStepUpEnrollment(id);
      this.db.prepare(
        `INSERT OR REPLACE INTO revoked_auth_sessions (tokenHash, subjectId, role, reason, expiresAt, createdAt)
         SELECT tokenHash, subjectId, role, 'disabled', expiresAt, ? FROM auth_sessions
         WHERE subjectId = ? AND role = 'user'`,
      ).run(Date.now(), id);
      this.deleteAuthSessionsForSubject(id, "user");
    }
  }

  createAuthSession(session: AuthSessionRow) {
    this.purgeExpiredAuthSessions();
    this.db
      .prepare(
        `INSERT INTO auth_sessions (tokenHash, subjectId, role, expiresAt, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(session.tokenHash, session.subjectId, session.role, session.expiresAt, session.createdAt);
  }

  findAuthSession(tokenHash: string, role: SessionRole) {
    const session = this.db
      .prepare("SELECT * FROM auth_sessions WHERE tokenHash = ? AND role = ?")
      .get(tokenHash, role) as AuthSessionRow | undefined;
    if (!session) {
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      this.deleteAuthSession(tokenHash, role);
      return null;
    }
    return session;
  }

  deleteAuthSession(tokenHash: string, role: SessionRole) {
    this.db.prepare("DELETE FROM auth_sessions WHERE tokenHash = ? AND role = ?").run(tokenHash, role);
    this.db.prepare("DELETE FROM revoked_auth_sessions WHERE tokenHash = ? AND role = ?").run(tokenHash, role);
  }

  findDisabledRevokedSession(tokenHash: string) {
    const row = this.db.prepare(
      `SELECT subjectId, expiresAt FROM revoked_auth_sessions
       WHERE tokenHash = ? AND role = 'user' AND reason = 'disabled'`,
    ).get(tokenHash) as { subjectId: string; expiresAt: number } | undefined;
    if (!row || row.expiresAt <= Date.now()) return undefined;
    const user = this.findUserById(row.subjectId);
    return user?.status === "disabled" ? user : undefined;
  }

  deleteAuthSessionsForSubject(subjectId: string, role: SessionRole) {
    this.db.prepare("DELETE FROM auth_sessions WHERE subjectId = ? AND role = ?").run(subjectId, role);
  }

  createEmailToken(record: EmailTokenRecord) {
    this.db
      .prepare(
        `INSERT INTO email_tokens (
          id, email, purpose, userId, codeHash, tokenHash, expiresAt, usedAt, createdAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.email,
        record.purpose,
        record.userId ?? null,
        record.codeHash,
        record.tokenHash,
        record.expiresAt,
        record.usedAt ?? null,
        record.createdAt,
      );
  }

  findLatestEmailToken(email: string, purpose: EmailTokenPurpose) {
    const row = this.db
      .prepare("SELECT * FROM email_tokens WHERE email = ? AND purpose = ? ORDER BY createdAt DESC LIMIT 1")
      .get(email, purpose) as EmailTokenRow | undefined;
    return row ? toEmailToken(row) : null;
  }

  countEmailTokensSince(email: string, purpose: EmailTokenPurpose, since: number) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM email_tokens WHERE email = ? AND purpose = ? AND createdAt >= ?")
      .get(email, purpose, since) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  findLatestUsableEmailToken(email: string, purpose: EmailTokenPurpose, now = Date.now()) {
    const row = this.db
      .prepare(
        `SELECT * FROM email_tokens
         WHERE email = ? AND purpose = ? AND usedAt IS NULL AND expiresAt > ?
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(email, purpose, now) as EmailTokenRow | undefined;
    return row ? toEmailToken(row) : null;
  }

  findUsableEmailTokenByCodeHash(email: string, purpose: EmailTokenPurpose, codeHash: string, now = Date.now()) {
    const row = this.db
      .prepare(
        `SELECT * FROM email_tokens
         WHERE email = ? AND purpose = ? AND codeHash = ? AND usedAt IS NULL AND expiresAt > ?
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(email, purpose, codeHash, now) as EmailTokenRow | undefined;
    return row ? toEmailToken(row) : null;
  }

  findUsableEmailTokenByTokenHash(email: string, purpose: EmailTokenPurpose, tokenHash: string, now = Date.now()) {
    const row = this.db
      .prepare(
        `SELECT * FROM email_tokens
         WHERE email = ? AND purpose = ? AND tokenHash = ? AND usedAt IS NULL AND expiresAt > ?
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(email, purpose, tokenHash, now) as EmailTokenRow | undefined;
    return row ? toEmailToken(row) : null;
  }

  markEmailTokenUsed(id: string, usedAt = Date.now()) {
    this.db.prepare("UPDATE email_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL").run(usedAt, id);
  }

  purgeExpiredAuthSessions() {
    this.db.prepare("DELETE FROM auth_sessions WHERE expiresAt <= ?").run(Date.now());
  }

  getMarketSymbol(symbol: string) {
    const row = this.db.prepare("SELECT * FROM market_symbols WHERE symbol = ?").get(symbol) as MarketSymbolRow | undefined;
    return row ? toMarketSymbol(row) : null;
  }

  listMarketSymbols() {
    const rows = this.db.prepare("SELECT * FROM market_symbols ORDER BY symbol").all() as MarketSymbolRow[];
    return rows.map(toMarketSymbol);
  }

  upsertMarketSymbol(symbol: MarketSymbol) {
    this.db
      .prepare(
        `INSERT INTO market_symbols (
           symbol, displayName, apiSymbol, providerMarketId, providerCoin, sourceDex, sourceType, category,
           digits, spread, leverage, contractSize,
           minLot, maxLot, lotStep, tradeStatus, isVisible, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           displayName = excluded.displayName,
           apiSymbol = excluded.apiSymbol,
           providerMarketId = excluded.providerMarketId,
           providerCoin = excluded.providerCoin,
           sourceDex = excluded.sourceDex,
           sourceType = excluded.sourceType,
           category = excluded.category,
           digits = excluded.digits,
           spread = excluded.spread,
           leverage = excluded.leverage,
           contractSize = excluded.contractSize,
           minLot = excluded.minLot,
           maxLot = excluded.maxLot,
           lotStep = excluded.lotStep,
           tradeStatus = excluded.tradeStatus,
           isVisible = excluded.isVisible,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        symbol.symbol,
        symbol.displayName,
        symbol.apiSymbol,
        symbol.providerMarketId,
        symbol.providerCoin,
        symbol.sourceDex,
        symbol.sourceType,
        symbol.category,
        symbol.digits,
        symbol.spread,
        symbol.leverage,
        symbol.contractSize,
        symbol.minLot,
        symbol.maxLot,
        symbol.lotStep,
        symbol.tradeStatus,
        symbol.isVisible ? 1 : 0,
        Date.now(),
      );
  }

  upsertAccount(account: TradingAccount) {
    const normalized = toTradingAccount(account);
    this.db
      .prepare(
        `INSERT INTO accounts (id, userId, currency, balance, equity, usedMargin, freeMargin, floatingPnl, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           id = excluded.id,
           currency = excluded.currency,
           balance = excluded.balance,
           equity = excluded.equity,
           usedMargin = excluded.usedMargin,
           freeMargin = excluded.freeMargin,
           floatingPnl = excluded.floatingPnl,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        normalized.id,
        normalized.userId,
        normalized.asset,
        normalized.balance,
        normalized.equity,
        normalized.usedMargin,
        normalized.freeMargin,
        normalized.floatingPnl,
        normalized.createdAt,
        normalized.updatedAt,
      );
  }

  listSimulationAccounts(userId?: string, includeDeleted = false) {
    const conditions: string[] = [];
    const params: string[] = [];
    if (userId) {
      conditions.push("userId = ?");
      params.push(userId);
    }
    if (!includeDeleted) {
      conditions.push("status != 'deleted'");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM simulation_accounts ${where} ORDER BY createdAt ASC`)
      .all(...params) as SimulationAccountRow[];
    return rows.map(toSimulationAccount);
  }

  getSimulationAccount(id: string) {
    const row = this.db.prepare("SELECT * FROM simulation_accounts WHERE id = ?").get(id) as SimulationAccountRow | undefined;
    return row ? toSimulationAccount(row) : undefined;
  }

  upsertSimulationAccount(account: SimulationAccount) {
    const normalized = toSimulationAccount(account);
    this.db
      .prepare(
        `INSERT INTO simulation_accounts (
           id, userId, name, currency, balance, equity, usedMargin, freeMargin, floatingPnl,
           status, lastResetAt, createdAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
           name = excluded.name,
           currency = excluded.currency,
           balance = excluded.balance,
           equity = excluded.equity,
           usedMargin = excluded.usedMargin,
           freeMargin = excluded.freeMargin,
           floatingPnl = excluded.floatingPnl,
           status = excluded.status,
           lastResetAt = excluded.lastResetAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        normalized.id,
        normalized.userId,
        normalized.name,
        normalized.asset,
        normalized.balance,
        normalized.equity,
        normalized.usedMargin,
        normalized.freeMargin,
        normalized.floatingPnl,
        normalized.status,
        normalized.lastResetAt ?? null,
        normalized.createdAt,
        normalized.updatedAt,
      );
  }

  listPositions() {
    const rows = this.db
      .prepare(
        `SELECT positions.*
         FROM positions
         INNER JOIN simulation_accounts ON simulation_accounts.id = positions.accountId
         ORDER BY positions.openedAt DESC`,
      )
      .all() as PositionRow[];
    return rows.map((row) => {
      const accountId = row.accountId ?? row.simulationAccountId ?? `LEGACY-${row.userId}`;
      return {
        ...row,
        accountId,
        simulationAccountId: accountId,
      };
    }) satisfies Position[];
  }

  savePosition(position: Position) {
    this.db
      .prepare(
        `INSERT INTO positions (id, userId, accountId, symbol, side, volume, entryPrice, margin, openedAt, source, quoteTime, entryBid, entryAsk, entrySpread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
           accountId = excluded.accountId,
           symbol = excluded.symbol,
           side = excluded.side,
           volume = excluded.volume,
           entryPrice = excluded.entryPrice,
           margin = excluded.margin,
           openedAt = excluded.openedAt,
           source = excluded.source,
           quoteTime = excluded.quoteTime,
           entryBid = excluded.entryBid,
           entryAsk = excluded.entryAsk,
           entrySpread = excluded.entrySpread`,
      )
      .run(
        position.id,
        position.userId,
        position.accountId,
        position.symbol,
        position.side,
        position.volume,
        position.entryPrice,
        position.margin,
        position.openedAt,
        position.source,
        position.quoteTime,
        position.entryBid,
        position.entryAsk,
        position.entrySpread,
      );
  }

  deletePosition(positionId: string) {
    this.db.prepare("DELETE FROM positions WHERE id = ?").run(positionId);
  }

  listOrders() {
    const rows = this.db
      .prepare(
        `SELECT orders.*
         FROM orders
         INNER JOIN simulation_accounts ON simulation_accounts.id = orders.accountId
         ORDER BY orders.createdAt DESC`,
      )
      .all() as OrderRow[];
    return rows.map((row) => ({ ...row, simulationAccountId: row.simulationAccountId ?? row.accountId, simulated: Boolean(row.simulated) as true })) satisfies OrderRecord[];
  }

  cleanupLegacyTradingData() {
    this.db.exec(`
      DELETE FROM positions
      WHERE accountId IS NULL
         OR accountId = ''
         OR accountId LIKE 'LEGACY-%'
         OR accountId LIKE 'ACC-%'
         OR accountId NOT IN (SELECT id FROM simulation_accounts);

      DELETE FROM orders
      WHERE accountId IS NULL
         OR accountId = ''
         OR accountId LIKE 'LEGACY-%'
         OR accountId LIKE 'ACC-%'
         OR accountId NOT IN (SELECT id FROM simulation_accounts);

      DELETE FROM balance_adjustments;
      DELETE FROM accounts;
    `);
  }

  saveOrder(order: OrderRecord) {
    this.db
      .prepare(
        `INSERT INTO orders (
           id, userId, accountId, positionId, symbol, side, positionSide, orderType, action, status,
           volume, price, bid, ask, spread, source, quoteTime, simulated, reason, pnl, createdAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        order.id,
        order.userId,
        order.accountId,
        order.positionId ?? null,
        order.symbol,
        order.side,
        order.positionSide,
        order.orderType,
        order.action,
        order.status,
        order.volume,
        order.price,
        order.bid,
        order.ask,
        order.spread,
        order.source,
        order.quoteTime,
        order.simulated ? 1 : 0,
        order.reason ?? null,
        order.pnl ?? null,
        order.createdAt,
      );
  }

  listAdjustments() {
    return this.db.prepare("SELECT * FROM balance_adjustments ORDER BY createdAt DESC").all() as AdjustmentRow[];
  }

  saveAdjustment(adjustment: BalanceAdjustment) {
    this.db
      .prepare(
        `INSERT INTO balance_adjustments (id, accountId, userId, type, amount, previousBalance, nextBalance, note, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        adjustment.id,
        adjustment.accountId,
        adjustment.userId,
        adjustment.type,
        adjustment.amount,
        adjustment.previousBalance,
        adjustment.nextBalance,
        adjustment.note ?? null,
        adjustment.createdAt,
      );
  }

  listFundingAccounts() {
    const rows = this.db.prepare("SELECT * FROM funding_accounts ORDER BY createdAt DESC").all() as FundingAccountRow[];
    return rows.map(toFundingAccount);
  }

  getFundingAccount(userId: string) {
    const row = this.db.prepare("SELECT * FROM funding_accounts WHERE userId = ?").get(userId) as FundingAccountRow | undefined;
    return row ? toFundingAccount(row) : null;
  }

  upsertFundingAccount(account: FundingAccount) {
    this.db
      .prepare(
        `INSERT INTO funding_accounts (id, userId, asset, balance, frozen, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           id = excluded.id,
           asset = excluded.asset,
           balance = excluded.balance,
           frozen = excluded.frozen,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(account.id, account.userId, account.asset, account.balance, account.frozen, account.createdAt, account.updatedAt);
  }

  listRealTradingAccounts() {
    const rows = this.db.prepare("SELECT * FROM real_trading_accounts ORDER BY createdAt DESC").all() as RealTradingAccountRow[];
    return rows.map(toFundingAccount);
  }

  getRealTradingAccount(userId: string) {
    const row = this.db.prepare("SELECT * FROM real_trading_accounts WHERE userId = ?").get(userId) as
      | RealTradingAccountRow
      | undefined;
    return row ? toFundingAccount(row) : null;
  }

  upsertRealTradingAccount(account: FundingAccount) {
    this.db
      .prepare(
        `INSERT INTO real_trading_accounts (id, userId, asset, balance, frozen, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           id = excluded.id,
           asset = excluded.asset,
           balance = excluded.balance,
           frozen = excluded.frozen,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(account.id, account.userId, account.asset, account.balance, account.frozen, account.createdAt, account.updatedAt);
  }

  listDepositAddresses() {
    return this.db.prepare("SELECT * FROM wallet_addresses ORDER BY derivationIndex ASC, createdAt ASC").all() as unknown as DepositAddressRow[];
  }

  listOnchainDeposits(userId?: string) {
    const sql = userId
      ? "SELECT * FROM onchain_deposits WHERE userId = ? ORDER BY blockNumber DESC, logIndex DESC"
      : "SELECT * FROM onchain_deposits ORDER BY blockNumber DESC, logIndex DESC";
    return (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as OnchainDepositRow[];
  }

  listPendingOnchainDeposits() {
    return this.db
      .prepare("SELECT * FROM onchain_deposits WHERE status IN ('detected', 'confirming') ORDER BY blockNumber ASC, logIndex ASC")
      .all() as OnchainDepositRow[];
  }

  getOnchainDeposit(id: string) {
    return this.db.prepare("SELECT * FROM onchain_deposits WHERE id = ?").get(id) as OnchainDepositRow | undefined;
  }

  findOnchainDepositByTransfer(network: string, txHash: string, logIndex: number) {
    return this.db
      .prepare("SELECT * FROM onchain_deposits WHERE network = ? AND lower(txHash) = lower(?) AND logIndex = ?")
      .get(network, txHash, logIndex) as OnchainDepositRow | undefined;
  }

  saveOnchainDeposit(deposit: OnchainDeposit) {
    this.db
      .prepare(
        `INSERT INTO onchain_deposits (
           id, userId, asset, network, chainId, tokenAddress, fromAddress, toAddress, amount, amountDecimal,
           txHash, logIndex, blockNumber, blockHash, confirmations, status, creditedLedgerId,
           failedReason, detectedAt, confirmedAt, createdAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(network, txHash, logIndex) DO UPDATE SET
           userId = excluded.userId,
           asset = excluded.asset,
           chainId = excluded.chainId,
           tokenAddress = excluded.tokenAddress,
           fromAddress = excluded.fromAddress,
           toAddress = excluded.toAddress,
           amount = excluded.amount,
           amountDecimal = excluded.amountDecimal,
           blockNumber = excluded.blockNumber,
           blockHash = excluded.blockHash,
           confirmations = excluded.confirmations,
           status = excluded.status,
           creditedLedgerId = excluded.creditedLedgerId,
           failedReason = excluded.failedReason,
           detectedAt = excluded.detectedAt,
           confirmedAt = excluded.confirmedAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        deposit.id,
        deposit.userId,
        deposit.asset,
        deposit.network,
        deposit.chainId,
        deposit.tokenAddress,
        deposit.fromAddress,
        deposit.toAddress,
        deposit.amount,
        deposit.amountDecimal,
        deposit.txHash,
        deposit.logIndex,
        deposit.blockNumber,
        deposit.blockHash ?? null,
        deposit.confirmations,
        deposit.status,
        deposit.creditedLedgerId ?? null,
        deposit.failedReason ?? null,
        deposit.detectedAt,
        deposit.confirmedAt ?? null,
        deposit.createdAt,
        deposit.updatedAt,
      );
  }

  getChainScanCursor(network: string, tokenAddress: string) {
    return this.db
      .prepare("SELECT * FROM chain_scan_cursors WHERE network = ? AND lower(tokenAddress) = lower(?)")
      .get(network, tokenAddress) as ChainScanCursorRow | undefined;
  }

  saveChainScanCursor(cursor: ChainScanCursor) {
    this.db
      .prepare(
        `INSERT INTO chain_scan_cursors (id, network, chainId, tokenAddress, lastScannedBlock, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(network, tokenAddress) DO UPDATE SET
           chainId = excluded.chainId,
           lastScannedBlock = excluded.lastScannedBlock,
           updatedAt = excluded.updatedAt`,
      )
      .run(cursor.id, cursor.network, cursor.chainId, cursor.tokenAddress, cursor.lastScannedBlock, cursor.updatedAt);
  }

  getDepositAddressByUserId(userId: string) {
    return this.db.prepare("SELECT * FROM wallet_addresses WHERE userId = ?").get(userId) as DepositAddressRow | undefined;
  }

  getDepositAddressByAddress(address: string) {
    return this.db.prepare("SELECT * FROM wallet_addresses WHERE lower(address) = lower(?)").get(address) as DepositAddressRow | undefined;
  }

  getMaxDepositDerivationIndex() {
    const row = this.db.prepare("SELECT MAX(derivationIndex) as maxIndex FROM wallet_addresses").get() as { maxIndex: number | null } | undefined;
    return row?.maxIndex ?? null;
  }

  saveDepositAddress(address: DepositAddress) {
    this.db
      .prepare(
        `INSERT INTO wallet_addresses (id, userId, network, address, derivationIndex, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           network = excluded.network,
           address = excluded.address,
           derivationIndex = excluded.derivationIndex,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        address.id,
        address.userId,
        address.network,
        address.address,
        address.derivationIndex,
        address.createdAt,
        address.updatedAt,
      );
  }

  getExternalWalletBindingByUserId(userId: string) {
    const row = this.db.prepare("SELECT * FROM external_wallet_bindings WHERE userId = ?").get(userId) as ExternalWalletBindingRow | undefined;
    return row ? toExternalWalletBinding(row) : undefined;
  }

  getExternalWalletBindingByAddress(walletAddress: string) {
    const row = this.db
      .prepare("SELECT * FROM external_wallet_bindings WHERE lower(walletAddress) = lower(?)")
      .get(walletAddress) as ExternalWalletBindingRow | undefined;
    return row ? toExternalWalletBinding(row) : undefined;
  }

  getExternalWalletBindingById(id: string) {
    const row = this.db.prepare("SELECT * FROM external_wallet_bindings WHERE id = ?").get(id) as ExternalWalletBindingRow | undefined;
    return row ? toExternalWalletBinding(row) : undefined;
  }

  listExternalWalletBindings() {
    const rows = this.db
      .prepare("SELECT * FROM external_wallet_bindings ORDER BY updatedAt DESC, createdAt DESC")
      .all() as ExternalWalletBindingRow[];
    return rows.map(toExternalWalletBinding);
  }

  saveExternalWalletBinding(binding: ExternalWalletBinding) {
    this.db
      .prepare(
        `INSERT INTO external_wallet_bindings (
           id, userId, walletAddress, network, provider, isDefault, bindStatus,
           nonce, challenge, challengeExpiresAt, lastVerifiedAt, createdAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           walletAddress = excluded.walletAddress,
           network = excluded.network,
           provider = excluded.provider,
           isDefault = excluded.isDefault,
           bindStatus = excluded.bindStatus,
           nonce = excluded.nonce,
           challenge = excluded.challenge,
           challengeExpiresAt = excluded.challengeExpiresAt,
           lastVerifiedAt = excluded.lastVerifiedAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        binding.id,
        binding.userId,
        binding.walletAddress,
        binding.network,
        binding.provider,
        binding.isDefault ? 1 : 0,
        binding.bindStatus,
        binding.nonce,
        binding.challenge,
        binding.challengeExpiresAt,
        binding.lastVerifiedAt ?? null,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  deleteExternalWalletBinding(id: string) {
    this.db.prepare("DELETE FROM external_wallet_bindings WHERE id = ?").run(id);
  }

  listFundingLedger(userId?: string) {
    const sql = userId
      ? "SELECT id, userId, accountId, accountType, type, source, asset, amount, balanceBefore, balanceAfter, frozenBefore, frozenAfter, status, relatedId, network, address, txHash, remark, createdAt, updatedAt FROM funding_ledger WHERE userId = ? ORDER BY createdAt DESC"
      : "SELECT id, userId, accountId, accountType, type, source, asset, amount, balanceBefore, balanceAfter, frozenBefore, frozenAfter, status, relatedId, network, address, txHash, remark, createdAt, updatedAt FROM funding_ledger ORDER BY createdAt DESC";
    return (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as FundingLedgerRow[];
  }

  saveFundingLedger(entry: FundingLedgerEntry) {
    this.db
      .prepare(
        `INSERT INTO funding_ledger (
           id, userId, accountId, accountType, type, source, asset, amount,
           balanceBefore, balanceAfter, frozenBefore, frozenAfter, status,
           relatedId, network, address, txHash, remark, createdAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        entry.id,
        entry.userId,
        entry.accountId,
        entry.accountType,
        entry.type,
        entry.source,
        entry.asset,
        entry.amount,
        entry.balanceBefore,
        entry.balanceAfter,
        entry.frozenBefore,
        entry.frozenAfter,
        entry.status,
        entry.relatedId ?? null,
        entry.network ?? null,
        entry.address ?? null,
        entry.txHash ?? null,
        entry.remark ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  listAccountTransfers(userId?: string) {
    const sql = userId
      ? `SELECT * FROM account_transfer_records
         WHERE fromUserId = ? OR toUserId = ?
         ORDER BY createdAt DESC`
      : "SELECT * FROM account_transfer_records ORDER BY createdAt DESC";
    return (userId ? this.db.prepare(sql).all(userId, userId) : this.db.prepare(sql).all()) as AccountTransferRow[];
  }

  getAccountTransferByClientRequestId(fromUserId: string, clientRequestId: string) {
    return this.db
      .prepare("SELECT * FROM account_transfer_records WHERE fromUserId = ? AND clientRequestId = ?")
      .get(fromUserId, clientRequestId) as AccountTransferRow | undefined;
  }

  saveAccountTransfer(record: AccountTransferRecord) {
    this.db
      .prepare(
        `INSERT INTO account_transfer_records (
           id, transferType, asset, amount, fromUserId, toUserId,
           fromAccountType, toAccountType, status, clientRequestId, remark, createdAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           transferType = excluded.transferType,
           asset = excluded.asset,
           amount = excluded.amount,
           fromUserId = excluded.fromUserId,
           toUserId = excluded.toUserId,
           fromAccountType = excluded.fromAccountType,
           toAccountType = excluded.toAccountType,
           status = excluded.status,
           clientRequestId = excluded.clientRequestId,
           remark = excluded.remark,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        record.id,
        record.transferType,
        record.asset,
        record.amount,
        record.fromUserId,
        record.toUserId,
        record.fromAccountType,
        record.toAccountType,
        record.status,
        record.clientRequestId ?? null,
        record.remark ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  listWithdrawalRequests(userId?: string) {
    const sql = userId
      ? "SELECT id, userId, asset, amount, status, network, txHash, onchainStatus, chainId, tokenAddress, fromAddress, toAddress, broadcastTxHash, broadcastedAt, confirmedAt, failedAt, failedReason, confirmations, broadcastAttemptCount, lastBroadcastAttemptAt, remark, reviewNote, createdAt, reviewedAt, updatedAt FROM withdrawal_requests WHERE userId = ? ORDER BY createdAt DESC"
      : "SELECT id, userId, asset, amount, status, network, txHash, onchainStatus, chainId, tokenAddress, fromAddress, toAddress, broadcastTxHash, broadcastedAt, confirmedAt, failedAt, failedReason, confirmations, broadcastAttemptCount, lastBroadcastAttemptAt, remark, reviewNote, createdAt, reviewedAt, updatedAt FROM withdrawal_requests ORDER BY createdAt DESC";
    return (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as WithdrawalRequestRow[];
  }

  listWithdrawalsByStatuses(statuses: WithdrawalRequest["status"][]) {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT id, userId, asset, amount, status, network, txHash, onchainStatus, chainId, tokenAddress, fromAddress, toAddress, broadcastTxHash, broadcastedAt, confirmedAt, failedAt, failedReason, confirmations, broadcastAttemptCount, lastBroadcastAttemptAt, remark, reviewNote, createdAt, reviewedAt, updatedAt FROM withdrawal_requests WHERE status IN (${placeholders}) ORDER BY createdAt ASC`)
      .all(...statuses) as WithdrawalRequestRow[];
  }

  getWithdrawalRequest(id: string) {
    return this.db
      .prepare("SELECT id, userId, asset, amount, status, network, txHash, onchainStatus, chainId, tokenAddress, fromAddress, toAddress, broadcastTxHash, broadcastedAt, confirmedAt, failedAt, failedReason, confirmations, broadcastAttemptCount, lastBroadcastAttemptAt, remark, reviewNote, createdAt, reviewedAt, updatedAt FROM withdrawal_requests WHERE id = ?")
      .get(id) as WithdrawalRequestRow | undefined;
  }

  saveWithdrawalRequest(request: WithdrawalRequest) {
    this.db
      .prepare(
        `INSERT INTO withdrawal_requests (
           id, userId, asset, amount, status, network, txHash,
           onchainStatus, chainId, tokenAddress, fromAddress, toAddress, broadcastTxHash,
           broadcastedAt, confirmedAt, failedAt, failedReason, confirmations,
           broadcastAttemptCount, lastBroadcastAttemptAt, remark, reviewNote, createdAt, reviewedAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
           asset = excluded.asset,
           amount = excluded.amount,
           status = excluded.status,
           network = excluded.network,
           txHash = excluded.txHash,
           onchainStatus = excluded.onchainStatus,
           chainId = excluded.chainId,
           tokenAddress = excluded.tokenAddress,
           fromAddress = excluded.fromAddress,
           toAddress = excluded.toAddress,
           broadcastTxHash = excluded.broadcastTxHash,
           broadcastedAt = excluded.broadcastedAt,
           confirmedAt = excluded.confirmedAt,
           failedAt = excluded.failedAt,
           failedReason = excluded.failedReason,
           confirmations = excluded.confirmations,
           broadcastAttemptCount = excluded.broadcastAttemptCount,
           lastBroadcastAttemptAt = excluded.lastBroadcastAttemptAt,
           remark = excluded.remark,
           reviewNote = excluded.reviewNote,
           createdAt = excluded.createdAt,
           reviewedAt = excluded.reviewedAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        request.id,
        request.userId,
        request.asset,
        request.amount,
        request.status,
        request.network ?? null,
        request.txHash ?? null,
        request.onchainStatus ?? request.status,
        request.chainId ?? null,
        request.tokenAddress ?? null,
        request.fromAddress ?? null,
        request.toAddress ?? null,
        request.broadcastTxHash ?? null,
        request.broadcastedAt ?? null,
        request.confirmedAt ?? null,
        request.failedAt ?? null,
        request.failedReason ?? null,
        request.confirmations ?? null,
        request.broadcastAttemptCount ?? 0,
        request.lastBroadcastAttemptAt ?? null,
        request.remark ?? null,
        request.reviewNote ?? null,
        request.createdAt,
        request.reviewedAt ?? null,
        request.updatedAt,
      );
  }

  saveRealTradingAudit(record: RealTradingAuditRecord) {
    this.maintainRealTradingAudit(record.completedAt);
    this.db
      .prepare(
        `INSERT INTO real_trading_exchange_audit (
           requestId, userId, network, masterAddress, actionType, clientOrderIds, outcome, errorCategory,
           providerStatus, httpStatus, message, submittedAt, completedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.requestId,
        record.userId,
        record.network,
        record.masterAddress,
        record.actionType,
        JSON.stringify(record.clientOrderIds),
        record.outcome,
        record.errorCategory,
        record.providerStatus,
        record.httpStatus,
        record.message,
        record.submittedAt,
        record.completedAt,
      );
  }

  listRealTradingAudit(userId?: string) {
    if (userId) {
      const rows = this.db
        .prepare("SELECT * FROM real_trading_exchange_audit WHERE userId = ? ORDER BY submittedAt DESC")
        .all(userId) as RealTradingAuditRow[];
      return rows.map(toRealTradingAuditRecord);
    }
    const rows = this.db
      .prepare("SELECT * FROM real_trading_exchange_audit ORDER BY submittedAt DESC")
      .all() as RealTradingAuditRow[];
    return rows.map(toRealTradingAuditRecord);
  }

  findRealTradingAudit(userId: string, input: { requestId?: string | null; cloid?: string | null }) {
    if (input.requestId) {
      const row = this.db.prepare(
        "SELECT * FROM real_trading_exchange_audit WHERE userId = ? AND requestId = ?",
      ).get(userId, input.requestId) as RealTradingAuditRow | undefined;
      return row ? toRealTradingAuditRecord(row) : undefined;
    }
    if (input.cloid) {
      const row = this.db.prepare(
        `SELECT audit.* FROM real_trading_exchange_audit audit
         JOIN real_trading_order_idempotency idem ON idem.requestId = audit.requestId
         WHERE audit.userId = ? AND idem.cloid = ?`,
      ).get(userId, input.cloid.toLowerCase()) as RealTradingAuditRow | undefined;
      return row ? toRealTradingAuditRecord(row) : undefined;
    }
    return undefined;
  }

  listUserRealTradingReconciliationRecords(userId: string) {
    const rows = this.db.prepare(
      `SELECT
         audit.requestId,
         audit.actionType,
         audit.clientOrderIds,
         audit.errorCategory,
         audit.submittedAt,
         audit.completedAt,
         COUNT(idem.cloid) AS idempotencyRowCount,
         MAX(idem.lastReconcileAttemptAt) AS lastReconcileAttemptAt,
         MAX(idem.reconcileAttemptCount) AS reconcileAttemptCount
       FROM real_trading_exchange_audit audit
       LEFT JOIN real_trading_order_idempotency idem ON idem.requestId = audit.requestId
       WHERE audit.userId = ? AND audit.outcome = 'pending_reconciliation'
       GROUP BY audit.requestId
       ORDER BY audit.submittedAt ASC`,
    ).all(userId) as Array<RealTradingAuditRow & {
      idempotencyRowCount?: number | null;
      lastReconcileAttemptAt?: number | null;
      reconcileAttemptCount?: number | null;
    }>;
    return rows.map((row) => {
      const record = toRealTradingAuditRecord(row);
      const autoRecoverable = record.actionType === "order" && Number(row.idempotencyRowCount ?? 0) > 0;
      return {
        requestId: record.requestId,
        actionType: record.actionType,
        submittedAt: record.submittedAt,
        clientOrderIds: record.clientOrderIds,
        autoRecoverable,
        manualReview: !autoRecoverable,
        lastReconcileAttemptAt: row.lastReconcileAttemptAt ?? null,
        errorCategory: record.errorCategory,
        blockingScope: autoRecoverable ? "new_risk" : "manual_review",
      };
    });
  }

  listPendingRealTradingReconciliations(limit = 50) {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    const requestRows = this.db.prepare(
      `SELECT requestId
       FROM real_trading_order_idempotency
       WHERE state IN ('processing', 'pending_reconciliation')
       GROUP BY requestId
       ORDER BY MIN(submittedAt) ASC
       LIMIT ?`,
    ).all(safeLimit) as Array<{ requestId: string }>;
    if (requestRows.length === 0) return [];
    const placeholders = requestRows.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT
         idem.userId,
         idem.masterAddress,
         idem.network,
         idem.cloid,
         idem.requestId,
         idem.actionType,
         idem.state,
         idem.submittedAt,
         idem.completedAt,
         idem.receiptJson,
         idem.requestFingerprint,
         idem.reconcileAttemptCount,
         idem.lastReconcileAttemptAt,
         idem.lastReconcileError,
         audit.outcome AS auditOutcome,
         audit.errorCategory AS auditErrorCategory,
         audit.completedAt AS auditCompletedAt
       FROM real_trading_order_idempotency idem
       LEFT JOIN real_trading_exchange_audit audit ON audit.requestId = idem.requestId
       WHERE idem.requestId IN (${placeholders}) AND idem.state IN ('processing', 'pending_reconciliation')
       ORDER BY idem.submittedAt ASC, idem.cloid ASC`,
    ).all(...requestRows.map((row) => row.requestId)) as Array<RealTradingIdempotencyRow & {
      auditOutcome?: string | null;
      auditErrorCategory?: string | null;
      auditCompletedAt?: number | null;
    }>;
    return rows.map((row) => ({
      userId: String(row.userId ?? ""),
      masterAddress: String(row.masterAddress ?? ""),
      network: String(row.network ?? ""),
      cloid: String(row.cloid ?? ""),
      requestId: row.requestId,
      actionType: String(row.actionType ?? ""),
      state: row.state,
      submittedAt: row.submittedAt,
      completedAt: row.completedAt ?? null,
      reconcileAttemptCount: row.reconcileAttemptCount ?? 0,
      lastReconcileAttemptAt: row.lastReconcileAttemptAt ?? null,
      lastReconcileError: row.lastReconcileError ?? null,
      auditOutcome: row.auditOutcome ?? null,
      auditErrorCategory: row.auditErrorCategory ?? null,
      auditCompletedAt: row.auditCompletedAt ?? null,
    }));
  }

  recordRealTradingReconciliationAttempt(requestId: string, attemptedAt: number, error: string | null) {
    this.db.prepare(
      `UPDATE real_trading_order_idempotency
       SET reconcileAttemptCount = COALESCE(reconcileAttemptCount, 0) + 1,
           lastReconcileAttemptAt = ?,
           lastReconcileError = ?
       WHERE requestId = ?`,
    ).run(attemptedAt, error, requestId);
  }

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
  ) {
    this.db.prepare(
      `UPDATE real_trading_exchange_audit
       SET outcome = ?,
           errorCategory = ?,
           providerStatus = ?,
           httpStatus = ?,
           message = ?,
           completedAt = ?
       WHERE requestId = ?`,
    ).run(
      outcome,
      input.errorCategory,
      input.providerStatus,
      input.httpStatus,
      input.message,
      input.completedAt,
      requestId,
    );
  }

  getRealTradingOperationsSummary(now = Date.now(), windowMs = 24 * 60 * 60 * 1_000) {
    const auditPending = this.db.prepare(
      `SELECT MIN(submittedAt) AS oldestSubmittedAt, COUNT(*) AS pendingCount
       FROM real_trading_exchange_audit
       WHERE outcome = 'pending_reconciliation'`,
    ).get() as { oldestSubmittedAt?: number | null; pendingCount?: number | null };
    const autoRecoverable = this.db.prepare(
      `SELECT COUNT(DISTINCT audit.requestId) AS count
       FROM real_trading_exchange_audit audit
       JOIN real_trading_order_idempotency idem ON idem.requestId = audit.requestId
       WHERE audit.outcome = 'pending_reconciliation'
         AND audit.actionType = 'order'
         AND idem.state IN ('processing', 'pending_reconciliation')`,
    ).get() as { count?: number | null };
    const idempotencyPending = this.db.prepare(
      `SELECT MIN(submittedAt) AS oldestSubmittedAt, COUNT(DISTINCT requestId) AS pendingCount
       FROM real_trading_order_idempotency
       WHERE state IN ('processing', 'pending_reconciliation')`,
    ).get() as { oldestSubmittedAt?: number | null; pendingCount?: number | null };
    const pendingCount = Number(auditPending.pendingCount ?? 0);
    const autoRecoverableCount = Number(autoRecoverable.count ?? 0);
    const oldestSubmittedAt = minNullableNumber(auditPending.oldestSubmittedAt, idempotencyPending.oldestSubmittedAt);
    const safeWindowMs = Math.max(60_000, Number.isFinite(windowMs) ? windowMs : 24 * 60 * 60 * 1_000);
    const rows = this.db.prepare(
      `SELECT actionType, outcome, COUNT(*) AS count
       FROM real_trading_exchange_audit
       WHERE completedAt >= ?
       GROUP BY actionType, outcome
       ORDER BY actionType, outcome`,
    ).all(now - safeWindowMs) as Array<{ actionType: string; outcome: RealTradingAuditOutcome; count: number }>;
    return {
      pendingCount,
      autoRecoverablePendingCount: autoRecoverableCount,
      manualReviewPendingCount: Math.max(0, pendingCount - autoRecoverableCount),
      idempotencyPendingWithoutAuditCount: Math.max(0, Number(idempotencyPending.pendingCount ?? 0) - autoRecoverableCount),
      oldestPendingSubmittedAt: oldestSubmittedAt,
      oldestPendingAgeMs: oldestSubmittedAt !== null ? Math.max(0, now - oldestSubmittedAt) : null,
      recentWindowMs: safeWindowMs,
      recentCounts: rows.map((row) => ({
        actionType: row.actionType,
        outcome: row.outcome,
        count: Number(row.count),
      })),
      auditCleanup: this.getRealTradingAuditMaintenanceStatus(),
    };
  }

  findRealTradingAgentBinding(userId: string, masterAddress: string) {
    return this.db.prepare(
      `SELECT userId, masterAddress, agentAddress, approvedAt, updatedAt
       FROM real_trading_agent_bindings
       WHERE userId = ? AND masterAddress = ?`,
    ).get(userId, masterAddress.toLowerCase()) as RealTradingAgentBindingRow | undefined;
  }

  upsertRealTradingAgentBinding(binding: RealTradingAgentBinding) {
    this.db.prepare(
      `INSERT INTO real_trading_agent_bindings (
         userId, masterAddress, agentAddress, approvedAt, updatedAt
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(userId, masterAddress) DO UPDATE SET
         agentAddress = excluded.agentAddress,
         approvedAt = excluded.approvedAt,
         updatedAt = excluded.updatedAt`,
    ).run(
      binding.userId,
      binding.masterAddress.toLowerCase(),
      binding.agentAddress.toLowerCase(),
      binding.approvedAt,
      binding.updatedAt,
    );
  }

  reserveRealTradingOrderRequest(reservation: RealTradingIdempotencyReservation): RealTradingIdempotencyResult {
    return this.transaction(() => {
      const existing = reservation.clientOrderIds.map((cloid) => this.db.prepare(
        `SELECT requestId, state, submittedAt, receiptJson, requestFingerprint FROM real_trading_order_idempotency
         WHERE userId = ? AND masterAddress = ? AND network = ? AND cloid = ?`,
      ).get(reservation.userId, reservation.masterAddress, reservation.network, cloid) as RealTradingIdempotencyRow | undefined);
      const present = existing.filter((row): row is RealTradingIdempotencyRow => Boolean(row));
      if (present.length > 0) {
        const first = present[0];
        const exactExistingRequest = present.length === reservation.clientOrderIds.length
          && present.every((row) => row.requestId === first.requestId && row.requestFingerprint === reservation.requestFingerprint);
        return {
          kind: "existing",
          requestId: exactExistingRequest ? first.requestId : "conflict",
          state: exactExistingRequest ? first.state : "processing",
          submittedAt: exactExistingRequest ? first.submittedAt : reservation.submittedAt,
          receiptJson: exactExistingRequest ? first.receiptJson : null,
        };
      }
      const insert = this.db.prepare(
        `INSERT INTO real_trading_order_idempotency (
           userId, masterAddress, network, cloid, requestId, actionType, requestFingerprint, state, receiptJson, submittedAt, completedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', NULL, ?, NULL)`,
      );
      reservation.clientOrderIds.forEach((cloid) => insert.run(
        reservation.userId,
        reservation.masterAddress,
        reservation.network,
        cloid,
        reservation.requestId,
        reservation.actionType,
        reservation.requestFingerprint,
        reservation.submittedAt,
      ));
      return { kind: "reserved" };
    });
  }

  completeRealTradingOrderRequest(
    requestId: string,
    state: Exclude<RealTradingIdempotencyState, "processing">,
    receiptJson: string,
    completedAt: number,
  ) {
    this.db.prepare(
      `UPDATE real_trading_order_idempotency
       SET state = ?, receiptJson = ?, completedAt = ?
       WHERE requestId = ?`,
    ).run(state, receiptJson, completedAt, requestId);
  }

  releaseRealTradingOrderRequest(requestId: string) {
    this.db.prepare(
      "DELETE FROM real_trading_order_idempotency WHERE requestId = ? AND state = 'processing'",
    ).run(requestId);
  }

  purgeExpiredRealTradingAudit(now = Date.now()) {
    const retentionDays = parsePositiveEnvironmentNumber(process.env.REAL_TRADING_AUDIT_RETENTION_DAYS, 180);
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
    const batchSize = 1_000;
    const changes = this.db.prepare(
      `DELETE FROM real_trading_exchange_audit
       WHERE rowid IN (
         SELECT rowid FROM real_trading_exchange_audit WHERE completedAt < ? ORDER BY completedAt ASC LIMIT ?
       )`,
    ).run(cutoff, batchSize).changes;
    const idempotencyChanges = this.db.prepare(
      `DELETE FROM real_trading_order_idempotency
       WHERE rowid IN (
         SELECT rowid FROM real_trading_order_idempotency
         WHERE completedAt IS NOT NULL AND completedAt < ? ORDER BY completedAt ASC LIMIT ?
       )`,
    ).run(cutoff, batchSize).changes;
    this.lastRealTradingAuditPurgeDeleted = Number(changes) + Number(idempotencyChanges);
    return changes;
  }

  getRealTradingAuditMaintenanceStatus() {
    const retentionDays = parsePositiveEnvironmentNumber(process.env.REAL_TRADING_AUDIT_RETENTION_DAYS, 180);
    return {
      retentionDays,
      lastMaintenanceAt: this.lastRealTradingAuditMaintenanceAt || null,
      lastDeletedRows: this.lastRealTradingAuditPurgeDeleted,
    };
  }

  private maintainRealTradingAudit(now = Date.now()) {
    if (now - this.lastRealTradingAuditMaintenanceAt < 6 * 60 * 60 * 1_000) return;
    this.purgeExpiredRealTradingAudit(now);
    this.lastRealTradingAuditMaintenanceAt = now;
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT NOT NULL,
        userId TEXT PRIMARY KEY,
        currency TEXT NOT NULL,
        balance REAL NOT NULL,
        equity REAL NOT NULL,
        usedMargin REAL NOT NULL,
        freeMargin REAL NOT NULL,
        floatingPnl REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS simulation_accounts (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        currency TEXT NOT NULL,
        balance REAL NOT NULL,
        equity REAL NOT NULL,
        usedMargin REAL NOT NULL,
        freeMargin REAL NOT NULL,
        floatingPnl REAL NOT NULL,
        status TEXT NOT NULL,
        lastResetAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        emailVerifiedAt TEXT,
        stepUpEnrollmentInvalidatedAt INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS email_tokens (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        userId TEXT,
        codeHash TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        usedAt INTEGER,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        tokenHash TEXT PRIMARY KEY,
        subjectId TEXT NOT NULL,
        role TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS revoked_auth_sessions (
        tokenHash TEXT PRIMARY KEY,
        subjectId TEXT NOT NULL,
        role TEXT NOT NULL,
        reason TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        accountId TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        volume REAL NOT NULL,
        entryPrice REAL NOT NULL,
        margin REAL NOT NULL,
        openedAt INTEGER NOT NULL,
        source TEXT NOT NULL,
        quoteTime INTEGER NOT NULL,
        entryBid REAL NOT NULL,
        entryAsk REAL NOT NULL,
        entrySpread REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        accountId TEXT NOT NULL,
        positionId TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        positionSide TEXT NOT NULL,
        orderType TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        volume REAL NOT NULL,
        price REAL,
        bid REAL,
        ask REAL,
        spread REAL,
        source TEXT NOT NULL,
        quoteTime INTEGER,
        simulated INTEGER NOT NULL,
        reason TEXT,
        pnl REAL,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS balance_adjustments (
        id TEXT PRIMARY KEY,
        accountId TEXT NOT NULL,
        userId TEXT NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        previousBalance REAL NOT NULL,
        nextBalance REAL NOT NULL,
        note TEXT,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_positions_userId ON positions(userId);
      CREATE INDEX IF NOT EXISTS idx_orders_userId ON orders(userId);
      CREATE INDEX IF NOT EXISTS idx_orders_accountId ON orders(accountId);
      CREATE INDEX IF NOT EXISTS idx_adjustments_userId ON balance_adjustments(userId);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_email_tokens_email_purpose ON email_tokens(email, purpose, createdAt);
      CREATE INDEX IF NOT EXISTS idx_email_tokens_tokenHash ON email_tokens(tokenHash);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_subject ON auth_sessions(subjectId, role);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiresAt ON auth_sessions(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_revoked_auth_sessions_expiresAt ON revoked_auth_sessions(expiresAt);

      CREATE TABLE IF NOT EXISTS market_symbols (
        symbol TEXT PRIMARY KEY,
        displayName TEXT NOT NULL,
        apiSymbol TEXT NOT NULL,
        providerMarketId TEXT NOT NULL DEFAULT '',
        providerCoin TEXT NOT NULL DEFAULT '',
        sourceDex TEXT NOT NULL DEFAULT 'main',
        sourceType TEXT NOT NULL DEFAULT 'main',
        category TEXT NOT NULL,
        digits INTEGER NOT NULL,
        spread REAL NOT NULL,
        leverage REAL NOT NULL,
        contractSize REAL NOT NULL,
        minLot REAL NOT NULL,
        maxLot REAL NOT NULL,
        lotStep REAL NOT NULL,
        tradeStatus TEXT NOT NULL,
        isVisible INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS funding_accounts (
        id TEXT NOT NULL,
        userId TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        balance REAL NOT NULL,
        frozen REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS real_trading_accounts (
        id TEXT NOT NULL,
        userId TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        balance REAL NOT NULL,
        frozen REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS funding_ledger (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        accountId TEXT NOT NULL,
        accountType TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount REAL NOT NULL,
        balanceBefore REAL NOT NULL,
        balanceAfter REAL NOT NULL,
        frozenBefore REAL NOT NULL,
        frozenAfter REAL NOT NULL,
        status TEXT NOT NULL,
        relatedId TEXT,
        network TEXT,
        address TEXT,
        txHash TEXT,
        remark TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_transfer_records (
        id TEXT PRIMARY KEY,
        transferType TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount REAL NOT NULL,
        fromUserId TEXT NOT NULL,
        toUserId TEXT NOT NULL,
        fromAccountType TEXT NOT NULL,
        toAccountType TEXT NOT NULL,
        status TEXT NOT NULL,
        clientRequestId TEXT,
        remark TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(fromUserId, clientRequestId)
      );

      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        network TEXT,
        txHash TEXT,
        onchainStatus TEXT,
        chainId INTEGER,
        tokenAddress TEXT,
        fromAddress TEXT,
        toAddress TEXT,
        broadcastTxHash TEXT,
        broadcastedAt INTEGER,
        confirmedAt INTEGER,
        failedAt INTEGER,
        failedReason TEXT,
        confirmations INTEGER,
        broadcastAttemptCount INTEGER DEFAULT 0,
        lastBroadcastAttemptAt INTEGER,
        remark TEXT,
        reviewNote TEXT,
        createdAt INTEGER NOT NULL,
        reviewedAt INTEGER,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_addresses (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL UNIQUE,
        network TEXT NOT NULL,
        address TEXT NOT NULL UNIQUE,
        derivationIndex INTEGER NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_wallet_bindings (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL UNIQUE,
        walletAddress TEXT NOT NULL UNIQUE,
        network TEXT NOT NULL,
        provider TEXT NOT NULL,
        isDefault INTEGER NOT NULL,
        bindStatus TEXT NOT NULL,
        nonce TEXT NOT NULL,
        challenge TEXT NOT NULL,
        challengeExpiresAt INTEGER NOT NULL,
        lastVerifiedAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS onchain_deposits (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        asset TEXT NOT NULL,
        network TEXT NOT NULL,
        chainId INTEGER NOT NULL,
        tokenAddress TEXT NOT NULL,
        fromAddress TEXT NOT NULL,
        toAddress TEXT NOT NULL,
        amount TEXT NOT NULL,
        amountDecimal REAL NOT NULL,
        txHash TEXT NOT NULL,
        logIndex INTEGER NOT NULL,
        blockNumber INTEGER NOT NULL,
        blockHash TEXT,
        confirmations INTEGER NOT NULL,
        status TEXT NOT NULL,
        creditedLedgerId TEXT,
        failedReason TEXT,
        detectedAt INTEGER NOT NULL,
        confirmedAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(network, txHash, logIndex)
      );

      CREATE TABLE IF NOT EXISTS chain_scan_cursors (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        chainId INTEGER NOT NULL,
        tokenAddress TEXT NOT NULL,
        lastScannedBlock INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(network, tokenAddress)
      );

      CREATE TABLE IF NOT EXISTS real_trading_exchange_audit (
        requestId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        network TEXT NOT NULL,
        masterAddress TEXT,
        actionType TEXT NOT NULL,
        clientOrderIds TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL,
        errorCategory TEXT,
        providerStatus TEXT,
        httpStatus INTEGER NOT NULL,
        message TEXT,
        submittedAt INTEGER NOT NULL,
        completedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS real_trading_order_idempotency (
        userId TEXT NOT NULL,
        masterAddress TEXT NOT NULL,
        network TEXT NOT NULL,
        cloid TEXT NOT NULL,
        requestId TEXT NOT NULL,
        actionType TEXT NOT NULL,
        requestFingerprint TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        receiptJson TEXT,
        submittedAt INTEGER NOT NULL,
        completedAt INTEGER,
        reconcileAttemptCount INTEGER NOT NULL DEFAULT 0,
        lastReconcileAttemptAt INTEGER,
        lastReconcileError TEXT,
        PRIMARY KEY (userId, masterAddress, network, cloid)
      );

      CREATE TABLE IF NOT EXISTS real_trading_agent_bindings (
        userId TEXT NOT NULL,
        masterAddress TEXT NOT NULL,
        agentAddress TEXT NOT NULL,
        approvedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, masterAddress)
      );

      CREATE TABLE IF NOT EXISTS binance_credential_bindings (
        userId TEXT NOT NULL,
        venue TEXT NOT NULL CHECK(venue = 'binance'),
        uidSnapshot TEXT NOT NULL
          CHECK(length(uidSnapshot) = 64 AND uidSnapshot = lower(uidSnapshot)),
        credentialNote TEXT NOT NULL DEFAULT '',
        bindingVersion INTEGER NOT NULL CHECK(bindingVersion > 0),
        status TEXT NOT NULL CHECK(status IN ('active', 'verified_unbound', 'unverified_unbound')),
        interventionStatus TEXT NOT NULL CHECK(interventionStatus IN ('none', 'manual_intervention')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, venue)
      );

      CREATE TABLE IF NOT EXISTS binance_binding_operations (
        operationId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        venue TEXT NOT NULL CHECK(venue = 'binance'),
        requestDigest TEXT NOT NULL,
        resultJson TEXT,
        createdAt INTEGER NOT NULL,
        completedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS binance_recovery_receipts (
        receiptId TEXT PRIMARY KEY,
        operationId TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        venue TEXT NOT NULL CHECK(venue = 'binance'),
        uidSnapshot TEXT NOT NULL,
        bindingVersion INTEGER NOT NULL,
        operator TEXT NOT NULL,
        approver TEXT NOT NULL,
        reason TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('verified_unbound', 'unverified_unbound')),
        timestamp INTEGER NOT NULL,
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        FOREIGN KEY(operationId) REFERENCES binance_binding_operations(operationId)
      );

      CREATE TRIGGER IF NOT EXISTS binance_recovery_receipts_no_update
      BEFORE UPDATE ON binance_recovery_receipts
      BEGIN SELECT RAISE(ABORT, 'binance recovery receipts are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS binance_recovery_receipts_no_delete
      BEFORE DELETE ON binance_recovery_receipts
      BEGIN SELECT RAISE(ABORT, 'binance recovery receipts are append-only'); END;

      CREATE TABLE IF NOT EXISTS binance_binding_audit_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        receiptId TEXT NOT NULL UNIQUE,
        operationId TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        venue TEXT NOT NULL CHECK(venue = 'binance'),
        uidSnapshot TEXT NOT NULL,
        bindingVersion INTEGER NOT NULL,
        operator TEXT NOT NULL,
        reason TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('bound', 'uid_changed', 'credential_note_updated', 'verified_unbound')),
        timestamp INTEGER NOT NULL,
        digest TEXT NOT NULL CHECK(length(digest) = 64)
      );

      CREATE TRIGGER IF NOT EXISTS binance_binding_audit_receipts_no_update
      BEFORE UPDATE ON binance_binding_audit_receipts
      BEGIN SELECT RAISE(ABORT, 'binance binding audit receipts are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS binance_binding_audit_receipts_no_delete
      BEFORE DELETE ON binance_binding_audit_receipts
      BEGIN SELECT RAISE(ABORT, 'binance binding audit receipts are append-only'); END;

      CREATE INDEX IF NOT EXISTS idx_funding_ledger_userId ON funding_ledger(userId);
      CREATE INDEX IF NOT EXISTS idx_funding_ledger_relatedId ON funding_ledger(relatedId);
      CREATE INDEX IF NOT EXISTS idx_real_trading_accounts_userId ON real_trading_accounts(userId);
      CREATE INDEX IF NOT EXISTS idx_simulation_accounts_userId ON simulation_accounts(userId);
      CREATE INDEX IF NOT EXISTS idx_simulation_accounts_status ON simulation_accounts(status);
      CREATE INDEX IF NOT EXISTS idx_account_transfer_records_fromUserId ON account_transfer_records(fromUserId);
      CREATE INDEX IF NOT EXISTS idx_account_transfer_records_toUserId ON account_transfer_records(toUserId);
      CREATE INDEX IF NOT EXISTS idx_account_transfer_records_createdAt ON account_transfer_records(createdAt);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_userId ON withdrawal_requests(userId);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
      CREATE INDEX IF NOT EXISTS idx_wallet_addresses_address ON wallet_addresses(address);
      CREATE INDEX IF NOT EXISTS idx_external_wallet_bindings_userId ON external_wallet_bindings(userId);
      CREATE INDEX IF NOT EXISTS idx_external_wallet_bindings_walletAddress ON external_wallet_bindings(walletAddress);
      CREATE INDEX IF NOT EXISTS idx_external_wallet_bindings_status ON external_wallet_bindings(bindStatus);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_userId ON onchain_deposits(userId);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_status ON onchain_deposits(status);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_toAddress ON onchain_deposits(toAddress);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_blockNumber ON onchain_deposits(blockNumber);
      CREATE INDEX IF NOT EXISTS idx_real_trading_audit_userId ON real_trading_exchange_audit(userId, submittedAt);
      CREATE INDEX IF NOT EXISTS idx_real_trading_audit_completedAt ON real_trading_exchange_audit(completedAt);
      CREATE INDEX IF NOT EXISTS idx_real_trading_order_idempotency_requestId ON real_trading_order_idempotency(requestId);
      CREATE INDEX IF NOT EXISTS idx_real_trading_agent_bindings_agent ON real_trading_agent_bindings(agentAddress);
      CREATE INDEX IF NOT EXISTS idx_binance_credential_bindings_status
        ON binance_credential_bindings(status);
    `);
    this.addColumnIfMissing("withdrawal_requests", "onchainStatus", "TEXT");
    this.addColumnIfMissing("withdrawal_requests", "chainId", "INTEGER");
    this.addColumnIfMissing("withdrawal_requests", "tokenAddress", "TEXT");
    this.addColumnIfMissing("withdrawal_requests", "fromAddress", "TEXT");
    this.addColumnIfMissing("withdrawal_requests", "toAddress", "TEXT");
    this.addColumnIfMissing("withdrawal_requests", "broadcastTxHash", "TEXT");
    this.addColumnIfMissing("withdrawal_requests", "broadcastedAt", "INTEGER");
    this.addColumnIfMissing("withdrawal_requests", "confirmedAt", "INTEGER");
    this.addColumnIfMissing("withdrawal_requests", "failedAt", "INTEGER");
    this.addColumnIfMissing("withdrawal_requests", "failedReason", "TEXT");
    this.addColumnIfMissing("withdrawal_requests", "confirmations", "INTEGER");
    this.addColumnIfMissing("withdrawal_requests", "broadcastAttemptCount", "INTEGER DEFAULT 0");
    this.addColumnIfMissing("withdrawal_requests", "lastBroadcastAttemptAt", "INTEGER");
    this.addColumnIfMissing("funding_ledger", "address", "TEXT");
    this.addColumnIfMissing("positions", "accountId", "TEXT");
    this.addColumnIfMissing("users", "emailVerifiedAt", "TEXT");
    this.addColumnIfMissing("users", "stepUpEnrollmentInvalidatedAt", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("market_symbols", "providerMarketId", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("market_symbols", "providerCoin", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("market_symbols", "sourceDex", "TEXT NOT NULL DEFAULT 'main'");
    this.addColumnIfMissing("market_symbols", "sourceType", "TEXT NOT NULL DEFAULT 'main'");
    this.addColumnIfMissing("real_trading_exchange_audit", "clientOrderIds", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("real_trading_exchange_audit", "errorCategory", "TEXT");
    this.addColumnIfMissing("real_trading_order_idempotency", "requestFingerprint", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("real_trading_order_idempotency", "reconcileAttemptCount", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("real_trading_order_idempotency", "lastReconcileAttemptAt", "INTEGER");
    this.addColumnIfMissing("real_trading_order_idempotency", "lastReconcileError", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_positions_accountId ON positions(accountId);");
    this.cleanupLegacyTradingData();
    this.db.prepare("UPDATE users SET emailVerifiedAt = createdAt WHERE emailVerifiedAt IS NULL").run();
    this.db.prepare("UPDATE withdrawal_requests SET status = 'pending_review' WHERE status = 'pending'").run();
    this.db.prepare("UPDATE withdrawal_requests SET status = 'confirmed', onchainStatus = 'confirmed' WHERE status = 'approved'").run();
    this.db.prepare("UPDATE withdrawal_requests SET onchainStatus = status WHERE onchainStatus IS NULL").run();
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    if (this.columnExists(table, column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  private columnExists(table: string, column: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((item) => item.name === column);
  }
}

function assertBinanceBindingIdentity(userId: string, uidSnapshot: string) {
  if (!userId.trim()) throw new Error("Binance binding userId is required");
  if (!/^[0-9a-f]{64}$/u.test(uidSnapshot)) {
    throw new Error("Binance UID snapshot must be a full lowercase SHA-256 digest");
  }
}

function normalizeCredentialNote(value: string) {
  const note = value.trim();
  if (note.length > 100) throw new Error("credentialNote must not exceed 100 characters");
  return note;
}

function assertOperationId(operationId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw new Error("Recovery Unbind operationId must be a UUID");
  }
}

function toFundingAccount(row: FundingAccountRow): FundingAccount {
  return {
    ...row,
    asset: "USDT",
    available: roundMoney(row.balance - row.frozen),
  };
}

function toMarketSymbol(row: MarketSymbolRow): MarketSymbol {
  const providerMarketId = row.providerMarketId || row.apiSymbol;
  const providerCoin = row.providerCoin || providerMarketId.split(":").at(-1)!;
  const sourceDex = row.sourceDex || (providerMarketId.includes(":") ? providerMarketId.split(":")[0] : "main");
  return {
    ...row,
    providerMarketId,
    providerCoin,
    sourceDex,
    sourceType: row.sourceType === "hip3" ? "hip3" : "main",
    category: normalizeMarketCategory(row.category),
    isVisible: Boolean(row.isVisible),
  };
}

function toEmailToken(row: EmailTokenRow): EmailTokenRecord {
  return {
    ...row,
    userId: row.userId ?? null,
    usedAt: row.usedAt ?? null,
  };
}

function toRealTradingAuditRecord(row: RealTradingAuditRow): RealTradingAuditRecord {
  let clientOrderIds: string[] = [];
  try {
    const parsed = JSON.parse(row.clientOrderIds);
    if (Array.isArray(parsed)) clientOrderIds = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // Legacy/malformed audit metadata is returned without client order ids.
  }
  return { ...row, clientOrderIds };
}

function normalizeMarketCategory(value: string): MarketSymbol["category"] {
  if (value === "crypto" || value === "metals" || value === "us_equities" || value === "indices" || value === "other") {
    return value;
  }
  if (value === "metal") return "metals";
  if (value === "stock") return "us_equities";
  if (value === "index") return "indices";
  return "other";
}

function toExternalWalletBinding(row: ExternalWalletBindingRow): ExternalWalletBinding {
  return {
    ...row,
    network: "BSC_TESTNET",
    provider: "metamask",
    bindStatus: row.bindStatus === "active" ? "active" : "pending",
    isDefault: Boolean(row.isDefault),
    lastVerifiedAt: row.lastVerifiedAt ?? null,
  };
}

function toSimulationAccount(row: SimulationAccountRow | SimulationAccount): SimulationAccount {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name?.trim() || "模拟账户",
    asset: row.asset ?? row.currency ?? "USDT",
    balance: row.balance,
    equity: row.equity,
    usedMargin: row.usedMargin,
    freeMargin: row.freeMargin,
    floatingPnl: row.floatingPnl,
    status: row.status === "disabled" || row.status === "deleted" ? row.status : "active",
    lastResetAt: row.lastResetAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTradingAccount(row: AccountRow | TradingAccount): TradingAccount {
  return {
    id: row.id?.trim() || `ACC-${row.userId}`,
    userId: row.userId,
    asset: row.asset ?? row.currency ?? "USDT",
    balance: row.balance,
    equity: row.equity,
    usedMargin: row.usedMargin,
    freeMargin: row.freeMargin,
    floatingPnl: row.floatingPnl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function parsePositiveEnvironmentNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minNullableNumber(...values: unknown[]) {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numbers.length ? Math.min(...numbers) : null;
}
