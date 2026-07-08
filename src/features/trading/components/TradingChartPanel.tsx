import { Activity } from "lucide-react";
import type { RefObject } from "react";
import { MarketIcon } from "../../../components/trading/MarketIcon";
import { Card } from "../../../components/ui/Card";
import type { CandleInterval } from "../../../types";
import type { TradeSymbol } from "../../../types/market";
import { tradingIntervalLabels, tradingIntervals } from "../model/constants";

export function TradingChartPanel({
  chartContainerRef,
  chartLoading,
  chartMessage,
  interval,
  onIntervalChange,
  selectedConfig,
  symbol,
  themeColor,
}: {
  chartContainerRef: RefObject<HTMLDivElement | null>;
  chartLoading: boolean;
  chartMessage: string;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  selectedConfig: TradeSymbol;
  symbol: string;
  themeColor: string;
}) {
  return (
    <Card className="p-0">
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity size={18} style={{ color: themeColor }} />
          <MarketIcon className="xh-market-row-token" iconUrl={selectedConfig.iconUrl} fallback={selectedConfig.apiSymbol} />
          <span className="font-semibold">{symbol}</span>
          <span className="text-sm text-muted">{selectedConfig.displayName}</span>
        </div>
        <div className="no-scrollbar flex max-w-full overflow-x-auto border border-line bg-black p-1">
          {tradingIntervals.map((item) => (
            <button
              key={item}
              className={`shrink-0 px-2.5 py-1.5 text-sm transition sm:px-3 ${interval === item ? "bg-white text-black" : "text-muted hover:text-white"}`}
              onClick={() => onIntervalChange(item)}
            >
              {tradingIntervalLabels[item]}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <div ref={chartContainerRef} className="h-[320px] w-full sm:h-[420px] lg:h-[460px]" />
        {chartLoading || chartMessage ? (
          <div className="pointer-events-none absolute inset-x-4 top-4 border border-line bg-black/85 px-4 py-3 text-sm text-muted backdrop-blur">
            {chartLoading ? "K线加载中..." : chartMessage}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
