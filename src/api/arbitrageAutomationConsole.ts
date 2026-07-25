import type {
  AutomationActionReceipt,
  AutomationCandidate,
  AutomationConsoleClient,
  AutomationConsoleSnapshot,
  AutomationCredentialStatus,
  AutomationCredentialSummary,
  AutomationParameter,
  AutomationPrivateAccountSnapshot,
  AutomationPositionGroup,
  AutomationPreflight,
  AutomationPreflightFailure,
  AutomationPreflightMode,
  AutomationExecutionOrder,
  AutomationExecutionResult,
  AutomationShadowCheck,
  AutomationVenue,
  AutomationVenueControl,
  CredentialDraft,
  ParameterDraft,
  SafetyAction,
} from "../features/arbitrageAutomation/model/controlConsoleTypes";
import type { StepUpIntent } from "../features/arbitrageAutomation/model/stepUpTypes";
import { normalizeProductAvailability, resolveVenueCapabilities } from "../features/arbitrageAutomation/model/venueCapabilities";
import { HttpRequestError, requestJson } from "./httpClient";
import { createStepUpIntent } from "./stepUpSecurity";

const apiBase = "/api/arbitrage/automation";
const venueOrder: AutomationVenue[] = ["bybit", "bitget", "binance", "okx"];

type VenueStatusDto = {
  venue: AutomationVenue;
  implemented: boolean;
  enabled: boolean;
  phase?: unknown;
  providerWritesEnabled?: unknown;
  productAvailability?: unknown;
  credential: {
    stored: boolean;
    accountId: string | null;
    accountFingerprint: string | null;
    masterKeyConfigured: boolean;
    maskedApiKey: string | null;
    connectionStatus: string;
    lifecycleStatus: string;
    accountMode: string | null;
    permissions: Record<string, boolean> | null;
    lastVerifiedAt: number | null;
    message: string | null;
    ipWhitelistConfigured: boolean | null;
    warnings: string[];
  };
};

type ConfigDto = {
  venue?: AutomationVenue;
  accountId: string | null;
  defaultAccountId: string | null;
  globalExecutionEnabled: boolean;
  strategyEnabled: boolean;
  killSwitchActive: boolean;
  serverGlobalKillSwitchActive: boolean;
  maxStrategyCapitalUsd: number;
  maxEntryBasisBps: number;
  maxCombinedSlippageBps: number;
  minNetAprPercent: number;
  minLiquidationDistancePercent: number;
  maxUnhedgedMs: number;
};

type PrivateAccountDto = Record<string, unknown>;

type OpportunityDto = {
  id: string;
  venue: AutomationVenue | null;
  adapterImplemented: boolean;
  safetyEligible: boolean;
  safetyDisqualifiers: string[];
  automationEligible: boolean;
  automationDisqualifiers: string[];
  netApr: number;
  persistenceRatio: number;
  entryBasisBps: number | null;
  longLeg: { venue: string; symbol: string; asset: string; kind: "spot" | "perpetual" };
  shortLeg: { venue: string; symbol: string; asset: string; kind: "spot" | "perpetual" };
};

type ChallengeDto = {
  challengeId: string;
  challengeToken: string;
  expiresAt: number;
  report: Record<string, unknown>;
};

type SafeShadowReport = Omit<AutomationShadowCheck, "kind" | "candidateId" | "accountId" | "mode">;
type SafePreflightFailure = Omit<AutomationPreflightFailure, "kind" | "candidateId" | "accountId" | "mode">;
type AutomationErrorDetails = {
  shadowReport?: SafeShadowReport;
  preflightFailure?: SafePreflightFailure;
};

export class AutomationConsoleContractError extends Error {
  status: number;
  retryAfterSeconds: number | null;
  category: string | null;
  details: AutomationErrorDetails | null;

  constructor(
    status: number,
    message: string,
    retryAfterSeconds: number | null = null,
    category: string | null = null,
    details: AutomationErrorDetails | null = null,
  ) {
    super(message);
    this.name = "AutomationConsoleContractError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.category = category;
    this.details = details;
  }
}

export function createUserAutomationConsoleClient(): AutomationConsoleClient {
  let latest: AutomationConsoleSnapshot | null = null;
  const challenges = new Map<string, AutomationPreflight>();

  const load = async (signal?: AbortSignal) => {
    challenges.clear();
    const venues = await apiRequest<VenueStatusDto[]>(`${apiBase}/venues`, "API 账户状态加载失败。", { signal });
    const implemented = venues.filter((item) => item.implemented);
    const [opportunities, positions, pnl, audit, configs, accounts] = await Promise.all([
      apiRequest<{ generatedAt: number; eligibleCount: number; items: OpportunityDto[] }>(`${apiBase}/opportunities`, "套利候选加载失败。", { signal }),
      apiRequest<{ items: unknown[] }>(`${apiBase}/positions`, "套利持仓加载失败。", { signal }),
      apiRequest<{ venues: unknown[] }>(`${apiBase}/pnl`, "策略盈亏加载失败。", { signal }),
      apiRequest<{ venues: unknown[] }>(`${apiBase}/audit`, "套利审计加载失败。", { signal }),
      Promise.all(implemented.map(async (item) => {
        const config = await optionalApiRequest<ConfigDto>(`${apiBase}/venues/${item.venue}/config`, "策略参数加载失败。", { signal });
        return config ? { ...config, venue: item.venue } : null;
      })),
      Promise.all(implemented.map(async (item) => {
        if (!item.credential.stored || !item.credential.accountId) return null;
        const account = await optionalApiRequest<PrivateAccountDto>(`${apiBase}/venues/${item.venue}/account`, "交易所账户状态加载失败。", { signal });
        return account ? { venue: item.venue, account } : null;
      })),
    ]);
    latest = buildSnapshot(
      venues,
      opportunities,
      positions,
      pnl,
      audit,
      configs.filter((item): item is ConfigDto & { venue: AutomationVenue } => item !== null),
      accounts.filter((item): item is { venue: AutomationVenue; account: PrivateAccountDto } => item !== null),
    );
    return latest;
  };

  return {
    load,
    async requestPreflight(candidateId, mode) {
      const candidate = requireLatest(latest).candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new AutomationConsoleContractError(422, "候选机会不存在或已失效。", null, "opportunity_not_found");
      if (!candidate.adapterImplemented) throw new AutomationConsoleContractError(501, `${venueName(candidate.venue)} adapter 暂未接入。`, null, "venue_not_implemented");
      if (!candidate.safetyEligible) throw new AutomationConsoleContractError(409, "候选机会未通过安全门槛。", null, "safety_opportunity_blocked");
      if (mode === "arbitrage_entry" && !candidate.automationEligible) {
        throw new AutomationConsoleContractError(409, "候选机会未达到自动策略条件。", null, "automation_opportunity_blocked");
      }
      const credential = requireCredential(requireLatest(latest), candidate.venue);
      if (!credential.canRunReadOnlyPreflight) {
        throw new AutomationConsoleContractError(501, `${venueName(candidate.venue)} 当前阶段不开放预检。`, null, "venue_capability_unavailable");
      }
      if (candidate.canExecute && !candidate.executionReady) {
        throw new AutomationConsoleContractError(409, "API 授权、策略开关或急停状态尚未全部就绪。", null, "execution_not_ready");
      }
      let response: ChallengeDto;
      try {
        response = await apiRequest<ChallengeDto>(`${apiBase}/preflight`, "执行预检失败。", {
          method: "POST",
          body: { accountId: credential.accountId, opportunityId: candidate.id, mode },
        });
      } catch (error) {
        if (
          error instanceof AutomationConsoleContractError
          && ["binance_provider_writes_disabled", "preflight_rejected"].includes(error.category ?? "")
        ) {
          if (error.details?.shadowReport) {
            return {
              kind: "shadow_check",
              ...error.details.shadowReport,
              candidateId: candidate.id,
              accountId: credential.accountId,
              mode,
            };
          }
          if (error.details?.preflightFailure) {
            return {
              kind: "preflight_rejected",
              ...error.details.preflightFailure,
              candidateId: candidate.id,
              accountId: credential.accountId,
              mode,
            };
          }
        }
        throw error;
      }
      if (!credential.canExecute) {
        throw new AutomationConsoleContractError(409, `${venueName(candidate.venue)} 当前阶段不会签发执行 challenge。`, null, "provider_writes_disabled");
      }
      const preflight = mapPreflight(response, candidate, credential, mode);
      challenges.set(preflight.challengeId, preflight);
      return preflight;
    },
    async confirmExecution(challengeId, stepUpToken) {
      const challenge = challenges.get(challengeId);
      if (!challenge) throw new AutomationConsoleContractError(409, "执行 challenge 不存在、已过期或已使用。", null, "challenge_invalid");
      if (challenge.expiresAt <= Date.now()) {
        challenges.delete(challengeId);
        throw new AutomationConsoleContractError(409, "执行 challenge 已过期，请重新预检。", null, "challenge_invalid");
      }
      const currentAccount = requireCredential(requireLatest(latest), challenge.venue);
      if (currentAccount.accountId !== challenge.accountId) {
        challenges.delete(challengeId);
        throw new AutomationConsoleContractError(409, "API 账户已变化，请重新预检。", null, "account_mismatch");
      }
      try {
        const response = await apiRequest<Record<string, unknown>>(`${apiBase}/execute`, "真实执行请求失败。", {
          method: "POST",
          body: { ...executionRequestBody(challenge), stepUpToken },
        });
        challenges.delete(challengeId);
        const execution = mapExecution(response, challenge.venue, challenge.accountId);
        return realReceipt(execution.message || "真实执行请求已提交，结果以交易所权威订单状态为准。", execution);
      } catch (error) {
        if (
          error instanceof AutomationConsoleContractError
          && ["challenge_invalid", "challenge_disarmed", "restart_disarmed", "preflight_changed", "idempotency_conflict", "account_mismatch"].includes(error.category ?? "")
        ) challenges.delete(challengeId);
        throw error;
      }
    },
    async validateCredential(draft, stepUpToken) {
      const current = requireLatest(latest).credentials.find((item) => item.venue === draft.venue);
      if (!current?.canAuthorize) throw new AutomationConsoleContractError(501, `${venueName(draft.venue)} 当前阶段暂不开放 API 授权。`, null, "venue_not_implemented");
      const response = await apiRequest<VenueStatusDto>(`${apiBase}/venues/${draft.venue}/credentials`, "API 凭证验证失败。", {
        method: "PUT",
        body: { ...credentialRequestBody(draft), stepUpToken },
      });
      return mapCredential(response, null, []);
    },
    async deleteCredential(accountId, stepUpToken) {
      const credential = requireLatest(latest).credentials.find((item) => item.accountId === accountId);
      if (!credential) throw new AutomationConsoleContractError(422, "API 账户不存在或已解绑。", null, "credentials_unconfigured");
      await apiRequest(`${apiBase}/venues/${credential.venue}/credentials`, "API 账户解绑失败。", {
        method: "DELETE",
        body: { accountId, stepUpToken },
      });
      challenges.clear();
      return realReceipt(`${venueName(credential.venue)} API 账户已解绑。`);
    },
    async validateParameters(venue, draft) {
      const snapshot = requireLatest(latest);
      const credential = requireCredential(snapshot, venue);
      const body: Record<string, number | string> = { accountId: credential.accountId };
      for (const key of parameterKeys) {
        if (!Number.isFinite(draft[key])) continue;
        body[key] = key === "maxUnhedgedMs" ? draft[key] * 1_000 : draft[key];
      }
      await apiRequest(`${apiBase}/venues/${venue}/config`, "策略参数保存失败。", { method: "PUT", body });
      challenges.clear();
      return realReceipt(`${venueName(venue)} 策略参数已保存。`);
    },
    async performSafetyAction(action, stepUpToken) {
      const snapshot = requireLatest(latest);
      const credential = requireCredential(snapshot, action.venue);
      if (action.type === "toggle_global_execution" || action.type === "toggle_strategy") {
        const field = action.type === "toggle_global_execution" ? "globalExecutionEnabled" : "strategyEnabled";
        const body = { accountId: credential.accountId, [field]: action.enabled };
        await apiRequest(`${apiBase}/venues/${action.venue}/config`, "执行开关更新失败。", {
          method: "PUT",
          body: action.enabled ? { ...body, stepUpToken } : body,
        });
        challenges.clear();
        return realReceipt(`${venueName(action.venue)} 执行开关已更新。`);
      }
      if (action.type === "set_kill_switch") {
        const body = { accountId: credential.accountId, active: action.active };
        await apiRequest(`${apiBase}/venues/${action.venue}/kill-switch`, "Kill switch 操作失败。", {
          method: "POST",
          body: action.active ? body : { ...body, stepUpToken },
        });
        challenges.clear();
        return realReceipt(`${venueName(action.venue)} Kill switch 已${action.active ? "激活" : "解除"}。`);
      }
      if (action.type === "close_all") {
        const response = await apiRequest<Record<string, unknown>>(`${apiBase}/venues/${action.venue}/close-all`, "退出对冲组合请求失败。", {
          method: "POST",
          body: { accountId: credential.accountId, idempotencyKey: action.idempotencyKey, stepUpToken },
        });
        challenges.clear();
        const execution = mapExecution(response, action.venue, credential.accountId);
        return realReceipt(execution.message || "退出对冲组合请求已提交。", execution);
      }
      throw new AutomationConsoleContractError(422, "服务端不支持独立 venue 开关。", null, "unsupported_config_field");
    },
    async closePosition(positionId, stepUpToken, requestIdempotencyKey) {
      const snapshot = requireLatest(latest);
      const position = snapshot.positionGroups.find((item) => item.id === positionId);
      if (!position) throw new AutomationConsoleContractError(422, "持仓不存在或已退出。", null, "position_not_found");
      const credential = snapshot.credentials.find((item) => item.venue === position.venue);
      if (!credential?.canExecute) {
        throw new AutomationConsoleContractError(501, `${venueName(position.venue)} 当前阶段不开放持仓写操作。`, null, `${position.venue}_provider_writes_disabled`);
      }
      const body = positionCloseRequestBody(position.accountId, requestIdempotencyKey);
      await apiRequest(`${apiBase}/positions/${encodeURIComponent(positionId)}/close`, "持仓退出请求失败。", {
        method: "POST",
        body: { ...body, stepUpToken },
      });
      return realReceipt("退出对冲组合请求已提交。");
    },
  };
}

export const userAutomationConsoleClient = createUserAutomationConsoleClient();

export async function credentialStepUpIntent(draft: CredentialDraft): Promise<StepUpIntent> {
  return createStepUpIntent({
    operation: "credential_put",
    venue: draft.venue,
    accountId: draft.accountId ?? "new-account",
    resourceId: null,
    requestBody: credentialRequestBody(draft),
  });
}

export async function credentialDeleteStepUpIntent(
  snapshot: AutomationConsoleSnapshot,
  accountId: string,
): Promise<StepUpIntent> {
  const credential = snapshot.credentials.find((item) => item.accountId === accountId);
  if (!credential) {
    throw new AutomationConsoleContractError(422, "API 账户不存在或已解绑。", null, "credentials_unconfigured");
  }
  return createStepUpIntent({
    operation: "credential_delete",
    venue: credential.venue,
    accountId,
    resourceId: null,
    requestBody: { accountId },
  });
}

export async function executionStepUpIntent(preflight: AutomationPreflight): Promise<StepUpIntent> {
  return createStepUpIntent({
    operation: "hedge_execute",
    venue: preflight.venue,
    accountId: preflight.accountId,
    resourceId: preflight.challengeId,
    requestBody: executionRequestBody(preflight),
  });
}

export async function safetyActionStepUpIntent(
  snapshot: AutomationConsoleSnapshot,
  action: SafetyAction,
): Promise<StepUpIntent | null> {
  const credential = requireCredential(snapshot, action.venue);
  if (action.type === "toggle_global_execution" || action.type === "toggle_strategy") {
    if (!action.enabled) return null;
    const field = action.type === "toggle_global_execution" ? "globalExecutionEnabled" : "strategyEnabled";
    return createStepUpIntent({
      operation: "execution_enable",
      venue: action.venue,
      accountId: credential.accountId,
      resourceId: null,
      requestBody: { accountId: credential.accountId, [field]: true },
    });
  }
  if (action.type === "set_kill_switch") {
    if (action.active) return null;
    return createStepUpIntent({
      operation: "kill_switch_disable",
      venue: action.venue,
      accountId: credential.accountId,
      resourceId: null,
      requestBody: { accountId: credential.accountId, active: false },
    });
  }
  return createStepUpIntent({
    operation: "close_all",
    venue: action.venue,
    accountId: credential.accountId,
    resourceId: null,
    requestBody: { accountId: credential.accountId, idempotencyKey: action.idempotencyKey },
  });
}

export async function positionCloseStepUpIntent(
  snapshot: AutomationConsoleSnapshot,
  positionId: string,
): Promise<{ intent: StepUpIntent; idempotencyKey: string }> {
  const position = snapshot.positionGroups.find((item) => item.id === positionId);
  if (!position) {
    throw new AutomationConsoleContractError(422, "持仓不存在或已退出。", null, "position_not_found");
  }
  const request = positionCloseRequestBody(position.accountId, idempotencyKey(`close:${positionId}`));
  return {
    intent: await createStepUpIntent({
      operation: "position_close",
      venue: position.venue,
      accountId: position.accountId,
      resourceId: positionId,
      requestBody: { positionId, ...request },
    }),
    idempotencyKey: request.idempotencyKey,
  };
}

export function presentAutomationConsoleError(error: unknown) {
  if (!(error instanceof AutomationConsoleContractError)) return { title: "控制台请求失败", message: error instanceof Error ? error.message : "请稍后重试。", retryable: true };
  if (error.status === 401) return { title: "登录已失效", message: error.message, retryable: false };
  if (error.category === "step_up_not_enrolled") return { title: "尚未设置二次验证", message: "请先设置身份验证器，再执行该敏感操作。", retryable: false };
  if (error.category === "step_up_required") return { title: "需要新的二次验证", message: "本次授权不存在或已被撤销，请重新验证。", retryable: true };
  if (error.category === "step_up_invalid") return { title: "二次验证失败", message: "动态验证码无效或已过期，未提交敏感操作。", retryable: true };
  if (error.category === "step_up_expired") return { title: "二次验证已过期", message: "短效授权已过期，未提交敏感操作，请重新验证。", retryable: true };
  if (error.category === "step_up_replayed") return { title: "二次验证已使用", message: "该授权不能重复使用，请获取新的动态验证码。", retryable: true };
  if (error.category === "step_up_scope_mismatch") return { title: "操作内容已经变化", message: "账户、参数或请求内容与授权不匹配，请重新确认。", retryable: true };
  if (error.category === "step_up_recovery_required") return { title: "需要恢复验证", message: "请使用当前身份验证器或一个未使用的恢复码处理安全设置。", retryable: false };
  if (error.category === "step_up_key_unavailable" || error.category?.startsWith("step_up_storage_")) {
    return { title: "二次验证服务不可用", message: "安全密钥或存储暂不可用，敏感操作已阻止。", retryable: true };
  }
  if (error.category === "step_up_rate_limited") return { title: "二次验证过于频繁", message: error.message, retryable: true };
  if (error.status === 403) return { title: "当前账号无操作权限", message: error.message, retryable: false };
  if (error.category === "binance_provider_writes_disabled") return { title: "Binance 执行能力未开放", message: "服务端未明确开放 provider 写调用，已拒绝执行。", retryable: false };
  if (error.category === "preflight_rejected") return { title: "实时预检未通过", message: error.message, retryable: true };
  if (["permission_rejected", "provider_permission_error"].includes(error.category ?? "")) return { title: "API 权限不符合要求", message: "请开启读取、现货和合约交易权限，关闭提现权限，并确认账户模式符合当前阶段要求。", retryable: false };
  if (error.category === "provider_credential_invalid") return { title: "API 凭证无效", message: "交易所拒绝了当前 Key 或 Secret，请核对后重新提交。", retryable: false };
  if (error.category === "provider_timestamp_error") return { title: "交易所时间校验失败", message: "本机或服务端时间与交易所偏差过大，请稍后重试。", retryable: true };
  if (["provider_product_unavailable", "binance_product_unavailable"].includes(error.category ?? "")) return { title: "XAUT 对冲组合当前不可用", message: error.message, retryable: true };
  if (["challenge_invalid", "challenge_disarmed", "restart_disarmed"].includes(error.category ?? "")) return { title: "执行确认已失效", message: "短效执行凭证已过期、已使用或因服务重启失效，请重新预检。", retryable: true };
  if (error.category === "preflight_changed") return { title: "实时条件已经变化", message: "执行前复核未通过，未建立对冲组合，请刷新候选后重新预检。", retryable: true };
  if (error.category === "idempotency_conflict") return { title: "请求标识冲突", message: "该幂等请求标识已用于其他执行，请刷新状态后重试。", retryable: true };
  if (error.category === "manual_intervention") return { title: "需要人工处理", message: "自动安全处置未能闭环，请立即前往对应交易所核对订单与仓位。", retryable: false };
  if (error.category === "compensating") return { title: "正在安全处置", message: "系统正在撤销订单并退出未对冲敞口，请等待状态刷新。", retryable: true };
  if (error.category === "server_kill_switch_active") return { title: "服务端全局急停已开启", message: "当前用户无法绕过平台安全门禁，请等待运维解除后重新预检。", retryable: false };
  if (error.status === 409) return { title: "当前状态已变化", message: error.message, retryable: true };
  if (error.status === 422 || error.status === 400) return { title: "提交内容未通过校验", message: error.message, retryable: false };
  if (error.status === 429) return { title: "操作过于频繁", message: `${error.message} ${error.retryAfterSeconds ? `请在 ${error.retryAfterSeconds} 秒后重试。` : "请稍后重试。"}`, retryable: true };
  if (error.status === 501) return { title: "当前能力未开放", message: error.message, retryable: false };
  return { title: "套利自动化服务暂不可用", message: error.message, retryable: true };
}

export type CredentialAuthorizationFailure = {
  action: string;
  category: string;
  detail: string;
  summary: string;
};

export function presentCredentialAuthorizationError(
  error: unknown,
  hadConfiguredCredential: boolean,
): CredentialAuthorizationFailure {
  const summary = hadConfiguredCredential
    ? "新凭证验证未通过，未保存；原 API 账户配置保持不变。"
    : "验证未通过，凭证未保存，账户仍未配置。";

  if (!(error instanceof AutomationConsoleContractError)) {
    return {
      action: "请检查网络连接，待服务恢复后重新提交。",
      category: "network_or_client_error",
      detail: "未取得服务端有效验证结果。",
      summary,
    };
  }

  const category = error.category ?? "unknown";
  const detail = safeAutomationErrorMessage(error.category, error.message);
  if (category === "provider_credential_invalid") {
    return { action: "请核对 Binance API Key 与 Secret 后重新提交。", category, detail, summary };
  }
  if (["permission_rejected", "provider_permission_error"].includes(category)) {
    return {
      action: "请开启读取、现货与 USD-M Futures 权限，关闭提现权限，并确认使用 one-way 持仓模式后重试。",
      category,
      detail,
      summary,
    };
  }
  if (
    category === "credential_unavailable"
    || category === "credentials_unavailable"
    || category === "credential_key_provider_unavailable"
    || category.startsWith("credential_key_")
  ) {
    return {
      action: "凭证加密服务当前不可用，请等待服务恢复后重试；无需在 Binance 重新创建 Key。",
      category,
      detail,
      summary,
    };
  }
  if (category === "binance_egress_ip_config_missing") {
    return {
      action: "请等待运维补齐 Binance 固定出口 IP 配置后再提交。",
      category,
      detail,
      summary,
    };
  }
  if (["binance_ip_whitelist_unconfirmed", "binance_ip_whitelist_mismatch"].includes(category)) {
    return {
      action: "请按页面公布的生产出口 IP 修正 Binance API Key 白名单后重试。",
      category,
      detail,
      summary,
    };
  }
  if (category === "provider_timestamp_error") {
    return { action: "请等待服务端时间同步后重试。", category, detail, summary };
  }
  if (category === "provider_rate_limited") {
    return { action: "请稍后重试，避免连续重复提交。", category, detail, summary };
  }
  if (["provider_unavailable", "provider_invalid_response"].includes(category)) {
    return { action: "Binance 私有接口暂不可用，请稍后重试。", category, detail, summary };
  }
  if (category === "automation_internal_error") {
    return {
      action: "服务端内部异常尚未修复，请等待服务恢复后重新提交。",
      category,
      detail,
      summary,
    };
  }

  return {
    action: "请根据服务端反馈修正后重试；不要连续重复提交。",
    category,
    detail,
    summary,
  };
}

export function isAccountMismatchError(error: unknown) {
  return error instanceof AutomationConsoleContractError && ["account_mismatch", "credential_account_mismatch"].includes(error.category ?? "");
}

export function isCredentialActivationReady(credential: AutomationCredentialSummary) {
  if (!credential.canAuthorize || credential.status !== "connected" || credential.permissions.withdraw) return false;
  return credential.verificationChecks.every((check) => check.id === "ip_bound" || check.status === "passed");
}

async function apiRequest<T = unknown>(path: string, fallback: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
  try {
    return await requestJson<T>(path, fallback, {
      userAuthFailure: ({ status, category }) => (
        status === 401
        || (status === 403 && !category?.startsWith("step_up_"))
      ),
      mapErrorDetails: extractAutomationErrorDetails,
      init: {
        method: options.method ?? "GET",
        signal: options.signal,
        headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    });
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw new AutomationConsoleContractError(
        error.status,
        safeAutomationErrorMessage(error.category, error.message),
        retrySeconds(error.retryAfter),
        error.category,
        isShadowErrorDetails(error.details) ? error.details : null,
      );
    }
    throw error;
  }
}

async function optionalApiRequest<T>(path: string, fallback: string, options: { signal?: AbortSignal } = {}) {
  try {
    return await apiRequest<T>(path, fallback, options);
  } catch (error) {
    if (error instanceof AutomationConsoleContractError && (error.status === 401 || error.status === 403)) throw error;
    return null;
  }
}

function buildSnapshot(
  venues: VenueStatusDto[],
  opportunities: { generatedAt: number; eligibleCount: number; items: OpportunityDto[] },
  positions: { items: unknown[] },
  pnl: { venues: unknown[] },
  audit: { venues: unknown[] },
  configs: Array<ConfigDto & { venue: AutomationVenue }>,
  accounts: Array<{ venue: AutomationVenue; account: PrivateAccountDto }>,
): AutomationConsoleSnapshot {
  const positionItems = positions.items.map(record);
  const pnlVenues = pnl.venues.map(record);
  const groups = positionItems.map((item) => mapPosition(item, pnlVenues)).filter((item): item is AutomationPositionGroup => item !== null);
  const credentials = venueOrder.map((venue) => {
    const raw = venues.find((item) => item.venue === venue) ?? unimplementedVenue(venue);
    const config = configs.find((item) => item.venue === venue) ?? null;
    const account = accounts.find((item) => item.venue === venue)?.account ?? null;
    return mapCredential(raw, config, groups, account);
  });
  const venueControls = configs.map((config): AutomationVenueControl => {
    const credential = credentials.find((item) => item.venue === config.venue);
    return {
      venue: config.venue,
      accountId: config.accountId,
      globalExecutionEnabled: config.globalExecutionEnabled,
      strategyEnabled: config.strategyEnabled,
      killSwitchActive: config.killSwitchActive,
      serverGlobalKillSwitchActive: config.serverGlobalKillSwitchActive,
      enabled: Boolean(credential?.enabled),
      parameters: mapParameters(config, config.venue),
    };
  });
  const candidates = opportunities.items.map(mapCandidate).filter((item): item is AutomationCandidate => item !== null).map((candidate) => {
    const capability = credentials.find((credential) => credential.venue === candidate.venue);
    return {
      ...candidate,
      canRunReadOnlyPreflight: candidate.adapterImplemented && Boolean(capability?.canRunReadOnlyPreflight),
      canExecute: candidate.adapterImplemented && Boolean(capability?.canExecute),
      executionReady: candidate.adapterImplemented && Boolean(capability?.canExecute && capability.enabled),
    };
  });
  const pnlSeries = pnlVenues.flatMap((venue) => array(venue.series).map((item) => {
    const point = record(item);
    return { timestamp: numberValue(point.capturedAt), netPnl: numberValue(point.netPnlUsd) };
  })).filter((point) => point.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp);
  const currentPnls = pnlVenues.map((venue) => record(venue.current)).filter((item) => Object.keys(item).length > 0);
  const netPnl = currentPnls.reduce((sum, item) => sum + numberValue(item.netPnlUsd), 0);
  const dayPoints = pnlSeries.filter((point) => point.timestamp >= Date.now() - 86_400_000);
  const alerts = buildAlerts(venues, audit, opportunities.generatedAt);
  const serverBlocked = venueControls.some((item) => item.serverGlobalKillSwitchActive);
  const anyExecutionEnabled = venueControls.some((item) => item.globalExecutionEnabled);
  const anyStrategyEnabled = venueControls.some((item) => item.strategyEnabled);
  const anyUserKillSwitch = venueControls.some((item) => item.killSwitchActive);
  return {
    source: "user_api", contractVersion: "user-api-v1", generatedAt: opportunities.generatedAt || Date.now(), mode: "controlled_live",
    status: serverBlocked || anyUserKillSwitch ? "blocked" : "healthy",
    globalExecutionEnabled: anyExecutionEnabled,
    killSwitchActive: anyUserKillSwitch || serverBlocked,
    strategyEnabled: anyStrategyEnabled,
    summary: {
      connectedVenueCount: credentials.filter((item) => item.status === "connected").length,
      totalVenueCount: credentials.length,
      eligibleCandidateCount: candidates.filter((item) => item.canExecute && item.safetyEligible && item.automationEligible).length,
      totalCapitalUsedUsd: groups.reduce((sum, item) => sum + item.capitalUsedUsd, 0),
      netDeltaUsd: groups.reduce((sum, item) => sum + item.netDeltaUsd, 0),
      cumulativeNetPnl: netPnl,
      todayNetPnl: dayPoints.length > 1 ? dayPoints.at(-1)!.netPnl - dayPoints[0].netPnl : 0,
      fundingPnl: currentPnls.reduce((sum, item) => sum + numberValue(item.fundingPnlUsd), 0),
      fees: currentPnls.reduce((sum, item) => sum + numberValue(item.feesUsd), 0),
    },
    credentials,
    candidates,
    positionGroups: groups,
    pnlSeries,
    parameters: venueControls.flatMap((item) => item.parameters),
    venueControls,
    alerts,
    productionEgressIps: [],
  };
}

function mapCredential(raw: VenueStatusDto, config: ConfigDto | null, groups: AutomationPositionGroup[], account: PrivateAccountDto | null = null): AutomationCredentialSummary {
  const credential = raw.credential;
  const permissions = credential.permissions ?? {};
  const accountId = credential.accountId;
  const venueGroups = groups.filter((item) => item.venue === raw.venue);
  const capability = resolveVenueCapabilities(raw);
  return {
    accountId,
    venue: raw.venue,
    implemented: raw.implemented,
    note: `${venueName(raw.venue)} 执行账户`,
    enabled: raw.enabled,
    providerWritesEnabled: raw.providerWritesEnabled === true,
    ...capability,
    status: credentialStatus(raw), maskedKey: credential.maskedApiKey, uidFingerprint: credential.accountFingerprint,
    permissions: {
      read: Boolean(permissions.read),
      spotTrade: Boolean(permissions.spotTrade),
      contractTrade: Boolean(permissions.contractTrade),
      withdraw: Boolean(permissions.withdraw),
      spotAccount: nullableBoolean(permissions.spotAccount),
      futuresAccount: nullableBoolean(permissions.futuresAccount),
      positionModeSupported: nullableBoolean(permissions.positionModeSupported),
    },
    productAvailability: normalizeProductAvailability(raw.productAvailability),
    ipWhitelist: [], ipWhitelistConfigured: credential.ipWhitelistConfigured, warnings: credential.warnings ?? [], accountMode: credential.accountMode,
    lastVerifiedAt: credential.lastVerifiedAt, defaultExecutionAccount: Boolean(accountId && config?.defaultAccountId === accountId), assetStatisticsEnabled: false,
    verificationChecks: credentialChecks(raw),
    activeOrderCount: account
      ? numberValue(record(account.openOrders).spot) + numberValue(record(account.openOrders).perpetual)
      : venueGroups.reduce((sum, item) => sum + item.history.filter((event) => ["New", "PartiallyFilled"].includes(event.status)).length, 0),
    openPositionCount: venueGroups.filter((item) => item.status !== "closed").length,
    accountSnapshot: account ? mapPrivateAccount(raw.venue, account) : null,
  };
}

function credentialChecks(raw: VenueStatusDto): AutomationCredentialSummary["verificationChecks"] {
  const permissions = raw.credential.permissions ?? {};
  const pending = !raw.credential.stored;
  const status = (value: boolean) => pending ? "pending" as const : value ? "passed" as const : "failed" as const;
  const binance = raw.venue === "binance";
  const accountModeSupported = binance
    ? ["single_asset_one_way", "multi_assets_one_way"].includes(raw.credential.accountMode ?? "")
      && permissions.positionModeSupported === true
    : raw.credential.accountMode === "uta";
  return [
    { id: "ip_bound", label: "生产出口 IP 已绑定", status: raw.credential.ipWhitelistConfigured === null ? "pending" : raw.credential.ipWhitelistConfigured ? "passed" : "warning", message: raw.credential.ipWhitelistConfigured === null ? "等待提交后由服务端验证。" : raw.credential.ipWhitelistConfigured ? "交易所已确认 IP 限制。" : "未绑定 IP 白名单，风险较高但不阻断授权。" },
    { id: "read", label: "读取权限", status: status(Boolean(permissions.read)), message: pending ? "等待提交后由服务端验证。" : permissions.read ? "读取权限可用。" : "读取权限不可用。" },
    { id: "spot_trade", label: binance ? "现货账户与交易权限" : "现货交易权限", status: status(Boolean(permissions.spotTrade) && (!binance || permissions.spotAccount === true)), message: pending ? "等待提交后由服务端验证。" : permissions.spotTrade && (!binance || permissions.spotAccount === true) ? "现货账户与交易权限可用。" : "现货账户或交易权限不可用。" },
    { id: "contract_trade", label: binance ? "USD-M Futures 权限" : "合约交易权限", status: status(Boolean(permissions.contractTrade) && (!binance || permissions.futuresAccount === true)), message: pending ? "等待提交后由服务端验证。" : permissions.contractTrade && (!binance || permissions.futuresAccount === true) ? binance ? "USD-M Futures 账户与交易权限可用。" : "合约交易权限可用。" : binance ? "USD-M Futures 账户或交易权限不可用。" : "合约交易权限不可用。" },
    { id: "withdraw_disabled", label: "提现权限关闭", status: pending ? "pending" : permissions.withdraw ? "failed" : "passed", message: pending ? "等待提交后由服务端验证 withdraw=false。" : permissions.withdraw ? "检测到提现权限，禁止激活。" : "withdraw=false。" },
    {
      id: "account_mode",
      label: binance ? "单向持仓模式" : "账户模式满足要求",
      status: pending ? "pending" : accountModeSupported ? "passed" : "failed",
      message: pending
        ? "等待提交后由服务端读取账户模式。"
        : binance
          ? accountModeSupported ? `${binanceAccountModeLabel(raw.credential.accountMode)}，one-way 已确认。` : "第一阶段仅支持 single-asset 或 multi-assets one-way，暂不支持 hedge mode。"
          : accountModeSupported ? "UTA 账户模式。" : "仅支持 UTA 专用子账户。",
    },
  ];
}

function credentialStatus(raw: VenueStatusDto): AutomationCredentialStatus {
  if (!raw.implemented || raw.credential.lifecycleStatus === "not_implemented") return "not_implemented";
  const lifecycle = raw.credential.lifecycleStatus;
  if (lifecycle === "active") return "connected";
  if (["unconfigured", "validating", "expired", "revoked", "rotation_required"].includes(lifecycle)) return lifecycle as AutomationCredentialStatus;
  return "permission_incomplete";
}

function mapCandidate(raw: OpportunityDto): AutomationCandidate | null {
  const venue = isVenue(raw.venue) ? raw.venue : isVenue(raw.longLeg.venue) ? raw.longLeg.venue : null;
  if (!venue) return null;
  return {
    id: raw.id, asset: raw.longLeg.asset, venue,
    longLeg: { venue, symbol: raw.longLeg.symbol, marketType: raw.longLeg.kind, side: "long" },
    shortLeg: { venue, symbol: raw.shortLeg.symbol, marketType: raw.shortLeg.kind, side: "short" },
    netApr: raw.netApr / 100, favorableDayRatio: raw.persistenceRatio, basisBps: raw.entryBasisBps, capacityUsd: null,
    adapterImplemented: raw.adapterImplemented,
    canRunReadOnlyPreflight: false,
    canExecute: false,
    executionReady: false,
    safetyEligible: raw.safetyEligible,
    safetyDisqualifiers: [...(raw.safetyDisqualifiers ?? [])],
    automationEligible: raw.automationEligible,
    automationDisqualifiers: [...(raw.automationDisqualifiers ?? [])],
  };
}

function mapPrivateAccount(venue: AutomationVenue, value: PrivateAccountDto): AutomationPrivateAccountSnapshot {
  const balances = record(value.balances);
  const openOrders = record(value.openOrders);
  const instruments = record(value.instruments);
  const fees = record(value.fees);
  return {
    venue,
    accountId: stringValue(value.accountId),
    fetchedAt: numberValue(value.fetchedAt),
    spotAvailableUsdt: numberValue(balances.spotAvailableUsdt ?? value.availableUsdt),
    futuresAvailableUsdt: numberValue(balances.futuresAvailableUsdt ?? value.availableUsdt),
    spotXaut: numberValue(balances.spotXaut),
    perpetualXaut: numberValue(balances.perpetualXaut),
    openSpotOrders: numberValue(openOrders.spot),
    openPerpetualOrders: numberValue(openOrders.perpetual),
    spot: mapInstrument(instruments.spot),
    perpetual: mapInstrument(instruments.perpetual),
    spotTakerBps: nullableFiniteNumber(fees.spotTakerBps),
    perpetualTakerBps: nullableFiniteNumber(fees.perpetualTakerBps),
  };
}

function mapInstrument(value: unknown) {
  const raw = record(value);
  if (!Object.keys(raw).length) return null;
  return {
    status: safeText(raw.status, 40) || "Unknown",
    bid: numberValue(raw.bid),
    ask: numberValue(raw.ask),
    mark: nullableFiniteNumber(raw.mark),
    depthUsd: nullableFiniteNumber(raw.depthUsd),
    minOrderQty: numberValue(raw.minOrderQty),
    qtyStep: numberValue(raw.qtyStep),
    minNotionalUsd: numberValue(raw.minNotionalUsd),
    priceTick: numberValue(raw.priceTick),
    fundingRate: nullableFiniteNumber(raw.fundingRate),
    fundingIntervalHours: nullableFiniteNumber(raw.fundingIntervalHours),
    nextFundingTime: nullableFiniteNumber(raw.nextFundingTime),
  };
}

function mapPosition(raw: Record<string, unknown>, pnlVenues: Record<string, unknown>[]): AutomationPositionGroup | null {
  const venue = isVenue(raw.venue) ? raw.venue : "bybit";
  const current = raw;
  const legs = record(current.legs);
  const spot = record(legs.spot);
  const perpetual = record(legs.perpetual);
  const venuePnl = pnlVenues.find((item) => item.venue === venue) ?? {};
  const rawExecutionHistory = array(venuePnl.history);
  const history = executionHistory(rawExecutionHistory, venue);
  const latestExecution = record(rawExecutionHistory[0]);
  const capturedAt = numberValue(current.capturedAt) || Date.now();
  const accountId = stringValue(current.accountId);
  if (!accountId) return null;
  return {
    id: stringValue(raw.positionId) || `${venue}:${stringValue(raw.strategyId)}`,
    accountId,
    venue,
    strategyId: stringValue(raw.strategyId) || "unknown-strategy",
    label: `${venueName(venue)} XAUT 现货与永续对冲组合`, mode: "live", status: positionStatus(latestExecution.state), openedAt: history.at(-1)?.occurredAt ?? capturedAt,
    capitalUsedUsd: numberValue(spot.notionalUsd) + numberValue(perpetual.notionalUsd), netDeltaUsd: numberValue(current.netDeltaUsd), basisBps: nullableNumber(current.currentBasisBps),
    realizedPnl: numberValue(current.realizedPnlUsd), unrealizedPnl: numberValue(current.unrealizedPnlUsd), fundingPnl: numberValue(current.fundingPnlUsd), fees: numberValue(current.feesUsd), slippage: numberValue(current.slippageUsd), netPnl: numberValue(current.netPnlUsd),
    legs: [mapLeg(spot, venue, "spot", "long", current, false), mapLeg(perpetual, venue, "perpetual", "short", current, true)].filter((leg) => leg.quantity > 0),
    history,
  };
}

function positionStatus(value: unknown): AutomationPositionGroup["status"] {
  if (value === "accepted" || value === "opening_spot" || value === "opening_perpetual") return "opening";
  if (value === "compensating") return "closing";
  if (value === "closed") return "closed";
  if (value === "failed" || value === "manual_intervention") return "attention";
  return "hedged";
}

function mapLeg(raw: Record<string, unknown>, venue: AutomationVenue, marketType: "spot" | "perpetual", side: "long" | "short", current: Record<string, unknown>, fundingLeg: boolean) {
  return {
    venue, symbol: "XAUTUSDT", marketType, side, quantity: numberValue(raw.quantityXaut), entryPrice: numberValue(raw.averageEntryPrice), markPrice: numberValue(raw.markPrice), notionalUsd: numberValue(raw.notionalUsd),
    unrealizedPnl: numberValue(raw.unrealizedPnlUsd), realizedPnl: numberValue(raw.realizedPnlUsd), fundingPnl: fundingLeg ? numberValue(current.fundingPnlUsd) : 0,
    fees: numberValue(current.feesUsd) / 2, slippage: numberValue(current.slippageUsd) / 2, liquidationDistancePercent: null,
  };
}

function executionHistory(items: unknown[], venue: AutomationVenue): AutomationPositionGroup["history"] {
  return items.flatMap((value) => {
    const execution = record(value);
    const orders = [execution.spotOrder, ...array(execution.perpetualOrders), ...array(execution.compensationOrders)].filter(Boolean).map(record);
    return orders.map((order) => ({
      id: stringValue(order.orderId) || stringValue(order.orderLinkId), type: "order" as const, venue, symbol: "XAUTUSDT", status: stringValue(order.status),
      quantity: nullableNumber(order.filledQuantityXaut), price: nullableNumber(order.averagePrice), occurredAt: numberValue(order.updatedAt) || numberValue(execution.updatedAt),
    }));
  }).sort((a, b) => b.occurredAt - a.occurredAt);
}

const parameterKeys = ["maxStrategyCapitalUsd", "maxEntryBasisBps", "maxCombinedSlippageBps", "minNetAprPercent", "minLiquidationDistancePercent", "maxUnhedgedMs"] as const;
function mapParameters(config: ConfigDto, venue: AutomationVenue): AutomationParameter[] {
  const strategyName = `${venueName(venue)} XAUT`;
  return [
    parameter(venue, "maxStrategyCapitalUsd", "策略资金上限", config.maxStrategyCapitalUsd, 25, 300, 25, "USDT", `${strategyName} 对冲策略资金硬上限。`),
    parameter(venue, "maxEntryBasisBps", "最大入场基差", config.maxEntryBasisBps, 0, 80, 1, "bps", "入场基差绝对值上限。"),
    parameter(venue, "maxCombinedSlippageBps", "两侧最大合计滑点", config.maxCombinedSlippageBps, 1, 20, 1, "bps", "现货侧与永续侧成交滑点合计上限。"),
    parameter(venue, "minNetAprPercent", "最低净 APR", config.minNetAprPercent, 8, 100, 1, "%", "扣除费用与滑点后的最低净 APR。"),
    parameter(venue, "minLiquidationDistancePercent", "最低强平距离", config.minLiquidationDistancePercent, 30, 100, 1, "%", "永续侧所需最低强平安全距离。"),
    parameter(venue, "maxUnhedgedMs", "单侧暴露时限", config.maxUnhedgedMs / 1_000, 1, 10, 1, "seconds", "现货侧成交后允许的最长未对冲时间。"),
  ];
}

function parameter(venue: AutomationVenue, id: string, label: string, value: number, min: number, max: number, step: number, unit: AutomationParameter["unit"], description: string): AutomationParameter {
  return { id, label, value, min, max, step, unit, description, venue, scope: id === "maxStrategyCapitalUsd" ? "global" : "strategy", scopeId: `${venue}-xaut-spot-perp-v1` };
}

function buildAlerts(venues: VenueStatusDto[], audit: { venues: unknown[] }, occurredAt: number) {
  const alerts = venues.flatMap((venue) => [venue.credential.message, ...(venue.credential.warnings ?? [])].filter(Boolean).map((message, index) => ({ id: `${venue.venue}-${index}`, severity: venue.credential.message ? "critical" as const : "warning" as const, message: String(message), occurredAt: venue.credential.lastVerifiedAt ?? occurredAt })));
  for (const value of audit.venues) {
    const venueAudit = record(value);
    const alert = record(venueAudit.alert);
    if (Object.keys(alert).length) alerts.push({ id: `audit-${stringValue(venueAudit.venue)}`, severity: "critical", message: stringValue(alert.message) || "交易所账户需要人工处理。", occurredAt: numberValue(alert.occurredAt) || occurredAt });
  }
  return alerts;
}

function mapPreflight(
  response: ChallengeDto,
  candidate: AutomationCandidate,
  credential: AutomationCredentialSummary & { accountId: string },
  mode: AutomationPreflightMode,
): AutomationPreflight {
  const report = response.report;
  const quantity = numberValue(report.quantityXaut);
  const totalBudget = numberValue(report.totalBudgetUsd);
  const warnings = array(report.warnings).map(stringValue).filter(Boolean);
  const confirmations = ["已核对执行账户、交易所、标的及现货侧与永续侧数量", "已核对总预算与服务端实时预检", "理解这是 Mainnet 真实执行且确认凭证仅可使用一次"];
  if (mode === "manual_entry") confirmations.push("已阅读并接受上述手动决策风险");
  return {
    challengeId: response.challengeId, challengeToken: response.challengeToken, idempotencyKey: idempotencyKey(`execute:${candidate.id}`), expiresAt: response.expiresAt,
    candidateId: candidate.id, accountId: credential.accountId, venue: candidate.venue, mode, estimatedCapitalRequiredUsd: numberValue(report.estimatedCapitalRequiredUsd), totalBudgetUsd: totalBudget,
    exactLegs: [
      { venue: candidate.venue, symbol: candidate.longLeg.symbol, side: "buy", quantity, referencePrice: numberValue(report.referenceSpotAsk), estimatedFeeUsd: null },
      { venue: candidate.venue, symbol: candidate.shortLeg.symbol, side: "sell", quantity, referencePrice: numberValue(report.referencePerpetualBid), estimatedFeeUsd: null },
    ],
    estimatedTotalFeesUsd: nullableFiniteNumber(report.estimatedFeesUsd),
    estimatedSlippageUsd: nullableFiniteNumber(report.estimatedSlippageUsd),
    maximumLossUsd: nullableFiniteNumber(report.maximumLossUsd),
    warnings,
    confirmations,
    checks: mapPreflightChecks(report.checks),
    accountSnapshot: credential.accountSnapshot,
    entryBasisBps: nullableFiniteNumber(report.entryBasisBps),
    fundingRate: nullableFiniteNumber(report.fundingRate),
    estimatedNetAprPercent: nullableFiniteNumber(report.estimatedNetAprPercent),
  };
}

function requireLatest(snapshot: AutomationConsoleSnapshot | null) {
  if (!snapshot) throw new AutomationConsoleContractError(409, "账户状态尚未加载，请刷新后重试。", null, "snapshot_unavailable");
  return snapshot;
}
function requireCredential(snapshot: AutomationConsoleSnapshot, venue: AutomationVenue) {
  const credential = snapshot.credentials.find((item) => item.venue === venue);
  if (!credential?.implemented) throw new AutomationConsoleContractError(501, `${venueName(venue)} adapter 暂未接入。`, null, "venue_not_implemented");
  if (!credential.accountId) throw new AutomationConsoleContractError(409, `请先配置 ${venueName(venue)} API 账户。`, null, "credentials_unconfigured");
  return credential as AutomationCredentialSummary & { accountId: string };
}
function unimplementedVenue(venue: AutomationVenue): VenueStatusDto { return { venue, implemented: false, enabled: false, credential: { stored: false, accountId: null, accountFingerprint: null, masterKeyConfigured: false, maskedApiKey: null, connectionStatus: "not_implemented", lifecycleStatus: "not_implemented", accountMode: null, permissions: null, lastVerifiedAt: null, message: "该交易所 adapter 暂未接入。", ipWhitelistConfigured: null, warnings: [] } }; }
function extractAutomationErrorDetails(payload: unknown) {
  const body = record(payload);
  const report = record(body.report);
  if (
    report.venue === "binance"
    && report.phase === "execution_capable"
    && report.providerWritesEnabled === true
  ) {
    const preflightFailure: SafePreflightFailure = {
      venue: "binance",
      checks: mapPreflightChecks(report.checks),
      warnings: array(report.warnings).map((value) => safeText(value, 240)).filter(Boolean).slice(0, 20),
      message: safeText(report.message, 300) || "市场或账户实时检查未通过。",
      generatedAt: nullableFiniteNumber(report.generatedAt),
    };
    return { preflightFailure };
  }
  if (
    report.venue !== "binance"
    || report.phase !== "phase_1_read_only_shadow"
    || report.providerWritesEnabled !== false
  ) return null;
  const checks = array(report.checks).slice(0, 40).flatMap((value) => {
    const item = record(value);
    const id = safeText(item.id, 80);
    const message = safeText(item.message, 240);
    if (!id || !message || typeof item.passed !== "boolean") return [];
    return [{ id, passed: item.passed, message }];
  });
  const shadowReport: SafeShadowReport = {
    venue: "binance",
    phase: "phase_1_read_only_shadow",
    providerWritesEnabled: false,
    productAvailability: normalizeProductAvailability(report.productAvailability),
    quantityXaut: nullableFiniteNumber(report.quantityXaut),
    totalBudgetUsd: nullableFiniteNumber(report.totalBudgetUsd),
    estimatedCapitalRequiredUsd: nullableFiniteNumber(report.estimatedCapitalRequiredUsd),
    estimatedSpotNotionalUsd: nullableFiniteNumber(report.estimatedSpotNotionalUsd),
    estimatedPerpetualNotionalUsd: nullableFiniteNumber(report.estimatedPerpetualNotionalUsd),
    referenceSpotAsk: nullableFiniteNumber(report.referenceSpotAsk),
    referencePerpetualBid: nullableFiniteNumber(report.referencePerpetualBid),
    entryBasisBps: nullableFiniteNumber(report.entryBasisBps),
    fundingRate: nullableFiniteNumber(report.fundingRate),
    estimatedNetAprPercent: nullableFiniteNumber(report.estimatedNetAprPercent),
    marketChecksPassed: report.marketChecksPassed === true,
    checks,
    warnings: array(report.warnings).map((value) => safeText(value, 240)).filter(Boolean).slice(0, 20),
    generatedAt: nullableFiniteNumber(report.generatedAt),
    message: safeText(report.message, 300) || (report.marketChecksPassed === true
      ? "市场与账户只读检查通过，但 Binance 第一阶段不签发执行 challenge。"
      : "市场或账户只读检查未通过。"),
  };
  return { shadowReport };
}
function isShadowErrorDetails(value: unknown): value is AutomationErrorDetails {
  const details = record(value);
  return details.shadowReport !== undefined || details.preflightFailure !== undefined;
}
function safeAutomationErrorMessage(category: string | null, message: string) {
  if (category === "provider_credential_invalid") return "交易所拒绝了当前 API 凭证。";
  if (category === "provider_permission_error" || category === "permission_rejected") return "交易所账户权限或账户模式不符合当前阶段要求。";
  if (category === "provider_timestamp_error") return "交易所时间校验失败，请稍后重试。";
  if (category === "provider_rate_limited") return "交易所请求过于频繁，请稍后重试。";
  if (category === "provider_unavailable") return "交易所私有接口暂不可用。";
  return safeText(message, 500) || "自动套利服务暂不可用。";
}
function binanceAccountModeLabel(value: string | null) {
  if (value === "single_asset_one_way") return "Single-Asset 单向持仓";
  if (value === "multi_assets_one_way") return "Multi-Assets 单向持仓";
  if (value === "single_asset_hedge") return "Single-Asset Hedge Mode";
  if (value === "multi_assets_hedge") return "Multi-Assets Hedge Mode";
  if (value === "portfolio_margin") return "Portfolio Margin";
  return "未知账户模式";
}
function mapPreflightChecks(value: unknown): AutomationPreflight["checks"] {
  return array(value).slice(0, 50).flatMap((entry) => {
    const raw = record(entry);
    const id = safeText(raw.name ?? raw.id, 80);
    const message = safeText(raw.message, 300);
    if (!id || !message || typeof raw.passed !== "boolean") return [];
    return [{
      id,
      passed: raw.passed,
      value: safeCheckValue(raw.value ?? raw.actual),
      limit: safeCheckValue(raw.limit ?? raw.expected),
      message,
    }];
  });
}
function safeCheckValue(value: unknown): number | string | boolean | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 120);
  return null;
}
function mapExecution(value: unknown, venue: AutomationVenue, accountId: string): AutomationExecutionResult {
  const raw = record(value);
  const allowedStates = new Set<AutomationExecutionResult["state"]>([
    "accepted", "opening_spot", "opening_perpetual", "hedged", "compensating", "closed", "failed", "manual_intervention",
  ]);
  const stateValue = safeText(raw.state, 40) as AutomationExecutionResult["state"];
  return {
    venue,
    accountId,
    executionId: safeText(raw.executionId, 120) || "pending",
    state: allowedStates.has(stateValue) ? stateValue : "unknown",
    message: safeText(raw.message, 500) || "执行状态已更新，请以交易所权威订单和仓位为准。",
    errorCategory: safeText(raw.errorCategory, 100) || null,
    hedgedQuantityXaut: numberValue(raw.hedgedQuantityXaut),
    unhedgedDurationMs: nullableFiniteNumber(raw.unhedgedDurationMs),
    spotOrder: mapExecutionOrder(raw.spotOrder),
    perpetualOrders: array(raw.perpetualOrders).map(mapExecutionOrder).filter((item): item is AutomationExecutionOrder => item !== null),
    compensationOrders: array(raw.compensationOrders).map(mapExecutionOrder).filter((item): item is AutomationExecutionOrder => item !== null),
    createdAt: numberValue(raw.createdAt),
    updatedAt: numberValue(raw.updatedAt),
  };
}
function mapExecutionOrder(value: unknown): AutomationExecutionOrder | null {
  const raw = record(value);
  if (!Object.keys(raw).length) return null;
  return {
    orderId: safeText(raw.orderId, 120),
    orderLinkId: safeText(raw.orderLinkId, 120),
    status: safeText(raw.status, 60) || "Unknown",
    requestedQuantityXaut: numberValue(raw.requestedQuantityXaut),
    filledQuantityXaut: numberValue(raw.filledQuantityXaut),
    averagePrice: nullableFiniteNumber(raw.averagePrice),
    feeUsd: numberValue(raw.feeUsd),
    updatedAt: numberValue(raw.updatedAt),
  };
}
function retrySeconds(value: string | null) { if (!value) return null; const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null; }
function idempotencyKey(scope: string) { return `${scope.replace(/[^A-Za-z0-9:_-]/g, "-")}:${crypto.randomUUID()}`.slice(0, 100); }

function credentialRequestBody(draft: CredentialDraft) {
  const body: Record<string, string> = {
    apiKey: draft.apiKey.trim(),
    apiSecret: draft.secret.trim(),
  };
  if ((draft.venue === "bitget" || draft.venue === "okx") && draft.passphrase?.trim()) {
    body.passphrase = draft.passphrase.trim();
  }
  return body;
}

function executionRequestBody(challenge: Pick<AutomationPreflight, "accountId" | "challengeId" | "challengeToken" | "idempotencyKey">) {
  return {
    accountId: challenge.accountId,
    challengeId: challenge.challengeId,
    challengeToken: challenge.challengeToken,
    idempotencyKey: challenge.idempotencyKey,
  };
}

function positionCloseRequestBody(accountId: string, requestIdempotencyKey: string) {
  return {
    accountId,
    idempotencyKey: requestIdempotencyKey,
  };
}
function realReceipt(message: string, execution?: AutomationExecutionResult): AutomationActionReceipt { return { ok: true, simulated: false, message, execution }; }
function venueName(venue: AutomationVenue) { return ({ bybit: "Bybit", bitget: "Bitget", binance: "Binance", okx: "OKX" } as const)[venue]; }
function isVenue(value: unknown): value is AutomationVenue { return typeof value === "string" && venueOrder.includes(value as AutomationVenue); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumber(value: unknown) { return value === null || value === undefined ? null : numberValue(value); }
function nullableFiniteNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function nullableBoolean(value: unknown) { return typeof value === "boolean" ? value : null; }
function safeText(value: unknown, maxLength: number) { return typeof value === "string" ? value.slice(0, maxLength) : ""; }
