import assert from "node:assert/strict";
import test from "node:test";
import type { BinanceStatus } from "../../../api/binancePersonalTrading";
import { canEnterBinancePosition, mergeCredentialSummaries } from "./personalTradingState";

const status: BinanceStatus = {
  mode: "personal",
  version: "development",
  credential: { configured: true, maskedApiKey: "abc...xyz" },
  connection: { status: "connected", checkedAt: 1, accountId: "account", message: null },
  risk: { liveTradingEnabled: true, killSwitchActive: false, maxOrderUsd: 25, maxPositionUsd: 100 },
};

test("entry is fail-closed unless credentials, connection and both risk switches allow it", () => {
  assert.equal(canEnterBinancePosition(status), true);
  assert.equal(canEnterBinancePosition({ ...status, risk: { ...status.risk, liveTradingEnabled: false } }), false);
  assert.equal(canEnterBinancePosition({ ...status, risk: { ...status.risk, killSwitchActive: true } }), false);
  assert.equal(canEnterBinancePosition({ ...status, connection: { ...status.connection, status: "failed" } }), false);
  assert.equal(canEnterBinancePosition(null), false);
});

test("credential summaries include every venue without inventing configured state", () => {
  const result = mergeCredentialSummaries([{
    venue: "binance",
    configured: true,
    implemented: true,
    accountId: "account",
    accountFingerprint: "fingerprint",
    maskedApiKey: "abc...xyz",
    permissions: { read: true },
    lastVerifiedAt: 1,
    message: null,
  }]);
  assert.equal(result.length, 4);
  assert.equal(result[0].configured, true);
  assert.equal(result[1].configured, false);
  assert.equal(result[1].implemented, true);
});
