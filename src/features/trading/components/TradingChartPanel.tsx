import { RefreshCw } from "lucide-react";
import type { RefObject } from "react";
import type { ApiCandle, ApiTicker } from "../../../api/market";
import type { CandleInterval } from "../../../types";
import type { TradeSymbol } from "../../../types/market";
import { formatPrice } from "../../../utils/price";
import { formatMarketDayChange, marketNumberTone } from "../lib/marketSummary";
import { tradingIntervalLabels, tradingIntervals } from "../model/constants";

export function TradingChartPanel({
  chartContainerRef,
  chartLoading,
  chartMessage,
  dayChange,
  dayChangePercent,
  interval,
  latestCandle,
  marketDataLoading,
  onIntervalChange,
  onRefreshMarketData,
  selectedConfig,
  ticker,
}: {
  chartContainerRef: RefObject<HTMLDivElement | null>;
  chartLoading: boolean;
  chartMessage: string;
  dayChange?: number | null;
  dayChangePercent?: number | null;
  interval: CandleInterval;
  latestCandle: ApiCandle | null;
  marketDataLoading: boolean;
  onIntervalChange: (interval: CandleInterval) => void;
  onRefreshMarketData: () => void;
  selectedConfig: TradeSymbol;
  ticker: ApiTicker;
}) {
  const digits = selectedConfig.digits;
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="xh-real-chart-toolbar">
        <div className="no-scrollbar flex max-w-full overflow-x-auto">
          {tradingIntervals.filter((item) => ["1m", "5m", "15m", "1h", "4h", "8h", "12h", "1d", "1w", "1M"].includes(item)).map((item) => (
            <button
              key={item}
              className={`xh-real-interval ${interval === item ? "is-active" : ""}`}
              onClick={() => onIntervalChange(item)}
              type="button"
            >
              {tradingIntervalLabels[item]}
            </button>
          ))}
        </div>
        <div className="xh-real-live-source">
          <span /> {ticker.source ?? "Hyperliquid"} · WS
          <button aria-label="刷新模拟行情" disabled={marketDataLoading} onClick={onRefreshMarketData} type="button">
            <RefreshCw className={marketDataLoading ? "animate-spin" : ""} size={14} />
          </button>
        </div>
      </div>
      <div className="xh-real-candle-summary">
        <strong>HYPERLIQUID DEMO</strong>
        <span>O&nbsp; {formatPrice(latestCandle?.open, digits)}</span>
        <span>H&nbsp; {formatPrice(latestCandle?.high, digits)}</span>
        <span>L&nbsp; {formatPrice(latestCandle?.low, digits)}</span>
        <span>C&nbsp; {formatPrice(latestCandle?.close, digits)}</span>
        <span>24h&nbsp; <b className={marketNumberTone(dayChange) ? `is-${marketNumberTone(dayChange)}` : ""}>{formatMarketDayChange(dayChange, dayChangePercent)}</b></span>
      </div>
      <div className="xh-real-chart-canvas">
        <div ref={chartContainerRef} className="h-full w-full" />
        {chartLoading || chartMessage ? (
          <div className="pointer-events-none absolute inset-x-4 top-4 border border-line bg-black/85 px-4 py-3 text-[12px] text-muted">
            {chartLoading ? "K线加载中..." : chartMessage}
          </div>
        ) : null}
      </div>
    </section>
  );
}
