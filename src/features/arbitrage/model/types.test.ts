import assert from "node:assert/strict";
import test from "node:test";
import { ARBITRAGE_ASSET_ORDER } from "./types";

test("arbitrage asset catalog includes the requested major crypto assets", () => {
  for (const asset of ["BTC", "ETH", "SOL", "XRP", "DOGE"] as const) {
    assert.ok(ARBITRAGE_ASSET_ORDER.includes(asset), `${asset} should be available to the asset filter`);
  }
});

test("audited equity expansion is searchable without admitting ETFs or unresolved aliases", () => {
  for (const asset of ["AAPL", "AMZN", "META", "COIN", "PLTR", "MSTR", "HOOD", "INTC", "AVGO", "ORCL", "NFLX", "CRM", "WMT", "CRCL", "SNDK", "QCOM", "UBER", "JPM", "V"] as const) {
    assert.ok(ARBITRAGE_ASSET_ORDER.includes(asset));
  }
  for (const asset of ["QQQ", "SPY", "SOXL", "AMDSTOCK", "OPENAI", "GOOG"]) {
    assert.ok(!(ARBITRAGE_ASSET_ORDER as readonly string[]).includes(asset));
  }
  assert.equal(new Set(ARBITRAGE_ASSET_ORDER).size, ARBITRAGE_ASSET_ORDER.length);
});
