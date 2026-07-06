import { AlertTriangle, ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import type { ApiTicker } from "../../../api/market";
import type { TradeSymbol } from "../../../types/market";
import { formatQuantity } from "../../../utils/quantity";
import { Quote } from "./TradingFeedback";

export function TradingOrderPanel({
  digits,
  message,
  needsSimulationAccount,
  onSubmitOrder,
  orderDisabled,
  selectedConfig,
  setVolume,
  simulationAccountsLoading,
  ticker,
  volume,
}: {
  digits: number;
  message: string;
  needsSimulationAccount: boolean;
  onSubmitOrder: (side: "buy" | "sell") => void;
  orderDisabled: boolean;
  selectedConfig: TradeSymbol;
  setVolume: (volume: number) => void;
  simulationAccountsLoading: boolean;
  ticker: ApiTicker;
  volume: number;
}) {
  return (
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
            交易手数（{formatQuantity(selectedConfig.minLot, selectedConfig.lotStep)}-{formatQuantity(selectedConfig.maxLot, selectedConfig.lotStep)} / {formatQuantity(selectedConfig.lotStep, selectedConfig.lotStep)}）
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
          <Button disabled={orderDisabled} onClick={() => onSubmitOrder("buy")}>
            <ArrowUp size={16} /> 买入 Ask
          </Button>
          <Button disabled={orderDisabled} variant="danger" onClick={() => onSubmitOrder("sell")}>
            <ArrowDown size={16} /> 卖出 Bid
          </Button>
        </div>
        {selectedConfig.tradeStatus !== "enabled" ? (
          <p className="mt-3 text-sm text-amber-200">
            当前品种状态为 {selectedConfig.tradeStatus}，仅允许平仓，不可新开仓。
          </p>
        ) : null}
        {!simulationAccountsLoading && needsSimulationAccount ? <p className="mt-3 text-sm text-amber-200">模拟账户不可用。</p> : null}
        {message ? <p className="mt-4 xh-message">{message}</p> : null}
      </Card>
    </div>
  );
}
