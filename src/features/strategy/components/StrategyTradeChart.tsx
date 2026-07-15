import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchStrategyCandles } from "../../../api/strategy";
import type {
  StrategyCandle,
  StrategyCandleInterval,
  StrategyForwardTrade,
} from "../model/types";
import {
  buildStrategyTradeMarkerEvents,
  calculateStrategyCandleWindow,
  resolveStrategyChartCenter,
  strategyChartIntervals,
  strategyTradeKey,
  type StrategyTradeMarkerEvent,
} from "../lib/tradeChart";
import {
  formatExitReason,
  formatStrategyDateTime,
  formatStrategyMoney,
  formatStrategyPrice,
  strategyNumberTone,
} from "../lib/formatters";

export type StrategyChartContextState = "loading" | "ready" | "unavailable";

export type StrategyChartFocusRequest = {
  trade: StrategyForwardTrade;
  revision: number;
} | null;

type StrategyTradeChartProps = {
  mode: "forward" | "history";
  contextState: StrategyChartContextState;
  trades: StrategyForwardTrade[];
  fallbackTime: string | null;
  focusRequest: StrategyChartFocusRequest;
};

type ChartLoadState = "idle" | "loading" | "ready" | "empty" | "error";

export function StrategyTradeChart({ contextState, fallbackTime, focusRequest, mode, trades }: StrategyTradeChartProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const markerEventMapRef = useRef(new Map<string, StrategyTradeMarkerEvent>());
  const candleMapRef = useRef(new Map<number, StrategyCandle>());
  const [interval, setInterval] = useState<StrategyCandleInterval>("5m");
  const [loadState, setLoadState] = useState<ChartLoadState>("idle");
  const [error, setError] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [activeCandle, setActiveCandle] = useState<StrategyCandle | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<StrategyTradeMarkerEvent | null>(null);
  const [visibleMarkerCount, setVisibleMarkerCount] = useState(0);
  const tradeSignature = useMemo(() => JSON.stringify(trades), [trades]);
  const focusTrade = focusRequest?.trade ?? null;
  const centerTime = resolveStrategyChartCenter(focusTrade, fallbackTime);
  const markerEvents = useMemo(
    () => buildStrategyTradeMarkerEvents(trades, interval),
    [interval, tradeSignature],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      width: container.clientWidth || 900,
      height: container.clientHeight || 420,
      layout: { background: { color: "#07090d" }, textColor: "#8f99a5", fontFamily: "Inter, system-ui, sans-serif" },
      grid: { vertLines: { color: "#171b21" }, horzLines: { color: "#171b21" } },
      rightPriceScale: { borderColor: "#25282f", scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: "#25282f", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: 1, vertLine: { color: "#59616c" }, horzLine: { color: "#59616c" } },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00C896",
      borderUpColor: "#00C896",
      wickUpColor: "#00C896",
      downColor: "#FF667F",
      borderDownColor: "#FF667F",
      wickDownColor: "#FF667F",
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
    });
    const markers = createSeriesMarkers(series, [], { autoScale: true, zOrder: "top" });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;

    const handleCrosshairMove = (params: MouseEventParams) => {
      const value = params.seriesData.get(series);
      if (value && "open" in value && "high" in value && "low" in value && "close" in value) {
        const sourceCandle = candleMapRef.current.get(Number(value.time));
        setActiveCandle(sourceCandle ?? {
          time: Number(value.time),
          open: value.open,
          high: value.high,
          low: value.low,
          close: value.close,
          volume: 0,
        });
      }
    };
    const handleClick = (params: MouseEventParams) => {
      const objectId = params.hoveredInfo?.objectId ?? params.hoveredObjectId;
      if (typeof objectId !== "string") return;
      const event = markerEventMapRef.current.get(objectId);
      if (event) setSelectedEvent(event);
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.subscribeClick(handleClick);

    const resizeObserver = new ResizeObserver(([entry]) => {
      const { height, width } = entry.contentRect;
      if (height > 0 && width > 0) chart.applyOptions({ height, width });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.unsubscribeClick(handleClick);
      markers.detach();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      candleMapRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (contextState !== "ready") {
      seriesRef.current?.setData([]);
      markersRef.current?.setMarkers([]);
      markerEventMapRef.current.clear();
      candleMapRef.current.clear();
      setVisibleMarkerCount(0);
      setSelectedEvent(null);
      setActiveCandle(null);
      setLoadState(contextState === "loading" ? "loading" : "idle");
      setError("");
      return;
    }

    const controller = new AbortController();
    const requestWindow = calculateStrategyCandleWindow(centerTime, interval);
    setLoadState("loading");
    setError("");
    setSelectedEvent(null);
    void fetchStrategyCandles({
      interval,
      from: requestWindow.from,
      to: requestWindow.to,
      limit: requestWindow.limit,
    }, controller.signal)
      .then((report) => {
        if (controller.signal.aborted) return;
        if (report.status !== "available") {
          seriesRef.current?.setData([]);
          markersRef.current?.setMarkers([]);
          markerEventMapRef.current.clear();
          candleMapRef.current.clear();
          setVisibleMarkerCount(0);
          setActiveCandle(null);
          setLoadState("error");
          setError("Binance 策略K线当前不可用。");
          return;
        }
        const candles = normalizeCandles(report.candles);
        if (!candles.length) {
          seriesRef.current?.setData([]);
          markersRef.current?.setMarkers([]);
          markerEventMapRef.current.clear();
          candleMapRef.current.clear();
          setVisibleMarkerCount(0);
          setActiveCandle(null);
          setLoadState("empty");
          return;
        }
        const chartData = candles.map(toChartCandle);
        candleMapRef.current = new Map(candles.map((candle) => [candle.time, candle]));
        seriesRef.current?.setData(chartData);
        setActiveCandle(candles.at(-1) ?? null);

        const candleTimes = new Set(candles.map((candle) => candle.time));
        const visibleEvents = markerEvents.filter((event) => candleTimes.has(event.bucketTime));
        markerEventMapRef.current = new Map(visibleEvents.map((event) => [event.id, event]));
        markersRef.current?.setMarkers(visibleEvents.map(toSeriesMarker));
        setVisibleMarkerCount(visibleEvents.length);
        setLoadState("ready");

        const selectedEntryId = focusTrade ? `${strategyTradeKey(focusTrade)}:entry` : null;
        setSelectedEvent(selectedEntryId ? markerEventMapRef.current.get(selectedEntryId) ?? null : null);
        positionChart(chartRef.current, candles, requestWindow.focusBucketTime, Boolean(focusTrade));
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        seriesRef.current?.setData([]);
        markersRef.current?.setMarkers([]);
        markerEventMapRef.current.clear();
        candleMapRef.current.clear();
        setVisibleMarkerCount(0);
        setActiveCandle(null);
        setLoadState("error");
        setError(reason instanceof Error ? reason.message : "策略K线加载失败。");
      });

    return () => controller.abort();
  }, [centerTime, contextState, focusRequest?.revision, interval, markerEvents, retryRevision]);

  useEffect(() => {
    if (!focusRequest) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rootRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }, [focusRequest?.revision]);

  const stateMessage = contextState === "unavailable"
    ? "等待当前策略报告，K线与交易标记暂不可用。"
    : loadState === "empty"
      ? "当前窗口没有已收盘K线。"
      : loadState === "error"
        ? error
        : "";

  return (
    <section ref={rootRef} className="xh-strategy-panel xh-strategy-trade-chart" aria-labelledby={`strategy-chart-title-${mode}`}>
      <div className="xh-strategy-chart-header">
        <div>
          <h2 id={`strategy-chart-title-${mode}`}>策略交易K线</h2>
          <p>Binance USD-M · BTCUSDT · Paper only / 自动下单关闭</p>
        </div>
        <div className="xh-strategy-chart-intervals" role="group" aria-label="K线周期">
          {strategyChartIntervals.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={interval === item}
              className={interval === item ? "is-active" : ""}
              onClick={() => setInterval(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="xh-strategy-chart-ohlc" aria-live="polite">
        <span>{activeCandle ? formatChartTime(activeCandle.time) : "—"}</span>
        <span>O <strong>{formatStrategyPrice(activeCandle?.open ?? null)}</strong></span>
        <span>H <strong>{formatStrategyPrice(activeCandle?.high ?? null)}</strong></span>
        <span>L <strong>{formatStrategyPrice(activeCandle?.low ?? null)}</strong></span>
        <span>C <strong>{formatStrategyPrice(activeCandle?.close ?? null)}</strong></span>
        <span>VOL <strong>{formatVolume(activeCandle?.volume ?? null)}</strong></span>
      </div>

      <div className="xh-strategy-chart-stage">
        <div ref={containerRef} className="xh-strategy-chart-canvas" aria-label={`${interval} BTCUSDT K线图`} />
        {contextState === "loading" || loadState === "loading" ? <div className="xh-strategy-chart-skeleton" aria-label="策略K线加载中" aria-busy="true"><span /><span /><span /></div> : null}
        {stateMessage ? (
          <div className="xh-strategy-chart-state" role={loadState === "error" ? "alert" : "status"}>
            <p>{stateMessage}</p>
            {contextState === "ready" && (loadState === "error" || loadState === "empty") ? <button type="button" onClick={() => setRetryRevision((value) => value + 1)}>重试</button> : null}
          </div>
        ) : null}
      </div>

      <div className="xh-strategy-chart-marker-status" role="status">
        {loadState !== "ready"
          ? "等待K线与交易标记数据。"
          : trades.length === 0
          ? "当前报告暂无可标记交易。"
          : visibleMarkerCount === 0
            ? "当前K线窗口未包含交易标记，可点击下方交易记录定位。"
            : `当前窗口 ${visibleMarkerCount} 个开平仓标记。点击标记查看详情。`}
      </div>
      <StrategyMarkerDetail event={selectedEvent} />
    </section>
  );
}

function StrategyMarkerDetail({ event }: { event: StrategyTradeMarkerEvent | null }) {
  if (!event) {
    return <div className="xh-strategy-marker-empty">点击开平仓标记或下方交易记录查看执行详情。</div>;
  }
  return (
    <div className="xh-strategy-marker-detail" aria-live="polite">
      <div className="xh-strategy-marker-detail-title">
        <strong>{event.kind === "exit" ? `× ${event.label}` : event.label}</strong>
        <span>{event.side === "long" ? "做多交易" : "做空交易"}</span>
      </div>
      <dl>
        <Detail label="成交时间" value={formatStrategyDateTime(event.exactTime)} />
        <Detail label="成交价格" value={formatStrategyPrice(event.price)} />
        <Detail label="数量" value={formatQuantity(event.trade.quantity)} />
        <Detail label="交易净盈亏" value={formatNullableMoney(event.trade.netPnl)} tone={strategyNumberTone(event.trade.netPnl)} />
        <Detail label="手续费" value={formatFee(event.trade.fees)} />
        <Detail label="退出原因" value={event.kind === "exit" ? formatExitReason(event.trade.exitReason) : "—"} />
      </dl>
    </div>
  );
}

function Detail({ label, tone = "", value }: { label: string; tone?: string; value: string }) {
  return <div><dt>{label}</dt><dd className={tone}>{value}</dd></div>;
}

function normalizeCandles(candles: StrategyCandle[]) {
  return [...new Map(candles
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .map((candle) => [candle.time, candle])).values()]
    .sort((left, right) => left.time - right.time);
}

function toChartCandle(candle: StrategyCandle): CandlestickData<UTCTimestamp> {
  return {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function toSeriesMarker(event: StrategyTradeMarkerEvent): SeriesMarker<Time> {
  return {
    id: event.id,
    time: event.bucketTime as UTCTimestamp,
    position: event.position,
    shape: event.shape,
    color: event.color,
    text: event.kind === "exit" ? `× ${event.label}` : event.label,
    size: event.kind === "entry" ? 1.4 : 1.1,
  };
}

function positionChart(chart: IChartApi | null, candles: StrategyCandle[], focusBucketTime: number, focused: boolean) {
  if (!chart || !candles.length) return;
  if (!focused) {
    chart.timeScale().fitContent();
    return;
  }
  const index = candles.findIndex((candle) => candle.time >= focusBucketTime);
  if (index < 0) {
    chart.timeScale().fitContent();
    return;
  }
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, index - 60),
    to: Math.min(candles.length - 1, index + 40),
  });
}

function formatChartTime(time: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(time * 1000));
}

function formatVolume(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatQuantity(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatNullableMoney(value: number | null) {
  return value === null ? "—" : formatStrategyMoney(value);
}

function formatFee(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
