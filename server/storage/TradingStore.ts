import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BalanceAdjustment,
  ChainScanCursor,
  DepositAddress,
  FundingAccount,
  FundingLedgerEntry,
  MarketSymbol,
  OnchainDeposit,
  OrderRecord,
  Position,
  TradingAccount,
  User,
  WithdrawalRequest,
} from "../types";

const defaultDbPath = resolve(process.cwd(), "server/data/trading.sqlite");

type AccountRow = TradingAccount;
type PositionRow = Omit<Position, "source"> & { source: Position["source"] };
type OrderRow = Omit<OrderRecord, "simulated"> & { simulated: number };
type AdjustmentRow = BalanceAdjustment;
type FundingAccountRow = Omit<FundingAccount, "available">;
type DepositAddressRow = DepositAddress;
type OnchainDepositRow = OnchainDeposit;
type ChainScanCursorRow = ChainScanCursor;
type FundingLedgerRow = FundingLedgerEntry;
type WithdrawalRequestRow = WithdrawalRequest;
type UserRow = User & { password: string };
type MarketSymbolRow = Omit<MarketSymbol, "isVisible"> & { isVisible: number };

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

  listUsers() {
    return this.db.prepare("SELECT id, email, nickname, status, createdAt FROM users ORDER BY createdAt DESC").all() as User[];
  }

  findUserByEmail(email: string) {
    return this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  }

  findUserById(id: string) {
    return this.db.prepare("SELECT id, email, nickname, status, createdAt FROM users WHERE id = ?").get(id) as User | undefined;
  }

  createUser(user: UserRow) {
    this.db
      .prepare(
        `INSERT INTO users (id, email, password, nickname, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, user.email, user.password, user.nickname ?? null, user.status, user.createdAt);
  }

  updateUserStatus(id: string, status: User["status"]) {
    this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
  }

  getMarketSymbol(symbol: string) {
    const row = this.db.prepare("SELECT * FROM market_symbols WHERE symbol = ?").get(symbol) as MarketSymbolRow | undefined;
    return row ? toMarketSymbol(row) : null;
  }

  upsertMarketSymbol(symbol: MarketSymbol) {
    this.db
      .prepare(
        `INSERT INTO market_symbols (
           symbol, displayName, apiSymbol, category, digits, spread, leverage, contractSize,
           minLot, maxLot, lotStep, tradeStatus, isVisible, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           displayName = excluded.displayName,
           apiSymbol = excluded.apiSymbol,
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
        account.asset,
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

  listDepositAddresses() {
    return this.db.prepare("SELECT * FROM wallet_addresses ORDER BY derivationIndex ASC, createdAt ASC").all() as DepositAddressRow[];
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

  listWithdrawalsByStatuses(statuses: WithdrawalRequest["status"][]) {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM withdrawal_requests WHERE status IN (${placeholders}) ORDER BY createdAt ASC`)
      .all(...statuses) as WithdrawalRequestRow[];
  }

  getWithdrawalRequest(id: string) {
    return this.db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(id) as WithdrawalRequestRow | undefined;
  }

  saveWithdrawalRequest(request: WithdrawalRequest) {
    this.db
      .prepare(
        `INSERT INTO withdrawal_requests (
           id, userId, asset, amount, status, network, walletAddress, txHash,
           onchainStatus, chainId, tokenAddress, fromAddress, toAddress, broadcastTxHash,
           broadcastedAt, confirmedAt, failedAt, failedReason, confirmations,
           broadcastAttemptCount, lastBroadcastAttemptAt, remark, reviewNote, createdAt, reviewedAt, updatedAt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
           asset = excluded.asset,
           amount = excluded.amount,
           status = excluded.status,
           network = excluded.network,
           walletAddress = excluded.walletAddress,
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
        request.walletAddress ?? null,
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

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS market_symbols (
        symbol TEXT PRIMARY KEY,
        displayName TEXT NOT NULL,
        apiSymbol TEXT NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_funding_ledger_userId ON funding_ledger(userId);
      CREATE INDEX IF NOT EXISTS idx_funding_ledger_relatedId ON funding_ledger(relatedId);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_userId ON withdrawal_requests(userId);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
      CREATE INDEX IF NOT EXISTS idx_wallet_addresses_address ON wallet_addresses(address);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_userId ON onchain_deposits(userId);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_status ON onchain_deposits(status);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_toAddress ON onchain_deposits(toAddress);
      CREATE INDEX IF NOT EXISTS idx_onchain_deposits_blockNumber ON onchain_deposits(blockNumber);
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
    this.db.prepare("UPDATE withdrawal_requests SET status = 'pending_review' WHERE status = 'pending'").run();
    this.db.prepare("UPDATE withdrawal_requests SET status = 'confirmed', onchainStatus = 'confirmed' WHERE status = 'approved'").run();
    this.db.prepare("UPDATE withdrawal_requests SET onchainStatus = status WHERE onchainStatus IS NULL").run();
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
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
  return {
    ...row,
    isVisible: Boolean(row.isVisible),
  };
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}
