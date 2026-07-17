import type { MartingaleForwardReport } from "./martingaleTypes";

export type MartingaleRequestState = {
  report: MartingaleForwardReport | null;
  loading: boolean;
  error: string;
};

export type MartingaleRequestAction =
  | { type: "start" }
  | { type: "success"; report: MartingaleForwardReport }
  | { type: "failure"; message: string };

export const initialMartingaleRequestState: MartingaleRequestState = {
  report: null,
  loading: true,
  error: "",
};

export function martingaleRequestReducer(
  _state: MartingaleRequestState,
  action: MartingaleRequestAction,
): MartingaleRequestState {
  if (action.type === "start") return { report: null, loading: true, error: "" };
  if (action.type === "success") return { report: action.report, loading: false, error: "" };
  return { report: null, loading: false, error: action.message };
}
