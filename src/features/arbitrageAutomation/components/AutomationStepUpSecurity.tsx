import {
  Clipboard,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  isStepUpAuthFailure,
  isStepUpUnavailable,
  presentStepUpError,
} from "../../../api/stepUpSecurity";
import { USER_AUTH_FAILED_EVENT } from "../../../api/session";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import type {
  StepUpEnrollment,
  StepUpFactor,
  StepUpSecurityClient,
  StepUpStatus,
} from "../model/stepUpTypes";
import { ConsoleSection, StatusTag, formatDate } from "./AutomationConsoleShared";
import { TotpQrCode, type QrCodeDataUrlGenerator } from "./TotpQrCode";

type LifecycleAction = "enroll" | "reset" | "regenerate" | "disable";
type DialogStage = "verify" | "setup" | "recovery" | "confirm_close";

export function AutomationStepUpSecurity({
  client,
  generateQrDataUrl,
  onFeedback,
  onStatusChange,
}: {
  client: StepUpSecurityClient;
  generateQrDataUrl?: QrCodeDataUrlGenerator;
  onFeedback: (message: string, tone?: "error" | "info" | "success" | "warning") => void;
  onStatusChange?: (status: StepUpStatus | null) => void;
}) {
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [stage, setStage] = useState<DialogStage>("verify");
  const [password, setPassword] = useState("");
  const [factorMethod, setFactorMethod] = useState<StepUpFactor["method"]>("totp");
  const [factorCode, setFactorCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showFactor, setShowFactor] = useState(false);
  const [enrollment, setEnrollment] = useState<StepUpEnrollment | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = async (signal?: AbortSignal) => {
    try {
      const next = await client.status(signal);
      setStatus(next);
      setStatusError("");
      setUnavailable(false);
      onStatusChange?.(next);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setStatus(null);
      setStatusError(presentStepUpError(loadError));
      setUnavailable(isStepUpUnavailable(loadError));
      onStatusChange?.(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    const clearOnAuthFailure = () => closeNow();
    window.addEventListener(USER_AUTH_FAILED_EVENT, clearOnAuthFailure);
    return () => {
      controller.abort();
      window.removeEventListener(USER_AUTH_FAILED_EVENT, clearOnAuthFailure);
    };
  }, [client]);

  const manualSecret = useMemo(() => extractTotpSecret(enrollment?.otpauthUri ?? ""), [enrollment]);
  const isOpen = action !== null;
  const needsCurrentFactor = action === "reset" || action === "regenerate" || action === "disable";
  const title = action === "enroll"
    ? "设置二次身份验证"
    : action === "reset"
      ? "重新设置身份验证器"
      : action === "regenerate"
        ? "重新生成恢复码"
        : "停用二次身份验证";

  function openLifecycle(nextAction: LifecycleAction) {
    clearSensitiveState();
    setAction(nextAction);
    setStage("verify");
  }

  function clearSensitiveState() {
    setPassword("");
    setFactorCode("");
    setShowPassword(false);
    setShowFactor(false);
    setEnrollment(null);
    setConfirmationCode("");
    setRecoveryCodes([]);
    setAcknowledged(false);
    setError("");
    setBusy(false);
  }

  function closeNow() {
    setAction(null);
    setStage("verify");
    clearSensitiveState();
  }

  function requestClose() {
    if (stage === "recovery" && recoveryCodes.length > 0 && !acknowledged) {
      setStage("confirm_close");
      return;
    }
    closeNow();
  }

  async function submitVerification() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      if (action === "enroll" || action === "reset") {
        const nextEnrollment = await client.beginEnrollment({
          currentPassword: password,
          currentFactor: action === "reset" ? { method: factorMethod, code: factorCode } : undefined,
        });
        setPassword("");
        setFactorCode("");
        setEnrollment(nextEnrollment);
        setStage("setup");
        return;
      }
      if (action === "regenerate") {
        const result = await client.regenerateRecoveryCodes({
          currentPassword: password,
          factor: { method: factorMethod, code: factorCode },
        });
        setPassword("");
        setFactorCode("");
        setRecoveryCodes(result.recoveryCodes);
        setStage("recovery");
        await loadStatus();
        return;
      }
      await client.disable({
        currentPassword: password,
        factor: { method: factorMethod, code: factorCode },
      });
      closeNow();
      await loadStatus();
      onFeedback("二次身份验证已停用，所有未使用的敏感操作授权均已撤销。", "warning");
    } catch (submitError) {
      setPassword("");
      setFactorCode("");
      if (isStepUpAuthFailure(submitError)) {
        const message = presentStepUpError(submitError);
        closeNow();
        onFeedback(message, "error");
        await loadStatus();
      } else {
        setError(presentStepUpError(submitError));
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollment() {
    if (!enrollment) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.confirmEnrollment({
        enrollmentId: enrollment.enrollmentId,
        code: confirmationCode,
      });
      setEnrollment(null);
      setConfirmationCode("");
      setRecoveryCodes(result.recoveryCodes);
      setStage("recovery");
      await loadStatus();
    } catch (confirmError) {
      setConfirmationCode("");
      if (isStepUpAuthFailure(confirmError)) {
        const message = presentStepUpError(confirmError);
        closeNow();
        onFeedback(message, "error");
        await loadStatus();
      } else {
        setError(presentStepUpError(confirmError));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      onFeedback(successMessage, "success");
    } catch {
      onFeedback("复制失败，请手动记录。", "error");
    }
  }

  function downloadRecoveryCodes() {
    const blob = new Blob(
      [`Stella X recovery codes\n\n${recoveryCodes.join("\n")}\n`],
      { type: "text/plain;charset=utf-8" },
    );
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "stella-x-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(objectUrl);
    setAcknowledged(true);
  }

  return (
    <>
      <ConsoleSection
        title="二次身份验证"
        description="真实资金敏感操作使用 6 位动态验证码授权；授权有效 120 秒且只能使用一次。"
        actions={<StepUpSecurityStatusTag status={status} unavailable={unavailable} />}
      >
        <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">
              {status?.enrolled ? "身份验证器已启用" : status?.pendingEnrollment ? "设置尚未完成" : "尚未设置身份验证器"}
            </p>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">
              {status?.enrolled
                ? `启用于 ${status.enabledAt ? formatDate(status.enabledAt) : "-"}，剩余 ${status.recoveryCodesRemaining} 个恢复码。`
                : "只读浏览和预检不受影响；新增凭证、开启执行、建立或退出对冲组合前必须完成设置。"}
            </p>
            {statusError ? <p className="mt-2 text-xs leading-5 text-red-200" role="alert">{statusError}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {status?.enrolled ? (
              <>
                <Button onClick={() => openLifecycle("regenerate")} type="button" variant="secondary"><RefreshCw size={15} />恢复码</Button>
                <Button onClick={() => openLifecycle("reset")} type="button" variant="secondary"><KeyRound size={15} />重新设置</Button>
                <Button onClick={() => openLifecycle("disable")} type="button" variant="danger"><ShieldOff size={15} />停用</Button>
              </>
            ) : (
              <Button disabled={unavailable} onClick={() => openLifecycle("enroll")} type="button">
                <ShieldCheck size={15} />{status?.pendingEnrollment ? "重新开始设置" : "开始设置"}
              </Button>
            )}
          </div>
        </div>
      </ConsoleSection>

      <Modal
        closeDisabled={busy}
        description="密码、动态验证码、设置 URI 和恢复码只保存在当前弹窗内存中，关闭后立即清空。"
        focusKey={stage}
        onClose={requestClose}
        open={isOpen}
        shellClassName="max-w-[820px]"
        title={title}
      >
        {stage === "verify" ? (
          <LifecycleVerification
            action={action}
            busy={busy}
            error={error}
            factorCode={factorCode}
            factorMethod={factorMethod}
            needsCurrentFactor={needsCurrentFactor}
            onFactorCode={setFactorCode}
            onFactorMethod={setFactorMethod}
            onPassword={setPassword}
            onShowFactor={() => setShowFactor((current) => !current)}
            onShowPassword={() => setShowPassword((current) => !current)}
            onSubmit={() => void submitVerification()}
            password={password}
            showFactor={showFactor}
            showPassword={showPassword}
          />
        ) : null}
        {stage === "setup" && enrollment ? (
          <EnrollmentSetup
            busy={busy}
            code={confirmationCode}
            enrollment={enrollment}
            error={error}
            generateQrDataUrl={generateQrDataUrl}
            manualSecret={manualSecret}
            onCode={setConfirmationCode}
            onConfirm={() => void confirmEnrollment()}
            onCopy={(value) => void copyText(value, "手动设置值已复制。")}
          />
        ) : null}
        {stage === "recovery" ? (
          <RecoveryCodes
            acknowledged={acknowledged}
            codes={recoveryCodes}
            onAcknowledge={setAcknowledged}
            onClose={requestClose}
            onCopy={() => void copyText(recoveryCodes.join("\n"), "恢复码已复制，请保存到安全位置。")}
            onDownload={downloadRecoveryCodes}
          />
        ) : null}
        {stage === "confirm_close" ? (
          <div className="space-y-4">
            <div
              className="border border-amber-400/35 bg-amber-400/[0.06] p-4 text-sm leading-6 text-amber-100"
              data-modal-initial-focus
              tabIndex={-1}
            >
              恢复码关闭后不会再次显示。确认已保存，或返回继续复制与下载。
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button onClick={() => setStage("recovery")} type="button" variant="secondary">返回恢复码</Button>
              <Button onClick={closeNow} type="button" variant="danger">仍然关闭</Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

export function StepUpSecurityStatusTag({ status, unavailable }: { status: StepUpStatus | null; unavailable: boolean }) {
  if (unavailable) return <StatusTag tone="danger">不可用</StatusTag>;
  if (!status) return <StatusTag tone="neutral">加载中</StatusTag>;
  if (status.enrolled && status.recoveryCodesRemaining === 0) return <StatusTag tone="warning">需恢复</StatusTag>;
  if (status.enrolled) return <StatusTag tone="success">已启用</StatusTag>;
  if (status.pendingEnrollment) return <StatusTag tone="warning">设置中</StatusTag>;
  return <StatusTag tone="neutral">未设置</StatusTag>;
}

function LifecycleVerification({
  action,
  busy,
  error,
  factorCode,
  factorMethod,
  needsCurrentFactor,
  onFactorCode,
  onFactorMethod,
  onPassword,
  onShowFactor,
  onShowPassword,
  onSubmit,
  password,
  showFactor,
  showPassword,
}: {
  action: LifecycleAction | null;
  busy: boolean;
  error: string;
  factorCode: string;
  factorMethod: StepUpFactor["method"];
  needsCurrentFactor: boolean;
  onFactorCode: (value: string) => void;
  onFactorMethod: (value: StepUpFactor["method"]) => void;
  onPassword: (value: string) => void;
  onShowFactor: () => void;
  onShowPassword: () => void;
  onSubmit: () => void;
  password: string;
  showFactor: boolean;
  showPassword: boolean;
}) {
  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <SensitiveField initialFocus label="当前密码" onChange={onPassword} onToggle={onShowPassword} show={showPassword} value={password} />
      {needsCurrentFactor ? (
        <>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-slate-200">当前验证方式</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["totp", "recovery_code"] as const).map((method) => (
                <button
                  aria-pressed={factorMethod === method}
                  className={`min-h-11 border px-3 text-sm font-semibold ${factorMethod === method ? "border-white bg-white text-black" : "border-white/20 text-muted"}`}
                  key={method}
                  onClick={() => onFactorMethod(method)}
                  type="button"
                >
                  {method === "totp" ? "动态验证码" : "恢复码"}
                </button>
              ))}
            </div>
          </fieldset>
          <SensitiveField
            label={factorMethod === "totp" ? "6 位动态验证码" : "恢复码"}
            onChange={onFactorCode}
            onToggle={onShowFactor}
            show={showFactor}
            value={factorCode}
          />
        </>
      ) : null}
      {error ? <p className="border border-red-400/35 bg-red-400/[0.06] p-3 text-sm text-red-200" role="alert">{error}</p> : null}
      <Button
        className="w-full"
        disabled={busy || !password.trim() || (needsCurrentFactor && !factorCode.trim())}
        type="submit"
        variant={action === "disable" ? "danger" : "primary"}
      >
        {busy ? "验证中" : action === "disable" ? "验证并停用" : "继续"}
      </Button>
    </form>
  );
}

function EnrollmentSetup({
  busy,
  code,
  enrollment,
  error,
  generateQrDataUrl,
  manualSecret,
  onCode,
  onConfirm,
  onCopy,
}: {
  busy: boolean;
  code: string;
  enrollment: StepUpEnrollment;
  error: string;
  generateQrDataUrl?: QrCodeDataUrlGenerator;
  manualSecret: string;
  onCode: (value: string) => void;
  onConfirm: () => void;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-[248px_minmax(0,1fr)]">
      <TotpQrCode generateDataUrl={generateQrDataUrl} value={enrollment.otpauthUri} />
      <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <div>
          <h3 className="text-sm font-semibold text-white">添加到身份验证器</h3>
          <p className="mt-1 text-xs leading-5 text-muted">扫描二维码，或使用手动设置值。该设置在 {formatDate(enrollment.expiresAt)} 前有效。</p>
        </div>
        <div className="border border-white/15 bg-black p-3">
          <p className="text-xs font-medium text-slate-200">手动设置值</p>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-xs leading-5 text-white">{manualSecret || "无法解析，请重新开始设置。"}</code>
            <button
              aria-label="复制手动设置值"
              className="shrink-0 p-2 text-muted hover:text-white"
              disabled={!manualSecret}
              onClick={() => onCopy(manualSecret)}
              type="button"
            >
              <Clipboard size={16} />
            </button>
          </div>
        </div>
        <label className="xh-account-modal-field">
          <span>身份验证器中的 6 位动态验证码</span>
          <input
            autoComplete="one-time-code"
            className="xh-account-modal-control font-mono"
            data-modal-initial-focus
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => onCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
            type="password"
            value={code}
          />
        </label>
        {error ? <p className="border border-red-400/35 bg-red-400/[0.06] p-3 text-sm text-red-200" role="alert">{error}</p> : null}
        <Button className="w-full" disabled={busy || code.length !== 6 || !manualSecret} type="submit">
          {busy ? "确认中" : "确认并启用"}
        </Button>
      </form>
    </div>
  );
}

function RecoveryCodes({
  acknowledged,
  codes,
  onAcknowledge,
  onClose,
  onCopy,
  onDownload,
}: {
  acknowledged: boolean;
  codes: string[];
  onAcknowledge: (value: boolean) => void;
  onClose: () => void;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="space-y-4">
      <div
        className="border border-amber-400/35 bg-amber-400/[0.06] p-4 text-sm leading-6 text-amber-100"
        data-modal-initial-focus
        tabIndex={-1}
      >
        这 8 个恢复码只显示一次。每个恢复码只能使用一次，请保存到密码管理器或离线安全位置。
      </div>
      <div className="grid gap-px bg-white/10 sm:grid-cols-2" aria-label="一次性恢复码">
        {codes.map((code, index) => (
          <code className="bg-black px-4 py-3 font-mono text-sm text-white" key={`${index}:${code}`}>{code}</code>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button onClick={onCopy} type="button" variant="secondary"><Clipboard size={15} />复制恢复码</Button>
        <Button onClick={onDownload} type="button" variant="secondary"><Download size={15} />下载文本</Button>
      </div>
      <label className="flex items-start gap-3 border border-white/15 p-3 text-sm leading-5 text-slate-200">
        <input className="mt-1" checked={acknowledged} onChange={(event) => onAcknowledge(event.target.checked)} type="checkbox" />
        <span>我已将恢复码保存到安全位置，并了解关闭后无法再次查看。</span>
      </label>
      <Button className="w-full" disabled={!acknowledged} onClick={onClose} type="button">完成</Button>
    </div>
  );
}

function SensitiveField({
  initialFocus = false,
  label,
  onChange,
  onToggle,
  show,
  value,
}: {
  initialFocus?: boolean;
  label: string;
  onChange: (value: string) => void;
  onToggle: () => void;
  show: boolean;
  value: string;
}) {
  return (
    <label className="xh-account-modal-field">
      <span>{label}</span>
      <span className="relative block">
        <input
          autoCapitalize="none"
          autoComplete="off"
          className="xh-account-modal-control pr-12"
          data-modal-initial-focus={initialFocus ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          type={show ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={show ? `隐藏${label}` : `显示${label}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-muted hover:text-white"
          onClick={onToggle}
          type="button"
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </label>
  );
}

function extractTotpSecret(uri: string) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "otpauth:") return "";
    return parsed.searchParams.get("secret")?.trim() ?? "";
  } catch {
    return "";
  }
}
