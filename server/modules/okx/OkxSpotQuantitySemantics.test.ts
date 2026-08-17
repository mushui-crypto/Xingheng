import assert from "node:assert/strict";
import test from "node:test";
import { OkxInstrumentMappingAdapter } from "./OkxInstrumentMapping";
import { loadOkxSpotQuantityRules, okxBaseQuantityToSpotSize, okxSpotSizeToBase } from "./OkxSpotQuantitySemantics";

const now = 1_800_000_000_000;
const instrument = new OkxInstrumentMappingAdapter().resolve("DOGE-USDT-SPOT");

function rules(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    instType: "SPOT" as const, instId: "DOGE-USDT", baseCcy: "DOGE", quoteCcy: "USDT",
    lotSz: "0.1", minSz: "1", tickSz: "0.00001", state: "live", fetchedAt: now,
    ...overrides,
  };
}

test("Spot keeps canonical base quantity as sz without ctVal", async () => {
  const loaded = await loadOkxSpotQuantityRules(async () => rules(), instrument, now);
  assert.equal(okxBaseQuantityToSpotSize("100.2", loaded), "100.2");
  assert.equal(okxSpotSizeToBase("100.2", loaded), "100.2");
});

test("Spot quantity rules fail closed for minimum, stale, invalid, or mismatched instruments", async () => {
  await assert.rejects(() => loadOkxSpotQuantityRules(async () => null, instrument, now), /unavailable/u);
  await assert.rejects(() => loadOkxSpotQuantityRules(async () => rules({ fetchedAt: now - 300_001 }), instrument, now), /stale/u);
  await assert.rejects(() => loadOkxSpotQuantityRules(async () => rules({ lotSz: "0" }), instrument, now), /lotSz/u);
  await assert.rejects(() => loadOkxSpotQuantityRules(async () => rules({ instId: "BTC-USDT" }), instrument, now), /identity/u);
  const loaded = await loadOkxSpotQuantityRules(async () => rules(), instrument, now);
  assert.throws(() => okxBaseQuantityToSpotSize("0.9", loaded), /minSz/u);
  assert.throws(() => okxBaseQuantityToSpotSize("1.05", loaded), /lotSz/u);
});
