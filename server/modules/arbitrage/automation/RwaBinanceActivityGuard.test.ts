import assert from "node:assert/strict";
import test from "node:test";
import {
  RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS,
  RwaBinanceActivityGuard,
  RwaBinanceActivityUnsafeError,
} from "./RwaBinanceActivityGuard";

test("Binance activity certificate is short-lived, mutation-specific, and one-time", () => {
  let now = 1_000;
  const guard = new RwaBinanceActivityGuard(() => {}, () => now);
  guard.markConnected("spot");
  guard.markConnected("futures");
  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  guard.consumeCertificate("place_spot_order");
  assert.throws(
    () => guard.consumeCertificate("place_spot_order"),
    (error) => error instanceof RwaBinanceActivityUnsafeError && error.reason === "certificate_missing",
  );

  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  assert.throws(
    () => guard.consumeCertificate("place_futures_order"),
    (error) => error instanceof RwaBinanceActivityUnsafeError && error.reason === "certificate_mismatch",
  );

  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  now += 2_001;
  assert.throws(
    () => guard.consumeCertificate("place_spot_order"),
    (error) => error instanceof RwaBinanceActivityUnsafeError && error.reason === "certificate_expired",
  );
});

test("external order between check and mutation invalidates the certificate", () => {
  const reasons: string[] = [];
  const guard = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); });
  guard.registerStrategyOrderPrefix("stx-");
  guard.markConnected("spot");
  guard.markConnected("futures");
  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  guard.observeOrder({ leg: "spot", clientOrderId: "manual-order", eventTime: 1_001 });
  assert.throws(
    () => guard.consumeCertificate("place_spot_order"),
    (error) => error instanceof RwaBinanceActivityUnsafeError && error.reason === "certificate_missing",
  );
  assert.deepEqual(reasons, ["unknown_provider_order_or_fill"]);
});

test("strategy orders are attributed while unknown balance events and disconnects fail closed", () => {
  const reasons: string[] = [];
  const guard = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); });
  guard.registerStrategyOrderPrefix("stx-");
  guard.markConnected("spot");
  guard.markConnected("futures");
  guard.observeOrder({ leg: "spot", clientOrderId: "stx-s1", eventTime: 1_000 });
  guard.issueCertificate({ mutation: "cancel_spot_order", providerOrderId: "1" });
  guard.markDisconnected("spot");
  assert.throws(() => guard.consumeCertificate("cancel_spot_order"));
  assert.deepEqual(reasons, ["spot_stream_disconnected"]);

  const restarted = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); });
  restarted.markConnected("spot");
  restarted.markConnected("futures");
  restarted.issueCertificate({ mutation: "set_leverage", expectedLeverage: 1 });
  restarted.resetForRestart();
  assert.throws(() => restarted.consumeCertificate("set_leverage"));
  assert.equal(reasons.at(-1), "activity_guard_restarted");

  const balance = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); });
  balance.markConnected("spot");
  balance.markConnected("futures");
  balance.observeAccountChange("spot", "balance_change", 1_000);
  assert.equal(reasons.at(-1), "unknown_balance_change");

  const unknown = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); });
  unknown.markConnected("spot");
  unknown.markConnected("futures");
  unknown.observeUnknownEvent("provider_schema_change");
  assert.equal(reasons.at(-1), "unknown_event:provider_schema_change");
});

test("unknown account activity is never hidden by a recent mutation certificate", () => {
  const reasons: string[] = [];
  const guard = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); }, () => 1_000);
  guard.registerStrategyOrderPrefix("stx-");
  guard.markConnected("spot");
  guard.markConnected("futures");
  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  guard.consumeCertificate("place_spot_order");

  guard.observeAccountChange("spot", "spot_outboundAccountPosition", 1_001);

  assert.throws(
    () => guard.issueCertificate({ mutation: "place_futures_order", orderLinkId: "stx-p1" }),
    (error) => error instanceof RwaBinanceActivityUnsafeError && error.reason === "stream_not_continuous",
  );
  assert.deepEqual(reasons, ["unknown_spot_outboundAccountPosition"]);
});

test("account updates require an exact attributed order event and config updates require exact leverage", () => {
  const reasons: string[] = [];
  const guard = new RwaBinanceActivityGuard((reason) => { reasons.push(reason); });
  guard.registerStrategyOrderPrefix("stx-");
  guard.markConnected("spot");
  guard.markConnected("futures");
  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  guard.consumeCertificate("place_spot_order");
  guard.observeOrder({
    leg: "spot",
    clientOrderId: "stx-s1",
    providerOrderId: "10",
    eventTime: 2_000,
    accountChangeExpected: true,
  });
  guard.observeAccountChange("spot", "spot_outboundAccountPosition", 2_000);
  guard.issueCertificate({ mutation: "set_leverage", expectedLeverage: 1 });
  guard.consumeCertificate("set_leverage");
  guard.observeAccountConfigUpdate("XAUTUSDT", 1);

  assert.deepEqual(reasons, []);
});

test("pending order and account expectations expire fail-closed instead of remaining unbounded", () => {
  let now = 1_000;
  const mutationReasons: string[] = [];
  const mutation = new RwaBinanceActivityGuard(
    (reason) => { mutationReasons.push(reason); },
    () => now,
  );
  mutation.markConnected("spot");
  mutation.markConnected("futures");
  mutation.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  mutation.consumeCertificate("place_spot_order");
  now += RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS;
  mutation.checkSettlementDeadlines();
  assert.deepEqual(mutationReasons, ["unknown_expected_mutation_settlement_timeout"]);
  assert.throws(() =>
    mutation.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s2" }));

  const accountReasons: string[] = [];
  const account = new RwaBinanceActivityGuard(
    (reason) => { accountReasons.push(reason); },
    () => now,
  );
  account.markConnected("spot");
  account.markConnected("futures");
  account.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  account.consumeCertificate("place_spot_order");
  account.observeOrder({
    leg: "spot",
    clientOrderId: "stx-s1",
    providerOrderId: "10",
    eventTime: now,
    terminal: true,
    accountChangeExpected: true,
  });
  now += RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS;
  account.checkSettlementDeadlines();
  assert.deepEqual(accountReasons, ["unknown_expected_account_settlement_timeout"]);
});

test("zero-fill order states settle without requiring an account update", () => {
  let now = 1_000;
  for (const terminal of [true, false]) {
    const reasons: string[] = [];
    const guard = new RwaBinanceActivityGuard(
      (reason) => { reasons.push(reason); },
      () => now,
    );
    guard.markConnected("spot");
    guard.markConnected("futures");
    guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
    guard.consumeCertificate("place_spot_order");
    guard.observeOrder({
      leg: "spot",
      clientOrderId: "stx-s1",
      providerOrderId: "10",
      eventTime: now,
      terminal,
      accountChangeExpected: false,
    });
    now += RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS;
    guard.checkSettlementDeadlines();
    assert.deepEqual(reasons, []);
  }
});

test("an actual fill without its account update still expires fail-closed", () => {
  let now = 1_000;
  const reasons: string[] = [];
  const guard = new RwaBinanceActivityGuard(
    (reason) => { reasons.push(reason); },
    () => now,
  );
  guard.markConnected("spot");
  guard.markConnected("futures");
  guard.issueCertificate({ mutation: "place_spot_order", orderLinkId: "stx-s1" });
  guard.consumeCertificate("place_spot_order");
  guard.observeOrder({
    leg: "spot",
    clientOrderId: "stx-s1",
    providerOrderId: "10",
    eventTime: now,
    terminal: true,
    accountChangeExpected: true,
  });
  now += RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS;
  guard.checkSettlementDeadlines();
  assert.deepEqual(reasons, ["unknown_expected_account_settlement_timeout"]);
});
