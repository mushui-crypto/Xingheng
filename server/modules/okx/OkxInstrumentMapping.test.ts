import assert from "node:assert/strict";
import test from "node:test";
import { OkxInstrumentMappingAdapter } from "./OkxInstrumentMapping";

test("maps DOGE-USDT-PERP to the OKX USDT swap instrument", () => {
  const resolved = new OkxInstrumentMappingAdapter().resolve("DOGE-USDT-PERP");

  assert.deepEqual(resolved, {
    canonicalInstrument: {
      instrumentId: "DOGE-USDT-PERP",
      baseAsset: "DOGE",
      quoteAsset: "USDT",
      contractType: "perpetual",
    },
    venueInstrument: {
      venue: "okx",
      instId: "DOGE-USDT-SWAP",
      contractType: "linear_perpetual",
      quantityRulesReference: {
        source: "okx-instruments",
        instType: "SWAP",
        instId: "DOGE-USDT-SWAP",
        fields: ["lotSz", "minSz", "ctVal", "tickSz"],
      },
    },
  });
});

test("rejects unsupported canonical instruments", () => {
  assert.throws(
    () => new OkxInstrumentMappingAdapter().resolve("BTC-USDT-PERP"),
    /Unsupported OKX instrument: BTC-USDT-PERP/u,
  );
});

test("rejects invalid OKX mapping records", () => {
  assert.throws(
    () => new OkxInstrumentMappingAdapter([{
      canonicalInstrumentId: "DOGE-USDT-PERP",
      instId: "DOGEUSDT",
      contractType: "linear_perpetual",
    }]),
    /Invalid OKX instrument mapping: DOGE-USDT-PERP must map to DOGE-USDT-SWAP/u,
  );

  assert.throws(
    () => new OkxInstrumentMappingAdapter([{
      canonicalInstrumentId: "DOGE-USDT-SPOT",
      instId: "DOGE-USDT-SWAP",
      contractType: "linear_perpetual",
    }]),
    /Invalid OKX instrument mapping: only perpetual instruments are supported/u,
  );
});

test("returns deterministic resolution for string and object canonical input", () => {
  const adapter = new OkxInstrumentMappingAdapter();

  const first = adapter.resolve("DOGE-USDT-PERP");
  const second = adapter.resolve({
    instrumentId: "DOGE-USDT-PERP",
    baseAsset: "DOGE",
    quoteAsset: "USDT",
    contractType: "perpetual",
  });

  assert.deepEqual(second, first);
  assert.deepEqual(adapter.resolve("DOGE-USDT-PERP"), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.venueInstrument), true);
});
