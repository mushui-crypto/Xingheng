import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Modal } from "../../../components/ui/Modal";
import type { RealPosition, RealTradingFees, RealTradingMarginMode, RealTradingReconciliationRecord } from "../../../api/realTrading";
import { MarginLeverageModal } from "./MarginLeverageModal";
import { WalletNetworkGateModal } from "./WalletNetworkGateModal";
import { submitMarginLeverageUpdate } from "../lib/hyperliquidSdk";
import { normalizeHyperliquidPrice } from "../lib/hyperliquidPrice";
import { buildRealTradingEntryOrderInput } from "../lib/realTradingOrderValidation";
import { createHyperliquidCloid, type HyperliquidCloid } from "../lib/hyperliquidCloid";
import { assertValidHyperliquidSizeDecimals, formatHyperliquidOrderSizeFloor, getHyperliquidSizeInputStep } from "../lib/hyperliquidSize";
import type { HyperliquidSessionController } from "../lib/useHyperliquidSessionSigner";
import { buildPositionTpslOrders } from "../lib/tpslOrders";
import {
  marginModeLabel,
  resolveMarginLeverageSelection,
  type MarginLeverageSessionState,
  type MarginLeverageSelection,
} from "../model/marginLeverage";
import { preflightRealTradingOrder, realTradingRiskPolicy } from "../model/riskPolicy";
import { canSkipRealTradingConfirmationForSession } from "../model/confirmationPolicy";
import { lifecyclesFromActionFailure, orderOperationKey } from "../model/reconciliation";
import {
  extractExchangeOrderUpdates,
  realTradingOrderStatusLabel,
  type RealTradingOrderLifecycle,
} from "../model/realtimeState";

const positionPercentSteps = [0, 25, 50, 75, 100] as const;
const positionPercentSnapThreshold = 2;

export function RealTradingOrderPanel({
  assetId,
  availableMargin,
  connected,
  equity,
  fees,
  latestOrderLifecycle,
  markPrice,
  marketReady,
  marginModeConstraint,
  maxLeverage,
  onConnect,
  onOrderLifecycle,
  onSubmitted,
  openOrderCount,
  positionSize,
  position,
  pendingOperationKeys = [],
  reconciliationPending,
  reconciliationError,
  reconciliationLoading,
  reconciliationMessage,
  reconciliationRecords,
  session,
  supportedMarginModes,
  szDecimals,
  symbol,
  totalExposure,
}: {
  assetId?: number;
  availableMargin?: number | null;
  connected: boolean;
  equity?: number | null;
  fees?: RealTradingFees | null;
  latestOrderLifecycle?: RealTradingOrderLifecycle | null;
  markPrice?: number | null;
  marketReady: boolean;
  marginModeConstraint?: "cross_and_isolated" | "isolated_only";
  maxLeverage?: number;
  onConnect: () => void;
  onOrderLifecycle: (phase: "submitted" | "updated", order: RealTradingOrderLifecycle) => void;
  onSubmitted: () => Promise<void> | void;
  openOrderCount: number;
  positionSize?: number;
  position?: RealPosition | null;
  pendingOperationKeys?: string[];
  reconciliationPending: boolean;
  reconciliationError?: string;
  reconciliationLoading?: boolean;
  reconciliationMessage?: string;
  reconciliationRecords?: RealTradingReconciliationRecord[];
  session: HyperliquidSessionController;
  supportedMarginModes?: RealTradingMarginMode[];
  szDecimals?: number;
  symbol: string;
  totalExposure: number;
}) {
  const sizeInputSourceRef = useRef<"manual" | "slider">("manual");
  const [side, setSide] = useState("buy");
  const [orderType, setOrderType] = useState("limit");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tpslEnabled, setTpslEnabled] = useState(false);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [marginSelections, setMarginSelections] = useState<MarginLeverageSessionState>({});
  const [marginModalOpen, setMarginModalOpen] = useState(false);
  const [marginSubmitting, setMarginSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipLimitConfirmationForSession, setSkipLimitConfirmationForSession] = useState(false);
  const [pendingClientOrderId, setPendingClientOrderId] = useState("");
  const [pendingSide, setPendingSide] = useState<"buy" | "sell">("buy");
  const [retryIntent, setRetryIntent] = useState<{ cloid: HyperliquidCloid; side: "buy" | "sell" } | null>(null);
  const [positionPercent, setPositionPercent] = useState(0);
  const { authorized, busy } = session;
  const marginSelection = resolveMarginLeverageSelection({
    marginModeConstraint,
    maxLeverage,
    position,
    sessionSelection: marginSelections[symbol],
    supportedMarginModes,
  });
  const leverage = String(marginSelection.leverage);
  const currentOperationKey = orderOperationKey(symbol, reduceOnly);
  const currentOperationPending = pendingOperationKeys.includes(currentOperationKey);
  const entrySafetyBlocked = (!marketReady || reconciliationPending) && !reduceOnly;
  const actionDisabled = !connected || entrySafetyBlocked || currentOperationPending || busy || typeof assetId !== "number";
  const sizeInputStep = getHyperliquidSizeInputStep(szDecimals);

  useEffect(() => {
    sizeInputSourceRef.current = "manual";
    setPrice("");
    setSize("");
    setTpPrice("");
    setSlPrice("");
    setPositionPercent(0);
    setConfirmOpen(false);
    session.setMessage("");
  }, [assetId, symbol, szDecimals]);

  useEffect(() => {
    if (orderType === "market" && typeof markPrice === "number") {
      const protectionPrice = markPrice * (side === "buy" ? 1.01 : 0.99);
      try {
        setPrice(normalizeHyperliquidPrice(protectionPrice, szDecimals, side === "buy" ? "up" : "down"));
      } catch {
        setPrice("");
      }
    }
  }, [markPrice, orderType, side, szDecimals]);

  useEffect(() => {
    if (sizeInputSourceRef.current === "slider") {
      setSize(sizeForPercent(positionPercent));
      return;
    }
    setPositionPercent(percentForSize(size));
  }, [availableMargin, leverage, markPrice, orderType, positionSize, price, reduceOnly, side, szDecimals]);

  async function authorizeSession() {
    if (typeof assetId !== "number") return;
    await session.authorize();
  }

  async function submitOrder(
    orderSide: "buy" | "sell" = side === "sell" ? "sell" : "buy",
    cloid = createHyperliquidCloid(),
  ) {
    let draft: ReturnType<typeof buildOrderDraft>;
    try {
      draft = buildOrderDraft(orderSide, cloid);
    } catch (error) {
      session.setError(error instanceof Error ? error.message : "请输入有效的价格和数量。");
      return;
    }

    const signer = session.signer;
    if (!signer) return;
    const submittedAt = Date.now();
    const operationKey = orderOperationKey(symbol, reduceOnly);
    const lifecycleBase = { clientOrderId: cloid, operationKey, symbol, updatedAt: submittedAt };
    onOrderLifecycle("submitted", { ...lifecycleBase, status: "submitted" });
    try {
      const triggers = tpslEnabled && !reduceOnly ? resolveTpslOrders(orderSide, draft.entryOrder.size, draft.entryOrder.price, cloid) : [];
      const outcome = await session.runActionResult(
        () => triggers.length > 0 ? signer.placeOrderWithTpsl(draft.entryOrder, triggers) : signer.placeOrder(draft.entryOrder),
        reduceOnly ? "reduce-only 平仓请求已发送。" : tpslEnabled ? "真实订单与止盈止损请求已发送。" : "真实订单请求已发送。",
      );
      if (!outcome.completed) {
        lifecyclesFromActionFailure({
          cloid,
          operationKeys: [operationKey],
          outcome,
          symbol,
          updatedAt: Date.now(),
        }).forEach((order) => onOrderLifecycle("updated", order));
        setRetryIntent(!outcome.reconciliationRequired && outcome.error && isRetryableOrderError(outcome.error) ? { cloid, side: orderSide } : null);
        if (outcome.reconciliationRequired) await onSubmitted();
        return;
      }
      extractExchangeOrderUpdates(outcome.result, { ...lifecycleBase, updatedAt: Date.now() }).forEach((order) => {
        onOrderLifecycle("updated", order);
      });
      setRetryIntent(null);
      await onSubmitted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "止盈止损参数无效。";
      session.setError(message);
      onOrderLifecycle("updated", { ...lifecycleBase, message, status: "rejected", updatedAt: Date.now() });
      setRetryIntent(isRetryableOrderError(message) ? { cloid, side: orderSide } : null);
    }
  }

  function resolveOrderPrice(orderSide: "buy" | "sell") {
    if (orderType !== "market") return price;
    if (typeof markPrice !== "number" || !Number.isFinite(markPrice)) return "";
    try {
      return normalizeHyperliquidPrice(markPrice * (orderSide === "buy" ? 1.01 : 0.99), szDecimals, orderSide === "buy" ? "up" : "down");
    } catch {
      return "";
    }
  }

  function buildOrderDraft(orderSide: "buy" | "sell", cloid: HyperliquidCloid) {
    const orderPrice = resolveOrderPrice(orderSide);
    const entryOrder = buildRealTradingEntryOrderInput({
      assetId,
      cloid,
      orderPrice,
      orderSide,
      orderType: orderType === "market" ? "market" : "limit",
      reduceOnly,
      size,
      szDecimals,
      symbol,
    });
    return { entryOrder };
  }

  function resolveTpslOrders(
    orderSide: "buy" | "sell",
    normalizedSize: string,
    referenceValue = resolveOrderPrice(orderSide),
    parentCloid = createHyperliquidCloid(),
  ) {
    if (typeof assetId !== "number") return [];
    const decimals = assertValidHyperliquidSizeDecimals(szDecimals, symbol);
    return buildPositionTpslOrders({
      asset: assetId,
      closingIsBuy: orderSide === "sell",
      parentCloid,
      referencePrice: Number(referenceValue),
      size: normalizedSize,
      slPrice,
      szDecimals: decimals,
      tpPrice,
    });
  }

  function requestOrder(orderSide: "buy" | "sell") {
    setSide(orderSide);
    session.setMessage("");
    if (!connected) {
      onConnect();
      return;
    }
    const nextClientOrderId = createHyperliquidCloid();
    let draft: ReturnType<typeof buildOrderDraft>;
    try {
      draft = buildOrderDraft(orderSide, nextClientOrderId);
      if (tpslEnabled && !reduceOnly) {
        resolveTpslOrders(orderSide, draft.entryOrder.size, draft.entryOrder.price, nextClientOrderId);
      }
    } catch (error) {
      session.setError(error instanceof Error ? error.message : "请输入有效的价格和数量。");
      return;
    }
    const orderNotional = Number(draft.entryOrder.price) * Number(draft.entryOrder.size);
    const riskErrors = preflightRealTradingOrder({
      equity,
      openOrderCount,
      orderNotional,
      reduceOnly,
      totalExposure,
    });
    if (riskErrors.length > 0) {
      session.setError(`${riskErrors.join(" ")} 最终结果以服务端风控为准。`);
      return;
    }
    if (!authorized) {
      void authorizeSession();
      return;
    }
    if (canSkipOrderConfirmation() && skipLimitConfirmationForSession) {
      void submitOrder(orderSide, nextClientOrderId);
      return;
    }
    setPendingSide(orderSide);
    setPendingClientOrderId(nextClientOrderId);
    setConfirmOpen(true);
  }

  function confirmOrder() {
    setConfirmOpen(false);
    void submitOrder(pendingSide, pendingClientOrderId as HyperliquidCloid || createHyperliquidCloid());
  }

  function canSkipOrderConfirmation() {
    return canSkipRealTradingConfirmationForSession({
      orderType: orderType === "market" ? "market" : "limit",
      reduceOnly,
      tpslEnabled,
    });
  }

  function changePositionPercent(value: number) {
    const normalizedValue = normalizePositionPercent(value);
    sizeInputSourceRef.current = "slider";
    setPositionPercent(normalizedValue);
    setSize(sizeForPercent(normalizedValue));
  }

  function changeSize(value: string) {
    sizeInputSourceRef.current = "manual";
    setSize(value);
    setPositionPercent(percentForSize(value));
  }

  function maxOrderSize() {
    if (reduceOnly) return Math.max(0, positionSize ?? 0);
    const explicitPrice = Number(resolveOrderPrice(side === "sell" ? "sell" : "buy"));
    const orderPrice = explicitPrice > 0 ? explicitPrice : (markPrice ?? 0);
    const margin = availableMargin ?? 0;
    const leverageValue = Number(leverage);
    if (!(orderPrice > 0) || !(margin > 0) || !(leverageValue > 0)) return 0;
    const marginNotional = margin * leverageValue;
    const equityValue = typeof equity === "number" && Number.isFinite(equity) && equity > 0 ? equity : 0;
    const singleOrderNotional = equityValue * realTradingRiskPolicy.maxSingleOrderEquityRatio;
    const remainingExposureNotional = Math.max(0, equityValue * realTradingRiskPolicy.maxTotalExposureEquityRatio - totalExposure);
    return Math.min(marginNotional, singleOrderNotional, remainingExposureNotional) / orderPrice;
  }

  function sizeForPercent(value: number) {
    if (value <= 0) return "";
    try {
      return formatHyperliquidOrderSizeFloor(maxOrderSize() * (value / 100), szDecimals, symbol);
    } catch {
      return "";
    }
  }

  function percentForSize(value: string) {
    const numericSize = Number(value);
    const maximum = maxOrderSize();
    if (!Number.isFinite(numericSize) || numericSize <= 0 || maximum <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((numericSize / maximum) * 100)));
  }

  function openMarginModal() {
    session.setMessage("");
    setMarginModalOpen(true);
  }

  async function submitMarginSelection(nextSelection: Pick<MarginLeverageSelection, "leverage" | "marginMode">) {
    if (!marketReady || reconciliationPending) {
      session.setError("实时账户状态未就绪，暂不能调整保证金模式或杠杆。");
      return;
    }
    if (typeof assetId !== "number") {
      session.setError("当前品种缺少可用的 Hyperliquid asset id。");
      return;
    }
    setMarginSubmitting(true);
    try {
      const completed = await session.runAction(
        (signer) => submitMarginLeverageUpdate(signer, assetId, nextSelection.leverage, nextSelection.marginMode),
        `已更新为 ${nextSelection.leverage}x · ${marginModeLabel(nextSelection.marginMode)}。`,
      );
      if (!completed) return;
      setMarginSelections((current) => ({ ...current, [symbol]: nextSelection }));
      await onSubmitted();
      setMarginModalOpen(false);
    } finally {
      setMarginSubmitting(false);
    }
  }

  const confirmCloid = pendingClientOrderId as HyperliquidCloid;
  const confirmEntryOrder = confirmOpen && confirmCloid ? safeBuildOrderDraft(pendingSide, confirmCloid)?.entryOrder ?? null : null;
  const confirmTriggers = confirmOpen && confirmEntryOrder && tpslEnabled && !reduceOnly
    ? safeResolveTpslOrders(pendingSide, confirmEntryOrder.size, confirmEntryOrder.price, confirmCloid)
    : [];
  const confirmTpPrice = confirmTriggers.find((order) => order.tpsl === "tp")?.triggerPrice;
  const confirmSlPrice = confirmTriggers.find((order) => order.tpsl === "sl")?.triggerPrice;

  function safeBuildOrderDraft(orderSide: "buy" | "sell", cloid: HyperliquidCloid) {
    try {
      return buildOrderDraft(orderSide, cloid);
    } catch {
      return null;
    }
  }

  function safeResolveTpslOrders(orderSide: "buy" | "sell", normalizedSize: string, referenceValue: string, parentCloid: HyperliquidCloid) {
    try {
      return resolveTpslOrders(orderSide, normalizedSize, referenceValue, parentCloid);
    } catch {
      return [];
    }
  }

  return (
    <section className="xh-real-order-panel">
      <div className="xh-real-order-topline">
        <button aria-haspopup="dialog" disabled={busy || !marketReady || reconciliationPending || typeof assetId !== "number"} onClick={openMarginModal} type="button">
          <span>{marginModeLabel(marginSelection.marginMode)}</span><ChevronDown aria-hidden="true" size={16} />
        </button>
        <button aria-haspopup="dialog" disabled={busy || !marketReady || reconciliationPending || typeof assetId !== "number"} onClick={openMarginModal} type="button">
          <span>{marginSelection.leverage}x</span><ChevronDown aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="xh-real-position-tabs" role="tablist" aria-label="仓位动作">
        <button className={!reduceOnly ? "is-active" : ""} onClick={() => setReduceOnly(false)} role="tab" type="button">开仓</button>
        <button className={reduceOnly ? "is-active" : ""} onClick={() => setReduceOnly(true)} role="tab" type="button">平仓</button>
      </div>
      <div className="xh-real-type-tabs" role="tablist" aria-label="订单类型">
        <button className={orderType === "market" ? "is-active" : ""} onClick={() => setOrderType("market")} role="tab" type="button">市价</button>
        <button className={orderType === "limit" ? "is-active" : ""} onClick={() => setOrderType("limit")} role="tab" type="button">限价</button>
      </div>

      <fieldset className="xh-real-order-form" disabled={busy}>
        <div className="xh-real-order-entry-fields">
          <div className="xh-real-order-balance"><span>可用余额</span><strong>{formatMoney(availableMargin)} USDT</strong><span>当前仓位</span><strong>{positionSize ?? 0}</strong></div>
          {orderType === "limit" ? (
            <label className="xh-real-order-field">
              <span>价格</span>
              <div><input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} /><b>USDC</b></div>
            </label>
          ) : null}
          <label className="xh-real-order-field">
            <span>数量</span>
            <div><input inputMode="decimal" step={sizeInputStep} value={size} onChange={(event) => changeSize(event.target.value)} /><b>{symbol.replace("USDT", "")}</b></div>
          </label>
          {tpslEnabled && !reduceOnly ? (
            <div className="xh-real-order-tpsl-fields">
              <label className="xh-real-order-field"><span>止盈价</span><div><input inputMode="decimal" value={tpPrice} onChange={(event) => setTpPrice(event.target.value)} /><b>USDC</b></div></label>
              <label className="xh-real-order-field"><span>止损价</span><div><input inputMode="decimal" value={slPrice} onChange={(event) => setSlPrice(event.target.value)} /><b>USDC</b></div></label>
            </div>
          ) : null}
        </div>
        <div className="xh-real-position-percent-control">
          <div className="xh-real-position-percent">
            <div
              aria-hidden="true"
              className="xh-real-position-percent-track"
              style={{ "--position-percent": `${positionPercent}%` } as CSSProperties}
            />
            <div className="xh-real-position-percent-nodes" aria-hidden="true">
              {positionPercentSteps.map((step) => (
                <span
                  className={positionPercent > step ? "is-active" : ""}
                  key={step}
                  style={{ left: `${step}%` }}
                />
              ))}
            </div>
            <input
              aria-label="仓位百分比滑杆"
              max={100}
              min={0}
              onChange={(event) => changePositionPercent(Number(event.target.value))}
              onInput={(event) => changePositionPercent(Number(event.currentTarget.value))}
              onPointerCancel={(event) => changePositionPercent(snapPositionPercent(Number(event.currentTarget.value)))}
              onPointerUp={(event) => changePositionPercent(snapPositionPercent(Number(event.currentTarget.value)))}
              step={1}
              type="range"
              value={positionPercent}
            />
          </div>
          <label className="xh-real-position-percent-input">
            <span className="sr-only">仓位百分比输入</span>
            <input inputMode="numeric" max={100} min={0} onChange={(event) => changePositionPercent(Number(event.target.value))} step={1} type="number" value={positionPercent} />
            <b>%</b>
          </label>
        </div>
        <div className="xh-real-side-buttons">
          <button className="is-buy-active" disabled={actionDisabled} onClick={() => requestOrder("buy")} type="button">买入 / 做多</button>
          <button className="is-sell-active" disabled={actionDisabled} onClick={() => requestOrder("sell")} type="button">卖出 / 做空</button>
        </div>
        {!connected ? (
          <button className="xh-real-connect-wallet" onClick={onConnect} type="button">连接钱包</button>
        ) : null}
        <div className="xh-real-order-checks">
          <Checkbox checked={reduceOnly} label="只减仓" onChange={(event) => setReduceOnly(event.target.checked)} />
          <Checkbox checked={tpslEnabled} disabled={reduceOnly} label="止盈/止损" onChange={(event) => setTpslEnabled(event.target.checked)} />
        </div>
        <p className="xh-real-risk-policy-note">
          风控预检：最高 20x · 单笔 ≤ 权益 50% · 总敞口 ≤ 权益 200% · 当前委托 ≤ 20 笔。服务端规则为准。
        </p>
        {!marketReady ? (
          <p className="xh-real-risk-policy-note is-warning" role="alert">
            行情或账户实时状态未就绪，暂停新开仓；撤单和合法 Reduce-only 平仓仍可用。
          </p>
        ) : null}
        {reconciliationPending ? (
          <p className="xh-real-risk-policy-note is-warning" role="alert">
            {reconciliationLoading ? "正在读取待对账状态，确认完成前暂停新增风险动作。" : reconciliationMessage || "存在结果未知的订单，完成前暂停新增风险动作。"}
          </p>
        ) : null}
        {reconciliationError ? <p className="xh-real-risk-policy-note is-warning" role="alert">{reconciliationError}</p> : null}
      </fieldset>

      {reconciliationRecords && reconciliationRecords.length > 0 ? (
        <section className="xh-real-reconciliation-list" aria-label="待对账交易">
          <div className="xh-real-reconciliation-heading">
            <strong>待对账</strong>
            <span>{reconciliationRecords.length}</span>
          </div>
          {reconciliationRecords.map((record) => (
            <ReconciliationItem key={record.requestId} record={record} />
          ))}
        </section>
      ) : null}

      <div className="xh-real-order-metrics">
        <PanelMetric label="强平价格" value="-" />
        <PanelMetric label="订单价值" value={estimateValue(resolveOrderPrice(side === "sell" ? "sell" : "buy"), size)} />
        <PanelMetric label="所需保证金" value={estimateMargin(resolveOrderPrice(side === "sell" ? "sell" : "buy"), size, leverage)} />
        <PanelMetric label="费用" value={estimateFee(resolveOrderPrice(side === "sell" ? "sell" : "buy"), size, orderType === "market" ? fees?.takerRate : fees?.makerRate)} />
      </div>
      {latestOrderLifecycle ? (
        <div className={`xh-real-order-lifecycle is-${latestOrderLifecycle.status}`} role="status">
          <span>订单状态</span>
          <strong>{realTradingOrderStatusLabel(latestOrderLifecycle.status)}</strong>
          {latestOrderLifecycle.exchangeOrderId ? <small>OID {latestOrderLifecycle.exchangeOrderId}</small> : null}
          {latestOrderLifecycle.requestId ? <small>Request {truncateIdentifier(latestOrderLifecycle.requestId)}</small> : null}
          {latestOrderLifecycle.clientOrderId && !latestOrderLifecycle.clientOrderId.startsWith("audit:") ? <small>Cloid {truncateIdentifier(latestOrderLifecycle.clientOrderId)}</small> : null}
          {latestOrderLifecycle.submittedAt ? <small>提交 {formatLifecycleTime(latestOrderLifecycle.submittedAt)}</small> : null}
          {latestOrderLifecycle.message ? <small>{latestOrderLifecycle.message}</small> : null}
          {retryIntent?.cloid === latestOrderLifecycle.clientOrderId ? (
            <button disabled={busy || (!marketReady && !reduceOnly)} onClick={() => void submitOrder(retryIntent.side, retryIntent.cloid)} type="button">
              使用同一 cloid 重试
            </button>
          ) : null}
        </div>
      ) : null}
      <Modal open={confirmOpen} title="确认订单" onClose={() => setConfirmOpen(false)} shellClassName="xh-real-confirm-modal">
        <div className="xh-real-confirm-summary">
          <ConfirmMetric label="品种" value={symbol} />
          <ConfirmMetric label="方向" value={pendingSide === "buy" ? "买入 / 做多" : "卖出 / 做空"} tone={pendingSide} />
          <ConfirmMetric label="仓位" value={reduceOnly ? "平仓 · Reduce-only" : "开仓"} />
          <ConfirmMetric label="类型" value={orderType === "market" ? "市价 IOC" : "限价"} />
          <ConfirmMetric label="价格" value={`${confirmEntryOrder?.price ?? "-"} USDC`} />
          <ConfirmMetric label="数量" value={`${confirmEntryOrder?.size ?? "-"} ${symbol.replace("USDT", "")}`} />
          <ConfirmMetric label="订单价值" value={estimateValue(confirmEntryOrder?.price ?? "", confirmEntryOrder?.size ?? "")} />
          <ConfirmMetric label="杠杆" value={`${marginSelection.leverage}x · ${marginModeLabel(marginSelection.marginMode)}`} />
          {tpslEnabled && !reduceOnly ? <ConfirmMetric label="止盈价" value={confirmTpPrice ? `${confirmTpPrice} USDC` : "-"} /> : null}
          {tpslEnabled && !reduceOnly ? <ConfirmMetric label="止损价" value={confirmSlPrice ? `${confirmSlPrice} USDC` : "-"} /> : null}
        </div>
        <div className="xh-real-confirm-warning" role="note">
          Hyperliquid Testnet 真实订单。确认后将请求本地签名，订单结果以交易所返回为准。
        </div>
        {canSkipOrderConfirmation() ? (
          <label className="xh-real-confirm-skip">
            <input checked={skipLimitConfirmationForSession} onChange={(event) => setSkipLimitConfirmationForSession(event.target.checked)} type="checkbox" />
            本次页面会话内，普通限价单不再提醒
          </label>
        ) : null}
        <div className="xh-real-confirm-actions">
          <Button onClick={() => setConfirmOpen(false)} type="button" variant="secondary">取消</Button>
          <Button onClick={confirmOrder} type="button" variant={pendingSide === "buy" ? "primary" : "danger"}>确认订单</Button>
        </div>
      </Modal>
      <MarginLeverageModal
        connected={connected}
        onClose={() => {
          if (!marginSubmitting) setMarginModalOpen(false);
        }}
        onConfirm={submitMarginSelection}
        open={marginModalOpen}
        selection={marginSelection}
        submitting={marginSubmitting || busy}
      />
      <WalletNetworkGateModal session={session} />
    </section>
  );
}

function ConfirmMetric({ label, tone, value }: { label: string; tone?: "buy" | "sell"; value: string }) {
  return <div><span>{label}</span><strong className={tone === "buy" ? "is-buy" : tone === "sell" ? "is-sell" : ""}>{value}</strong></div>;
}

function PanelMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function ReconciliationItem({ record }: { record: RealTradingReconciliationRecord }) {
  return (
    <article className={`xh-real-reconciliation-item ${record.manualReview ? "is-manual" : "is-automatic"}`}>
      <div>
        <strong>{realTradingActionLabel(record.actionType)}</strong>
        <span>{record.manualReview ? "人工核对" : record.autoRecoverable ? "自动核对" : "待核对"}</span>
      </div>
      <dl>
        <div><dt>提交</dt><dd>{formatLifecycleTime(record.submittedAt)}</dd></div>
        <div><dt>Request</dt><dd><CopyIdentifier value={record.requestId} /></dd></div>
        <div>
          <dt>Cloid</dt>
          <dd>{record.clientOrderIds.length > 0 ? record.clientOrderIds.map((cloid) => <CopyIdentifier key={cloid} value={cloid} />) : "-"}</dd>
        </div>
        <div><dt>最近核对</dt><dd>{formatLifecycleTime(record.lastReconcileAttemptAt)}</dd></div>
      </dl>
      <p>{record.manualReview ? "需要人工核对，禁止盲目重试。" : "系统正在按权威 orderStatus 自动核对。"}</p>
      {record.errorCategory ? <small>错误类别：{record.errorCategory}</small> : null}
    </article>
  );
}

function CopyIdentifier({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button aria-label={`复制 ${value}`} className="xh-real-copy-id" onClick={() => void copy()} title={value} type="button">
      {copied ? "已复制" : truncateIdentifier(value)}
    </button>
  );
}

function truncateIdentifier(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatLifecycleTime(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
}

function realTradingActionLabel(value: string) {
  const labels: Record<string, string> = {
    approveAgent: "Agent 授权",
    cancel: "撤单",
    order: "订单",
    updateLeverage: "杠杆 / 保证金",
  };
  return labels[value] ?? value;
}

function isRetryableOrderError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("网络") || normalized.includes("network") || normalized.includes("fetch") || normalized.includes("timeout");
}

function formatMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0.00";
}

function estimateValue(price: string, size: string) {
  const value = Number(price) * Number(size);
  return Number.isFinite(value) && value > 0 ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : "-";
}

function estimateMargin(price: string, size: string, leverage: string) {
  const value = Number(price) * Number(size);
  const leverageValue = Number(leverage);
  const margin = value / leverageValue;
  return Number.isFinite(margin) && margin > 0 ? `${margin.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : "-";
}

function estimateFee(price: string, size: string, rate?: number | null) {
  const fee = Number(price) * Number(size) * Number(rate);
  return typeof rate === "number" && Number.isFinite(fee) && fee > 0
    ? `${fee.toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC`
    : "-";
}

function normalizePositionPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function snapPositionPercent(value: number) {
  const normalizedValue = normalizePositionPercent(value);
  const nearestStep = positionPercentSteps.reduce((nearest, step) => (
    Math.abs(step - normalizedValue) < Math.abs(nearest - normalizedValue) ? step : nearest
  ));
  return Math.abs(nearestStep - normalizedValue) <= positionPercentSnapThreshold ? nearestStep : normalizedValue;
}
