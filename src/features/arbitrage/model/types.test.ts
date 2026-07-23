import assert from "node:assert/strict";
import test from "node:test";
import { ARBITRAGE_ASSET_ORDER } from "./types";

test("arbitrage asset catalog includes the requested major crypto assets", () => {
  for (const asset of ["BTC", "ETH", "SOL", "XRP", "DOGE"] as const) {
    assert.ok(ARBITRAGE_ASSET_ORDER.includes(asset), `${asset} should be available to the asset filter`);
  }
});
