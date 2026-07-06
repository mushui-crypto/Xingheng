import { currentSimulationAccountKey } from "../model/constants";

export function readCurrentSimulationAccountId() {
  try {
    return window.localStorage.getItem(currentSimulationAccountKey) ?? "";
  } catch {
    return "";
  }
}

export function formatAccountMoney(value: number | undefined, currency: string) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} ${currency}` : "-";
}

export function formatSignedAccountMoney(value: number | undefined, currency: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(2)} ${currency}`;
}

export function getSignedTone(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) {
    return "neutral" as const;
  }
  return value > 0 ? "positive" as const : "negative" as const;
}

export function shortSimulationId(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 7)}...${value.slice(-4)}`;
}
