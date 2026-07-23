import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CredentialStoreError,
  RwaAutomationPersistentStore,
  type RwaAutomationStateData,
} from "./RwaAutomationPersistentStore";
import { RwaBybitProviderError } from "./RwaBybitMainnetClient";
import { RwaNeutralHedgeExecutionEngine } from "./RwaNeutralHedgeExecutionEngine";
import { sanitizeRwaAutomationError } from "./RwaNeutralAutomationSecurity";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import type { RwaAutomationMode } from "./RwaAutomationTypes";
import {
  RWA_MAX_STRATEGY_CAPITAL_USD,
  RWA_SMOKE_QUANTITY_XAUT,
  RWA_SMOKE_TOTAL_BUDGET_USD,
  RWA_STRATEGY_ID,
  defaultRwaExecutionConfig,
  type RwaBybitCredentials,
  type RwaBybitPermissions,
  type RwaBybitTradingClient,
  type RwaBybitTradingClientFactory,
  type RwaCredentialStatus,
  type RwaCredentialLifecycle,
  type RwaExecutionConfig,
  type RwaExecutionRecord,
  type RwaPreflightCheck,
  type RwaPreflightChallenge,
  type RwaPreflightReport,
  type RwaProviderOrder,
  type RwaProviderPreflightSnapshot,
} from "./RwaNeutralExecutionTypes";

const challengeTtlMs = 60_000;
const credentialPermissionTtlMs = 10_000;
const credentialRotationAgeMs = 90 * 24 * 60 * 60 * 1_000;
const executionStates = new Set(["accepted", "opening_spot", "opening_perpetual", "compensating"]);

export class RwaNeutralExecutionError extends Error {
  constructor(readonly statusCode: number, readonly category: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export class RwaNeutralExecutionService {
  private lock = Promise.resolve();
  private armedChallengeIds = new Set<string>();
  private credentialLifecycleOverride: RwaCredentialLifecycle | null = null;
  private readonly hedgeEngine: RwaNeutralHedgeExecutionEngine;
  private accessCache: {
    accountId: string;
    verifiedAt: number;
    access: Awaited<ReturnType<RwaBybitTradingClient["validateAccess"]>>;
  } | null = null;

  constructor(
    private readonly store: RwaAutomationPersistentStore,
    private readonly clientFactory: RwaBybitTradingClientFactory,
    private readonly now: () => number = Date.now,
    private readonly serverKillSwitchActive: () => boolean = () => process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "false",
  ) {
    this.hedgeEngine = new RwaNeutralHedgeExecutionEngine(now);
  }

  private get strategyOrderPrefix() {
    return `rwa${this.store.userDomain}`;
  }

  async initialize() {
    this.armedChallengeIds.clear();
    await this.withLock(async () => {
      if (!(await this.store.hasCredentials()) || !this.store.masterKeyConfigured) return;
      const state = await this.store.readState();
      const pending = state.executions.filter((item) => executionStates.has(item.state));
      if (!pending.length) return;
      let client: RwaBybitTradingClient;
      try {
        client = await this.client();
      } catch {
        for (const execution of pending) {
          execution.state = "manual_intervention";
          execution.errorCategory = "credential_key_provider_unavailable";
          execution.message = "凭证无法解密，系统不能自动退出；请在交易所人工检查订单和仓位。";
          execution.updatedAt = this.now();
        }
        state.config.killSwitchActive = true;
        state.config.strategyEnabled = false;
        state.config.globalExecutionEnabled = false;
        await this.store.writeState(state);
        return;
      }
      for (const execution of pending) {
        try {
          await client.cancelStrategyOrders(execution.orderLinkPrefix);
          await this.hedgeEngine.closeAll(client, execution.orderLinkPrefix, `${execution.orderLinkPrefix}r`);
          execution.state = "closed";
          execution.message = "服务重启后已按 provider 权威状态完成安全退出。";
          execution.updatedAt = this.now();
        } catch (error) {
          execution.state = "manual_intervention";
          execution.errorCategory = category(error);
          execution.message = "重启恢复无法自动闭环，需要当前用户在交易所人工处理。";
          execution.updatedAt = this.now();
          state.config.killSwitchActive = true;
        }
      }
      await this.store.writeState(state);
    });
  }

  async getCredentialStatus(): Promise<RwaCredentialStatus> {
    let metadata;
    try {
      metadata = await this.store.readCredentialMetadata();
    } catch (error) {
      return {
        userId: this.store.ownerUserId,
        accountId: null,
        accountFingerprint: null,
        stored: true,
        masterKeyConfigured: this.store.masterKeyConfigured,
        maskedApiKey: null,
        connectionStatus: "invalid",
        lifecycleStatus: "invalid",
        accountMode: null,
        permissions: null,
        lastVerifiedAt: null,
        updatedAt: null,
        message: sanitizeRwaAutomationError(error),
        ipWhitelistConfigured: null,
        warnings: [],
      };
    }
    if (!metadata) {
      return {
        userId: this.store.ownerUserId,
        accountId: null,
        accountFingerprint: null,
        stored: false,
        masterKeyConfigured: this.store.masterKeyConfigured,
        maskedApiKey: null,
        connectionStatus: "not_configured",
        lifecycleStatus: this.credentialLifecycleOverride ?? "unconfigured",
        accountMode: null,
        permissions: null,
        lastVerifiedAt: null,
        updatedAt: null,
        message: this.store.masterKeyError,
        ipWhitelistConfigured: null,
        warnings: [],
      };
    }
    if (metadata.requiresRotation) {
      return {
        userId: this.store.ownerUserId,
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        stored: true,
        masterKeyConfigured: this.store.masterKeyConfigured,
        maskedApiKey: metadata.maskedApiKey,
        connectionStatus: "unavailable",
        lifecycleStatus: "rotation_required",
        accountMode: metadata.accountMode,
        permissions: metadata.permissions,
        lastVerifiedAt: metadata.lastVerifiedAt,
        updatedAt: metadata.updatedAt,
        message: "检测到旧版凭证格式；必须删除旧凭证并重新授权。",
        ipWhitelistConfigured: metadata.permissions.ipRestricted,
        warnings: [],
      };
    }
    if (!this.store.masterKeyConfigured) {
      return {
        userId: this.store.ownerUserId,
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        stored: true,
        masterKeyConfigured: false,
        maskedApiKey: metadata.maskedApiKey,
        connectionStatus: "unavailable",
        lifecycleStatus: "invalid",
        accountMode: metadata.accountMode,
        permissions: metadata.permissions,
        lastVerifiedAt: metadata.lastVerifiedAt,
        updatedAt: metadata.updatedAt,
        message: this.store.masterKeyError,
        ipWhitelistConfigured: metadata.permissions.ipRestricted,
        warnings: metadata.permissions.ipRestricted ? [] : ["API Key 未配置固定 IP 白名单，存在较高安全风险。"],
      };
    }
    try {
      const credentials = await this.store.loadCredentials();
      const access = await this.clientFactory(credentials).validateAccess();
      const valid = permissionsValid(access.permissions) && access.accountId === metadata.accountId;
      const rotationRequired = this.now() - metadata.updatedAt >= credentialRotationAgeMs;
      const lifecycleStatus = !valid ? "invalid" as const : rotationRequired ? "rotation_required" as const : "active" as const;
      this.accessCache = valid ? { accountId: access.accountId, verifiedAt: this.now(), access } : null;
      if (!valid) await this.markCredentialUnsafe("invalid", "Bybit Key 当前权限或账户身份不符合自动执行安全门禁。", metadata);
      else if (rotationRequired) await this.markCredentialUnsafe("rotation_required", "API Key 已达到轮换周期，完成轮换前禁止新增风险。", metadata);
      return {
        userId: this.store.ownerUserId,
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        stored: true,
        masterKeyConfigured: true,
        maskedApiKey: metadata.maskedApiKey,
        connectionStatus: valid ? "verified" as const : "invalid" as const,
        lifecycleStatus,
        accountMode: access.accountMode,
        permissions: access.permissions,
        lastVerifiedAt: this.now(),
        updatedAt: metadata.updatedAt,
        message: lifecycleStatus === "active" ? null : lifecycleStatus === "rotation_required"
          ? "API Key 已达到轮换周期，完成轮换前禁止新增风险。"
          : "Bybit Key 当前权限或账户身份不符合自动执行安全门禁。",
        ipWhitelistConfigured: access.permissions.ipRestricted,
        warnings: access.permissions.ipRestricted ? [] : ["API Key 未配置固定 IP 白名单，存在较高安全风险。"],
      };
    } catch (error) {
      const lifecycleStatus = credentialFailureLifecycle(error);
      this.accessCache = null;
      await this.markCredentialUnsafe(lifecycleStatus, "Bybit 凭证实时校验失败，已禁止新增风险。", metadata);
      return {
        userId: this.store.ownerUserId,
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        stored: true,
        masterKeyConfigured: true,
        maskedApiKey: metadata.maskedApiKey,
        connectionStatus: ["invalid", "expired", "revoked"].includes(lifecycleStatus) ? "invalid" as const : "unavailable" as const,
        lifecycleStatus,
        accountMode: metadata.accountMode,
        permissions: metadata.permissions,
        lastVerifiedAt: metadata.lastVerifiedAt,
        updatedAt: metadata.updatedAt,
        message: error instanceof RwaBybitProviderError ? error.message : "Bybit 凭证实时连接校验暂不可用。",
        ipWhitelistConfigured: metadata.permissions.ipRestricted,
        warnings: metadata.permissions.ipRestricted ? [] : ["API Key 未配置固定 IP 白名单，存在较高安全风险。"],
      };
    }
  }

  async getConfiguredAccountId() {
    return (await this.store.readCredentialMetadata())?.accountId ?? null;
  }

  async putCredentials(input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, ["apiKey", "apiSecret"]);
    const credentials = normalizeCredentials(body);
    if (!this.store.masterKeyConfigured) throw keyProviderUnavailable(this.store.masterKeyError);
    this.credentialLifecycleOverride = "validating";
    try {
      await this.withLock(async () => {
        const previous = await this.store.readCredentialMetadata();
        if (previous?.requiresRotation) {
          throw new RwaNeutralExecutionError(409, "credential_rotation_required", "检测到旧版凭证格式；请先删除旧凭证并重新授权。");
        }
        await this.store.assertKeyProviderHealthy("pending-credential-validation").catch((error) => {
          throw credentialStoreExecutionError(error);
        });
        let access;
        try {
          access = await this.clientFactory(credentials).validateAccess();
        } catch (error) {
          throw providerError(error, "Bybit 凭证校验失败。");
        }
        assertPermissions(access.permissions);
        if (previous && previous.accountId !== access.accountId) {
          throw new RwaNeutralExecutionError(409, "credential_account_mismatch",
            "新凭证属于不同交易账户；请先确认旧账户无订单/仓位并安全删除旧凭证，再绑定新账户。");
        }
        const verifiedAt = this.now();
        await this.store.saveCredentials(credentials, access.permissions, access, verifiedAt).catch((error) => {
          throw credentialStoreExecutionError(error);
        });
        const state = await this.store.readState();
        state.credentialLifecycle = "active";
        state.credentialAlert = null;
        state.config.killSwitchActive = true;
        state.config.strategyEnabled = false;
        state.config.globalExecutionEnabled = false;
        state.challenges = [];
        state.credentialAudit.push({
          userId: this.store.ownerUserId,
          action: previous ? "rotated" : "activated",
          accountId: access.accountId,
          accountFingerprint: access.accountFingerprint,
          maskedApiKey: (await this.store.readCredentialMetadata())?.maskedApiKey ?? null,
          occurredAt: verifiedAt,
        });
        await this.store.writeState(state);
        this.armedChallengeIds.clear();
        this.accessCache = { accountId: access.accountId, verifiedAt, access };
      });
    } finally {
      this.credentialLifecycleOverride = null;
    }
    return this.getCredentialStatus();
  }

  async deleteCredentials(input: unknown = {}) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId"]);
    await this.withLock(async () => {
      const state = await this.store.readState();
      const metadata = await this.store.readCredentialMetadata();
      if (metadata) {
        const accountId = requiredString(body.accountId, "accountId", 100);
        assertAccountId(accountId, metadata.accountId);
        let pnl;
        try {
          const client = await this.client();
          await this.validateActiveAccess(client, metadata.accountId, true, state);
          pnl = await client.readStrategyPnl(this.strategyOrderPrefix, null);
        } catch (error) {
          await this.setCredentialUnsafeState(state, credentialFailureLifecycle(error), metadata,
            "凭证无法验证，系统不能确认或退出交易所仓位；请先在 Bybit 专用子账户人工撤单和平仓，再处理凭证。");
          throw new RwaNeutralExecutionError(409, "credential_delete_manual_intervention",
            "凭证已失效或不可用，无法安全解绑。请先在交易所专用子账户人工撤单和平仓。", { accountId: metadata.accountId });
        }
        const hasExposure = pnl.openOrders.length > 0 || pnl.legs.spot.quantityXaut > 1e-9 || pnl.legs.perpetual.quantityXaut > 1e-9;
        if (hasExposure) {
          throw new RwaNeutralExecutionError(409, "credential_delete_blocked",
            "存在未平仓策略仓位或活动订单，请先执行 close-all 并确认退出后再删除凭证。", { accountId: metadata.accountId });
        }
        state.credentialAudit.push({ userId: this.store.ownerUserId, action: "deleted", accountId: metadata.accountId,
          accountFingerprint: metadata.accountFingerprint, maskedApiKey: metadata.maskedApiKey, occurredAt: this.now() });
      }
      state.config.killSwitchActive = true;
      state.config.strategyEnabled = false;
      state.config.globalExecutionEnabled = false;
      state.challenges = [];
      state.credentialLifecycle = "unconfigured";
      state.credentialAlert = null;
      await this.store.writeState(state);
      await this.store.deleteCredentials();
      this.armedChallengeIds.clear();
      this.accessCache = null;
    });
    return { ok: true, credentials: await this.getCredentialStatus() };
  }

  async getConfig() {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    return publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive());
  }

  async updateConfig(input: unknown) {
    const body = record(input);
    const allowed = [
      "globalExecutionEnabled",
      "strategyEnabled",
      "maxStrategyCapitalUsd",
      "maxEntryBasisBps",
      "maxCombinedSlippageBps",
      "minNetAprPercent",
      "minLiquidationDistancePercent",
      "maxUnhedgedMs",
      "accountId",
    ];
    assertOnlyKeys(body, allowed);
    return this.withLock(async () => {
      const state = await this.store.readState();
      const metadata = await this.store.readCredentialMetadata();
      if (metadata) assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
      if (body.globalExecutionEnabled === true || body.strategyEnabled === true) {
        const activeMetadata = await this.requireCredentialMetadata();
        const client = await this.clientForNewRisk(state, activeMetadata);
        await this.validateActiveAccess(client, activeMetadata.accountId, true, state);
      }
      const next = { ...state.config };
      for (const key of ["globalExecutionEnabled", "strategyEnabled"] as const) {
        if (key in body) {
          if (typeof body[key] !== "boolean") throw invalid(`${key} 必须是布尔值。`);
          next[key] = body[key];
        }
      }
      assignRange(next, body, "maxStrategyCapitalUsd", 25, RWA_MAX_STRATEGY_CAPITAL_USD);
      assignRange(next, body, "maxEntryBasisBps", 0, 80);
      assignRange(next, body, "maxCombinedSlippageBps", 1, 20);
      assignRange(next, body, "minNetAprPercent", 8, 100);
      assignRange(next, body, "minLiquidationDistancePercent", 30, 100);
      assignRange(next, body, "maxUnhedgedMs", 1_000, 10_000);
      state.config = next;
      await this.store.writeState(state);
      return publicConfig(this.store.ownerUserId, next, metadata?.accountId ?? null, this.serverKillSwitchActive());
    });
  }

  async setKillSwitch(active: unknown, accountId?: unknown) {
    if (typeof active !== "boolean") throw invalid("active 必须是布尔值。");
    return this.withLock(async () => {
      const state = await this.store.readState();
      const metadata = await this.store.readCredentialMetadata();
      if (metadata) assertAccountId(requiredString(accountId, "accountId", 100), metadata.accountId);
      if (!active) {
        const activeMetadata = await this.requireCredentialMetadata();
        const client = await this.clientForNewRisk(state, activeMetadata);
        await this.validateActiveAccess(client, activeMetadata.accountId, true, state);
      }
      state.config.killSwitchActive = active;
      if (active) {
        state.challenges = [];
        this.armedChallengeIds.clear();
      }
      await this.store.writeState(state);
      return { active, userId: this.store.ownerUserId, accountId: metadata?.accountId ?? null,
        config: publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive()) };
    });
  }

  async getPrivateAccount() {
    const client = await this.client();
    const metadata = await this.requireCredentialMetadata();
    await this.validateActiveAccess(client, metadata.accountId, false);
    const snapshot = await client.readPreflightSnapshot().catch((error) => { throw providerError(error, "Bybit 私有账户读取失败。"); });
    return {
      network: "bybit_mainnet" as const,
      userId: this.store.ownerUserId,
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      strategyId: RWA_STRATEGY_ID,
      accountMode: snapshot.accountMode,
      permissions: snapshot.permissions,
      balances: {
        availableUsdt: snapshot.availableUsdt,
        strategySpotXaut: snapshot.existingSpotQuantityXaut,
        strategyPerpetualXaut: snapshot.existingPerpetualQuantityXaut,
      },
      instruments: { spot: snapshot.spot, perpetual: snapshot.perpetual },
      fees: snapshot.fees,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async getPnl() {
    const client = await this.client();
    const metadata = await this.requireCredentialMetadata();
    await this.validateActiveAccess(client, metadata.accountId, false);
    const state = await this.store.readState();
    const firstExecutionAt = state.executions.length ? Math.min(...state.executions.map((item) => item.createdAt)) : null;
    const snapshot = await client.readStrategyPnl(this.strategyOrderPrefix, firstExecutionAt)
      .catch((error) => { throw providerError(error, "策略盈亏读取失败。"); });
    snapshot.slippageUsd = calculateExecutionSlippage(state);
    snapshot.netPnlUsd = snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd + snapshot.fundingPnlUsd - snapshot.feesUsd - snapshot.slippageUsd;
    state.pnlSeries.push(snapshot);
    if (state.pnlSeries.length > 1_000) state.pnlSeries.splice(0, state.pnlSeries.length - 1_000);
    await this.store.writeState(state);
    return {
      userId: this.store.ownerUserId,
      accountId: snapshot.accountId,
      current: snapshot,
      series: state.pnlSeries.slice(-200),
      history: state.executions.slice(-100).reverse().map(redactExecution),
    };
  }

  async getAudit() {
    const state = await this.store.readState();
    return {
      items: state.credentialAudit.slice(-200).reverse(),
      alert: state.credentialAlert,
    };
  }

  async preflight(
    opportunity: ArbitrageOpportunity,
    accountId: string,
    mode: RwaAutomationMode = "arbitrage_entry",
  ): Promise<RwaPreflightChallenge> {
    return this.withLock(async () => {
      if (mode !== "arbitrage_entry" && mode !== "manual_entry") {
        throw new RwaNeutralExecutionError(400, "mode_invalid", "mode 仅允许 arbitrage_entry 或 manual_entry。");
      }
      if (
        opportunity.strategyType !== "same_venue_neutral" ||
        opportunity.longLeg.venue !== "bybit" || opportunity.shortLeg.venue !== "bybit" ||
        opportunity.longLeg.kind !== "spot" || opportunity.shortLeg.kind !== "perpetual" ||
        opportunity.longLeg.asset !== "XAUT" || opportunity.shortLeg.asset !== "XAUT" ||
        opportunity.disqualifiers.length > 0 ||
        (mode === "arbitrage_entry" && !opportunity.automationEligible)
      ) {
        throw new RwaNeutralExecutionError(409, "adapter_opportunity_unsupported", "Bybit 首个 adapter 仅支持安全可执行的 XAUT 同所中性机会；自动模式还要求通过自动策略门禁。");
      }
      const state = await this.store.readState();
      this.assertEntrySwitches(state.config);
      const metadata = await this.requireCredentialMetadata();
      const client = await this.clientForNewRisk(state, metadata);
      assertAccountId(accountId, metadata.accountId);
      await this.validateActiveAccess(client, accountId, true, state);
      const snapshot = await client.readPreflightSnapshot().catch((error) => { throw providerError(error, "Bybit 实时 preflight 读取失败。"); });
      assertAccountId(snapshot.accountId, accountId);
      const report = buildPreflight(this.store.ownerUserId, snapshot, state.config, this.now(), opportunity.id, mode);
      if (!report.passed) {
        throw new RwaNeutralExecutionError(409, "preflight_rejected", "实时 preflight 未通过，禁止真实下单。", { report });
      }
      const challengeId = randomUUID();
      const challengeToken = randomBytes(32).toString("base64url");
      state.challenges = state.challenges.filter((item) => item.expiresAt > this.now() && item.consumedAt === null);
      state.challenges.push({
        id: challengeId,
        tokenHash: hash(challengeToken),
        report,
        expiresAt: report.expiresAt,
        consumedAt: null,
      });
      await this.store.writeState(state);
      this.armedChallengeIds.add(challengeId);
      return { challengeId, challengeToken, expiresAt: report.expiresAt, report };
    });
  }

  async execute(input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "challengeId", "challengeToken", "idempotencyKey"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const challengeId = requiredString(body.challengeId, "challengeId", 100);
    const challengeToken = requiredString(body.challengeToken, "challengeToken", 200);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    if (!/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) throw invalid("idempotencyKey 格式无效。");
    const scopedIdempotencyKey = `${this.store.userDomain}:${idempotencyKey}`;
    return this.withLock(async () => {
      const state = await this.store.readState();
      const existing = state.executions.find((item) => item.idempotencyKey === scopedIdempotencyKey);
      if (existing) {
        if (existing.challengeId !== challengeId) throw new RwaNeutralExecutionError(409, "idempotency_conflict", "幂等键已用于其他执行请求。");
        assertAccountId(accountId, existing.accountId);
        return redactExecution(existing);
      }
      this.assertEntrySwitches(state.config);
      const challenge = state.challenges.find((item) => item.id === challengeId);
      if (!challenge || challenge.tokenHash !== hash(challengeToken) || challenge.expiresAt <= this.now() || challenge.consumedAt !== null) {
        throw new RwaNeutralExecutionError(409, "challenge_invalid", "执行 challenge 无效、已过期或已使用。");
      }
      if (!this.armedChallengeIds.has(challengeId)) {
        throw new RwaNeutralExecutionError(409, "restart_disarmed", "服务已重启，原 challenge 不再 armed，请重新 preflight。");
      }
      assertAccountId(accountId, challenge.report.accountId);
      challenge.consumedAt = this.now();
      this.armedChallengeIds.delete(challengeId);
      const execution = newExecution(this.store.ownerUserId, accountId, this.strategyOrderPrefix, scopedIdempotencyKey, challengeId, this.now());
      state.executions.push(execution);
      await this.store.writeState(state);
      let client: RwaBybitTradingClient | null = null;
      try {
        const metadata = await this.requireCredentialMetadata();
        client = await this.clientForNewRisk(state, metadata);
        await this.validateActiveAccess(client, accountId, true, state);
        const realtime = await client.readPreflightSnapshot();
        assertAccountId(realtime.accountId, accountId);
        const challengeMode = challenge.report.mode === "manual_entry" ? "manual_entry" : "arbitrage_entry";
        const report = buildPreflight(
          this.store.ownerUserId,
          realtime,
          state.config,
          this.now(),
          challenge.report.opportunityId,
          challengeMode,
        );
        if (!report.passed) throw new RwaNeutralExecutionError(409, "preflight_changed", "执行前实时条件已变化，禁止下单。");
        await client.setPerpetualLeverage(1);
        await this.hedgeEngine.open({
          client,
          execution,
          snapshot: realtime,
          config: state.config,
          state,
          quantityXaut: report.quantityXaut,
          persist: (currentState, currentExecution) => this.persistExecution(currentState, currentExecution),
        });
      } catch (error) {
        if (execution.state !== "hedged" && execution.state !== "closed") {
          execution.errorCategory = category(error);
          execution.message = sanitizeRwaAutomationError(error);
          try {
            if (!client) throw new Error("credential client unavailable");
            execution.state = "compensating";
            await this.persistExecution(state, execution);
            await client.cancelStrategyOrders(execution.orderLinkPrefix);
            await this.hedgeEngine.closeAll(client, execution.orderLinkPrefix, `${execution.orderLinkPrefix}x`);
            execution.state = "failed";
            execution.message = "对冲未完成，已按 provider 权威状态撤单并退出未对冲敞口。";
          } catch {
            execution.state = "manual_intervention";
            execution.message = "自动建立或退出对冲组合未能闭环，需要当前用户在交易所人工处理。";
            state.config.killSwitchActive = true;
          }
          execution.updatedAt = this.now();
          await this.store.writeState(state);
        }
      }
      return redactExecution(execution);
    });
  }

  async closeAll(input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "idempotencyKey"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    const scopedIdempotencyKey = `${this.store.userDomain}:${idempotencyKey}`;
    return this.withLock(async () => {
      const state = await this.store.readState();
      const existing = state.executions.find((item) => item.idempotencyKey === scopedIdempotencyKey);
      if (existing) return redactExecution(existing);
      const client = await this.client();
      const metadata = await this.requireCredentialMetadata();
      assertAccountId(accountId, metadata.accountId);
      const execution = newExecution(this.store.ownerUserId, accountId, this.strategyOrderPrefix, scopedIdempotencyKey, "close-all", this.now());
      execution.state = "compensating";
      state.executions.push(execution);
      await this.store.writeState(state);
      try {
        await client.cancelStrategyOrders(this.strategyOrderPrefix);
        await this.hedgeEngine.closeAll(client, this.strategyOrderPrefix, execution.orderLinkPrefix);
        execution.state = "closed";
        execution.message = "策略订单已撤销，现货与永续两侧仓位已按权威状态退出并确认。";
      } catch (error) {
        execution.state = "manual_intervention";
        execution.errorCategory = category(error);
        execution.message = "自动 close-all 未能闭环，需要当前用户在交易所人工处理。";
        state.config.killSwitchActive = true;
      }
      execution.updatedAt = this.now();
      await this.store.writeState(state);
      return redactExecution(execution);
    });
  }

  private async client() {
    if (!this.store.masterKeyConfigured) throw keyProviderUnavailable(this.store.masterKeyError);
    let credentials: RwaBybitCredentials;
    try {
      credentials = await this.store.loadCredentials();
    } catch (error) {
      throw credentialStoreExecutionError(error);
    }
    return this.clientFactory(credentials);
  }

  private async clientForNewRisk(
    state: RwaAutomationStateData,
    metadata: NonNullable<Awaited<ReturnType<RwaAutomationPersistentStore["readCredentialMetadata"]>>>,
  ) {
    try {
      return await this.client();
    } catch (error) {
      await this.setCredentialUnsafeState(
        state,
        credentialFailureLifecycle(error),
        metadata,
        "凭证密钥 provider 不可用或凭证无法解密；已激活急停。请在交易所人工检查订单和仓位。",
      );
      throw error;
    }
  }

  private async requireCredentialMetadata() {
    const metadata = await this.store.readCredentialMetadata();
    if (!metadata) throw new RwaNeutralExecutionError(409, "credentials_unconfigured", "该 venue 尚未配置执行账户凭证。");
    if (metadata.requiresRotation) {
      throw new RwaNeutralExecutionError(409, "credential_rotation_required", "检测到旧版凭证格式；请删除旧凭证并重新授权。");
    }
    return metadata;
  }

  private async validateActiveAccess(
    client: RwaBybitTradingClient,
    accountId: string,
    force: boolean,
    lockedState?: RwaAutomationStateData,
  ) {
    const metadata = await this.requireCredentialMetadata();
    assertAccountId(accountId, metadata.accountId);
    if (this.now() - metadata.updatedAt >= credentialRotationAgeMs) {
      if (lockedState) await this.setCredentialUnsafeState(lockedState, "rotation_required", metadata, "API Key 已达到轮换周期，完成轮换前禁止新增风险。");
      else await this.markCredentialUnsafe("rotation_required", "API Key 已达到轮换周期，完成轮换前禁止新增风险。", metadata);
      throw new RwaNeutralExecutionError(409, "credential_rotation_required", "API Key 已达到轮换周期，请先完成安全轮换。");
    }
    if (!force && this.accessCache && this.accessCache.accountId === accountId
      && this.now() - this.accessCache.verifiedAt <= credentialPermissionTtlMs) {
      return this.accessCache.access;
    }
    try {
      const access = await client.validateAccess();
      assertPermissions(access.permissions);
      assertAccountId(access.accountId, accountId);
      this.accessCache = { accountId, verifiedAt: this.now(), access };
      return access;
    } catch (error) {
      this.accessCache = null;
      const lifecycle = credentialFailureLifecycle(error);
      if (lockedState) await this.setCredentialUnsafeState(lockedState, lifecycle, metadata, "执行账户权限或连接校验失败，已禁止新增风险。");
      else await this.markCredentialUnsafe(lifecycle, "执行账户权限或连接校验失败，已禁止新增风险。", metadata);
      throw providerError(error, "执行账户权限或连接校验失败。");
    }
  }

  private async markCredentialUnsafe(
    lifecycle: Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active">,
    message: string,
    metadata: Awaited<ReturnType<RwaAutomationPersistentStore["readCredentialMetadata"]>> & {},
  ) {
    await this.withLock(async () => {
      const state = await this.store.readState();
      await this.setCredentialUnsafeState(state, lifecycle, metadata, message);
    });
  }

  private async setCredentialUnsafeState(
    state: RwaAutomationStateData,
    lifecycle: Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active">,
    metadata: NonNullable<Awaited<ReturnType<RwaAutomationPersistentStore["readCredentialMetadata"]>>>,
    message: string,
  ) {
    state.credentialLifecycle = lifecycle;
    state.credentialAlert = message;
    state.config.killSwitchActive = true;
    state.config.strategyEnabled = false;
    state.config.globalExecutionEnabled = false;
    state.challenges = [];
    state.credentialAudit.push({ userId: this.store.ownerUserId, action: "invalidated", accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint, maskedApiKey: metadata.maskedApiKey, occurredAt: this.now() });
    if (state.credentialAudit.length > 200) state.credentialAudit.splice(0, state.credentialAudit.length - 200);
    await this.store.writeState(state);
    this.armedChallengeIds.clear();
  }

  private async persistExecution(state: RwaAutomationStateData, execution: RwaExecutionRecord) {
    execution.updatedAt = this.now();
    await this.store.writeState(state);
  }

  private assertEntrySwitches(config: RwaExecutionConfig) {
    if (this.serverKillSwitchActive()) {
      throw new RwaNeutralExecutionError(409, "server_kill_switch_active", "服务端全局急停已激活，禁止新增风险动作。");
    }
    assertEntrySwitches(config);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function buildPreflight(
  userId: string,
  snapshot: RwaProviderPreflightSnapshot,
  config: RwaExecutionConfig,
  now: number,
  opportunityId: string,
  mode: RwaAutomationMode,
): RwaPreflightReport {
  const spotNotional = RWA_SMOKE_QUANTITY_XAUT * snapshot.spot.ask;
  const perpetualNotional = RWA_SMOKE_QUANTITY_XAUT * snapshot.perpetual.bid;
  const feesUsd = (spotNotional * snapshot.fees.spotTakerBps + perpetualNotional * snapshot.fees.perpetualTakerBps) / 10_000;
  const slippageReserveUsd = (spotNotional + perpetualNotional) * config.maxCombinedSlippageBps / 10_000;
  const capitalRequired = spotNotional + perpetualNotional + feesUsd + slippageReserveUsd;
  const entryBasisBps = snapshot.spot.ask > 0 ? (snapshot.perpetual.bid - snapshot.spot.ask) / snapshot.spot.ask * 10_000 : Number.POSITIVE_INFINITY;
  const fundingPeriodsPerYear = 24 / snapshot.perpetual.fundingIntervalHours * 365;
  const fundingAprPercent = snapshot.perpetual.fundingRate * fundingPeriodsPerYear * 100;
  const costAprPercent = (snapshot.fees.spotTakerBps + snapshot.fees.perpetualTakerBps + config.maxCombinedSlippageBps) / 100;
  const estimatedNetAprPercent = fundingAprPercent - costAprPercent;
  const checks: RwaPreflightCheck[] = [
    check("permissions", permissionsValid(snapshot.permissions), true, "必须具备 read + spot trade + contract trade，且禁止提现、启用 UTA 并使用专用子账户。"),
    check("account_mode", snapshot.accountMode === "uta", "uta", "仅允许 UTA 专用子账户。"),
    check("spot_trading", snapshot.spot.status === "Trading", "Trading", "XAUTUSDT 现货必须处于 Trading。"),
    check("perpetual_trading", snapshot.perpetual.status === "Trading", "Trading", "XAUTUSDT 永续必须处于 Trading。"),
    check("fixed_quantity", stepAligned(RWA_SMOKE_QUANTITY_XAUT, snapshot.spot.qtyStep) && stepAligned(RWA_SMOKE_QUANTITY_XAUT, snapshot.perpetual.qtyStep), true, "烟测数量固定为 0.002 XAUT，必须同时匹配现货侧与永续侧步长。"),
    check("price_ticks", snapshot.spot.priceTick > 0 && snapshot.perpetual.priceTick > 0, true, "现货侧与永续侧实时价格步长必须可核对。"),
    check("spot_minimum", RWA_SMOKE_QUANTITY_XAUT >= snapshot.spot.minOrderQty && spotNotional >= snapshot.spot.minNotionalUsd, true, "现货数量和名义必须达到实时最小值。"),
    check("perpetual_minimum", RWA_SMOKE_QUANTITY_XAUT >= snapshot.perpetual.minOrderQty && perpetualNotional >= snapshot.perpetual.minNotionalUsd, true, "永续数量和名义必须达到实时最小值。"),
    check("no_existing_spot", snapshot.existingSpotQuantityXaut <= 1e-9, 0, "烟测前专用子账户不得已有 XAUT 现货。"),
    check("no_existing_perpetual", snapshot.existingPerpetualQuantityXaut <= 1e-9, 0, "烟测前专用子账户不得已有 XAUT 永续仓位。"),
    check("total_budget", capitalRequired <= RWA_SMOKE_TOTAL_BUDGET_USD, RWA_SMOKE_TOTAL_BUDGET_USD, "现货与永续对冲组合的 1x 名义、手续费和滑点准备金必须在 25 USDT 总预算内。"),
    check("strategy_cap", capitalRequired <= config.maxStrategyCapitalUsd && config.maxStrategyCapitalUsd <= RWA_MAX_STRATEGY_CAPITAL_USD, config.maxStrategyCapitalUsd, "V1 策略资本不得超过 300 USDT。"),
    check("balance", snapshot.availableUsdt >= capitalRequired, capitalRequired, "可用 USDT 必须覆盖烟测总预算需求。"),
    check("liquidation", snapshot.perpetual.liquidationDistancePercent === null || snapshot.perpetual.liquidationDistancePercent >= config.minLiquidationDistancePercent, config.minLiquidationDistancePercent, "现有仓位强平距离不得低于门限；新仓固定先设 1x。"),
    check("freshness", now - snapshot.fetchedAt <= 5_000, 5_000, "preflight 私有与市场数据必须在 5 秒内。"),
  ];
  if (mode === "arbitrage_entry") {
    checks.splice(-2, 0,
      check("funding_direction", snapshot.perpetual.fundingRate > 0, "> 0", "永续空头必须收取 Funding；负 Funding 必须拒绝。"),
      check("entry_basis", Math.abs(entryBasisBps) <= config.maxEntryBasisBps, config.maxEntryBasisBps, "入场基差绝对值不得超过门限。"),
      check("net_apr", estimatedNetAprPercent >= config.minNetAprPercent, config.minNetAprPercent, "扣除手续费与滑点后的估算净 APR 必须达标。"),
    );
  }
  const warnings = snapshot.permissions.ipRestricted
    ? []
    : ["API Key 未配置固定 IP 白名单；这是高风险配置，但不作为本轮硬阻断。"];
  if (mode === "manual_entry") {
    if (snapshot.perpetual.fundingRate <= 0) warnings.push("当前永续侧未处于收取 Funding 状态，请确认后自行决策。");
    if (Math.abs(entryBasisBps) > config.maxEntryBasisBps) warnings.push("当前入场基差超过自动策略门限，请确认后自行决策。");
    if (estimatedNetAprPercent < config.minNetAprPercent) warnings.push("当前估算净 APR 低于自动策略门限，请确认后自行决策。");
  }
  return {
    userId,
    accountId: snapshot.accountId,
    accountFingerprint: snapshot.accountFingerprint,
    strategyId: RWA_STRATEGY_ID,
    network: "bybit_mainnet",
    action: mode,
    mode,
    opportunityId,
    venue: "bybit",
    quantityXaut: RWA_SMOKE_QUANTITY_XAUT,
    totalBudgetUsd: RWA_SMOKE_TOTAL_BUDGET_USD,
    estimatedSpotNotionalUsd: spotNotional,
    estimatedPerpetualNotionalUsd: perpetualNotional,
    estimatedCapitalRequiredUsd: capitalRequired,
    referenceSpotAsk: snapshot.spot.ask,
    referencePerpetualBid: snapshot.perpetual.bid,
    entryBasisBps,
    fundingRate: snapshot.perpetual.fundingRate,
    estimatedNetAprPercent,
    checks,
    warnings,
    passed: checks.every((item) => item.passed),
    generatedAt: now,
    expiresAt: now + challengeTtlMs,
  };
}

function newExecution(userId: string, accountId: string, userOrderPrefix: string, idempotencyKey: string, challengeId: string, now: number): RwaExecutionRecord {
  const executionId = randomUUID();
  return {
    userId,
    accountId,
    executionId,
    idempotencyKey,
    challengeId,
    state: "accepted",
    orderLinkPrefix: `${userOrderPrefix}${executionId.replace(/-/g, "").slice(0, 10)}`,
    spotOrder: null,
    perpetualOrders: [],
    compensationOrders: [],
    hedgedQuantityXaut: 0,
    unhedgedDurationMs: null,
    errorCategory: null,
    message: "执行请求已接受。",
    createdAt: now,
    updatedAt: now,
  };
}

function publicConfig(userId: string, config: RwaExecutionConfig, accountId: string | null, serverGlobalKillSwitchActive: boolean) {
  return {
    ...config,
    userId,
    accountId,
    defaultAccountId: accountId,
    strategyId: RWA_STRATEGY_ID,
    network: "bybit_mainnet" as const,
    automaticExecutionEnabled: false,
    armed: false,
    smokeQuantityXaut: RWA_SMOKE_QUANTITY_XAUT,
    smokeTotalBudgetUsd: RWA_SMOKE_TOTAL_BUDGET_USD,
    hardCapitalLimitUsd: RWA_MAX_STRATEGY_CAPITAL_USD,
    serverGlobalKillSwitchActive,
  };
}

function redactExecution(execution: RwaExecutionRecord) {
  return { ...execution };
}

function assertEntrySwitches(config: RwaExecutionConfig) {
  if (!config.globalExecutionEnabled) throw new RwaNeutralExecutionError(409, "global_execution_disabled", "全局真实执行开关未启用。");
  if (!config.strategyEnabled) throw new RwaNeutralExecutionError(409, "strategy_disabled", "XAUT 中性策略开关未启用。");
  if (config.killSwitchActive) throw new RwaNeutralExecutionError(409, "kill_switch_active", "Kill switch 已激活，禁止新增风险动作。");
}

function assertPermissions(permissions: RwaBybitPermissions) {
  if (!permissionsValid(permissions)) {
    throw new RwaNeutralExecutionError(
      409,
      "permission_rejected",
      "Bybit Key 必须具备读取、现货交易和合约交易权限，禁止提现，并启用 UTA 和专用子账户。",
    );
  }
}

function permissionsValid(value: RwaBybitPermissions) {
  return value.read && value.spotTrade && value.contractTrade && !value.withdraw && value.uta && value.ownerSubaccount;
}

function assertAccountId(actual: string, expected: string) {
  if (actual !== expected) {
    throw new RwaNeutralExecutionError(409, "account_mismatch", "accountId 与当前 venue 执行账户不匹配，已拒绝操作。");
  }
}

function credentialFailureLifecycle(error: unknown): Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active"> {
  if (error instanceof CredentialStoreError && error.category === "credential_rotation_required") return "rotation_required";
  if (error instanceof RwaNeutralExecutionError && error.category === "credential_rotation_required") return "rotation_required";
  if (error instanceof RwaBybitProviderError) {
    if (error.category === "provider_credential_expired") return "expired";
    if (error.category === "provider_credential_revoked" || error.category === "provider_permission_error") return "revoked";
  }
  return "invalid";
}

function keyProviderUnavailable(message: string | null) {
  return new RwaNeutralExecutionError(
    503,
    "credential_key_provider_unavailable",
    message ?? "凭证密钥 provider 不可用；已拒绝凭证操作。",
  );
}

function credentialStoreExecutionError(error: unknown) {
  if (error instanceof RwaNeutralExecutionError) return error;
  if (error instanceof CredentialStoreError) {
    const statusCode = error.category === "credential_rotation_required" ? 409 : 503;
    return new RwaNeutralExecutionError(statusCode, error.category, error.message);
  }
  return new RwaNeutralExecutionError(503, "credentials_unavailable", sanitizeRwaAutomationError(error));
}

function providerError(error: unknown, fallback: string) {
  if (error instanceof RwaNeutralExecutionError) return error;
  if (error instanceof RwaBybitProviderError) return new RwaNeutralExecutionError(502, error.category, error.message);
  return new RwaNeutralExecutionError(502, category(error), fallback);
}

function category(error: unknown) {
  if (error instanceof RwaNeutralExecutionError || error instanceof RwaBybitProviderError) return error.category;
  return "execution_failed";
}

function normalizeCredentials(body: Record<string, unknown>): RwaBybitCredentials {
  const apiKey = requiredString(body.apiKey, "apiKey", 128);
  const apiSecret = requiredString(body.apiSecret, "apiSecret", 256);
  if (apiKey.length < 8 || apiSecret.length < 16) throw invalid("Bybit API Key 或 Secret 格式无效。");
  return { apiKey, apiSecret };
}

function assignRange<K extends keyof RwaExecutionConfig>(target: RwaExecutionConfig, body: Record<string, unknown>, key: K, min: number, max: number) {
  if (!(key in body)) return;
  const value = Number(body[key]);
  if (!Number.isFinite(value) || value < min || value > max) throw invalid(`${String(key)} 必须在 ${min} 到 ${max} 之间。`);
  (target[key] as number) = value;
}

function check(name: string, actual: boolean, limit: number | string | boolean, message: string): RwaPreflightCheck {
  return { name, passed: actual, value: actual, limit, message };
}

function stepAligned(quantity: number, step: number) {
  if (!(step > 0)) return false;
  return Math.abs(quantity / step - Math.round(quantity / step)) < 1e-8;
}

function floorStep(quantity: number, step: number) {
  if (!(step > 0)) return 0;
  return Math.floor((quantity + 1e-12) / step) * step;
}

function ceilStep(quantity: number, step: number) {
  if (!(step > 0)) return 0;
  return Math.ceil((quantity - 1e-12) / step) * step;
}

function calculateExecutionSlippage(state: RwaAutomationStateData) {
  let slippage = 0;
  for (const execution of state.executions) {
    const challenge = state.challenges.find((item) => item.id === execution.challengeId);
    if (!challenge) continue;
    const report = challenge.report;
    if (execution.spotOrder?.averagePrice) {
      slippage += Math.max(0, execution.spotOrder.averagePrice - report.referenceSpotAsk) * execution.spotOrder.filledQuantityXaut;
    }
    for (const order of execution.perpetualOrders) {
      if (order.averagePrice) slippage += Math.max(0, report.referencePerpetualBid - order.averagePrice) * order.filledQuantityXaut;
    }
  }
  return slippage;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw invalid(`${field} 格式无效。`);
  return value.trim();
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`请求包含不支持的字段：${unknown.join("、")}。`);
}

function invalid(message: string) {
  return new RwaNeutralExecutionError(400, "invalid_request", message);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
