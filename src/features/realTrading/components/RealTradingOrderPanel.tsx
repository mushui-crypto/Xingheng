import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Modal } from "../../../components/ui/Modal";
import type { RealTradingFees } from "../../../api/realTrading";
import { normalizeSdkError } from "../lib/hyperliquidSdk";
import { normalizeHyperliquidPrice } from "../lib/hyperliquidPrice";
import type { HyperliquidSessionController } from "../lib/useHyperliquidSessionSigner";
import { buildPositionTpslOrders } from "../lib/tpslOrders";

const skipOrderConfirmationKey = "stellax.realTrading.skipOrderConfirmation";
const positionPercentSteps = [0, 25, 50, 75, 100] as const;
const positionPercentSnapThreshold = 2;

export function RealTradingOrderPanel({
  assetId,
  availableMargin,
  connected,
  connectionMessage,
  fees,
  markPrice,
  maxLeverage,
  onConnect,
  onSubmitted,
  positionSize,
  session,
  szDecimals = 0,
  symbol,
}: {
  assetId?: number;
  availableMargin?: number | null;
  connected: boolean;
  connectionMessage?: string;
  fees?: RealTradingFees | null;
  markPrice?: number | null;
  maxLeverage?: number;
  onConnect: () => void;
  onSubmitted: () => void;
  positionSize?: number;
  session: HyperliquidSessionController;
  szDecimals?: number;
  symbol: string;
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
  const [leverage, setLeverage] = useState("5");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipNextConfirmation, setSkipNextConfirmation] = useState(false);
  const [pendingSide, setPendingSide] = useState<"buy" | "sell">("buy");
  const [positionPercent, setPositionPercent] = useState(0);
  const { authorized, busy, message } = session;
  const canSubmit = authorized && !busy && typeof assetId === "number";
  const actionDisabled = !connected || busy || typeof assetId !== "number";

  useEffect(() => {
    if (orderType === "market" && typeof markPrice === "number") {
      const protectionPrice = markPrice * (side === "buy" ? 1.01 : 0.99);
      setPrice(normalizeHyperliquidPrice(protectionPrice, szDecimals, side === "buy" ? "up" : "down"));
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
    const signer = await session.authorize();
    if (signer && typeof assetId === "number") {
      try {
        await signer.updateLeverage(assetId, Number(leverage));
        session.setMessage("会话签名器已初始化。");
        onSubmitted();
      } catch (error) {
        session.setError(normalizeSdkError(error));
      }
    }
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    const completed = await session.runAction(() => action(), success);
    if (completed) onSubmitted();
  }

  async function submitOrder(orderSide: "buy" | "sell" = side === "sell" ? "sell" : "buy") {
    const signer = session.signer;
    if (!signer || typeof assetId !== "number") return;
    const orderPrice = resolveOrderPrice(orderSide);
    if (!orderPrice || !size || Number(orderPrice) <= 0 || Number(size) <= 0) {
      session.setError("请输入有效的价格和数量。");
      return;
    }
    let normalizedPrice: string;
    try {
      normalizedPrice = normalizeHyperliquidPrice(orderPrice, szDecimals, orderSide === "buy" ? "up" : "down");
    } catch {
      session.setError("请输入有效的价格和数量。");
      return;
    }
    const entryOrder = { asset: assetId, isBuy: orderSide === "buy", price: normalizedPrice, size, reduceOnly, market: orderType === "market" };
    try {
      const triggers = tpslEnabled && !reduceOnly ? resolveTpslOrders(orderSide, orderPrice) : [];
      await runAction(
        () => triggers.length > 0 ? signer.placeOrderWithTpsl(entryOrder, triggers) : signer.placeOrder(entryOrder),
        reduceOnly ? "reduce-only 平仓请求已发送。" : tpslEnabled ? "真实订单与止盈止损请求已发送。" : "真实订单请求已发送。",
      );
    } catch (error) {
      session.setError(error instanceof Error ? error.message : "止盈止损参数无效。");
    }
  }

  function resolveOrderPrice(orderSide: "buy" | "sell") {
    if (orderType !== "market") return price;
    if (typeof markPrice !== "number" || !Number.isFinite(markPrice)) return "";
    return normalizeHyperliquidPrice(markPrice * (orderSide === "buy" ? 1.01 : 0.99), szDecimals, orderSide === "buy" ? "up" : "down");
  }

  function resolveTpslOrders(orderSide: "buy" | "sell", referenceValue = resolveOrderPrice(orderSide)) {
    if (typeof assetId !== "number") return [];
    return buildPositionTpslOrders({
      asset: assetId,
      closingIsBuy: orderSide === "sell",
      referencePrice: Number(referenceValue),
      size,
      slPrice,
      szDecimals,
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
    if (!authorized) {
      void authorizeSession();
      return;
    }
    const orderPrice = resolveOrderPrice(orderSide);
    if (!orderPrice || !size || Number(orderPrice) <= 0 || Number(size) <= 0) {
      session.setError("请输入有效的价格和数量。");
      return;
    }
    if (tpslEnabled && !reduceOnly) {
      try {
        resolveTpslOrders(orderSide, orderPrice);
      } catch (error) {
        session.setError(error instanceof Error ? error.message : "止盈止损参数无效。");
        return;
      }
    }
    if (window.localStorage.getItem(skipOrderConfirmationKey) === "1") {
      void submitOrder(orderSide);
      return;
    }
    setPendingSide(orderSide);
    setSkipNextConfirmation(false);
    setConfirmOpen(true);
  }

  function confirmOrder() {
    if (skipNextConfirmation) {
      window.localStorage.setItem(skipOrderConfirmationKey, "1");
    }
    setConfirmOpen(false);
    void submitOrder(pendingSide);
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
    return orderPrice > 0 && margin > 0 && leverageValue > 0 ? (margin * leverageValue) / orderPrice : 0;
  }

  function sizeForPercent(value: number) {
    if (value <= 0) return "";
    return formatOrderSize(maxOrderSize() * (value / 100), szDecimals);
  }

  function percentForSize(value: string) {
    const numericSize = Number(value);
    const maximum = maxOrderSize();
    if (!Number.isFinite(numericSize) || numericSize <= 0 || maximum <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((numericSize / maximum) * 100)));
  }

  async function submitLeverage(nextLeverage = leverage) {
    const signer = session.signer;
    const value = Number(nextLeverage);
    if (!signer || typeof assetId !== "number") return;
    if (!Number.isInteger(value) || value < 1 || value > (maxLeverage ?? 50)) {
      session.setError(`杠杆必须为 1-${maxLeverage ?? 50} 的整数。`);
      return;
    }
    await runAction(() => signer.updateLeverage(assetId, value), "杠杆更新请求已发送。");
  }

  function changeLeverage(nextLeverage: string) {
    setLeverage(nextLeverage);
    if (canSubmit) {
      void submitLeverage(nextLeverage);
    }
  }

  return (
    <section className="xh-real-order-panel">
      <div className="xh-real-order-topline">
        <label><span className="sr-only">保证金模式</span><select disabled value="cross" onChange={() => undefined}><option value="cross">全仓</option></select><ChevronDown aria-hidden="true" size={18} /></label>
        <div className="xh-real-leverage-control">
          <label><span className="sr-only">杠杆</span><select value={leverage} onChange={(event) => changeLeverage(event.target.value)}>{leverageOptions(maxLeverage).map((value) => <option key={value} value={value}>{value}x</option>)}</select><ChevronDown aria-hidden="true" size={18} /></label>
        </div>
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
            <div><input inputMode="decimal" value={size} onChange={(event) => changeSize(event.target.value)} /><b>{symbol.replace("USDT", "")}</b></div>
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
        {!connected && connectionMessage ? <p className="xh-real-connect-error" role="alert">{connectionMessage}</p> : null}
        <div className="xh-real-order-checks">
          <Checkbox checked={reduceOnly} label="只减仓" onChange={(event) => setReduceOnly(event.target.checked)} />
          <Checkbox checked={tpslEnabled} disabled={reduceOnly} label="止盈/止损" onChange={(event) => setTpslEnabled(event.target.checked)} />
        </div>
      </fieldset>

      <div className="xh-real-order-metrics">
        <PanelMetric label="强平价格" value="-" />
        <PanelMetric label="订单价值" value={estimateValue(resolveOrderPrice(side === "sell" ? "sell" : "buy"), size)} />
        <PanelMetric label="所需保证金" value={estimateMargin(resolveOrderPrice(side === "sell" ? "sell" : "buy"), size, leverage)} />
        <PanelMetric label="费用" value={estimateFee(resolveOrderPrice(side === "sell" ? "sell" : "buy"), size, orderType === "market" ? fees?.takerRate : fees?.makerRate)} />
      </div>
      {message ? <p className={`xh-real-order-message ${session.messageTone === "success" ? "is-success" : ""}`} role="status">{message}</p> : null}
      <Modal open={confirmOpen} title="确认订单" onClose={() => setConfirmOpen(false)} shellClassName="xh-real-confirm-modal">
        <div className="xh-real-confirm-summary">
          <ConfirmMetric label="品种" value={symbol} />
          <ConfirmMetric label="方向" value={pendingSide === "buy" ? "买入 / 做多" : "卖出 / 做空"} tone={pendingSide} />
          <ConfirmMetric label="仓位" value={reduceOnly ? "平仓 · Reduce-only" : "开仓"} />
          <ConfirmMetric label="类型" value={orderType === "market" ? "市价 IOC" : "限价"} />
          <ConfirmMetric label="价格" value={`${resolveOrderPrice(pendingSide) || "-"} USDC`} />
          <ConfirmMetric label="数量" value={`${size || "-"} ${symbol.replace("USDT", "")}`} />
          <ConfirmMetric label="订单价值" value={estimateValue(resolveOrderPrice(pendingSide), size)} />
          <ConfirmMetric label="杠杆" value={`${leverage}x · 全仓`} />
          {tpslEnabled && !reduceOnly ? <ConfirmMetric label="止盈价" value={tpPrice ? `${tpPrice} USDC` : "-"} /> : null}
          {tpslEnabled && !reduceOnly ? <ConfirmMetric label="止损价" value={slPrice ? `${slPrice} USDC` : "-"} /> : null}
        </div>
        <div className="xh-real-confirm-warning" role="note">
          Hyperliquid Testnet 真实订单。确认后将请求本地签名，订单结果以交易所返回为准。
        </div>
        <label className="xh-real-confirm-skip">
          <input checked={skipNextConfirmation} onChange={(event) => setSkipNextConfirmation(event.target.checked)} type="checkbox" />
          下次不再提醒
        </label>
        <div className="xh-real-confirm-actions">
          <Button onClick={() => setConfirmOpen(false)} type="button" variant="secondary">取消</Button>
          <Button onClick={confirmOrder} type="button" variant={pendingSide === "buy" ? "primary" : "danger"}>确认订单</Button>
        </div>
      </Modal>
    </section>
  );
}

function ConfirmMetric({ label, tone, value }: { label: string; tone?: "buy" | "sell"; value: string }) {
  return <div><span>{label}</span><strong className={tone === "buy" ? "is-buy" : tone === "sell" ? "is-sell" : ""}>{value}</strong></div>;
}

function PanelMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function leverageOptions(maxLeverage = 50) {
  return [1, 2, 3, 5, 10, 15, 20, 25, 50].filter((value) => value <= maxLeverage);
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

function formatOrderSize(value: number, decimals: number) {
  const factor = 10 ** Math.max(0, decimals);
  const floored = Math.floor(value * factor) / factor;
  const fixed = floored.toFixed(Math.max(0, decimals));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
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
