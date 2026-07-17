import type { RealPosition, RealTradingMarginMode } from "../../../api/realTrading";
import { realTradingRiskPolicy } from "./riskPolicy";

export type MarginLeverageSelection = {
  leverage: number;
  marginMode: RealTradingMarginMode;
  maxLeverage: number;
  supportedMarginModes: RealTradingMarginMode[];
};

export type MarginLeverageSessionState = Record<string, Pick<MarginLeverageSelection, "leverage" | "marginMode">>;

const legacyMaxLeverage = realTradingRiskPolicy.maxLeverage;
const defaultLeverage = 5;

export function resolveMarginLeverageSelection({
  marginModeConstraint,
  maxLeverage,
  position,
  sessionSelection,
  supportedMarginModes,
}: {
  marginModeConstraint?: string | null;
  maxLeverage?: number | null;
  position?: RealPosition | null;
  sessionSelection?: Pick<MarginLeverageSelection, "leverage" | "marginMode"> | null;
  supportedMarginModes?: RealTradingMarginMode[] | null;
}): MarginLeverageSelection {
  const modes = normalizeSupportedMarginModes(supportedMarginModes, marginModeConstraint);
  const resolvedMaxLeverage = normalizeMaxLeverage(position?.maxLeverage ?? maxLeverage);
  const preferredMode = normalizeMarginMode(position?.marginMode)
    ?? normalizeMarginMode(sessionSelection?.marginMode);
  const marginMode = preferredMode && modes.includes(preferredMode) ? preferredMode : modes[0];
  const preferredLeverage = validLeverage(position?.leverage)
    ?? validLeverage(sessionSelection?.leverage)
    ?? defaultLeverage;

  return {
    leverage: clampLeverage(preferredLeverage, resolvedMaxLeverage),
    marginMode,
    maxLeverage: resolvedMaxLeverage,
    supportedMarginModes: modes,
  };
}

export function normalizeSupportedMarginModes(
  supportedMarginModes?: RealTradingMarginMode[] | null,
  marginModeConstraint?: string | null,
): RealTradingMarginMode[] {
  const normalizedConstraint = marginModeConstraint?.trim().toLowerCase().replaceAll("-", "_");
  if (["isolated_only", "strictisolated", "strict_isolated", "nocross", "no_cross", "onlyisolated", "only_isolated"].includes(normalizedConstraint ?? "")) {
    return ["isolated"] as RealTradingMarginMode[];
  }

  const supported = supportedMarginModes?.filter((mode, index, modes) => (
    (mode === "cross" || mode === "isolated") && modes.indexOf(mode) === index
  ));
  return supported?.length ? supported : ["cross", "isolated"];
}

export function normalizeMaxLeverage(value?: number | null) {
  const sourceLimit = Number.isFinite(value) && Number(value) >= 1 ? Math.floor(Number(value)) : legacyMaxLeverage;
  return Math.min(sourceLimit, realTradingRiskPolicy.maxLeverage);
}

export function clampLeverage(value: number, maxLeverage: number) {
  const safeMax = normalizeMaxLeverage(maxLeverage);
  if (!Number.isFinite(value)) return Math.min(defaultLeverage, safeMax);
  return Math.min(safeMax, Math.max(1, Math.round(value)));
}

export function marginModeLabel(marginMode: RealTradingMarginMode) {
  return marginMode === "isolated" ? "逐仓" : "全仓";
}

function normalizeMarginMode(value?: string | null): RealTradingMarginMode | null {
  if (value === "cross" || value === "isolated") return value;
  return null;
}

function validLeverage(value?: number | null) {
  return Number.isFinite(value) && Number(value) >= 1 ? Number(value) : null;
}
