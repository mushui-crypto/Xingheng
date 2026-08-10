import assert from "node:assert/strict";
import test from "node:test";
import {
  CexReadCapabilityRegistry,
  cexReadCapabilityRegistry,
  type CexReadCapability,
} from "./CexReadCapabilityRegistry";
import type { CexVenue } from "./CexCanonicalModels";

const venues: readonly CexVenue[] = ["binance", "okx", "bitget", "bybit"];
const defaultCapabilities: readonly CexReadCapability[] = ["instrument_catalog", "funding_rate", "market_data"];
const expectedCapabilities: Readonly<Record<CexVenue, readonly CexReadCapability[]>> = {
  binance: defaultCapabilities,
  okx: defaultCapabilities,
  bitget: defaultCapabilities,
  bybit: defaultCapabilities,
};

test("the static registry discovers declared read capabilities for every CEX venue", () => {
  assert.equal(cexReadCapabilityRegistry.list().length, venues.length);

  for (const venue of venues) {
    const capabilities = expectedCapabilities[venue];
    assert.deepEqual(cexReadCapabilityRegistry.lookup(venue), { venue, capabilities });
    for (const capability of capabilities) {
      assert.equal(cexReadCapabilityRegistry.hasCapability(venue, capability), true);
    }
  }
});

test("every Phase 9.1 CEX venue advertises read-only market data", () => {
  for (const venue of venues) {
    assert.equal(cexReadCapabilityRegistry.hasCapability(venue, "market_data"), true);
  }
});

test("an unregistered venue and an undeclared read capability are not discovered", () => {
  const registry = new CexReadCapabilityRegistry()
    .register({ venue: "okx", capabilities: ["instrument_catalog"] });

  assert.equal(registry.lookup("bybit"), undefined);
  assert.equal(registry.hasCapability("okx", "funding_rate"), false);
});

test("registration rejects duplicate venue metadata and duplicate capabilities", () => {
  const registry = new CexReadCapabilityRegistry()
    .register({ venue: "binance", capabilities: ["instrument_catalog"] });

  assert.throws(
    () => registry.register({ venue: "binance", capabilities: ["funding_rate"] }),
    /already registered/u,
  );
  assert.throws(
    () => new CexReadCapabilityRegistry().register({
      venue: "bybit",
      capabilities: ["funding_rate", "funding_rate"],
    }),
    /Duplicate read capability/u,
  );
});
