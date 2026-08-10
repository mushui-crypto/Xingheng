import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  CircleDollarSign,
  RefreshCw,
  ShieldOff,
  Wifi,
} from "lucide-react";
import {
  BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
  checkBinanceConnection,
  enterBinanceStrategy,
  exitBinanceStrategy,
  fetchBinanceAccount,
  fetchBinanceMarket,
  fetchBinanceOrders,
  fetchBinanceStatus,
  fetchBinanceStrategy,
  reconcileBinance,
  type BinanceAccountSnapshot,
  type BinanceMarketSnapshot,
  type BinanceOrdersState,
  type BinanceStatus,
  type BinanceStrategyStatus,
  type BinanceUserExecutionMode,
} from "../../../api/binancePersonalTrading";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Modal } from "../../../components/ui/Modal";
import { canEnterBinancePosition, createIdempotencyKey } from "../model/personalTradingState";

type Action = "enter" | "exit" | null;

export function BinanceTradingWorkbench({ reloadToken }: { reloadToken: number }) {
  const [status, setStatus] = useState<BinanceStatus | null>(null);
  const [account, setAccount] = useState<BinanceAccountSnapshot | null>(null);
  const [market, setMarket] = useState<BinanceMarketSnapshot | null>(null);
  const [strategy, setStrategy] = useState<BinanceStrategyStatus | null>(null);
  const [orders, setOrders] = useState<BinanceOrdersState>({ orders: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [executionMode, setExecutionMode] =
    useState<BinanceUserExecutionMode>("EXECUTION_PRIORITY");
  const [existingExposureRiskAcknowledged, setExistingExposureRiskAcknowledged] = useState(false);

  const load = useCallback(async (initial = false, signal?: AbortSignal) => {
    initial ? setLoading(true) : setRefreshing(true);
    setError("");
    try {
      const nextStatus = await fetchBinanceStatus(signal);
      setStatus(nextStatus);
      if (!nextStatus.credential.configured) {
        setAccount(null);
        setMarket(null);
        setStrategy(null);
        setOrders({ orders: [] });
        return;
      }
      const [nextAccount, nextMarket, nextStrategy, nextOrders] = await Promise.all([
        fetchBinanceAccount(signal),
        fetchBinanceMarket(signal),
        fetchBinanceStrategy(signal),
        fetchBinanceOrders(signal),
      ]);
      setAccount(nextAccount);
      setMarket(nextMarket);
      setStrategy(nextStrategy);
      setOrders(nextOrders);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Binance Personal Trading 数据加载失败。");
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

  const reconcile = async () => {
    setBusyAction("reconcile");
    setNotice("");
    setError("");
    try {
      const result = await reconcileBinance();
      setAccount(result.snapshot);
      setOrders({ orders: result.orders });
      setNotice(`对账完成，更新 ${result.reconciled.length} 笔订单。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Binance 对账失败。");
    } finally {
      setBusyAction(null);
    }
  };

  const confirmAction = async () => {
    if (!action) return;
    setBusyAction(action);
    setNotice("");
    setError("");
    try {
      if (action === "enter") {
        const parsedBudget = budgetUsd.trim() ? Number(budgetUsd) : undefined;
        await enterBinanceStrategy({
          idempotencyKey: createIdempotencyKey("strategy-enter"),
          executionMode,
          ...(existingExposureRiskAcknowledged ? {
            existingExposureRiskAcknowledgement: BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
          } : {}),
          ...(parsedBudget && parsedBudget > 0 ? { budgetUsd: parsedBudget } : {}),
        });
        setNotice("建仓请求已完成，请核对订单与持仓。");
      } else {
        await exitBinanceStrategy({ idempotencyKey: createIdempotencyKey("strategy-exit") });
        setNotice("退出请求已完成，请执行对账确认剩余持仓。");
      }
      setAction(null);
      setBudgetUsd("");
      setExecutionMode("EXECUTION_PRIORITY");
      setExistingExposureRiskAcknowledged(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${action === "enter" ? "建仓" : "退出"}失败。`);
    } finally {
      setBusyAction(null);
    }
  };

  const openEntryModal = async () => {
    setBusyAction("entry-modal");
    setError("");
    setExistingExposureRiskAcknowledged(false);
    try {
      const refreshedStrategy = await fetchBinanceStrategy();
      setStrategy(refreshedStrategy);
      setAccount(refreshedStrategy.snapshot);
      setAction("enter");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法刷新 Binance 建仓风险快照。");
    } finally {
      setBusyAction(null);
    }
  };

  if (loading) return <WorkbenchSkeleton />;

  const connected = status?.connection.status === "connected";
  const canExit = Boolean(status?.credential.configured && connected);

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
          <AccountSection account={account} />
          <MarketSection market={market} />
          <StrategySection
            canEnter={canEnterBinancePosition(status)}
            canExit={canExit}
            onEnter={() => void openEntryModal()}
            onExit={() => setAction("exit")}
            strategy={strategy}
          />
          <OrdersSection
            busy={busyAction === "reconcile"}
            onReconcile={() => void reconcile()}
            orders={orders}
            reconciliationEnabled={canExit}
          />
        </>
      )}

      <Modal
        closeDisabled={busyAction === action}
        description={action === "enter" ? "服务端会再次执行风险检查；当前开关关闭时无法提交。" : "退出属于减险操作，不会因建仓开关关闭而在前端禁用。"}
        onClose={() => { if (!busyAction) { setAction(null); setBudgetUsd(""); setExecutionMode("EXECUTION_PRIORITY"); setExistingExposureRiskAcknowledged(false); } }}
        open={Boolean(action)}
        title={action === "enter" ? "确认建立对冲仓位" : "确认退出对冲仓位"}
      >
        <div className="space-y-4">
          {action === "enter" ? (
            <>
              <Input
                inputMode="decimal"
                label="预算（USD，可选）"
                max={status?.risk.maxPositionUsd}
                min="0"
                onChange={(event) => setBudgetUsd(event.target.value)}
                placeholder={`服务端默认，上限 ${formatMoney(status?.risk.maxPositionUsd)}`}
                type="number"
                value={budgetUsd}
              />
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-[#c5ccd4]">执行方式</legend>
                <ExecutionModeOption
                  checked={executionMode === "PRICE_PRIORITY"}
                  description="内部使用限价 IOC，优先控制成交价格，允许未成交。"
                  label="价格优先"
                  onChange={() => setExecutionMode("PRICE_PRIORITY")}
                />
                <ExecutionModeOption
                  checked={executionMode === "EXECUTION_PRIORITY"}
                  description="内部使用市价，优先执行速度，接受成交价格波动。"
                  label="执行优先"
                  onChange={() => setExecutionMode("EXECUTION_PRIORITY")}
                />
              </fieldset>
              <ExistingExposureRiskNotice
                acknowledged={existingExposureRiskAcknowledged}
                onAcknowledgedChange={setExistingExposureRiskAcknowledged}
                strategy={strategy}
              />
            </>
          ) : (
            <p className="text-sm leading-6 text-[#c5ccd4]">系统将先退出永续空仓，再处理可交易的现货数量。完成后仍需执行对账。</p>
          )}
          <div className="flex flex-col-reverse gap-2 border-t border-[#25282f] pt-4 sm:flex-row sm:justify-end">
            <Button disabled={Boolean(busyAction)} onClick={() => { setAction(null); setBudgetUsd(""); setExecutionMode("EXECUTION_PRIORITY"); setExistingExposureRiskAcknowledged(false); }} type="button" variant="ghost">取消</Button>
            <Button disabled={Boolean(busyAction) || (action === "enter" && (!canEnterBinancePosition(status) || strategy?.entryExposure.rulesValid === false || (strategy?.entryExposure.requiresAcknowledgement && !existingExposureRiskAcknowledged)))} onClick={() => void confirmAction()} type="button" variant={action === "exit" ? "danger" : "primary"}>
              {busyAction === action ? "提交中" : action === "enter" ? "确认建仓" : "确认退出"}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

function ExistingExposureRiskNotice({ acknowledged, onAcknowledgedChange, strategy }: {
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  strategy: BinanceStrategyStatus | null;
}) {
  const exposure = strategy?.entryExposure;
  if (!exposure) return null;
  const direction = { long: "LONG", short: "SHORT", flat: "FLAT" }[exposure.perpetual.direction];
  return (
    <div className="space-y-3 border border-amber-400/30 bg-amber-400/[0.05] p-3 text-xs leading-5 text-amber-100">
      <p className="font-semibold">当前账户总 XAUT exposure</p>
      <dl className="grid gap-1 font-mono text-[11px] sm:grid-cols-2">
        <div>Spot total: {formatQuantity(exposure.spot.totalQuantityXaut)}</div>
        <div>Spot notional: {formatMoney(exposure.spot.notionalUsd)}</div>
        <div>Spot free: {formatQuantity(exposure.spot.freeQuantityXaut)}</div>
        <div>Spot locked: {formatQuantity(exposure.spot.lockedQuantityXaut)}</div>
        <div>Perp: {formatQuantity(exposure.perpetual.quantityXaut)}</div>
        <div>Perp direction: {direction}</div>
      </dl>
      <p>本次将新增 Spot LONG + Perp SHORT，并承担额外净敞口风险。</p>
      <p className="font-medium">新增仓位不与已有资产隔离。本次发生 confirmed fill 后失败恢复可能卖出/平掉账户全部可交易 XAUT。</p>
      {!exposure.rulesValid ? (
        <p className="border-t border-red-400/20 pt-3 font-medium text-red-200">交易规则无效，服务端已禁止建仓。请刷新后重试。</p>
      ) : null}
      {exposure.requiresAcknowledgement ? (
        <label className="flex cursor-pointer items-start gap-2 border-t border-amber-400/20 pt-3">
          <input
            checked={acknowledged}
            className="mt-1"
            onChange={(event) => onAcknowledgedChange(event.target.checked)}
            type="checkbox"
          />
          <span>我已理解并允许本次建仓及失败时的账户总 XAUT 恢复操作。</span>
        </label>
      ) : null}
    </div>
  );
}

function ExecutionModeOption({ checked, description, label, onChange }: {
  checked: boolean;
  description: string;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className={`block cursor-pointer border p-3 ${checked ? "border-emerald-400/50 bg-emerald-400/[0.06]" : "border-[#30343b]"}`}>
      <span className="flex items-center gap-2 text-sm font-medium text-white">
        <input checked={checked} name="binance-execution-price-mode" onChange={onChange} type="radio" />
        {label}
      </span>
      <span className="mt-1 block pl-6 text-xs leading-5 text-[#8f99a5]">{description}</span>
    </label>
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

function StrategySection({ canEnter, canExit, onEnter, onExit, strategy }: { canEnter: boolean; canExit: boolean; onEnter: () => void; onExit: () => void; strategy: BinanceStrategyStatus | null }) {
  const opportunity = strategy?.opportunity;
  return (
    <section className="border-b border-[#25282f]" aria-labelledby="binance-strategy-title">
      <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-white" id="binance-strategy-title">资金费率机会</h3>
            {opportunity ? <span className={`border px-2 py-0.5 text-[11px] ${opportunity.eligible ? "border-emerald-400/30 text-emerald-200" : "border-amber-400/30 text-amber-200"}`}>{opportunity.eligible ? "满足策略条件" : "暂不满足"}</span> : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-[#8f99a5]">{opportunity?.reasons.length ? opportunity.reasons.join(" · ") : "等待服务端策略评估"}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button disabled={!canEnter} onClick={onEnter} type="button"><ArrowDownToLine size={14} /> 建立对冲</Button>
          <Button disabled={!canExit} onClick={onExit} type="button" variant="danger"><ArrowUpFromLine size={14} /> 退出策略</Button>
        </div>
      </div>
      <div className="grid gap-px border-t border-[#25282f] bg-[#25282f] sm:grid-cols-3">
        <StatusMetric label="Funding" value={opportunity ? formatPercent(opportunity.fundingRate * 100, 4) : "-"} />
        <StatusMetric label="入场基差" value={opportunity ? `${opportunity.entryBasisBps.toFixed(2)} bps` : "-"} />
        <StatusMetric label="预估净 APR" value={opportunity ? formatPercent(opportunity.estimatedNetAprPercent, 2) : "-"} />
      </div>
    </section>
  );
}

function OrdersSection({ busy, onReconcile, orders, reconciliationEnabled }: { busy: boolean; onReconcile: () => void; orders: BinanceOrdersState; reconciliationEnabled: boolean }) {
  return (
    <section aria-labelledby="binance-orders-title">
      <div className="flex items-center justify-between gap-3 border-b border-[#25282f] px-4 py-4 sm:px-5">
        <div><h3 className="text-sm font-semibold text-white" id="binance-orders-title">订单与 Reconciliation</h3><p className="mt-1 text-xs text-[#8f99a5]">处理中的订单必须通过对账确认最终状态。</p></div>
        <Button disabled={!reconciliationEnabled || busy} onClick={onReconcile} type="button" variant="secondary"><RefreshCw className={busy ? "animate-spin" : ""} size={14} /> {busy ? "对账中" : "执行对账"}</Button>
      </div>
      {orders.orders.length === 0 ? <EmptyState icon={<CheckCircle2 size={20} />} title="暂无订单" description="策略操作产生的订单会显示在这里。" /> : (
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
