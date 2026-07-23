import { createAutomationConsoleFixture } from "../features/arbitrageAutomation/model/controlConsoleFixture";
import type {
  AutomationActionReceipt,
  AutomationConsoleClient,
  AutomationConsoleSnapshot,
  AutomationCredentialSummary,
  AutomationPreflight,
  AutomationPreflightMode,
  CredentialDraft,
  SafetyAction,
} from "../features/arbitrageAutomation/model/controlConsoleTypes";
import { AutomationConsoleContractError } from "./arbitrageAutomationConsole";

export function createFakeAutomationConsoleClient(initialSnapshot: AutomationConsoleSnapshot = createAutomationConsoleFixture()): AutomationConsoleClient {
  let snapshot = structuredClone(initialSnapshot);
  return {
    async load(signal) {
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
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
      return fakePreflight(candidate, account.accountId, mode);
    },
    async confirmExecution(challengeId) {
      if (!challengeId) throw new AutomationConsoleContractError(409, "challenge 无效。", null, "challenge_invalid");
      return receipt("Fake contract 已完成确认演练，未发送任何真实订单。");
    },
    async validateCredential(draft) {
      validateDraft(draft);
      const summary = credentialSummary(draft);
      snapshot = { ...snapshot, credentials: snapshot.credentials.map((item) => item.venue === draft.venue ? summary : item) };
      return structuredClone(summary);
    },
    async deleteCredential(accountId) {
      const existing = snapshot.credentials.find((item) => item.accountId === accountId);
      if (!existing) throw new AutomationConsoleContractError(422, "API 账户不存在。");
      if (existing.activeOrderCount || existing.openPositionCount) throw new AutomationConsoleContractError(409, "请先退出仓位。", null, "credential_delete_blocked");
      snapshot = { ...snapshot, globalExecutionEnabled: false, strategyEnabled: false, credentials: snapshot.credentials.map((item) => item.accountId === accountId ? { ...item, accountId: null, status: "unconfigured", maskedKey: null, uidFingerprint: null, enabled: false, defaultExecutionAccount: false } : item) };
      return receipt("Fake contract 已演练解绑。");
    },
    async validateParameters(draft) {
      const invalid = snapshot.parameters.find((parameter) => {
        const value = draft[parameter.id];
        return !Number.isFinite(value) || value < parameter.min || value > parameter.max;
      });
      if (invalid) throw new AutomationConsoleContractError(422, `${invalid.label} 超出允许范围。`, null, "config_out_of_range");
      return receipt("Fake contract 已演练参数校验。");
    },
    async performSafetyAction(action: SafetyAction) { return receipt(`Fake contract 已演练 ${action.type}。`); },
    async closePosition() { return receipt("Fake contract 已演练退出持仓。"); },
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
    note: binance ? "BINANCE 只读验证账户" : `${draft.venue.toUpperCase()} 执行账户`,
    enabled: false,
    phase: binance ? "phase_1_read_only_shadow" : "execution_capable",
    providerWritesEnabled: !binance,
    canAuthorize: true,
    canRunReadOnlyPreflight: true,
    canExecute: !binance,
    phaseLabel: binance ? "只读验证 / Shadow" : "执行已关闭",
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

function fakePreflight(candidate: AutomationConsoleSnapshot["candidates"][number], accountId: string, mode: AutomationPreflightMode): AutomationPreflight {
  const warnings = mode === "manual_entry"
    ? ["当前收益条件未达到自动策略要求", "Funding、基差与持续性需要用户自行判断"]
    : [];
  const confirmations = ["已核对执行账户和两腿", "已理解 Mainnet 风险", "确认 challenge 为一次性短效凭证"];
  if (mode === "manual_entry") confirmations.push("已阅读并接受上述手动决策风险");
  return {
    challengeId: `fake-${candidate.id}`, challengeToken: "fake-token", idempotencyKey: "fake-idempotency", expiresAt: Date.now() + 60_000,
    candidateId: candidate.id, accountId, mode, estimatedCapitalRequiredUsd: 25, totalBudgetUsd: 25,
    exactLegs: [
      { venue: candidate.longLeg.venue, symbol: candidate.longLeg.symbol, side: "buy", quantity: 0.002, referencePrice: 3_360.2, estimatedFeeUsd: null },
      { venue: candidate.shortLeg.venue, symbol: candidate.shortLeg.symbol, side: "sell", quantity: 0.002, referencePrice: 3_361.1, estimatedFeeUsd: null },
    ],
    estimatedTotalFeesUsd: null, estimatedSlippageUsd: null, maximumLossUsd: null, warnings, confirmations,
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
      { id: "product_pair", passed: true, message: "Binance Mainnet 必须同时存在 XAUTUSDT 现货与 USD-M 永续。" },
      { id: "position_mode", passed: true, message: "第一阶段只接受 one-way 持仓模式。" },
    ],
    warnings: ["Binance API Key 未配置固定 IP 白名单；这是高风险配置。"],
    generatedAt: Date.now(),
    message: "市场与账户只读检查通过，但 Binance 第一阶段不签发执行 challenge。",
  };
}

function receipt(message: string): AutomationActionReceipt { return { ok: true, simulated: true, message }; }
