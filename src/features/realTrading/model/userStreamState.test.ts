import assert from "node:assert/strict";
import test from "node:test";
import type { RealTradingUserStreamEvent } from "../../../api/realTrading";
import { decideRealTradingUserStreamSequence, parseRealTradingUserStreamEvent } from "./userStreamState";

const address = "0x1111111111111111111111111111111111111111";

test("accepts only authoritative address-bound real-trading user events", () => {
  const valid = event({ mode: "snapshot", sequence: 7 });
  assert.equal(parseRealTradingUserStreamEvent(valid, address)?.sequence, 7);
  assert.equal(parseRealTradingUserStreamEvent({ ...valid, address: "0x2222222222222222222222222222222222222222" }, address), null);
  assert.equal(parseRealTradingUserStreamEvent({ ...valid, authoritative: false }, address), null);
  assert.equal(parseRealTradingUserStreamEvent({ ...valid, channel: "private-key" }, address), null);
});

test("requires a recovery snapshot for gaps and ignores duplicates", () => {
  assert.equal(decideRealTradingUserStreamSequence(null, event({ channel: "connection", mode: "incremental", sequence: 1 })), "accept");
  assert.equal(decideRealTradingUserStreamSequence(null, event({ channel: "orders", mode: "incremental", sequence: 1 })), "gap");
  assert.equal(decideRealTradingUserStreamSequence(4, event({ mode: "incremental", sequence: 4 })), "ignore");
  assert.equal(decideRealTradingUserStreamSequence(4, event({ mode: "incremental", sequence: 5 })), "accept");
  assert.equal(decideRealTradingUserStreamSequence(4, event({ mode: "incremental", sequence: 6 })), "gap");
  assert.equal(decideRealTradingUserStreamSequence(99, event({ mode: "snapshot", sequence: 2 })), "accept");
});

function event(overrides: Partial<RealTradingUserStreamEvent>): RealTradingUserStreamEvent {
  return {
    address,
    authoritative: true,
    channel: "connection",
    data: null,
    mode: "incremental",
    reconnecting: false,
    sequence: 1,
    source: "hyperliquid-user-ws",
    stale: false,
    status: "connected",
    timestamp: Date.now(),
    type: "real-trading-user",
    ...overrides,
  };
}
