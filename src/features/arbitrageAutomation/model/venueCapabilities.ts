import type { AutomationProductAvailability, AutomationVenue, AutomationVenuePhase } from "./controlConsoleTypes";

export type VenueCapabilityInput = {
  venue: AutomationVenue;
  implemented: boolean;
  enabled: boolean;
  phase?: unknown;
  providerWritesEnabled?: unknown;
};

export type VenueCapabilities = {
  phase: AutomationVenuePhase;
  phaseLabel: string;
  canAuthorize: boolean;
  canRunReadOnlyPreflight: boolean;
  canExecute: boolean;
};

export function resolveVenueCapabilities(input: VenueCapabilityInput): VenueCapabilities {
  if (!input.implemented) {
    return {
      phase: "unknown",
      phaseLabel: "暂未接入",
      canAuthorize: false,
      canRunReadOnlyPreflight: false,
      canExecute: false,
    };
  }

  if (
    input.venue === "binance"
    && input.phase === "phase_1_read_only_shadow"
    && input.providerWritesEnabled === false
  ) {
    return {
      phase: "phase_1_read_only_shadow",
      phaseLabel: "只读验证 / Shadow",
      canAuthorize: true,
      canRunReadOnlyPreflight: true,
      canExecute: false,
    };
  }

  if (
    input.venue === "bybit"
    && input.phase === "execution_capable"
    && input.providerWritesEnabled === true
  ) {
    return {
      phase: "execution_capable",
      phaseLabel: input.enabled ? "受控真实执行" : "执行已关闭",
      canAuthorize: true,
      canRunReadOnlyPreflight: true,
      canExecute: true,
    };
  }

  return {
    phase: "unknown",
    phaseLabel: "能力状态未知",
    canAuthorize: false,
    canRunReadOnlyPreflight: false,
    canExecute: false,
  };
}

export function normalizeProductAvailability(value: unknown): AutomationProductAvailability | null {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (Object.keys(raw).length === 0) return null;
  const allowedStatuses: AutomationProductAvailability["status"][] = [
    "available",
    "spot_unavailable",
    "perpetual_unavailable",
    "both_unavailable",
  ];
  const status = typeof raw.status === "string" && allowedStatuses.includes(raw.status as AutomationProductAvailability["status"])
    ? raw.status as AutomationProductAvailability["status"]
    : "unknown";
  return {
    available: raw.available === true && status === "available",
    status,
    spotSymbol: safeString(raw.spotSymbol, 40) || "XAUTUSDT",
    perpetualSymbol: safeString(raw.perpetualSymbol, 40) || "XAUTUSDT",
    checkedAt: typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
    message: safeString(raw.message, 300) || null,
  };
}

function safeString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}
