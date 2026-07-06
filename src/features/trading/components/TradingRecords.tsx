import { XCircle } from "lucide-react";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import type { OrderRecord, PositionView } from "../../../api/market";
import type { SimulationAccountView } from "../../../api/walletApi";
import { formatPrice } from "../../../utils/price";
import { formatQuantity } from "../../../utils/quantity";

export function TradingPositionsTable({
  closingPositionId,
  digits,
  hasSimulationAccounts,
  needsSimulationAccount,
  onClosePosition,
  positions,
  selectedSimulationAccount,
  lotStep,
}: {
  closingPositionId: string | null;
  digits: number;
  hasSimulationAccounts: boolean;
  needsSimulationAccount: boolean;
  onClosePosition: (positionId: string) => void;
  positions: PositionView[];
  selectedSimulationAccount: SimulationAccountView | null;
  lotStep: number;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line p-4">
        <h2 className="font-semibold">模拟持仓</h2>
        <p className="mt-1 text-sm text-muted">
          {selectedSimulationAccount ? `${selectedSimulationAccount.name ?? "当前模拟账户"} · ${selectedSimulationAccount.id}` : "选择模拟账户后展示对应持仓。"}
        </p>
      </div>
      {needsSimulationAccount ? (
        <div className="p-8 text-center text-sm text-muted">{hasSimulationAccounts ? "模拟账户不可用。" : "请先创建模拟账户。"}</div>
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
                  <td className="px-5 py-4">{formatQuantity(position.volume, lotStep)}</td>
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
                      onClick={() => onClosePosition(position.id)}
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
  );
}

export function TradingOrdersTable({
  digits,
  hasSimulationAccounts,
  needsSimulationAccount,
  orders,
  selectedSimulationAccount,
  lotStep,
}: {
  digits: number;
  hasSimulationAccounts: boolean;
  needsSimulationAccount: boolean;
  orders: OrderRecord[];
  selectedSimulationAccount: SimulationAccountView | null;
  lotStep: number;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line p-4">
        <h2 className="font-semibold">订单记录</h2>
        <p className="mt-1 text-sm text-muted">
          {selectedSimulationAccount ? `${selectedSimulationAccount.name ?? "当前模拟账户"} · ${selectedSimulationAccount.id}` : "选择模拟账户后展示对应订单。"}
        </p>
      </div>
      {needsSimulationAccount ? (
        <div className="p-8 text-center text-sm text-muted">{hasSimulationAccounts ? "模拟账户不可用。" : "请先创建模拟账户。"}</div>
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
                  <td className="px-5 py-4">{order.side} / {formatQuantity(order.volume, lotStep)}</td>
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
  );
}
