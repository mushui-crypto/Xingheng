import { requestJson } from "./httpClient";
import type {
  StrategyCandlesQuery,
  StrategyCandlesReport,
  StrategyForwardReport,
  StrategyHistoryQuery,
  StrategyHistoryReport,
} from "../features/strategy/model/types";
import type {
  MartingaleCandlesQuery,
  MartingaleCandlesReport,
  MartingaleForwardReport,
} from "../features/strategy/model/martingaleTypes";

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

export function fetchStrategyHistoryReport(query: StrategyHistoryQuery, signal?: AbortSignal) {
  const search = new URLSearchParams();
  if (query.from) search.set("from", query.from);
  if (query.to) search.set("to", query.to);
  if (query.limit) search.set("limit", String(query.limit));
  if (query.cursor) search.set("cursor", query.cursor);
  const suffix = search.size ? `?${search.toString()}` : "";
  return requestJson<StrategyHistoryReport>(
    `/api/strategy/ict/history${suffix}`,
    "历史回测报告暂时无法读取，请稍后再试。",
    {
      init: { signal },
      networkErrorMessage: "历史回测服务暂时不可用。",
      userAuthFailure: true,
    },
  );
}

export function fetchStrategyCandles(query: StrategyCandlesQuery, signal?: AbortSignal) {
  const search = new URLSearchParams({
    interval: query.interval,
    from: query.from,
    to: query.to,
  });
  if (query.limit) search.set("limit", String(query.limit));
  return requestJson<StrategyCandlesReport>(
    `/api/strategy/ict/candles?${search.toString()}`,
    "策略K线暂时无法读取，请稍后再试。",
    {
      init: { signal },
      networkErrorMessage: "策略K线服务暂时不可用。",
      userAuthFailure: true,
    },
  );
}

export function fetchMartingaleForwardReport(signal?: AbortSignal) {
  return requestJson<MartingaleForwardReport>(
    "/api/strategy/martingale/forward",
    "马丁网格 Paper 报告暂时无法读取，请稍后再试。",
    {
      init: { signal },
      networkErrorMessage: "马丁网格 Paper 服务暂时不可用。",
      userAuthFailure: true,
    },
  );
}

export function fetchMartingaleCandles(query: MartingaleCandlesQuery, signal?: AbortSignal) {
  const search = new URLSearchParams({
    symbol: query.symbol,
    interval: query.interval,
    from: query.from,
    to: query.to,
  });
  if (query.limit) search.set("limit", String(query.limit));
  return requestJson<MartingaleCandlesReport>(
    `/api/strategy/martingale/candles?${search.toString()}`,
    "马丁网格策略K线暂时无法读取，请稍后再试。",
    {
      init: { signal },
      networkErrorMessage: "马丁网格策略K线服务暂时不可用。",
      userAuthFailure: true,
    },
  );
}
