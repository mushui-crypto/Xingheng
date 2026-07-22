import type { NeutralAutomationStatus } from "../features/admin/arbitrage/model/types";
import { adminHeaders, requestJson } from "./httpClient";

export function fetchNeutralAutomationStatus(signal?: AbortSignal) {
  return requestJson<NeutralAutomationStatus>(
    "/api/admin/arbitrage/neutral-automation",
    "RWA Shadow 状态加载失败。",
    {
      init: { headers: adminHeaders(), cache: "no-store", signal },
    },
  );
}
