import { useState } from "react";
import type { RealOpenOrder, RealPosition, RealTradingSymbol } from "../../../api/realTrading";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { recordBelongsToMarket, resolveRealTradingSymbolForRecord } from "../lib/realTradingMarket";
import { createHyperliquidCloid } from "../lib/hyperliquidCloid";
import type { RealPositionCloseRequest, RealPositionTpslRequest } from "../model/types";

export type { RealPositionCloseRequest } from "../model/types";

type CloseIntent = RealPositionCloseRequest | null;

export function RealPositionsTable({
  bestAsk,
  bestBid,
  onCloseRequest,
  openOrders = [],
  onTpslRequest,
  rows,
  symbols,
}: {
  bestAsk?: number | null;
  bestBid?: number | null;
  onCloseRequest?: (request: RealPositionCloseRequest) => Promise<void> | void;
  openOrders?: RealOpenOrder[];
  onTpslRequest?: (request: RealPositionTpslRequest) => Promise<void> | void;
  rows: RealPosition[];
  symbols: RealTradingSymbol[];
}) {
  const [intent, setIntent] = useState<CloseIntent>(null);
  const [tpslIntent, setTpslIntent] = useState<RealPositionTpslRequest | null>(null);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function requestAllClose() {
    setStatus("");
    setIntent({ cloid: createHyperliquidCloid(), mode: "market", positions: rows, scope: "all" });
  }

  function requestSingleClose(position: RealPosition, mode: RealPositionCloseRequest["mode"]) {
    setStatus("");
    const counterpartyPrice = position.side === "long" ? bestBid : bestAsk;
    setIntent({
      cloid: createHyperliquidCloid(),
      limitPrice: mode === "limit" && typeof counterpartyPrice === "number" ? String(counterpartyPrice) : undefined,
      mode,
      positions: [position],
      scope: "single",
    });
  }

  function requestTpsl(position: RealPosition) {
    setStatus("");
    setTpslIntent({
      cloid: createHyperliquidCloid(),
      position,
      slPrice: triggerPrice(openOrders, position, symbols, "sl"),
      tpPrice: triggerPrice(openOrders, position, symbols, "tp"),
    });
  }

  async function confirmClose() {
    if (!intent) return;
    if (!onCloseRequest) {
      setStatus("平仓接口待接入");
      setIntent(null);
      return;
    }
    setSubmitting(true);
    try {
      await onCloseRequest(intent);
      setStatus(intent.scope === "all" ? "全部平仓请求已提交" : "平仓请求已提交");
      setIntent(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "平仓请求失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmTpsl() {
    if (!tpslIntent) return;
    if (!onTpslRequest) {
      setStatus("止盈止损接口待接入");
      setTpslIntent(null);
      return;
    }
    setSubmitting(true);
    try {
      await onTpslRequest(tpslIntent);
      setStatus("止盈止损请求已提交");
      setTpslIntent(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "止盈止损请求失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="xh-real-position-shell">
      <div className="xh-real-position-table">
        <div className="xh-real-position-head">
          <span>资产</span>
          <span>数量</span>
          <span>仓位价值</span>
          <span>开仓价格</span>
          <span>标记价格</span>
          <span>盈亏（ROE%）</span>
          <span>强平价格</span>
          <span>保证金</span>
          <span>资金费</span>
          <span>止盈</span>
          <span>止损</span>
          <button onClick={requestAllClose} type="button">全部平仓</button>
        </div>
        {rows.length === 0 ? (
          <div className="xh-real-position-empty">暂无真实持仓</div>
        ) : rows.map((row, index) => {
          const pnlTone = numberTone(row.unrealizedPnl);
          const sideTone = positionSideTone(row.side);
          return (
            <div className={`xh-real-position-row is-${row.side}`} key={`${row.coin}-${row.side}-${index}`}>
              <strong>{row.coin}</strong>
              <span className={sideTone}>{formatNumber(row.size)}</span>
              <span>{formatCurrency(positionValue(row))}</span>
              <span>{formatNumber(row.entryPx ?? row.entryPrice)}</span>
              <span>{formatNumber(row.markPx ?? row.markPrice)}</span>
              <span className={pnlTone}>{formatPnl(row)}</span>
              <span>{formatNumber(row.liqPx ?? row.liquidationPrice)}</span>
              <span>{formatMargin(row)}</span>
              <span>{formatSignedMoney(row.fundingSinceOpen ?? row.cumFunding?.sinceOpen)}</span>
              <button className="xh-real-position-trigger-button" onClick={() => requestTpsl(row)} type="button">{formatTriggerPrice(openOrders, row, symbols, "tp")}</button>
              <button className="xh-real-position-trigger-button" onClick={() => requestTpsl(row)} type="button">{formatTriggerPrice(openOrders, row, symbols, "sl")}</button>
              <div className="xh-real-position-actions">
                <button onClick={() => requestSingleClose(row, "limit")} type="button">限价</button>
                <button onClick={() => requestSingleClose(row, "market")} type="button">市价</button>
                <button onClick={() => requestSingleClose(row, "reverse")} type="button">反手</button>
              </div>
            </div>
          );
        })}
      </div>
      {status ? <p className="xh-real-position-status" role="status">{status}</p> : null}

      <Modal
        open={intent !== null}
        title={intent?.scope === "all" ? "确认全部平仓" : closeTitle(intent?.mode)}
        onClose={() => setIntent(null)}
        shellClassName="xh-real-confirm-modal"
      >
        <div className="xh-real-confirm-summary">
          <CloseMetric label="范围" value={intent?.scope === "all" ? `全部持仓 · ${intent.positions.length}` : intent?.positions[0]?.coin ?? "-"} />
          <CloseMetric label="方式" value={closeModeLabel(intent?.mode)} />
          <CloseMetric label="订单" value={intent?.mode === "market" ? "Reduce-only · Market" : intent?.mode === "limit" ? "Reduce-only · Limit" : "Close + Reverse"} />
          <CloseMetric label="网络" value="Hyperliquid Testnet" />
        </div>
        {intent?.mode === "limit" ? (
          <label className="xh-real-close-limit-field">
            <span>限价</span>
            <div><input autoFocus inputMode="decimal" onChange={(event) => setIntent((current) => current ? { ...current, limitPrice: event.target.value } : current)} value={intent.limitPrice ?? ""} /><b>USDC</b></div>
          </label>
        ) : null}
        <div className="xh-real-confirm-warning" role="note">
          {intent?.scope === "all"
            ? "全部持仓将以市价平仓。市场波动可能产生滑点，提交后无法撤销。"
            : intent?.mode === "market"
              ? "该持仓将以市价平仓。市场波动可能产生滑点，提交后无法撤销。"
              : intent?.mode === "reverse"
                ? "当前持仓将被平仓并反向开仓，成交结果以交易所返回为准。"
                : "限价平仓不会保证立即成交，未成交订单将保留在当前委托。"}
        </div>
        <div className="xh-real-confirm-actions">
          <Button disabled={submitting} onClick={() => setIntent(null)} type="button" variant="secondary">取消</Button>
          <Button disabled={submitting || intent?.positions.length === 0 || (intent?.mode === "limit" && !(Number(intent.limitPrice) > 0))} onClick={() => void confirmClose()} type="button" variant="danger">
            {submitting ? "提交中" : "确认平仓"}
          </Button>
        </div>
      </Modal>

      <Modal
        open={tpslIntent !== null}
        title="设置止盈/止损"
        onClose={() => setTpslIntent(null)}
        shellClassName="xh-real-confirm-modal"
      >
        <div className="xh-real-confirm-summary">
          <CloseMetric label="资产" value={tpslIntent?.position.coin ?? "-"} />
          <CloseMetric label="方向" value={tpslIntent?.position.side === "short" ? "做空" : "做多"} />
          <CloseMetric label="标记价格" value={formatNumber(tpslIntent?.position.markPx ?? tpslIntent?.position.markPrice)} />
          <CloseMetric label="数量" value={formatNumber(tpslIntent?.position.size)} />
        </div>
        <div className="xh-real-tpsl-fields">
          <label className="xh-real-close-limit-field"><span>止盈价</span><div><input inputMode="decimal" onChange={(event) => setTpslIntent((current) => current ? { ...current, tpPrice: event.target.value } : current)} value={tpslIntent?.tpPrice ?? ""} /><b>USDC</b></div></label>
          <label className="xh-real-close-limit-field"><span>止损价</span><div><input inputMode="decimal" onChange={(event) => setTpslIntent((current) => current ? { ...current, slPrice: event.target.value } : current)} value={tpslIntent?.slPrice ?? ""} /><b>USDC</b></div></label>
        </div>
        <div className="xh-real-confirm-actions">
          <Button disabled={submitting} onClick={() => setTpslIntent(null)} type="button" variant="secondary">取消</Button>
          <Button disabled={submitting || (!tpslIntent?.tpPrice?.trim() && !tpslIntent?.slPrice?.trim())} onClick={() => void confirmTpsl()} type="button">{submitting ? "提交中" : "确认"}</Button>
        </div>
      </Modal>
    </div>
  );
}

function CloseMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function closeTitle(mode?: RealPositionCloseRequest["mode"]) {
  if (mode === "market") return "确认市价平仓";
  if (mode === "reverse") return "确认反手";
  return "确认限价平仓";
}

function closeModeLabel(mode?: RealPositionCloseRequest["mode"]) {
  if (mode === "market") return "市价";
  if (mode === "reverse") return "反手";
  return "限价";
}

function positionValue(position: RealPosition) {
  if (typeof position.positionValue === "number" && Number.isFinite(position.positionValue)) return position.positionValue;
  const markPrice = position.markPx ?? position.markPrice;
  if (typeof markPrice !== "number" || !Number.isFinite(markPrice)) return null;
  return Math.abs(position.size) * markPrice;
}

function formatPnl(position: RealPosition) {
  const pnl = formatSignedMoney(position.unrealizedPnl);
  if (typeof position.returnOnEquity === "number" && Number.isFinite(position.returnOnEquity)) {
    return `${pnl} (${(position.returnOnEquity * 100).toFixed(2)}%)`;
  }
  if (typeof position.unrealizedPnl !== "number" || typeof position.margin !== "number" || position.margin === 0) return pnl;
  return `${pnl} (${((position.unrealizedPnl / position.margin) * 100).toFixed(2)}%)`;
}

function formatTriggerPrice(
  orders: RealOpenOrder[],
  position: RealPosition,
  symbols: RealTradingSymbol[],
  type: "tp" | "sl",
) {
  const value = triggerPrice(orders, position, symbols, type);
  return value ? formatNumber(Number(value)) : "设置";
}

function triggerPrice(
  orders: RealOpenOrder[],
  position: RealPosition,
  symbols: RealTradingSymbol[],
  type: "tp" | "sl",
) {
  const market = resolveRealTradingSymbolForRecord(position, symbols);
  if (!market) return undefined;
  const order = orders.find((item) => {
    if (!item.isTrigger || !recordBelongsToMarket(item, market, symbols)) return false;
    const text = `${item.orderType ?? ""} ${item.triggerCondition ?? ""}`.toLowerCase();
    return type === "tp" ? text.includes("take") || text.includes("tp") : text.includes("stop") || text.includes("sl");
  });
  return typeof order?.triggerPx === "number" && Number.isFinite(order.triggerPx) ? String(order.triggerPx) : undefined;
}

function formatMargin(position: RealPosition) {
  const margin = formatCurrency(position.margin);
  return typeof position.leverage === "number" ? `${margin} · ${position.leverage}x` : margin;
}

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "-";
}

function formatCurrency(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : "-";
}

function formatSignedMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "-";
}

function numberTone(value?: number | null) {
  if (typeof value !== "number" || value === 0) return "";
  return value > 0 ? "is-positive" : "is-negative";
}

function positionSideTone(side: RealPosition["side"]) {
  if (side === "long") return "is-positive";
  if (side === "short") return "is-negative";
  return "";
}
