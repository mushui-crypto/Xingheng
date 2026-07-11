import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { LinkIcon, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select } from "../../components/ui/Select";
import {
  fetchRealAccountSummary,
  fetchRealCandles,
  fetchRealMarketSummary,
  fetchRealOpenOrders,
  fetchRealOrderHistory,
  fetchRealOrderbook,
  fetchRealPositions,
  fetchRealTrades,
  fetchRealTradingSymbols,
  type RealAccountSummary,
  type RealMarketSummary,
  type RealOpenOrder,
  type RealOrderHistory,
  type RealOrderbook,
  type RealPosition,
  type RealTrade,
  type RealTradingSymbol,
} from "../../api/realTrading";
import { getChartPriceFormat, normalizeChartCandles, toChartCandle } from "../../features/trading/lib/chart";
import { RealTradingOrderPanel } from "../../features/realTrading/components/RealTradingOrderPanel";
import { tradingIntervalLabels, tradingIntervals } from "../../features/trading/model/constants";
import type { CandleInterval } from "../../types";
import { formatPrice } from "../../utils/price";

const networkLabel = "Hyperliquid Testnet";

type BrowserEthereum = {
  request: (payload: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: "accountsChanged", listener: (accounts: unknown) => void) => void;
  removeListener?: (event: "accountsChanged", listener: (accounts: unknown) => void) => void;
};

function getBrowserEthereum() {
  return (window as Window & { ethereum?: BrowserEthereum }).ethereum;
}

export function RealTradePage() {
  const [symbols, setSymbols] = useState<RealTradingSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<CandleInterval>("15m");
  const [walletAddress, setWalletAddress] = useState("");
  const [marketSummary, setMarketSummary] = useState<RealMarketSummary | null>(null);
  const [orderbook, setOrderbook] = useState<RealOrderbook | null>(null);
  const [trades, setTrades] = useState<RealTrade[]>([]);
  const [account, setAccount] = useState<RealAccountSummary | null>(null);
  const [positions, setPositions] = useState<RealPosition[]>([]);
  const [openOrders, setOpenOrders] = useState<RealOpenOrder[]>([]);
  const [history, setHistory] = useState<RealOrderHistory | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [accountLoading, setAccountLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);
  const [marketError, setMarketError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [chartMessage, setChartMessage] = useState("");
  const [connectMessage, setConnectMessage] = useState("");
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const selectedConfig = symbols.find((item) => item.symbol === selectedSymbol) ?? null;
  const isConnected = Boolean(walletAddress);
  const digits = selectedConfig?.priceDecimals ?? 2;
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
      setPositions([]);
      setOpenOrders([]);
      setHistory(null);
      return;
    }
    setAccountLoading(true);
    setAccountError("");
    try {
      const [nextAccount, nextPositions, nextOpenOrders, nextHistory] = await Promise.all([
        fetchRealAccountSummary(address),
        fetchRealPositions(address),
        fetchRealOpenOrders(address),
        fetchRealOrderHistory(address),
      ]);
      setAccount(nextAccount);
      setPositions(nextPositions);
      setOpenOrders(nextOpenOrders);
      setHistory(nextHistory);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "真实账户数据加载失败。");
      setAccount(null);
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
    const ethereum = getBrowserEthereum();
    if (!ethereum?.on) {
      return;
    }

    const handleAccountsChanged = (accounts: unknown) => {
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      setWalletAddress(address);
      setConnectMessage(address ? "主账户地址已切换，正在刷新只读账户数据。" : "钱包已断开，真实账户数据已清空。");
      void loadAccount(address);
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    return () => ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!chartContainerRef.current) {
      return;
    }

    const chart = createChart(chartContainerRef.current, {
      height: 520,
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

    const resize = () => chart.applyOptions({ width: chartContainerRef.current?.clientWidth ?? 900 });
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
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
          setChartMessage("暂未取得可展示的真实 K 线数据。");
          return;
        }
        candleSeriesRef.current?.setData(candles.map(toChartCandle));
        chartRef.current?.timeScale().fitContent();
      } catch (error) {
        if (!cancelled) {
          candleSeriesRef.current?.setData([]);
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
    const ethereum = getBrowserEthereum();
    if (!ethereum?.request) {
      setConnectMessage("未检测到浏览器钱包。请使用支持 EIP-1193 的钱包连接主账户地址。");
      return;
    }
    try {
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      if (!address) {
        setConnectMessage("钱包未返回账户地址。");
        return;
      }
      setWalletAddress(address);
      await loadAccount(address);
      setConnectMessage("主账户地址已连接。当前仅启用只读账户查询，交易授权尚未接入。");
    } catch (error) {
      setConnectMessage(error instanceof Error ? error.message : "钱包连接失败。");
    }
  };

  return (
    <div className="xh-trade-terminal">
      <section className="xh-trade-marketbar">
        <div className="xh-trade-marketbar-main">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">{networkLabel}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em]">真实交易终端</h1>
          </div>
          <Badge tone="neutral">SDK 本地签名壳</Badge>
          <Badge tone={isConnected ? "success" : "danger"}>{isConnected ? "钱包已连接" : "未连接"}</Badge>
        </div>
        <div className="xh-trade-market-stats">
          <TradeStat label="Mark" value={formatPrice(marketSummary?.markPrice ?? undefined, digits)} />
          <TradeStat label="Oracle" value={formatPrice(marketSummary?.oraclePrice ?? undefined, digits)} />
          <TradeStat label="Mid" value={formatPrice(marketSummary?.midPrice ?? undefined, digits)} />
          <TradeStat label="24h Volume" value={formatNumber(marketSummary?.dayNotionalVolume)} />
          <TradeStat label="Open Interest" value={formatNumber(marketSummary?.openInterest)} />
          <TradeStat label="Funding" value={formatPercent(marketSummary?.funding)} />
          <TradeStat label="网络" value="Testnet" muted />
          <TradeStat label="状态" value={marketSummary?.status ?? (marketLoading ? "loading" : "-")} muted />
        </div>
      </section>

      <section className="xh-real-boundary">
        <ShieldCheck size={18} />
        <p>
          `/app/trade` 仅用于 Hyperliquid Testnet。当前已接入 SDK 本地签名与会话 API wallet 初始化壳；agent 授权成功前交易动作保持禁用。前端不会把 API wallet
          私钥写入 localStorage、IndexedDB、日志或发送给后端。
        </p>
      </section>

      <div className="xh-trade-grid">
        <main className="xh-trade-main">
          <section className="xh-trade-workbench">
            <Card className="xh-trade-chart-stage p-0">
              <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Select
                    label="真实交易品种"
                    options={symbolOptions}
                    value={selectedSymbol}
                    onChange={(event) => setSelectedSymbol(event.target.value)}
                    className="sm:min-w-[240px]"
                  />
                  <Button variant="secondary" onClick={() => void loadMarket(selectedSymbol)} disabled={marketLoading}>
                    <RefreshCw size={16} /> {marketLoading ? "刷新中" : "刷新市场"}
                  </Button>
                </div>
                <div className="no-scrollbar flex max-w-full overflow-x-auto border border-line bg-black p-1">
                  {tradingIntervals.map((item) => (
                    <button
                      key={item}
                      className={`shrink-0 px-2.5 py-1.5 text-sm transition sm:px-3 ${interval === item ? "bg-white text-black" : "text-muted hover:text-white"}`}
                      onClick={() => setInterval(item)}
                    >
                      {tradingIntervalLabels[item]}
                    </button>
                  ))}
                </div>
              </div>
              <StatePanel
                loading={marketLoading}
                error={marketError}
                empty={!marketSummary}
                emptyText="等待 /api/real-trading/market/* 返回真实 Testnet 行情。"
                onRetry={() => void loadMarket(selectedSymbol)}
              >
                <div className="relative border-t border-line bg-black/35">
                  <div ref={chartContainerRef} className="h-[360px] w-full sm:h-[460px] xl:h-[560px]" />
                  {chartLoading || chartMessage ? (
                    <div className="pointer-events-none absolute inset-x-4 top-4 border border-line bg-black/85 px-4 py-3 text-sm text-muted backdrop-blur">
                      {chartLoading ? "真实 K线加载中..." : chartMessage}
                    </div>
                  ) : null}
                </div>
              </StatePanel>
            </Card>

            <div className="xh-trade-depth-stage">
              <StatePanel
                loading={marketLoading}
                error={marketError}
                empty={!marketSummary}
                emptyText="等待 /api/real-trading/market/* 返回真实 Testnet 行情。"
                onRetry={() => void loadMarket(selectedSymbol)}
              >
                <DepthAndTrades orderbook={orderbook} trades={trades} digits={digits} />
              </StatePanel>
            </div>
          </section>

          <RealRecords
            accountLoading={accountLoading}
            address={walletAddress}
            error={accountError}
            history={history}
            openOrders={openOrders}
            positions={positions}
          />
        </main>

        <aside className="xh-trade-order-rail">
          <ConnectionPanel
            account={account}
            accountError={accountError}
            accountLoading={accountLoading}
            connectMessage={connectMessage}
            isConnected={isConnected}
            onConnect={connectWallet}
            onRefresh={() => void loadAccount(walletAddress)}
            walletAddress={walletAddress}
          />
          <RealTradingOrderPanel
            assetId={selectedConfig?.assetId}
            connected={isConnected}
            markPrice={marketSummary?.markPrice}
            maxLeverage={selectedConfig?.maxLeverage}
            onSubmitted={() => void loadAccount(walletAddress)}
            priceDecimals={selectedConfig?.priceDecimals}
            provider={getBrowserEthereum()}
            symbol={selectedSymbol}
            walletAddress={walletAddress}
          />
        </aside>
      </div>
    </div>
  );
}

function DepthAndTrades({ digits, orderbook, trades }: { digits: number; orderbook: RealOrderbook | null; trades: RealTrade[] }) {
  const asks = orderbook?.asks.slice(0, 8) ?? [];
  const bids = orderbook?.bids.slice(0, 8) ?? [];
  return (
    <div className="grid gap-4">
      <Card className="p-0">
        <div className="xh-trade-panel-header p-4">
          <h2>真实盘口</h2>
          <span>L2 · Testnet</span>
        </div>
        <div className="grid grid-cols-2 border-b border-line px-4 py-2 text-xs uppercase tracking-[0.12em] text-muted">
          <span>价格</span>
          <span className="text-right">数量</span>
        </div>
        <BookSide levels={asks} digits={digits} tone="ask" />
        <BookSide levels={bids} digits={digits} tone="bid" />
      </Card>
      <Card className="p-0">
        <div className="xh-trade-panel-header p-4">
          <h2>最新成交</h2>
          <span>Trades</span>
        </div>
        <div className="max-h-[220px] overflow-y-auto">
          {trades.length === 0 ? (
            <EmptyLine text="暂无真实成交数据。" />
          ) : trades.slice(0, 12).map((trade, index) => (
            <div key={trade.tradeId ?? trade.txHash ?? `${trade.timestamp}-${index}`} className="grid grid-cols-3 gap-2 border-b border-line px-4 py-2 text-xs">
              <span className={trade.side === "sell" ? "text-red-300" : "text-emerald-300"}>{trade.side}</span>
              <span className="font-mono">{formatPrice(trade.price, digits)}</span>
              <span className="text-right font-mono text-muted">{trade.size}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function BookSide({ digits, levels, tone }: { digits: number; levels: { price: number; size: number }[]; tone: "ask" | "bid" }) {
  if (levels.length === 0) {
    return <EmptyLine text={tone === "ask" ? "暂无卖盘。" : "暂无买盘。"} />;
  }
  return (
    <div>
      {levels.map((level, index) => (
        <div key={`${tone}-${level.price}-${index}`} className="grid grid-cols-2 border-b border-line px-4 py-2 text-xs">
          <span className={`font-mono ${tone === "ask" ? "text-red-300" : "text-emerald-300"}`}>{formatPrice(level.price, digits)}</span>
          <span className="text-right font-mono text-muted">{level.size}</span>
        </div>
      ))}
    </div>
  );
}

function ConnectionPanel({
  account,
  accountError,
  accountLoading,
  connectMessage,
  isConnected,
  onConnect,
  onRefresh,
  walletAddress,
}: {
  account: RealAccountSummary | null;
  accountError: string;
  accountLoading: boolean;
  connectMessage: string;
  isConnected: boolean;
  onConnect: () => void;
  onRefresh: () => void;
  walletAddress: string;
}) {
  return (
    <Card>
      <div className="xh-trade-panel-header">
        <h2>真实账户连接</h2>
        <span>{networkLabel}</span>
      </div>
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Button className="w-full" onClick={onConnect} variant={isConnected ? "secondary" : "primary"}>
            <LinkIcon size={16} /> {isConnected ? "切换钱包" : "连接钱包"}
          </Button>
          <Button className="w-full" disabled={!isConnected || accountLoading} onClick={onRefresh} variant="secondary">
            <RefreshCw size={16} /> {accountLoading ? "刷新中" : "刷新账户"}
          </Button>
        </div>
        <p className="break-all text-xs leading-5 text-muted">{walletAddress || "未连接主账户地址。不会读取或保存 API wallet 私钥。"}</p>
        {connectMessage ? <p className="border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">{connectMessage}</p> : null}
        {accountError ? (
          <div className="border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100" role="alert">
            <p>{accountError}</p>
            <button className="mt-2 font-semibold underline underline-offset-4" onClick={onRefresh} type="button">重试账户读取</button>
          </div>
        ) : null}
      </div>
      <div className="mt-4 grid gap-3">
        <Metric label="账户权益" value={accountLoading ? "加载中" : formatMoney(account?.accountValue)} />
        <Metric label="可用保证金" value={formatMoney(account?.availableMargin)} />
        <Metric label="已用保证金" value={formatMoney(account?.usedMargin)} />
        <Metric label="未实现盈亏" value={formatMoney(account?.totalUnrealizedPnl)} />
      </div>
    </Card>
  );
}

function RealRecords({
  accountLoading,
  address,
  error,
  history,
  openOrders,
  positions,
}: {
  accountLoading: boolean;
  address: string;
  error: string;
  history: RealOrderHistory | null;
  openOrders: RealOpenOrder[];
  positions: RealPosition[];
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line p-4">
        <h2 className="font-semibold">真实持仓 / 委托 / 历史</h2>
        <p className="mt-1 text-sm text-muted">{address ? `主账户：${address}` : "连接钱包后读取真实账户数据。"}</p>
      </div>
      <StatePanel
        loading={accountLoading}
        error={error}
        empty={!address}
        emptyText="未连接钱包，暂不请求真实账户接口。"
      >
        <div className="grid gap-0 divide-y divide-line xl:grid-cols-4 xl:divide-x xl:divide-y-0">
          <RecordColumn title="持仓" emptyText="暂无真实持仓。" rows={positions.map((item) => `${item.coin} · ${item.side} · ${item.size}`)} />
          <RecordColumn title="当前委托" emptyText="暂无当前委托。" rows={openOrders.map((item) => `${item.coin ?? "-"} · ${item.side ?? "-"} · ${item.status ?? "-"}`)} />
          <RecordColumn
            title="历史委托"
            emptyText="暂无历史委托。"
            rows={(history?.orders ?? []).map((item) => {
              const order = item.order ?? item;
              return `${order.coin ?? "-"} · ${order.side ?? "-"} · ${item.status ?? order.status ?? "-"}`;
            })}
          />
          <RecordColumn
            title="成交历史"
            emptyText="暂无真实成交。"
            rows={(history?.fills ?? []).map((item) => `${item.coin ?? "-"} · ${item.side ?? "-"} · ${item.sz ?? "-"} @ ${item.px ?? "-"}`)}
          />
        </div>
        {history?.warnings.length ? (
          <p className="border-t border-line px-4 py-3 text-xs text-amber-200" role="status">部分历史数据暂不可用：{history.warnings.join("；")}</p>
        ) : null}
      </StatePanel>
    </Card>
  );
}

function RecordColumn({ emptyText, rows, title }: { emptyText: string; rows: string[]; title: string }) {
  return (
    <div className="min-h-[180px] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3 space-y-2">
        {rows.length === 0 ? <p className="text-sm text-muted">{emptyText}</p> : rows.slice(0, 8).map((row, index) => (
          <p key={`${title}-${index}`} className="truncate border border-line bg-black px-3 py-2 text-sm text-slate-200">{row}</p>
        ))}
      </div>
    </div>
  );
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

function TradeStat({ label, muted = false, value }: { label: string; muted?: boolean; value: string }) {
  return (
    <div className="xh-trade-stat">
      <span>{label}</span>
      <strong className={muted ? "text-muted" : ""}>{value}</strong>
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
