import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BalanceAdjustment,
  FundingAccount,
  FundingLedgerEntry,
  OrderRecord,
  Position,
  TradingAccount,
  WithdrawalRequest,
} from "../types";

const defaultDbPath = resolve(process.cwd(), "server/data/trading.sqlite");

type AccountRow = TradingAccount;
type PositionRow = Omit<Position, "source"> & { source: Position["source"] };
type OrderRow = Omit<OrderRecord, "simulated"> & { simulated: number };
type AdjustmentRow = BalanceAdjustment;
type FundingAccountRow = Omit<FundingAccount, "available">;
type FundingLedgerRow = FundingLedgerEntry;
type WithdrawalRequestRow = WithdrawalRequest;

export class TradingStore {
  private db: DatabaseSync;

  constructor(dbPath = process.env.TRADING_DB_PATH ?? defaultDbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
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

  listAccounts() {
    return this.db.prepare("SELECT * FROM accounts ORDER BY createdAt DESC").all() as AccountRow[];
  }

  upsertAccount(account: TradingAccount) {
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
        account.id,
        account.userId,
        account.currency,
        account.balance,
        account.equity,
        account.usedMargin,
        account.freeMargin,
        account.floatingPnl,
        account.createdAt,
        account.updatedAt,
      );
  }

  listPositions() {
    return this.db.prepare("SELECT * FROM positions ORDER BY openedAt DESC").all() as PositionRow[] as Position[];
  }

  savePosition(position: Position) {
    this.db
      .prepare(
        `INSERT INTO positions (id, userId, symbol, side, volume, entryPrice, margin, openedAt, source, quoteTime, entryBid, entryAsk, entrySpread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
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
    const rows = this.db.prepare("SELECT * FROM orders ORDER BY createdAt DESC").all() as OrderRow[];
    return rows.map((row) => ({ ...row, simulated: Boolean(row.simulated) as true })) satisfies OrderRecord[];
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

  listFundingLedger(userId?: string) {
    const sql = userId
      ? "SELECT * FROM funding_ledger WHERE userId = ? ORDER BY createdAt DESC"
      : "SELECT * FROM funding_ledger ORDER BY createdAt DESC";
    return (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as FundingLedgerRow[];
  }

  saveFundingLedger(entry: FundingLedgerEntry) {
    this.db
      .prepare(
        `INSERT INTO funding_ledger (
           id, userId, accountId, accountType, type, source, asset, amount,
           balanceBefore, balanceAfter, frozenBefore, frozenAfter, status,
           relatedId, network, walletAddress, txHash, remark, createdAt, updatedAt
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
        entry.walletAddress ?? null,
        entry.txHash ?? null,
        entry.remark ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  listWithdrawalRequests(userId?: string) {
    const sql = userId
      ? "SELECT * FROM withdrawal_requests WHERE userId = ? ORDER BY createdAt DESC"
      : "SELECT * FROM withdrawal_requests ORDER BY createdAt DESC";
    return (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as WithdrawalRequestRow[];
  }

  getWithdrawalRequest(id: string) {
    return this.db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(id) as WithdrawalRequestRow | undefined;
  }

  saveWithdrawalRequest(request: WithdrawalRequest) {
    this.db
      .prepare(
        `INSERT INTO withdrawal_requests (
           id, userId, asset, amount, status, network, walletAddress, txHash,
           remark, reviewNote, createdAt, reviewedAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
           asset = excluded.asset,
           amount = excluded.amount,
           status = excluded.status,
           network = excluded.network,
           walletAddress = excluded.walletAddress,
           txHash = excluded.txHash,
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
        request.walletAddress ?? null,
        request.txHash ?? null,
        request.remark ?? null,
        request.reviewNote ?? null,
        request.createdAt,
        request.reviewedAt ?? null,
        request.updatedAt,
      );
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

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_adjustments_userId ON balance_adjustments(userId);

      CREATE TABLE IF NOT EXISTS funding_accounts (
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
        walletAddress TEXT,
        txHash TEXT,
        remark TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        network TEXT,
        walletAddress TEXT,
        txHash TEXT,
        remark TEXT,
        reviewNote TEXT,
        createdAt INTEGER NOT NULL,
        reviewedAt INTEGER,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_funding_ledger_userId ON funding_ledger(userId);
      CREATE INDEX IF NOT EXISTS idx_funding_ledger_relatedId ON funding_ledger(relatedId);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_userId ON withdrawal_requests(userId);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
    `);
  }
}

function toFundingAccount(row: FundingAccountRow): FundingAccount {
  return {
    ...row,
    asset: "USDT",
    available: roundMoney(row.balance - row.frozen),
  };
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}
