import type { ArbitrageDashboardSnapshot, ArbitrageHorizon } from "../features/arbitrage/model/types";
import { requestJson } from "./httpClient";

export function fetchArbitrageDashboard(horizonDays: ArbitrageHorizon, forceRefresh = false) {
  const params = new URLSearchParams({ horizonDays: String(horizonDays) });
  if (forceRefresh) params.set("refresh", "1");
  return requestJson<ArbitrageDashboardSnapshot>(
    `/api/arbitrage/dashboard?${params.toString()}`,
    "套利看板加载失败。",
    { networkErrorMessage: "无法连接套利行情服务。" },
  );
}
