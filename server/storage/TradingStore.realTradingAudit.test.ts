import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TradingStore } from "./TradingStore";

test("real-trading audit schema stores only non-replayable metadata and retains 180 days by default", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-audit-"));
  const dbPath = join(directory, "test.sqlite");
  const store = new TradingStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = Date.now();
  store.saveRealTradingAudit(record("old", now - 181 * 86_400_000));
  store.saveRealTradingAudit(record("current", now));
  store.purgeExpiredRealTradingAudit(now);
  assert.deepEqual(store.listRealTradingAudit().map((item) => item.requestId), ["current"]);

  const db = new DatabaseSync(dbPath);
  const columns = db.prepare("PRAGMA table_info(real_trading_exchange_audit)").all() as Array<{ name: string }>;
  db.close();
  const names = columns.map((column) => column.name);
  assert.equal(names.includes("signature"), false);
  assert.equal(names.includes("nonce"), false);
  assert.equal(names.includes("payload"), false);
  assert.equal(names.includes("privateKey"), false);
  assert.equal(names.includes("mnemonic"), false);
  assert.equal(names.includes("errorCategory"), true);

  const idempotencyDb = new DatabaseSync(dbPath);
  const idempotencyColumns = idempotencyDb
    .prepare("PRAGMA table_info(real_trading_order_idempotency)").all() as Array<{ name: string }>;
  idempotencyDb.close();
  const idempotencyNames = idempotencyColumns.map((column) => column.name);
  assert.equal(idempotencyNames.includes("cloid"), true);
  assert.equal(idempotencyNames.includes("signature"), false);
  assert.equal(idempotencyNames.includes("payload"), false);

  store.upsertRealTradingAgentBinding({
    userId: "USR-test",
    masterAddress: "0x1111111111111111111111111111111111111111",
    agentAddress: "0x2222222222222222222222222222222222222222",
    approvedAt: now,
    updatedAt: now,
  });
  assert.equal(
    store.findRealTradingAgentBinding("USR-test", "0x1111111111111111111111111111111111111111")?.agentAddress,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(store.findRealTradingAgentBinding("USR-other", "0x1111111111111111111111111111111111111111"), undefined);
});

function record(requestId: string, completedAt: number) {
  return {
    requestId,
    userId: "USR-test",
    network: "hyperliquid-testnet" as const,
    masterAddress: "0x1111111111111111111111111111111111111111",
    actionType: "order",
    clientOrderIds: ["0x11111111111111111111111111111111"],
    outcome: "accepted" as const,
    errorCategory: null,
    providerStatus: "ok",
    httpStatus: 200,
    message: null,
    submittedAt: completedAt - 1,
    completedAt,
  };
}
