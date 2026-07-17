import type { StrategyCandleInterval, StrategyForwardTrade } from "../model/types";

export const strategyChartIntervals: StrategyCandleInterval[] = ["5m", "15m", "1h", "4h"];
export const strategyChartCandleLimit = 300;

const intervalSeconds: Record<StrategyCandleInterval, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
};

export type StrategyTradeMarkerEvent = {
  id: string;
  tradeKey: string;
  kind: "entry" | "add" | "exit";
  side: "long" | "short";
  bucketTime: number;
  exactTime: string;
  price: number;
  label: string;
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  detail: {
    contextLabel: string;
    groupId: string | null;
    level: number | null;
    quantity: number | null;
    fee: number | null;
    netPnl: number | null;
    exitReason: string | null;
  };
};

export function strategyIntervalSeconds(interval: StrategyCandleInterval) {
  return intervalSeconds[interval];
}

export function bucketStrategyTradeTime(value: string, interval: StrategyCandleInterval) {
  const seconds = Date.parse(value) / 1000;
  if (!Number.isFinite(seconds)) return null;
  const step = intervalSeconds[interval];
  return Math.floor(seconds / step) * step;
}

export function strategyTradeKey(trade: StrategyForwardTrade) {
  return [trade.side ?? "side", trade.signalTime ?? "signal", trade.entryTime ?? "entry", trade.exitTime ?? "open"].join(":");
}

export function buildStrategyTradeMarkerEvents(
  trades: StrategyForwardTrade[],
  interval: StrategyCandleInterval,
) {
  const events: StrategyTradeMarkerEvent[] = [];
  for (const trade of trades) {
    if (trade.side !== "long" && trade.side !== "short") continue;
    const tradeKey = strategyTradeKey(trade);
    const entryBucket = trade.entryTime ? bucketStrategyTradeTime(trade.entryTime, interval) : null;
    if (entryBucket !== null && trade.entryTime && isPositiveNumber(trade.entryPrice)) {
      events.push({
        id: `${tradeKey}:entry`,
        tradeKey,
        kind: "entry",
        side: trade.side,
        bucketTime: entryBucket,
        exactTime: trade.entryTime,
        price: trade.entryPrice,
        label: trade.side === "long" ? "多开" : "空开",
        position: trade.side === "long" ? "belowBar" : "aboveBar",
        shape: trade.side === "long" ? "arrowUp" : "arrowDown",
        color: trade.side === "long" ? "#00C896" : "#FF667F",
        detail: {
          contextLabel: trade.side === "long" ? "做多交易" : "做空交易",
          groupId: null,
          level: null,
          quantity: trade.quantity,
          fee: trade.fees,
          netPnl: trade.netPnl,
          exitReason: null,
        },
      });
    }
    const exitBucket = trade.exitTime ? bucketStrategyTradeTime(trade.exitTime, interval) : null;
    if (exitBucket !== null && trade.exitTime && isPositiveNumber(trade.exitPrice)) {
      events.push({
        id: `${tradeKey}:exit`,
        tradeKey,
        kind: "exit",
        side: trade.side,
        bucketTime: exitBucket,
        exactTime: trade.exitTime,
        price: trade.exitPrice,
        label: trade.side === "long" ? "平多" : "平空",
        position: trade.side === "long" ? "aboveBar" : "belowBar",
        shape: "square",
        color: trade.side === "long" ? "#FF667F" : "#00C896",
        detail: {
          contextLabel: trade.side === "long" ? "做多交易" : "做空交易",
          groupId: null,
          level: null,
          quantity: trade.quantity,
          fee: trade.fees,
          netPnl: trade.netPnl,
          exitReason: trade.exitReason,
        },
      });
    }
  }
  return events.sort(compareMarkerEvents);
}

export function resolveStrategyChartCenter(
  focusTrade: StrategyForwardTrade | null,
  fallbackTime: string | null,
) {
  return validIso(focusTrade?.entryTime) ?? validIso(fallbackTime) ?? new Date().toISOString();
}

export function calculateStrategyCandleWindow(
  centerTime: string,
  interval: StrategyCandleInterval,
  limit = strategyChartCandleLimit,
) {
  const step = intervalSeconds[interval];
  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const parsedCenter = Date.parse(centerTime) / 1000;
  const center = Number.isFinite(parsedCenter) ? Math.floor(parsedCenter / step) * step : Math.floor(Date.now() / 1000 / step) * step;
  const before = Math.floor((safeLimit - 1) * 0.6);
  const after = safeLimit - 1 - before;
  return {
    from: new Date((center - before * step) * 1000).toISOString(),
    to: new Date((center + after * step) * 1000).toISOString(),
    limit: safeLimit,
    focusBucketTime: center,
  };
}

function compareMarkerEvents(left: StrategyTradeMarkerEvent, right: StrategyTradeMarkerEvent) {
  return left.bucketTime - right.bucketTime
    || Date.parse(left.exactTime) - Date.parse(right.exactTime)
    || markerKindOrder(left.kind) - markerKindOrder(right.kind)
    || left.id.localeCompare(right.id);
}

function markerKindOrder(kind: StrategyTradeMarkerEvent["kind"]) {
  return kind === "entry" ? 0 : kind === "add" ? 1 : 2;
}

function validIso(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function isPositiveNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
