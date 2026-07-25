import {
  Activity,
  CandlestickChart,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Eye,
  EyeOff,
  XCircle,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import {
  AutomationConsoleContractError,
  credentialDeleteStepUpIntent,
  credentialStepUpIntent,
  executionStepUpIntent,
  isAccountMismatchError,
  isCredentialActivationReady,
  positionCloseStepUpIntent,
  presentAutomationConsoleError,
  safetyActionStepUpIntent,
} from "../../../api/arbitrageAutomationConsole";
import {
  isStepUpAuthFailure,
  presentStepUpError,
  stepUpSecurityClient,
} from "../../../api/stepUpSecurity";
import { USER_AUTH_FAILED_EVENT } from "../../../api/session";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { Toast, useTradingToast } from "../../trading/components/TradingFeedback";
import type {
  AutomationCandidate,
  AutomationConsoleClient,
  AutomationConsoleSnapshot,
  AutomationConsoleTab,
  AutomationExecutionOrder,
  AutomationExecutionResult,
  AutomationPreflight,
  AutomationPreflightFailure,
  AutomationPreflightMode,
  AutomationShadowCheck,
  AutomationVenue,
  CredentialDraft,
  ParameterDraft,
  SafetyAction,
} from "../model/controlConsoleTypes";
import type {
  StepUpIntent,
  StepUpSecurityClient,
  StepUpStatus,
} from "../model/stepUpTypes";
import { AutomationCandidates } from "./AutomationCandidates";
import { AutomationCredentials } from "./AutomationCredentials";
import { AutomationOverview } from "./AutomationOverview";
import { AutomationParameters } from "./AutomationParameters";
import { AutomationPositions } from "./AutomationPositions";
import { AutomationSafety } from "./AutomationSafety";
import { AutomationStepUpSecurity } from "./AutomationStepUpSecurity";
import { StatusTag, formatDate, formatMoney, venueLabel } from "./AutomationConsoleShared";

const tabs: Array<{ id: AutomationConsoleTab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "总览", icon: <Activity size={15} /> },
  { id: "candidates", label: "候选与执行", icon: <CandlestickChart size={15} /> },
  { id: "positions", label: "持仓与盈亏", icon: <SlidersHorizontal size={15} /> },
  { id: "credentials", label: "API 账户", icon: <KeyRound size={15} /> },
  { id: "parameters", label: "参数", icon: <Settings2 size={15} /> },
  { id: "safety", label: "安全操作", icon: <ShieldAlert size={15} /> },
];

type PendingSafetyConfirmation =
  | { kind: "safety"; action: SafetyAction; title: string; phrase: string }
  | { kind: "position"; positionId: string; title: string; phrase: string };

type PendingStepUp = {
  id: string;
  title: string;
  description: string;
  intent: StepUpIntent;
  resolve: (token: string) => void;
  reject: (error: Error) => void;
};

class StepUpCancelledError extends Error {
  constructor() {
    super("二次身份验证已取消。");
    this.name = "StepUpCancelledError";
  }
}

export function shouldCancelStepUpForAccountScope(previousScope: string, nextScope: string) {
  return previousScope !== nextScope;
}

export function AutomationControlConsole({
  client,
  onReload,
  securityClient = stepUpSecurityClient,
  snapshot,
}: {
  client: AutomationConsoleClient;
  onReload: () => Promise<void>;
  securityClient?: StepUpSecurityClient;
  snapshot: AutomationConsoleSnapshot;
}) {
  const [activeTab, setActiveTab] = useState<AutomationConsoleTab>("overview");
  const [preflight, setPreflight] = useState<AutomationPreflight | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<AutomationPreflightFailure | null>(null);
  const [legacyCheck, setLegacyCheck] = useState<AutomationShadowCheck | null>(null);
  const [execution, setExecution] = useState<AutomationExecutionResult | null>(null);
  const [preflightChecks, setPreflightChecks] = useState<Record<number, boolean>>({});
  const [preflightPhrase, setPreflightPhrase] = useState("");
  const [safetyConfirmation, setSafetyConfirmation] = useState<PendingSafetyConfirmation | null>(null);
  const [safetyPhrase, setSafetyPhrase] = useState("");
  const [stepUpStatus, setStepUpStatus] = useState<StepUpStatus | null>(null);
  const [stepUpPrompt, setStepUpPrompt] = useState<PendingStepUp | null>(null);
  const [stepUpCode, setStepUpCode] = useState("");
  const [stepUpError, setStepUpError] = useState("");
  const [showStepUpCode, setShowStepUpCode] = useState(false);
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const { dismissToast, showToast, toast } = useTradingToast();
  const accountScope = snapshot.credentials
    .map((credential) => `${credential.venue}:${credential.accountId ?? "-"}`)
    .join("|");
  const stepUpAccountScopeRef = useRef(accountScope);

  useEffect(() => {
    setPreflight(null);
    setPreflightFailure(null);
    setLegacyCheck(null);
    setPreflightChecks({});
    setPreflightPhrase("");
  }, [accountScope, snapshot.generatedAt]);

  useEffect(() => {
    const controller = new AbortController();
    void securityClient.status(controller.signal)
      .then(setStepUpStatus)
      .catch(() => setStepUpStatus(null));
    return () => controller.abort();
  }, [securityClient]);

  useEffect(() => {
    const previousScope = stepUpAccountScopeRef.current;
    stepUpAccountScopeRef.current = accountScope;
    if (!stepUpPrompt || !shouldCancelStepUpForAccountScope(previousScope, accountScope)) return;
    stepUpPrompt.reject(new StepUpCancelledError());
    setStepUpPrompt(null);
    setStepUpCode("");
    setStepUpError("");
    setShowStepUpCode(false);
  }, [accountScope]);

  useEffect(() => {
    const clearPending = () => cancelStepUp();
    window.addEventListener(USER_AUTH_FAILED_EVENT, clearPending);
    return () => window.removeEventListener(USER_AUTH_FAILED_EVENT, clearPending);
  }, [stepUpPrompt]);

  const handleContractError = async (error: unknown) => {
    if (error instanceof StepUpCancelledError) return;
    if (isAccountMismatchError(error)) await onReload();
    showContractError(error, showToast);
  };

  const requestStepUp = (intent: StepUpIntent, title: string, description: string) => {
    if (!stepUpStatus?.enrolled) {
      setActiveTab("safety");
      showToast("请先在“安全操作”中设置二次身份验证。", "warning");
      return Promise.reject(new StepUpCancelledError());
    }
    if (stepUpPrompt) {
      showToast("已有敏感操作正在等待二次验证。", "warning");
      return Promise.reject(new StepUpCancelledError());
    }
    return new Promise<string>((resolve, reject) => {
      setStepUpCode("");
      setStepUpError("");
      setShowStepUpCode(false);
      setStepUpPrompt({
        id: crypto.randomUUID(),
        title,
        description,
        intent,
        resolve,
        reject,
      });
    });
  };

  const authorizeStepUp = async () => {
    const pending = stepUpPrompt;
    if (!pending || stepUpCode.length !== 6) return;
    setStepUpBusy(true);
    setStepUpError("");
    const code = stepUpCode;
    setStepUpCode("");
    try {
      const authorization = await securityClient.authorize({ code, intent: pending.intent });
      setStepUpPrompt(null);
      setShowStepUpCode(false);
      pending.resolve(authorization.authorizationToken);
    } catch (error) {
      const message = presentStepUpError(error);
      if (isStepUpAuthFailure(error)) {
        pending.reject(new StepUpCancelledError());
        setStepUpPrompt(null);
        setShowStepUpCode(false);
        setStepUpStatus(null);
        setActiveTab("safety");
        showToast(message, "error");
      } else {
        setStepUpError(message);
      }
    } finally {
      setStepUpBusy(false);
    }
  };

  function cancelStepUp() {
    if (stepUpPrompt) stepUpPrompt.reject(new StepUpCancelledError());
    setStepUpPrompt(null);
    setStepUpCode("");
    setStepUpError("");
    setShowStepUpCode(false);
    setStepUpBusy(false);
  }

  const requestPreflight = async (candidate: AutomationCandidate, mode: AutomationPreflightMode) => {
    setBusy(true);
    try {
      const result = await client.requestPreflight(candidate.id, mode);
      setPreflight(null);
      setPreflightFailure(null);
      setLegacyCheck(null);
      if (isPreflightFailure(result)) {
        setPreflightFailure(result);
      } else if (isLegacyCheck(result)) {
        setLegacyCheck(result);
      } else {
        setPreflight(result);
        setPreflightChecks({});
        setPreflightPhrase("");
      }
    } catch (error) {
      await handleContractError(error);
    } finally {
      setBusy(false);
    }
  };

  const confirmPreflight = async () => {
    if (!preflight) return;
    setBusy(true);
    try {
      const intent = await executionStepUpIntent(preflight);
      const token = await requestStepUp(
        intent,
        "建立现货与永续对冲组合",
        `${venueLabel(preflight.venue)} · ${preflight.accountId} · XAUTUSDT · 预计所需资金 ${formatMoney(preflight.estimatedCapitalRequiredUsd)}`,
      );
      const receipt = await client.confirmExecution(preflight.challengeId, token);
      showToast(receipt.message, receipt.simulated ? "warning" : "success");
      setPreflight(null);
      if (receipt.execution) setExecution(receipt.execution);
      await onReload();
    } catch (error) {
      await handleContractError(error);
    } finally {
      setBusy(false);
    }
  };

  const validateCredential = async (draft: CredentialDraft) => {
    try {
      const intent = await credentialStepUpIntent(draft);
      const token = await requestStepUp(
        intent,
        draft.accountId ? `轮换 ${venueLabel(draft.venue)} API 凭证` : `新增 ${venueLabel(draft.venue)} API 凭证`,
        "验证通过后服务端才会保存加密凭证；本次授权只适用于当前请求。",
      );
      const credential = await client.validateCredential(draft, token);
      if (!isCredentialActivationReady(credential)) {
        throw new AutomationConsoleContractError(
          409,
          "服务端签名、交易权限、提现关闭或账户模式验证未全部通过；旧连接保持不变。",
          null,
          "credential_verification_incomplete",
        );
      }
      showToast(`${venueLabel(draft.venue)} API 授权已通过服务端验证；Secret 已从表单清空。`, "success");
      await onReload();
    } catch (error) {
      await handleContractError(error);
      throw error;
    }
  };

  const deleteCredential = async (accountId: string) => {
    try {
      const intent = await credentialDeleteStepUpIntent(snapshot, accountId);
      const token = await requestStepUp(intent, "解绑 API 账户", `${venueLabel(intent.venue)} · ${accountId}`);
      const receipt = await client.deleteCredential(accountId, token);
      showToast(receipt.message, "warning");
      await onReload();
    } catch (error) {
      await handleContractError(error);
      throw error;
    }
  };

  const validateParameters = async (venue: AutomationVenue, draft: ParameterDraft) => {
    try {
      const receipt = await client.validateParameters(venue, draft);
      showToast(receipt.message, "success");
      await onReload();
    } catch (error) {
      await handleContractError(error);
    }
  };

  const performSafetyAction = async () => {
    if (!safetyConfirmation) return;
    setBusy(true);
    try {
      let receipt;
      if (safetyConfirmation.kind === "position") {
        const prepared = await positionCloseStepUpIntent(snapshot, safetyConfirmation.positionId);
        const token = await requestStepUp(
          prepared.intent,
          "退出现货与永续对冲组合",
          `${venueLabel(prepared.intent.venue)} · ${prepared.intent.accountId}`,
        );
        receipt = await client.closePosition(
          safetyConfirmation.positionId,
          token,
          prepared.idempotencyKey,
        );
      } else {
        const intent = await safetyActionStepUpIntent(snapshot, safetyConfirmation.action);
        const token = intent
          ? await requestStepUp(intent, safetyConfirmation.title, `${venueLabel(intent.venue)} · ${intent.accountId}`)
          : undefined;
        receipt = await client.performSafetyAction(safetyConfirmation.action, token);
      }
      showToast(receipt.message, "warning");
      if (receipt.execution) setExecution(receipt.execution);
      setSafetyConfirmation(null);
      setSafetyPhrase("");
      await onReload();
    } catch (error) {
      await handleContractError(error);
    } finally {
      setBusy(false);
    }
  };

  const closePosition = async (positionId: string) => {
    const position = snapshot.positionGroups.find((item) => item.id === positionId);
    if (!position) return;
    setSafetyConfirmation({
      kind: "position",
      positionId,
      title: `退出 ${position.label}`,
      phrase: "退出对冲组合",
    });
    setSafetyPhrase("");
  };

  const allPreflightChecks = preflight
    ? preflight.confirmations.every((_, index) => preflightChecks[index])
    : false;

  return (
    <div className="space-y-4">
      <section
        aria-label="Mainnet 真实执行边界"
        className="flex flex-col gap-3 border border-red-400/25 bg-red-400/[0.045] px-4 py-3 text-xs text-red-100 sm:flex-row sm:items-center sm:justify-between sm:px-5"
      >
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 shrink-0" size={15} />
          <p className="leading-5">
            <strong className="font-semibold">Mainnet 能力边界</strong>
            <span className="ml-2 text-red-100/75">
              Binance 与 Bybit 仅在服务端全部门禁就绪后提供受控真实执行；每次建立对冲组合都需要实时预检和用户二次确认。
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <StatusTag tone="warning">受控真实</StatusTag>
          <StatusTag tone={snapshot.killSwitchActive ? "danger" : "success"}>
            {snapshot.killSwitchActive ? "急停开启" : "急停待命"}
          </StatusTag>
        </div>
      </section>

      <nav
        aria-label="套利自动化控制台"
        className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto border-b border-white/15"
      >
        {tabs.map((tab) => (
          <button
            aria-current={activeTab === tab.id ? "page" : undefined}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition ${
              activeTab === tab.id
                ? "border-white text-white"
                : "border-transparent text-muted hover:border-white/30 hover:text-white"
            }`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" ? <AutomationOverview snapshot={snapshot} /> : null}
      {activeTab === "candidates" ? (
        <AutomationCandidates
          candidates={snapshot.candidates}
          onPreflight={(candidate, mode) => void requestPreflight(candidate, mode)}
        />
      ) : null}
      {activeTab === "positions" ? (
        <AutomationPositions
          groups={snapshot.positionGroups}
          onClose={closePosition}
          writableVenues={snapshot.credentials
            .filter((credential) => credential.canExecute)
            .map((credential) => credential.venue)}
        />
      ) : null}
      {activeTab === "credentials" ? (
        <AutomationCredentials
          credentials={snapshot.credentials}
          onDelete={deleteCredential}
          onFeedback={showToast}
          onGoToSafety={() => setActiveTab("safety")}
          onValidate={validateCredential}
          productionEgressIps={snapshot.productionEgressIps}
        />
      ) : null}
      {activeTab === "parameters" ? (
        <AutomationParameters
          controls={snapshot.venueControls}
          onValidate={validateParameters}
          parameters={snapshot.parameters}
        />
      ) : null}
      {activeTab === "safety" ? (
        <div className="space-y-4">
          <AutomationStepUpSecurity
            client={securityClient}
            onFeedback={showToast}
            onStatusChange={setStepUpStatus}
          />
          <AutomationSafety
            onAction={(action, title, phrase) => {
              setSafetyConfirmation({ kind: "safety", action, title, phrase });
              setSafetyPhrase("");
            }}
            snapshot={snapshot}
          />
        </div>
      ) : null}

      <Modal
        closeDisabled={busy}
        description={
          preflight?.mode === "manual_entry"
            ? "该机会通过基础安全门槛但未达到自动策略条件；提交时服务端仍会重新校验全部实时状态。"
            : "短效执行凭证有效期为 60 秒；提交时服务端会再次读取账户、行情、开关和急停状态。"
        }
        onClose={() => setPreflight(null)}
        open={preflight !== null}
        shellClassName="max-w-[940px]"
        title={preflight?.mode === "manual_entry" ? "手动风险预检" : "自动策略预检"}
      >
        {preflight ? (
          <PreflightConfirmation
            allChecksComplete={allPreflightChecks}
            busy={busy}
            checks={preflightChecks}
            onCheck={(index, checked) => {
              setPreflightChecks((current) => ({ ...current, [index]: checked }));
            }}
            onConfirm={() => void confirmPreflight()}
            onPhrase={setPreflightPhrase}
            phrase={preflightPhrase}
            preflight={preflight}
          />
        ) : null}
      </Modal>

      <Modal
        onClose={() => setPreflightFailure(null)}
        open={preflightFailure !== null}
        shellClassName="max-w-[820px]"
        title="实时预检未通过"
        description="未生成短效执行凭证，也未发送订单。请按服务端检查结果处理后重新预检。"
      >
        {preflightFailure ? <PreflightFailureResult report={preflightFailure} /> : null}
      </Modal>

      <Modal
        onClose={() => setLegacyCheck(null)}
        open={legacyCheck !== null}
        shellClassName="max-w-[820px]"
        title="条件检查结果"
        description="当前服务端仅返回检查结果，未生成短效执行凭证，也未发送订单。"
      >
        {legacyCheck ? (
          <PreflightFailureResult
            report={{
              kind: "preflight_rejected",
              venue: legacyCheck.venue,
              candidateId: legacyCheck.candidateId,
              accountId: legacyCheck.accountId,
              mode: legacyCheck.mode,
              checks: legacyCheck.checks.map((check) => ({
                ...check,
                value: null,
                limit: null,
              })),
              warnings: legacyCheck.warnings,
              message: legacyCheck.message,
              generatedAt: legacyCheck.generatedAt,
            }}
          />
        ) : null}
      </Modal>

      <Modal
        onClose={() => setExecution(null)}
        open={execution !== null}
        shellClassName="max-w-[900px]"
        title="执行状态"
        description="状态来自服务端执行记录；订单与仓位最终以交易所权威数据为准。"
      >
        {execution ? <ExecutionResult execution={execution} /> : null}
      </Modal>

      <Modal
        closeDisabled={busy}
        description="该操作只影响当前用户在所选交易所的自动套利账户；服务端仍会校验 accountId、幂等标识与实时状态。"
        onClose={() => setSafetyConfirmation(null)}
        open={safetyConfirmation !== null}
        title={safetyConfirmation?.title ?? "确认安全操作"}
      >
        {safetyConfirmation ? (
          <div className="space-y-4">
            <div className="border border-red-400/30 bg-red-400/[0.06] p-4 text-sm leading-6 text-red-100">
              执行前请核对当前持仓、在途订单、策略状态和退出风险。退出操作会处理当前账户的现货与永续对冲组合。
            </div>
            <label className="xh-account-modal-field">
              <span>输入“{safetyConfirmation.phrase}”确认</span>
              <input
                autoComplete="off"
                className="xh-account-modal-control"
                onChange={(event) => setSafetyPhrase(event.target.value)}
                type="text"
                value={safetyPhrase}
              />
            </label>
            <Button
              className="w-full"
              disabled={busy || safetyPhrase !== safetyConfirmation.phrase}
              onClick={() => void performSafetyAction()}
              type="button"
              variant="danger"
            >
              {busy ? "处理中" : "确认操作"}
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal
        closeDisabled={stepUpBusy}
        description={stepUpPrompt?.description}
        onClose={cancelStepUp}
        open={stepUpPrompt !== null}
        shellClassName="max-w-[520px]"
        title={stepUpPrompt?.title ?? "敏感操作二次验证"}
      >
        {stepUpPrompt ? (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void authorizeStepUp(); }}>
            <div className="flex items-start gap-3 border border-sky-400/30 bg-sky-400/[0.06] p-4 text-sm leading-6 text-sky-100">
              <ShieldCheck className="mt-0.5 shrink-0" size={18} />
              <p>输入身份验证器中的新 6 位动态验证码。本次授权只绑定当前账户、操作和请求内容，有效 120 秒且只能使用一次。</p>
            </div>
            <label className="xh-account-modal-field">
              <span>6 位动态验证码</span>
              <span className="relative block">
                <input
                  autoComplete="one-time-code"
                  autoFocus
                  className="xh-account-modal-control pr-12 font-mono"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setStepUpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                  type={showStepUpCode ? "text" : "password"}
                  value={stepUpCode}
                />
                <button
                  aria-label={showStepUpCode ? "隐藏动态验证码" : "显示动态验证码"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-muted hover:text-white"
                  onClick={() => setShowStepUpCode((current) => !current)}
                  type="button"
                >
                  {showStepUpCode ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
            </label>
            {stepUpError ? <p className="border border-red-400/35 bg-red-400/[0.06] p-3 text-sm text-red-200" role="alert">{stepUpError}</p> : null}
            <Button className="w-full" disabled={stepUpBusy || stepUpCode.length !== 6} type="submit">
              {stepUpBusy ? "验证中" : "验证并继续"}
            </Button>
          </form>
        ) : null}
      </Modal>
      <Toast onDismiss={dismissToast} toast={toast} />
    </div>
  );
}

function PreflightConfirmation({
  allChecksComplete,
  busy,
  checks,
  onCheck,
  onConfirm,
  onPhrase,
  phrase,
  preflight,
}: {
  allChecksComplete: boolean;
  busy: boolean;
  checks: Record<number, boolean>;
  onCheck: (index: number, checked: boolean) => void;
  onConfirm: () => void;
  onPhrase: (value: string) => void;
  phrase: string;
  preflight: AutomationPreflight;
}) {
  const account = preflight.accountSnapshot;
  return (
    <div className="space-y-4">
      <PreflightModeNotice mode={preflight.mode} />
      <PreflightWarnings warnings={preflight.warnings} />
      <div className="grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
        <PreflightMetric label="交易所" value={venueLabel(preflight.venue)} />
        <PreflightMetric label="执行账户" value={preflight.accountId} />
        <PreflightMetric label="标的" value="XAUTUSDT" />
        <PreflightMetric label="有效期" value={formatDate(preflight.expiresAt)} />
        <PreflightMetric label="预计所需资金" value={formatMoney(preflight.estimatedCapitalRequiredUsd)} />
        <PreflightMetric label="总预算上限" value={formatMoney(preflight.totalBudgetUsd)} />
        <PreflightMetric label="预计总费用" value={optionalMoney(preflight.estimatedTotalFeesUsd)} />
        <PreflightMetric label="最大损失" value={optionalMoney(preflight.maximumLossUsd)} />
        <PreflightMetric label="入场基差" value={optionalNumber(preflight.entryBasisBps, " bps")} />
        <PreflightMetric label="Funding" value={optionalPercent(preflight.fundingRate)} />
        <PreflightMetric label="估算净 APR" value={optionalNumber(preflight.estimatedNetAprPercent, "%")} />
        <PreflightMetric label="预计滑点" value={optionalMoney(preflight.estimatedSlippageUsd)} />
      </div>

      {account ? <AccountSnapshot account={account} /> : null}

      <div className="min-w-0 overflow-x-auto border border-white/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[0.025] text-xs text-muted">
            <tr>
              <th className="px-3 py-2">市场侧</th>
              <th className="px-3 py-2">交易所 / 品种</th>
              <th className="px-3 py-2">精确数量</th>
              <th className="px-3 py-2">参考价格</th>
              <th className="px-3 py-2">预计费用</th>
            </tr>
          </thead>
          <tbody>
            {preflight.exactLegs.map((side) => (
              <tr className="border-b border-white/[0.07]" key={`${side.venue}:${side.symbol}:${side.side}`}>
                <td className="px-3 py-3">{side.side === "buy" ? "现货侧买入" : "永续侧卖出"}</td>
                <td className="px-3 py-3">
                  {venueLabel(side.venue)} · <span className="font-mono">{side.symbol}</span>
                </td>
                <td className="px-3 py-3 font-mono">{side.quantity}</td>
                <td className="px-3 py-3 font-mono">{side.referencePrice}</td>
                <td className="px-3 py-3 font-mono">{optionalMoney(side.estimatedFeeUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PreflightChecks checks={preflight.checks} />

      <div className="space-y-2">
        {preflight.confirmations.map((label, index) => (
          <label
            className="flex cursor-pointer items-start gap-3 border border-white/10 p-3 text-sm text-slate-200"
            key={label}
          >
            <input
              checked={Boolean(checks[index])}
              className="mt-0.5"
              onChange={(event) => onCheck(index, event.target.checked)}
              type="checkbox"
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <label className="xh-account-modal-field">
        <span>输入“确认执行”完成真实资金二次确认</span>
        <input
          autoComplete="off"
          className="xh-account-modal-control"
          onChange={(event) => onPhrase(event.target.value)}
          type="text"
          value={phrase}
        />
      </label>
      <Button
        className="w-full"
        disabled={busy || !allChecksComplete || phrase !== "确认执行"}
        onClick={onConfirm}
        type="button"
        variant="danger"
      >
        {busy ? "确认中" : "确认建立现货与永续对冲组合"}
      </Button>
    </div>
  );
}

function AccountSnapshot({
  account,
}: {
  account: NonNullable<AutomationPreflight["accountSnapshot"]>;
}) {
  return (
    <section className="border border-white/10">
      <div className="border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">实时账户与市场规格</h3>
        <p className="mt-1 text-xs text-muted">快照时间 {formatDate(account.fetchedAt)}</p>
      </div>
      <div className="grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
        <PreflightMetric label="现货可用 USDT" value={formatMoney(account.spotAvailableUsdt)} />
        <PreflightMetric label="永续可用 USDT" value={formatMoney(account.futuresAvailableUsdt)} />
        <PreflightMetric label="现货 XAUT" value={optionalNumber(account.spotXaut)} />
        <PreflightMetric label="永续 XAUT" value={optionalNumber(account.perpetualXaut)} />
        <PreflightMetric label="现货侧报价" value={quote(account.spot)} />
        <PreflightMetric label="永续侧报价" value={quote(account.perpetual)} />
        <PreflightMetric label="现货深度" value={optionalMoney(account.spot?.depthUsd ?? null)} />
        <PreflightMetric label="永续深度" value={optionalMoney(account.perpetual?.depthUsd ?? null)} />
        <PreflightMetric label="现货最小数量 / 步进" value={spec(account.spot)} />
        <PreflightMetric label="永续最小数量 / 步进" value={spec(account.perpetual)} />
        <PreflightMetric label="现货 Taker" value={optionalNumber(account.spotTakerBps, " bps")} />
        <PreflightMetric label="永续 Taker" value={optionalNumber(account.perpetualTakerBps, " bps")} />
      </div>
    </section>
  );
}

function PreflightFailureResult({ report }: { report: AutomationPreflightFailure }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 border border-red-400/30 bg-red-400/[0.06] p-4 text-sm leading-6 text-red-100">
        <XCircle className="mt-0.5 shrink-0" size={18} />
        <div>
          <strong className="font-semibold">未建立对冲组合</strong>
          <p className="mt-1 text-xs leading-5 opacity-80">{report.message}</p>
        </div>
      </div>
      <div className="grid gap-px bg-white/10 sm:grid-cols-3">
        <PreflightMetric label="交易所" value={venueLabel(report.venue)} />
        <PreflightMetric label="执行账户" value={report.accountId} />
        <PreflightMetric label="检查时间" value={report.generatedAt ? formatDate(report.generatedAt) : "-"} />
      </div>
      <PreflightChecks checks={report.checks} />
      <PreflightWarnings warnings={report.warnings} />
    </div>
  );
}

function PreflightChecks({ checks }: { checks: AutomationPreflight["checks"] }) {
  if (checks.length === 0) return null;
  return (
    <section className="border border-white/10">
      <div className="border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">服务端实时检查</h3>
        <p className="mt-1 text-xs text-muted">
          {checks.filter((check) => check.passed).length} / {checks.length} 通过
        </p>
      </div>
      <div className="divide-y divide-white/10">
        {checks.map((check) => (
          <div className="flex items-start gap-3 px-4 py-3" key={check.id}>
            {check.passed ? (
              <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-300" size={16} />
            ) : (
              <XCircle className="mt-0.5 shrink-0 text-red-300" size={16} />
            )}
            <div className="min-w-0">
              <p className="font-mono text-xs text-slate-200">{check.id}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{check.message}</p>
              {check.value !== null || check.limit !== null ? (
                <p className="mt-1 font-mono text-[11px] text-dim">
                  当前 {String(check.value ?? "-")} · 限制 {String(check.limit ?? "-")}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExecutionResult({ execution }: { execution: AutomationExecutionResult }) {
  const riskState = ["compensating", "failed", "manual_intervention"].includes(execution.state);
  return (
    <div className="space-y-4">
      <div
        className={`flex items-start gap-3 border p-4 text-sm leading-6 ${
          riskState
            ? "border-red-400/30 bg-red-400/[0.06] text-red-100"
            : "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100"
        }`}
      >
        {riskState ? (
          <CircleAlert className="mt-0.5 shrink-0" size={18} />
        ) : (
          <CheckCircle2 className="mt-0.5 shrink-0" size={18} />
        )}
        <div>
          <strong className="font-semibold">{executionStateLabel(execution.state)}</strong>
          <p className="mt-1 text-xs leading-5 opacity-80">{execution.message}</p>
          {execution.state === "manual_intervention" ? (
            <p className="mt-2 text-xs font-semibold">
              请立即前往 {venueLabel(execution.venue)} 核对现货侧、永续侧、订单与仓位。
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
        <PreflightMetric label="交易所" value={venueLabel(execution.venue)} />
        <PreflightMetric label="执行账户" value={execution.accountId} />
        <PreflightMetric label="执行 ID" value={execution.executionId} />
        <PreflightMetric label="状态更新时间" value={formatDate(execution.updatedAt)} />
        <PreflightMetric label="已对冲数量" value={optionalNumber(execution.hedgedQuantityXaut, " XAUT")} />
        <PreflightMetric
          label="单侧暴露时长"
          value={execution.unhedgedDurationMs === null ? "-" : `${execution.unhedgedDurationMs} ms`}
        />
        <PreflightMetric label="补偿订单" value={String(execution.compensationOrders.length)} />
        <PreflightMetric label="错误分类" value={execution.errorCategory ?? "-"} />
      </div>

      <ExecutionOrders
        compensation={execution.compensationOrders}
        perpetual={execution.perpetualOrders}
        spot={execution.spotOrder}
      />
    </div>
  );
}

function ExecutionOrders({
  compensation,
  perpetual,
  spot,
}: {
  compensation: AutomationExecutionOrder[];
  perpetual: AutomationExecutionOrder[];
  spot: AutomationExecutionOrder | null;
}) {
  const rows = [
    ...(spot ? [{ market: "现货侧", order: spot }] : []),
    ...perpetual.map((order) => ({ market: "永续侧", order })),
    ...compensation.map((order) => ({ market: "安全补偿", order })),
  ];
  if (rows.length === 0) {
    return <p className="border border-white/10 px-4 py-8 text-center text-sm text-muted">服务端尚未返回订单记录。</p>;
  }
  return (
    <div className="min-w-0 overflow-x-auto border border-white/10">
      <table className="w-full min-w-[780px] text-left text-sm">
        <thead className="border-b border-white/10 bg-white/[0.025] text-xs text-muted">
          <tr>
            <th className="px-3 py-2">市场侧</th>
            <th className="px-3 py-2">订单 ID</th>
            <th className="px-3 py-2">状态</th>
            <th className="px-3 py-2">请求数量</th>
            <th className="px-3 py-2">成交数量</th>
            <th className="px-3 py-2">均价</th>
            <th className="px-3 py-2">费用</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ market, order }, index) => (
            <tr className="border-b border-white/[0.07]" key={`${market}:${order.orderId}:${index}`}>
              <td className="px-3 py-3">{market}</td>
              <td className="px-3 py-3 font-mono">{order.orderId || order.orderLinkId || "-"}</td>
              <td className="px-3 py-3">{order.status}</td>
              <td className="px-3 py-3 font-mono">{order.requestedQuantityXaut}</td>
              <td className="px-3 py-3 font-mono">{order.filledQuantityXaut}</td>
              <td className="px-3 py-3 font-mono">{order.averagePrice ?? "-"}</td>
              <td className="px-3 py-3 font-mono">{formatMoney(-order.feeUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreflightMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-[#101010] p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 break-words font-mono text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

export function PreflightModeNotice({ mode }: { mode: AutomationPreflightMode }) {
  return mode === "manual_entry" ? (
    <div className="border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm leading-6 text-amber-100">
      <strong className="font-semibold">由用户手动决策</strong>
      <p className="mt-1 text-xs leading-5 text-amber-100/80">
        收益、Funding、基差和持续性仅是风险提示，不构成系统推荐；手动预检不会绕过任何安全门槛。
      </p>
    </div>
  ) : (
    <div className="border border-white/10 p-4 text-sm leading-6 text-slate-200">
      <strong className="font-semibold text-white">自动策略条件已通过</strong>
      <p className="mt-1 text-xs leading-5 text-muted">
        仍需核对服务端实时预检、执行账户、现货侧与永续侧数量和总预算。
      </p>
    </div>
  );
}

export function PreflightWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="border border-amber-400/30 p-4">
      <p className="text-sm font-semibold text-amber-100">服务端实时风险提示</p>
      <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100/80">
        {warnings.map((warning) => <li key={warning}>• {warning}</li>)}
      </ul>
    </div>
  );
}

function quote(instrument: NonNullable<AutomationPreflight["accountSnapshot"]>["spot"]) {
  return instrument ? `${instrument.bid} / ${instrument.ask}` : "-";
}

function spec(instrument: NonNullable<AutomationPreflight["accountSnapshot"]>["spot"]) {
  return instrument ? `${instrument.minOrderQty} / ${instrument.qtyStep}` : "-";
}

function optionalMoney(value: number | null) {
  return value === null ? "服务端未提供" : formatMoney(value);
}

function optionalNumber(value: number | null, suffix = "") {
  return value === null
    ? "服务端未提供"
    : `${value.toLocaleString("en-US", { maximumFractionDigits: 8 })}${suffix}`;
}

function optionalPercent(value: number | null) {
  return value === null ? "服务端未提供" : `${(value * 100).toFixed(4)}%`;
}

function executionStateLabel(state: AutomationExecutionResult["state"]) {
  return ({
    accepted: "执行请求已接受",
    opening_spot: "正在建立现货侧仓位",
    opening_perpetual: "正在建立永续侧仓位",
    hedged: "两侧仓位已对冲",
    compensating: "正在执行安全补偿",
    closed: "对冲组合已退出",
    failed: "执行失败",
    manual_intervention: "需要人工处理",
    unknown: "执行状态未知",
  } as const)[state];
}

function isPreflightFailure(
  value: AutomationPreflight | AutomationPreflightFailure | AutomationShadowCheck,
): value is AutomationPreflightFailure {
  return "kind" in value && value.kind === "preflight_rejected";
}

function isLegacyCheck(
  value: AutomationPreflight | AutomationPreflightFailure | AutomationShadowCheck,
): value is AutomationShadowCheck {
  return "kind" in value && value.kind === "shadow_check";
}

function showContractError(
  error: unknown,
  showToast: (message: string, tone?: "error" | "info" | "success" | "warning") => void,
) {
  const presentation = presentAutomationConsoleError(error);
  showToast(`${presentation.title}：${presentation.message}`, "error");
}
