import { DatabaseSync } from "node:sqlite";
import type { BinanceCredentialBinding } from "./TradingStore";

export class BinanceCredentialBindingReadStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath = process.env.TRADING_DB_PATH ?? "") {
    if (!dbPath) {
      throw new Error("TRADING_DB_PATH is required for Binance binding preflight.");
    }
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  findActiveBinanceCredentialBinding(userId: string, venue = "binance") {
    const row = this.db.prepare(
      `SELECT userId, venue, uidSnapshot, credentialNote, bindingVersion, status,
              interventionStatus, createdAt, updatedAt
         FROM binance_credential_bindings
        WHERE userId = ? AND venue = ? AND status = 'active'`,
    ).get(userId, venue) as BinanceCredentialBinding | undefined;
    return row ?? null;
  }

  close() {
    this.db.close();
  }
}
