import { useMemo, useState, type CSSProperties } from "react";
import type { ApiTicker, TradingAccount } from "../../../api/market";
import type { TradeSymbol } from "../../../types/market";
import { formatQuantity, normalizeQuantity } from "../../../utils/quantity";

export function TradingOrderPanel({
  account,
  message,
  needsSimulationAccount,
  onSubmitOrder,
  orderDisabled,
  positionSize,
  selectedConfig,
  setVolume,
  simulationAccountsLoading,
  ticker,
  volume,
}: {
  account: TradingAccount | null;
  message: string;
  needsSimulationAccount: boolean;
  onSubmitOrder: (side: "buy" | "sell") => void;
  orderDisabled: boolean;
  positionSize: number;
  selectedConfig: TradeSymbol;
  setVolume: (volume: number) => void;
  simulationAccountsLoading: boolean;
  ticker: ApiTicker;
  volume: number;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const referencePrice = side === "buy" ? ticker.ask : ticker.bid;
  const maxQuantity = useMemo(() => {
    if (!account?.freeMargin || !referencePrice || referencePrice <= 0) return selectedConfig.minLot;
    const affordable = account.freeMargin * selectedConfig.leverage / (referencePrice * selectedConfig.contractSize);
    return Math.max(selectedConfig.minLot, Math.min(selectedConfig.maxLot, snapQuantity(affordable, selectedConfig.lotStep)));
  }, [account?.freeMargin, referencePrice, selectedConfig]);
  const percent = maxQuantity <= selectedConfig.minLot
    ? 0
    : Math.round(((volume - selectedConfig.minLot) / (maxQuantity - selectedConfig.minLot)) * 100);
  const boundedPercent = Math.max(0, Math.min(100, percent));
  const orderValue = referencePrice ? referencePrice * volume * selectedConfig.contractSize : null;
  const requiredMargin = orderValue === null ? null : orderValue / selectedConfig.leverage;

  const updatePercent = (nextPercent: number) => {
    const next = selectedConfig.minLot + (maxQuantity - selectedConfig.minLot) * (nextPercent / 100);
    setVolume(snapQuantity(Math.max(selectedConfig.minLot, Math.min(maxQuantity, next)), selectedConfig.lotStep));
  };

  const submit = (nextSide: "buy" | "sell") => {
    setSide(nextSide);
    onSubmitOrder(nextSide);
  };

  return (
    <section className="xh-real-order-panel xh-demo-order-panel">
      <div className="xh-real-order-topline">
        <div className="xh-demo-order-topline-control">模拟账户</div>
        <div className="xh-demo-order-topline-control">{selectedConfig.leverage}x</div>
      </div>
      <div className="xh-real-position-tabs" role="tablist" aria-label="仓位动作">
        <button className="is-active" role="tab" type="button">开仓</button>
        <button disabled role="tab" type="button">平仓</button>
      </div>
      <div className="xh-real-type-tabs" role="tablist" aria-label="订单类型">
        <button className="is-active" role="tab" type="button">市价</button>
      </div>
      <fieldset className="xh-real-order-form" disabled={false}>
        <div className="xh-real-order-entry-fields">
          <div className="xh-real-order-balance">
            <span>可用余额</span><strong>{account?.freeMargin?.toFixed(2) ?? "0.00"} USDT</strong>
            <span>当前仓位</span><strong>{formatQuantity(positionSize, selectedConfig.lotStep)}</strong>
          </div>
          <label className="xh-real-order-field">
            <span>数量</span>
            <div>
              <input
                max={selectedConfig.maxLot}
                min={selectedConfig.minLot}
                onChange={(event) => setVolume(Number(event.target.value))}
                step={selectedConfig.lotStep}
                type="number"
                value={volume}
              />
              <b>{selectedConfig.apiSymbol}</b>
            </div>
          </label>
        </div>
      </fieldset>
      <div className="xh-real-position-percent-control">
        <div className="xh-real-position-percent">
          <span className="xh-real-position-percent-track" style={{ "--position-percent": `${boundedPercent}%` } as CSSProperties} />
          <input aria-label="仓位百分比" max={100} min={0} onChange={(event) => updatePercent(Number(event.target.value))} step={1} type="range" value={boundedPercent} />
          <div className="xh-real-position-percent-nodes" aria-hidden="true">
            {[0, 25, 50, 75, 100].map((node) => <span className={boundedPercent >= node ? "is-active" : ""} key={node} style={{ left: `${node}%` }} />)}
          </div>
        </div>
        <label className="xh-real-position-percent-input">
          <input aria-label="仓位百分比数值" max={100} min={0} onChange={(event) => updatePercent(Number(event.target.value))} type="number" value={boundedPercent} />
          <b>%</b>
        </label>
      </div>
      <div className="xh-real-side-buttons">
        <button className="is-buy-active" disabled={orderDisabled} onClick={() => submit("buy")} type="button">买入 / 做多</button>
        <button className="is-sell-active" disabled={orderDisabled} onClick={() => submit("sell")} type="button">卖出 / 做空</button>
      </div>
      {selectedConfig.tradeStatus !== "enabled" ? <p className="xh-real-order-message">当前品种仅允许平仓</p> : null}
      {!simulationAccountsLoading && needsSimulationAccount ? <p className="xh-real-order-message">模拟账户不可用</p> : null}
      <div className="xh-real-order-metrics">
        <div><span>订单价值</span><strong>{orderValue === null ? "-" : `${orderValue.toFixed(2)} USDT`}</strong></div>
        <div><span>所需保证金</span><strong>{requiredMargin === null ? "-" : `${requiredMargin.toFixed(2)} USDT`}</strong></div>
        <div><span>费用</span><strong>-</strong></div>
      </div>
      {message ? <p className="xh-real-order-message" role="status">{message}</p> : null}
    </section>
  );
}

function snapQuantity(value: number, step: number) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return normalizeQuantity(value);
  return normalizeQuantity(Math.floor((value + step * 1e-9) / step) * step);
}
