export function formatStrategyDateTime(value: string | number | null | undefined) {
  const timestamp = typeof value === "number" ? value * 1000 : Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatStrategyPeriod(from: string, through: string | null) {
  return `${formatShortDate(from)} — ${through ? formatShortDate(through) : "观察中"}`;
}

export function formatStrategyMoney(value: number | null | undefined) {
  if (!isFiniteNumber(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatStrategyPrice(value: number | null | undefined) {
  if (!isFiniteNumber(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatStrategyPercent(value: number | null | undefined, digits = 2) {
  if (!isFiniteNumber(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatProfitFactor(value: number | null | undefined, tradeCount: number) {
  if (tradeCount === 0 || !isFiniteNumber(value)) return "—";
  return value.toFixed(3);
}

export function formatAverageR(value: number | null | undefined) {
  if (!isFiniteNumber(value)) return "—";
  return `${value.toFixed(3)}R`;
}

export function strategyNumberTone(value: number | null | undefined) {
  if (!isFiniteNumber(value) || value === 0) return "";
  return value > 0 ? "is-positive" : "is-negative";
}

export function formatExitReason(value: string | null) {
  if (!value) return "—";
  return {
    stop: "止损",
    target: "止盈",
    liquidation: "清算",
    session_close: "时段结束",
    end_of_data: "观察中",
    take_profit: "整组止盈",
    group_stop: "整组止损",
    timeout: "24小时超时",
  }[value] ?? value;
}

function formatShortDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
