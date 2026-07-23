import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProductAvailability, resolveVenueCapabilities } from "./venueCapabilities";

test("Binance phase 1 allows authorization and Shadow checks but no provider writes", () => {
  const capability = resolveVenueCapabilities({
    venue: "binance",
    implemented: true,
    enabled: false,
    phase: "phase_1_read_only_shadow",
    providerWritesEnabled: false,
  });
  assert.equal(capability.canAuthorize, true);
  assert.equal(capability.canRunReadOnlyPreflight, true);
  assert.equal(capability.canExecute, false);
  assert.match(capability.phaseLabel, /Shadow/);
});

test("Bybit keeps execution capability only when the server explicitly enables writes", () => {
  const enabled = resolveVenueCapabilities({
    venue: "bybit",
    implemented: true,
    enabled: true,
    phase: "execution_capable",
    providerWritesEnabled: true,
  });
  assert.equal(enabled.canAuthorize, true);
  assert.equal(enabled.canExecute, true);

  const disabled = resolveVenueCapabilities({
    venue: "bybit",
    implemented: true,
    enabled: false,
    phase: "execution_capable",
    providerWritesEnabled: true,
  });
  assert.equal(disabled.canAuthorize, true);
  assert.equal(disabled.canExecute, true);
});

test("unknown or incomplete capability states fail closed", () => {
  for (const input of [
    { venue: "binance" as const, implemented: true, enabled: false, phase: "future_phase", providerWritesEnabled: false },
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
