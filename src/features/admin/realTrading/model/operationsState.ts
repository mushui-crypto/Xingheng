import type { AdminRealTradingOperations } from "../../../../api/realTrading";

export type AdminRealTradingOperationsState = {
  error: string;
  loading: boolean;
  report: AdminRealTradingOperations | null;
};

export type AdminRealTradingOperationsAction =
  | { type: "started" }
  | { type: "succeeded"; report: AdminRealTradingOperations }
  | { type: "failed"; error: string };

export const initialAdminRealTradingOperationsState: AdminRealTradingOperationsState = {
  error: "",
  loading: true,
  report: null,
};

export function adminRealTradingOperationsReducer(
  state: AdminRealTradingOperationsState,
  action: AdminRealTradingOperationsAction,
): AdminRealTradingOperationsState {
  if (action.type === "started") return { error: "", loading: true, report: null };
  if (action.type === "succeeded") return { error: "", loading: false, report: action.report };
  return { error: action.error, loading: false, report: null };
}
