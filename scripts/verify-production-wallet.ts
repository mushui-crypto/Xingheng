import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.NODE_ENV = "production";

const [{ TradingService }, { TradingStore }, { OnchainWalletService }, { WalletService }] = await Promise.all([
  import("../server/market/TradingService"),
  import("../server/storage/TradingStore"),
  import("../server/wallet/OnchainWalletService"),
  import("../server/wallet/WalletService"),
]);

const directory = mkdtempSync(join(tmpdir(), "xingheng-production-wallet-"));
const databasePath = join(directory, "production.sqlite");

try {
  const store = new TradingStore(databasePath);
  const market = {
    getSymbol() {
      return null;
    },
    getTicker() {
      return { symbol: "BTCUSDT", status: "disconnected" as const };
    },
  };
  const trading = new TradingService(market, store);
  const onchain = new OnchainWalletService(store);
  new WalletService(store, trading, onchain);
  store.close();

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
    name: string;
  }>;
  const writes: string[] = [];
  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "userId")) continue;
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${name}" WHERE userId = ?`).get("demo-user") as { count: number };
    if (row.count > 0) writes.push(`${name}:${row.count}`);
  }
  database.close();

  if (writes.length) {
    throw new Error(`production WalletService wrote demo-user data: ${writes.join(", ")}`);
  }
  console.log("production wallet seed isolation passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
