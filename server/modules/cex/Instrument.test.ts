import assert from "node:assert/strict";
import test from "node:test";
import { createAsset } from "./Asset";
import { createCanonicalInstrument, createInstrument, toCanonicalInstrument } from "./Instrument";
import { InstrumentCapability } from "./InstrumentCapability";

test("creates a spot instrument linked to assets", () => {
  const instrument = createInstrument({
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "SPOT",
  });

  assert.deepEqual(instrument, {
    instrumentId: "BTC-USDT-SPOT",
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "SPOT",
  });
});

test("creates a perpetual instrument linked to assets", () => {
  const instrument = createInstrument({
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "PERPETUAL",
  });

  assert.deepEqual(instrument, {
    instrumentId: "BTC-USDT-PERP",
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "PERPETUAL",
  });
  assert.deepEqual(toCanonicalInstrument(instrument), {
    baseAsset: "BTC",
    quoteAsset: "USDT",
    contractType: "perpetual",
  });
});

test("supports RWA instruments without venue details", () => {
  const instrument = createInstrument({
    baseAsset: createAsset({
      symbol: "XAUT",
      type: "RWA_ASSET",
      externalReference: {
        namespace: "issuer",
        identifier: "tether:xaut",
      },
    }),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "PERPETUAL",
  });

  assert.equal(instrument.instrumentId, "XAUT-USDT-PERP");
  assert.equal(instrument.baseAsset.type, "RWA_ASSET");
  assert.equal("venue" in instrument, false);
  assert.equal("symbol" in instrument, false);
  assert.equal("orderId" in instrument, false);
});

test("rejects venue fields and invalid instrument types", () => {
  assert.throws(() => createInstrument({
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "PERPETUAL",
    venue: "binance",
  }), /unsupported field: venue/u);
  assert.throws(() => createInstrument({
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    instrumentType: "FUTURE",
  }), /instrumentType must be SPOT or PERPETUAL/u);
});

test("creates a canonical instrument model", () => {
  const instrument = createCanonicalInstrument({
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    contractType: "perpetual",
  });

  assert.deepEqual(instrument, {
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    contractType: "perpetual",
  });
});

test("maps canonical instruments to Binance venue instruments", () => {
  const capability = new InstrumentCapability();
  const spot = capability.resolveVenueInstrument(canonicalSpot(), "binance");
  const perp = capability.resolveVenueInstrument(canonicalPerp(), "binance");

  assert.deepEqual(spot, {
    venue: "binance",
    symbol: "XAUTUSDT",
    instId: "XAUTUSDT",
    category: "spot",
    contractIdentifier: "binance:spot:XAUTUSDT",
    tradingRules: {},
  });
  assert.deepEqual(perp, {
    venue: "binance",
    symbol: "XAUTUSDT",
    instId: "XAUTUSDT",
    category: "linear",
    contractIdentifier: "binance:perpetual:XAUTUSDT",
    tradingRules: {},
  });
});

test("maps canonical instruments to OKX venue instruments", () => {
  const capability = new InstrumentCapability();
  const spot = capability.resolveVenueInstrument(canonicalSpot(), "okx");
  const perp = capability.resolveVenueInstrument(canonicalPerp(), "okx");

  assert.deepEqual(spot, {
    venue: "okx",
    symbol: "XAUT-USDT",
    instId: "XAUT-USDT",
    category: "spot",
    contractIdentifier: "okx:spot:XAUTUSDT",
    tradingRules: {},
  });
  assert.deepEqual(perp, {
    venue: "okx",
    symbol: "XAUT-USDT-SWAP",
    instId: "XAUT-USDT-SWAP",
    category: "swap",
    contractIdentifier: "okx:perpetual:XAUTUSDT",
    tradingRules: {},
  });
});

test("maps canonical instruments to Bybit and Bitget venue instruments", () => {
  const capability = new InstrumentCapability();
  const bybit = capability.resolveVenueInstrument(canonicalPerp(), "bybit");
  const bitget = capability.resolveVenueInstrument(canonicalPerp(), "bitget");

  assert.deepEqual(bybit, {
    venue: "bybit",
    symbol: "XAUTUSDT",
    instId: "XAUTUSDT",
    category: "linear",
    contractIdentifier: "bybit:perpetual:XAUTUSDT",
    tradingRules: {},
  });
  assert.deepEqual(bitget, {
    venue: "bitget",
    symbol: "XAUTUSDT",
    instId: "XAUTUSDT",
    category: "linear",
    contractIdentifier: "bitget:perpetual:XAUTUSDT",
    tradingRules: {},
  });
});

test("rejects unknown venues", () => {
  const capability = new InstrumentCapability();
  const instrument = canonicalPerp();

  assert.throws(() => capability.resolveVenueInstrument(instrument, "tradexyz"), /Unsupported venue/u);
});

test("rejects malformed canonical instruments", () => {
  assert.throws(() => createCanonicalInstrument({
    baseAsset: "xaut",
    quoteAsset: "USDT",
    contractType: "perpetual",
  }), /uppercase asset symbol/u);
  assert.throws(() => createCanonicalInstrument({
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    contractType: "linear",
  }), /contractType must be spot or perpetual/u);
});

function canonicalSpot() {
  return createCanonicalInstrument({
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    contractType: "spot",
  });
}

function canonicalPerp() {
  return createCanonicalInstrument({
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    contractType: "perpetual",
  });
}

function digitalAsset(symbol: string) {
  return createAsset({
    symbol,
    type: "DIGITAL_ASSET",
  });
}
