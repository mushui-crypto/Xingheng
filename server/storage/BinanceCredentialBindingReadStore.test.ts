import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BinanceCredentialBindingReadStore } from "./BinanceCredentialBindingReadStore";
import { TradingStore } from "./TradingStore";

function uidSnapshot(uid: string) {
  return createHash("sha256").update(`binance:${uid}`).digest("hex");
}

test("read-only Binance binding store returns the active binding only", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-binding-read-"));
  const dbPath = join(directory, "test.sqlite");
  const writer = new TradingStore(dbPath);
  writer.bindBinanceCredential("user-a", uidSnapshot("10001"), "主账户", 100);
  const reader = new BinanceCredentialBindingReadStore(dbPath);
  t.after(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual({ ...reader.findActiveBinanceCredentialBinding("user-a")! }, {
    userId: "user-a",
    venue: "binance",
    uidSnapshot: uidSnapshot("10001"),
    credentialNote: "主账户",
    bindingVersion: 1,
    status: "active",
    interventionStatus: "none",
    createdAt: 100,
    updatedAt: 100,
  });
  assert.equal(reader.findActiveBinanceCredentialBinding("user-b"), null);
});

test("read-only Binance binding store fails closed for non-active bindings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-binding-read-unbound-"));
  const dbPath = join(directory, "test.sqlite");
  const writer = new TradingStore(dbPath);
  const snapshot = uidSnapshot("20002");
  writer.bindBinanceCredential("user-a", snapshot, "", 100);
  writer.markBinanceVerifiedUnbound("user-a", snapshot, 1, 101);
  const reader = new BinanceCredentialBindingReadStore(dbPath);
  t.after(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(reader.findActiveBinanceCredentialBinding("user-a"), null);
});
