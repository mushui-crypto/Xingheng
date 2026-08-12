import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  RefreshCw,
  ShieldOff,
  Wifi,
} from "lucide-react";
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

type LoadStepKey = "connection" | "account" | "balance" | "positions" | "market" | "orders";
type LoadStep = { status: "idle" | "success" | "failed" | "skipped"; message: string | null };

const emptyLoadSteps: Record<LoadStepKey, LoadStep> = {
  connection: { status: "idle", message: null },
  account: { status: "idle", message: null },
  balance: { status: "idle", message: null },
  positions: { status: "idle", message: null },
  market: { status: "idle", message: null },
  orders: { status: "idle", message: null },
};

export function BinanceTradingWorkbench({ reloadToken }: { reloadToken: number }) {
  const [status, setStatus] = useState<BinanceStatus | null>(null);
  const [account, setAccount] = useState<BinanceAccountSnapshot | null>(null);
  const [market, setMarket] = useState<BinanceMarketSnapshot | null>(null);
  const [orders, setOrders] = useState<BinanceOrdersState>({ orders: [] });
  const [loadSteps, setLoadSteps] = useState<Record<LoadStepKey, LoadStep>>(emptyLoadSteps);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async (initial = false, signal?: AbortSignal) => {
    initial ? setLoading(true) : setRefreshing(true);
    setError("");
    setLoadSteps(emptyLoadSteps);
    try {
      const nextStatus = await fetchBinanceStatus(signal);
      setStatus(nextStatus);
      setLoadSteps((current) => ({
        ...current,
        connection: {
          status: nextStatus.connection.status === "failed" ? "failed" : nextStatus.credential.configured ? "success" : "skipped",
          message: nextStatus.connection.message,
        },
      }));
      if (!nextStatus.credential.configured) {
        setAccount(null);
        setMarket(null);
        setOrders({ orders: [] });
        setLoadSteps((current) => markSteps(current, ["account", "balance", "positions", "market", "orders"], "skipped", "Binance API credential is not configured."));
        return;
      }
      const [nextAccount, nextMarket, nextOrders] = await Promise.all([
        settle(fetchBinanceAccount(signal)),
        settle(fetchBinanceMarket(signal)),
        settle(fetchBinanceOrders(signal)),
      ]);

      if (nextAccount.ok) {
        setAccount(nextAccount.value);
        setLoadSteps((current) => markSteps(current, ["account", "balance", "positions"], "success", null));
      } else if (!signal?.aborted) {
        setAccount(null);
        setLoadSteps((current) => markSteps(current, ["account", "balance", "positions"], "failed", `Account snapshot query failed: ${nextAccount.message}`));
      }

      if (nextMarket.ok) {
        setMarket(nextMarket.value);
        setLoadSteps((current) => markSteps(current, ["market"], "success", null));
      } else if (!signal?.aborted) {
        setMarket(null);
        setLoadSteps((current) => markSteps(current, ["market"], "failed", `Market query failed: ${nextMarket.message}`));
      }

      if (nextOrders.ok) {
        setOrders(nextOrders.value);
        setLoadSteps((current) => markSteps(current, ["orders"], "success", null));
      } else if (!signal?.aborted) {
        setOrders({ orders: [] });
        setLoadSteps((current) => markSteps(current, ["orders"], "failed", `Orders query failed: ${nextOrders.message}`));
      }

      const failures = [nextAccount, nextMarket, nextOrders].filter((item) => !item.ok);
      if (failures.length > 0 && !signal?.aborted) setError("Binance 数据部分加载失败，请查看状态明细。");
    } catch (reason) {
      if (!signal?.aborted) {
        const message = reason instanceof Error ? reason.message : "Binance Personal Trading 数据加载失败。";
        setError(message);
        setLoadSteps((current) => markSteps(current, ["connection"], "failed", `Status query failed: ${message}`));
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(true, controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const checkConnection = async () => {
    setBusyAction("connection");
    setNotice("");
    setError("");
    try {
      setStatus(await checkBinanceConnection());
      setNotice("Binance 连接检查完成。");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Binance 连接检查失败。");
    } finally {
      setBusyAction(null);
    }
  };

  if (loading) return <WorkbenchSkeleton />;

  return (
    <section className="min-w-0 border border-[#25282f] bg-[#0b0d11]" aria-labelledby="binance-workbench-title">
      <header className="flex flex-col gap-4 border-b border-[#25282f] px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-white" id="binance-workbench-title">Binance Personal Trading</h2>
            <ConnectionLabel status={status} />
          </div>
          <p className="mt-1 text-xs leading-5 text-[#8f99a5]">XAUT/USDT 现货与 USD-M 永续资金费率策略</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!status?.credential.configured || busyAction === "connection"} onClick={() => void checkConnection()} type="button" variant="secondary">
            <Wifi size={14} /> {busyAction === "connection" ? "检查中" : "检查连接"}
          </Button>
          <Button disabled={refreshing} onClick={() => void load()} type="button" variant="ghost">
            <RefreshCw className={refreshing ? "animate-spin" : ""} size={14} /> 刷新
          </Button>
        </div>
      </header>

      <RiskStrip status={status} />
      {error ? <Message tone="error" text={error} /> : null}
      {notice ? <Message tone="success" text={notice} /> : null}

      {!status?.credential.configured ? (
        <EmptyState icon={<ShieldOff size={20} />} title="尚未配置 Binance API" description="请先在上方配置并验证 Binance API，工作台不会使用其他交易所配置代替。" />
      ) : (
        <>
          <LoadDiagnostics steps={loadSteps} />
          <AccountSection account={account} />
          <MarketSection market={market} />
          <OrdersSection orders={orders} />
        </>
      )}
    </section>
  );
}

async function settle<T>(promise: Promise<T>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : "Unknown error." };
  }
}

function markSteps(
  current: Record<LoadStepKey, LoadStep>,
  keys: LoadStepKey[],
  status: LoadStep["status"],
  message: string | null,
) {
  return keys.reduce((next, key) => ({ ...next, [key]: { status, message } }), current);
}

function LoadDiagnostics({ steps }: { steps: Record<LoadStepKey, LoadStep> }) {
  return (
    <section className="border-b border-[#25282f]" aria-labelledby="binance-load-diagnostics-title">
      <SectionHeader title="加载状态" />
      <div className="grid gap-px bg-[#25282f] sm:grid-cols-2 xl:grid-cols-3">
        <DiagnosticItem label="Connection" step={steps.connection} />
        <DiagnosticItem label="Account" step={steps.account} />
        <DiagnosticItem label="Balance" step={steps.balance} />
        <DiagnosticItem label="Positions" step={steps.positions} />
        <DiagnosticItem label="Market" step={steps.market} />
        <DiagnosticItem label="Orders" step={steps.orders} />
      </div>
    </section>
  );
}

function DiagnosticItem({ label, step }: { label: string; step: LoadStep }) {
  const color = step.status === "success"
    ? "text-emerald-200"
    : step.status === "failed"
      ? "text-red-200"
      : step.status === "skipped"
        ? "text-amber-200"
        : "text-[#8f99a5]";
  const labelText = step.status === "success" ? "success" : step.status === "failed" ? "failed" : step.status === "skipped" ? "skipped" : "idle";
  return (
    <div className="min-w-0 bg-[#0b0d11] px-4 py-3">
      <p className="text-[11px] text-[#8f99a5]">{label}</p>
      <p className={`mt-1 font-mono text-sm font-semibold ${color}`}>{labelText}</p>
      {step.message ? <p className="mt-1 break-words text-xs leading-5 text-[#aab3bd]">{step.message}</p> : null}
    </div>
  );
}

function RiskStrip({ status }: { status: BinanceStatus | null }) {
  return (
    <div className="grid gap-px border-b border-[#25282f] bg-[#25282f] sm:grid-cols-2 lg:grid-cols-4">
      <StatusMetric label="真实交易" tone={status?.risk.liveTradingEnabled ? "success" : "danger"} value={status?.risk.liveTradingEnabled ? "已启用" : "已关闭"} />
      <StatusMetric label="Binance 急停" tone={status?.risk.killSwitchActive ? "danger" : "success"} value={status?.risk.killSwitchActive ? "已开启" : "已解除"} />
      <StatusMetric label="单笔上限" value={formatMoney(status?.risk.maxOrderUsd)} />
      <StatusMetric label="仓位上限" value={formatMoney(status?.risk.maxPositionUsd)} />
    </div>
  );
}

function AccountSection({ account }: { account: BinanceAccountSnapshot | null }) {
  if (!account) return <UnavailableRow text="账户状态暂不可用。" />;
  return (
    <section className="border-b border-[#25282f]" aria-labelledby="binance-account-title">
      <SectionHeader icon={<CircleDollarSign size={15} />} title="余额与仓位" detail={`快照 ${formatDate(account.fetchedAt)}`} />
      <div className="grid gap-px bg-[#25282f] sm:grid-cols-2 xl:grid-cols-4">
        <StatusMetric label="可用 USDT" value={formatMoney(account.availableUsdt)} />
        <StatusMetric label="现货 XAUT" value={formatQuantity(account.existingSpotQuantityXaut)} />
        <StatusMetric label="永续 XAUT" value={formatQuantity(account.existingPerpetualQuantityXaut)} />
        <StatusMetric label="活动订单" value={`${account.openSpotOrderCount + account.openPerpetualOrderCount} 笔`} />
      </div>
    </section>
  );
}

function MarketSection({ market }: { market: BinanceMarketSnapshot | null }) {
  if (!market) return <UnavailableRow text="Spot/Futures 行情暂不可用。" />;
  return (
    <section className="border-b border-[#25282f]" aria-labelledby="binance-market-title">
      <SectionHeader title="Spot / Futures 行情" detail={`更新 ${formatDate(market.fetchedAt)}`} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="bg-black text-[#8f99a5]"><tr>{["市场", "状态", "Bid", "Ask / Mark", "Funding", "下次结算", "最小名义金额"].map((item) => <th className="px-4 py-3 font-medium" key={item}>{item}</th>)}</tr></thead>
          <tbody className="divide-y divide-[#25282f] text-[#d7dce2]">
            <tr><td className="px-4 py-3 font-semibold text-white">Spot XAUTUSDT</td><td className="px-4 py-3">{market.spot.status}</td><Mono value={formatMoney(market.spot.bid)} /><Mono value={formatMoney(market.spot.ask)} /><td className="px-4 py-3">-</td><td className="px-4 py-3">-</td><Mono value={formatMoney(market.spot.minNotionalUsd)} /></tr>
            <tr><td className="px-4 py-3 font-semibold text-white">USD-M XAUTUSDT</td><td className="px-4 py-3">{market.perpetual.status}</td><Mono value={formatMoney(market.perpetual.bid)} /><Mono value={formatMoney(market.perpetual.mark)} /><Mono value={formatPercent(market.perpetual.fundingRate * 100, 4)} /><td className="px-4 py-3">{market.perpetual.nextFundingTime ? formatDate(market.perpetual.nextFundingTime) : "-"}</td><Mono value={formatMoney(market.perpetual.minNotionalUsd)} /></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrdersSection({ orders }: { orders: BinanceOrdersState }) {
  return (
    <section aria-labelledby="binance-orders-title">
      <div className="border-b border-[#25282f] px-4 py-4 sm:px-5">
        <h3 className="text-sm font-semibold text-white" id="binance-orders-title">订单状态</h3>
      </div>
      {orders.orders.length === 0 ? <EmptyState icon={<CheckCircle2 size={20} />} title="暂无订单" description="执行记录关联的订单会显示在这里。" /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-left text-xs">
            <thead className="bg-black text-[#8f99a5]"><tr>{["时间", "市场", "模式", "状态", "请求数量", "成交数量", "均价", "错误"].map((item) => <th className="px-4 py-3 font-medium" key={item}>{item}</th>)}</tr></thead>
            <tbody className="divide-y divide-[#25282f] text-[#d7dce2]">{orders.orders.map((item) => <tr key={item.idempotencyKey}><td className="px-4 py-3">{formatDate(item.createdAt)}</td><td className="px-4 py-3">{item.category === "spot" ? "Spot" : "USD-M"}</td><td className="px-4 py-3">{item.executionMode === "test_gtc" ? "测试订单" : "真实订单"}</td><td className="px-4 py-3 font-medium text-white">{item.order?.status ?? item.status}</td><Mono value={formatQuantity(item.order?.requestedQuantityXaut)} /><Mono value={formatQuantity(item.order?.filledQuantityXaut)} /><Mono value={formatMoney(item.order?.averagePrice)} /><td className="max-w-[280px] break-words px-4 py-3 text-red-200">{item.error ?? "-"}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ConnectionLabel({ status }: { status: BinanceStatus | null }) {
  const value = status?.connection.status ?? "not_configured";
  const labels = { connected: "已连接", checking: "检查中", failed: "连接失败", not_configured: "未配置" };
  return <span className={`border px-2 py-0.5 text-[11px] ${value === "connected" ? "border-emerald-400/30 text-emerald-200" : value === "failed" ? "border-red-400/30 text-red-200" : "border-white/20 text-[#aab3bd]"}`}>{labels[value]}</span>;
}

function SectionHeader({ detail, icon, title }: { detail?: string; icon?: React.ReactNode; title: string }) {
  return <header className="flex items-center justify-between gap-4 border-b border-[#25282f] bg-black px-4 py-3 sm:px-5"><h3 className="flex items-center gap-2 text-xs font-semibold text-white">{icon}{title}</h3>{detail ? <span className="text-[11px] text-[#707985]">{detail}</span> : null}</header>;
}

function StatusMetric({ label, tone, value }: { label: string; tone?: "success" | "danger"; value: string }) {
  return <div className="min-w-0 bg-[#0b0d11] px-4 py-3"><p className="text-[11px] text-[#8f99a5]">{label}</p><p className={`mt-1 break-words font-mono text-sm font-semibold ${tone === "success" ? "text-emerald-200" : tone === "danger" ? "text-red-200" : "text-white"}`}>{value}</p></div>;
}

function Mono({ value }: { value: string }) { return <td className="px-4 py-3 font-mono text-white">{value}</td>; }

function Message({ text, tone }: { text: string; tone: "error" | "success" }) {
  return <div className={`flex items-start gap-2 border-b px-4 py-3 text-xs leading-5 ${tone === "error" ? "border-red-400/30 bg-red-500/[0.08] text-red-200" : "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200"}`} role={tone === "error" ? "alert" : "status"}>{tone === "error" ? <AlertTriangle className="mt-0.5 shrink-0" size={15} /> : <CheckCircle2 className="mt-0.5 shrink-0" size={15} />}{text}</div>;
}

function EmptyState({ description, icon, title }: { description: string; icon: React.ReactNode; title: string }) {
  return <div className="flex min-h-36 flex-col items-center justify-center px-5 py-8 text-center text-[#c5ccd4]">{icon}<strong className="mt-3 text-sm text-white">{title}</strong><p className="mt-2 max-w-xl text-xs leading-5 text-[#8f99a5]">{description}</p></div>;
}

function UnavailableRow({ text }: { text: string }) { return <div className="border-b border-[#25282f] px-5 py-5 text-xs text-[#8f99a5]">{text}</div>; }

function WorkbenchSkeleton() { return <div className="h-[720px] animate-pulse border border-[#25282f] bg-[#0b0d11]" aria-label="正在加载 Binance Personal Trading" />; }

function formatMoney(value: number | null | undefined) { return value === null || value === undefined || !Number.isFinite(value) ? "-" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }); }
function formatQuantity(value: number | null | undefined) { return value === null || value === undefined || !Number.isFinite(value) ? "-" : value.toLocaleString("en-US", { maximumFractionDigits: 8 }); }
function formatPercent(value: number, digits: number) { return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "-"; }
function formatDate(value: number) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
