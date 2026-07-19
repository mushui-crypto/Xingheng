import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { MarketSymbolPicker, type MarketPickerSymbol } from "../../components/trading/MarketSymbolPicker";
import {
  fetchRealAccountSummary,
  fetchRealCandles,
  fetchRealTradingCloidStatus,
  fetchRealTradingOrderAudit,
  fetchRealTradingReconciliation,
  fetchRealMarketSummary,
  fetchRealOrderbook,
  fetchRealPositions,
  fetchRealTrades,
  fetchRealTradingFees,
  fetchRealTradingOrderState,
  fetchRealTradingSymbols,
  normalizeRealFills,
  normalizeRealTradingOrderState,
  requestRealTradingRealtimeToken,
  type RealAccountSummary,
  type RealCandle,
  type RealMarketSummary,
  type RealOpenOrder,
  type RealOrderHistory,
  type RealTradingOrderState,
  type RealOrderbook,
  type RealPosition,
  type RealTrade,
  type RealTradingFees,
  type RealTradingReconciliationRecord,
  type RealTradingUserStreamEvent,
  type RealTradingSymbol,
} from "../../api/realTrading";
import { getChartPriceFormat, normalizeChartCandles, positionLatestCandleInInitialView, toChartCandle } from "../../features/trading/lib/chart";
import { RealTradingOrderPanel } from "../../features/realTrading/components/RealTradingOrderPanel";
import { RealPositionsTable } from "../../features/realTrading/components/RealPositionsTable";
import { MarketDepthPanel } from "../../features/trading/components/MarketDepthPanel";
import { TradeStat } from "../../features/trading/components/TradeStat";
import { Toast, useTradingToast } from "../../features/trading/components/TradingFeedback";
import type { RealPositionCloseRequest, RealPositionTpslRequest } from "../../features/realTrading/model/types";
import { enrichPositionMarks, preservePositionMarks } from "../../features/realTrading/lib/enrichPositionMarks";
import {
  transitionRealAccountRequestGeneration,
  withRealAccountLoadTimeout,
} from "../../features/realTrading/lib/accountLoad";
import { resolveRealTradingCategory } from "../../features/realTrading/lib/marketCategory";
import { resolvePositionSymbol, submitPositionCloseRequest, submitPositionTpslRequest } from "../../features/realTrading/lib/positionActions";
import {
  recordBelongsToMarket,
  resolveRealTradingSourceDex,
  resolveRealTradingSourceType,
  resolveRealTradingSymbolForRecord,
} from "../../features/realTrading/lib/realTradingMarket";
import { useHyperliquidSessionSigner } from "../../features/realTrading/lib/useHyperliquidSessionSigner";
import { getRealTradingDisplayPriceDecimals } from "../../features/realTrading/lib/realTradingDisplayPrecision";
import { presentRealFill } from "../../features/realTrading/model/realFillPresentation";
import { presentOrderLifecycleToast } from "../../features/realTrading/model/orderLifecycleToast";
import {
  initialRealTradingRealtimeState,
  extractExchangeOrderUpdates,
  normalizeRealTradingConnectionStatus,
  normalizeRealTradingOrderStatus,
  realTradingOrderStatusLabel,
  realTradingRealtimeReducer,
  type RealTradingConnectionStatus,
  type RealTradingOrderLifecycle,
} from "../../features/realTrading/model/realtimeState";
import {
  reconciliationRecordsToLifecycles,
  resolveReconciliationAccess,
} from "../../features/realTrading/model/reconciliationRecovery";
import { decideUserStreamReconnect } from "../../features/realTrading/model/userStreamReconnect";
import {
  decideRealTradingUserStreamSequence,
  parseRealTradingUserStreamEvent,
} from "../../features/realTrading/model/userStreamState";
import {
  buildAuthoritativeOrderLifecycles,
  lifecycleFromAuthoritativeOrder,
  lifecyclesFromActionFailure,
  lookupReconciliationWithCloidFallback,
  positionOperationKey,
} from "../../features/realTrading/model/reconciliation";
import { tradingIntervalLabels, tradingIntervals } from "../../features/trading/model/constants";
import { formatCompactMoney, formatFundingPercent, marketNumberTone, multiplyFinite } from "../../features/trading/lib/marketSummary";
import { useWalletConnectionStore } from "../../store/walletConnectionStore";
import type { CandleInterval } from "../../types";
import { formatPrice } from "../../utils/price";

const realCandlePollingIntervalMs = 2_000;
const realMarketPollingIntervalMs = 2_000;
const realMarketStaleAfterMs = 10_000;
const realOrderFallbackPollingIntervalMs = 5_000;
const realReconciliationPollingIntervalMs = 15_000;
const realUserStreamMaxReconnectAttempts = 5;

export function RealTradePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [symbols, setSymbols] = useState<RealTradingSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState(() => searchParams.get("symbol")?.toUpperCase() ?? "BTCUSDT");
  const [interval, setInterval] = useState<CandleInterval>("5m");
  const walletAddress = useWalletConnectionStore((state) => state.address);
  const walletProvider = useWalletConnectionStore((state) => state.provider);
  const requestWalletConnection = useWalletConnectionStore((state) => state.connect);
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
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);
  const [marketError, setMarketError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [positionsError, setPositionsError] = useState("");
  const [ordersError, setOrdersError] = useState("");
  const [chartMessage, setChartMessage] = useState("");
  const [latestCandle, setLatestCandle] = useState<RealCandle | null>(null);
  const [realtimeState, dispatchRealtime] = useReducer(realTradingRealtimeReducer, initialRealTradingRealtimeState);
  const [orderConnectionStatus, setOrderConnectionStatus] = useState<RealTradingConnectionStatus>("reconnecting");
  const [userStreamConnectionStatus, setUserStreamConnectionStatus] = useState<RealTradingConnectionStatus>("disconnected");
  const [userStreamRetryKey, setUserStreamRetryKey] = useState(0);
  const [reconciliationRecords, setReconciliationRecords] = useState<RealTradingReconciliationRecord[]>([]);
  const [reconciliationLoading, setReconciliationLoading] = useState(true);
  const [reconciliationError, setReconciliationError] = useState("");
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const orderSequenceRef = useRef<number | null>(null);
  const userStreamSequenceRef = useRef<number | null>(null);
  const accountRequestGenerationRef = useRef(0);
  const realtimePositionGenerationRef = useRef(0);
  const positionsRef = useRef<RealPosition[]>([]);
  const positionMarkSummaryRequestsRef = useRef(new Map<string, { expiresAt: number; request: Promise<RealMarketSummary> }>());
  const marketRequestGenerationRef = useRef(0);
  const marketRequestInFlightRef = useRef(false);
  const lifecycleToastKeysRef = useRef(new Set<string>());
  const previousWalletAddressRef = useRef<string | null>(null);
  const pageMountedAtRef = useRef(Date.now());
  const { dismissToast, showToast, toast } = useTradingToast();
  const tradingSession = useHyperliquidSessionSigner(walletProvider, walletAddress);

  const selectedConfig = symbols.find((item) => item.symbol === selectedSymbol) ?? null;
  const selectedPosition = positions.find((item) => (
    Math.abs(item.size) > 0
    && selectedConfig !== null
    && recordBelongsToMarket(item, selectedConfig, symbols)
  )) ?? null;
  const isConnected = Boolean(walletAddress);
  const effectiveConnectionStatus = isConnected
    ? combineConnectionStatuses(realtimeState.connectionStatus, orderConnectionStatus, userStreamConnectionStatus)
    : realtimeState.connectionStatus;
  const marketReady = effectiveConnectionStatus === "connected";
  const pendingReconciliationOrders = realtimeState.orders.filter((order) => order.status === "pending_reconciliation");

  function commitPositions(nextPositions: RealPosition[]) {
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
  }

  function commitAccountPositions(nextPositions: RealPosition[]) {
    realtimePositionGenerationRef.current += 1;
    commitPositions(nextPositions);
  }

  function fetchPositionMarkSummary(symbol: string) {
    const key = symbol.trim().toUpperCase();
    const now = Date.now();
    const cached = positionMarkSummaryRequestsRef.current.get(key);
    if (cached && cached.expiresAt > now) return cached.request;
    const request = fetchRealMarketSummary(key);
    positionMarkSummaryRequestsRef.current.set(key, { expiresAt: now + 5_000, request });
    return request;
  }

  function applyRealtimePositions(incoming: RealPosition[]) {
    const generation = ++realtimePositionGenerationRef.current;
    const preserved = preservePositionMarks(incoming, positionsRef.current);
    commitPositions(preserved);
    void enrichPositionMarks(preserved, fetchPositionMarkSummary).then((enriched) => {
      if (generation !== realtimePositionGenerationRef.current) return;
      commitPositions(preservePositionMarks(positionsRef.current, enriched));
    });
  }
  const reconciliationAccess = resolveReconciliationAccess(reconciliationRecords, reconciliationError);
  const reconciliationPending = reconciliationLoading || reconciliationAccess.blocksNewRisk || pendingReconciliationOrders.length > 0;
  const pendingOperationKeys = useMemo(
    () => [...new Set(pendingReconciliationOrders.flatMap((order) => order.operationKey ? [order.operationKey] : []))],
    [pendingReconciliationOrders],
  );
  const pendingOperationSet = useMemo(() => new Set(pendingOperationKeys), [pendingOperationKeys]);
  const digits = getRealTradingDisplayPriceDecimals(selectedConfig?.pxDecimals);
  const pickerSymbols = useMemo<MarketPickerSymbol[]>(
    () => {
      const availableSymbols: RealTradingSymbol[] = symbols.length > 0
        ? symbols
        : [{ symbol: selectedSymbol, providerCoin: "BTC", status: "pending" }];
      return availableSymbols.map((item) => ({
        apiSymbol: item.providerCoin,
        category: resolveRealTradingCategory(
          item.providerMarketId,
          item.category,
          resolveRealTradingSourceType(item),
        ),
        displayName: item.providerCoin,
        iconUrl: item.iconUrl,
        id: item.assetId ?? item.symbol,
        leverage: item.maxLeverage,
        providerCoin: item.providerCoin,
        providerMarketId: item.providerMarketId,
        sourceDex: resolveRealTradingSourceDex(item),
        sourceType: resolveRealTradingSourceType(item),
        symbol: item.symbol,
      }));
    },
    [selectedSymbol, symbols],
  );
  const wsUrl = useMemo(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }, []);

  useEffect(() => {
    if (!tradingSession.message) return;
    showToast(
      tradingSession.message,
      tradingSession.messageTone === "error"
        ? "error"
        : tradingSession.messageTone === "success"
          ? "success"
          : "warning",
    );
  }, [showToast, tradingSession.message, tradingSession.messageTone]);

  useEffect(() => {
    const order = realtimeState.orders[0];
    if (!order) return;
    const toastPresentation = presentOrderLifecycleToast(order);
    if (lifecycleToastKeysRef.current.has(toastPresentation.key)) return;
    lifecycleToastKeysRef.current.add(toastPresentation.key);
    if (order.updatedAt < pageMountedAtRef.current) return;
    showToast(toastPresentation.message, toastPresentation.tone);
  }, [realtimeState.orders, showToast]);

  const loadMarket = async (
    symbol = selectedSymbol,
    options: { background?: boolean; includeSymbols?: boolean } = {},
  ) => {
    const background = options.background === true;
    if (background && marketRequestInFlightRef.current) return;
    const requestGeneration = ++marketRequestGenerationRef.current;
    marketRequestInFlightRef.current = true;
    const includeSymbols = options.includeSymbols !== false;
    if (!background) dispatchRealtime({ type: "retry_requested" });
    if (!background) {
      setMarketLoading(true);
      setMarketError("");
      setMarketSummary(null);
      setOrderbook(null);
      setTrades([]);
    }
    try {
      const [nextSymbols, nextSummary, nextOrderbook, nextTrades] = await Promise.all([
        includeSymbols ? fetchRealTradingSymbols() : Promise.resolve<RealTradingSymbol[] | null>(null),
        fetchRealMarketSummary(symbol),
        fetchRealOrderbook(symbol),
        fetchRealTrades(symbol),
      ]);
      if (requestGeneration !== marketRequestGenerationRef.current) return;
      if (nextSymbols) {
        setSymbols(nextSymbols);
        if (nextSymbols.length > 0 && !nextSymbols.some((item) => item.symbol === symbol)) {
          setSelectedSymbol(nextSymbols[0].symbol);
        }
      }
      setMarketSummary(nextSummary);
      setOrderbook(nextOrderbook);
      setTrades(nextTrades);
      setMarketError("");
      dispatchRealtime({
        type: "heartbeat",
        at: Date.now(),
        status: resolveMarketConnectionStatus(nextSummary, nextOrderbook),
      });
    } catch (error) {
      if (requestGeneration !== marketRequestGenerationRef.current) return;
      if (!background) {
        setMarketError(error instanceof Error ? error.message : "真实交易市场数据加载失败。");
        setMarketSummary(null);
        setOrderbook(null);
        setTrades([]);
      }
      dispatchRealtime({ type: "connection_failed" });
    } finally {
      if (requestGeneration === marketRequestGenerationRef.current) {
        marketRequestInFlightRef.current = false;
        if (!background) setMarketLoading(false);
      }
    }
  };

  useEffect(() => {
    setSearchParams((current) => {
      if (current.get("symbol") === selectedSymbol) return current;
      const next = new URLSearchParams(current);
      next.set("symbol", selectedSymbol);
      return next;
    }, { replace: true });
  }, [selectedSymbol, setSearchParams]);

  const applyOrderState = (nextState: RealTradingOrderState) => {
    const connectionStatus = normalizeRealTradingConnectionStatus(nextState.status) ?? "connected";
    setOrderConnectionStatus(connectionStatus);
    if (nextState.mode === "snapshot") {
      orderSequenceRef.current = nextState.sequence;
      if (nextState.stale || nextState.reconnecting || connectionStatus !== "connected") {
        dispatchRealtime({ type: "snapshot_started" });
        return;
      }
      const nextHistory = { orders: nextState.orders, fills: nextState.fills, nextCursor: null, warnings: nextState.warnings };
      setOpenOrders(nextState.openOrders);
      setHistory(nextHistory);
      dispatchRealtime({ type: "snapshot_succeeded", orders: buildAuthoritativeOrderLifecycles(nextState.openOrders, nextHistory, nextState.timestamp) });
      return;
    }

    if (orderSequenceRef.current !== nextState.baseSequence) {
      orderSequenceRef.current = null;
      setOpenOrders([]);
      setHistory(null);
      dispatchRealtime({ type: "snapshot_started" });
      return;
    }
    orderSequenceRef.current = nextState.sequence;
    setOpenOrders((current) => applyOpenOrderIncremental(current, nextState));
    setHistory((current) => applyHistoryIncremental(current, nextState));
    lifecycleUpdatesFromIncremental(nextState).forEach((order) => dispatchRealtime({ type: "order_updated", order }));
  };

  const refreshOrderState = async (address: string, forceSnapshot = false) => {
    const state = await fetchRealTradingOrderState(address, forceSnapshot ? null : orderSequenceRef.current);
    applyOrderState(state);
  };

  const loadAccount = async (address = walletAddress, forceSnapshot = false) => {
    const requestGeneration = transitionRealAccountRequestGeneration(
      accountRequestGenerationRef.current,
      "request_started",
    );
    accountRequestGenerationRef.current = requestGeneration;
    if (forceSnapshot) orderSequenceRef.current = null;
    const needsSnapshot = orderSequenceRef.current === null;
    if (needsSnapshot) {
      setOrderConnectionStatus("reconnecting");
      dispatchRealtime({ type: "snapshot_started" });
      setAccount(null);
      setFees(null);
      commitAccountPositions([]);
      setOpenOrders([]);
      setHistory(null);
    }
    if (!address) {
      setAccountLoading(false);
      setPositionsLoading(false);
      setOrdersLoading(false);
      setAccountError("");
      setPositionsError("");
      setOrdersError("");
      orderSequenceRef.current = null;
      setOrderConnectionStatus("connected");
      dispatchRealtime({ type: "snapshot_succeeded", orders: [] });
      return;
    }
    setAccountLoading(true);
    setPositionsLoading(true);
    setOrdersLoading(true);
    setAccountError("");
    setPositionsError("");
    setOrdersError("");
    let failureRecorded = false;
    const recordFailure = (error: unknown, setResourceError?: (message: string) => void) => {
      if (requestGeneration !== accountRequestGenerationRef.current) return;
      const message = error instanceof Error ? error.message : "真实账户部分数据加载失败。";
      setResourceError?.(message);
      if (failureRecorded) return;
      failureRecorded = true;
      setAccountError(message);
      setOrderConnectionStatus("stale");
      dispatchRealtime({ type: "snapshot_failed", message });
    };
    const loadResource = async <T,>(
      request: Promise<T>,
      resourceLabel: string,
      commit: (value: T) => void,
      setResourceError?: (message: string) => void,
    ) => {
      try {
        const value = await withRealAccountLoadTimeout(request, resourceLabel);
        if (requestGeneration === accountRequestGenerationRef.current) commit(value);
      } catch (error) {
        recordFailure(error, setResourceError);
      }
    };
    try {
      const accountTask = Promise.all([
        loadResource(fetchRealAccountSummary(address), "真实账户", setAccount),
        loadResource(fetchRealTradingFees(address), "真实交易费率", setFees),
      ]).finally(() => {
        if (requestGeneration === accountRequestGenerationRef.current) setAccountLoading(false);
      });
      const positionsTask = loadResource(fetchRealPositions(address), "真实持仓", applyRealtimePositions, setPositionsError)
        .finally(() => {
          if (requestGeneration === accountRequestGenerationRef.current) setPositionsLoading(false);
        });
      const ordersTask = loadResource(
        fetchRealTradingOrderState(address, needsSnapshot ? null : orderSequenceRef.current),
        "真实订单状态",
        applyOrderState,
        setOrdersError,
      ).finally(() => {
        if (requestGeneration === accountRequestGenerationRef.current) setOrdersLoading(false);
      });
      await Promise.all([accountTask, positionsTask, ordersTask]);
    } finally {
      if (requestGeneration === accountRequestGenerationRef.current) {
        setAccountLoading(false);
        setPositionsLoading(false);
        setOrdersLoading(false);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (cancelled || refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        await loadMarket(selectedSymbol, { background: true, includeSymbols: false });
      } finally {
        refreshing = false;
      }
    };
    void loadMarket(selectedSymbol);
    const timer = window.setInterval(() => void refresh(), realMarketPollingIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  useEffect(() => {
    const previousAddress = previousWalletAddressRef.current;
    previousWalletAddressRef.current = walletAddress;
    orderSequenceRef.current = null;
    if (walletAddress) {
      if (previousAddress !== null && previousAddress !== walletAddress) {
        showToast(previousAddress ? "主账户地址已切换，正在刷新只读账户数据。" : "钱包连接已恢复，正在刷新只读账户数据。", "warning");
      }
      void loadAccount(walletAddress, true);
      return;
    }
    accountRequestGenerationRef.current = transitionRealAccountRequestGeneration(
      accountRequestGenerationRef.current,
      "wallet_session_changed",
    );
    realtimePositionGenerationRef.current += 1;
    userStreamSequenceRef.current = null;
    positionMarkSummaryRequestsRef.current.clear();
    setAccount(null);
    setFees(null);
    setAccountLoading(false);
    setPositionsLoading(false);
    setOrdersLoading(false);
    commitPositions([]);
    setOpenOrders([]);
    setHistory(null);
    setAccountError("");
    setPositionsError("");
    setOrdersError("");
    setOrderConnectionStatus("connected");
    dispatchRealtime({ type: "snapshot_succeeded", orders: [] });
    if (previousAddress) showToast("钱包已断开，真实账户数据已清空。", "warning");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    let loading = false;
    const refresh = async (initial = false) => {
      if (!active || loading || document.visibilityState === "hidden") return;
      loading = true;
      controller?.abort();
      controller = new AbortController();
      if (initial) setReconciliationLoading(true);
      setReconciliationError("");
      try {
        const response = await fetchRealTradingReconciliation(controller.signal);
        if (!active) return;
        setReconciliationRecords(response.records);
        dispatchRealtime({
          type: "reconciliation_synchronized",
          orders: reconciliationRecordsToLifecycles(response.records),
        });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "真实交易待对账状态加载失败。";
        setReconciliationRecords([]);
        setReconciliationError(message);
        dispatchRealtime({ type: "reconciliation_synchronized", orders: [] });
      } finally {
        if (active) setReconciliationLoading(false);
        loading = false;
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), realReconciliationPollingIntervalMs);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!walletAddress) return;
    if (orderConnectionStatus === "connected") return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (cancelled || polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        await refreshOrderState(walletAddress);
      } catch {
        if (!cancelled) setOrderConnectionStatus("stale");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), realOrderFallbackPollingIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orderConnectionStatus, walletAddress]);

  useEffect(() => {
    if (!walletAddress) {
      userStreamSequenceRef.current = null;
      setUserStreamConnectionStatus("disconnected");
      return;
    }
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const markAuthoritativeUserStateRecovering = () => {
      accountRequestGenerationRef.current = transitionRealAccountRequestGeneration(
        accountRequestGenerationRef.current,
        "realtime_recovering",
      );
      orderSequenceRef.current = null;
      dispatchRealtime({ type: "snapshot_started" });
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const decision = decideUserStreamReconnect(reconnectAttempt, realUserStreamMaxReconnectAttempts);
      if (decision.exhausted) {
        setUserStreamConnectionStatus("disconnected");
        setAccountError("真实交易用户流连续重连失败，已停止自动重试；可手动重新连接。安全退出仍可通过权威快照执行。");
        return;
      }
      setUserStreamConnectionStatus("reconnecting");
      markAuthoritativeUserStateRecovering();
      reconnectAttempt = decision.nextAttempt;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, decision.delayMs);
    };

    const applyStreamEvent = (event: RealTradingUserStreamEvent) => {
      const sequenceDecision = decideRealTradingUserStreamSequence(userStreamSequenceRef.current, event);
      if (sequenceDecision === "ignore") return;
      if (sequenceDecision === "gap") {
        setAccountError("真实交易实时序列不连续，正在恢复权威快照。");
        userStreamSequenceRef.current = null;
        socket?.close();
        scheduleReconnect();
        return;
      }
      userStreamSequenceRef.current = event.sequence;
      const connectionStatus = normalizeRealTradingConnectionStatus(event.status) ?? "reconnecting";
      setUserStreamConnectionStatus(connectionStatus);
      if (event.stale || event.reconnecting || connectionStatus !== "connected") {
        markAuthoritativeUserStateRecovering();
        return;
      }
      setAccountError("");
      reconnectAttempt = 0;
      if (event.channel === "snapshot") {
        if (!applyUserStreamSnapshot(event.data, applyOrderState, setAccount, applyRealtimePositions)) {
          setAccountError("真实交易实时快照格式异常，正在重新同步。");
          socket?.close();
        }
        return;
      }
      if (event.channel === "open_orders" && Array.isArray(event.data)) {
        const nextOrders = event.data as RealOpenOrder[];
        setOpenOrders(nextOrders);
        buildAuthoritativeOrderLifecycles(nextOrders, emptyRealOrderHistory(), event.timestamp).forEach((order) => {
          dispatchRealtime({ type: "order_updated", order });
        });
        return;
      }
      if (event.channel === "orders" && Array.isArray(event.data)) {
        const nextOrders = event.data as RealOrderHistory["orders"];
        setHistory((current) => mergeStreamOrders(current, nextOrders));
        buildAuthoritativeOrderLifecycles([], { ...emptyRealOrderHistory(), orders: nextOrders }, event.timestamp).forEach((order) => {
          dispatchRealtime({ type: "order_updated", order });
        });
        return;
      }
      if (event.channel === "fills" && Array.isArray(event.data)) {
        const nextFills = normalizeRealFills(event.data);
        setHistory((current) => mergeStreamFills(current, nextFills));
        buildAuthoritativeOrderLifecycles([], { ...emptyRealOrderHistory(), fills: nextFills }, event.timestamp).forEach((order) => {
          dispatchRealtime({ type: "order_updated", order });
        });
        return;
      }
      if (event.channel === "account") {
        if (!applyUserStreamAccount(event.data, setAccount, applyRealtimePositions)) {
          setAccountError("真实交易账户增量格式异常，正在重新同步。");
          socket?.close();
        }
      }
    };

    async function connect() {
      if (cancelled) return;
      setUserStreamConnectionStatus("reconnecting");
      try {
        const grant = await requestRealTradingRealtimeToken(walletAddress);
        if (cancelled) return;
        socket = new WebSocket(wsUrl);
        socket.addEventListener("open", () => {
          if (cancelled || !socket) return;
          socket.send(JSON.stringify({ type: "subscribe", channel: "real-trading-user", token: grant.token }));
        });
        socket.addEventListener("message", (message) => {
          if (cancelled) return;
          let payload: unknown;
          try {
            payload = JSON.parse(String(message.data));
          } catch {
            return;
          }
          const event = parseRealTradingUserStreamEvent(payload, walletAddress);
          if (event) {
            applyStreamEvent(event);
            return;
          }
          if (isSocketError(payload)) {
            setAccountError(payload.message);
            socket?.close();
          }
        });
        socket.addEventListener("close", () => {
          if (!cancelled) scheduleReconnect();
        });
        socket.addEventListener("error", () => socket?.close());
      } catch (error) {
        if (!cancelled) {
          setAccountError(error instanceof Error ? error.message : "真实交易实时订阅失败。");
          scheduleReconnect();
        }
      }
    }

    userStreamSequenceRef.current = null;
    setUserStreamConnectionStatus("reconnecting");
    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
    // The stream owns its reconnect lifecycle; account/symbol renders must not create parallel sockets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userStreamRetryKey, walletAddress, wsUrl]);

  useEffect(() => {
    if (!walletAddress || pendingReconciliationOrders.length === 0) return;
    let cancelled = false;
    let checking = false;
    const reconcile = async () => {
      if (cancelled || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const results = await Promise.allSettled(pendingReconciliationOrders.map((order) => lookupReconciliationWithCloidFallback(
          { address: walletAddress, cloid: order.clientOrderId, requestId: order.requestId },
          { fetchAudit: fetchRealTradingOrderAudit, fetchCloid: fetchRealTradingCloidStatus },
        )));
        if (cancelled) return;
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") return;
          const pending = pendingReconciliationOrders[index];
          if (result.value.kind === "audit") {
            const audit = result.value.value;
            if (audit.reconcileRequired) return;
            dispatchRealtime({
              type: "order_updated",
              order: {
                ...pending,
                message: audit.errorCategory ?? undefined,
                requestId: audit.requestId,
                status: normalizeRealTradingOrderStatus(audit.orderState) ?? "accepted",
                updatedAt: audit.timestamp,
              },
            });
            return;
          }
          const cloidStatus = result.value.value;
          if (cloidStatus.status !== "order" || !cloidStatus.order) return;
          const lifecycle = lifecycleFromAuthoritativeOrder(cloidStatus.order, "accepted", pending.clientOrderId, cloidStatus.timestamp);
          dispatchRealtime({ type: "order_updated", order: { ...lifecycle, clientOrderId: pending.clientOrderId, updatedAt: cloidStatus.timestamp } });
        });
      } finally {
        checking = false;
      }
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), realOrderFallbackPollingIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingReconciliationOrders.map((order) => `${order.clientOrderId}:${order.requestId ?? ""}`).join("|"), walletAddress]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      dispatchRealtime({ type: "heartbeat_timeout", at: Date.now(), staleAfterMs: realMarketStaleAfterMs });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

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
    let latestCandleTime = Number.NEGATIVE_INFINITY;
    let polling = false;
    let pollingTimer: number | undefined;

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
        const latest = candles[candles.length - 1];
        latestCandleTime = latest.time;
        setLatestCandle(latest);
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

    async function refreshLatestCandle() {
      if (cancelled || polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const candles = normalizeChartCandles(await fetchRealCandles(selectedSymbol, interval, 2));
        if (cancelled || candles.length === 0) return;
        const latest = candles[candles.length - 1];
        if (latest.time < latestCandleTime) return;
        candleSeriesRef.current?.update(toChartCandle(latest));
        latestCandleTime = latest.time;
        setLatestCandle(latest);
        setChartMessage("");
      } catch {
        // Keep the last valid candle visible; the next polling tick retries automatically.
      } finally {
        polling = false;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void refreshLatestCandle();
      }
    }

    void loadChart().finally(() => {
      if (!cancelled) {
        pollingTimer = window.setInterval(() => void refreshLatestCandle(), realCandlePollingIntervalMs);
      }
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollingTimer !== undefined) {
        window.clearInterval(pollingTimer);
      }
    };
  }, [interval, selectedSymbol]);

  const connectWallet = async () => {
    try {
      await requestWalletConnection();
      showToast("主账户地址已连接。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "钱包连接失败。", "error");
    }
  };

  const runTrackedPositionAction = async (
    cloid: string,
    symbol: string,
    operationKeys: string[],
    action: Parameters<typeof tradingSession.runActionResult>[0],
    successMessage: string,
  ) => {
    const lifecycleBase = { clientOrderId: cloid, operationKey: operationKeys[0], symbol, updatedAt: Date.now() };
    dispatchRealtime({ type: "order_submitted", order: { ...lifecycleBase, status: "submitted" } });
    const outcome = await tradingSession.runActionResult(action, successMessage);
    if (!outcome.completed) {
      lifecyclesFromActionFailure({ cloid, operationKeys, outcome, symbol, updatedAt: Date.now() }).forEach((order) => {
        dispatchRealtime({ type: "order_updated", order });
      });
      if (outcome.reconciliationRequired) {
        throw new Error("交易结果未知，正在使用原 requestId / cloid 对账；对账完成前不会重复提交。");
      }
      throw new Error(outcome.error || "交易请求未完成，请查看下单区状态。");
    }
    extractExchangeOrderUpdates(outcome.result, { ...lifecycleBase, updatedAt: Date.now() }).forEach((order, index) => {
      dispatchRealtime({ type: "order_updated", order: { ...order, operationKey: operationKeys[index] ?? operationKeys[0] } });
    });
    await loadAccount(walletAddress);
  };

  const handlePositionClose = async (request: RealPositionCloseRequest) => {
    const operationKeys = request.positions.map((position) => positionOperationKey(position, "exposure"));
    if (operationKeys.some((key) => pendingOperationSet.has(key))) {
      throw new Error("该持仓已有结果未知的平仓或反手请求，权威对账完成前不会重复提交。");
    }
    await runTrackedPositionAction(
      request.cloid,
      request.positions[0]?.symbol ?? request.positions[0]?.coin ?? selectedSymbol,
      operationKeys,
      (signer) => submitPositionCloseRequest(signer, request, symbols),
      request.scope === "all" ? "全部平仓请求已发送。" : request.mode === "reverse" ? "反手请求已发送。" : "平仓请求已发送。",
    );
  };

  const handleCancelOrder = async (order: RealOpenOrder) => {
    const config = resolveRealTradingSymbolForRecord(order, symbols);
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
    const operationKey = positionOperationKey(request.position, "tpsl");
    if (pendingOperationSet.has(operationKey)) {
      throw new Error("该持仓已有结果未知的止盈止损请求，权威对账完成前不会重复提交。");
    }
    const config = resolvePositionSymbol(request.position, symbols);
    const currentTriggers = openOrders.filter((order) => (
      order.isTrigger && recordBelongsToMarket(order, config, symbols)
    ));
    const existingTriggers = currentTriggers.map((order) => {
      const oid = Number(order.oid);
      if (!Number.isSafeInteger(oid) || oid <= 0) throw new Error("当前止盈止损委托缺少有效 OID，无法安全替换。");
      return { asset: config.assetId!, oid };
    });
    await runTrackedPositionAction(
      request.cloid,
      request.position.symbol ?? request.position.coin,
      [operationKey],
      async (signer) => {
        if (existingTriggers.length > 0) await signer.cancelOrders(existingTriggers);
        return submitPositionTpslRequest(signer, request, symbols);
      },
      "止盈止损请求已发送。",
    );
  };

  const retryRealtimeSnapshot = async () => {
    showToast("正在重新连接真实行情与账户状态。", "info");
    userStreamSequenceRef.current = null;
    setUserStreamRetryKey((current) => current + 1);
    await Promise.all([
      loadMarket(selectedSymbol),
      walletAddress ? loadAccount(walletAddress, true) : Promise.resolve(),
    ]);
  };

  return (
    <div className="xh-trade-terminal xh-real-trade-terminal">
      <Toast onDismiss={dismissToast} toast={toast} />
      <section className="xh-trade-marketbar">
        <div className="xh-trade-marketbar-main">
          <MarketSymbolPicker
            context="real"
            onSelect={setSelectedSymbol}
            selectedSymbol={selectedSymbol}
            symbols={pickerSymbols}
            triggerVariant="terminal"
          />
          <span className="xh-real-market-badge">PERP · REAL</span>
        </div>
        <div className="xh-trade-market-stats">
          <TradeStat label="Mark" value={formatPrice(marketSummary?.markPrice ?? undefined, digits)} />
          <TradeStat label="24h Change" value={formatRealMarketDayChange(marketSummary?.dayChange, marketSummary?.dayChangePercent, digits)} tone={marketNumberTone(marketSummary?.dayChange)} />
          <TradeStat label="24h Volume" value={formatCompactMoney(marketSummary?.dayNotionalVolume)} />
          <TradeStat label="Open Interest" value={formatCompactMoney(multiplyFinite(marketSummary?.openInterest, marketSummary?.markPrice))} />
          <TradeStat label="Funding" value={formatFundingPercent(marketSummary?.funding)} tone={marketNumberTone(marketSummary?.funding)} />
          <TradeStat
            actionLabel={effectiveConnectionStatus === "stale" || effectiveConnectionStatus === "disconnected" ? "重新连接真实行情" : undefined}
            label="Status"
            onAction={effectiveConnectionStatus === "stale" || effectiveConnectionStatus === "disconnected" ? () => void retryRealtimeSnapshot() : undefined}
            value={connectionStatusLabel(effectiveConnectionStatus)}
            tone={marketReady ? "positive" : undefined}
          />
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
                  <span /> Hyperliquid · REST + USER WS
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
                <span>24h&nbsp; <b className={toneClass(marketNumberTone(marketSummary?.dayChange))}>{formatRealMarketDayChange(marketSummary?.dayChange, marketSummary?.dayChangePercent, digits)}</b></span>
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
                <MarketDepthPanel ariaLabel="真实盘口数据" orderbook={orderbook} trades={trades} digits={digits} markPrice={marketSummary?.markPrice} midPrice={marketSummary?.midPrice} />
              </StatePanel>
            </div>
          </section>

          <RealRecords
            pendingOperationKeys={pendingOperationKeys}
            riskIncreasingActionsBlocked={!marketReady || Boolean(accountError) || reconciliationPending}
            ordersLoading={ordersLoading}
            ordersError={ordersError}
            positionsLoading={positionsLoading}
            positionsError={positionsError}
            bestAsk={orderbook?.asks[0]?.price}
            bestBid={orderbook?.bids[0]?.price}
            history={history}
            onCancelOrder={handleCancelOrder}
            onCloseRequest={handlePositionClose}
            onFeedback={showToast}
            onSelectSymbol={setSelectedSymbol}
            onTpslRequest={handlePositionTpsl}
            openOrders={openOrders}
            positions={positions}
            symbols={symbols}
          />
        </main>

        <aside className="xh-trade-order-rail">
          <RealTradingOrderPanel
            assetId={selectedConfig?.assetId}
            availableMargin={account?.availableMargin ?? account?.withdrawable}
            bestAsk={orderbook?.asks[0]?.price}
            bestBid={orderbook?.bids[0]?.price}
            connected={isConnected}
            markPrice={marketSummary?.markPrice}
            fees={fees}
            marginModeConstraint={selectedConfig?.marginModeConstraint}
            marketReady={marketReady && !accountError}
            maxLeverage={selectedConfig?.maxLeverage}
            onConnect={connectWallet}
            onOrderLifecycle={(phase, order) => dispatchRealtime({ type: phase === "submitted" ? "order_submitted" : "order_updated", order })}
            onSubmitted={() => loadAccount(walletAddress)}
            pendingOperationKeys={pendingOperationKeys}
            reconciliationError={reconciliationError}
            reconciliationLoading={reconciliationLoading}
            reconciliationMessage={reconciliationAccess.message}
            reconciliationPending={reconciliationPending}
            reconciliationRecords={reconciliationRecords}
            position={selectedPosition}
            positionSize={selectedPosition ? Math.abs(selectedPosition.size) : 0}
            session={tradingSession}
            supportedMarginModes={selectedConfig?.supportedMarginModes}
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

function formatRealMarketDayChange(change: number | null | undefined, percent: number | null | undefined, digits: number) {
  if (typeof change !== "number" || !Number.isFinite(change)) return "-";
  const changeText = `${change >= 0 ? "+" : "-"}${Math.abs(change).toFixed(digits)}`;
  return typeof percent === "number" && Number.isFinite(percent)
    ? `${changeText} / ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`
    : changeText;
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
        <AccountMetric label="未实现盈亏" tone={marketNumberTone(account?.totalUnrealizedPnl)} value={accountLoading ? "-" : formatAccountNumber(account?.totalUnrealizedPnl)} />
        <AccountMetric label="全仓保证金比率" value={accountLoading ? "-" : formatRatioPercent(account?.crossMarginRatio)} />
        <AccountMetric label="维持保证金" value={accountLoading ? "-" : formatAccountMoney(account?.crossMaintenanceMarginUsed)} />
        <AccountMetric label="全仓账户杠杆" value={accountLoading ? "-" : formatCrossLeverage(contractEquity, positions)} />
      </div>
      {accountError ? <p className="xh-real-account-error" role="alert">{accountError}</p> : null}
    </section>
  );
}

function RealRecords({
  bestAsk,
  bestBid,
  history,
  onCancelOrder,
  onCloseRequest,
  onFeedback,
  onSelectSymbol,
  onTpslRequest,
  openOrders,
  ordersLoading,
  ordersError,
  positions,
  positionsLoading,
  positionsError,
  pendingOperationKeys,
  riskIncreasingActionsBlocked,
  symbols,
}: {
  bestAsk?: number | null;
  bestBid?: number | null;
  history: RealOrderHistory | null;
  onCancelOrder: (order: RealOpenOrder) => Promise<void>;
  onCloseRequest: (request: RealPositionCloseRequest) => Promise<void>;
  onFeedback: (message: string, tone: "error" | "info" | "success" | "warning") => void;
  onSelectSymbol: (symbol: string) => void;
  onTpslRequest: (request: RealPositionTpslRequest) => Promise<void>;
  openOrders: RealOpenOrder[];
  ordersLoading: boolean;
  ordersError: string;
  positions: RealPosition[];
  positionsLoading: boolean;
  positionsError: string;
  pendingOperationKeys: string[];
  riskIncreasingActionsBlocked: boolean;
  symbols: RealTradingSymbol[];
}) {
  const [tab, setTab] = useState<"positions" | "open" | "orders" | "fills">("positions");
  const positionsHaveSnapshot = positions.length > 0;
  const ordersHaveSnapshot = openOrders.length > 0 || history !== null;
  const activeLoading = tab === "positions" ? positionsLoading : ordersLoading;
  const activeError = tab === "positions" ? positionsError : ordersError;
  const hasRecoverableSnapshot = tab === "positions" ? positionsHaveSnapshot : ordersHaveSnapshot;
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
        loading={activeLoading && !hasRecoverableSnapshot}
        error={hasRecoverableSnapshot ? "" : activeError}
        empty={false}
        emptyText="-"
      >
        {activeError && hasRecoverableSnapshot ? (
          <p className="border-b border-line px-4 py-3 text-xs text-amber-200" role="alert">
            {activeError} 当前显示上次快照；仅保留撤单和 Reduce-only 安全退出，反手及新增风险已禁用。
          </p>
        ) : null}
        {tab === "positions" ? <RealPositionsTable bestAsk={bestAsk} bestBid={bestBid} onCloseRequest={onCloseRequest} onFeedback={onFeedback} onSelectSymbol={onSelectSymbol} onTpslRequest={onTpslRequest} openOrders={openOrders} pendingOperationKeys={pendingOperationKeys} riskIncreasingActionsBlocked={riskIncreasingActionsBlocked} rows={positions} symbols={symbols} /> : null}
        {tab === "open" ? <OrderTable emptyText="暂无当前委托。" onCancel={onCancelOrder} onFeedback={onFeedback} rows={openOrders} /> : null}
        {tab === "orders" ? <OrderTable emptyText="暂无历史委托。" rows={(history?.orders ?? []).map((item) => ({
          ...item.order,
          ...item,
          status: item.status ?? item.order?.status,
          timestamp: item.statusTimestamp ?? item.timestamp,
        }))} /> : null}
        {tab === "fills" ? <FillTable rows={history?.fills ?? []} /> : null}
        {history?.warnings.length ? (
          <p className="border-t border-line px-4 py-3 text-xs text-amber-200" role="status">部分历史数据暂不可用：{history.warnings.join("；")}</p>
        ) : null}
      </StatePanel>
    </section>
  );
}

function OrderTable({ emptyText, onCancel, onFeedback, rows }: { emptyText: string; onCancel?: (order: RealOpenOrder) => Promise<void>; onFeedback?: (message: string, tone: "error" | "info" | "success" | "warning") => void; rows: RealOpenOrder[] }) {
  const [cancelingOid, setCancelingOid] = useState<string | null>(null);

  async function cancel(order: RealOpenOrder) {
    if (!onCancel) return;
    const oid = String(order.oid ?? "");
    setCancelingOid(oid);
    try {
      await onCancel(order);
    } catch (error) {
      onFeedback?.(error instanceof Error ? error.message : "撤单请求失败。", "error");
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
    </div>
  );
}

function FillTable({ rows }: { rows: RealOrderHistory["fills"] }) {
  return <div className="xh-real-record-table"><div className="xh-real-record-head"><span>资产</span><span>方向</span><span>价格</span><span>数量</span><span>已实现盈亏</span><span>OID</span><span>时间</span></div>{rows.length === 0 ? <RecordEmpty text="暂无真实成交。" /> : rows.map((row, index) => {
    const fill = presentRealFill(row);
    return <div className="xh-real-record-row" key={`${row.tid ?? row.oid}-${index}`}><strong>{row.coin ?? "-"}</strong><span>{row.side ?? "-"}</span><span>{fill.price}</span><span>{fill.size}</span><span className={fill.realizedPnlTone ? `is-${fill.realizedPnlTone}` : ""}>{fill.realizedPnl}</span><span>{fill.oid}</span><span>{fill.time}</span></div>;
  })}</div>;
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

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "-";
}

function formatMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "-";
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

function formatTime(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatOrderType(order: RealOpenOrder) {
  const lifecycleStatus = normalizeRealTradingOrderStatus(order.lifecycleStatus ?? order.status);
  if (lifecycleStatus) return realTradingOrderStatusLabel(lifecycleStatus);
  if (order.isTrigger) return order.orderType ?? order.triggerCondition ?? "TP/SL";
  return order.orderType ?? "-";
}

function toneClass(tone?: "positive" | "negative") {
  return tone ? `is-${tone}` : "";
}

function resolveMarketConnectionStatus(summary: RealMarketSummary, orderbook: RealOrderbook) {
  const reported = normalizeRealTradingConnectionStatus(
    summary.connectionStatus
    ?? summary.realtimeStatus
    ?? orderbook.connectionStatus
    ?? orderbook.realtimeStatus
    ?? summary.status,
  ) ?? "connected";
  if (reported !== "connected") return reported;
  const timestamps = [summary.timestamp, orderbook.timestamp]
    .map(normalizeMarketTimestamp)
    .filter((value): value is number => value !== null);
  return timestamps.length > 0 && Date.now() - Math.min(...timestamps) > realMarketStaleAfterMs
    ? "stale"
    : "connected";
}

function normalizeMarketTimestamp(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function connectionStatusLabel(status: typeof initialRealTradingRealtimeState.connectionStatus) {
  return {
    connected: "CONNECTED",
    stale: "STALE",
    disconnected: "DISCONNECTED",
    reconnecting: "RECONNECTING",
  }[status];
}

function combineConnectionStatuses(
  ...statuses: RealTradingConnectionStatus[]
): RealTradingConnectionStatus {
  const severity: Record<RealTradingConnectionStatus, number> = {
    connected: 0,
    stale: 1,
    reconnecting: 2,
    disconnected: 3,
  };
  return statuses.reduce<RealTradingConnectionStatus>(
    (mostSevere, status) => severity[status] > severity[mostSevere] ? status : mostSevere,
    "connected",
  );
}

function applyOpenOrderIncremental(current: RealOpenOrder[], state: Extract<RealTradingOrderState, { mode: "incremental" }>) {
  const removed = new Set(state.openOrders.removedOrderIds);
  const next = current.filter((order) => !removed.has(realOrderIdentity(order)));
  state.openOrders.upserted.forEach((order) => {
    const identity = realOrderIdentity(order);
    const index = next.findIndex((item) => realOrderIdentity(item) === identity);
    if (index >= 0) next[index] = order;
    else next.push(order);
  });
  return next;
}

function applyHistoryIncremental(
  current: RealOrderHistory | null,
  state: Extract<RealTradingOrderState, { mode: "incremental" }>,
): RealOrderHistory {
  const orders = [...(current?.orders ?? [])];
  const fills = [...(current?.fills ?? [])];
  const orderKeys = new Set(orders.map(realHistoricalOrderIdentity));
  const fillKeys = new Set(fills.map(realFillIdentity));
  state.terminalOrders.forEach((order) => {
    const key = realHistoricalOrderIdentity(order);
    if (!orderKeys.has(key)) {
      orderKeys.add(key);
      orders.unshift(order);
    }
  });
  state.fills.forEach((fill) => {
    const key = realFillIdentity(fill);
    if (!fillKeys.has(key)) {
      fillKeys.add(key);
      fills.unshift(fill);
    }
  });
  return { orders, fills, nextCursor: current?.nextCursor ?? null, warnings: state.warnings };
}

type StateSetter<T> = (value: T | ((current: T) => T)) => void;

function applyUserStreamSnapshot(
  value: unknown,
  applyOrderState: (state: RealTradingOrderState) => void,
  setAccount: StateSetter<RealAccountSummary | null>,
  applyPositions: (positions: RealPosition[]) => void,
) {
  if (!isRecord(value) || !isRealTradingOrderState(value.orders) || !isRecord(value.account) || !Array.isArray(value.positions)) {
    return false;
  }
  applyOrderState(normalizeRealTradingOrderState(value.orders));
  setAccount(value.account as RealAccountSummary);
  applyPositions(value.positions as RealPosition[]);
  return true;
}

function applyUserStreamAccount(
  value: unknown,
  setAccount: StateSetter<RealAccountSummary | null>,
  applyPositions: (positions: RealPosition[]) => void,
) {
  if (!isRecord(value) || !isRecord(value.account) || !Array.isArray(value.positions)) return false;
  const update = value.account as Partial<RealAccountSummary>;
  setAccount((current) => current ? { ...current, ...update } : update as RealAccountSummary);
  applyPositions(value.positions as RealPosition[]);
  return true;
}

function mergeStreamOrders(current: RealOrderHistory | null, incoming: RealOrderHistory["orders"]): RealOrderHistory {
  const byIdentity = new Map<string, RealOrderHistory["orders"][number]>();
  [...incoming, ...(current?.orders ?? [])].forEach((order) => {
    const key = `${order.oid ?? order.cloid ?? "unknown"}:${order.status ?? "unknown"}:${order.statusTimestamp ?? order.timestamp ?? 0}`;
    if (!byIdentity.has(key)) byIdentity.set(key, order);
  });
  return { ...(current ?? emptyRealOrderHistory()), orders: [...byIdentity.values()].slice(0, 2_000) };
}

function mergeStreamFills(current: RealOrderHistory | null, incoming: RealOrderHistory["fills"]): RealOrderHistory {
  const byIdentity = new Map<string, RealOrderHistory["fills"][number]>();
  [...incoming, ...(current?.fills ?? [])].forEach((fill) => {
    const key = `${fill.hash ?? ""}:${fill.tid ?? fill.oid ?? ""}:${fill.timestamp ?? 0}:${fill.price ?? ""}:${fill.size ?? ""}`;
    if (!byIdentity.has(key)) byIdentity.set(key, fill);
  });
  return { ...(current ?? emptyRealOrderHistory()), fills: [...byIdentity.values()].slice(0, 2_000) };
}

function emptyRealOrderHistory(): RealOrderHistory {
  return { orders: [], fills: [], nextCursor: null, warnings: [] };
}

function isRealTradingOrderState(value: unknown): value is RealTradingOrderState {
  if (!isRecord(value) || value.authoritative !== true || !Number.isSafeInteger(value.sequence)) return false;
  return value.mode === "snapshot" || value.mode === "incremental";
}

function isSocketError(value: unknown): value is { type: "error"; message: string } {
  return isRecord(value) && value.type === "error" && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lifecycleUpdatesFromIncremental(state: Extract<RealTradingOrderState, { mode: "incremental" }>) {
  const history: RealOrderHistory = {
    orders: state.terminalOrders,
    fills: state.fills,
    nextCursor: null,
    warnings: state.warnings,
  };
  return [
    ...buildAuthoritativeOrderLifecycles(state.openOrders.upserted, history, state.timestamp),
    ...state.openOrders.removedOrderIds.map((exchangeOrderId) => ({
      clientOrderId: `snapshot:${exchangeOrderId}`,
      exchangeOrderId,
      message: "订单已从当前委托移除，正在等待交易所终态对账。",
      status: "pending_reconciliation" as const,
      updatedAt: state.timestamp,
    })),
  ];
}

function realOrderIdentity(order: RealOpenOrder) {
  if (order.oid !== undefined && order.oid !== null) return String(order.oid);
  if (order.cloid) return order.cloid;
  if (order.clientOrderId) return order.clientOrderId;
  return `${order.coin ?? order.symbol ?? "unknown"}:${order.side ?? ""}:${order.timestamp ?? 0}:${order.price ?? order.limitPx ?? ""}:${order.size ?? order.sz ?? ""}`;
}

function realHistoricalOrderIdentity(order: RealOrderHistory["orders"][number]) {
  const normalized = { ...order.order, ...order };
  return `${realOrderIdentity(normalized)}:${normalized.status ?? "unknown"}:${order.statusTimestamp ?? order.timestamp ?? 0}`;
}

function realFillIdentity(fill: RealOrderHistory["fills"][number]) {
  return `${fill.hash ?? ""}:${fill.tid ?? ""}:${fill.oid ?? ""}:${fill.coin ?? fill.symbol ?? ""}:${fill.timestamp ?? 0}:${fill.price ?? ""}:${fill.size ?? ""}`;
}
