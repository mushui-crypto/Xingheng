import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAsset } from "./Asset";
import {
  ExplicitCanonicalAssetSource,
  createExecutionCanonicalAssetSource,
} from "./CanonicalAssetSource";

test("explicit canonical source returns the declared Asset including its canonical type", () => {
  const source = createExecutionCanonicalAssetSource();

  assert.equal(source.getAsset("BTC")?.type, "DIGITAL_ASSET");
  assert.equal(source.getAsset("ETH")?.type, "DIGITAL_ASSET");
  assert.equal(source.getAsset("DOGE")?.type, "DIGITAL_ASSET");
  assert.equal(source.getAsset("XAUT")?.type, "RWA_ASSET");
  assert.equal(source.getAsset("UNKNOWN"), null);
});

test("source is deterministic, read-only, and rejects duplicate canonical definitions", () => {
  const btc = createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" });
  const source = new ExplicitCanonicalAssetSource([btc]);

  assert.equal(source.getAsset("BTC"), source.getAsset("BTC"));
  assert.throws(() => new ExplicitCanonicalAssetSource([btc, btc]), /Duplicate canonical asset definition/u);
  assert.equal("setAsset" in source, false);
  assert.equal("deleteAsset" in source, false);
});

test("canonical source contains no provider lookup or symbol-to-type conditional inference", () => {
  const source = readFileSync(new URL("./CanonicalAssetSource.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Binance|exchangeInfo|providerSymbol|fetch\s*\(/u);
  assert.doesNotMatch(source, /if\s*\([^)]*(?:BTC|ETH|DOGE|XAUT)[^)]*\)/u);
});
