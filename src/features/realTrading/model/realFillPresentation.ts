import type { RealFill } from "../../../api/realTrading";

export type RealFillPresentation = {
  oid: string;
  price: string;
  realizedPnl: string;
  realizedPnlTone: "negative" | "positive" | undefined;
  size: string;
  time: string;
};

export function presentRealFill(fill: RealFill): RealFillPresentation {
  return {
    oid: fill.oid ?? "-",
    price: formatFinite(fill.price, 8),
    realizedPnl: formatSigned(fill.closedPnl),
    realizedPnlTone: fill.closedPnl === null || fill.closedPnl === 0
      ? undefined
      : fill.closedPnl > 0 ? "positive" : "negative",
    size: formatFinite(fill.size, 8),
    time: formatTimestamp(fill.timestamp),
  };
}

function formatFinite(value: number | null, maximumFractionDigits: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits })
    : "-";
}

function formatSigned(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const formatted = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 8 });
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : "0";
}

function formatTimestamp(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
