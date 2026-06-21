import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BalanceAdjustment, OrderRecord, Position, TradingAccount } from "../types";

const defaultDbPath = resolve(process.cwd(), "server/data/trading.sqlite");

type AccountRow = TradingAccount;
type PositionRow = Omit<Position, "source"> & { source: Position["source"] };
type OrderRow = Omit<OrderRecord, "simulated"> & { simulated: number };
type AdjustmentRow = BalanceAdjustment;

export class TradingStore {
  private db: DatabaseSync;

  constructor(dbPath = process.env.TRADING_DB_PATH ?? defaultDbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
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
    `);
  }
}
