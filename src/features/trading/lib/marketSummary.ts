export function formatMarketDayChange(change?: number | null, percent?: number | null) {
  if (typeof change !== "number" || !Number.isFinite(change)) return "-";
  const changeText = `${change >= 0 ? "+" : "-"}${Math.abs(change).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return typeof percent === "number" && Number.isFinite(percent)
    ? `${changeText} / ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`
    : changeText;
}

export function formatCompactMoney(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
}

export function formatFundingPercent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(4)}%` : "-";
}

export function marketNumberTone(value?: number | null): "positive" | "negative" | undefined {
  if (typeof value !== "number" || value === 0) return undefined;
  return value > 0 ? "positive" : "negative";
}

export function multiplyFinite(left?: number | null, right?: number | null) {
  return typeof left === "number" && Number.isFinite(left) && typeof right === "number" && Number.isFinite(right)
    ? left * right
    : null;
}
