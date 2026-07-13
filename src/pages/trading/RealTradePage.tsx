import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { MarketIcon } from "../../components/trading/MarketIcon";
import {
  fetchRealAccountSummary,
  fetchRealCandles,
  fetchRealMarketSummary,
  fetchRealOpenOrders,
  fetchRealOrderHistory,
  fetchRealOrderbook,
  fetchRealPositions,
  fetchRealTrades,
  fetchRealTradingFees,
  fetchRealTradingSymbols,
  type RealAccountSummary,
  type RealCandle,
  type RealMarketSummary,
  type RealOpenOrder,
  type RealOrderHistory,
  type RealOrderbook,
  type RealPosition,
  type RealTrade,
  type RealTradingFees,
  type RealTradingSymbol,
} from "../../api/realTrading";
import { getChartPriceFormat, normalizeChartCandles, positionLatestCandleInInitialView, toChartCandle } from "../../features/trading/lib/chart";
import { RealTradingOrderPanel } from "../../features/realTrading/components/RealTradingOrderPanel";
import { RealPositionsTable } from "../../features/realTrading/components/RealPositionsTable";
import type { RealPositionCloseRequest, RealPositionTpslRequest } from "../../features/realTrading/model/types";
import { enrichPositionMarks } from "../../features/realTrading/lib/enrichPositionMarks";
import { resolvePositionSymbol, submitPositionCloseRequest, submitPositionTpslRequest } from "../../features/realTrading/lib/positionActions";
import { useHyperliquidSessionSigner } from "../../features/realTrading/lib/useHyperliquidSessionSigner";
import { tradingIntervalLabels, tradingIntervals } from "../../features/trading/model/constants";
import type { CandleInterval } from "../../types";
import { formatPrice } from "../../utils/price";
import { discoverInjectedEthereumProvider, type Eip1193Provider } from "../../shared/wallet/eip1193";

export function RealTradePage() {
  const [symbols, setSymbols] = useState<RealTradingSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<CandleInterval>("5m");
  const [walletAddress, setWalletAddress] = useState("");
  const [marketSummary, setMarketSummary] = useState<RealMarketSummary | null>(null);
  const [orderbook, setOrderbook] = useState<RealOrderbook | null>(null);
  const [trades, setTrades] = useState<RealTrade[]>([]);
  const [account, setAccount] = useState<RealAccountSummary | null>(null);
  const [fees, setFees] = useState<RealTradingFees | null>(null);
  const [positions, setPositions] = useState<RealPosition[]>([]);
  const [openOrders, setOpenOrders] = useState<RealOpenOrder[]>([]);
  const [history, setHistory] = useState<RealOrderHistory | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [accountLoading, setAccountLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);
  const [marketError, setMarketError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [chartMessage, setChartMessage] = useState("");
  const [latestCandle, setLatestCandle] = useState<RealCandle | null>(null);
  const [connectMessage, setConnectMessage] = useState("");
  const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const tradingSession = useHyperliquidSessionSigner(walletProvider, walletAddress);

  const selectedConfig = symbols.find((item) => item.symbol === selectedSymbol) ?? null;
  const isConnected = Boolean(walletAddress);
  const digits = selectedConfig?.pxDecimals ?? 2;
  const symbolOptions = useMemo(
    () => (symbols.length > 0 ? symbols : [{ symbol: selectedSymbol, providerCoin: "BTC", status: "pending" }]).map((item) => ({
      label: `${item.symbol} · ${item.providerCoin}`,
      value: item.symbol,
    })),
    [selectedSymbol, symbols],
  );

  const loadMarket = async (symbol = selectedSymbol) => {
    setMarketLoading(true);
    setMarketError("");
    try {
      const [nextSymbols, nextSummary, nextOrderbook, nextTrades] = await Promise.all([
        fetchRealTradingSymbols().catch((error) => {
          throw error;
        }),
        fetchRealMarketSummary(symbol),
        fetchRealOrderbook(symbol),
        fetchRealTrades(symbol),
      ]);
      setSymbols(nextSymbols);
      if (nextSymbols.length > 0 && !nextSymbols.some((item) => item.symbol === symbol)) {
        setSelectedSymbol(nextSymbols[0].symbol);
      }
      setMarketSummary(nextSummary);
      setOrderbook(nextOrderbook);
      setTrades(nextTrades);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "真实交易市场数据加载失败。");
      setMarketSummary(null);
      setOrderbook(null);
      setTrades([]);
    } finally {
      setMarketLoading(false);
    }
  };

  const loadAccount = async (address = walletAddress) => {
    if (!address) {
      setAccountError("");
      setAccount(null);
      setFees(null);
      setPositions([]);
      setOpenOrders([]);
      setHistory(null);
      return;
    }
    setAccountLoading(true);
    setAccountError("");
    try {
      const [nextAccount, nextFees, nextPositions, nextOpenOrders, nextHistory] = await Promise.all([
        fetchRealAccountSummary(address),
        fetchRealTradingFees(address),
        fetchRealPositions(address),
        fetchRealOpenOrders(address),
        fetchRealOrderHistory(address),
      ]);
      const enrichedPositions = await enrichPositionMarks(nextPositions, fetchRealMarketSummary);
      setAccount(nextAccount);
      setFees(nextFees);
      setPositions(enrichedPositions);
      setOpenOrders(nextOpenOrders);
      setHistory(nextHistory);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "真实账户数据加载失败。");
      setAccount(null);
      setFees(null);
      setPositions([]);
      setOpenOrders([]);
      setHistory(null);
    } finally {
      setAccountLoading(false);
    }
  };

  useEffect(() => {
    void loadMarket(selectedSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  useEffect(() => {
    let active = true;
    void discoverInjectedEthereumProvider().then((provider) => {
      if (active) {
        setWalletProvider(provider);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!walletProvider?.on) {
      return;
    }

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0];
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      setWalletAddress(address);
      setConnectMessage(address ? "主账户地址已切换，正在刷新只读账户数据。" : "钱包已断开，真实账户数据已清空。");
      void loadAccount(address);
    };

    walletProvider.on("accountsChanged", handleAccountsChanged);
    return () => walletProvider.removeListener?.("accountsChanged", handleAccountsChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletProvider]);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) {
      return;
    }

    const chart = createChart(container, {
      height: container.clientHeight || 520,
      width: container.clientWidth || 900,
      layout: { background: { color: "#05090d" }, textColor: "#9CA3AF" },
      grid: {
        vertLines: { color: "#132126" },
        horzLines: { color: "#132126" },
      },
      rightPriceScale: { borderColor: "#1c2a30" },
      timeScale: { borderColor: "#1c2a30", timeVisible: true },
      crosshair: { mode: 1 },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#00C896",
      borderUpColor: "#00C896",
      wickUpColor: "#00C896",
      downColor: "#EF4444",
      borderDownColor: "#EF4444",
      wickDownColor: "#EF4444",
      priceFormat: getChartPriceFormat(digits),
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const resizeObserver = new ResizeObserver(([entry]) => {
      const { height, width } = entry.contentRect;
      if (height > 0 && width > 0) {
        chart.applyOptions({ height, width });
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    candleSeriesRef.current?.applyOptions({
      priceFormat: getChartPriceFormat(digits),
    });
  }, [digits]);

  useEffect(() => {
    let cancelled = false;

    async function loadChart() {
      setChartLoading(true);
      setChartMessage("");
      try {
        const candles = normalizeChartCandles(await fetchRealCandles(selectedSymbol, interval));
        if (cancelled) {
          return;
        }
        if (candles.length === 0) {
          candleSeriesRef.current?.setData([]);
          setLatestCandle(null);
          setChartMessage("暂未取得可展示的真实 K 线数据。");
          return;
        }
        candleSeriesRef.current?.setData(candles.map(toChartCandle));
        setLatestCandle(candles[candles.length - 1]);
        if (chartRef.current) {
          positionLatestCandleInInitialView(chartRef.current, candles.length);
        }
      } catch (error) {
        if (!cancelled) {
          candleSeriesRef.current?.setData([]);
          setLatestCandle(null);
          setChartMessage(error instanceof Error ? error.message : "真实 K 线加载失败。");
        }
      } finally {
        if (!cancelled) {
          setChartLoading(false);
        }
      }
    }

    void loadChart();
    return () => {
      cancelled = true;
    };
  }, [interval, selectedSymbol]);

  const connectWallet = async () => {
    setConnectMessage("");
    const ethereum = walletProvider ?? await discoverInjectedEthereumProvider();
    if (!ethereum?.request) {
      setConnectMessage("未检测到浏览器钱包。请使用支持 EIP-1193 的钱包连接主账户地址。");
      return;
    }
    try {
      setWalletProvider(ethereum);
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      if (!address) {
        setConnectMessage("钱包未返回账户地址。");
        return;
      }
      setWalletAddress(address);
      await loadAccount(address);
      setConnectMessage("主账户地址已连接。");
    } catch (error) {
      setConnectMessage(error instanceof Error ? error.message : "钱包连接失败。");
    }
  };

  const handlePositionClose = async (request: RealPositionCloseRequest) => {
    const completed = await tradingSession.runAction(
      (signer) => submitPositionCloseRequest(signer, request, symbols),
      request.scope === "all" ? "全部平仓请求已发送。" : request.mode === "reverse" ? "反手请求已发送。" : "平仓请求已发送。",
    );
    if (!completed) throw new Error("交易请求未完成，请查看下单区状态。");
    await loadAccount(walletAddress);
  };

  const handleCancelOrder = async (order: RealOpenOrder) => {
    const config = symbols.find((item) => item.providerCoin === order.coin || item.symbol === order.coin);
    const oid = Number(order.oid);
    if (!config || typeof config.assetId !== "number") throw new Error(`${order.coin ?? "当前品种"} 缺少真实交易资产映射。`);
    if (!Number.isSafeInteger(oid) || oid <= 0) throw new Error("当前委托缺少有效 OID。");
    const completed = await tradingSession.runAction(
      (signer) => signer.cancelOrder(config.assetId!, oid),
      "撤单请求已发送。",
    );
    if (!completed) throw new Error("撤单请求未完成，请查看下单区状态。");
    await loadAccount(walletAddress);
  };

  const handlePositionTpsl = async (request: RealPositionTpslRequest) => {
    const config = resolvePositionSymbol(request.position, symbols);
    const currentTriggers = openOrders.filter((order) => order.coin === request.position.coin && order.isTrigger);
    const existingTriggers = currentTriggers.map((order) => {
      const oid = Number(order.oid);
      if (!Number.isSafeInteger(oid) || oid <= 0) throw new Error("当前止盈止损委托缺少有效 OID，无法安全替换。");
      return { asset: config.assetId!, oid };
    });
    const completed = await tradingSession.runAction(async (signer) => {
      if (existingTriggers.length > 0) await signer.cancelOrders(existingTriggers);
      await submitPositionTpslRequest(signer, request, symbols);
    }, "止盈止损请求已发送。");
    if (!completed) throw new Error("止盈止损请求未完成，请查看下单区状态。");
    await loadAccount(walletAddress);
  };

  return (
    <div className="xh-trade-terminal xh-real-trade-terminal">
      <section className="xh-trade-marketbar">
        <div className="xh-trade-marketbar-main">
          <MarketIcon
            className="xh-real-symbol-mark"
            fallback={selectedConfig?.providerCoin ?? selectedSymbol}
            iconUrl={selectedConfig?.iconUrl}
          />
          <label className="xh-real-symbol-picker">
            <span className="sr-only">真实交易品种</span>
            <span className="xh-real-symbol-title">
              {selectedSymbol}
              <ChevronDown size={15} aria-hidden="true" />
            </span>
            <span className="xh-real-symbol-source">Hyperliquid perpetual · Testnet</span>
            <select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)}>
              {symbolOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <span className="xh-real-market-badge">PERP · REAL</span>
        </div>
        <div className="xh-trade-market-stats">
          <TradeStat label="Mark" value={formatPrice(marketSummary?.markPrice ?? undefined, digits)} />
          <TradeStat label="24h Change" value={formatDayChange(marketSummary?.dayChange, marketSummary?.dayChangePercent)} tone={numberTone(marketSummary?.dayChange)} />
          <TradeStat label="24h Volume" value={formatCompactMoney(marketSummary?.dayNotionalVolume)} />
          <TradeStat label="Open Interest" value={formatCompactMoney(multiplyFinite(marketSummary?.openInterest, marketSummary?.markPrice))} />
          <TradeStat label="Funding" value={formatPercent(marketSummary?.funding)} tone={numberTone(marketSummary?.funding)} />
          <TradeStat label="Status" value={marketSummary?.status ?? (marketLoading ? "LOADING" : "-")} tone={marketSummary?.status?.toLowerCase() === "live" ? "positive" : undefined} />
        </div>
      </section>

      <div className="xh-trade-grid">
        <main className="xh-trade-main">
          <section className="xh-trade-workbench">
            <section className="xh-trade-chart-stage">
              <div className="xh-real-chart-toolbar">
                <div className="no-scrollbar flex max-w-full overflow-x-auto">
                  {tradingIntervals.filter((item) => ["1m", "5m", "15m", "1h", "4h", "8h", "12h", "1d", "1w", "1M"].includes(item)).map((item) => (
                    <button
                      key={item}
                      className={`xh-real-interval ${interval === item ? "is-active" : ""}`}
                      onClick={() => setInterval(item)}
                    >
                      {tradingIntervalLabels[item]}
                    </button>
                  ))}
                </div>
                <div className="xh-real-live-source">
                  <span /> Hyperliquid · REST
                  <button aria-label="刷新真实行情" disabled={marketLoading} onClick={() => void loadMarket(selectedSymbol)} type="button">
                    <RefreshCw className={marketLoading ? "animate-spin" : ""} size={14} />
                  </button>
                </div>
              </div>
              <div className="xh-real-candle-summary">
                <strong>HYPERLIQUID TESTNET</strong>
                <span>O&nbsp; {formatPrice(latestCandle?.open, digits)}</span>
                <span>H&nbsp; {formatPrice(latestCandle?.high, digits)}</span>
                <span>L&nbsp; {formatPrice(latestCandle?.low, digits)}</span>
                <span>C&nbsp; {formatPrice(latestCandle?.close, digits)}</span>
                <span>24h&nbsp; <b className={toneClass(numberTone(marketSummary?.dayChange))}>{formatDayChange(marketSummary?.dayChange, marketSummary?.dayChangePercent)}</b></span>
              </div>
              <div className="xh-real-chart-canvas">
                <div ref={chartContainerRef} className="h-full w-full" />
                {marketLoading ? (
                  <div className="absolute inset-0 flex flex-col justify-center gap-3 bg-black/85 p-6" aria-busy="true" aria-label="行情加载中">
                    <div className="h-3 w-1/3 animate-pulse bg-white/10" />
                    <div className="h-3 w-2/3 animate-pulse bg-white/10" />
                    <div className="h-3 w-1/2 animate-pulse bg-white/10" />
                  </div>
                ) : marketError ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 p-8 text-center text-sm text-red-200" role="alert">
                    <p>{marketError}</p>
                    <Button className="mt-4" onClick={() => void loadMarket(selectedSymbol)} variant="secondary">重新加载</Button>
                  </div>
                ) : !marketSummary ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/90 p-8 text-center text-sm text-muted">
                    等待 /api/real-trading/market/* 返回真实 Testnet 行情。
                  </div>
                ) : chartLoading || chartMessage ? (
                  <div className="pointer-events-none absolute inset-x-4 top-4 border border-line bg-black/85 px-4 py-3 text-sm text-muted backdrop-blur">
                    {chartLoading ? "真实 K线加载中..." : chartMessage}
                  </div>
                ) : null}
              </div>
            </section>

            <div className="xh-trade-depth-stage">
              <StatePanel
                loading={marketLoading}
                error={marketError}
                empty={!marketSummary}
                emptyText="-"
                onRetry={() => void loadMarket(selectedSymbol)}
              >
                <DepthAndTrades orderbook={orderbook} trades={trades} digits={digits} markPrice={marketSummary?.markPrice} midPrice={marketSummary?.midPrice} />
              </StatePanel>
            </div>
          </section>

          <RealRecords
            accountLoading={accountLoading}
            bestAsk={orderbook?.asks[0]?.price}
            bestBid={orderbook?.bids[0]?.price}
            error={accountError}
            history={history}
            onCancelOrder={handleCancelOrder}
            onCloseRequest={handlePositionClose}
            onTpslRequest={handlePositionTpsl}
            openOrders={openOrders}
            positions={positions}
          />
        </main>

        <aside className="xh-trade-order-rail">
          <RealTradingOrderPanel
            assetId={selectedConfig?.assetId}
            availableMargin={account?.availableMargin ?? account?.withdrawable}
            connected={isConnected}
            connectionMessage={connectMessage}
            markPrice={marketSummary?.markPrice}
            fees={fees}
            maxLeverage={selectedConfig?.maxLeverage}
            onConnect={connectWallet}
            onSubmitted={() => void loadAccount(walletAddress)}
            positionSize={positions.filter((item) => item.coin === selectedConfig?.providerCoin).reduce((total, item) => total + Math.abs(item.size), 0)}
            session={tradingSession}
            szDecimals={selectedConfig?.szDecimals}
            symbol={selectedSymbol}
          />
          <ConnectionPanel
            account={account}
            accountError={accountError}
            accountLoading={accountLoading}
            positions={positions}
          />
        </aside>
      </div>
    </div>
  );
}

function DepthAndTrades({ digits, markPrice, midPrice, orderbook, trades }: { digits: number; markPrice?: number | null; midPrice?: number | null; orderbook: RealOrderbook | null; trades: RealTrade[] }) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  const asks = orderbook?.asks.slice(0, 10) ?? [];
  const bids = orderbook?.bids.slice(0, 10) ?? [];
  return (
    <section className="xh-real-depth-panel">
      <div className="xh-real-depth-tabs" role="tablist" aria-label="真实盘口数据">
        <button className={tab === "book" ? "is-active" : ""} onClick={() => setTab("book")} role="tab" type="button">Order Book</button>
        <button className={tab === "trades" ? "is-active" : ""} onClick={() => setTab("trades")} role="tab" type="button">Recent Trades</button>
      </div>
      {tab === "book" ? (
        <>
          <div className="xh-real-book-head">
            <span>Price (USDT)</span><span>Size ({orderbook?.symbol?.replace("USDT", "") || "BTC"})</span><span>Total</span>
          </div>
          <BookSide levels={asks} digits={digits} tone="ask" />
          <div className="xh-real-book-mid">
            <strong>{formatBookPrice(midPrice ?? orderbook?.bids[0]?.price ?? orderbook?.asks.at(-1)?.price, digits)}</strong>
            <span className="xh-real-book-change">-</span>
            <span>Mark {formatBookPrice(markPrice, digits)}</span>
          </div>
          <BookSide levels={bids} digits={digits} tone="bid" />
        </>
      ) : (
        <div className="xh-real-trades-list">
          <div className="xh-real-book-head"><span>Side</span><span>Price</span><span>Size</span></div>
          {trades.length === 0 ? (
            <EmptyLine text="暂无真实成交数据。" />
          ) : trades.slice(0, 24).map((trade, index) => (
            <div key={trade.tradeId ?? trade.txHash ?? `${trade.timestamp}-${index}`} className="xh-real-book-row">
              <span className={trade.side === "sell" ? "text-red-300" : "text-emerald-300"}>{trade.side}</span>
              <span className="font-mono">{formatPrice(trade.price, digits)}</span>
              <span className="text-right font-mono text-muted">{trade.size}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BookSide({ digits, levels, tone }: { digits: number; levels: { price: number; size: number; total?: number }[]; tone: "ask" | "bid" }) {
  if (levels.length === 0) {
    return <EmptyLine text={tone === "ask" ? "暂无卖盘。" : "暂无买盘。"} />;
  }
  return (
    <div className="xh-real-book-side">
      {levels.map((level, index) => (
        <div key={`${tone}-${level.price}-${index}`} className={`xh-real-book-row is-${tone}`}>
          <span>{formatBookPrice(level.price, digits)}</span>
          <span>{level.size}</span>
          <span>{formatBookTotal(level, levels, index)}</span>
        </div>
      ))}
    </div>
  );
}

function ConnectionPanel({
  account,
  accountError,
  accountLoading,
  positions,
}: {
  account: RealAccountSummary | null;
  accountError: string;
  accountLoading: boolean;
  positions: RealPosition[];
}) {
  const contractEquity = account?.crossAccountValue ?? account?.accountValue;
  return (
    <section aria-busy={accountLoading} className="xh-real-account-panel">
      <h2 className="xh-real-account-title">账户权益</h2>
      <div className="xh-real-account-metrics">
        <AccountMetric label="现货" value={accountLoading ? "-" : formatAccountMoney(account?.spotUsdcBalance)} />
        <AccountMetric label="合约" value={accountLoading ? "-" : formatAccountMoney(contractEquity)} />
        <AccountMetric label="未实现盈亏" tone={numberTone(account?.totalUnrealizedPnl)} value={accountLoading ? "-" : formatAccountNumber(account?.totalUnrealizedPnl)} />
        <AccountMetric label="全仓保证金比率" value={accountLoading ? "-" : formatRatioPercent(account?.crossMarginRatio)} />
        <AccountMetric label="维持保证金" value={accountLoading ? "-" : formatAccountMoney(account?.crossMaintenanceMarginUsed)} />
        <AccountMetric label="全仓账户杠杆" value={accountLoading ? "-" : formatCrossLeverage(contractEquity, positions)} />
      </div>
      {accountError ? <p className="xh-real-account-error" role="alert">{accountError}</p> : null}
    </section>
  );
}

function RealRecords({
  accountLoading,
  bestAsk,
  bestBid,
  error,
  history,
  onCancelOrder,
  onCloseRequest,
  onTpslRequest,
  openOrders,
  positions,
}: {
  accountLoading: boolean;
  bestAsk?: number | null;
  bestBid?: number | null;
  error: string;
  history: RealOrderHistory | null;
  onCancelOrder: (order: RealOpenOrder) => Promise<void>;
  onCloseRequest: (request: RealPositionCloseRequest) => Promise<void>;
  onTpslRequest: (request: RealPositionTpslRequest) => Promise<void>;
  openOrders: RealOpenOrder[];
  positions: RealPosition[];
}) {
  const [tab, setTab] = useState<"positions" | "open" | "orders" | "fills">("positions");
  const tabs = [
    { key: "positions", label: "持仓", count: positions.length },
    { key: "open", label: "当前委托", count: openOrders.length },
    { key: "orders", label: "历史委托", count: history?.orders.length ?? 0 },
    { key: "fills", label: "历史成交", count: history?.fills.length ?? 0 },
  ] as const;
  return (
    <section className="xh-real-records">
      <div className="xh-real-record-tabs" role="tablist" aria-label="真实账户记录">
        {tabs.map((item) => (
          <button className={tab === item.key ? "is-active" : ""} key={item.key} onClick={() => setTab(item.key)} role="tab" type="button">
            {item.label} <span>{item.count}</span>
          </button>
        ))}
      </div>
      <StatePanel
        loading={accountLoading}
        error={error}
        empty={false}
        emptyText="-"
      >
        {tab === "positions" ? <RealPositionsTable bestAsk={bestAsk} bestBid={bestBid} onCloseRequest={onCloseRequest} onTpslRequest={onTpslRequest} openOrders={openOrders} rows={positions} /> : null}
        {tab === "open" ? <OrderTable emptyText="暂无当前委托。" onCancel={onCancelOrder} rows={openOrders} /> : null}
        {tab === "orders" ? <OrderTable emptyText="暂无历史委托。" rows={(history?.orders ?? []).map((item) => item.order ?? item)} /> : null}
        {tab === "fills" ? <FillTable rows={history?.fills ?? []} /> : null}
        {history?.warnings.length ? (
          <p className="border-t border-line px-4 py-3 text-xs text-amber-200" role="status">部分历史数据暂不可用：{history.warnings.join("；")}</p>
        ) : null}
      </StatePanel>
    </section>
  );
}

function OrderTable({ emptyText, onCancel, rows }: { emptyText: string; onCancel?: (order: RealOpenOrder) => Promise<void>; rows: RealOpenOrder[] }) {
  const [cancelingOid, setCancelingOid] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  async function cancel(order: RealOpenOrder) {
    if (!onCancel) return;
    const oid = String(order.oid ?? "");
    setCancelingOid(oid);
    setStatus("");
    try {
      await onCancel(order);
      setStatus("撤单请求已发送");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "撤单请求失败");
    } finally {
      setCancelingOid(null);
    }
  }

  return (
    <div className="xh-real-record-table">
      <div className={`xh-real-record-head ${onCancel ? "has-action" : ""}`}>
        <span>资产</span><span>方向</span><span>价格</span><span>数量</span><span>状态</span><span>OID</span><span>时间</span>{onCancel ? <span /> : null}
      </div>
      {rows.length === 0 ? <RecordEmpty text={emptyText} /> : rows.map((row, index) => {
        const oid = String(row.oid ?? "");
        return (
          <div className={`xh-real-record-row ${onCancel ? "has-action" : ""}`} key={`${row.oid ?? row.id}-${index}`}>
            <strong>{row.coin ?? "-"}</strong><span>{row.side ?? "-"}</span><span>{formatNumber(row.price)}</span><span>{formatNumber(row.size)}</span><span>{formatOrderType(row)}</span><span>{row.oid ?? "-"}</span><span>{formatTime(row.timestamp)}</span>
            {onCancel ? <button disabled={cancelingOid === oid} onClick={() => void cancel(row)} type="button">{cancelingOid === oid ? "撤单中" : "撤单"}</button> : null}
          </div>
        );
      })}
      {status ? <p className="xh-real-position-status" role="status">{status}</p> : null}
    </div>
  );
}

function FillTable({ rows }: { rows: RealOrderHistory["fills"] }) {
  return <div className="xh-real-record-table"><div className="xh-real-record-head"><span>资产</span><span>方向</span><span>价格</span><span>数量</span><span>已实现盈亏</span><span>OID</span><span>时间</span></div>{rows.length === 0 ? <RecordEmpty text="暂无真实成交。" /> : rows.map((row, index) => <div className="xh-real-record-row" key={`${row.tid ?? row.oid}-${index}`}><strong>{row.coin ?? "-"}</strong><span>{row.side ?? "-"}</span><span>{row.px ?? "-"}</span><span>{row.sz ?? "-"}</span><span>{row.closedPnl ?? "-"}</span><span>{row.oid ?? "-"}</span><span>{formatTime(row.time)}</span></div>)}</div>;
}

function RecordEmpty({ text }: { text: string }) {
  return <div className="xh-real-record-empty"><strong>{text}</strong></div>;
}

function StatePanel({
  children,
  empty,
  emptyText,
  error,
  loading,
  onRetry,
}: {
  children: ReactNode;
  empty: boolean;
  emptyText: string;
  error: string;
  loading: boolean;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3 p-6" aria-busy="true" aria-label="数据加载中">
        <div className="h-3 w-1/3 animate-pulse bg-white/10" />
        <div className="h-3 w-2/3 animate-pulse bg-white/10" />
        <div className="h-3 w-1/2 animate-pulse bg-white/10" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-8 text-center text-sm text-red-200" role="alert">
        <p>{error}</p>
        {onRetry ? <Button className="mt-4" onClick={onRetry} variant="secondary">重新加载</Button> : null}
      </div>
    );
  }
  if (empty) {
    return <div className="p-8 text-center text-sm text-muted">{emptyText}</div>;
  }
  return <>{children}</>;
}

function EmptyLine({ text }: { text: string }) {
  return <div className="border-b border-line px-4 py-3 text-sm text-muted">{text}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-2 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <strong className="min-w-0 truncate text-right font-mono text-white">{value}</strong>
    </div>
  );
}

function AccountMetric({ label, tone, value }: { label: string; tone?: "positive" | "negative"; value: string }) {
  return <div><span>{label}</span><strong className={tone ? `is-${tone}` : ""}>{value}</strong></div>;
}

function TradeStat({ label, tone, value }: { label: string; tone?: "positive" | "negative"; value: string }) {
  return (
    <div className={`xh-trade-stat ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "-";
}

function formatMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "-";
}

function formatPercent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(4)}%` : "-";
}

function formatCompactMoney(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
}

function formatAccountMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${formatAccountNumber(value)} USDC` : "-";
}

function formatAccountNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-";
}

function formatRatioPercent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "-";
}

function formatDayChange(change?: number | null, percent?: number | null) {
  if (typeof change !== "number" || !Number.isFinite(change)) return "-";
  const changeText = `${change >= 0 ? "+" : "-"}${Math.abs(change).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return typeof percent === "number" && Number.isFinite(percent)
    ? `${changeText} / ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`
    : changeText;
}

function formatCrossLeverage(accountValue: number | null | undefined, positions: RealPosition[]) {
  const notional = positions.reduce((sum, position) => {
    if (typeof position.size !== "number" || !Number.isFinite(position.size) || typeof position.markPx !== "number" || !Number.isFinite(position.markPx)) {
      return sum;
    }
    return sum + Math.abs(position.size * position.markPx);
  }, 0);
  if (notional === 0) return "0.00x";
  if (typeof accountValue !== "number" || !Number.isFinite(accountValue) || accountValue <= 0) return "-";
  return `${(notional / accountValue).toFixed(2)}x`;
}

function formatBookTotal(level: { total?: number; size: number }, levels: { size: number }[], index: number) {
  if (typeof level.total === "number" && Number.isFinite(level.total)) return formatNumber(level.total);
  return formatNumber(levels.slice(0, index + 1).reduce((sum, item) => sum + item.size, 0));
}

function formatBookPrice(value: number | null | undefined, digits: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "-";
}

function formatTime(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatOrderType(order: RealOpenOrder) {
  if (order.isTrigger) return order.orderType ?? order.triggerCondition ?? "TP/SL";
  return order.status ?? order.orderType ?? "-";
}

function numberTone(value?: number | null): "positive" | "negative" | undefined {
  if (typeof value !== "number" || value === 0) return undefined;
  return value > 0 ? "positive" : "negative";
}

function toneClass(tone?: "positive" | "negative") {
  return tone ? `is-${tone}` : "";
}

function multiplyFinite(left?: number | null, right?: number | null) {
  return typeof left === "number" && Number.isFinite(left) && typeof right === "number" && Number.isFinite(right) ? left * right : null;
}
