import { createChart, type CandlestickData, CandlestickSeries, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select } from "../../components/ui/Select";
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

const intervals: CandleInterval[] = ["1m", "5m", "15m", "1h"];

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
  const [selectedSimulationAccountId, setSelectedSimulationAccountId] = useState(searchParams.get("simulationAccountId") ?? "");
  const [volume, setVolume] = useState(selectedConfig?.minLot ?? 0.01);
  const [message, setMessage] = useState("");
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [chartMessage, setChartMessage] = useState("");
  const [chartLoading, setChartLoading] = useState(true);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const closingPositionIdRef = useRef<string | null>(null);

  const statusTone = ticker.status === "connected" ? "success" : ticker.status === "stale" ? "neutral" : "danger";
  const statusText = ticker.status === "connected" ? "实时行情" : ticker.status === "stale" ? "行情延迟" : "行情连接中断";
  const selectedSimulationAccount = simulationAccounts.find((item) => item.id === selectedSimulationAccountId) ?? null;
  const hasSimulationAccounts = simulationAccounts.length > 0;
  const needsSimulationAccount = !selectedSimulationAccountId || !selectedSimulationAccount;
  const orderDisabled =
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
      setVolume(selectedConfig.minLot);
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
          if (!current) {
            return "";
          }
          return activeAccounts.some((item) => item.id === current) ? current : "";
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

      const tradingStatePromise = selectedSimulationAccountId
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
      setPositions(nextPositions);
      setOrders(nextOrders);
    }

    void loadInitialData().catch((error) => setMessage(error instanceof Error ? error.message : "行情初始化失败。"));
    return () => {
      cancelled = true;
    };
  }, [interval, selectedSimulationAccountId, symbol, symbolConfigKey]);

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
        void refreshTradingState();
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
  }, [interval, selectedSimulationAccountId, symbol, wsUrl]);

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

  const selectSimulationAccount = (accountId: string) => {
    setSelectedSimulationAccountId(accountId);
    setMessage("");
    setAccount(null);
    setPositions([]);
    setOrders([]);
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
      <div className="xh-page-header">
        <div>
          <p className="text-sm text-muted">Binance 合约行情 + 内部模拟交易</p>
          <h1 className="xh-title mt-2">{symbol} 交易终端</h1>
        </div>
        <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:flex-wrap md:items-center">
          <Select
            label="选择品种"
            hideLabel
            className="py-2.5 md:w-auto"
            value={symbol}
            onChange={(event) => setSelectedSymbol(event.target.value)}
            options={symbols.map((item) => ({ value: item.symbol, label: `${item.symbol} · ${item.displayName}` }))}
          />
          <div className="self-start">
            <Badge tone={statusTone}>{statusText}</Badge>
          </div>
        </div>
      </div>

      <Card className="p-0">
        <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold">模拟账户</h2>
            <p className="mt-1 text-sm text-muted">
              {hasSimulationAccounts ? "选择后显示该账户的权益、持仓与订单。" : "创建模拟账户后才能开始模拟交易。"}
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto lg:items-center">
            <Select
              label="选择模拟账户"
              className="min-w-0 py-2.5 sm:min-w-[280px]"
              value={selectedSimulationAccountId}
              onChange={(event) => selectSimulationAccount(event.target.value)}
              disabled={simulationAccountsLoading || !hasSimulationAccounts}
              options={[
                { value: "", label: simulationAccountsLoading ? "模拟账户加载中" : "请选择模拟账户" },
                ...simulationAccounts.map((item) => ({
                  value: item.id,
                  label: `${item.name ?? "模拟账户"} · ${item.equity.toFixed(2)} ${item.asset}`,
                })),
              ]}
            />
            <a
              className={`inline-flex items-center justify-center gap-2 whitespace-nowrap border px-4 py-2.5 text-sm font-semibold uppercase tracking-[0.08em] transition active:translate-y-px ${
                hasSimulationAccounts
                  ? "border-white/25 bg-black text-white hover:border-white hover:bg-white/[0.04]"
                  : "border-white bg-white text-black hover:bg-black hover:text-white"
              }`}
              href="/app/account?section=simulation"
            >
              {hasSimulationAccounts ? "管理模拟账户" : "创建模拟账户"}
            </a>
          </div>
        </div>
        {!hasSimulationAccounts && !simulationAccountsLoading ? (
          <div className="border-t border-line px-4 py-5">
            <div className="border border-line bg-black p-5">
              <p className="font-medium">暂无模拟账户</p>
              <p className="mt-2 text-sm text-muted">请先到账户页创建模拟账户，再返回交易页选择账户下单。</p>
            </div>
          </div>
        ) : needsSimulationAccount ? (
          <div className="border-t border-line px-4 py-3 text-sm text-amber-100">请选择模拟账户后再查看持仓、订单和提交市价单。</div>
        ) : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <AccountStat label="Balance" value={account?.balance} suffix={currency} />
        <AccountStat label="Equity" value={account?.equity} suffix={currency} />
        <AccountStat label="Used Margin" value={account?.usedMargin} suffix={currency} />
        <AccountStat label="Free Margin" value={account?.freeMargin} suffix={currency} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="p-0">
          <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Activity size={18} style={{ color: themeColor }} />
              <span className="font-semibold">{symbol}</span>
              <span className="text-sm text-muted">{selectedConfig.displayName}</span>
            </div>
            <div className="no-scrollbar flex overflow-x-auto border border-line bg-black p-1">
              {intervals.map((item) => (
                <button
                  key={item}
                  className={`shrink-0 px-3 py-1.5 text-sm transition ${interval === item ? "bg-white text-black" : "text-muted hover:text-white"}`}
                  onClick={() => setIntervalValue(item)}
                >
                  {item}
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

        <div className="space-y-4">
          <Card>
            <h2 className="font-semibold">最新报价</h2>
            <div className="mt-4 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
              <Quote label="Last" value={ticker.last} digits={digits} />
              <Quote label="Spread" value={ticker.spread} digits={digits} />
              <Quote label="Bid" value={ticker.bid} digits={digits} />
              <Quote label="Ask" value={ticker.ask} digits={digits} />
            </div>
            <div className="mt-4 space-y-1 text-xs text-muted">
              <p>来源：{ticker.source ?? "-"}</p>
              <p>更新时间：{ticker.timestamp ? new Date(ticker.timestamp).toLocaleString("zh-CN") : "-"}</p>
            </div>
            {ticker.status !== "connected" ? (
              <div className="mt-4 flex gap-2 border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                <AlertTriangle className="mt-0.5 shrink-0" size={16} />
                {ticker.status === "stale" ? "超过 10 秒未收到行情，市价单已暂停。" : "行情连接中断，正在等待重连。"}
              </div>
            ) : null}
          </Card>

          <Card>
            <h2 className="font-semibold">模拟市价单</h2>
            <label className="mt-4 block">
              <span className="mb-2 block text-sm text-muted">
                交易手数（{selectedConfig.minLot}-{selectedConfig.maxLot} / {selectedConfig.lotStep}）
              </span>
              <input
                className="w-full border border-line bg-black px-3.5 py-3 text-sm text-white outline-none transition focus:border-white"
                min={selectedConfig.minLot}
                max={selectedConfig.maxLot}
                step={selectedConfig.lotStep}
                type="number"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <div className="mt-4 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
              <Button disabled={orderDisabled} onClick={() => submitOrder("buy")}>
                <ArrowUp size={16} /> 买入 Ask
              </Button>
              <Button disabled={orderDisabled} variant="danger" onClick={() => submitOrder("sell")}>
                <ArrowDown size={16} /> 卖出 Bid
              </Button>
            </div>
            {selectedConfig.tradeStatus !== "enabled" ? (
              <p className="mt-3 text-sm text-amber-200">
                当前品种状态为 {selectedConfig.tradeStatus}，仅允许平仓，不可新开仓。
              </p>
            ) : null}
            {needsSimulationAccount ? <p className="mt-3 text-sm text-amber-200">请先选择模拟账户。</p> : null}
            {message ? <p className="mt-4 xh-message">{message}</p> : null}
          </Card>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line p-4">
          <h2 className="font-semibold">模拟持仓</h2>
          <p className="mt-1 text-sm text-muted">
            {selectedSimulationAccount ? `${selectedSimulationAccount.name ?? "当前模拟账户"} · ${selectedSimulationAccount.id}` : "选择模拟账户后展示对应持仓。"}
          </p>
        </div>
        {needsSimulationAccount ? (
          <div className="p-8 text-center text-sm text-muted">请选择模拟账户。</div>
        ) : positions.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted">当前模拟账户暂无持仓。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="xh-thead">
                <tr>
                  <th className="px-5 py-3 font-medium">方向</th>
                  <th className="px-5 py-3 font-medium">品种</th>
                  <th className="px-5 py-3 font-medium">手数</th>
                  <th className="px-5 py-3 font-medium">开仓价</th>
                  <th className="px-5 py-3 font-medium">标记价</th>
                  <th className="px-5 py-3 font-medium">保证金</th>
                  <th className="px-5 py-3 font-medium">浮盈亏</th>
                  <th className="px-5 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {positions.map((position) => (
                  <tr key={position.id}>
                    <td className="px-5 py-4">{position.side === "long" ? "多单" : "空单"}</td>
                    <td className="px-5 py-4">{position.symbol}</td>
                    <td className="px-5 py-4">{position.volume}</td>
                    <td className="px-5 py-4">{formatPrice(position.entryPrice, digits)}</td>
                    <td className="px-5 py-4">{formatPrice(position.markPrice ?? undefined, digits)}</td>
                    <td className="px-5 py-4">{position.margin.toFixed(2)}</td>
                    <td className={`px-5 py-4 ${Number(position.pnl) >= 0 ? "text-white" : "text-red-300"}`}>
                      {position.pnl?.toFixed(2) ?? "-"}
                    </td>
                    <td className="px-5 py-4">
                      <Button
                        variant="secondary"
                        disabled={closingPositionId !== null}
                        onClick={() => submitClose(position.id)}
                      >
                        <XCircle size={16} /> {closingPositionId === position.id ? "平仓中" : "平仓"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line p-4">
          <h2 className="font-semibold">订单记录</h2>
          <p className="mt-1 text-sm text-muted">
            {selectedSimulationAccount ? `${selectedSimulationAccount.name ?? "当前模拟账户"} · ${selectedSimulationAccount.id}` : "选择模拟账户后展示对应订单。"}
          </p>
        </div>
        {needsSimulationAccount ? (
          <div className="p-8 text-center text-sm text-muted">请选择模拟账户。</div>
        ) : orders.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted">当前模拟账户暂无订单记录。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1160px] text-left text-sm">
              <thead className="xh-thead">
                <tr>
                  <th className="px-5 py-3 font-medium">时间</th>
                  <th className="px-5 py-3 font-medium">动作</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                  <th className="px-5 py-3 font-medium">品种</th>
                  <th className="px-5 py-3 font-medium">方向/手数</th>
                  <th className="px-5 py-3 font-medium">成交价</th>
                  <th className="px-5 py-3 font-medium">Bid / Ask</th>
                  <th className="px-5 py-3 font-medium">来源</th>
                  <th className="px-5 py-3 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="px-5 py-4 text-muted">{new Date(order.createdAt).toLocaleString("zh-CN")}</td>
                    <td className="px-5 py-4">{order.action === "open" ? "开仓" : "平仓"}</td>
                    <td className="px-5 py-4">
                      <Badge tone={order.status === "filled" ? "success" : "danger"}>{order.status}</Badge>
                    </td>
                    <td className="px-5 py-4">{order.symbol}</td>
                    <td className="px-5 py-4">{order.side} / {order.volume}</td>
                    <td className="px-5 py-4">{order.price === null ? "-" : formatPrice(order.price, digits)}</td>
                    <td className="px-5 py-4 text-xs text-muted">
                      {order.bid === null || order.ask === null ? "-" : `${formatPrice(order.bid, digits)} / ${formatPrice(order.ask, digits)}`}
                    </td>
                    <td className="px-5 py-4 text-muted">{order.source}</td>
                    <td className="px-5 py-4 text-muted">{order.reason ?? (typeof order.pnl === "number" ? `P/L ${order.pnl.toFixed(2)}` : "模拟成交")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AccountStat({ label, value, suffix }: { label: string; value?: number; suffix: string }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-2xl font-semibold">{value?.toFixed(2) ?? "-"} <span className="text-sm text-muted">{suffix}</span></p>
    </Card>
  );
}

function Quote({ label, value, digits }: { label: string; value?: number; digits: number }) {
  return (
    <div className="border border-line bg-black p-3">
      <p className="text-xs uppercase text-muted">{label}</p>
      <p className="mt-2 text-lg font-semibold">{formatPrice(value, digits)}</p>
    </div>
  );
}

function toChartCandle(candle: ApiCandle): CandlestickData {
  return {
    time: candle.time as CandlestickData["time"],
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function normalizeChartCandles(candles: ApiCandle[]) {
  const byTime = new Map<number, ApiCandle>();
  for (const candle of candles) {
    if (isValidCandle(candle)) {
      byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function isValidCandle(candle: ApiCandle) {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close)
  );
}

function getChartPriceFormat(digits: number) {
  const precision = Math.min(Math.max(Math.trunc(digits), 0), 8);
  return {
    type: "price" as const,
    precision,
    minMove: 10 ** -precision,
  };
}
