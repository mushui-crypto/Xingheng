import { requestJson } from "./httpClient";
import type { StrategyForwardReport } from "../features/strategy/model/types";

export function fetchStrategyForwardReport(signal?: AbortSignal) {
  return requestJson<StrategyForwardReport>(
    "/api/strategy/ict/forward",
    "策略报告暂时无法读取，请稍后再试。",
    {
      init: { signal },
      networkErrorMessage: "策略观察服务暂时不可用。",
      userAuthFailure: true,
    },
  );
}
