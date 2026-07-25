import { createAutomationConsoleFixture } from "../features/arbitrageAutomation/model/controlConsoleFixture";
import type {
  AutomationActionReceipt,
  AutomationConsoleClient,
  AutomationConsoleSnapshot,
  AutomationCredentialSummary,
  AutomationExecutionResult,
  AutomationPreflight,
  AutomationPreflightMode,
  CredentialDraft,
  SafetyAction,
} from "../features/arbitrageAutomation/model/controlConsoleTypes";
import { AutomationConsoleContractError } from "./arbitrageAutomationConsole";

export function createFakeAutomationConsoleClient(initialSnapshot: AutomationConsoleSnapshot = createAutomationConsoleFixture()): AutomationConsoleClient {
  let snapshot = structuredClone(initialSnapshot);
  const challenges = new Map<string, AutomationPreflight>();
  return {
    async load(signal) {
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      challenges.clear();
      return structuredClone({ ...snapshot, generatedAt: Date.now() });
    },
    async requestPreflight(candidateId, mode) {
      const candidate = snapshot.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new AutomationConsoleContractError(422, "候选机会不存在或已失效。", null, "opportunity_not_found");
      if (!candidate.adapterImplemented) throw new AutomationConsoleContractError(501, "该交易所 adapter 暂未接入。", null, "venue_not_implemented");
      if (!candidate.safetyEligible) throw new AutomationConsoleContractError(409, "候选机会未通过安全门槛。", null, "safety_opportunity_blocked");
      if (mode === "arbitrage_entry" && !candidate.automationEligible) throw new AutomationConsoleContractError(409, "候选机会未达到自动策略条件。", null, "automation_opportunity_blocked");
      const account = snapshot.credentials.find((item) => item.venue === candidate.venue && item.status === "connected" && item.accountId);
      if (!account?.accountId) throw new AutomationConsoleContractError(409, "没有可用执行账户。", null, "credentials_unconfigured");
      if (!candidate.canRunReadOnlyPreflight) throw new AutomationConsoleContractError(501, "当前阶段不开放预检。", null, "venue_capability_unavailable");
      if (!candidate.canExecute) return fakeShadowCheck(candidate, account.accountId, mode);
      if (!candidate.executionReady) throw new AutomationConsoleContractError(409, "执行开关或急停状态尚未就绪。", null, "global_execution_disabled");
      const preflight = fakePreflight(candidate, { ...account, accountId: account.accountId }, mode);
      challenges.set(preflight.challengeId, preflight);
      return preflight;
    },
    async confirmExecution(challengeId, _stepUpToken) {
      const challenge = challenges.get(challengeId);
      if (!challenge || challenge.expiresAt <= Date.now()) throw new AutomationConsoleContractError(409, "执行确认已失效。", null, "challenge_invalid");
      challenges.delete(challengeId);
      const execution = fakeExecution(challenge.venue, challenge.accountId, "hedged");
      return receipt("Fake contract 已完成执行状态演练，未发送任何真实订单。", execution);
    },
    async validateCredential(draft, _stepUpToken) {
      validateDraft(draft);
      const summary = credentialSummary(draft);
      snapshot = { ...snapshot, credentials: snapshot.credentials.map((item) => item.venue === draft.venue ? summary : item) };
      return structuredClone(summary);
    },
    async deleteCredential(accountId, _stepUpToken) {
      const existing = snapshot.credentials.find((item) => item.accountId === accountId);
      if (!existing) throw new AutomationConsoleContractError(422, "API 账户不存在。");
      if (existing.activeOrderCount || existing.openPositionCount) throw new AutomationConsoleContractError(409, "请先退出仓位。", null, "credential_delete_blocked");
      snapshot = { ...snapshot, globalExecutionEnabled: false, strategyEnabled: false, credentials: snapshot.credentials.map((item) => item.accountId === accountId ? { ...item, accountId: null, status: "unconfigured", maskedKey: null, uidFingerprint: null, enabled: false, defaultExecutionAccount: false } : item) };
      return receipt("Fake contract 已演练解绑。");
    },
    async validateParameters(venue, draft) {
      const invalid = snapshot.parameters.find((parameter) => parameter.venue === venue && (() => {
        const value = draft[parameter.id];
        return !Number.isFinite(value) || value < parameter.min || value > parameter.max;
      })());
      if (invalid) throw new AutomationConsoleContractError(422, `${invalid.label} 超出允许范围。`, null, "config_out_of_range");
      return receipt("Fake contract 已演练参数校验。");
    },
    async performSafetyAction(action: SafetyAction, _stepUpToken) {
      if (action.type === "close_all") return receipt("Fake contract 已演练退出对冲组合。", fakeExecution(action.venue, `${action.venue}-primary`, "closed"));
      snapshot = {
        ...snapshot,
        venueControls: snapshot.venueControls.map((control) => {
          if (control.venue !== action.venue) return control;
          if (action.type === "toggle_global_execution") return { ...control, globalExecutionEnabled: action.enabled };
          if (action.type === "toggle_strategy") return { ...control, strategyEnabled: action.enabled };
          return { ...control, killSwitchActive: action.active };
        }),
      };
      challenges.clear();
      return receipt(`Fake contract 已演练 ${action.type}。`);
    },
    async closePosition(_positionId, _stepUpToken, _idempotencyKey) { return receipt("Fake contract 已演练退出持仓。"); },
    async reconcilePosition(input, signal) {
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      return snapshot.positionGroups.find((group) => (
        group.venue === input.venue
        && group.accountId === input.accountId
        && group.reconciliationId === input.reconciliationId
      ))?.reconciliation ?? null;
    },
    async finalizeReconciliation(input, _stepUpToken) {
      return fakeExecution(input.venue, input.accountId, "closed");
    },
  };
}

function validateDraft(draft: CredentialDraft) {
  if (draft.apiKey.trim().length < 8 || draft.secret.trim().length < 8) throw new AutomationConsoleContractError(422, "凭证格式不完整。");
}

function credentialSummary(draft: CredentialDraft): AutomationCredentialSummary {
  const suffix = draft.apiKey.trim().slice(-4).toUpperCase();
  const binance = draft.venue === "binance";
  return {
    accountId: draft.accountId ?? `${draft.venue}-fixture`, venue: draft.venue, implemented: true,
    note: `${draft.venue.toUpperCase()} 执行账户`,
    enabled: false,
    phase: "execution_capable",
    providerWritesEnabled: true,
    canAuthorize: true,
    canRunReadOnlyPreflight: true,
    canExecute: true,
    phaseLabel: "执行已关闭",
    status: "connected",
    maskedKey: `${draft.venue.slice(0, 3).toUpperCase()}••••${suffix}`, uidFingerprint: `${draft.venue.toUpperCase()}-UID-${suffix}`,
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      spotAccount: binance ? true : null,
      futuresAccount: binance ? true : null,
      positionModeSupported: binance ? true : null,
    },
    productAvailability: binance ? { available: true, status: "available", spotSymbol: "XAUTUSDT", perpetualSymbol: "XAUTUSDT", checkedAt: Date.now(), message: null } : null,
    ipWhitelist: [], ipWhitelistConfigured: false, warnings: ["未绑定 IP 白名单。"], accountMode: binance ? "single_asset_one_way" : "uta", lastVerifiedAt: Date.now(),
    defaultExecutionAccount: true, assetStatisticsEnabled: true, activeOrderCount: 0, openPositionCount: 0,
    verificationChecks: checks(false),
    accountSnapshot: null,
  };
}

function checks(ip: boolean): AutomationCredentialSummary["verificationChecks"] {
  return [
    { id: "ip_bound", label: "生产出口 IP 已绑定", status: ip ? "passed" : "warning", message: ip ? "已配置。" : "未配置，风险较高但不阻断。" },
    { id: "read", label: "读取权限", status: "passed", message: "可用。" },
    { id: "spot_trade", label: "现货交易权限", status: "passed", message: "可用。" },
    { id: "contract_trade", label: "合约交易权限", status: "passed", message: "可用。" },
    { id: "withdraw_disabled", label: "提现权限关闭", status: "passed", message: "withdraw=false。" },
    { id: "account_mode", label: "账户模式满足要求", status: "passed", message: "UTA。" },
  ];
}

function fakePreflight(candidate: AutomationConsoleSnapshot["candidates"][number], account: AutomationCredentialSummary & { accountId: string }, mode: AutomationPreflightMode): AutomationPreflight {
  const warnings = mode === "manual_entry"
    ? ["当前收益条件未达到自动策略要求", "Funding、基差与持续性需要用户自行判断"]
    : [];
  const confirmations = ["已核对执行账户及现货侧与永续侧", "已理解 Mainnet 风险", "确认执行凭证为一次性短效凭证"];
  if (mode === "manual_entry") confirmations.push("已阅读并接受上述手动决策风险");
  return {
    challengeId: `fake-${candidate.id}`, challengeToken: "fake-token", idempotencyKey: "fake-idempotency", expiresAt: Date.now() + 60_000,
    candidateId: candidate.id, accountId: account.accountId, venue: candidate.venue, mode, estimatedCapitalRequiredUsd: 25, totalBudgetUsd: 25,
    exactLegs: [
      { venue: candidate.longLeg.venue, symbol: candidate.longLeg.symbol, side: "buy", quantity: 0.002, referencePrice: 3_360.2, estimatedFeeUsd: null },
      { venue: candidate.shortLeg.venue, symbol: candidate.shortLeg.symbol, side: "sell", quantity: 0.002, referencePrice: 3_361.1, estimatedFeeUsd: null },
    ],
    estimatedTotalFeesUsd: 0.04, estimatedSlippageUsd: 0.03, maximumLossUsd: 25, warnings, confirmations,
    checks: [
      { id: "permissions", passed: true, value: true, limit: true, message: "读取、现货与合约交易权限可用，提现权限关闭。" },
      { id: "depth", passed: true, value: true, limit: true, message: "现货侧与永续侧盘口深度覆盖计划名义。" },
    ],
    accountSnapshot: account.accountSnapshot,
    entryBasisBps: 2.68,
    fundingRate: 0.0001,
    estimatedNetAprPercent: 9.2,
  };
}

function fakeShadowCheck(candidate: AutomationConsoleSnapshot["candidates"][number], accountId: string, mode: AutomationPreflightMode) {
  return {
    kind: "shadow_check" as const,
    venue: "binance" as const,
    candidateId: candidate.id,
    accountId,
    mode,
    phase: "phase_1_read_only_shadow" as const,
    providerWritesEnabled: false as const,
    productAvailability: { available: true, status: "available" as const, spotSymbol: "XAUTUSDT", perpetualSymbol: "XAUTUSDT", checkedAt: Date.now(), message: null },
    quantityXaut: 0.002,
    totalBudgetUsd: 25,
    estimatedCapitalRequiredUsd: 13.45,
    estimatedSpotNotionalUsd: 6.72,
    estimatedPerpetualNotionalUsd: 6.72,
    referenceSpotAsk: 3_360,
    referencePerpetualBid: 3_361,
    entryBasisBps: 2.98,
    fundingRate: 0.0001,
    estimatedNetAprPercent: 8.6,
    marketChecksPassed: true,
    checks: [
      { id: "product_pair", passed: true, message: "Binance Mainnet 必须同时存在 XAUTUSDT 现货侧与 USD-M 永续侧。" },
      { id: "position_mode", passed: true, message: "当前连接只接受 one-way 持仓模式。" },
    ],
    warnings: ["Binance API Key 未配置固定 IP 白名单；这是高风险配置。"],
    generatedAt: Date.now(),
    message: "市场与账户只读检查通过。",
  };
}

function fakeExecution(venue: AutomationExecutionResult["venue"], accountId: string, state: AutomationExecutionResult["state"]): AutomationExecutionResult {
  const now = Date.now();
  return {
    venue,
    accountId,
    executionId: `fake-execution-${state}`,
    state,
    message: state === "closed" ? "现货与永续对冲组合已退出。" : "现货侧与永续侧已完成对冲。",
    errorCategory: null,
    hedgedQuantityXaut: state === "closed" ? 0 : 0.002,
    unhedgedDurationMs: 1_250,
    spotOrder: { orderId: "fake-spot", orderLinkId: "fake-spot-link", status: "Filled", requestedQuantityXaut: 0.002, filledQuantityXaut: 0.002, averagePrice: 3360.2, feeUsd: 0.01, updatedAt: now },
    perpetualOrders: [{ orderId: "fake-perpetual", orderLinkId: "fake-perpetual-link", status: "Filled", requestedQuantityXaut: 0.002, filledQuantityXaut: 0.002, averagePrice: 3361.1, feeUsd: 0.01, updatedAt: now }],
    compensationOrders: [],
    reconciliation: null,
    createdAt: now - 1_250,
    updatedAt: now,
  };
}

function receipt(message: string, execution?: AutomationExecutionResult): AutomationActionReceipt { return { ok: true, simulated: true, message, execution }; }
