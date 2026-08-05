import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BinanceBindingStoreError, TradingStore } from "./TradingStore";

const fingerprint = (uid: string) => createHash("sha256").update(`binance:${uid}`).digest("hex");

test("Binance UID ownership is unique and permanent per user", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-binding-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const first = store.bindBinanceUid("user-a", fingerprint("10001"), 100);
  assert.equal(first.bindingVersion, 1);
  assert.equal(first.status, "active");
  assert.equal(first.uidFingerprint.length, 64);
  assert.deepEqual(store.bindBinanceUid("user-a", fingerprint("10001"), 101), first);

  assert.throws(
    () => store.bindBinanceUid("user-b", fingerprint("10001"), 102),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "binding_uid_conflict",
  );
  assert.throws(
    () => store.bindBinanceUid("user-a", fingerprint("20002"), 103),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "binding_user_conflict",
  );
});

test("Binance binding rejects truncated fingerprints", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-binding-fingerprint-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.throws(() => store.bindBinanceUid("user-a", fingerprint("10001").slice(0, 16)));
});
