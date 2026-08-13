import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Wifi } from "lucide-react";
import {
  checkBinanceConnection,
  fetchBinanceAccount,
  fetchBinanceMarket,
  fetchBinanceOrders,
  fetchBinanceStatus,
  type BinanceAccountSnapshot,
  type BinanceMarketSnapshot,
  type BinanceOrdersState,
  type BinanceStatus,
} from "../../../api/binancePersonalTrading";
import { Button } from "../../../components/ui/Button";

export type BinanceDetailState<T> =
  | { status: "loading" }
  | { status: "success"; value: T }
  | { status: "error" };

type BinanceDiagnosticsState = {
  status: BinanceDetailState<BinanceStatus>;
  account: BinanceDetailState<BinanceAccountSnapshot>;
  market: BinanceDetailState<BinanceMarketSnapshot>;
  orders: BinanceDetailState<BinanceOrdersState>;
};

const loadingState = (): BinanceDiagnosticsState => ({
  status: { status: "loading" },
  account: { status: "loading" },
  market: { status: "loading" },
  orders: { status: "loading" },
});

export function BinanceAccountDiagnostics() {
  const [state, setState] = useState<BinanceDiagnosticsState>(() => loadingState());
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState(loadingState());
    const [status, account, market, orders] = await Promise.allSettled([
      fetchBinanceStatus(signal),
      fetchBinanceAccount(signal),
      fetchBinanceMarket(signal),
      fetchBinanceOrders(signal),
    ]);
    if (signal?.aborted) return;
    setState({
      status: settledState(status),
      account: settledState(account),
      market: settledState(market),
      orders: settledState(orders),
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const checkConnection = async () => {
    setChecking(true);
    try {
      const status = await checkBinanceConnection();
      setState((current) => ({ ...current, status: { status: "success", value: status } }));
      await load();
    } catch {
      setState((current) => ({ ...current, status: { status: "error" } }));
    } finally {
      setChecking(false);
    }
  };

  return <BinanceDiagnosticsContent checking={checking} onCheckConnection={() => void checkConnection()} onRefresh={() => void load()} state={state} />;
}

export function BinanceDiagnosticsContent({ checking, onCheckConnection, onRefresh, state }: {
  checking: boolean;
  onCheckConnection: () => void;
  onRefresh: () => void;
  state: BinanceDiagnosticsState;
}) {
  const status = state.status.status === "success" ? state.status.value : null;
  return (
    <section className="space-y-4 border-t border-[#25282f] pt-5" aria-labelledby="binance-diagnostics-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white" id="binance-diagnostics-title">Binance 账户诊断</h3>
          <p className="mt-1 text-xs leading-5 text-[#8f99a5]">账户、行情和订单均为只读数据；连接检查不会提交订单。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={checking} onClick={onCheckConnection} type="button" variant="secondary"><Wifi size={14} />{checking ? "检查中" : "检查连接"}</Button>
          <Button onClick={onRefresh} type="button" variant="ghost"><RefreshCw size={14} />刷新详情</Button>
        </div>
      </div>

      <DetailBlock title="连接与交易安全状态">
        <MetricGrid>
          <DiagnosticMetric label="连接状态" value={connectionLabel(state.status)} />
          <DiagnosticMetric label="真实交易" value={status ? (status.risk.liveTradingEnabled ? "已启用" : "已关闭") : unavailable(state.status)} />
          <DiagnosticMetric label="Binance 急停" value={status ? (status.risk.killSwitchActive ? "已开启" : "已解除") : unavailable(state.status)} />
          <DiagnosticMetric label="单笔上限" value={status ? money(status.risk.maxOrderUsd) : unavailable(state.status)} />
          <DiagnosticMetric label="仓位上限" value={status ? money(status.risk.maxPositionUsd) : unavailable(state.status)} />
          <DiagnosticMetric label="最近检查" value={status?.connection.checkedAt ? dateTime(status.connection.checkedAt) : "暂无可靠数据"} />
        </MetricGrid>
      </DetailBlock>

      <DetailBlock title="Spot / Futures 账户">
        {state.account.status === "success" ? <AccountMetrics account={state.account.value} /> : <Unavailable state={state.account} text="Binance 账户信息暂时不可用" />}
      </DetailBlock>

      <DetailBlock title="市场与 Funding">
        {state.market.status === "success" ? <MarketMetrics market={state.market.value} /> : <Unavailable state={state.market} text="Binance 市场信息暂时不可用" />}
      </DetailBlock>

      <DetailBlock title="订单诊断">
        {state.orders.status === "success" ? <OrdersTable orders={state.orders.value} /> : <Unavailable state={state.orders} text="Binance 订单诊断暂时不可用" />}
      </DetailBlock>
    </section>
  );
}

function AccountMetrics({ account }: { account: BinanceAccountSnapshot }) {
  return <MetricGrid>
    <DiagnosticMetric label="Spot 可用 USDT" value={money(account.spotAvailableUsdt)} />
    <DiagnosticMetric label="Futures 可用 USDT" value={money(account.futuresAvailableUsdt)} />
    <DiagnosticMetric label="现货 XAUT 总量" value={quantity(account.existingSpotQuantityXaut)} />
    <DiagnosticMetric label="现货 XAUT 可用" value={quantity(account.spotAvailableQuantityXaut)} />
    <DiagnosticMetric label="现货 XAUT 锁定" value={quantity(account.spotLockedQuantityXaut)} />
    <DiagnosticMetric label="永续 XAUT 仓位" value={`${positionSide(account.perpetualPositionSide)} · ${quantity(account.existingPerpetualQuantityXaut)}`} />
    <DiagnosticMetric label="永续杠杆 / 保证金" value={`${account.perpetual.leverage ?? "暂无可靠数据"} / ${marginMode(account.perpetual.marginMode)}`} />
    <DiagnosticMetric label="活动订单" value={`现货 ${account.openSpotOrderCount} · 永续 ${account.openPerpetualOrderCount}`} />
    <DiagnosticMetric label="账户快照时间" value={dateTime(account.fetchedAt)} />
  </MetricGrid>;
}

function MarketMetrics({ market }: { market: BinanceMarketSnapshot }) {
  return <MetricGrid>
    <DiagnosticMetric label="Spot 市场状态" value={instrumentStatus(market.spot.status)} />
    <DiagnosticMetric label="Futures 市场状态" value={instrumentStatus(market.perpetual.status)} />
    <DiagnosticMetric label="Spot Bid / Ask" value={`${money(market.spot.bid)} / ${money(market.spot.ask)}`} />
    <DiagnosticMetric label="Futures Bid / Mark" value={`${money(market.perpetual.bid)} / ${money(market.perpetual.mark)}`} />
    <DiagnosticMetric label="Funding rate" value={percent(market.perpetual.fundingRate * 100, 4)} />
    <DiagnosticMetric label="下次结算时间" value={market.perpetual.nextFundingTime ? dateTime(market.perpetual.nextFundingTime) : "暂无可靠数据"} />
    <DiagnosticMetric label="Funding 间隔" value={`${market.perpetual.fundingIntervalHours} 小时`} />
    <DiagnosticMetric label="最小名义金额" value={`Spot ${money(market.spot.minNotionalUsd)} · Futures ${money(market.perpetual.minNotionalUsd)}`} />
    <DiagnosticMetric label="Taker 费率" value={`Spot ${market.fees.spotTakerBps} bps · Futures ${market.fees.perpetualTakerBps} bps`} />
    <DiagnosticMetric label="市场快照时间" value={dateTime(market.fetchedAt)} />
  </MetricGrid>;
}

function OrdersTable({ orders }: { orders: BinanceOrdersState }) {
  if (orders.orders.length === 0) return <p className="p-4 text-xs text-[#8f99a5]">当前没有 StellaX 关联的订单诊断记录。</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs">
    <thead className="border-b border-[#25282f] bg-black text-[#8f99a5]"><tr>{["时间", "市场", "诊断模式", "状态", "请求数量", "成交数量", "均价", "结果"].map((label) => <th className="px-3 py-3 font-medium" key={label}>{label}</th>)}</tr></thead>
    <tbody className="divide-y divide-[#25282f]">{orders.orders.map((order) => <tr key={order.idempotencyKey}>
      <td className="px-3 py-3 text-[#c5ccd4]">{dateTime(order.createdAt)}</td>
      <td className="px-3 py-3 text-white">{order.category === "spot" ? "Spot" : "Futures"}</td>
      <td className="px-3 py-3 text-[#c5ccd4]">{order.executionMode === "test_gtc" ? "测试诊断" : "真实执行记录"}</td>
      <td className="px-3 py-3 text-white">{order.order ? orderStatus(order.order.status) : storedOrderStatus(order.status)}</td>
      <td className="px-3 py-3 font-mono text-[#c5ccd4]">{quantity(order.order?.requestedQuantityXaut)}</td>
      <td className="px-3 py-3 font-mono text-[#c5ccd4]">{quantity(order.order?.filledQuantityXaut)}</td>
      <td className="px-3 py-3 font-mono text-[#c5ccd4]">{money(order.order?.averagePrice)}</td>
      <td className="max-w-60 break-words px-3 py-3 text-[#c5ccd4]">{order.error ? "执行记录包含错误" : "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function DetailBlock({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="border border-[#25282f]"><h4 className="border-b border-[#25282f] bg-black px-4 py-3 text-xs font-semibold text-white">{title}</h4>{children}</section>;
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid gap-px bg-[#25282f] sm:grid-cols-2 lg:grid-cols-3">{children}</dl>;
}

function DiagnosticMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-[#0b0d11] p-3"><dt className="text-[11px] text-[#8f99a5]">{label}</dt><dd className="mt-1 break-words font-mono text-sm text-white">{value}</dd></div>;
}

function Unavailable<T>({ state, text }: { state: BinanceDetailState<T>; text: string }) {
  return <div className="flex items-center gap-2 p-4 text-xs text-[#8f99a5]">{state.status === "error" ? <AlertTriangle className="text-amber-200" size={14} /> : null}{state.status === "loading" ? "正在加载…" : text}</div>;
}

function settledState<T>(result: PromiseSettledResult<T>): BinanceDetailState<T> {
  return result.status === "fulfilled" ? { status: "success", value: result.value } : { status: "error" };
}

function connectionLabel(state: BinanceDetailState<BinanceStatus>) {
  if (state.status !== "success") return unavailable(state);
  return { connected: "已连接", checking: "检查中", failed: "连接失败", not_configured: "未配置" }[state.value.connection.status];
}

function unavailable<T>(state: BinanceDetailState<T>) { return state.status === "loading" ? "加载中" : "暂无可靠数据"; }
function positionSide(value: BinanceAccountSnapshot["perpetualPositionSide"]) { return { long: "多头", short: "空头", flat: "无仓位" }[value]; }
function marginMode(value: BinanceAccountSnapshot["perpetual"]["marginMode"]) { return { cross: "全仓", isolated: "逐仓", unknown: "暂无法确认" }[value]; }
function instrumentStatus(value: BinanceMarketSnapshot["spot"]["status"]) { return { Trading: "可交易", Paused: "已暂停", Unknown: "暂无法确认" }[value]; }
function storedOrderStatus(value: BinanceOrdersState["orders"][number]["status"]) { return { processing: "处理中", completed: "已完成", failed: "失败" }[value]; }
function orderStatus(value: NonNullable<BinanceOrdersState["orders"][number]["order"]>["status"]) { return { New: "已创建", PartiallyFilled: "部分成交", Filled: "已成交", Cancelled: "已取消", Rejected: "已拒绝", Expired: "已过期", Unknown: "暂无法确认" }[value]; }
function money(value: number | null | undefined) { return value === null || value === undefined || !Number.isFinite(value) ? "暂无可靠数据" : value.toLocaleString("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 2 }); }
function quantity(value: number | null | undefined) { return value === null || value === undefined || !Number.isFinite(value) ? "暂无可靠数据" : value.toLocaleString("zh-CN", { maximumFractionDigits: 8 }); }
function percent(value: number, digits: number) { return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "暂无可靠数据"; }
function dateTime(value: number) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
