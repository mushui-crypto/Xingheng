import assert from "node:assert/strict";
import test from "node:test";
import type { MartingaleCompletedGroup, MartingaleOpenGroup } from "../model/martingaleTypes";
import { buildMartingaleMarkerEvents, martingaleFillMarkerId } from "./martingaleChart";

test("builds entry, every add layer and completed-group exit markers", () => {
  const group = makeCompletedGroup();
  const events = buildMartingaleMarkerEvents([group], "5m");
  assert.deepEqual(events.map((event) => [event.kind, event.label, event.detail.level, event.price]), [
    ["entry", "多开", 1, 100],
    ["add", "加多2", 2, 99],
    ["add", "加多3", 3, 98],
    ["exit", "平多", null, 102],
  ]);
});

test("keeps same-candle fills in stable level order without dropping any layer", () => {
  const group = makeCompletedGroup();
  group.fills = [group.fills[2], group.fills[0], group.fills[1]];
  const events = buildMartingaleMarkerEvents([group], "15m").filter((event) => event.kind !== "exit");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.detail.level), [1, 2, 3]);
  assert.equal(new Set(events.map((event) => event.bucketTime)).size, 1);
});

test("open group contains fill markers and never invents an exit", () => {
  const group: MartingaleOpenGroup = {
    ...makeCompletedGroup(),
    nextGridPrice: 97,
    markPrice: 101,
    unrealizedPnl: 2,
    feesPaid: 0.2,
  };
  delete (group as Partial<MartingaleCompletedGroup>).exitTime;
  delete (group as Partial<MartingaleCompletedGroup>).exitPrice;
  delete (group as Partial<MartingaleCompletedGroup>).exitReason;
  delete (group as Partial<MartingaleCompletedGroup>).grossPnl;
  delete (group as Partial<MartingaleCompletedGroup>).netPnl;
  delete (group as Partial<MartingaleCompletedGroup>).fees;
  delete (group as Partial<MartingaleCompletedGroup>).rMultiple;
  delete (group as Partial<MartingaleCompletedGroup>).holdingMinutes;
  const events = buildMartingaleMarkerEvents([group], "5m");
  assert.deepEqual(events.map((event) => event.kind), ["entry", "add", "add"]);
});

test("marker ids identify an exact fill for record-to-chart focus", () => {
  const group = makeCompletedGroup();
  assert.equal(
    martingaleFillMarkerId(group, group.fills[1], 1),
    "group-1:fill:2:2026-07-17T01:06:00.000Z",
  );
});

function makeCompletedGroup(): MartingaleCompletedGroup {
  return {
    id: "group-1",
    symbol: "BTCUSDT",
    side: "long",
    signalTime: "2026-07-17T01:00:00.000Z",
    entryTime: "2026-07-17T01:05:00.000Z",
    exitTime: "2026-07-17T01:12:00.000Z",
    exitPrice: 102,
    exitReason: "take_profit",
    fills: [
      { level: 1, time: "2026-07-17T01:05:00.000Z", price: 100, quantity: 1, notional: 100, fee: 0.1 },
      { level: 2, time: "2026-07-17T01:06:00.000Z", price: 99, quantity: 1.35, notional: 133.65, fee: 0.13 },
      { level: 3, time: "2026-07-17T01:07:00.000Z", price: 98, quantity: 1.82, notional: 178.36, fee: 0.18 },
    ],
    averageEntryPrice: 98.86,
    stopPrice: 95,
    targetPrice: 102,
    quantity: 4.17,
    grossPnl: 8,
    netPnl: 7.4,
    fees: 0.6,
    plannedRisk: 75,
    rMultiple: 0.1,
    holdingMinutes: 7,
  };
}
