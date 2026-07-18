import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card } from "../../components/ui/Card";
import { MarketSymbolPicker } from "../../components/trading/MarketSymbolPicker";
import {
  closePosition,
  fetchCandles,
  fetchMarketOrderbook,
  fetchMarketSummary,
  fetchMarketTrades,
  fetchMarketSymbols,
  fetchOrders,
  fetchPositions,
  fetchTicker,
  fetchTradingAccount,
  placeMarketOrder,
  type ApiCandle,
  type ApiMarketOrderbook,
  type ApiMarketSummary,
  type ApiMarketTrade,
  type ApiTicker,
  type OrderRecord,
  type PositionView,
  type TradingAccount,
} from "../../api/market";
import { fetchSimulationAccounts, type SimulationAccountView } from "../../api/walletApi";
import { useSymbolStore } from "../../store/symbolStore";
import type { CandleInterval } from "../../types";
import { formatPrice } from "../../utils/price";
import { normalizeQuantity } from "../../utils/quantity";
import { SimulationAccountContextPanel } from "../../features/trading/components/SimulationAccountContextPanel";
import { TradingChartPanel } from "../../features/trading/components/TradingChartPanel";
import { MarketDepthPanel } from "../../features/trading/components/MarketDepthPanel";
import { TradeStat } from "../../features/trading/components/TradeStat";
import { TradingOrderPanel } from "../../features/trading/components/TradingOrderPanel";
import { TradingRecords } from "../../features/trading/components/TradingRecords";
import { Toast } from "../../features/trading/components/TradingFeedback";
import { getChartPriceFormat, isValidCandle, normalizeChartCandles, toChartCandle } from "../../features/trading/lib/chart";
import { formatCompactMoney, formatFundingPercent, formatMarketDayChange, marketNumberTone, multiplyFinite } from "../../features/trading/lib/marketSummary";
import { readCurrentSimulationAccountId, shortSimulationId } from "../../features/trading/lib/simulationAccount";
import { mergeTradingSearchParams } from "../../features/trading/lib/tradingSearchParams";
import { currentSimulationAccountKey } from "../../features/trading/model/constants";

export function TradingPage() {
  const themeColor = "#00C896";
  const currency = "USDT";
  const allSymbols = useSymbolStore((state) => state.symbols);
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const symbols = useMemo(() => allSymbols.filter((item) => item.isVisible), [allSymbols]);
  const symbolConfigKey = useMemo(
    () =>
      JSON.stringify(
        symbols.map(({ quoteStatus: _quoteStatus, createdAt: _createdAt, updatedAt: _updatedAt, ...config }) => config),
      ),
    [symbols],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSymbol = searchParams.get("symbol")?.toUpperCase() ?? symbols[0]?.symbol ?? "BTCUSDT";
  const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol);
  const selectedConfig = symbols.find((item) => item.symbol === selectedSymbol) ?? symbols[0];
  const symbol = selectedConfig?.symbol ?? selectedSymbol;
  const digits = selectedConfig?.digits ?? 2;
  const [interval, setIntervalValue] = useState<CandleInterval>("1m");
  const [ticker, setTicker] = useState<ApiTicker>({ symbol, status: "disconnected" });
  const [marketSummary, setMarketSummary] = useState<ApiMarketSummary | null>(null);
  const [orderbook, setOrderbook] = useState<ApiMarketOrderbook | null>(null);
  const [marketTrades, setMarketTrades] = useState<ApiMarketTrade[]>([]);
  const [marketDataError, setMarketDataError] = useState("");
  const [marketDataLoading, setMarketDataLoading] = useState(true);
  const [account, setAccount] = useState<TradingAccount | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [simulationAccounts, setSimulationAccounts] = useState<SimulationAccountView[]>([]);
  const [simulationAccountsLoading, setSimulationAccountsLoading] = useState(true);
  const [selectedSimulationAccountId, setSelectedSimulationAccountId] = useState(searchParams.get("simulationAccountId") ?? readCurrentSimulationAccountId());
  const [volume, setVolume] = useState(selectedConfig?.minLot ?? 0.01);
  const [message, setMessage] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [chartMessage, setChartMessage] = useState("");
  const [chartLoading, setChartLoading] = useState(true);
  const [latestCandle, setLatestCandle] = useState<ApiCandle | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const closingPositionIdRef = useRef<string | null>(null);
  const initialSimulationAccountIdRef = useRef(searchParams.get("simulationAccountId") ?? "");
  const marketDataRequestRef = useRef(0);
  const switchToastShownRef = useRef(false);

  const statusText = ticker.status === "connected" ? "实时行情" : ticker.status === "stale" ? "行情延迟" : "行情连接中断";
  const selectedSimulationAccount = simulationAccounts.find((item) => item.id === selectedSimulationAccountId) ?? null;
  const hasSimulationAccounts = simulationAccounts.length > 0;
  const needsSimulationAccount = !selectedSimulationAccountId || !selectedSimulationAccount;
  const orderDisabled =
    simulationAccountsLoading ||
    needsSimulationAccount ||
    ticker.status !== "connected" ||
    !ticker.bid ||
    !ticker.ask ||
    selectedConfig?.tradeStatus !== "enabled";

  const wsUrl = useMemo(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }, []);

  const loadMarketData = async (targetSymbol = symbol) => {
    const requestId = ++marketDataRequestRef.current;
    setMarketDataLoading(true);
    setMarketDataError("");
    try {
      const [nextSummary, nextOrderbook, nextTrades] = await Promise.all([
        fetchMarketSummary(targetSymbol),
        fetchMarketOrderbook(targetSymbol),
        fetchMarketTrades(targetSymbol),
      ]);
      if (requestId !== marketDataRequestRef.current) return;
      setMarketSummary(nextSummary);
      setOrderbook(nextOrderbook);
      setMarketTrades(nextTrades);
    } catch (error) {
      if (requestId !== marketDataRequestRef.current) return;
      setMarketDataError(error instanceof Error ? error.message : "市场数据加载失败。");
    } finally {
      if (requestId === marketDataRequestRef.current) setMarketDataLoading(false);
    }
  };

  useEffect(() => {
    if (symbols.length > 0 && !symbols.some((item) => item.symbol === selectedSymbol)) {
      setSelectedSymbol(symbols[0].symbol);
    }
  }, [selectedSymbol, symbols]);

  useEffect(() => {
    if (selectedConfig) {
      setVolume(normalizeQuantity(selectedConfig.minLot));
      setSearchParams(
        (current) => mergeTradingSearchParams(current, selectedConfig.symbol, selectedSimulationAccountId),
        { replace: true },
      );
    }
  }, [selectedConfig?.minLot, selectedConfig?.symbol, selectedSimulationAccountId, setSearchParams]);

  useEffect(() => {
    void fetchMarketSymbols()
      .then(setSymbolsFromBackend)
      .catch((error) => setMessage(error instanceof Error ? error.message : "品种列表加载失败。"));
  }, [setSymbolsFromBackend]);

  useEffect(() => {
    setMarketSummary(null);
    setOrderbook(null);
    setMarketTrades([]);
    void loadMarketData(symbol);

    return () => {
      marketDataRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  useEffect(() => {
    let cancelled = false;
    setSimulationAccountsLoading(true);
    void fetchSimulationAccounts()
      .then((payload) => {
        if (cancelled) {
          return;
        }
        const activeAccounts = payload.items.filter((item) => item.status !== "deleted" && item.status !== "disabled");
        setSimulationAccounts(activeAccounts);
        setSelectedSimulationAccountId((current) => {
          const requestedAccountId = current || readCurrentSimulationAccountId();
          if (requestedAccountId && activeAccounts.some((item) => item.id === requestedAccountId)) {
            return requestedAccountId;
          }
          return activeAccounts[0]?.id ?? "";
        });
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "模拟账户加载失败。"))
      .finally(() => {
        if (!cancelled) {
          setSimulationAccountsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedSimulationAccountId) {
      window.localStorage.setItem(currentSimulationAccountKey, selectedSimulationAccountId);
    }
  }, [selectedSimulationAccountId]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timer = window.setTimeout(() => setToastMessage(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    if (switchToastShownRef.current || !initialSimulationAccountIdRef.current || !selectedSimulationAccount) {
      return;
    }
    if (selectedSimulationAccount.id !== initialSimulationAccountIdRef.current) {
      return;
    }
    switchToastShownRef.current = true;
    setToastMessage(`已切换至模拟账户：${selectedSimulationAccount.name || shortSimulationId(selectedSimulationAccount.id)}`);
  }, [selectedSimulationAccount]);

  useEffect(() => {
    if (!chartContainerRef.current) {
      return;
    }

    const container = chartContainerRef.current;
    const chart = createChart(container, {
      height: container.clientHeight || 520,
      layout: { background: { color: "#0B1118" }, textColor: "#9CA3AF" },
      grid: {
        vertLines: { color: "#17202d" },
        horzLines: { color: "#17202d" },
      },
      rightPriceScale: { borderColor: "#1F2937" },
      timeScale: { borderColor: "#1F2937", timeVisible: true },
      crosshair: { mode: 1 },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: themeColor,
      borderUpColor: themeColor,
      wickUpColor: themeColor,
      downColor: "#EF4444",
      borderDownColor: "#EF4444",
      wickDownColor: "#EF4444",
      priceFormat: getChartPriceFormat(digits),
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const resizeObserver = new ResizeObserver(([entry]) => {
      const { height, width } = entry.contentRect;
      if (height > 0 && width > 0) chart.applyOptions({ height, width });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [themeColor]);

  useEffect(() => {
    candleSeriesRef.current?.applyOptions({
      priceFormat: getChartPriceFormat(digits),
    });
  }, [digits]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      setChartLoading(true);
      setChartMessage("");

      try {
        const candles = normalizeChartCandles(await fetchCandles(symbol, interval));
        if (cancelled) {
          return;
        }
        if (candles.length === 0) {
          setLatestCandle(null);
          setChartMessage("暂未取得可展示的K线数据，系统会继续刷新。");
        } else {
          candleSeriesRef.current?.setData(candles.map(toChartCandle));
          setLatestCandle(candles[candles.length - 1]);
          chartRef.current?.timeScale().fitContent();
        }
      } catch (error) {
        if (!cancelled) {
          setChartMessage(error instanceof Error ? error.message : "K线加载失败，系统会继续刷新。");
        }
      } finally {
        if (!cancelled) {
          setChartLoading(false);
        }
      }

      const shouldLoadTradingState = Boolean(selectedSimulationAccountId && selectedSimulationAccount && !simulationAccountsLoading);
      const tradingStatePromise = shouldLoadTradingState
        ? Promise.all([
            fetchTradingAccount(selectedSimulationAccountId),
            fetchPositions(selectedSimulationAccountId),
            fetchOrders(selectedSimulationAccountId),
          ])
        : Promise.resolve<[TradingAccount | null, PositionView[], OrderRecord[]]>([null, [], []]);
      const [nextTicker, [nextAccount, nextPositions, nextOrders]] = await Promise.all([fetchTicker(symbol), tradingStatePromise]);
      if (cancelled) {
        return;
      }
      setTicker(nextTicker);
      setAccount(nextAccount);
      setPositions(nextPositions.filter((position) => position.simulationAccountId === selectedSimulationAccountId || position.accountId === selectedSimulationAccountId));
      setOrders(nextOrders.filter((order) => order.simulationAccountId === selectedSimulationAccountId || order.accountId === selectedSimulationAccountId));
    }

    void loadInitialData().catch((error) => setMessage(error instanceof Error ? error.message : "行情初始化失败。"));
    return () => {
      cancelled = true;
    };
  }, [interval, selectedSimulationAccount?.id, selectedSimulationAccountId, simulationAccountsLoading, symbol, symbolConfigKey]);

  useEffect(() => {
    const socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", channel: "ticker", symbol }));
      socket.send(JSON.stringify({ type: "subscribe", channel: "candle", symbol, interval }));
    });

    socket.addEventListener("message", (event) => {
      let payload: ({ type: string; interval?: CandleInterval; data?: ApiCandle } & ApiTicker) | null = null;
      try {
        payload = JSON.parse(event.data) as { type: string; interval?: CandleInterval; data?: ApiCandle } & ApiTicker;
      } catch {
        return;
      }
      if (payload.type === "ticker" && payload.symbol === symbol) {
        setTicker((current) => ({ ...current, ...payload }));
        if (!simulationAccountsLoading && selectedSimulationAccount) {
          void refreshTradingState();
        }
      }
      if (payload.type === "candle" && payload.interval === interval && payload.data && isValidCandle(payload.data)) {
        candleSeriesRef.current?.update(toChartCandle(payload.data));
        setLatestCandle(payload.data);
        setChartMessage("");
      }
    });

    socket.addEventListener("close", () => {
      setTicker((current) => ({ ...current, status: "disconnected" }));
    });

    return () => socket.close();
  }, [interval, selectedSimulationAccount?.id, selectedSimulationAccountId, simulationAccountsLoading, symbol, wsUrl]);

  const refreshTradingState = async (simulationAccountId = selectedSimulationAccountId) => {
    if (!simulationAccountId) {
      setAccount(null);
      setPositions([]);
      setOrders([]);
      return;
    }
    const [nextAccount, nextPositions, nextOrders] = await Promise.all([
      fetchTradingAccount(simulationAccountId),
      fetchPositions(simulationAccountId),
      fetchOrders(simulationAccountId),
    ]);
    if (simulationAccountId !== selectedSimulationAccountId) {
      return;
    }
    setAccount(nextAccount);
    setPositions(nextPositions.filter((position) => position.simulationAccountId === simulationAccountId || position.accountId === simulationAccountId));
    setOrders(nextOrders.filter((order) => order.simulationAccountId === simulationAccountId || order.accountId === simulationAccountId));
  };

  const submitOrder = async (side: "buy" | "sell") => {
    setMessage("");
    if (!selectedSimulationAccountId || !selectedSimulationAccount) {
      setMessage("请先选择模拟账户。");
      return;
    }
    try {
      const position = await placeMarketOrder(symbol, side, volume, selectedSimulationAccountId);
      await refreshTradingState(selectedSimulationAccountId);
      setMessage(`${side === "buy" ? "买入" : "卖出"}已成交，价格 ${formatPrice(position.entryPrice, digits)}`);
    } catch (error) {
      await refreshTradingState(selectedSimulationAccountId);
      setMessage(error instanceof Error ? error.message : "市价单被拒绝。");
    }
  };

  const submitClose = async (positionId: string) => {
    if (closingPositionIdRef.current) {
      return;
    }
    closingPositionIdRef.current = positionId;
    setClosingPositionId(positionId);
    setMessage("");
    if (!selectedSimulationAccountId || !selectedSimulationAccount) {
      setMessage("请先选择模拟账户。");
      closingPositionIdRef.current = null;
      setClosingPositionId(null);
      return;
    }
    try {
      const result = await closePosition(positionId, selectedSimulationAccountId);
      await refreshTradingState(selectedSimulationAccountId);
      setMessage(`平仓已成交，价格 ${formatPrice(result.closePrice, digits)}，盈亏 ${result.pnl.toFixed(2)} ${currency}`);
    } catch (error) {
      await refreshTradingState(selectedSimulationAccountId);
      setMessage(error instanceof Error ? error.message : "平仓被拒绝。");
    } finally {
      closingPositionIdRef.current = null;
      setClosingPositionId(null);
    }
  };

  if (!selectedConfig) {
    return (
      <Card>
        <p className="font-medium">暂无可交易品种</p>
        <p className="mt-2 text-sm text-muted">请先在后台品种管理中启用至少一个用户端可见品种。</p>
      </Card>
    );
  }

  return (
    <div className="xh-trade-terminal xh-real-trade-terminal xh-demo-trade-terminal">
      <Toast message={toastMessage} />
      <section className="xh-trade-marketbar">
        <div className="xh-trade-marketbar-main">
          <h1 className="sr-only">{symbol} 交易终端</h1>
          <MarketSymbolPicker
            context="demo"
            symbols={symbols}
            selectedSymbol={symbol}
            onSelect={setSelectedSymbol}
            triggerVariant="terminal"
          />
          <span className="xh-real-market-badge">PERP · DEMO</span>
        </div>
        <div className="xh-trade-market-stats">
          <TradeStat label="Mark" value={formatPrice(marketSummary?.markPrice ?? undefined, digits)} />
          <TradeStat label="24h Change" value={formatMarketDayChange(marketSummary?.dayChange, marketSummary?.dayChangePercent)} tone={marketNumberTone(marketSummary?.dayChange)} />
          <TradeStat label="24h Volume" value={formatCompactMoney(marketSummary?.dayNotionalVolume)} />
          <TradeStat label="Open Interest" value={formatCompactMoney(multiplyFinite(marketSummary?.openInterest, marketSummary?.markPrice))} />
          <TradeStat label="Funding" value={formatFundingPercent(marketSummary?.funding)} tone={marketNumberTone(marketSummary?.funding)} />
          <TradeStat
            label="Status"
            value={marketDataError ? "ERROR" : (marketSummary?.status ?? statusText)}
            tone={marketDataError || ticker.status === "disconnected" ? "negative" : ticker.status === "connected" ? "positive" : undefined}
          />
        </div>
      </section>

      <div className="xh-trade-grid">
        <main className="xh-trade-main">
          <section className="xh-trade-workbench">
            <div className="xh-trade-chart-stage">
              <TradingChartPanel
                chartContainerRef={chartContainerRef}
                chartLoading={chartLoading}
                chartMessage={chartMessage}
                dayChange={marketSummary?.dayChange}
                dayChangePercent={marketSummary?.dayChangePercent}
                interval={interval}
                latestCandle={latestCandle}
                marketDataLoading={marketDataLoading}
                onIntervalChange={setIntervalValue}
                onRefreshMarketData={() => void loadMarketData(symbol)}
                selectedConfig={selectedConfig}
                ticker={ticker}
              />
            </div>

            <div className="xh-trade-depth-stage">
              <MarketDepthPanel
                ariaLabel="模拟盘口数据"
                digits={digits}
                markPrice={marketSummary?.markPrice}
                midPrice={marketSummary?.midPrice}
                orderbook={orderbook}
                trades={marketTrades}
              />
            </div>
          </section>

          <TradingRecords
            closingPositionId={closingPositionId}
            contractSize={selectedConfig.contractSize}
            digits={digits}
            hasSimulationAccounts={hasSimulationAccounts}
            lotStep={selectedConfig.lotStep}
            needsSimulationAccount={needsSimulationAccount}
            onClosePosition={submitClose}
            onSelectSymbol={setSelectedSymbol}
            orders={orders}
            positions={positions}
            selectedSimulationAccount={selectedSimulationAccount}
          />
        </main>

        <aside className="xh-trade-order-rail">
          <TradingOrderPanel
            account={account}
            message={message}
            needsSimulationAccount={needsSimulationAccount}
            onSubmitOrder={submitOrder}
            orderDisabled={orderDisabled}
            positionSize={positions.filter((position) => position.symbol === symbol).reduce((total, position) => total + position.volume, 0)}
            selectedConfig={selectedConfig}
            setVolume={setVolume}
            simulationAccountsLoading={simulationAccountsLoading}
            ticker={ticker}
            volume={volume}
          />
          <SimulationAccountContextPanel
            account={account}
            currency={currency}
            simulationAccount={selectedSimulationAccount}
          />
        </aside>
      </div>
    </div>
  );
}
