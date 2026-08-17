import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseUnifiedRealTradingTestArguments } from "./run-real-trading-test";

test("parses a default-preview OKX maximum-notional invocation", () => {
  assert.deepEqual(parseUnifiedRealTradingTestArguments([
    "--request-id", "doge-perp-long-8u",
    "--user-id", "user-a",
    "--venue", "okx",
    "--instrument", "DOGE-USDT-PERP",
    "--side", "buy",
    "--max-notional-usdt", "8",
  ]), {
    requestId: "doge-perp-long-8u",
    userId: "user-a",
    venue: "okx",
    instrumentId: "DOGE-USDT-PERP",
    side: "buy",
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" },
    reduceOnly: false,
    executionMode: "EXECUTION_PRIORITY",
    executeLive: false,
  });
});

test("parses explicit quantity, reduceOnly, execution mode, and live execution", () => {
  const invocation = parseUnifiedRealTradingTestArguments([
    "--request-id", "doge-close",
    "--user-id", "user-a",
    "--venue", "okx",
    "--instrument", "DOGE-USDT-PERP",
    "--side", "buy",
    "--quantity", "80",
    "--reduce-only",
    "--mode", "PRICE_PRIORITY",
    "--execute-live",
  ]);

  assert.equal(invocation.quantityInput.mode, "ASSET_QUANTITY");
  assert.equal(invocation.reduceOnly, true);
  assert.equal(invocation.executionMode, "PRICE_PRIORITY");
  assert.equal(invocation.executeLive, true);
});

test("rejects ambiguous quantity, duplicate flags, and unknown arguments", () => {
  const required = [
    "--request-id", "doge-test",
    "--user-id", "user-a",
    "--venue", "okx",
    "--instrument", "DOGE-USDT-PERP",
    "--side", "buy",
  ];
  assert.throws(() => parseUnifiedRealTradingTestArguments([
    ...required,
    "--quantity", "80",
    "--max-notional-usdt", "8",
  ]), /exactly one/u);
  assert.throws(() => parseUnifiedRealTradingTestArguments([
    ...required,
    "--quantity", "80",
    "--execute-live",
    "--execute-live",
  ]), /Duplicate argument/u);
  assert.throws(() => parseUnifiedRealTradingTestArguments([...required, "--quantity", "80", "--direct-provider"]), /Unsupported argument/u);
});

test("CLI composition contains only the formal runtime route and no direct Provider mutation", () => {
  const source = readFileSync(new URL("./run-real-trading-test.ts", import.meta.url), "utf8");

  assert.match(source, /UnifiedRealTradingTestCommand/u);
  assert.match(source, /FormalExecutionRuntimeRegistry/u);
  assert.match(source, /OkxFormalArbitrageExecutionRuntime/u);
  assert.doesNotMatch(source, /OkxClient|Bybit.*Provider|Bitget.*Provider|BinanceClient/u);
  assert.doesNotMatch(source, /\.placeOrder\(|INSERT INTO .*orders/iu);
});
