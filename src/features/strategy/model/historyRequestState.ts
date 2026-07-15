import type { StrategyHistoryReport } from "./types";

export type StrategyHistoryRequestState = {
  report: StrategyHistoryReport | null;
  loading: boolean;
  error: string;
};

export type StrategyHistoryRequestAction =
  | { type: "start" }
  | { type: "success"; report: StrategyHistoryReport }
  | { type: "failure"; message: string };

export const initialStrategyHistoryRequestState: StrategyHistoryRequestState = {
  report: null,
  loading: false,
  error: "",
};

export function strategyHistoryRequestReducer(
  state: StrategyHistoryRequestState,
  action: StrategyHistoryRequestAction,
): StrategyHistoryRequestState {
  switch (action.type) {
    case "start":
      return { report: null, loading: true, error: "" };
    case "success":
      return { report: action.report, loading: false, error: "" };
    case "failure":
      return { report: null, loading: false, error: action.message };
    default:
      return state;
  }
}
