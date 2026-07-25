import { createHash, randomBytes } from "node:crypto";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import {
  CredentialStoreError,
  RwaAutomationPersistentStore,
  type RwaCredentialMutationSnapshot,
  type RwaAutomationStateData,
} from "./RwaAutomationPersistentStore";
import {
  RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS,
  RWA_BINANCE_STRATEGY_ID,
  RWA_BINANCE_TOTAL_BUDGET_USD,
  type RwaBinanceClient,
  type RwaBinanceClientFactory,
  type RwaBinanceCredentials,
  type RwaBinancePermissions,
  type RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import { RwaBinanceProviderError } from "./RwaBinanceMainnetClient";
import {
  calculateNeutralExecutionSlippage,
  createNeutralExecutionRecord,
  RwaNeutralHedgeExecutionEngine,
} from "./RwaNeutralHedgeExecutionEngine";
import { sanitizeRwaAutomationError } from "./RwaNeutralAutomationSecurity";
import type { RwaAutomationMode } from "./RwaAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";
import {
  RWA_MAX_STRATEGY_CAPITAL_USD,
  defaultRwaExecutionConfig,
  type RwaCredentialLifecycle,
  type RwaExecutionConfig,
  type RwaExecutionRecord,
  type RwaPreflightReport,
} from "./RwaNeutralExecutionTypes";

const rotationAgeMs = 90 * 24 * 60 * 60 * 1_000;
const challengeTtlMs = 60_000;
const executionStates = new Set(["accepted", "opening_spot", "opening_perpetual", "compensating"]);
type BinanceStore = RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>;
type BinanceCredentialMetadata = NonNullable<Awaited<ReturnType<BinanceStore["readCredentialMetadata"]>>>;

export class RwaBinanceAutomationService {
  private lock = Promise.resolve();
  private readonly armedChallengeIds = new Set<string>();
  private credentialLifecycleOverride: RwaCredentialLifecycle | null = null;
  private readonly publicClient: RwaBinanceClient;
  private readonly hedgeEngine: RwaNeutralHedgeExecutionEngine;

  constructor(
    private readonly store: RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>,
    private readonly clientFactory: RwaBinanceClientFactory,
    private readonly now: () => number = Date.now,
    private readonly serverKillSwitchActive: () => boolean = () => process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "false",
    publicClient?: RwaBinanceClient,
    private readonly assertExecutionLeaseHeld: () => void = () => {},
  ) {
    this.store.setClock(now);
    this.publicClient = publicClient ?? clientFactory({ apiKey: "", apiSecret: "" });
    this.hedgeEngine = new RwaNeutralHedgeExecutionEngine(now, assertExecutionLeaseHeld);
  }

  private get strategyOrderPrefix() {
    return `rwa${this.store.userDomain}`;
  }

  async initialize() {
    this.assertExecutionLeaseHeld();
    this.armedChallengeIds.clear();
    await this.withLock(async () => {
      if (!(await this.store.hasCredentials()) || !this.store.masterKeyConfigured) return;
      const state = await this.store.readState();
      const pending = state.executions.filter((item) => executionStates.has(item.state));
      if (!pending.length) return;
      let client: RwaBinanceClient;
      try {
        client = await this.client();
      } catch {
        for (const execution of pending) {
          execution.state = "manual_intervention";
          execution.errorCategory = "credential_key_provider_unavailable";
          execution.message = "凭证无法解密，系统不能自动退出；请在 Binance 人工检查订单和仓位。";
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
          this.assertExecutionLeaseHeld();
          await client.cancelStrategyOrders(execution.orderLinkPrefix);
          await this.hedgeEngine.closeAll(client, execution.orderLinkPrefix, `${execution.orderLinkPrefix}r`);
          execution.state = "closed";
          execution.message = "服务重启后已按 Binance 权威状态退出对冲组合。";
        } catch (error) {
          execution.state = "manual_intervention";
          execution.errorCategory = errorCategory(error);
          execution.message = "重启恢复无法自动退出对冲组合，需要当前用户在 Binance 人工处理。";
          state.config.killSwitchActive = true;
        }
        execution.updatedAt = this.now();
      }
      await this.store.writeState(state);
    });
  }

  async getProductAvailability() {
    try {
      return await this.publicClient.readProductAvailability();
    } catch {
      return {
        available: false,
        status: "both_unavailable" as const,
        spotSymbol: "XAUTUSDT" as const,
        perpetualSymbol: "XAUTUSDT" as const,
        checkedAt: this.now(),
        message: "Binance Mainnet 产品目录暂不可用；已按 unavailable 处理。",
      };
    }
  }

  async getCredentialStatus() {
    let metadata;
    try {
      metadata = await this.store.readCredentialMetadata();
    } catch {
      return this.status({
        stored: true,
        connectionStatus: "invalid",
        lifecycleStatus: "invalid",
        message: "Binance API 凭证文件不可读；已拒绝继续使用。",
      });
    }
    if (!metadata) {
      return this.status({
        stored: false,
        connectionStatus: "not_configured",
        lifecycleStatus: this.credentialLifecycleOverride ?? "unconfigured",
        message: this.store.masterKeyError,
      });
    }
    if (metadata.requiresRotation) {
      return this.status({
        metadata,
        stored: true,
        connectionStatus: "unavailable",
        lifecycleStatus: "rotation_required",
        message: "检测到旧版凭证格式；必须删除旧凭证并重新授权。",
        ipWhitelistConfigured: metadata.permissions.ipRestricted,
      });
    }
    if (!this.store.masterKeyConfigured) {
      return this.status({
        metadata,
        stored: true,
        connectionStatus: "unavailable",
        lifecycleStatus: "invalid",
        message: this.store.masterKeyError,
        ipWhitelistConfigured: false,
      });
    }
    try {
      const access = await this.client().then((client) => client.validateAccess());
      const valid = permissionsValid(access.permissions) && access.accountId === metadata.accountId;
      const rotationRequired = this.now() - metadata.updatedAt >= rotationAgeMs;
      const lifecycleStatus = !valid ? "invalid" as const : rotationRequired ? "rotation_required" as const : "active" as const;
      return this.status({
        metadata: {
          ...metadata,
          accountMode: access.accountMode,
          permissions: access.permissions,
          lastVerifiedAt: this.now(),
        },
        stored: true,
        connectionStatus: valid ? "verified" : "invalid",
        lifecycleStatus,
        message: !valid
          ? "Binance Key 当前权限、账户身份或持仓模式不符合只读预检安全门禁。"
          : rotationRequired ? "API Key 已达到轮换周期，完成轮换前禁止新增风险。" : null,
      });
    } catch (error) {
      const lifecycleStatus = credentialFailureLifecycle(error);
      return this.status({
        metadata,
        stored: true,
        connectionStatus: lifecycleStatus === "invalid" || lifecycleStatus === "revoked" ? "invalid" : "unavailable",
        lifecycleStatus,
        message: error instanceof RwaBinanceProviderError
          ? error.message
          : "Binance 凭证实时连接校验暂不可用。",
        ipWhitelistConfigured: false,
      });
    }
  }

  async getConfiguredAccountId() {
    return (await this.store.readCredentialMetadata())?.accountId ?? null;
  }

  assertRiskCapacity() {
    return this.store.assertRiskCapacity();
  }

  captureCredentialMutationSnapshot() {
    return this.store.captureCredentialMutationSnapshot();
  }

  restoreCredentialMutationSnapshot(snapshot: RwaCredentialMutationSnapshot) {
    return this.store.restoreCredentialMutationSnapshot(snapshot);
  }

  async putCredentials(input: RwaBinanceCredentials) {
    this.assertExecutionLeaseHeld();
    if (!this.store.masterKeyConfigured) {
      throw keyProviderUnavailable(this.store.masterKeyError);
    }
    this.credentialLifecycleOverride = "validating";
    try {
      const previous = await this.store.readCredentialMetadata();
      if (previous?.requiresRotation) {
        throw new RwaNeutralExecutionError(409, "credential_rotation_required", "检测到旧版凭证格式；请先删除旧凭证并重新授权。");
      }
      await this.store.assertKeyProviderHealthy("pending-credential-validation").catch((error) => {
        throw credentialStoreExecutionError(error);
      });
      let access;
      try {
        access = await this.clientFactory(input).validateAccess();
      } catch (error) {
        throw providerError(error, "Binance 凭证校验失败。");
      }
      assertPermissions(access.permissions);
      if (previous && previous.accountId !== access.accountId) {
        throw new RwaNeutralExecutionError(
          409,
          "credential_account_mismatch",
          "新凭证属于不同 Binance 账户；请先确认旧账户无订单/仓位并安全删除旧凭证。",
        );
      }
      const verifiedAt = this.now();
      await this.store.saveCredentials(input, access.permissions, access, verifiedAt).catch((error) => {
        throw credentialStoreExecutionError(error);
      });
      const state = await this.store.readState();
      state.credentialLifecycle = "active";
      state.credentialAlert = null;
      state.config = {
        ...state.config,
        globalExecutionEnabled: false,
        strategyEnabled: false,
        killSwitchActive: true,
      };
      state.challenges = [];
      this.armedChallengeIds.clear();
      state.credentialAudit.push({
        userId: this.store.ownerUserId,
        action: previous ? "rotated" : "activated",
        accountId: access.accountId,
        accountFingerprint: access.accountFingerprint,
        maskedApiKey: (await this.store.readCredentialMetadata())?.maskedApiKey ?? null,
        occurredAt: verifiedAt,
      });
      await this.store.writeState(state);
      return this.getCredentialStatus();
    } finally {
      this.credentialLifecycleOverride = null;
    }
  }

  async deleteCredentials(input: unknown = {}) {
    this.assertExecutionLeaseHeld();
    const body = record(input);
    assertOnlyKeys(body, ["accountId"]);
    const metadata = await this.store.readCredentialMetadata();
    const state = await this.store.readState();
    if (metadata) {
      assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
      let snapshot;
      try {
        snapshot = await this.client().then((client) => client.readPreflightSnapshot());
      } catch {
        state.credentialLifecycle = "invalid";
        state.credentialAlert = "Binance 凭证不可用，无法确认账户风险敞口。";
        state.config.killSwitchActive = true;
        await this.store.writeState(state);
        throw new RwaNeutralExecutionError(
          409,
          "credential_delete_manual_intervention",
          "凭证已失效或不可用，无法安全解绑。请先在 Binance 现货与 USD-M Futures 人工撤单并确认无仓位。",
          { accountId: metadata.accountId },
        );
      }
      if (
        snapshot.existingSpotQuantityXaut > 1e-9
        || snapshot.existingPerpetualQuantityXaut > 1e-9
        || snapshot.openSpotOrderCount > 0
        || snapshot.openPerpetualOrderCount > 0
      ) {
        throw new RwaNeutralExecutionError(
          409,
          "credential_delete_blocked",
          "Binance 账户存在 XAUT 余额、永续仓位或活动订单；请先人工核对并退出后再删除凭证。",
          { accountId: metadata.accountId },
        );
      }
      state.credentialAudit.push({
        userId: this.store.ownerUserId,
        action: "deleted",
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        maskedApiKey: metadata.maskedApiKey,
        occurredAt: this.now(),
      });
    }
    state.config = {
      ...state.config,
      globalExecutionEnabled: false,
      strategyEnabled: false,
      killSwitchActive: true,
    };
    state.challenges = [];
    state.credentialLifecycle = "unconfigured";
    state.credentialAlert = null;
    await this.store.writeState(state);
    await this.store.deleteCredentials();
    this.armedChallengeIds.clear();
    return { ok: true, credentials: await this.getCredentialStatus() };
  }

  async getConfig() {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    return publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive());
  }

  async updateConfig(input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, [
      "globalExecutionEnabled",
      "strategyEnabled",
      "maxStrategyCapitalUsd",
      "maxEntryBasisBps",
      "maxCombinedSlippageBps",
      "minNetAprPercent",
      "minLiquidationDistancePercent",
      "maxUnhedgedMs",
      "accountId",
    ]);
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    if (metadata) assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
    if (body.globalExecutionEnabled === true || body.strategyEnabled === true) {
      const activeMetadata = await this.requireMetadata();
      await this.validateActiveAccess(await this.clientForNewRisk(state, activeMetadata), activeMetadata.accountId, state);
    }
    const next = { ...state.config };
    if ("globalExecutionEnabled" in body) next.globalExecutionEnabled = booleanField(body.globalExecutionEnabled, "globalExecutionEnabled");
    if ("strategyEnabled" in body) next.strategyEnabled = booleanField(body.strategyEnabled, "strategyEnabled");
    assignRange(next, body, "maxStrategyCapitalUsd", 25, RWA_MAX_STRATEGY_CAPITAL_USD);
    assignRange(next, body, "maxEntryBasisBps", 0, 80);
    assignRange(next, body, "maxCombinedSlippageBps", 1, 20);
    assignRange(next, body, "minNetAprPercent", 8, 100);
    assignRange(next, body, "minLiquidationDistancePercent", 30, 100);
    assignRange(next, body, "maxUnhedgedMs", 1_000, 10_000);
    state.config = next;
    await this.store.writeState(state);
    return publicConfig(this.store.ownerUserId, next, metadata?.accountId ?? null, this.serverKillSwitchActive());
  }

  async setKillSwitch(active: boolean, accountId?: string) {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    if (metadata) assertAccountId(requiredString(accountId, "accountId", 100), metadata.accountId);
    if (!active) {
      const activeMetadata = await this.requireMetadata();
      await this.validateActiveAccess(await this.clientForNewRisk(state, activeMetadata), activeMetadata.accountId, state);
    }
    state.config.killSwitchActive = active;
    if (active) {
      state.challenges = [];
      this.armedChallengeIds.clear();
    }
    await this.store.writeState(state);
    return {
      active,
      userId: this.store.ownerUserId,
      accountId: metadata?.accountId ?? null,
      config: publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive()),
    };
  }

  async getPrivateAccount() {
    const metadata = await this.requireMetadata();
    const snapshot = await this.client().then((client) => client.readPreflightSnapshot())
      .catch((error) => { throw providerError(error, "Binance 私有账户读取失败。"); });
    assertAccountId(snapshot.accountId, metadata.accountId);
    return {
      network: "binance_mainnet" as const,
      phase: "execution_capable" as const,
      providerWritesEnabled: true,
      userId: this.store.ownerUserId,
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      strategyId: RWA_BINANCE_STRATEGY_ID,
      accountMode: snapshot.accountMode,
      permissions: snapshot.permissions,
      productAvailability: snapshot.productAvailability,
      balances: {
        spotAvailableUsdt: snapshot.spotAvailableUsdt,
        futuresAvailableUsdt: snapshot.futuresAvailableUsdt,
        spotXaut: snapshot.existingSpotQuantityXaut,
        perpetualXaut: snapshot.existingPerpetualQuantityXaut,
      },
      openOrders: {
        spot: snapshot.openSpotOrderCount,
        perpetual: snapshot.openPerpetualOrderCount,
      },
      instruments: { spot: snapshot.spot, perpetual: snapshot.perpetual },
      fees: snapshot.fees,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async getPnl() {
    const metadata = await this.requireMetadata();
    const client = await this.client();
    const state = await this.store.readState();
    const firstExecutionAt = state.executions.length
      ? Math.min(...state.executions.map((item) => item.createdAt))
      : null;
    const snapshot = await client.readStrategyPnl(this.strategyOrderPrefix, firstExecutionAt)
      .catch((error) => { throw providerError(error, "Binance 策略盈亏读取失败。"); });
    assertAccountId(snapshot.accountId, metadata.accountId);
    snapshot.slippageUsd = calculateNeutralExecutionSlippage(state);
    snapshot.netPnlUsd = snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd
      + snapshot.fundingPnlUsd - snapshot.feesUsd - snapshot.slippageUsd;
    state.pnlSeries.push(snapshot);
    if (state.pnlSeries.length > 1_000) state.pnlSeries.splice(0, state.pnlSeries.length - 1_000);
    await this.store.writeState(state);
    return {
      userId: this.store.ownerUserId,
      accountId: metadata.accountId,
      current: snapshot,
      series: state.pnlSeries.slice(-200),
      history: state.executions.slice(-100).reverse().map(redactExecution),
      phase: "execution_capable",
      providerWritesEnabled: true,
    };
  }

  async getAudit() {
    const state = await this.store.readState();
    return {
      items: state.credentialAudit.slice(-200).reverse(),
      alert: state.credentialAlert,
      phase: "execution_capable",
      providerWritesEnabled: true,
    };
  }

  async preflight(opportunity: ArbitrageOpportunity, accountId: string, mode: RwaAutomationMode) {
    this.assertExecutionLeaseHeld();
    assertSupportedOpportunity(opportunity, mode);
    return this.withLock(async () => {
      const state = await this.store.readState();
      this.assertEntrySwitches(state.config);
      const metadata = await this.requireMetadata();
      assertAccountId(accountId, metadata.accountId);
      const productAvailability = await this.getProductAvailability();
      if (!productAvailability.available) {
        throw new RwaNeutralExecutionError(
          409,
          "binance_product_unavailable",
          productAvailability.message ?? "Binance Mainnet 当前无法组成 XAUT 现货与永续对冲组合。",
          { productAvailability },
        );
      }
      const client = await this.clientForNewRisk(state, metadata);
      await this.validateActiveAccess(client, accountId, state);
      const snapshot = await client.readPreflightSnapshot()
        .catch((error) => { throw providerError(error, "Binance 实时 preflight 读取失败。"); });
      assertAccountId(snapshot.accountId, accountId);
      const report = buildBinancePreflight(
        this.store.ownerUserId,
        opportunity.id,
        snapshot,
        state.config,
        mode,
        this.now(),
      );
      if (!report.passed) {
        throw new RwaNeutralExecutionError(409, "preflight_rejected", "Binance 实时 preflight 未通过，禁止建立对冲组合。", { report });
      }
      const challengeId = randomBytes(18).toString("base64url");
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
      while (this.armedChallengeIds.size >= this.store.maxInMemoryChallenges) {
        const oldest = this.armedChallengeIds.values().next().value;
        if (!oldest) break;
        this.armedChallengeIds.delete(oldest);
      }
      this.armedChallengeIds.add(challengeId);
      return { challengeId, challengeToken, expiresAt: report.expiresAt, report };
    });
  }

  async execute(input: unknown) {
    this.assertExecutionLeaseHeld();
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "challengeId", "challengeToken", "idempotencyKey"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const challengeId = requiredString(body.challengeId, "challengeId", 100);
    const challengeToken = requiredString(body.challengeToken, "challengeToken", 200);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    if (!/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) {
      throw new RwaNeutralExecutionError(400, "invalid_request", "idempotencyKey 格式无效。");
    }
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
      const execution = createNeutralExecutionRecord({
        userId: this.store.ownerUserId,
        accountId,
        userOrderPrefix: this.strategyOrderPrefix,
        idempotencyKey: scopedIdempotencyKey,
        challengeId,
        now: this.now(),
      });
      state.executions.push(execution);
      await this.store.writeState(state);
      this.assertExecutionLeaseHeld();
      let client: RwaBinanceClient | null = null;
      try {
        const metadata = await this.requireMetadata();
        client = await this.clientForNewRisk(state, metadata);
        await this.validateActiveAccess(client, accountId, state);
        const realtime = await client.readPreflightSnapshot();
        assertAccountId(realtime.accountId, accountId);
        const mode = challenge.report.mode === "manual_entry" ? "manual_entry" : "arbitrage_entry";
        const report = buildBinancePreflight(
          this.store.ownerUserId,
          challenge.report.opportunityId,
          realtime,
          state.config,
          mode,
          this.now(),
        );
        if (!report.passed) throw new RwaNeutralExecutionError(409, "preflight_changed", "执行前实时条件已变化，禁止建立对冲组合。");
        this.assertExecutionLeaseHeld();
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
          execution.errorCategory = errorCategory(error);
          execution.message = sanitizeRwaAutomationError(error);
          try {
            if (!client) throw error;
            this.assertExecutionLeaseHeld();
            execution.state = "compensating";
            await this.persistExecution(state, execution);
            this.assertExecutionLeaseHeld();
            await client.cancelStrategyOrders(execution.orderLinkPrefix);
            await this.hedgeEngine.closeAll(client, execution.orderLinkPrefix, `${execution.orderLinkPrefix}x`);
            execution.state = "failed";
            execution.message = "对冲未完成，已按 Binance 权威状态撤单并退出未对冲敞口。";
          } catch {
            execution.state = "manual_intervention";
            execution.message = "自动建立或退出对冲组合未能闭环，需要当前用户在 Binance 人工处理。";
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
    this.assertExecutionLeaseHeld();
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "idempotencyKey"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    if (!/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) {
      throw new RwaNeutralExecutionError(400, "invalid_request", "idempotencyKey 格式无效。");
    }
    const scopedIdempotencyKey = `${this.store.userDomain}:${idempotencyKey}`;
    return this.withLock(async () => {
      const state = await this.store.readState();
      const existing = state.executions.find((item) => item.idempotencyKey === scopedIdempotencyKey);
      if (existing) return redactExecution(existing);
      const metadata = await this.requireMetadata();
      assertAccountId(accountId, metadata.accountId);
      const client = await this.client();
      const execution = createNeutralExecutionRecord({
        userId: this.store.ownerUserId,
        accountId,
        userOrderPrefix: this.strategyOrderPrefix,
        idempotencyKey: scopedIdempotencyKey,
        challengeId: "close-all",
        now: this.now(),
      });
      execution.state = "compensating";
      execution.message = "正在退出现货与永续对冲组合。";
      state.executions.push(execution);
      await this.store.writeState(state);
      this.assertExecutionLeaseHeld();
      try {
        this.assertExecutionLeaseHeld();
        await client.cancelStrategyOrders(this.strategyOrderPrefix);
        await this.hedgeEngine.closeAll(client, this.strategyOrderPrefix, execution.orderLinkPrefix);
        execution.state = "closed";
        execution.message = "策略订单已撤销，现货与永续两侧仓位已退出并确认。";
      } catch (error) {
        execution.state = "manual_intervention";
        execution.errorCategory = errorCategory(error);
        execution.message = "自动退出对冲组合未能闭环，需要当前用户在 Binance 人工处理。";
        state.config.killSwitchActive = true;
      }
      execution.updatedAt = this.now();
      await this.store.writeState(state);
      return redactExecution(execution);
    });
  }

  private async client(): Promise<RwaBinanceClient> {
    this.assertExecutionLeaseHeld();
    if (!this.store.masterKeyConfigured) {
      throw keyProviderUnavailable(this.store.masterKeyError);
    }
    try {
      return this.clientFactory(await this.store.loadCredentials());
    } catch (error) {
      throw credentialStoreExecutionError(error);
    }
  }

  private async clientForNewRisk(state: RwaAutomationStateData, metadata: BinanceCredentialMetadata) {
    try {
      return await this.client();
    } catch (error) {
      await this.freezeNewRisk(
        state,
        credentialFailureLifecycle(error),
        metadata,
        "凭证密钥 provider 不可用或凭证无法解密；已激活急停。请在 Binance 人工检查订单和仓位。",
      );
      throw error;
    }
  }

  private async requireMetadata() {
    const metadata = await this.store.readCredentialMetadata();
    if (!metadata) throw new RwaNeutralExecutionError(409, "credential_not_configured", "Binance API 凭证尚未配置。");
    if (metadata.requiresRotation) {
      throw new RwaNeutralExecutionError(409, "credential_rotation_required", "检测到旧版凭证格式；请删除旧凭证并重新授权。");
    }
    return metadata;
  }

  private async validateActiveAccess(client: RwaBinanceClient, accountId: string, state: RwaAutomationStateData) {
    const metadata = await this.requireMetadata();
    assertAccountId(accountId, metadata.accountId);
    if (this.now() - metadata.updatedAt >= rotationAgeMs) {
      await this.freezeNewRisk(state, "rotation_required", metadata, "Binance API Key 已达到轮换周期，完成轮换前禁止新增风险。");
      throw new RwaNeutralExecutionError(409, "credential_rotation_required", "Binance API Key 已达到轮换周期，请先完成安全轮换。");
    }
    try {
      const access = await client.validateAccess();
      assertPermissions(access.permissions);
      assertAccountId(access.accountId, accountId);
      return access;
    } catch (error) {
      const lifecycle = credentialFailureLifecycle(error);
      await this.freezeNewRisk(state, lifecycle, metadata, "Binance 执行账户权限或连接校验失败，已禁止新增风险。");
      throw providerError(error, "Binance 执行账户权限或连接校验失败。");
    }
  }

  private async freezeNewRisk(
    state: RwaAutomationStateData,
    lifecycle: Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active">,
    metadata: BinanceCredentialMetadata,
    message: string,
  ) {
    state.credentialLifecycle = lifecycle;
    state.credentialAlert = message;
    state.config.killSwitchActive = true;
    state.config.strategyEnabled = false;
    state.config.globalExecutionEnabled = false;
    state.challenges = [];
    state.credentialAudit.push({
      userId: this.store.ownerUserId,
      action: "invalidated",
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
      maskedApiKey: metadata.maskedApiKey,
      occurredAt: this.now(),
    });
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
    if (!config.globalExecutionEnabled) throw new RwaNeutralExecutionError(409, "global_execution_disabled", "全局真实执行开关未启用。");
    if (!config.strategyEnabled) throw new RwaNeutralExecutionError(409, "strategy_disabled", "Binance XAUT 对冲策略开关未启用。");
    if (config.killSwitchActive) throw new RwaNeutralExecutionError(409, "kill_switch_active", "Kill switch 已激活，禁止新增风险动作。");
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

  private status(input: {
    metadata?: BinanceCredentialMetadata | null;
    stored: boolean;
    connectionStatus: "not_configured" | "verified" | "invalid" | "unavailable";
    lifecycleStatus: RwaCredentialLifecycle;
    message: string | null;
    ipWhitelistConfigured?: boolean | null;
  }) {
    const metadata = input.metadata ?? null;
    const permissions = metadata?.permissions ?? null;
    return {
      userId: this.store.ownerUserId,
      accountId: metadata?.accountId ?? null,
      accountFingerprint: metadata?.accountFingerprint ?? null,
      stored: input.stored,
      masterKeyConfigured: this.store.masterKeyConfigured,
      maskedApiKey: metadata?.maskedApiKey ?? null,
      connectionStatus: input.connectionStatus,
      lifecycleStatus: input.lifecycleStatus,
      accountMode: metadata?.accountMode ?? null,
      permissions,
      lastVerifiedAt: metadata?.lastVerifiedAt ?? null,
      updatedAt: metadata?.updatedAt ?? null,
      message: input.message,
      ipWhitelistConfigured: input.ipWhitelistConfigured ?? permissions?.ipRestricted ?? null,
      warnings: [],
    };
  }
}

function buildBinancePreflight(
  userId: string,
  opportunityId: string,
  snapshot: RwaBinancePreflightSnapshot,
  config: RwaExecutionConfig,
  mode: RwaAutomationMode,
  now: number,
): RwaPreflightReport & {
  phase: "execution_capable";
  providerWritesEnabled: true;
  productAvailability: RwaBinancePreflightSnapshot["productAvailability"];
  marketChecksPassed: boolean;
  message: string;
} {
  const commonStep = Math.max(snapshot.spot.qtyStep, snapshot.perpetual.qtyStep);
  const budgetQuantity = commonStep > 0
    ? floorStep(RWA_BINANCE_TOTAL_BUDGET_USD * 0.95 / (snapshot.spot.ask + snapshot.perpetual.bid), commonStep)
    : 0;
  const quantityXaut = budgetQuantity;
  const spotNotional = quantityXaut * snapshot.spot.ask;
  const perpetualNotional = quantityXaut * snapshot.perpetual.bid;
  const feesUsd = (spotNotional * snapshot.fees.spotTakerBps + perpetualNotional * snapshot.fees.perpetualTakerBps) / 10_000;
  const slippageReserveUsd = (spotNotional + perpetualNotional) * config.maxCombinedSlippageBps / 10_000;
  const capitalRequired = spotNotional + perpetualNotional + feesUsd + slippageReserveUsd;
  const entryBasisBps = snapshot.spot.ask > 0
    ? (snapshot.perpetual.bid - snapshot.spot.ask) / snapshot.spot.ask * 10_000
    : Number.POSITIVE_INFINITY;
  const fundingPeriodsPerYear = snapshot.perpetual.fundingIntervalHours > 0
    ? 24 / snapshot.perpetual.fundingIntervalHours * 365
    : 0;
  const estimatedNetAprPercent = snapshot.perpetual.fundingRate * fundingPeriodsPerYear * 100
    - (snapshot.fees.spotTakerBps + snapshot.fees.perpetualTakerBps + config.maxCombinedSlippageBps) / 100;
  const checks = [
    check("product_pair", snapshot.productAvailability.available, true, "Binance Mainnet 必须存在可执行的 XAUTUSDT 现货与 USD-M 永续对冲组合。"),
    check("permissions", permissionsValid(snapshot.permissions), true, "必须具备读取、现货交易和 USD-M Futures 交易权限，关闭提现，并通过服务端固定出口 IP 白名单核对。"),
    check("position_mode", snapshot.permissions.positionModeSupported, true, "当前只接受 one-way 持仓模式；hedge mode 暂不放行。"),
    check("spot_trading", snapshot.spot.status === "Trading", "Trading", "XAUTUSDT 现货必须为 TRADING。"),
    check("perpetual_trading", snapshot.perpetual.status === "Trading", "Trading", "XAUTUSDT USD-M 永续必须为 TRADING。"),
    check("quotes", snapshot.spot.bid > 0 && snapshot.spot.ask > 0 && snapshot.perpetual.bid > 0 && snapshot.perpetual.ask > 0, true, "现货侧与永续侧 Bid/Ask 必须完整。"),
    check("precision", quantityXaut > 0 && stepAligned(quantityXaut, snapshot.spot.qtyStep) && stepAligned(quantityXaut, snapshot.perpetual.qtyStep), true, "数量必须同时匹配现货和永续步长。"),
    check("spot_minimum", quantityXaut >= snapshot.spot.minOrderQty && spotNotional >= snapshot.spot.minNotionalUsd, true, "现货数量和名义必须达到实时最小值。"),
    check("perpetual_minimum", quantityXaut >= snapshot.perpetual.minOrderQty && perpetualNotional >= snapshot.perpetual.minNotionalUsd, true, "永续数量和名义必须达到实时最小值。"),
    check("spot_balance", snapshot.spotAvailableUsdt >= spotNotional + feesUsd, spotNotional + feesUsd, "现货账户 USDT 必须独立覆盖现货侧。"),
    check("futures_balance", snapshot.futuresAvailableUsdt >= perpetualNotional + feesUsd, perpetualNotional + feesUsd, "USD-M Futures 可用余额必须独立覆盖永续侧。"),
    check("no_existing_spot", snapshot.existingSpotQuantityXaut <= 1e-9 && snapshot.openSpotOrderCount === 0, 0, "专用账户不得已有 XAUT 现货或活动现货订单。"),
    check("no_existing_perpetual", snapshot.existingPerpetualQuantityXaut <= 1e-9 && snapshot.openPerpetualOrderCount === 0, 0, "专用账户不得已有 XAUT 永续仓位或活动合约订单。"),
    check("depth", snapshot.spot.depthUsd >= spotNotional && snapshot.perpetual.depthUsd >= perpetualNotional, true, "现货侧与永续侧公开盘口深度必须覆盖计划名义。"),
    check("total_budget", capitalRequired <= RWA_BINANCE_TOTAL_BUDGET_USD, RWA_BINANCE_TOTAL_BUDGET_USD, "现货与永续对冲组合的 1x 名义、手续费和滑点准备金必须在 25 USDT 总预算内。"),
    check("strategy_cap", capitalRequired <= config.maxStrategyCapitalUsd && config.maxStrategyCapitalUsd <= RWA_MAX_STRATEGY_CAPITAL_USD, config.maxStrategyCapitalUsd, "venue 资本上限不得超过 300 USDT。"),
    check("liquidation", snapshot.perpetual.liquidationDistancePercent === null
      || snapshot.perpetual.liquidationDistancePercent >= config.minLiquidationDistancePercent, config.minLiquidationDistancePercent, "已有仓位强平距离不得低于门限。"),
    check("freshness", now - snapshot.fetchedAt <= RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS, RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS, "私有账户与市场快照必须新鲜。"),
  ];
  if (mode === "arbitrage_entry") {
    checks.push(
      check("funding_direction", snapshot.perpetual.fundingRate > 0, "> 0", "永续空头必须处于收取 Funding 方向。"),
      check("entry_basis", Math.abs(entryBasisBps) <= config.maxEntryBasisBps, config.maxEntryBasisBps, "入场基差绝对值不得超过门限。"),
      check("net_apr", estimatedNetAprPercent >= config.minNetAprPercent, config.minNetAprPercent, "估算净 APR 必须达到自动策略门限。"),
    );
  }
  const warnings: string[] = [];
  if (mode === "manual_entry") {
    if (snapshot.perpetual.fundingRate <= 0) warnings.push("当前永续侧未处于收取 Funding 状态。");
    if (Math.abs(entryBasisBps) > config.maxEntryBasisBps) warnings.push("当前入场基差超过自动策略门限。");
    if (estimatedNetAprPercent < config.minNetAprPercent) warnings.push("当前估算净 APR 低于自动策略门限。");
  }
  const marketChecksPassed = checks.every((item) => item.passed);
  return {
    userId,
    accountId: snapshot.accountId,
    accountFingerprint: snapshot.accountFingerprint,
    network: "binance_mainnet",
    venue: "binance",
    phase: "execution_capable",
    providerWritesEnabled: true,
    strategyId: RWA_BINANCE_STRATEGY_ID,
    action: mode,
    opportunityId,
    mode,
    productAvailability: snapshot.productAvailability,
    quantityXaut,
    totalBudgetUsd: RWA_BINANCE_TOTAL_BUDGET_USD,
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
    marketChecksPassed,
    passed: marketChecksPassed,
    generatedAt: now,
    expiresAt: now + challengeTtlMs,
    message: marketChecksPassed
      ? "市场与账户检查通过，可签发一次性执行 challenge。"
      : "市场或账户检查未通过，禁止建立对冲组合。",
  };
}

function assertSupportedOpportunity(opportunity: ArbitrageOpportunity, mode: RwaAutomationMode) {
  if (
    (mode !== "arbitrage_entry" && mode !== "manual_entry")
    || opportunity.strategyType !== "same_venue_neutral"
    || opportunity.longLeg.venue !== "binance"
    || opportunity.shortLeg.venue !== "binance"
    || opportunity.longLeg.kind !== "spot"
    || opportunity.shortLeg.kind !== "perpetual"
    || opportunity.longLeg.asset !== "XAUT"
    || opportunity.shortLeg.asset !== "XAUT"
    || opportunity.disqualifiers.length > 0
    || (mode === "arbitrage_entry" && !opportunity.automationEligible)
  ) {
    throw new RwaNeutralExecutionError(
      409,
      "adapter_opportunity_unsupported",
      "Binance 仅支持安全可执行的 XAUT 同所现货侧买入 + USD-M 永续侧卖出对冲组合。",
    );
  }
}

function publicConfig(userId: string, config: RwaExecutionConfig, accountId: string | null, serverGlobalKillSwitchActive: boolean) {
  return {
    userId,
    accountId,
    ...config,
    serverGlobalKillSwitchActive,
    venue: "binance",
    phase: "execution_capable",
    providerWritesEnabled: true,
    automaticExecutionEnabled: false,
    armed: false,
  };
}

function assertPermissions(value: RwaBinancePermissions) {
  if (!permissionsValid(value)) {
    throw new RwaNeutralExecutionError(
      409,
      "permission_rejected",
      "Binance Key 必须具备读取、现货交易与 USD-M Futures 交易权限，禁止提现，通过服务端固定出口 IP 白名单核对，并使用当前支持的 one-way 持仓模式。",
    );
  }
}

function permissionsValid(value: RwaBinancePermissions) {
  return value.read
    && value.spotTrade
    && value.contractTrade
    && !value.withdraw
    && value.ipRestricted
    && value.spotAccount
    && value.futuresAccount
    && value.positionModeSupported;
}

function credentialFailureLifecycle(error: unknown): Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active"> {
  if (error instanceof CredentialStoreError && error.category === "credential_rotation_required") return "rotation_required";
  if (error instanceof RwaNeutralExecutionError && error.category === "credential_rotation_required") return "rotation_required";
  if (error instanceof RwaBinanceProviderError && ["provider_credential_invalid", "provider_permission_error"].includes(error.category)) {
    return "revoked";
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
  return new RwaNeutralExecutionError(503, "credential_unavailable", "Binance API 凭证不可用；已拒绝私有请求。");
}

function providerError(error: unknown, fallback: string) {
  if (error instanceof RwaNeutralExecutionError) return error;
  if (error instanceof RwaBinanceProviderError) {
    const statusCode = error.category === "binance_egress_ip_config_missing"
      ? 503
      : ["binance_ip_whitelist_unconfirmed", "binance_ip_whitelist_mismatch"].includes(error.category)
        ? 409
        : 502;
    return new RwaNeutralExecutionError(statusCode, error.category, error.message);
  }
  return new RwaNeutralExecutionError(502, "provider_unavailable", fallback);
}

function errorCategory(error: unknown) {
  return error instanceof RwaNeutralExecutionError || error instanceof RwaBinanceProviderError
    ? error.category
    : "automation_execution_error";
}

function redactExecution(execution: RwaExecutionRecord) {
  return { ...execution };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function assertAccountId(actual: string, expected: string) {
  if (actual !== expected) {
    throw new RwaNeutralExecutionError(409, "account_mismatch", "accountId 与当前 Binance 执行账户不匹配，已拒绝操作。");
  }
}

function assignRange(
  target: RwaExecutionConfig,
  body: Record<string, unknown>,
  key: keyof RwaExecutionConfig,
  minimum: number,
  maximum: number,
) {
  if (!(key in body)) return;
  const value = Number(body[key]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RwaNeutralExecutionError(400, "invalid_request", `${key} 必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  (target[key] as number) = value;
}

function booleanField(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new RwaNeutralExecutionError(400, "invalid_request", `${field} 必须是布尔值。`);
  return value;
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new RwaNeutralExecutionError(400, "invalid_request", `请求包含不支持的字段：${unknown.join("、")}。`);
}

function requiredString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new RwaNeutralExecutionError(400, "invalid_request", `${field} 格式无效。`);
  }
  return value.trim();
}

function check(name: string, passed: boolean, limit: number | string | boolean, message: string) {
  return { name, passed, value: passed, limit, message };
}

function floorStep(value: number, step: number) {
  return step > 0 ? Math.floor((value + 1e-12) / step) * step : 0;
}

function stepAligned(value: number, step: number) {
  if (!(step > 0)) return false;
  return Math.abs(value / step - Math.round(value / step)) <= 1e-8;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export const binancePhaseOneDefaultConfig = { ...defaultRwaExecutionConfig };
