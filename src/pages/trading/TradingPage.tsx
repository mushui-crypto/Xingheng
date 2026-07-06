import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { MarketSymbolPicker } from "../../components/trading/MarketSymbolPicker";
import {
  closePosition,
  fetchCandles,
  fetchMarketSymbols,
  fetchOrders,
  fetchPositions,
  fetchTicker,
  fetchTradingAccount,
  placeMarketOrder,
  type ApiCandle,
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
import { TradingOrderPanel } from "../../features/trading/components/TradingOrderPanel";
import { TradingOrdersTable, TradingPositionsTable } from "../../features/trading/components/TradingRecords";
import { Toast } from "../../features/trading/components/TradingFeedback";
import { getChartPriceFormat, isValidCandle, normalizeChartCandles, toChartCandle } from "../../features/trading/lib/chart";
import { readCurrentSimulationAccountId, shortSimulationId } from "../../features/trading/lib/simulationAccount";
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
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const closingPositionIdRef = useRef<string | null>(null);
  const initialSimulationAccountIdRef = useRef(searchParams.get("simulationAccountId") ?? "");
  const switchToastShownRef = useRef(false);

  const statusTone = ticker.status === "connected" ? "success" : ticker.status === "stale" ? "neutral" : "danger";
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

  useEffect(() => {
    if (symbols.length > 0 && !symbols.some((item) => item.symbol === selectedSymbol)) {
      setSelectedSymbol(symbols[0].symbol);
    }
  }, [selectedSymbol, symbols]);

  useEffect(() => {
    if (selectedConfig) {
      setVolume(normalizeQuantity(selectedConfig.minLot));
      const nextParams: Record<string, string> = { symbol: selectedConfig.symbol };
      if (selectedSimulationAccountId) {
        nextParams.simulationAccountId = selectedSimulationAccountId;
      }
      setSearchParams(nextParams);
    }
  }, [selectedConfig?.minLot, selectedConfig?.symbol, selectedSimulationAccountId, setSearchParams]);

  useEffect(() => {
    void fetchMarketSymbols()
      .then(setSymbolsFromBackend)
      .catch((error) => setMessage(error instanceof Error ? error.message : "品种列表加载失败。"));
  }, [setSymbolsFromBackend]);

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

    const chart = createChart(chartContainerRef.current, {
      height: 460,
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

    const resize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth ?? 900 });
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
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
          setChartMessage("暂未取得可展示的K线数据，系统会继续刷新。");
        } else {
          candleSeriesRef.current?.setData(candles.map(toChartCandle));
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
    <div className="xh-page">
      <Toast message={toastMessage} />
      <div className="xh-page-header">
        <div>
          <h1 className="sr-only">{symbol} 交易终端</h1>
          <p className="text-sm text-muted">Hyperliquid 永续 · 内部模拟交易</p>
          <div className="mt-2">
            <MarketSymbolPicker
              symbols={symbols}
              selectedSymbol={symbol}
              onSelect={setSelectedSymbol}
            />
          </div>
        </div>
        <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:flex-wrap md:items-center">
          <div className="self-start">
            <Badge tone={statusTone}>{statusText}</Badge>
          </div>
        </div>
      </div>

      <SimulationAccountContextPanel
        account={account}
        currency={currency}
        simulationAccount={selectedSimulationAccount}
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <TradingChartPanel
          chartContainerRef={chartContainerRef}
          chartLoading={chartLoading}
          chartMessage={chartMessage}
          interval={interval}
          onIntervalChange={setIntervalValue}
          selectedConfig={selectedConfig}
          symbol={symbol}
          themeColor={themeColor}
        />

        <TradingOrderPanel
          digits={digits}
          message={message}
          needsSimulationAccount={needsSimulationAccount}
          onSubmitOrder={submitOrder}
          orderDisabled={orderDisabled}
          selectedConfig={selectedConfig}
          setVolume={setVolume}
          simulationAccountsLoading={simulationAccountsLoading}
          ticker={ticker}
          volume={volume}
        />
      </div>

      <TradingPositionsTable
        closingPositionId={closingPositionId}
        digits={digits}
        hasSimulationAccounts={hasSimulationAccounts}
        lotStep={selectedConfig.lotStep}
        needsSimulationAccount={needsSimulationAccount}
        onClosePosition={submitClose}
        positions={positions}
        selectedSimulationAccount={selectedSimulationAccount}
      />

      <TradingOrdersTable
        digits={digits}
        hasSimulationAccounts={hasSimulationAccounts}
        lotStep={selectedConfig.lotStep}
        needsSimulationAccount={needsSimulationAccount}
        orders={orders}
        selectedSimulationAccount={selectedSimulationAccount}
      />
    </div>
  );
}
