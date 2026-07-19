import assert from "node:assert/strict";
import test from "node:test";
import type { RealPosition } from "../../../api/realTrading";
import { enrichPositionMarks, preservePositionMarks } from "./enrichPositionMarks";

const position = (symbol: string, markPrice?: number | null): RealPosition => ({
  coin: symbol.replace(/USDT$/, ""),
  markPrice,
  markPx: markPrice,
  side: "long",
  size: 0.001,
  symbol,
});

test("realtime positions preserve a valid mark only from the same symbol", () => {
  const next = preservePositionMarks(
    [position("BTCUSDT"), position("ETHUSDT"), position("SOLUSDT")],
    [position("BTCUSDT", 64_000), position("ETHUSDT", 3_200)],
  );

  assert.equal(next[0].markPx, 64_000);
  assert.equal(next[1].markPx, 3_200);
  assert.equal(next[2].markPx, undefined);
});

test("missing realtime marks are fetched once per own symbol and never cross-filled", async () => {
  const requested: string[] = [];
  const next = await enrichPositionMarks(
    [position("BTCUSDT"), position("BTCUSDT"), position("ETHUSDT")],
    async (symbol) => {
      requested.push(symbol);
      return { markPrice: symbol === "BTCUSDT" ? 64_500 : null, symbol };
    },
  );

  assert.deepEqual(requested.sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(next[0].markPx, 64_500);
  assert.equal(next[1].markPx, 64_500);
  assert.equal(next[2].markPx, undefined);
});
