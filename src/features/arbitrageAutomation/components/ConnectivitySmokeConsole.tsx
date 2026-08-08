import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AutomationConsoleContractError,
  connectivitySmokeStepUpRequest,
  presentAutomationConsoleError,
} from "../../../api/arbitrageAutomationConsole";
import { Button } from "../../../components/ui/Button";
import type {
  ConnectivitySmokeAcceptance,
  ConnectivitySmokeClient,
  ConnectivitySmokeExecutionRequest,
  ConnectivitySmokeMetric,
  ConnectivitySmokeOrder,
  ConnectivitySmokePolicy,
  ConnectivitySmokePreflight,
  ConnectivitySmokeProviderState,
  ConnectivitySmokeReceipt,
  ConnectivitySmokeStage,
  ConnectivitySmokeStatus,
} from "../model/connectivitySmokeTypes";
import type { StepUpIntent } from "../model/stepUpTypes";
import { ConsoleSection, StatusTag, formatDate, formatMoney } from "./AutomationConsoleShared";

const terminalStages = new Set<ConnectivitySmokeStage>(["flat", "failed", "manual_intervention"]);
const pollIntervalMs = 1_500;

type ConfirmationState = {
  exclusiveWindowConfirmed: boolean;
  manualRecoveryConfirmed: boolean;
  nonAtomicRiskAccepted: boolean;
};

const initialConfirmations: ConfirmationState = {
  exclusiveWindowConfirmed: false,
  manualRecoveryConfirmed: false,
  nonAtomicRiskAccepted: false,
};

export function ConnectivitySmokeConsole({
  accountId,
  client,
  expectedAccountFingerprint,
  onFeedback,
  requestStepUp,
}: {
  accountId: string;
  client: ConnectivitySmokeClient;
  expectedAccountFingerprint: string | null;
  onFeedback: (message: string, tone?: "error" | "info" | "success" | "warning") => void;
  requestStepUp: (intent: StepUpIntent, title: string, description: string) => Promise<string>;
}) {
  const scopeRef = useRef(createConnectivitySmokeScope(accountId));
  if (scopeRef.current.accountId !== accountId) {
    scopeRef.current = nextConnectivitySmokeScope(scopeRef.current, accountId);
  }
  const busyOperationRef = useRef(0);
  const [policy, setPolicy] = useState<ConnectivitySmokePolicy | null>(null);
  const [preflight, setPreflight] = useState<ConnectivitySmokePreflight | null>(null);
  const [status, setStatus] = useState<ConnectivitySmokeStatus | null>(null);
  const [receipt, setReceipt] = useState<ConnectivitySmokeReceipt | null>(null);
  const [unknownRequest, setUnknownRequest] = useState<ConnectivitySmokeExecutionRequest | null>(null);
  const [confirmations, setConfirmations] = useState(initialConfirmations);
  const [loading, setLoading] = useState(true);
  const [busyState, setBusyState] = useState(() => idleConnectivitySmokeBusy(scopeRef.current));
  const [error, setError] = useState("");
  const busy = isConnectivitySmokeBusyForScope(busyState, scopeRef.current);

  const loadReadOnly = useCallback(async (signal?: AbortSignal) => {
    const scope = scopeRef.current;
    setLoading(true);
    setError("");
    try {
      const [nextPolicy, nextStatus] = await Promise.all([
        client.policy(accountId, signal),
        client.status(accountId, undefined, signal),
      ]);
      if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
      if (nextPolicy.accountId !== accountId || nextPolicy.venue !== "binance") {
        throw new AutomationConsoleContractError(409, "Policy 与当前 Binance 账户不匹配。", null, "account_mismatch");
      }
      assertConnectivitySmokeStatusScope(nextStatus, expectedAccountFingerprint);
      setPolicy(nextPolicy);
      setStatus(nextStatus);
      setPreflight(null);
      setUnknownRequest(null);
      setConfirmations(initialConfirmations);
      if (nextStatus?.stage === "flat") {
        const nextReceipt = await client.receipt(accountId, nextStatus.smokeId, signal);
        if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
        assertConnectivitySmokeReceiptScope(nextReceipt, expectedAccountFingerprint);
        setReceipt(nextReceipt);
      } else {
        setReceipt(null);
      }
    } catch (loadError) {
      if (signal?.aborted || !isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
      setPolicy(null);
      setStatus(null);
      setReceipt(null);
      setError(errorMessage(loadError));
    } finally {
      if (!signal?.aborted && isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) setLoading(false);
    }
  }, [accountId, client, expectedAccountFingerprint]);

  useEffect(() => {
    const scope = scopeRef.current;
    setBusyState((current) => resetConnectivitySmokeBusyForScope(current, scope));
    setPolicy(null);
    setPreflight(null);
    setStatus(null);
    setReceipt(null);
    setUnknownRequest(null);
    setConfirmations(initialConfirmations);
    setError("");
    const controller = new AbortController();
    void loadReadOnly(controller.signal);
    return () => controller.abort();
  }, [accountId, loadReadOnly]);

  useEffect(() => {
    if (!status || terminalStages.has(status.stage)) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      const scope = scopeRef.current;
      void client.status(accountId, status.smokeId, controller.signal)
        .then(async (next) => {
          if (!next || !isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
          assertConnectivitySmokeStatusScope(next, expectedAccountFingerprint);
          setStatus(next);
          if (next.stage === "flat") {
            const nextReceipt = await client.receipt(accountId, next.smokeId, controller.signal);
            if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
            assertConnectivitySmokeReceiptScope(nextReceipt, expectedAccountFingerprint);
            setReceipt(nextReceipt);
          }
        })
        .catch((pollError) => {
          if (!controller.signal.aborted && isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) {
            setError(errorMessage(pollError));
          }
        });
    }, pollIntervalMs);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [accountId, client, expectedAccountFingerprint, status]);

  const requestPreflight = async () => {
    if (
      !policy
      || policy.accountId !== accountId
      || !allConfirmed(confirmations)
      || statusBlocksNewRun(status)
    ) return;
    const scope = scopeRef.current;
    const operationId = ++busyOperationRef.current;
    setBusyState(beginConnectivitySmokeBusy(scope, operationId));
    setError("");
    try {
      const next = await client.preflight(accountId, policy, confirmations as ConnectivitySmokeAcceptance);
      if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
      if (
        next.report.accountId !== accountId
        || next.report.policy.version !== policy.policy.version
        || next.report.policy.digest !== policy.policy.digest
      ) {
        throw new AutomationConsoleContractError(409, "Preflight policy 或账户已变化，请重新加载。", null, "account_mismatch");
      }
      setPreflight(next);
    } catch (preflightError) {
      if (isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) setError(errorMessage(preflightError));
    } finally {
      setBusyState((current) => finishConnectivitySmokeBusy(current, scope, operationId));
    }
  };

  const execute = async () => {
    if (!preflight || unknownRequest || statusBlocksNewRun(status)) return;
    const scope = scopeRef.current;
    let preparedRequest: ConnectivitySmokeExecutionRequest | null = null;
    const operationId = ++busyOperationRef.current;
    setBusyState(beginConnectivitySmokeBusy(scope, operationId));
    setError("");
    try {
      const prepared = await connectivitySmokeStepUpRequest(preflight);
      preparedRequest = prepared.request;
      if (
        !isConnectivitySmokeScopeCurrent(scopeRef.current, scope)
        || prepared.request.accountId !== scope.accountId
      ) {
        if (isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) {
          setPreflight(null);
          setError("账户范围已变化，旧预检已失效；未申请 TOTP。");
        }
        return;
      }
      const token = await requestStepUp(
        prepared.intent,
        "执行总计划资本不超过 40 USDT 的闭环连通性验证",
        `Binance · ${prepared.request.accountId} · 单次执行并立即退出 · 计划资本 ${formatMoney(preflight.report.budget.totalCapitalUsd)}`,
      );
      if (
        !isConnectivitySmokeScopeCurrent(scopeRef.current, scope)
        || prepared.request.accountId !== scopeRef.current.accountId
      ) return;
      const next = await client.execute(prepared.request, token);
      if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
      if (!next) {
        setUnknownRequest(prepared.request);
        setPreflight(null);
        setConfirmations(initialConfirmations);
        setError("");
        return;
      }
      assertConnectivitySmokeStatusScope(next, expectedAccountFingerprint);
      setStatus(next);
      setPreflight(null);
      setConfirmations(initialConfirmations);
      if (next.stage === "flat") {
        const nextReceipt = await client.receipt(prepared.request.accountId, next.smokeId);
        if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
        assertConnectivitySmokeReceiptScope(nextReceipt, expectedAccountFingerprint);
        setReceipt(nextReceipt);
      }
      onFeedback("闭环连通性验证已提交，后续状态仅从服务端记录读取。", "success");
    } catch (executeError) {
      if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
      if (isConnectivitySmokeTransportUnknown(executeError)) {
        if (preparedRequest && isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) {
          setUnknownRequest(preparedRequest);
          setPreflight(null);
          setConfirmations(initialConfirmations);
        }
      }
      setError(errorMessage(executeError));
    } finally {
      setBusyState((current) => finishConnectivitySmokeBusy(current, scope, operationId));
    }
  };

  const continueExactLookup = async () => {
    if (!unknownRequest || unknownRequest.accountId !== accountId) return;
    const scope = scopeRef.current;
    const request = unknownRequest;
    const operationId = ++busyOperationRef.current;
    setBusyState(beginConnectivitySmokeBusy(scope, operationId));
    setError("");
    try {
      const next = await client.lookup(request);
      if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
      if (!next) return;
      assertConnectivitySmokeStatusScope(next, expectedAccountFingerprint);
      setStatus(next);
      setUnknownRequest(null);
      if (next.stage === "flat") {
        const nextReceipt = await client.receipt(request.accountId, next.smokeId);
        if (!isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) return;
        assertConnectivitySmokeReceiptScope(nextReceipt, expectedAccountFingerprint);
        setReceipt(nextReceipt);
      }
    } catch (lookupError) {
      if (isConnectivitySmokeScopeCurrent(scopeRef.current, scope)) setError(errorMessage(lookupError));
    } finally {
      setBusyState((current) => finishConnectivitySmokeBusy(current, scope, operationId));
    }
  };

  const canPreflight = Boolean(
    policy
    && policy.accountId === accountId
    && !unknownRequest
    && allConfirmed(confirmations)
    && !statusBlocksNewRun(status),
  );
  const active = status && !terminalStages.has(status.stage);

  return (
    <div className="space-y-4">
      <ConsoleSection
        actions={<Button disabled={loading || busy} onClick={() => void loadReadOnly()} type="button" variant="secondary"><RefreshCw className={loading ? "animate-spin" : ""} size={15} />重新读取</Button>}
        description="一次性运维验证；不属于套利机会、收益验证或长期自动化。"
        title="不超过 40 USDT 的闭环连通性验证"
      >
        <div className="space-y-5 p-4 sm:p-5">
          {loading ? <InlineMessage icon={<RefreshCw className="animate-spin" size={17} />} text="正在读取服务端 policy 与最近一次验证状态。" /> : null}
          {error ? <InlineMessage danger icon={<AlertTriangle size={17} />} text={error} /> : null}
          {policy ? (
            <>
              <InlineMessage icon={<ShieldAlert size={17} />} text={policy.message} />
              <PolicyDisclosure policy={policy} />
              {!unknownRequest && !statusBlocksNewRun(status) ? (
                <div className="space-y-3 border-t border-white/10 pt-4">
                  <Confirmation
                    checked={confirmations.exclusiveWindowConfirmed}
                    label="我确认本次使用专用窗口，期间不通过 Binance UI、其他 Key、转账或其他系统操作 XAUT。"
                    onChange={(checked) => setConfirmations((current) => ({ ...current, exclusiveWindowConfirmed: checked }))}
                  />
                  <Confirmation
                    checked={confirmations.manualRecoveryConfirmed}
                    label="我确认具备在 Binance 人工识别、撤销订单并按要求平仓的能力。"
                    onChange={(checked) => setConfirmations((current) => ({ ...current, manualRecoveryConfirmed: checked }))}
                  />
                  <Confirmation
                    checked={confirmations.nonAtomicRiskAccepted}
                    label="我已阅读并接受服务端列出的非原子连续性风险，且理解 40 USDT 仅为总计划资本硬上限，不是必须用满的预算或最大损失保证。"
                    onChange={(checked) => setConfirmations((current) => ({ ...current, nonAtomicRiskAccepted: checked }))}
                  />
                  <Button disabled={!canPreflight || busy} onClick={() => void requestPreflight()} type="button">
                    {busy ? "预检中" : "提交服务端实时预检"}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </ConsoleSection>

      {preflight ? <PreflightPanel busy={busy} onExecute={() => void execute()} preflight={preflight} /> : null}
      {unknownRequest ? <UnknownExecutionPanel busy={busy} onLookup={() => void continueExactLookup()} request={unknownRequest} /> : null}
      {status ? <StatusPanel active={Boolean(active)} status={status} /> : null}
      {status?.stage === "flat" && receipt ? <ReceiptPanel receipt={receipt} /> : null}
    </div>
  );
}

export function PolicyDisclosure({ policy }: { policy: ConnectivitySmokePolicy }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <PolicyList items={policy.policy.exclusiveWindowRules} title="专用窗口规则" />
      <PolicyList items={policy.policy.manualRecoveryRequirements} title="人工恢复要求" />
      <PolicyList danger items={policy.policy.residualRisks} title="非原子残余风险" />
    </div>
  );
}

function PolicyList({ danger = false, items, title }: { danger?: boolean; items: ConnectivitySmokePolicy["policy"]["residualRisks"]; title: string }) {
  return (
    <section className={`min-w-0 border p-4 ${danger ? "border-red-400/30 bg-red-400/[0.045]" : "border-white/10 bg-white/[0.02]"}`}>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <ul className="mt-3 space-y-2 text-xs leading-5 text-muted">
        {items.map((item) => <li className="flex gap-2" key={item.code}><span aria-hidden="true">•</span><span>{item.message}</span></li>)}
      </ul>
    </section>
  );
}

function Confirmation({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border border-white/10 p-3 text-sm leading-6 text-slate-200">
      <input checked={checked} className="mt-1 h-4 w-4 shrink-0 accent-white" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

function PreflightPanel({ busy, onExecute, preflight }: { busy: boolean; onExecute: () => void; preflight: ConnectivitySmokePreflight }) {
  const budget = preflight.report.budget;
  return (
    <ConsoleSection
      actions={<StatusTag tone={preflight.report.passed ? "success" : "danger"}>{preflight.report.passed ? "服务端预检通过" : "服务端预检阻断"}</StatusTag>}
      description={`短效结果到期：${formatDate(preflight.expiresAt)}`}
      title="实时预检结果"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
          <Metric label="核定数量" value={`${budget.quantityXaut} XAUT`} />
          <Metric label="计划资本" value={formatMoney(budget.totalCapitalUsd)} />
          <Metric label="Spot 资金" value={formatMoney(budget.spotNotionalUsd)} />
          <Metric label="Futures 资金" value={formatMoney(budget.futuresMarginUsd)} />
          <Metric label="四次手续费准备" value={formatMoney(budget.spotFeesUsd + budget.futuresFeesUsd)} />
          <Metric label="四次滑点准备" value={formatMoney(budget.spotSlippageReserveUsd + budget.futuresSlippageReserveUsd)} />
          <Metric label="Tick / 舍入准备" value={formatMoney(budget.roundingReserveUsd)} />
          <Metric label="单次滑点边界" value={`${budget.slippageBpsPerAction} bps`} />
        </div>
        <ul className="space-y-2 text-xs leading-5">
          {preflight.report.checks.map((check) => (
            <li className={`border p-3 ${check.passed ? "border-emerald-400/25 text-emerald-100" : "border-red-400/35 text-red-100"}`} key={check.name}>
              {check.passed ? "通过" : "阻断"} · {check.message}
            </li>
          ))}
        </ul>
        <Button className="w-full" disabled={busy || !preflight.report.passed || preflight.expiresAt <= Date.now()} onClick={onExecute} type="button">
          {busy ? "等待二次验证" : "TOTP 验证并执行一次"}
        </Button>
      </div>
    </ConsoleSection>
  );
}

export function UnknownExecutionPanel({
  busy,
  onLookup,
  request,
}: {
  busy: boolean;
  onLookup: () => void;
  request: ConnectivitySmokeExecutionRequest;
}) {
  return (
    <ConsoleSection
      actions={<StatusTag tone="warning">受理状态未知</StatusTag>}
      description="只允许使用原 accountId、challengeId 与 idempotencyKey 继续精确查询。"
      title="本次执行响应尚未确认"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <InlineMessage
          danger
          icon={<AlertTriangle size={17} />}
          text="截至本次查询尚未确认服务端是否已持久受理；传输中的 execute 仍可能稍后到达。请勿重复开始，也不会自动重放 execute。"
        />
        <p className="break-all text-xs leading-5 text-muted">关联 challenge：{request.challengeId}</p>
        <Button disabled={busy} onClick={onLookup} type="button" variant="secondary">
          {busy ? "精确查询中" : "继续查询本次请求"}
        </Button>
      </div>
    </ConsoleSection>
  );
}

export function StatusPanel({ active, status }: { active: boolean; status: ConnectivitySmokeStatus }) {
  const manual = status.stage === "manual_intervention";
  const failed = status.stage === "failed";
  return (
    <ConsoleSection
      actions={<StatusTag tone={manual ? "danger" : status.stage === "flat" ? "success" : failed ? "warning" : "info"}>{stageLabel(status.stage)}</StatusTag>}
      description="刷新页面只读恢复此记录；不会自动再次执行。"
      title="验证执行状态"
    >
      <div className="space-y-4 p-4 sm:p-5">
        {active ? <InlineMessage icon={<Clock3 size={17} />} text="执行已开始，再次开始入口已禁用。页面仅轮询服务端状态。" /> : null}
        {manual ? <InlineMessage danger icon={<ShieldAlert size={17} />} text="必须立即前往 Binance 人工撤销相关活动订单并处理剩余 Spot/Futures。不要重复开始，不会自动调用全部退出。" /> : null}
        {failed ? <InlineMessage icon={<AlertTriangle size={17} />} text={`本记录 noReopen=${String(status.noReopen)}。如需重新验证，必须从新的用户动作与 TOTP 开始。`} /> : null}
        <p className="text-sm leading-6 text-slate-200">{status.message}</p>
        <ProviderStateView providerState={status.providerState} />
        <OrderGrid orders={status.orders} />
        <Timeline events={status.timeline} />
      </div>
    </ConsoleSection>
  );
}

export function ReceiptPanel({ receipt }: { receipt: ConnectivitySmokeReceipt }) {
  return (
    <ConsoleSection
      actions={<StatusTag tone="success">独立凭据</StatusTag>}
      description={`完成于 ${formatDate(receipt.completedAt)}；不进入套利持仓、Funding 或绩效统计。`}
      title="闭环连通性验证凭据"
    >
      <div className="space-y-5 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
          <Metric label="计划资本" value={formatMoney(receipt.budget.totalCapitalUsd)} />
          <Metric label="最终 Spot" value={`${receipt.finalSpotQuantityXaut} XAUT`} />
          <Metric label="最终 Futures" value={`${receipt.finalFuturesQuantityXaut} XAUT`} />
          <Metric label="Provider Flat" value={receipt.providerFlatConfirmed ? "服务端确认" : "未确认"} />
        </div>
        <div className="border border-white/10 p-3 text-xs leading-5 text-muted">
          <p>Policy version：<span className="break-all text-slate-200">{receipt.policyVersion}</span></p>
          <p>Policy digest：<span className="break-all text-slate-200">{receipt.policyDigest}</span></p>
          <p className="mt-1 text-slate-200">服务端记录三项确认均已接受。</p>
        </div>
        <ProviderStateView providerState={receipt.finalProviderState} />
        <OrderGrid orders={receipt.orders} />
        <div className="grid gap-3 md:grid-cols-3">
          <ActualMetric label="实际手续费" metric={receipt.metrics.actualFeesUsd} />
          <ActualMetric label="实际滑点" metric={receipt.metrics.actualSlippageUsd} />
          <ActualMetric label="实际损益" metric={receipt.metrics.actualRealizedPnlUsd} />
        </div>
        {receipt.disclosureAvailability === "available" && receipt.disclosure ? (
          <div className="grid gap-4 lg:grid-cols-3">
            <PolicyList items={receipt.disclosure.exclusiveWindowRules} title="已接受窗口规则" />
            <PolicyList items={receipt.disclosure.manualRecoveryRequirements} title="已接受人工恢复要求" />
            <PolicyList danger items={receipt.disclosure.residualRisks} title="已接受非原子风险" />
          </div>
        ) : <InlineMessage icon={<AlertTriangle size={17} />} text={`历史 policy 披露不可用：${receipt.disclosureReason ?? "服务端未提供原因"}`} />}
        <Timeline events={receipt.timeline} />
      </div>
    </ConsoleSection>
  );
}

function ProviderStateView({ providerState }: { providerState: ConnectivitySmokeProviderState }) {
  const verified = providerState.verificationStatus === "verified";
  return (
    <section className={`border p-4 ${verified ? "border-emerald-400/25 bg-emerald-400/[0.035]" : "border-amber-400/30 bg-amber-400/[0.04]"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Provider 权威状态</h3>
        <StatusTag tone={verified ? "success" : "warning"}>{providerStateLabel(providerState.verificationStatus)}</StatusTag>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">
        {verified ? "以下事实来自服务端已验证快照。" : "以下状态不能标记为“已确认当前”，请按服务端原因处理。"}
        {" "}观测时间：{providerState.observedAt === null ? "不可用" : formatDate(providerState.observedAt)}；原因：{providerState.reason}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
        <Metric label="剩余 Spot" value={nullableValue(providerState.residualSpotQuantityXaut, " XAUT")} />
        <Metric label="剩余 Futures" value={nullableValue(providerState.residualFuturesQuantityXaut, " XAUT")} />
        <Metric label="Spot 活动订单" value={nullableValue(providerState.activeSpotOrderCount)} />
        <Metric label="Futures 活动订单" value={nullableValue(providerState.activeFuturesOrderCount)} />
        <Metric label="活动订单合计" value={nullableValue(providerState.activeTotalOrderCount)} />
      </dl>
    </section>
  );
}

function OrderGrid({ orders }: { orders: ConnectivitySmokeStatus["orders"] }) {
  const slots: Array<[string, ConnectivitySmokeOrder | null]> = [
    ["Spot 开仓", orders.spotOpen],
    ["Futures 开仓", orders.futuresOpen],
    ["Futures 退出", orders.futuresClose],
    ["Spot 退出", orders.spotClose],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {slots.map(([label, order]) => (
        <section className="min-w-0 border border-white/10 p-3 text-xs" key={label}>
          <h3 className="font-semibold text-white">{label}</h3>
          {order ? (
            <dl className="mt-2 space-y-1.5 text-muted">
              <div><dt className="inline">订单 ID：</dt><dd className="inline break-all text-slate-200">{order.orderId}</dd></div>
              <div><dt className="inline">终态：</dt><dd className="inline text-slate-200">{order.status}</dd></div>
              <div><dt className="inline">成交：</dt><dd className="inline text-slate-200">{order.filledQuantityXaut} / {order.requestedQuantityXaut} XAUT</dd></div>
              <div><dt className="inline">均价：</dt><dd className="inline text-slate-200">{order.averagePriceUsd === null ? "服务端不可用" : formatMoney(order.averagePriceUsd)}</dd></div>
            </dl>
          ) : <p className="mt-2 text-muted">服务端尚未形成该订单摘要。</p>}
        </section>
      ))}
    </div>
  );
}

function Timeline({ events }: { events: ConnectivitySmokeStatus["timeline"] }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-white">服务端时间线</h3>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2">
        {events.map((event, index) => (
          <li className="border-l border-white/20 pl-3 text-xs leading-5 text-muted" key={`${event.at}:${event.code}:${index}`}>
            <span className="font-semibold text-slate-200">{stageLabel(event.stage)}</span> · {formatDate(event.at)}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActualMetric({ label, metric }: { label: string; metric: ConnectivitySmokeMetric }) {
  return (
    <section className="border border-white/10 p-3 text-xs">
      <h3 className="font-semibold text-white">{label}</h3>
      <p className="mt-2 text-muted">
        {metric.availability === "available" && metric.value !== null
          ? formatMoney(metric.value)
          : `服务端无法权威计算（${metric.reason ?? "原因未提供"}）`}
      </p>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-dim">{label}</dt><dd className="mt-1 break-words font-medium text-slate-100">{value}</dd></div>;
}

function InlineMessage({ danger = false, icon, text }: { danger?: boolean; icon: React.ReactNode; text: string }) {
  return <div className={`flex items-start gap-2 border p-3 text-sm leading-6 ${danger ? "border-red-400/35 bg-red-400/[0.055] text-red-100" : "border-sky-400/25 bg-sky-400/[0.045] text-sky-100"}`} role={danger ? "alert" : "status"}>{icon}<span>{text}</span></div>;
}

export function stageLabel(stage: ConnectivitySmokeStage) {
  return ({
    reserved: "已预留",
    spot_opening: "Spot 开仓中",
    spot_open: "Spot 已成交",
    futures_opening: "Futures 开仓中",
    hedged: "短暂对冲完成",
    futures_closing: "Futures 退出中",
    spot_closing: "Spot 退出中",
    flat: "闭环完成",
    failed: "验证失败",
    manual_intervention: "需要人工处理",
  } satisfies Record<ConnectivitySmokeStage, string>)[stage];
}

export function providerStateLabel(status: ConnectivitySmokeProviderState["verificationStatus"]) {
  return ({
    verified: "已验证快照",
    stale: "快照已过期",
    ambiguous: "状态有歧义",
    unavailable: "状态不可用",
  } as const)[status];
}

export function allConfirmed(confirmations: ConfirmationState) {
  return confirmations.exclusiveWindowConfirmed
    && confirmations.manualRecoveryConfirmed
    && confirmations.nonAtomicRiskAccepted;
}

export function statusBlocksNewRun(status: ConnectivitySmokeStatus | null) {
  return Boolean(status && (!terminalStages.has(status.stage) || status.stage === "manual_intervention"));
}

export type ConnectivitySmokeScope = {
  accountId: string;
  generation: number;
};

export function createConnectivitySmokeScope(accountId: string): ConnectivitySmokeScope {
  return { accountId, generation: 0 };
}

export function nextConnectivitySmokeScope(
  current: ConnectivitySmokeScope,
  accountId: string,
): ConnectivitySmokeScope {
  return accountId === current.accountId
    ? current
    : { accountId, generation: current.generation + 1 };
}

export function isConnectivitySmokeScopeCurrent(
  current: ConnectivitySmokeScope,
  captured: ConnectivitySmokeScope,
) {
  return current.accountId === captured.accountId && current.generation === captured.generation;
}

export type ConnectivitySmokeBusyState = {
  generation: number;
  operationId: number;
  active: boolean;
};

export function idleConnectivitySmokeBusy(
  scope: ConnectivitySmokeScope,
): ConnectivitySmokeBusyState {
  return { generation: scope.generation, operationId: 0, active: false };
}

export function beginConnectivitySmokeBusy(
  scope: ConnectivitySmokeScope,
  operationId: number,
): ConnectivitySmokeBusyState {
  return { generation: scope.generation, operationId, active: true };
}

export function resetConnectivitySmokeBusyForScope(
  current: ConnectivitySmokeBusyState,
  scope: ConnectivitySmokeScope,
) {
  return current.generation === scope.generation
    ? current
    : idleConnectivitySmokeBusy(scope);
}

export function finishConnectivitySmokeBusy(
  current: ConnectivitySmokeBusyState,
  scope: ConnectivitySmokeScope,
  operationId: number,
) {
  return current.generation === scope.generation
    && current.operationId === operationId
    ? { ...current, active: false }
    : current;
}

export function isConnectivitySmokeBusyForScope(
  current: ConnectivitySmokeBusyState,
  scope: ConnectivitySmokeScope,
) {
  return current.generation === scope.generation && current.active;
}

function assertConnectivitySmokeStatusScope(
  status: ConnectivitySmokeStatus | null,
  expectedAccountFingerprint: string | null,
) {
  if (
    status
    && expectedAccountFingerprint
    && status.accountFingerprint !== expectedAccountFingerprint
  ) {
    throw new AutomationConsoleContractError(
      409,
      "服务端 smoke 状态与当前 Binance 账户指纹不匹配。",
      null,
      "account_mismatch",
    );
  }
}

function assertConnectivitySmokeReceiptScope(
  receipt: ConnectivitySmokeReceipt,
  expectedAccountFingerprint: string | null,
) {
  if (
    expectedAccountFingerprint
    && receipt.accountFingerprint !== expectedAccountFingerprint
  ) {
    throw new AutomationConsoleContractError(
      409,
      "服务端 smoke 凭据与当前 Binance 账户指纹不匹配。",
      null,
      "account_mismatch",
    );
  }
}

function isConnectivitySmokeTransportUnknown(error: unknown) {
  return error instanceof AutomationConsoleContractError
    && ["network_request_failed", "request_aborted"].includes(error.category ?? "");
}

function nullableValue(value: number | null, suffix = "") {
  return value === null ? "服务端不可用" : `${value}${suffix}`;
}

function errorMessage(error: unknown) {
  const presentation = presentAutomationConsoleError(error);
  return `${presentation.title}：${presentation.message}`;
}
