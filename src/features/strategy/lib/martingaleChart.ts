import type {
  MartingaleCompletedGroup,
  MartingaleFill,
  MartingaleGroup,
} from "../model/martingaleTypes";
import type { StrategyCandleInterval } from "../model/types";
import {
  bucketStrategyTradeTime,
  type StrategyTradeMarkerEvent,
} from "./tradeChart";

export function martingaleGroupKey(group: MartingaleGroup) {
  return group.id ?? [group.symbol ?? "symbol", group.side ?? "side", group.entryTime ?? "entry"].join(":");
}

export function martingaleFillMarkerId(group: MartingaleGroup, fill: MartingaleFill, index: number) {
  return `${martingaleGroupKey(group)}:fill:${fill.level ?? index + 1}:${fill.time ?? "time"}`;
}

export function martingaleExitMarkerId(group: MartingaleCompletedGroup) {
  return `${martingaleGroupKey(group)}:exit:${group.exitTime ?? "time"}`;
}

export function buildMartingaleMarkerEvents(
  groups: MartingaleGroup[],
  interval: StrategyCandleInterval,
) {
  const events: StrategyTradeMarkerEvent[] = [];
  for (const group of groups) {
    if (group.side !== "long" && group.side !== "short") continue;
    const side = group.side;
    const groupKey = martingaleGroupKey(group);
    group.fills.forEach((fill, index) => {
      const bucketTime = fill.time ? bucketStrategyTradeTime(fill.time, interval) : null;
      if (bucketTime === null || !fill.time || !isPositiveNumber(fill.price)) return;
      const level = positiveLevel(fill.level, index + 1);
      const entry = index === 0;
      events.push({
        id: martingaleFillMarkerId(group, fill, index),
        tradeKey: groupKey,
        kind: entry ? "entry" : "add",
        side,
        bucketTime,
        exactTime: fill.time,
        price: fill.price,
        label: entry
          ? side === "long" ? "多开" : "空开"
          : side === "long" ? `加多${level}` : `加空${level}`,
        position: side === "long" ? "belowBar" : "aboveBar",
        shape: entry ? side === "long" ? "arrowUp" : "arrowDown" : "circle",
        color: side === "long" ? "#00C896" : "#FF667F",
        detail: {
          contextLabel: side === "long" ? "做多网格组" : "做空网格组",
          groupId: group.id,
          level,
          quantity: fill.quantity,
          fee: fill.fee,
          netPnl: null,
          exitReason: null,
        },
      });
    });
    if (!isCompletedGroup(group)) continue;
    const exitBucket = group.exitTime ? bucketStrategyTradeTime(group.exitTime, interval) : null;
    if (exitBucket === null || !group.exitTime || !isPositiveNumber(group.exitPrice)) continue;
    events.push({
      id: martingaleExitMarkerId(group),
      tradeKey: groupKey,
      kind: "exit",
      side: group.side,
      bucketTime: exitBucket,
      exactTime: group.exitTime,
      price: group.exitPrice,
      label: group.side === "long" ? "平多" : "平空",
      position: group.side === "long" ? "aboveBar" : "belowBar",
      shape: "square",
      color: group.netPnl !== null && group.netPnl < 0 ? "#FF667F" : "#00C896",
      detail: {
        contextLabel: group.side === "long" ? "做多网格组" : "做空网格组",
        groupId: group.id,
        level: null,
        quantity: group.quantity,
        fee: group.fees,
        netPnl: group.netPnl,
        exitReason: group.exitReason,
      },
    });
  }
  return events.sort(compareEvents);
}

export function isCompletedGroup(group: MartingaleGroup): group is MartingaleCompletedGroup {
  return "exitTime" in group;
}

function positiveLevel(value: number | null, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function isPositiveNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function compareEvents(left: StrategyTradeMarkerEvent, right: StrategyTradeMarkerEvent) {
  return left.bucketTime - right.bucketTime
    || Date.parse(left.exactTime) - Date.parse(right.exactTime)
    || eventOrder(left.kind) - eventOrder(right.kind)
    || (left.detail.level ?? Number.MAX_SAFE_INTEGER) - (right.detail.level ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id);
}

function eventOrder(kind: StrategyTradeMarkerEvent["kind"]) {
  return kind === "entry" ? 0 : kind === "add" ? 1 : 2;
}
