import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Clock3,
  LogOut,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assetAuthorizationCreateIntent,
  assetAuthorizationRevokeIntent,
  assetManagementClient,
  assetTakeoverStartIntent,
} from "../../../api/arbitrageAssetManagement";
import { presentAutomationConsoleError } from "../../../api/arbitrageAutomationConsole";
import { USER_AUTH_FAILED_EVENT } from "../../../api/session";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import type {
  AssetAuthorizationView,
  AssetAuthorizationPreviewView,
  AssetExitPreviewView,
  AssetLeverage,
  AssetManagementClient,
  AssetTakeoverDiscoveryView,
  AssetTakeoverDisplayView,
  AssetTakeoverPreviewView,
  AssetVenue,
  OpaquePreview,
  RequestAssetStepUp,
} from "../model/assetManagementTypes";
import type { AutomationCredentialSummary } from "../model/controlConsoleTypes";
import {
  ConsoleSection,
  StatusTag,
  formatDate,
  formatMoney,
  venueLabel,
} from "./AutomationConsoleShared";

const activeTakeoverStates = new Set([
  "planned",
  "cancelling_orders",
  "awaiting_reconfirm",
  "setting_leverage",
  "opening_spot",
  "opening_perpetual",
  "managed",
  "manual_intervention",
]);

export type AssetScopeSnapshot = Readonly<{
  generation: number;
  scope: string;
}>;

export function createAssetScopeGuard(initialScope: string) {
  let generation = 0;
  let scope = initialScope;
  return {
    capture(): AssetScopeSnapshot {
      return { generation, scope };
    },
    isCurrent(snapshot: AssetScopeSnapshot) {
      return snapshot.generation === generation && snapshot.scope === scope;
    },
    sync(nextScope: string) {
      if (nextScope !== scope) {
        scope = nextScope;
        generation += 1;
      }
    },
  };
}

export function takeoverDisplayAfterAbort(
  result: AssetTakeoverDiscoveryView,
): AssetTakeoverDisplayView | null {
  return result.state === "failed" ? null : result;
}

export function takeoverDisplayAfterAbortFailure(
  existing: AssetTakeoverDisplayView,
  refreshed: AssetTakeoverDiscoveryView | null,
): AssetTakeoverDisplayView {
  return refreshed ?? existing;
}

export function authorizationForAssetScope(
  authorization: AssetAuthorizationView | null,
  resolvedScope: string | null,
  currentScope: string,
) {
  return resolvedScope === currentScope ? authorization : null;
}

export function assetAuthorityGate(input: {
  accountScope: string;
  authorizationError: string | null;
  authorizationLoading: boolean;
  lifecycleError: string | null;
  lifecycleLoading: boolean;
  resolvedAuthorizationScope: string | null;
  resolvedLifecycleScope: string | null;
}) {
  const authorizationSettled = input.resolvedAuthorizationScope === input.accountScope;
  const lifecycleSettled = input.resolvedLifecycleScope === input.accountScope;
  const authorizationPending = input.authorizationLoading || (!input.authorizationError && !authorizationSettled);
  const lifecyclePending = input.lifecycleLoading || (!input.lifecycleError && !lifecycleSettled);
  return {
    actionsReady: authorizationSettled
      && lifecycleSettled
      && !input.authorizationError
      && !input.lifecycleError
      && !input.authorizationLoading
      && !input.lifecycleLoading,
    canRetry: Boolean(input.authorizationError || input.lifecycleError)
      && !input.authorizationLoading
      && !input.lifecycleLoading,
    pending: authorizationPending || lifecyclePending,
  };
}

export function AutomationAssetManagement({
  client = assetManagementClient,
  credentials,
  onFeedback,
  requestStepUp,
}: {
  client?: AssetManagementClient;
  credentials: AutomationCredentialSummary[];
  onFeedback: (message: string, tone: "success" | "warning" | "error") => void;
  requestStepUp: RequestAssetStepUp;
}) {
  const venues = useMemo(() => credentials.filter((item) =>
    (item.venue === "binance" || item.venue === "bybit") && item.implemented
  ), [credentials]);
  const [venue, setVenue] = useState<AssetVenue>(() =>
    venues.find((item) => item.venue === "binance")?.venue as AssetVenue
      ?? venues[0]?.venue as AssetVenue
      ?? "binance"
  );
  const credential = credentials.find((item) => item.venue === venue);
  const accountScope = `${venue}:${credential?.accountId ?? "-"}:${credential?.lastVerifiedAt ?? "-"}`;
  const [authorization, setAuthorization] = useState<AssetAuthorizationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [resolvedAuthorizationScope, setResolvedAuthorizationScope] = useState<string | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [resolvedLifecycleScope, setResolvedLifecycleScope] = useState<string | null>(null);
  const [authorityReloadKey, setAuthorityReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizationPreview, setAuthorizationPreview] = useState<OpaquePreview<AssetAuthorizationPreviewView> | null>(null);
  const [capital, setCapital] = useState("100");
  const [leverageInput, setLeverageInput] = useState("2");
  const [takeoverPreviewValue, setTakeoverPreviewValue] = useState<OpaquePreview<AssetTakeoverPreviewView> | null>(null);
  const [takeover, setTakeover] = useState<AssetTakeoverDisplayView | null>(null);
  const [reconfirmation, setReconfirmation] = useState<OpaquePreview<AssetTakeoverPreviewView> | null>(null);
  const [reconfirmationBase, setReconfirmationBase] = useState<AssetTakeoverPreviewView | null>(null);
  const [abortConfirmationOpen, setAbortConfirmationOpen] = useState(false);
  const [exitPreviewValue, setExitPreviewValue] = useState<OpaquePreview<AssetExitPreviewView> | null>(null);
  const [now, setNow] = useState(Date.now());
  const startIdempotencyRef = useRef<string | null>(null);
  const exitIdempotencyRef = useRef<string | null>(null);
  const scopeRef = useRef(accountScope);
  const scopeGuardRef = useRef(createAssetScopeGuard(accountScope));
  scopeGuardRef.current.sync(accountScope);

  const clearPending = useCallback(() => {
    setAuthorizationPreview(null);
    setTakeoverPreviewValue(null);
    setReconfirmation(null);
    setReconfirmationBase(null);
    setExitPreviewValue(null);
    startIdempotencyRef.current = null;
    exitIdempotencyRef.current = null;
  }, []);

  const loadAuthorization = useCallback(async (signal?: AbortSignal) => {
    const operationScope = scopeGuardRef.current.capture();
    if (!credential?.accountId) {
      if (scopeGuardRef.current.isCurrent(operationScope)) {
        setAuthorization(null);
        setLoading(false);
        setAuthorizationError(null);
        setResolvedAuthorizationScope(operationScope.scope);
      }
      return;
    }
    if (scopeGuardRef.current.isCurrent(operationScope)) {
      setLoading(true);
      setAuthorizationError(null);
    }
    try {
      const next = await client.getAuthorization(venue, signal);
      if (scopeGuardRef.current.isCurrent(operationScope)) {
        setAuthorization(next);
        setAuthorizationError(null);
        setResolvedAuthorizationScope(operationScope.scope);
      }
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") return;
      if (scopeGuardRef.current.isCurrent(operationScope)) {
        setAuthorization(null);
        setResolvedAuthorizationScope(null);
        setAuthorizationError(presentAutomationConsoleError(loadError).message);
      }
    } finally {
      if (!signal?.aborted && scopeGuardRef.current.isCurrent(operationScope)) setLoading(false);
    }
  }, [authorityReloadKey, client, credential?.accountId, credential?.lastVerifiedAt, credential?.status, venue]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAuthorization(controller.signal);
    return () => controller.abort();
  }, [loadAuthorization]);

  useEffect(() => {
    const controller = new AbortController();
    const operationScope = scopeGuardRef.current.capture();
    if (!credential?.accountId) {
      setTakeover(null);
      setLifecycleLoading(false);
      setLifecycleError(null);
      setResolvedLifecycleScope(accountScope);
      return () => controller.abort();
    }
    setLifecycleLoading(true);
    setLifecycleError(null);
    void client.getCurrentTakeover(venue, controller.signal)
      .then((current) => {
        if (!controller.signal.aborted && scopeGuardRef.current.isCurrent(operationScope)) {
          setTakeover(current);
          setLifecycleError(null);
          setResolvedLifecycleScope(operationScope.scope);
        }
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        if (scopeGuardRef.current.isCurrent(operationScope)) {
          setLifecycleError(presentAutomationConsoleError(loadError).message);
          setResolvedLifecycleScope(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && scopeGuardRef.current.isCurrent(operationScope)) {
          setLifecycleLoading(false);
        }
      });
    return () => controller.abort();
  }, [accountScope, authorityReloadKey, client, credential?.accountId, credential?.lastVerifiedAt, credential?.status, venue]);

  useEffect(() => {
    if (scopeRef.current !== accountScope) {
      scopeRef.current = accountScope;
      clearPending();
      setAuthorization(null);
      setAuthorizationError(null);
      setAbortConfirmationOpen(false);
      setLifecycleError(null);
      setResolvedAuthorizationScope(null);
      setResolvedLifecycleScope(null);
      setTakeover(null);
      setError(null);
      setBusy(false);
    }
  }, [accountScope, clearPending]);

  useEffect(() => {
    const clear = () => {
      clearPending();
      setAuthorization(null);
      setAuthorizationError(null);
      setAbortConfirmationOpen(false);
      setLifecycleError(null);
      setResolvedAuthorizationScope(null);
      setResolvedLifecycleScope(null);
      setTakeover(null);
      setBusy(false);
    };
    window.addEventListener(USER_AUTH_FAILED_EVENT, clear);
    return () => window.removeEventListener(USER_AUTH_FAILED_EVENT, clear);
  }, [clearPending]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (authorizationPreview && authorizationPreview.view.expiresAt <= now) setAuthorizationPreview(null);
    if (takeoverPreviewValue && takeoverPreviewValue.view.expiresAt <= now) {
      setTakeoverPreviewValue(null);
      startIdempotencyRef.current = null;
    }
    if (reconfirmation && reconfirmation.view.expiresAt <= now) {
      setReconfirmation(null);
      setReconfirmationBase(null);
      startIdempotencyRef.current = null;
    }
    if (exitPreviewValue && exitPreviewValue.view.expiresAt <= now) {
      setExitPreviewValue(null);
      exitIdempotencyRef.current = null;
    }
  }, [authorizationPreview, exitPreviewValue, now, reconfirmation, takeoverPreviewValue]);

  useEffect(() => {
    if (!takeover || !activeTakeoverStates.has(takeover.state)) return;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      const operationScope = scopeGuardRef.current.capture();
      try {
        const next = takeover.runtime?.phase === "exiting"
          ? await client.getExitStatus(venue, takeover.takeoverId, controller.signal)
          : await client.getTakeoverStatus(venue, takeover.takeoverId, controller.signal);
        if (!controller.signal.aborted && scopeGuardRef.current.isCurrent(operationScope)) setTakeover(next);
      } catch (pollError) {
        if (
          !(pollError instanceof Error && pollError.name === "AbortError")
          && scopeGuardRef.current.isCurrent(operationScope)
        ) {
          setError(presentAutomationConsoleError(pollError).message);
        }
      }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    timer = window.setInterval(() => void poll(), 5_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, takeover?.state, takeover?.takeoverId, takeover?.runtime?.phase, venue]);

  const run = async (operation: (operationScope: AssetScopeSnapshot) => Promise<void>) => {
    if (busy) return;
    const operationScope = scopeGuardRef.current.capture();
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    setBusy(true);
    setError(null);
    try {
      await operation(operationScope);
    } catch (operationError) {
      if (!scopeGuardRef.current.isCurrent(operationScope)) return;
      if (operationError instanceof Error && operationError.name === "StepUpCancelledError") {
        cancelled = true;
        return;
      }
      const presentation = presentAutomationConsoleError(operationError);
      setError(presentation.message);
      onFeedback(presentation.message, "error");
    } finally {
      if (scopeGuardRef.current.isCurrent(operationScope)) setBusy(false);
      if (cancelled && scopeGuardRef.current.isCurrent(operationScope)) {
        window.requestAnimationFrame(() => {
          if (returnFocus?.isConnected) returnFocus.focus();
        });
      }
    }
  };

  const previewAuthorization = () => void run(async (operationScope) => {
    if (!authority.actionsReady) throw new Error("最新账户状态尚未确认，请重新获取后继续操作。");
    const preview = await client.previewAuthorization(venue);
    if (scopeGuardRef.current.isCurrent(operationScope)) setAuthorizationPreview(preview);
  });

  const enableAuthorization = () => void run(async (operationScope) => {
    if (!authority.actionsReady) throw new Error("最新账户状态尚未确认，请重新获取后继续操作。");
    if (!authorizationPreview || authorizationPreview.view.expiresAt <= Date.now()) {
      setAuthorizationPreview(null);
      throw new Error("授权预览已过期，请重新获取。");
    }
    const intent = await assetAuthorizationCreateIntent(venue, authorizationPreview.opaque);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    const token = await requestStepUp(
      intent,
      "启用 XAUT 资产管理",
      "系统可能撤销、买入、卖出或平掉该账户内全部 XAUT；其他资产不受影响。",
    );
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    const next = await client.createAuthorization(venue, authorizationPreview.opaque, token);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setAuthorization(next);
    clearPending();
    onFeedback("XAUT 资产管理授权已启用。", "success");
  });

  const revokeAuthorization = () => void run(async (operationScope) => {
    if (!authority.actionsReady || !visibleAuthorization?.active) {
      throw new Error("当前账户授权状态尚未确认，请先重试。");
    }
    const intent = await assetAuthorizationRevokeIntent(venue);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    const token = await requestStepUp(intent, "撤销 XAUT 资产管理授权", "撤销后不会建立新的 XAUT 接管计划。已有运行状态仍以服务端为准。");
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    await client.revokeAuthorization(venue, token);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setAuthorization(null);
    clearPending();
    onFeedback("XAUT 资产管理授权已撤销。", "warning");
  });

  const calculateTakeover = () => void run(async (operationScope) => {
    if (!authority.actionsReady || !visibleAuthorization?.active) {
      throw new Error("最新账户状态尚未确认，请重新获取后继续操作。");
    }
    const newCapitalUsd = Number(capital);
    if (!Number.isFinite(newCapitalUsd) || newCapitalUsd <= 0) throw new Error("请输入有效的新增投入金额。");
    const leverage = Number(leverageInput);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 3) throw new Error("杠杆请输入 1 至 3 的整数。");
    const preview = await client.previewTakeover(venue, { newCapitalUsd, leverage: leverage as AssetLeverage });
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setTakeoverPreviewValue(preview);
    startIdempotencyRef.current = crypto.randomUUID();
  });

  const startTakeover = () => void run(async (operationScope) => {
    if (!authority.actionsReady || !visibleAuthorization?.active) {
      throw new Error("最新账户状态尚未确认，请重新获取后继续操作。");
    }
    const preview = takeoverPreviewValue;
    if (!preview || preview.view.expiresAt <= Date.now()) {
      setTakeoverPreviewValue(null);
      throw new Error("接管方案已过期，请重新计算。");
    }
    const intent = await assetTakeoverStartIntent(venue, preview.opaque);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    const token = await requestStepUp(
      intent,
      "启动 XAUT 接管",
      `${venueLabel(venue)} · 新增投入 ${formatMoney(preview.view.newCapitalUsd)} · ${preview.view.selectedLeverage}x`,
    );
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    const key = startIdempotencyRef.current ?? crypto.randomUUID();
    startIdempotencyRef.current = key;
    const result = await client.startTakeover(venue, preview.opaque, token, key);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setTakeover(result.takeover);
    setReconfirmationBase(result.reconfirmation ? preview.view : null);
    setReconfirmation(result.reconfirmation);
    setTakeoverPreviewValue(null);
    if (!result.reconfirmation) startIdempotencyRef.current = null;
    onFeedback(result.reconfirmation ? "账户订单已变化，请核对更新后的接管方案。" : "XAUT 接管流程已启动。", result.reconfirmation ? "warning" : "success");
  });

  const reconfirmTakeover = () => void run(async (operationScope) => {
    if (!takeover || !reconfirmation || reconfirmation.view.expiresAt <= Date.now()) {
      setReconfirmation(null);
      throw new Error("二次确认方案已过期。接管仍在等待确认，可在运行监控中安全终止。");
    }
    const result = await client.reconfirmTakeover(venue, takeover.takeoverId, reconfirmation.opaque);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setTakeover(result.takeover);
    setReconfirmationBase(result.reconfirmation ? reconfirmation.view : null);
    setReconfirmation(result.reconfirmation);
    if (!result.reconfirmation) startIdempotencyRef.current = null;
    onFeedback(result.reconfirmation ? "账户状态再次变化，请重新核对。" : "XAUT 接管已继续执行。", result.reconfirmation ? "warning" : "success");
  });

  const abortTakeover = () => void run(async (operationScope) => {
    if (!takeover || takeover.state !== "awaiting_reconfirm") {
      setAbortConfirmationOpen(false);
      throw new Error("当前没有等待确认的 XAUT 接管。");
    }
    let result;
    try {
      result = await client.abortTakeover(venue, takeover.takeoverId);
    } catch (abortError) {
      if (scopeGuardRef.current.isCurrent(operationScope)) {
        setAbortConfirmationOpen(false);
        try {
          const current = await client.getCurrentTakeover(venue);
          if (scopeGuardRef.current.isCurrent(operationScope)) {
            setTakeover(takeoverDisplayAfterAbortFailure(takeover, current));
          }
        } catch {
          // Keep the last visible authoritative task when refresh is also unavailable.
        }
      }
      throw abortError;
    }
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setAbortConfirmationOpen(false);
    setReconfirmation(null);
    setReconfirmationBase(null);
    startIdempotencyRef.current = null;
    const displayed = takeoverDisplayAfterAbort(result);
    setTakeover(displayed);
    if (!displayed) {
      onFeedback("待确认接管已安全终止。", "success");
      return;
    }
    onFeedback("账户仍有 XAUT 仓位或订单，需要人工处理。", "warning");
  });

  const refreshTakeover = () => void run(async (operationScope) => {
    const current = await client.getCurrentTakeover(venue);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setTakeover(current);
    if (!current) onFeedback("当前账户没有未结束的 XAUT 接管。", "success");
  });

  const retryAuthoritativeState = () => {
    if (busy || loading || lifecycleLoading) return;
    clearPending();
    setAuthorization(null);
    setAuthorizationError(null);
    setLifecycleError(null);
    setResolvedAuthorizationScope(null);
    setResolvedLifecycleScope(null);
    setTakeover(null);
    setError(null);
    setAuthorityReloadKey((value) => value + 1);
  };

  const previewExit = () => void run(async (operationScope) => {
    if (!takeover || takeover.state !== "managed") throw new Error("当前没有可退出的运行中 XAUT 接管。");
    const preview = await client.previewExit(venue, takeover.takeoverId);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setExitPreviewValue(preview);
    exitIdempotencyRef.current = crypto.randomUUID();
  });

  const confirmExit = () => void run(async (operationScope) => {
    if (!takeover || !exitPreviewValue || exitPreviewValue.view.expiresAt <= Date.now()) {
      setExitPreviewValue(null);
      throw new Error("退出预览已过期，请重新获取。");
    }
    const key = exitIdempotencyRef.current ?? crypto.randomUUID();
    exitIdempotencyRef.current = key;
    const next = await client.confirmExit(venue, takeover.takeoverId, exitPreviewValue.opaque, key);
    if (!scopeGuardRef.current.isCurrent(operationScope)) return;
    setTakeover(next);
    setExitPreviewValue(null);
    onFeedback("全部退出请求已提交，正在读取服务端进度。", "warning");
  });

  const previewSeconds = (expiresAt: number, maximum: number) => Math.min(maximum, Math.max(0, Math.ceil((expiresAt - now) / 1_000)));
  const canManage = Boolean(credential?.accountId && credential.status === "connected");
  const visibleAuthorization = authorizationForAssetScope(authorization, resolvedAuthorizationScope, accountScope);
  const authority = assetAuthorityGate({
    accountScope,
    authorizationError,
    authorizationLoading: loading,
    lifecycleError,
    lifecycleLoading,
    resolvedAuthorizationScope,
    resolvedLifecycleScope,
  });
  const authorityError = lifecycleError ?? authorizationError;

  return (
    <div className="space-y-4">
      <ConsoleSection
        actions={authority.pending ? <RefreshCw className="animate-spin text-muted" size={16} /> : null}
        description="按交易所账户管理 XAUT 授权、接管方案、运行状态和全部退出。"
        title="XAUT 资产管理"
      >
        <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="inline-flex max-w-full overflow-x-auto border border-white/15 p-1" aria-label="选择交易所">
              {venues.map((item) => (
                <button
                  aria-pressed={venue === item.venue}
                  className={`min-h-11 min-w-24 px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${venue === item.venue ? "bg-white text-black" : "text-muted hover:text-white"}`}
                  disabled={busy}
                  key={item.venue}
                  onClick={() => {
                    if (busy || item.venue === venue) return;
                    scopeGuardRef.current.sync(`${item.venue}:${item.accountId ?? "-"}:${item.lastVerifiedAt ?? "-"}`);
                    setAuthorization(null);
                    setAuthorizationError(null);
                    setLifecycleError(null);
                    setResolvedAuthorizationScope(null);
                    setResolvedLifecycleScope(null);
                    setVenue(item.venue as AssetVenue);
                    clearPending();
                    setTakeover(null);
                    setError(null);
                  }}
                  type="button"
                >
                  {venueLabel(item.venue)}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusTag tone={canManage ? "success" : "warning"}>{canManage ? "账户已连接" : "账户未就绪"}</StatusTag>
              <StatusTag tone={visibleAuthorization?.active ? "success" : "neutral"}>{visibleAuthorization?.active ? "XAUT 已授权" : authority.actionsReady ? "XAUT 未授权" : "授权状态待确认"}</StatusTag>
            </div>
          </div>

          {!canManage ? (
            <InlineState icon={<AlertTriangle size={17} />} title="请先完成 API 账户验证" detail="资产管理只读取并操作当前用户在所选交易所的 XAUT；未连接账户不会请求授权预览。" tone="warning" />
          ) : null}
          {authorityError ? (
            <InlineState
              action={<Button disabled={!authority.canRetry || busy} onClick={retryAuthoritativeState} type="button" variant="secondary"><RefreshCw size={15} />重新获取</Button>}
              detail={authorityError}
              icon={<XCircle size={17} />}
              title="最新账户状态获取失败"
              tone="danger"
            />
          ) : null}
          {error ? <InlineState icon={<XCircle size={17} />} title="资产管理请求未完成" detail={error} tone="danger" /> : null}

          {canManage ? (
            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)]">
              <section className="min-w-0 border-t border-white/10 pt-4 xl:border-r xl:border-t-0 xl:pr-5">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0"><h3 className="text-sm font-semibold text-white">资产授权</h3><p className="mt-1 text-xs leading-5 text-muted">授权范围仅限当前账户的 XAUT。</p></div>
                  {visibleAuthorization?.active ? <StatusTag tone="success">生效中</StatusTag> : <StatusTag>{authority.actionsReady ? "未启用" : "待确认"}</StatusTag>}
                </div>
                {visibleAuthorization?.active ? (
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                    <Metric label="现货数量" value={`${formatQuantity(visibleAuthorization.spotQuantity)} XAUT`} />
                    <Metric label="永续状态" value={perpetualLabel(visibleAuthorization.perpetualSide, visibleAuthorization.perpetualQuantity)} />
                    <Metric label="活动订单" value={`${visibleAuthorization.spotOrderCount + visibleAuthorization.perpetualOrderCount} 笔`} />
                    <Metric label="授权上限" value={formatMoney(visibleAuthorization.maxManagedNotionalUsd)} />
                    <Metric label="启用时间" value={formatDate(visibleAuthorization.createdAt)} wide />
                  </dl>
                ) : authority.actionsReady ? <p className="mt-4 text-sm leading-6 text-slate-300">启用后系统可能撤销、买入、卖出或平掉该账户内全部 XAUT，其他资产不受影响。</p> : <p className="mt-4 text-sm leading-6 text-slate-300">完成当前账户的授权与接管状态确认后才可操作。</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  {visibleAuthorization?.active ? (
                  <Button disabled={busy || !authority.actionsReady || Boolean(takeover)} onClick={revokeAuthorization} type="button" variant="secondary"><XCircle size={15} />撤销授权</Button>
                  ) : (
                    <Button disabled={busy || !authority.actionsReady} onClick={previewAuthorization} type="button"><ShieldCheck size={15} />查看授权范围</Button>
                  )}
                </div>
              </section>

              <section className="min-w-0">
                <div className="flex min-w-0 items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">接管计算器</h3><p className="mt-1 text-xs leading-5 text-muted">资金、Funding、收益、强平与推荐值均来自服务端。</p></div><Calculator className="shrink-0 text-muted" size={17} /></div>
                <div className="mt-4 grid min-w-0 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(7.5rem,0.28fr)_auto]">
                  <label className="min-w-0 text-xs text-muted"><span className="mb-1.5 block">本次新增投入（USDT）</span><input className="xh-account-modal-control h-11 min-h-11 w-full py-0" disabled={busy || !authority.actionsReady || Boolean(takeover)} inputMode="decimal" min="0" onChange={(event) => { setCapital(event.target.value); setTakeoverPreviewValue(null); startIdempotencyRef.current = null; }} type="number" value={capital} /></label>
                  <label className="min-w-0 text-xs text-muted"><span className="mb-1.5 block">杠杆（1–3x）</span><input className="xh-account-modal-control h-11 min-h-11 w-full py-0" disabled={busy || !authority.actionsReady || Boolean(takeover)} inputMode="numeric" max="3" min="1" onChange={(event) => { setLeverageInput(event.target.value); setTakeoverPreviewValue(null); startIdempotencyRef.current = null; }} step="1" type="number" value={leverageInput} /></label>
                  <Button className="h-11 min-h-11" disabled={busy || !authority.actionsReady || !visibleAuthorization?.active || Boolean(takeover)} onClick={calculateTakeover} type="button" variant="secondary"><Calculator size={15} />计算</Button>
                </div>
                {authority.actionsReady && !visibleAuthorization?.active ? <p className="mt-3 text-xs text-amber-100">启用 XAUT 资产授权后才能计算接管方案。</p> : null}
                {takeover ? <p className="mt-3 text-xs text-amber-100">当前账户已有未结束的 XAUT 接管，请先在运行监控中处理。</p> : null}
                {takeoverPreviewValue ? <TakeoverPreviewPanel busy={busy} onStart={startTakeover} preview={takeoverPreviewValue.view} seconds={previewSeconds(takeoverPreviewValue.view.expiresAt, 30)} /> : null}
              </section>
            </div>
          ) : null}
        </div>
      </ConsoleSection>

      {takeover ? <TakeoverMonitor busy={busy} onAbort={() => setAbortConfirmationOpen(true)} onExit={previewExit} onRefresh={refreshTakeover} takeover={takeover} /> : null}

      <Modal closeDisabled={busy} description="预览只在当前界面短暂保留；账户状态变化或到期后必须重新获取。" onClose={() => setAuthorizationPreview(null)} open={authorizationPreview !== null} title="确认 XAUT 授权范围">
        {authorizationPreview ? <AuthorizationPreview preview={authorizationPreview.view} seconds={previewSeconds(authorizationPreview.view.expiresAt, 120)} /> : null}
        {authorizationPreview ? <Button className="mt-5 w-full" disabled={busy || authorizationPreview.view.expiresAt <= now} onClick={enableAuthorization} type="button"><ShieldCheck size={15} />TOTP 验证并启用</Button> : null}
      </Modal>

      <Modal closeDisabled={busy} description="订单变化后服务端重新计算了接管方案。本次继续不重复要求 TOTP。" onClose={() => { setReconfirmation(null); setReconfirmationBase(null); startIdempotencyRef.current = null; }} open={reconfirmation !== null} title="核对更新后的接管方案">
        {reconfirmation ? <ReconfirmationDiff current={reconfirmationBase} next={reconfirmation.view} seconds={previewSeconds(reconfirmation.view.expiresAt, 30)} /> : null}
        {reconfirmation ? <Button className="mt-5 w-full" disabled={busy || reconfirmation.view.expiresAt <= now} onClick={reconfirmTakeover} type="button"><CheckCircle2 size={15} />确认更新后的方案</Button> : null}
      </Modal>

      <Modal closeDisabled={busy} description="服务端将重新读取当前账户，只在确认没有 XAUT 仓位或活动订单时释放接管；否则转为人工处理。" onClose={() => setAbortConfirmationOpen(false)} open={abortConfirmationOpen} title="安全终止待确认接管">
        <div className="border border-amber-400/30 bg-amber-400/[0.05] p-4 text-sm leading-6 text-amber-50">
          此操作不会向交易所发送订单或撤单。若账户仍有 XAUT 仓位、订单或状态不明确，系统会保留资金占用并标记为需要人工处理。
        </div>
        <Button className="mt-5 w-full" disabled={busy} onClick={abortTakeover} type="button" variant="danger"><XCircle size={15} />确认安全终止</Button>
      </Modal>

      <Modal closeDisabled={busy} description="该操作只退出当前运行中的 XAUT 接管，不复用旧的普通全部退出，也不要求 TOTP。" onClose={() => { setExitPreviewValue(null); exitIdempotencyRef.current = null; }} open={exitPreviewValue !== null} title="全部退出 XAUT 对冲组合">
        {exitPreviewValue ? <ExitPreview preview={exitPreviewValue.view} seconds={previewSeconds(exitPreviewValue.view.expiresAt, 30)} /> : null}
        {exitPreviewValue ? <Button className="mt-5 w-full" disabled={busy || exitPreviewValue.view.expiresAt <= now} onClick={confirmExit} type="button" variant="danger"><LogOut size={15} />确认全部退出</Button> : null}
      </Modal>
    </div>
  );
}

function TakeoverPreviewPanel({ busy, onStart, preview, seconds }: { busy: boolean; onStart: () => void; preview: AssetTakeoverPreviewView; seconds: number }) {
  const selected = preview.leveragePlans.find((item) => item.leverage === preview.selectedLeverage);
  return <div className="mt-4 border-t border-white/10 pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold text-white">服务端接管方案</h4><StatusTag tone={seconds > 10 ? "info" : "warning"}><Clock3 size={12} className="mr-1" />{seconds} 秒</StatusTag></div><dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs md:grid-cols-4"><Metric label="既有管理敞口" value={formatMoney(preview.existingManagedCapitalUsd)} /><Metric label="新增投入" value={formatMoney(preview.newCapitalUsd)} /><Metric label="总管理资金" value={formatMoney(preview.totalManagedCapitalUsd)} /><Metric label="备用资金" value={formatMoney(selected?.reserveUsd ?? preview.totalManagedCapitalUsd * preview.reserveRatio)} /><Metric label="当前 Funding" value={percentValue(selected?.currentFundingAprPercent)} /><Metric label="30 日中位数" value={percentValue(selected?.median30dFundingAprPercent)} /><Metric label="不利压力情景" value={percentValue(selected?.adverseFundingAprPercent)} /><Metric label="强平价 / 距离" value={selected ? `${selected.estimatedLiquidationPrice.toFixed(2)} / ${selected.liquidationDistancePercent.toFixed(2)}%` : "-"} /><Metric label="预计年化收益" value={formatMoney(selected?.currentEstimatedAnnualFundingUsd ?? 0)} /><Metric label="相对新增投入" value={percentValue(selected?.currentReturnOnNewCapitalPercent)} /><Metric label="相对总管理资金" value={percentValue(selected?.currentReturnOnTotalManagedPercent)} /><Metric label="服务端建议" value={`${preview.recommendedLeverage}x · ${plannedAction(preview)}`} /></dl><p className="mt-4 text-xs leading-5 text-muted">当前服务端总管理资金上限为 2,000 USDT；该值是既有敞口与新增投入的合计上限，不是固定单笔上限。</p><Button className="mt-4 w-full sm:w-auto" disabled={busy || seconds === 0 || !selected?.feasible} onClick={onStart} type="button"><ShieldCheck size={15} />TOTP 验证并启动接管</Button></div>;
}

export function TakeoverMonitor({
  busy,
  onAbort,
  onExit,
  onRefresh,
  takeover,
}: {
  busy: boolean;
  onAbort: () => void;
  onExit: () => void;
  onRefresh: () => void;
  takeover: AssetTakeoverDisplayView;
}) {
  const runtime = takeover.runtime;
  const snapshot = runtime?.snapshot;
  const strictHedge = snapshot ? Math.abs(snapshot.spotQuantity - snapshot.perpetualQuantity) <= 0.0001 : false;
  const needsManual = takeover.state === "manual_intervention" || runtime?.phase === "manual_intervention" || (runtime?.residualPerpetualQuantity ?? 0) > 0;
  const acceptedCount = runtime?.acceptedOrderCount ?? ("providerAcceptedOrderCount" in takeover ? takeover.providerAcceptedOrderCount : null);
  const cancelledCount = runtime?.cancelledOrderCount ?? ("cancelledOrderCount" in takeover ? takeover.cancelledOrderCount : null);
  return <ConsoleSection actions={<StatusTag tone={needsManual ? "danger" : runtime?.phase === "monitoring" ? "success" : "warning"}>{runtimePhaseLabel(runtime?.phase, takeover.state)}</StatusTag>} description="状态仅来自服务端接管与退出接口；页面不会直接请求交易所。" title="XAUT 运行监控"><div className="p-4 sm:p-5">{needsManual ? <InlineState icon={<AlertTriangle size={17} />} title="需要人工处理" detail={runtime?.message || takeover.message} tone="danger" /> : null}{takeover.state === "awaiting_reconfirm" ? <InlineState icon={<Clock3 size={17} />} title="等待接管确认" detail="短效确认方案已关闭或过期时，接管仍保留在服务端。可等待当前确认或使用下方安全终止。" tone="warning" /> : null}<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 text-xs md:grid-cols-4"><Metric label="现货数量" value={snapshot ? `${formatQuantity(snapshot.spotQuantity)} XAUT` : `${formatQuantity(takeover.finalSpotQuantity)} XAUT`} /><Metric label="永续数量" value={snapshot ? `${formatQuantity(snapshot.perpetualQuantity)} XAUT` : `${formatQuantity(takeover.finalPerpetualQuantity)} XAUT`} /><Metric label="严格对冲" value={snapshot ? (strictHedge ? "是" : "否") : "等待交易所最新数据"} /><Metric label="Funding" value={snapshot ? `${(snapshot.currentFundingRate * 100).toFixed(4)}%` : "-"} /><Metric label="强平距离" value={snapshot?.liquidationDistancePercent === null || snapshot?.liquidationDistancePercent === undefined ? "-" : `${snapshot.liquidationDistancePercent.toFixed(2)}%`} /><Metric label="备用资金" value={snapshot ? formatMoney(snapshot.reserveUsd) : formatMoney(takeover.reservedCapitalUsd)} /><Metric label="最后成功核对" value={runtime?.lastSuccessfulCheckAt ? formatDate(runtime.lastSuccessfulCheckAt) : "等待核对"} /><Metric label="退出原因" value={runtime?.reason ? runtimeReasonLabel(runtime.reason) : "-"} /><Metric label="已接受结果" value={acceptedCount === null ? "等待详情" : `${acceptedCount} 笔`} /><Metric label="已撤销订单" value={cancelledCount === null ? "等待详情" : `${cancelledCount} 笔`} /><Metric label="现货残余" value={`${formatQuantity(runtime?.residualSpotQuantity ?? takeover.residualQuantity)} XAUT`} /><Metric label="永续残余" value={`${formatQuantity(runtime?.residualPerpetualQuantity ?? 0)} XAUT`} /></dl><p className="mt-4 text-xs leading-5 text-muted">{runtime?.message || takeover.message}</p><div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy} onClick={onRefresh} type="button" variant="secondary"><RefreshCw size={15} />刷新状态</Button>{takeover.state === "awaiting_reconfirm" ? <Button disabled={busy} onClick={onAbort} type="button" variant="danger"><XCircle size={15} />安全终止接管</Button> : null}{takeover.state === "managed" && runtime?.phase !== "exiting" && runtime?.phase !== "exited" ? <Button disabled={busy} onClick={onExit} type="button" variant="danger"><LogOut size={15} />全部退出</Button> : null}</div></div></ConsoleSection>;
}

function AuthorizationPreview({ preview, seconds }: { preview: AssetAuthorizationPreviewView; seconds: number }) {
  return <div className="space-y-4"><div className="border border-amber-400/30 bg-amber-400/[0.05] p-4 text-sm leading-6 text-amber-50">启用后系统可能撤销、买入、卖出或平掉该账户内全部 XAUT，其他资产不受影响。</div><div className="flex items-center justify-between gap-3"><StatusTag tone={seconds > 15 ? "info" : "warning"}>剩余 {seconds} 秒</StatusTag><span className="text-xs text-muted">生成于 {formatDate(preview.generatedAt)}</span></div><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs"><Metric label="现货数量 / 可用" value={`${formatQuantity(preview.spotQuantity)} / ${formatQuantity(preview.spotAvailableQuantity)} XAUT`} /><Metric label="现货锁定" value={`${formatQuantity(preview.spotLockedQuantity)} XAUT`} /><Metric label="永续方向 / 数量" value={perpetualLabel(preview.perpetualSide, preview.perpetualQuantity)} /><Metric label="全部活动订单" value={`${preview.spotOrderCount + preview.perpetualOrderCount} 笔（现货 ${preview.spotOrderCount} / 永续 ${preview.perpetualOrderCount}）`} /><Metric label="现货授权上限" value={`${formatQuantity(preview.maxManagedSpotQuantity)} XAUT`} /><Metric label="永续授权上限" value={`${formatQuantity(preview.maxManagedPerpetualQuantity)} XAUT`} /><Metric label="名义授权上限" value={formatMoney(preview.maxManagedNotionalUsd)} wide /></dl></div>;
}

function ReconfirmationDiff({ current, next, seconds }: { current: AssetTakeoverPreviewView | null; next: AssetTakeoverPreviewView; seconds: number }) {
  return <div className="space-y-4"><StatusTag tone={seconds > 10 ? "warning" : "danger"}>剩余 {seconds} 秒</StatusTag><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs"><Metric label="现货数量（前 / 后）" value={`${formatQuantity(current?.spotQuantity ?? next.spotQuantity)} / ${formatQuantity(next.spotQuantity)} XAUT`} /><Metric label="永续数量（前 / 后）" value={`${formatQuantity(current?.perpetualQuantity ?? next.perpetualQuantity)} / ${formatQuantity(next.perpetualQuantity)} XAUT`} /><Metric label="活动订单（前 / 后）" value={`${current ? current.spotOrderCount + current.perpetualOrderCount : "-"} / ${next.spotOrderCount + next.perpetualOrderCount} 笔`} /><Metric label="更新后计划" value={plannedAction(next)} /></dl><p className="text-sm leading-6 text-slate-300">服务端已按撤单后的最新余额、仓位与订单重新计算。关闭后接管仍保持等待确认，可在运行监控中安全终止。</p></div>;
}

function ExitPreview({ preview, seconds }: { preview: AssetExitPreviewView; seconds: number }) {
  return <div className="space-y-4"><div className="border border-red-400/30 bg-red-400/[0.05] p-4 text-sm leading-6 text-red-100">将撤销当前 XAUT 活动订单，以 reduce-only 退出永续空头并卖出可用现货。交易所规格可能留下不可交易的小额残余。</div><StatusTag tone={seconds > 10 ? "warning" : "danger"}>剩余 {seconds} 秒</StatusTag><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs"><Metric label="待卖现货" value={`${formatQuantity(preview.spotAvailableQuantity)} XAUT`} /><Metric label="现货锁定" value={`${formatQuantity(preview.spotLockedQuantity)} XAUT`} /><Metric label="永续 reduce-only" value={`${formatQuantity(preview.perpetualQuantity)} XAUT`} /><Metric label="普通滑点档" value={`${preview.normalSlippageBps} bps`} /><Metric label="应急滑点档" value={preview.emergencySlippageBps.map((value) => `${value} bps`).join(" / ")} wide /></dl></div>;
}

function InlineState({ action, detail, icon, title, tone }: { action?: React.ReactNode; detail: string; icon: React.ReactNode; title: string; tone: "warning" | "danger" }) {
  return <div className={`flex min-w-0 flex-wrap gap-3 border p-3 ${tone === "danger" ? "border-red-400/30 bg-red-400/[0.05] text-red-100" : "border-amber-400/30 bg-amber-400/[0.05] text-amber-50"}`} role={tone === "danger" ? "alert" : "status"}><span className="mt-0.5 shrink-0">{icon}</span><div className="min-w-0 flex-1"><strong className="text-sm">{title}</strong><p className="mt-1 break-words text-xs leading-5 opacity-80">{detail}</p></div>{action ? <div className="flex w-full justify-end sm:w-auto sm:items-center">{action}</div> : null}</div>;
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}><dt className="text-muted">{label}</dt><dd className="mt-1 break-words font-mono font-medium text-slate-100 tabular-nums">{value}</dd></div>;
}

function formatQuantity(value: number) { return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 }); }
function percentValue(value: number | undefined) { return value === undefined ? "-" : `${value.toFixed(2)}%`; }
function perpetualLabel(side: "long" | "short" | "flat", quantity: number) { return side === "flat" ? "无仓位" : `${side === "short" ? "空头" : "多头"} ${formatQuantity(quantity)} XAUT`; }
function plannedAction(preview: AssetTakeoverPreviewView) { if (preview.missingSpotQuantity > 0) return `补现货 ${formatQuantity(preview.missingSpotQuantity)} XAUT`; if (preview.missingPerpetualQuantity > 0) return `补永续 ${formatQuantity(preview.missingPerpetualQuantity)} XAUT`; return "维持严格对冲"; }
function runtimePhaseLabel(phase: string | undefined, state: string) { return ({ recovery_required: "等待恢复", monitoring: "运行中", paused: "读取暂停", reducing: "减险中", exiting: "退出中", manual_intervention: "人工处理", exited: "已退出" } as Record<string, string>)[phase ?? ""] ?? ({ awaiting_reconfirm: "等待确认", managed: "运行中", manual_intervention: "人工处理", exited: "已退出", failed: "失败" } as Record<string, string>)[state] ?? "处理中"; }
function runtimeReasonLabel(reason: string) { return ({ user_exit: "用户全部退出", user_kill_switch: "用户急停", server_kill_switch: "服务端急停", liquidation_distance: "强平距离不足", funding_unfavorable: "Funding 持续不利", account_changed: "账户状态变化", external_position_change: "检测到外部仓位变化", provider_read_failure: "交易所读取失败", persistent_state_invalid: "持久状态异常" } as Record<string, string>)[reason] ?? "服务端风险退出"; }
