import { useState } from "react";
import type { OrderRecord, PositionView } from "../../../api/market";
import type { SimulationAccountView } from "../../../api/walletApi";
import { formatPrice } from "../../../utils/price";
import { formatQuantity } from "../../../utils/quantity";

export function TradingRecords({
  closingPositionId,
  contractSize,
  digits,
  hasSimulationAccounts,
  lotStep,
  needsSimulationAccount,
  onClosePosition,
  orders,
  positions,
  selectedSimulationAccount,
}: {
  closingPositionId: string | null;
  contractSize: number;
  digits: number;
  hasSimulationAccounts: boolean;
  lotStep: number;
  needsSimulationAccount: boolean;
  onClosePosition: (positionId: string) => void;
  orders: OrderRecord[];
  positions: PositionView[];
  selectedSimulationAccount: SimulationAccountView | null;
}) {
  const [tab, setTab] = useState<"positions" | "orders">("positions");
  const emptyText = needsSimulationAccount
    ? (hasSimulationAccounts ? "模拟账户不可用" : "请先创建模拟账户")
    : tab === "positions" ? "暂无模拟持仓" : "暂无模拟订单";
  return (
    <section className="xh-real-records xh-demo-records">
      <div className="xh-real-record-tabs" role="tablist" aria-label="模拟账户记录">
        <button className={tab === "positions" ? "is-active" : ""} onClick={() => setTab("positions")} role="tab" type="button">持仓 <span>{positions.length}</span></button>
        <button className={tab === "orders" ? "is-active" : ""} onClick={() => setTab("orders")} role="tab" type="button">订单记录 <span>{orders.length}</span></button>
        <p className="xh-demo-record-account">{selectedSimulationAccount?.name ?? "模拟账户"}</p>
      </div>
      {tab === "positions" ? (
        <div className="xh-real-record-table xh-demo-position-table">
          <div className="xh-real-record-head xh-demo-position-grid"><span>资产</span><span>方向</span><span>数量</span><span>仓位价值</span><span>开仓价格</span><span>标记价格</span><span>盈亏</span><span>保证金</span><span>操作</span></div>
          {needsSimulationAccount || positions.length === 0 ? <RecordEmpty text={emptyText} /> : positions.map((position) => (
            <div className={`xh-real-record-row xh-demo-position-grid is-${position.side}`} key={position.id}>
              <strong>{position.symbol}</strong>
              <span>{position.side === "long" ? "做多" : "做空"}</span>
              <span className={position.side === "long" ? "is-positive" : "is-negative"}>{formatQuantity(position.volume, lotStep)}</span>
              <span>{formatPrice((position.markPrice ?? position.entryPrice) * position.volume * contractSize, digits)}</span>
              <span>{formatPrice(position.entryPrice, digits)}</span>
              <span>{formatPrice(position.markPrice ?? undefined, digits)}</span>
              <span className={(position.pnl ?? 0) >= 0 ? "is-positive" : "is-negative"}>{position.pnl?.toFixed(2) ?? "-"}</span>
              <span>{position.margin.toFixed(2)}</span>
              <button disabled={closingPositionId !== null} onClick={() => onClosePosition(position.id)} type="button">{closingPositionId === position.id ? "平仓中" : "平仓"}</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="xh-real-record-table xh-demo-order-table">
          <div className="xh-real-record-head xh-demo-order-grid"><span>时间</span><span>动作</span><span>状态</span><span>品种</span><span>方向 / 数量</span><span>成交价</span><span>Bid / Ask</span><span>来源</span><span>说明</span></div>
          {needsSimulationAccount || orders.length === 0 ? <RecordEmpty text={emptyText} /> : orders.map((order) => (
            <div className="xh-real-record-row xh-demo-order-grid" key={order.id}>
              <span>{new Date(order.createdAt).toLocaleString("zh-CN")}</span>
              <span>{order.action === "open" ? "开仓" : "平仓"}</span>
              <span className={order.status === "filled" ? "is-positive" : "is-negative"}>{order.status}</span>
              <strong>{order.symbol}</strong>
              <span className={order.side === "buy" ? "is-positive" : "is-negative"}>{order.side} / {formatQuantity(order.volume, lotStep)}</span>
              <span>{order.price === null ? "-" : formatPrice(order.price, digits)}</span>
              <span>{order.bid === null || order.ask === null ? "-" : `${formatPrice(order.bid, digits)} / ${formatPrice(order.ask, digits)}`}</span>
              <span>{order.source}</span>
              <span>{order.reason ?? (typeof order.pnl === "number" ? `P/L ${order.pnl.toFixed(2)}` : "模拟成交")}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecordEmpty({ text }: { text: string }) {
  return <div className="xh-real-record-empty"><strong>{text}</strong></div>;
}
