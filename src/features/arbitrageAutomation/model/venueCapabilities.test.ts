import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProductAvailability, resolveVenueCapabilities } from "./venueCapabilities";

test("Binance execution capability requires the server to explicitly enable provider writes", () => {
  const capability = resolveVenueCapabilities({
    venue: "binance",
    implemented: true,
    enabled: true,
    phase: "execution_capable",
    providerWritesEnabled: true,
  });
  assert.equal(capability.canAuthorize, true);
  assert.equal(capability.canRunReadOnlyPreflight, true);
  assert.equal(capability.canExecute, true);
  assert.match(capability.phaseLabel, /受控真实执行/);
});

test("Bybit and Binance share explicit execution-capable mapping while account readiness stays separate", () => {
  for (const venue of ["bybit", "binance"] as const) {
    const capability = resolveVenueCapabilities({
      venue,
      implemented: true,
      enabled: false,
      phase: "execution_capable",
      providerWritesEnabled: true,
    });
    assert.equal(capability.canAuthorize, true);
    assert.equal(capability.canRunReadOnlyPreflight, true);
    assert.equal(capability.canExecute, true);
    assert.match(capability.phaseLabel, /执行已关闭/);
  }
});

test("unknown or incomplete capability states fail closed", () => {
  for (const input of [
    { venue: "binance" as const, implemented: true, enabled: false, phase: "future_phase", providerWritesEnabled: false },
    { venue: "binance" as const, implemented: true, enabled: true, phase: "execution_capable", providerWritesEnabled: false },
    { venue: "binance" as const, implemented: true, enabled: false },
    { venue: "bitget" as const, implemented: false, enabled: false },
    { venue: "okx" as const, implemented: true, enabled: true, phase: "execution_capable", providerWritesEnabled: true },
  ]) {
    const capability = resolveVenueCapabilities(input);
    assert.equal(capability.canAuthorize, false);
    assert.equal(capability.canRunReadOnlyPreflight, false);
    assert.equal(capability.canExecute, false);
  }
});

test("Binance product availability preserves all known states and fails unknown input closed", () => {
  for (const status of ["available", "spot_unavailable", "perpetual_unavailable", "both_unavailable"] as const) {
    const mapped = normalizeProductAvailability({
      available: status === "available",
      status,
      spotSymbol: "XAUTUSDT",
      perpetualSymbol: "XAUTUSDT",
      checkedAt: 123,
      message: status === "available" ? null : "fixture unavailable",
    });
    assert.equal(mapped?.status, status);
    assert.equal(mapped?.available, status === "available");
  }
  const unknown = normalizeProductAvailability({ available: true, status: "future_status", spotSymbol: "PAXGUSDT" });
  assert.equal(unknown?.status, "unknown");
  assert.equal(unknown?.available, false);
  assert.equal(unknown?.spotSymbol, "PAXGUSDT");
  assert.equal(normalizeProductAvailability(null), null);
});
