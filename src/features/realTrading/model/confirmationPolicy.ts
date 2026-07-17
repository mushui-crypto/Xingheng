export type RealTradingConfirmationAction =
  | "entry"
  | "close"
  | "close_all"
  | "reverse"
  | "margin_leverage"
  | "replace_tpsl"
  | "cancel";

export type RealTradingConfirmationContext = {
  action: RealTradingConfirmationAction;
  hasTpsl?: boolean;
  orderType?: "limit" | "market";
  reduceOnly?: boolean;
};

export type RealTradingSkippableConfirmationContext = {
  orderType: "limit" | "market";
  reduceOnly: boolean;
  tpslEnabled: boolean;
};

// Intentionally module-memory only. A hard refresh reloads the module and restores
// confirmation. Never persist this preference in browser storage.
let skipPlainLimitConfirmationForSession = false;

export function canSkipConfirmationForSession(context: RealTradingConfirmationContext) {
  return context.action === "entry"
    && context.orderType === "limit"
    && !context.reduceOnly
    && !context.hasTpsl;
}

export function canSkipRealTradingConfirmationForSession(context: RealTradingSkippableConfirmationContext) {
  return canSkipConfirmationForSession({
    action: "entry",
    hasTpsl: context.tpslEnabled,
    orderType: context.orderType,
    reduceOnly: context.reduceOnly,
  });
}

export function requiresRealTradingConfirmation(context: RealTradingConfirmationContext) {
  if (!canSkipConfirmationForSession(context)) return true;
  return !skipPlainLimitConfirmationForSession;
}

export function setSkipPlainLimitConfirmationForSession(skip: boolean) {
  skipPlainLimitConfirmationForSession = skip;
}

export function resetRealTradingConfirmationSessionForTest() {
  skipPlainLimitConfirmationForSession = false;
}
