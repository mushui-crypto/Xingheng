export type ManualReconciliationPhase =
  | "idle"
  | "loading"
  | "success"
  | "error"
  | "finalizing";

export type ManualReconciliationState<Report> = {
  scope: string;
  phase: ManualReconciliationPhase;
  requestId: string | null;
  report: Report | null;
  error: string | null;
};

export type ManualReconciliationAction<Report> =
  | { type: "scope_changed"; scope: string }
  | { type: "request_started"; scope: string; requestId: string }
  | { type: "request_succeeded"; scope: string; requestId: string; report: Report }
  | { type: "request_failed"; scope: string; requestId: string; error: string }
  | { type: "finalize_started"; scope: string; requestId: string }
  | { type: "finalize_succeeded"; scope: string; requestId: string; report: Report }
  | { type: "finalize_failed"; scope: string; requestId: string; error: string };

export function createManualReconciliationState<Report>(
  scope: string,
): ManualReconciliationState<Report> {
  return {
    scope,
    phase: "idle",
    requestId: null,
    report: null,
    error: null,
  };
}

export function manualReconciliationReducer<Report>(
  state: ManualReconciliationState<Report>,
  action: ManualReconciliationAction<Report>,
): ManualReconciliationState<Report> {
  if (action.type === "scope_changed") {
    return action.scope === state.scope
      ? state
      : createManualReconciliationState(action.scope);
  }

  if (action.type === "request_started") {
    return {
      scope: action.scope,
      phase: "loading",
      requestId: action.requestId,
      report: null,
      error: null,
    };
  }

  if (action.type === "finalize_started") {
    if (
      action.scope !== state.scope
      || state.phase === "loading"
      || state.phase === "finalizing"
    ) return state;
    return {
      ...state,
      phase: "finalizing",
      requestId: action.requestId,
      report: null,
      error: null,
    };
  }

  if (action.scope !== state.scope || action.requestId !== state.requestId) {
    return state;
  }

  if (action.type === "request_succeeded") {
    return {
      ...state,
      phase: "success",
      report: action.report,
      error: null,
    };
  }

  if (action.type === "request_failed") {
    return {
      ...state,
      phase: "error",
      report: null,
      error: action.error,
    };
  }

  if (action.type === "finalize_succeeded") {
    return {
      ...state,
      phase: "success",
      report: action.report,
      error: null,
    };
  }

  return {
    ...state,
    phase: "error",
    report: null,
    error: action.error,
  };
}

export function canStartManualReconciliation(
  phase: ManualReconciliationPhase,
) {
  return phase !== "loading" && phase !== "finalizing";
}
