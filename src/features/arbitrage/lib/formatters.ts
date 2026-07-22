export function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function formatApr(value: number | null, signed = false) {
  if (value === null || !Number.isFinite(value)) return "-";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

export function formatFundingRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  const percentage = value * 100;
  const prefix = percentage > 0 ? "+" : "";
  return `${prefix}${percentage.toFixed(4)}%`;
}

export function formatFundingCountdown(nextFundingTime: number | null, now: number) {
  if (nextFundingTime === null || !Number.isFinite(nextFundingTime)) return "结算时间待更新";
  const remainingSeconds = Math.floor((nextFundingTime - now) / 1000);
  if (remainingSeconds <= 0) return "等待结算更新";
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return `距结算 ${padTime(hours)}:${padTime(minutes)}:${padTime(seconds)}`;
}

export function calculateEquivalentApy(netApr: number | null, holdingDays: number) {
  if (netApr === null || !Number.isFinite(netApr) || holdingDays <= 0) return null;
  const periodGrowth = 1 + (netApr / 100) * (holdingDays / 365);
  if (periodGrowth <= 0) return null;
  return (Math.pow(periodGrowth, 365 / holdingDays) - 1) * 100;
}

export function equivalentNetYield(netApr: number | null, holdingDays: number, metric: "apr" | "apy") {
  return metric === "apy" ? calculateEquivalentApy(netApr, holdingDays) : netApr;
}

export function formatBps(value: number | null, signed = false) {
  if (value === null || !Number.isFinite(value)) return "-";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)} bps`;
}

export function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

export function formatRatio(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function padTime(value: number) {
  return String(value).padStart(2, "0");
}
