import { createHash, randomBytes } from "node:crypto";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import {
  CredentialStoreError,
  RwaAutomationPersistentStore,
  automationCapitalExposuresFromExecutions,
  automationCapitalExposuresFromTakeovers,
  readRwaAutomationCapitalExposures,
  type RwaCredentialMutationSnapshot,
  type RwaAutomationStateData,
} from "./RwaAutomationPersistentStore";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import {
  assertRwaAutomationInstrumentRules,
  assertRwaAutomationNewRisk,
  calculateRwaAutomationNewRiskUsage,
  mergeRwaAutomationCapitalExposures,
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
  type RwaAutomationCapitalExposure,
} from "./RwaAutomationAssetProfile";
import {
  assertAccountAssetAuthorizationPreview,
  createAccountAssetAuthorization as createStoredAccountAssetAuthorization,
  createAccountAssetAuthorizationPreview,
  invalidateAccountAssetAuthorizations,
  publicAccountAssetAuthorization,
  RwaAccountAssetAuthorizationError,
  validateAccountAssetAuthorizationPreview,
  type RwaAccountAssetAuthorizationPreview,
} from "./RwaAccountAssetAuthorization";
import {
  RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS,
  RWA_BINANCE_STRATEGY_ID,
  type RwaBinanceClient,
  type RwaBinanceClientFactory,
  type RwaBinanceCredentials,
  type RwaBinancePermissions,
  type RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import { RwaBinanceProviderError } from "./RwaBinanceMainnetClient";
import {
  assessResidual,
  calculateNeutralExecutionSlippage,
  createNeutralExecutionRecord,
  RwaNeutralHedgeExecutionEngine,
  spotClosableQuantity,
  trackedExposureFromExecution,
  trackedExposureFromState,
} from "./RwaNeutralHedgeExecutionEngine";
import { sanitizeRwaAutomationError } from "./RwaNeutralAutomationSecurity";
import type { RwaAutomationMode } from "./RwaAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";
import {
  defaultRwaExecutionConfig,
  type RwaExecutionReconciliationPreview,
  type RwaCredentialLifecycle,
  type RwaExecutionConfig,
  type RwaExecutionRecord,
  RwaExecutionSafetyError,
  type RwaPreflightReport,
  type RwaPositionAttributionSnapshot,
  type RwaProviderOrder,
} from "./RwaNeutralExecutionTypes";
import {
  createMonitoredActivityContinuity,
  createUnmonitoredActivityContinuity,
  mergeActivitySnapshot,
  recordStrategyProviderOrder,
  RWA_ACTIVITY_POLL_INTERVAL_MS,
} from "./RwaProviderActivityContinuity";
import {
  RwaBinanceActivityGuard,
  RwaBinanceActivityUnsafeError,
} from "./RwaBinanceActivityGuard";
import { RwaBinanceUserDataStream } from "./RwaBinanceUserDataStream";
import { calculateMinimumCommonBaseQuantity } from "./RwaAutomationMinimumOrder";
import { RwaAssetTakeoverCoordinator } from "./RwaAssetTakeoverCoordinator";
import type {
  RwaAssetTakeoverLeverage,
  RwaAssetTakeoverPreview,
} from "./RwaAssetTakeover";
import {
  RWA_ASSET_RUNTIME_PUBLIC_POLL_INTERVAL_MS,
  type RwaAssetTakeoverExitPreview,
} from "./RwaAssetTakeoverRuntime";
import {
  appendConnectivitySmokeTimeline,
  calculateConnectivitySmokeBudget,
  assertConnectivitySmokePolicyAcceptance,
  connectivitySmokePolicyDiscovery,
  isActiveConnectivitySmoke,
  newSmokeOrderPrefix,
  RWA_CONNECTIVITY_SMOKE_PURPOSE,
  RWA_CONNECTIVITY_SMOKE_POLICY,
  RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
  RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
  RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS,
  type RwaConnectivitySmokePolicyAcceptance,
  type RwaConnectivitySmokeChallengeReport,
  type RwaConnectivitySmokeRecord,
} from "./RwaConnectivitySmoke";
import {
  binanceAccountBindingSha256,
  loadRwaBinanceProductionSelfTestPermit,
  productionSelfTestPermitDigest,
  validProductionSelfTestActionScope,
  type RwaBinanceProductionSelfTestPermit,
} from "./RwaBinanceProductionSelfTestPermit";

const challengeTtlMs = 60_000;
const executionStates = new Set(["accepted", "opening_spot", "opening_perpetual", "compensating", "partial_closed"]);
const XAUT_BINANCE_PROFILE = requireRwaAutomationExecutionProfile("xaut", "binance");
type BinanceStore = RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>;
type BinanceCredentialMetadata = NonNullable<Awaited<ReturnType<BinanceStore["readCredentialMetadata"]>>>;

export class RwaBinanceAutomationService {
  private lock = Promise.resolve();
  private activityMonitor: ReturnType<typeof setInterval> | null = null;
  private takeoverMonitor: ReturnType<typeof setInterval> | null = null;
  private readonly armedChallengeIds = new Set<string>();
  private readonly armedSmokeChallenges = new Map<string, {
    tokenHash: string;
    report: RwaConnectivitySmokeChallengeReport;
  }>();
  private credentialLifecycleOverride: RwaCredentialLifecycle | null = null;
  private readonly publicClient: RwaBinanceClient;
  private readonly hedgeEngine: RwaNeutralHedgeExecutionEngine;
  private readonly takeoverCoordinator: RwaAssetTakeoverCoordinator<RwaBinancePermissions>;
  private readonly providerActivityGuard: RwaBinanceActivityGuard;
  private readonly providerUserDataStream: RwaBinanceUserDataStream;

  constructor(
    private readonly store: RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>,
    private readonly clientFactory: RwaBinanceClientFactory,
    private readonly now: () => number = Date.now,
    private readonly serverKillSwitchActive: () => boolean = () => process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "false",
    publicClient?: RwaBinanceClient,
    private readonly assertExecutionLeaseHeld: () => void = () => {},
    private readonly activityMonitoringEnabled: () => boolean = () =>
      process.env.NODE_ENV === "production"
      || process.env.RWA_BINANCE_ACTIVITY_MONITOR_ENABLED === "true",
    private readonly productionSelfTestPermit: () => RwaBinanceProductionSelfTestPermit | null =
      loadRwaBinanceProductionSelfTestPermit,
    private readonly productionEnvironment: () => boolean = () =>
      process.env.NODE_ENV === "production",
    assertAutomationMutationAllowed: () => void = () => {},
  ) {
    this.assertExecutionLeaseHeld = () => {
      assertExecutionLeaseHeld();
      assertAutomationMutationAllowed();
    };
    this.store.setClock(now);
    this.providerActivityGuard = new RwaBinanceActivityGuard(
      (reason) => { void this.failClosedForProviderActivity(reason); },
      now,
    );
    this.providerUserDataStream = new RwaBinanceUserDataStream(this.providerActivityGuard, fetch, undefined, now);
    this.publicClient = publicClient ?? clientFactory({ apiKey: "", apiSecret: "" });
    this.hedgeEngine = new RwaNeutralHedgeExecutionEngine(
      now,
      this.assertExecutionLeaseHeld,
      XAUT_BINANCE_PROFILE,
    );
    this.takeoverCoordinator = new RwaAssetTakeoverCoordinator({
      venue: "binance",
      store,
      client: () => this.clientForTakeover(),
      publicMark: () => {
        if (!this.publicClient.readManagedAssetPublicMark) {
          throw new Error("Binance 公开标记价格接口不可用。");
        }
        return this.publicClient.readManagedAssetPublicMark();
      },
      credentialBinding: () => this.requireMetadata(),
      assertExecutionLeaseHeld: this.assertExecutionLeaseHeld,
      serverKillSwitchActive,
      now,
    });
  }

  private get strategyOrderPrefix() {
    return `rwa${this.store.userDomain}`;
  }

  async initialize() {
    this.assertExecutionLeaseHeld();
    this.armedChallengeIds.clear();
    this.armedSmokeChallenges.clear();
    await this.withLock(async () => {
      if (!(await this.store.hasCredentials()) || !this.store.masterKeyConfigured) return;
      const state = await this.store.readState();
      await this.recoverConnectivitySmoke(state);
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
          await this.hedgeEngine.closeAll(
            client,
            execution.orderLinkPrefix,
            `${execution.orderLinkPrefix}r`,
            trackedExposureFromExecution(execution),
            (side, order) => this.persistCloseFill(state, [execution.executionId], side, order.positionQuantityXaut ?? order.filledQuantityXaut),
            (snapshot) => this.persistActivitySnapshot(state, [execution.executionId], snapshot),
            (side, orderId) => this.persistProviderOrder(state, [execution.executionId], side, orderId),
          );
          const fullyClosed = finalizeTrackedExecutions(state, [execution.executionId], this.now());
          execution.state = fullyClosed ? "closed" : "partial_closed";
          execution.reconciliation = await this.buildReconciliationPreview(client, execution);
          execution.message = fullyClosed
            ? "服务重启后已按 Binance 权威状态退出对冲组合。"
            : "服务重启后仍存在不可交易的策略残余，需要人工核对。";
          if (!fullyClosed) state.config.killSwitchActive = true;
        } catch (error) {
          execution.reconciliation = await this.safeReconciliationPreview(client, execution);
          execution.state = execution.reconciliation && hasPartialClose(execution.reconciliation)
            ? "partial_closed"
            : "manual_intervention";
          execution.errorCategory = errorCategory(error);
          execution.message = "重启恢复无法自动退出对冲组合，需要当前用户在 Binance 人工处理。";
          state.config.killSwitchActive = true;
        }
        execution.updatedAt = this.now();
      }
      await this.store.writeState(state);
    });
    await this.withLock(() => this.takeoverCoordinator.recoverPending());
    await this.startActivityMonitoring();
  }

  async startActivityMonitoring() {
    if (!this.activityMonitoringEnabled()) return;
    await this.startTakeoverMonitoring();
    await this.startStrategyActivityMonitoring();
  }

  private async startStrategyActivityMonitoring() {
    if (!this.activityMonitoringEnabled()) return;
    if (this.activityMonitor) return;
    const active = await this.refreshActivityContinuity();
    if (!active) return;
    this.activityMonitor = setInterval(() => {
      void this.refreshActivityContinuity().then((keep) => {
        if (!keep) this.stopActivityMonitor();
      });
    }, RWA_ACTIVITY_POLL_INTERVAL_MS);
    this.activityMonitor.unref();
  }

  hasActivityMonitor() {
    return this.activityMonitor !== null || this.takeoverMonitor !== null;
  }

  dispose() {
    this.stopActivityMonitor();
    this.stopTakeoverMonitor();
  }

  private stopActivityMonitor() {
    if (!this.activityMonitor) return;
    clearInterval(this.activityMonitor);
    this.activityMonitor = null;
  }

  private async startTakeoverMonitoring() {
    if (!this.activityMonitoringEnabled()) return;
    this.assertExecutionLeaseHeld();
    if (this.takeoverMonitor) return;
    const active = await this.withLock(() => this.takeoverCoordinator.pollManaged());
    if (!active) return;
    this.takeoverMonitor = setInterval(() => {
      void this.withLock(() => this.takeoverCoordinator.pollManagedPublicRisk()).then((keep) => {
        if (!keep) this.stopTakeoverMonitor();
      });
    }, RWA_ASSET_RUNTIME_PUBLIC_POLL_INTERVAL_MS);
    this.takeoverMonitor.unref();
  }

  private stopTakeoverMonitor() {
    if (!this.takeoverMonitor) return;
    clearInterval(this.takeoverMonitor);
    this.takeoverMonitor = null;
  }

  refreshActivityContinuity() {
    return this.withLock(async () => {
      const state = await this.store.readState();
      const active = strategyExposureExecutions(state.executions)
        .filter((execution) => execution.profileId === rwaAutomationProfileId(XAUT_BINANCE_PROFILE));
      if (!active.length) return false;
      this.assertExecutionLeaseHeld();
      if (active.some((execution) =>
        execution.activityContinuity.spot.coverage !== "monitored"
        || execution.activityContinuity.perpetual.coverage !== "monitored")) {
        markExecutionsActivityAmbiguous(state, active, this.now());
        await this.store.writeState(state);
        this.assertExecutionLeaseHeld();
        return false;
      }
      try {
        const client = await this.client();
        const market = await client.readPreflightSnapshot();
        const tracked = trackedExposureFromState(active, rwaAutomationProfileId(XAUT_BINANCE_PROFILE));
        if (
          Math.abs(market.existingSpotQuantityXaut - tracked.spotQuantityXaut) > 1e-9
          || Math.abs(market.existingPerpetualQuantityXaut - tracked.perpetualQuantityXaut) > 1e-9
        ) throw new RwaExecutionSafetyError("strategy_ownership_ambiguous", "账户数量与策略归属数量不一致。");
        const snapshot = await client.readPositionAttribution({
          strategyOrderPrefix: this.strategyOrderPrefix,
          strategyOrderPrefixes: tracked.strategyOrderPrefixes,
          since: tracked.attributionSince,
          continuity: tracked.activityContinuity,
        });
        this.assertExecutionLeaseHeld();
        await this.persistActivitySnapshot(state, tracked.sourceExecutionIds, snapshot);
        this.assertExecutionLeaseHeld();
        if (
          active.some((execution) => execution.activityContinuity.spot.coverage === "ambiguous"
            || execution.activityContinuity.perpetual.coverage === "ambiguous")
        ) throw new RwaExecutionSafetyError("strategy_ownership_ambiguous", "交易所活动连续性不完整。");
        return true;
      } catch (error) {
        if (error instanceof RwaAutomationExecutionLeaseError) throw error;
        markExecutionsActivityAmbiguous(state, active, this.now());
        await this.store.writeState(state);
        this.assertExecutionLeaseHeld();
        return false;
      }
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
    if (metadata.version === 1) {
      return this.status({
        metadata,
        stored: true,
        connectionStatus: "unavailable",
        lifecycleStatus: "invalid",
        message: "检测到不支持的旧版凭证格式；必须安全解绑后重新绑定。",
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
      const lifecycleStatus = !valid ? "invalid" as const : "active" as const;
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
        message: !valid ? "Binance Key 当前权限、账户身份或持仓模式不符合只读预检安全门禁。" : null,
        warnings: ipWhitelistWarnings(access.ipWhitelistVerificationMode),
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

  getConnectivitySmokePolicy(accountId: string) {
    return connectivitySmokePolicyDiscovery(accountId);
  }

  assertRiskCapacity() {
    return this.store.assertRiskCapacity();
  }

  async getAccountAssetAuthorization(assetId: string) {
    const profile = requireRwaAutomationExecutionProfile(assetId, "binance");
    const metadata = await this.store.readCredentialMetadata();
    if (!metadata) return null;
    const state = await this.store.readState();
    const active = state.assetAuthorizations.filter((authorization) =>
      authorization.assetId === profile.asset.assetId
      && authorization.profileId === rwaAutomationProfileId(profile)
      && authorization.revokedAt === null);
    if (active.length > 1) throw invalidAccountAssetAuthorization();
    const authorization = active[0];
    if (!authorization) return null;
    if (
      authorization.accountId !== metadata.accountId
      || authorization.accountFingerprint !== metadata.accountFingerprint
    ) throw invalidAccountAssetAuthorization();
    return publicAccountAssetAuthorization(authorization);
  }

  async previewAccountAssetAuthorization(assetId: string) {
    return this.withLock(async () => {
      const profile = requireRwaAutomationExecutionProfile(assetId, "binance");
      const metadata = await this.requireMetadata();
      return this.buildAccountAssetAuthorizationPreview(profile, metadata);
    });
  }

  async createAccountAssetAuthorization(
    assetId: string,
    providedPreview: RwaAccountAssetAuthorizationPreview,
  ) {
    return this.withLock(async () => {
      this.assertExecutionLeaseHeld();
      const profile = requireRwaAutomationExecutionProfile(assetId, "binance");
      const metadata = await this.requireMetadata();
      const provided = validateAccountAssetAuthorizationPreview(providedPreview);
      const current = await this.buildAccountAssetAuthorizationPreview(profile, metadata);
      assertAccountAssetAuthorizationPreview({ provided, current, now: this.now() });
      const state = await this.store.readState();
      if (state.assetAuthorizations.some((authorization) =>
        authorization.assetId === profile.asset.assetId
        && authorization.accountId === metadata.accountId
        && authorization.revokedAt === null)) {
        throw new RwaAccountAssetAuthorizationError(
          409,
          "asset_authorization_invalid",
          "该账户资产授权已启用；如需重新确认，请先撤销现有授权。",
        );
      }
      const latestMetadata = await this.requireMetadata();
      if (
        latestMetadata.accountId !== metadata.accountId
        || latestMetadata.accountFingerprint !== metadata.accountFingerprint
        || latestMetadata.updatedAt !== metadata.updatedAt
      ) throw invalidAccountAssetAuthorization();
      const authorization = createStoredAccountAssetAuthorization({
        userDomain: this.store.userDomain,
        venue: "binance",
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        assetId: profile.asset.assetId,
        preview: provided,
        now: this.now(),
      });
      state.assetAuthorizations.push(authorization);
      await this.store.writeState(state);
      this.assertExecutionLeaseHeld();
      return publicAccountAssetAuthorization(authorization);
    });
  }

  async revokeAccountAssetAuthorization(assetId: string) {
    return this.withLock(async () => {
      this.assertExecutionLeaseHeld();
      const profile = requireRwaAutomationExecutionProfile(assetId, "binance");
      const metadata = await this.requireMetadata();
      const state = await this.store.readState();
      const active = state.assetAuthorizations.filter((authorization) =>
        authorization.assetId === profile.asset.assetId
        && authorization.accountId === metadata.accountId
        && authorization.accountFingerprint === metadata.accountFingerprint
        && authorization.revokedAt === null);
      if (active.length !== 1) throw invalidAccountAssetAuthorization();
      if (state.assetTakeovers.some((takeover) =>
        takeover.authorizationId === active[0]!.authorizationId
        && takeover.state !== "failed"
        && takeover.reservedCapitalUsd > 0)) {
        throw new RwaAccountAssetAuthorizationError(
          409,
          "asset_authorization_invalid",
          "该授权仍绑定已接管的 XAUT 仓位，不能静默撤销；请先完成人工处置。",
        );
      }
      active[0]!.revokedAt = this.now();
      await this.store.writeState(state);
      this.assertExecutionLeaseHeld();
      return publicAccountAssetAuthorization(active[0]!);
    });
  }

  async previewAssetTakeover(input: {
    assetId: string;
    newCapitalUsd: number;
    leverage: RwaAssetTakeoverLeverage;
  }) {
    return this.withLock(async () => {
      await this.assertSelfTestNewRiskAllowed();
      const preview = await this.takeoverCoordinator.preview(input);
      return preview;
    });
  }

  async startAssetTakeover(input: {
    assetId: string;
    preview: RwaAssetTakeoverPreview;
    idempotencyKey: string;
  }) {
    const result = await this.withLock(async () => {
      await this.assertSelfTestNewRiskAllowed();
      return this.takeoverCoordinator.start(input, () =>
        this.assertSelfTestNewRiskAllowed());
    });
    await this.startTakeoverMonitoring();
    return result;
  }

  async reconfirmAssetTakeover(input: {
    takeoverId: string;
    preview: RwaAssetTakeoverPreview;
  }) {
    const result = await this.withLock(async () => {
      await this.assertSelfTestNewRiskAllowed();
      return this.takeoverCoordinator.reconfirm(input, () =>
        this.assertSelfTestNewRiskAllowed());
    });
    await this.startTakeoverMonitoring();
    return result;
  }

  getAssetTakeoverStatus(takeoverId: string) {
    return this.takeoverCoordinator.status(takeoverId);
  }

  getCurrentAssetTakeover() {
    return this.takeoverCoordinator.current();
  }

  getAssetTakeoverAbortContext(input: { takeoverId: string }) {
    return this.takeoverCoordinator.abortContext(input);
  }

  abortAssetTakeover(input: { takeoverId: string }) {
    return this.withLock(() => this.takeoverCoordinator.abortAwaiting(input));
  }

  previewAssetTakeoverExit(input: { takeoverId: string }) {
    return this.withLock(() => this.takeoverCoordinator.previewExit(input));
  }

  confirmAssetTakeoverExit(input: {
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
    idempotencyKey: string;
  }) {
    return this.withLock(() => this.takeoverCoordinator.confirmExit(input));
  }

  getAssetTakeoverExitStatus(takeoverId: string) {
    return this.takeoverCoordinator.exitStatus(takeoverId);
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
      if (previous) {
        throw new RwaNeutralExecutionError(409, "credential_rebind_requires_unbind", "已有 Binance Credential；必须先安全解绑再重新绑定。");
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
        productionSelfTestPermitConfirmation: null,
      };
      state.challenges = [];
      this.armedChallengeIds.clear();
      state.credentialAudit.push({
        userId: this.store.ownerUserId,
        action: "activated",
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

  async deleteCredentials(
    input: unknown = {},
    finalize?: () => Promise<void> | void,
    finalizeRestoreFailure?: (automationStopFailed: boolean) => Promise<void> | void,
  ) {
    this.assertExecutionLeaseHeld();
    const body = record(input);
    assertOnlyKeys(body, ["accountId"]);
    return this.withLock(async () => {
      const credentialSnapshot = await this.store.captureCredentialMutationSnapshot();
      let credentialMutated = false;
      let preserveFailClosedState = false;
      try {
        const metadata = await this.store.readCredentialMetadata();
        const state = await this.store.readState();
        assertRecoveryAutomationStopped(state, this.serverKillSwitchActive());
        if (metadata) {
          assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
          let snapshot;
          try {
            snapshot = await this.client().then((client) => client.readPreflightSnapshot());
          } catch {
            state.credentialLifecycle = "invalid";
            state.credentialAlert = "Binance 凭证不可用，无法确认账户风险敞口。";
            state.config.killSwitchActive = true;
            credentialMutated = true;
            preserveFailClosedState = true;
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
        stopAutomationForCredentialRemoval(state);
        state.credentialLifecycle = "unconfigured";
        state.credentialAlert = null;
        invalidateAccountAssetAuthorizations(state.assetAuthorizations, this.now());
        credentialMutated = true;
        await this.store.writeState(state);
        await this.store.deleteCredentials();
        const credentials = await this.getCredentialStatus();
        await finalize?.();
        this.armedChallengeIds.clear();
        return { ok: true, credentials };
      } catch (error) {
        if (!credentialMutated || preserveFailClosedState) throw error;
        try {
          await this.store.restoreCredentialMutationSnapshot(credentialSnapshot);
        } catch {
          let automationStopFailed = false;
          try {
            await this.markCredentialRecoveryInconsistentLocked();
          } catch {
            automationStopFailed = true;
          }
          await finalizeRestoreFailure?.(automationStopFailed);
          throw new RwaNeutralExecutionError(
            503,
            "credential_restore_failed",
            "Credential 恢复失败；Binding 一致性无法确认，已停止自动化并等待人工处理。",
            { automationStopFailed },
          );
        }
        throw error;
      }
    });
  }

  async recoveryUnbind(
    finalize?: (result: { providerVerifiedFlat: boolean }) => Promise<void> | void,
    finalizeRestoreFailure?: (automationStopFailed: boolean) => Promise<void> | void,
  ) {
    this.assertExecutionLeaseHeld();
    return this.withLock(async () => {
      const credentialSnapshot = await this.store.captureCredentialMutationSnapshot();
      let credentialMutated = false;
      let providerStateUnknown = false;
      try {
        const metadata = await this.store.readCredentialMetadata();
        if (!metadata) throw new RwaNeutralExecutionError(409, "credentials_unconfigured", "Binance API 凭证尚未配置。");
        const state = await this.store.readState();
        assertRecoveryAutomationStopped(state, this.serverKillSwitchActive());
        let providerVerifiedFlat = false;
        try {
          const snapshot = await this.client().then((client) => client.readPreflightSnapshot());
          if (
            snapshot.existingSpotQuantityXaut > 1e-9
            || snapshot.existingPerpetualQuantityXaut > 1e-9
            || snapshot.openSpotOrderCount > 0
            || snapshot.openPerpetualOrderCount > 0
          ) {
            throw new RwaNeutralExecutionError(
              409,
              "credential_delete_blocked",
              "Binance 账户存在受管理订单或仓位，Recovery Unbind 已拒绝。",
            );
          }
          providerVerifiedFlat = true;
        } catch (error) {
          if (error instanceof RwaNeutralExecutionError) throw error;
          providerStateUnknown = true;
        }
        state.config = {
          ...state.config,
          globalExecutionEnabled: false,
          strategyEnabled: false,
          killSwitchActive: true,
          productionSelfTestPermitConfirmation: null,
        };
        state.challenges = [];
        state.credentialLifecycle = "unconfigured";
        state.credentialAlert = providerVerifiedFlat
          ? null
          : "Provider 状态无法验证；系统已停止管理，但不能证明 Binance 账户已经清算。";
        invalidateAccountAssetAuthorizations(state.assetAuthorizations, this.now());
        credentialMutated = true;
        await this.store.writeState(state);
        await this.store.deleteCredentials();
        const result = { providerVerifiedFlat };
        await finalize?.(result);
        this.armedChallengeIds.clear();
        return result;
      } catch (error) {
        if (!credentialMutated) throw error;
        try {
          await this.store.restoreCredentialMutationSnapshot(credentialSnapshot);
        } catch {
          let automationStopFailed = false;
          try {
            await this.markCredentialRecoveryInconsistentLocked();
          } catch {
            automationStopFailed = true;
          }
          await finalizeRestoreFailure?.(automationStopFailed);
          throw new RwaNeutralExecutionError(
            503,
            "credential_restore_failed",
            "Credential 恢复失败；Binding 一致性无法确认，已停止自动化并等待人工处理。",
            { automationStopFailed },
          );
        }
        if (providerStateUnknown) await this.markProviderUnknownFailClosedLocked();
        throw error;
      }
    });
  }

  async markCredentialRecoveryInconsistent() {
    this.assertExecutionLeaseHeld();
    return this.withLock(() => this.markCredentialRecoveryInconsistentLocked());
  }

  private async markCredentialRecoveryInconsistentLocked() {
    const state = await this.store.readState();
    stopAutomationForCredentialRemoval(state);
    state.credentialLifecycle = "invalid";
    state.credentialAlert = "Recovery Unbind 回滚失败；凭证与 Binding 一致性无法确认，等待人工处理。";
    invalidateAccountAssetAuthorizations(state.assetAuthorizations, this.now());
    await this.store.writeState(state);
    this.armedChallengeIds.clear();
  }

  private async markProviderUnknownFailClosedLocked() {
    const state = await this.store.readState();
    stopAutomationForCredentialRemoval(state);
    state.credentialLifecycle = "invalid";
    state.credentialAlert = "Provider 状态无法验证；系统已停止管理，但不能证明 Binance 账户已经清算。";
    invalidateAccountAssetAuthorizations(state.assetAuthorizations, this.now());
    await this.store.writeState(state);
    this.armedChallengeIds.clear();
  }

  async getConfig() {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    return publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive());
  }

  async updateConfig(input: unknown) {
    return this.withLock(() => this.updateConfigLocked(input));
  }

  private async updateConfigLocked(input: unknown) {
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
      "accountIsolationMode",
    ]);
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    if (metadata) assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
    const next = { ...state.config };
    if ("globalExecutionEnabled" in body) next.globalExecutionEnabled = booleanField(body.globalExecutionEnabled, "globalExecutionEnabled");
    if ("strategyEnabled" in body) next.strategyEnabled = booleanField(body.strategyEnabled, "strategyEnabled");
    if ("accountIsolationMode" in body) {
      next.accountIsolationMode = binanceAccountIsolationMode(body.accountIsolationMode);
      next.accountIsolationConfirmedAt = this.now();
      next.productionSelfTestPermitConfirmation = null;
    }
    let activeMetadata: BinanceCredentialMetadata | null = null;
    let activeAccess: Awaited<ReturnType<RwaBinanceClient["validateAccess"]>> | null = null;
    if (body.globalExecutionEnabled === true || body.strategyEnabled === true) {
      this.assertExecutionLeaseHeld();
      activeMetadata = await this.requireMetadata();
      activeAccess = await this.validateActiveAccess(
        await this.clientForNewRisk(state, activeMetadata),
        activeMetadata.accountId,
        state,
      );
    }
    if (
      this.productionEnvironment()
      && next.accountIsolationMode === "development_exclusive_account"
      && body.accountIsolationMode !== undefined
    ) {
      activeMetadata ??= await this.requireMetadata();
      activeAccess ??= await this.validateActiveAccess(
        await this.clientForNewRisk(state, activeMetadata),
        activeMetadata.accountId,
        state,
      );
      next.productionSelfTestPermitConfirmation = this.confirmProductionSelfTestPermit(
        activeMetadata,
        activeAccess,
      );
    }
    if (
      body.globalExecutionEnabled === true
      || body.strategyEnabled === true
    ) {
      this.assertProductionSelfTestPermit(next, activeMetadata!, activeAccess!);
    }
    assignRange(
      next,
      body,
      "maxStrategyCapitalUsd",
      1,
      XAUT_BINANCE_PROFILE.asset.currentStageRiskLimits!.maxAssetCapitalUsd,
    );
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
    return this.withLock(() => this.setKillSwitchLocked(active, accountId));
  }

  private async setKillSwitchLocked(active: boolean, accountId?: string) {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    if (metadata) assertAccountId(requiredString(accountId, "accountId", 100), metadata.accountId);
    if (!active) {
      this.assertExecutionLeaseHeld();
      const activeMetadata = await this.requireMetadata();
      const access = await this.validateActiveAccess(
        await this.clientForNewRisk(state, activeMetadata),
        activeMetadata.accountId,
        state,
      );
      this.assertProductionSelfTestPermit(state.config, activeMetadata, access);
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
    return this.withLock(() => this.getPnlLocked());
  }

  private async getPnlLocked() {
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

  async getReconciliation(input: unknown = {}) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "reconciliationId"]);
    const metadata = await this.requireMetadata();
    const accountId = requiredString(body.accountId ?? metadata.accountId, "accountId", 100);
    assertAccountId(accountId, metadata.accountId);
    const state = await this.store.readState();
    const execution = selectReconciliationExecution(state.executions, body.reconciliationId);
    if (!execution) {
      return {
        accountId: metadata.accountId,
        items: [],
        phase: "execution_capable",
        providerWritesEnabled: true,
      };
    }
    const client = await this.client();
    const preview = await this.buildReconciliationPreview(client, execution);
    execution.reconciliation = preview;
    await this.store.writeState(state);
    return {
      accountId: metadata.accountId,
      items: [preview],
      phase: "execution_capable",
      providerWritesEnabled: true,
    };
  }

  async finalizeReconciliation(input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "reconciliationId", "idempotencyKey"]);
    const metadata = await this.requireMetadata();
    const accountId = requiredString(body.accountId, "accountId", 100);
    const reconciliationId = requiredString(body.reconciliationId, "reconciliationId", 100);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    if (!/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) {
      throw new RwaNeutralExecutionError(400, "invalid_request", "idempotencyKey 格式无效。");
    }
    assertAccountId(accountId, metadata.accountId);
    const scopedIdempotencyKey = `${this.store.userDomain}:binance:${accountId}:${reconciliationId}:${idempotencyKey}`;
    const requestFingerprint = hash(JSON.stringify({
      accountId,
      reconciliationId,
      idempotencyKey,
      venue: "binance",
      userDomain: this.store.userDomain,
    }));
    return this.withLock(async () => {
      const state = await this.store.readState();
      const execution = state.executions.find((item) => item.executionId === reconciliationId && item.accountId === accountId);
      if (!execution) throw new RwaNeutralExecutionError(404, "reconciliation_not_found", "对账记录不存在或不属于当前账户。");
      if (execution.finalizeIdempotency?.scopedKey === scopedIdempotencyKey) {
        if (execution.finalizeIdempotency.requestFingerprint !== requestFingerprint) {
          throw new RwaNeutralExecutionError(409, "idempotency_conflict", "相同幂等键与既有人工结案请求不一致。");
        }
        return redactExecution(execution);
      }
      if (execution.finalizeIdempotency) {
        throw new RwaNeutralExecutionError(409, "reconciliation_already_finalized", "该对账记录已人工结案；如需复核请使用既有幂等键结果。");
      }
      const client = await this.client();
      const preview = await this.buildReconciliationPreview(client, execution);
      if (!preview.canFinalize) {
        throw new RwaNeutralExecutionError(409, "reconciliation_blocked", "当前对账结果仍不允许人工结案。", { blockingReasons: preview.blockingReasons });
      }
      const resultState = preview.dustResidual.spot || preview.dustResidual.perpetual ? "reconciled" : "closed";
      execution.state = resultState;
      execution.reconciliation = preview;
      execution.finalizeIdempotency = {
        scopedKey: scopedIdempotencyKey,
        requestFingerprint,
        resultState,
        completedAt: this.now(),
      };
      execution.message = preview.dustResidual.spot || preview.dustResidual.perpetual
        ? "交易所权威对账确认仅剩不可交易残余，已按人工结案完成记录。"
        : "交易所权威对账确认双腿已关闭，已完成人工结案。";
      execution.errorCategory = null;
      execution.updatedAt = this.now();
      await this.store.writeState(state);
      return redactExecution(execution);
    });
  }

  async getAudit() {
    const state = await this.store.readState();
    return {
      items: state.credentialAudit.slice(-200).reverse(),
      connectivitySmoke: state.connectivitySmokes.slice(-100).reverse().map((smoke) => ({
        smokeId: smoke.smokeId,
        purpose: smoke.purpose,
        accountFingerprint: smoke.accountFingerprint,
        stage: smoke.stage,
        budgetUsd: smoke.budget.totalCapitalUsd,
        providerMutationCount: smoke.providerMutationCount,
        errorCategory: smoke.errorCategory,
        createdAt: smoke.createdAt,
        updatedAt: smoke.updatedAt,
      })),
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
      const access = await this.validateActiveAccess(client, accountId, state);
      this.assertProductionSelfTestPermit(state.config, metadata, access);
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
        await this.riskExposures(state),
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

  async preflightConnectivitySmoke(
    accountId: string,
    policyAcceptance: RwaConnectivitySmokePolicyAcceptance,
  ) {
    this.assertExecutionLeaseHeld();
    try {
      assertConnectivitySmokePolicyAcceptance(policyAcceptance);
    } catch {
      throw new RwaNeutralExecutionError(400, "connectivity_smoke_policy_invalid", "connectivity smoke 运维窗口承诺无效或已过期。");
    }
    return this.withLock(async () => {
      const state = await this.store.readState();
      this.assertEntrySwitches(state.config);
      if (state.connectivitySmokes.some(isActiveConnectivitySmoke)) {
        throw new RwaNeutralExecutionError(409, "connectivity_smoke_active", "当前账户已有进行中的连通性烟测。");
      }
      if (
        state.executions.some((item) => !["closed", "reconciled", "failed"].includes(item.state))
        || state.assetTakeovers.some((item) => !["failed", "exited"].includes(item.state))
      ) {
        throw new RwaNeutralExecutionError(
          409,
          "connectivity_smoke_account_not_exclusive",
          "当前账户存在其他自动执行或资产接管状态，禁止开启独占烟测窗口。",
        );
      }
      const metadata = await this.requireMetadata();
      assertAccountId(accountId, metadata.accountId);
      const client = await this.clientForNewRisk(state, metadata);
      const access = await this.validateActiveAccess(client, accountId, state);
      this.assertProductionSelfTestPermit(state.config, metadata, access);
      const snapshot = await client.readPreflightSnapshot()
        .catch((error) => { throw providerError(error, "Binance smoke preflight 读取失败。"); });
      assertAccountId(snapshot.accountId, accountId);
      const approvedCapitalUsd = this.approvedConnectivitySmokeCapital(
        state.config,
        metadata,
        access,
      );
      const budget = calculateConnectivitySmokeBudget(
        snapshot,
        state.config.maxCombinedSlippageBps,
        approvedCapitalUsd,
      );
      await this.assertProposedRiskCapacity(state, accountId, budget.totalCapitalUsd);
      const checks = smokePreflightChecks(snapshot, budget, this.now());
      const generatedAt = this.now();
      const report: RwaConnectivitySmokeChallengeReport = {
        purpose: RWA_CONNECTIVITY_SMOKE_PURPOSE,
        mode: "connectivity_smoke",
        venue: "binance",
        network: "binance_mainnet",
        accountId,
        accountFingerprint: snapshot.accountFingerprint,
        symbol: "XAUTUSDT",
        policy: {
          version: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
          digest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
          accepted: true,
          continuity: "nonAtomic/incomplete",
        },
        budget,
        checks,
        passed: checks.every((item) => item.passed),
        generatedAt,
        expiresAt: generatedAt + challengeTtlMs,
      };
      if (!report.passed) {
        throw new RwaNeutralExecutionError(
          409,
          "connectivity_smoke_preflight_rejected",
          "Binance 连通性烟测 preflight 未通过，provider 写调用保持为 0。",
          { report },
        );
      }
      const challengeId = randomBytes(18).toString("base64url");
      const challengeToken = randomBytes(32).toString("base64url");
      this.armedSmokeChallenges.set(challengeId, { tokenHash: hash(challengeToken), report });
      return { challengeId, challengeToken, expiresAt: report.expiresAt, report };
    });
  }

  async executeConnectivitySmoke(input: unknown) {
    this.assertExecutionLeaseHeld();
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "challengeId", "challengeToken", "idempotencyKey", "requestDigest", "policyVersion", "policyDigest"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const challengeId = requiredString(body.challengeId, "challengeId", 100);
    const challengeToken = requiredString(body.challengeToken, "challengeToken", 200);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    const requestDigest = requiredString(body.requestDigest, "requestDigest", 100);
    if (body.policyVersion !== RWA_CONNECTIVITY_SMOKE_POLICY_VERSION
      || body.policyDigest !== RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST) {
      throw new RwaNeutralExecutionError(409, "connectivity_smoke_policy_mismatch", "smoke policy 与 preflight 不匹配。");
    }
    if (!/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) {
      throw new RwaNeutralExecutionError(400, "invalid_request", "idempotencyKey 格式无效。");
    }
    const scopedKey = `${this.store.userDomain}:smoke:${idempotencyKey}`;
    return this.withLock(async () => {
      const state = await this.store.readState();
      const existing = state.connectivitySmokes.find((item) => item.idempotencyKey === scopedKey);
      if (existing) {
        if (existing.challengeId !== challengeId || existing.accountId !== accountId
          || existing.requestDigest !== requestDigest) {
          throw new RwaNeutralExecutionError(409, "idempotency_conflict", "幂等键已用于其他烟测。");
        }
        return publicConnectivitySmoke(existing);
      }
      const permit = this.requireConfirmedProductionSelfTestPermitForConsumption(state.config);
      if (permit && state.productionSelfTestPermitConsumptions.some((item) =>
        item.permitId === permit.permitId || item.digest === permit.digest
      )) {
        throw new RwaNeutralExecutionError(
          409,
          "production_self_test_permit_consumed",
          "Production self-test Permit 已消费，禁止用于新的连通性烟测请求。",
        );
      }
      if (state.connectivitySmokes.some(isActiveConnectivitySmoke)) {
        throw new RwaNeutralExecutionError(409, "connectivity_smoke_active", "当前账户已有进行中的连通性烟测。");
      }
      this.assertEntrySwitches(state.config);
      const armed = this.armedSmokeChallenges.get(challengeId);
      if (!armed || armed.tokenHash !== hash(challengeToken) || armed.report.expiresAt <= this.now()) {
        throw new RwaNeutralExecutionError(409, "challenge_invalid", "烟测 challenge 无效、已过期或已使用。");
      }
      assertAccountId(accountId, armed.report.accountId);
      this.armedSmokeChallenges.delete(challengeId);
      const now = this.now();
      const smoke: RwaConnectivitySmokeRecord = {
        smokeId: randomBytes(18).toString("base64url"),
        userId: this.store.ownerUserId,
        accountId,
        accountFingerprint: armed.report.accountFingerprint,
        purpose: RWA_CONNECTIVITY_SMOKE_PURPOSE,
        mode: "connectivity_smoke",
        idempotencyKey: scopedKey,
        challengeId,
        requestDigest,
        policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
        policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
        orderLinkPrefix: newSmokeOrderPrefix(this.store.userDomain),
        stage: "reserved",
        budget: armed.report.budget,
        authorization: {
          operation: "connectivity_smoke_execute",
          consumedBeforeProviderMutation: true,
          exitAuthorized: true,
          reservedAt: now,
          ...(permit ? { capitalTest: {
            accountBindingSha256: permit.accountBindingSha256,
            revision: permit.revision,
            approvedCapitalUsd: permit.approvedCapitalUsd,
            expiresAt: permit.expiresAt,
            leverage: permit.leverage,
            maxPositionUsd: permit.maxPositionUsd,
            maxOrderSizeUsd: permit.maxOrderSizeUsd,
            maxOrderCount: permit.maxOrderCount,
            maxSlippageBps: permit.maxSlippageBps,
            maxFeeBps: permit.maxFeeBps,
            lossLimitUsd: permit.lossLimitUsd,
            executionId: permit.executionId,
            authorizationDigest: permit.authorizationDigest,
            permitDigest: permit.digest,
          } } : {}),
        },
        spotOpenOrder: null,
        futuresOpenOrder: null,
        openedSpotQuantityXaut: 0,
        openedFuturesQuantityXaut: 0,
        exit: {
          futuresCloseOrder: null,
          spotCloseOrder: null,
          futuresFlatConfirmed: false,
          spotFlatConfirmed: false,
        },
        providerState: unavailableSmokeProviderState("not_yet_observed"),
        timeline: [{ stage: "reserved", at: now, code: "reserved" }],
        receipt: null,
        noReopen: true,
        providerMutationCount: 0,
        errorCategory: null,
        message: "连通性烟测已预留；失败或重启后禁止重新开仓。",
        createdAt: now,
        updatedAt: now,
      };
      this.assertExecutionLeaseHeld();
      if (permit) {
        state.productionSelfTestPermitConsumptions.push({
          permitId: permit.permitId,
          digest: permit.digest,
          consumedAt: now,
        });
      }
      state.connectivitySmokes.push(smoke);
      await this.store.writeState(state);
      await this.assertPersistedCapitalTestReservation(smoke, permit);
      let client: RwaBinanceClient | null = null;
      try {
        const metadata = await this.requireMetadata();
        client = await this.clientForNewRisk(state, metadata, true);
        const access = await this.validateActiveAccess(client, accountId, state);
        this.assertProductionSelfTestPermit(state.config, metadata, access);
        const snapshot = await this.verifyConnectivitySmokeWindow(
          client, state, smoke, "blank", null, true,
        );
        const approvedCapitalUsd = this.approvedConnectivitySmokeCapital(
          state.config,
          metadata,
          access,
        );
        const budget = calculateConnectivitySmokeBudget(
          snapshot,
          state.config.maxCombinedSlippageBps,
          approvedCapitalUsd,
        );
        await this.assertProposedRiskCapacity(state, accountId, budget.totalCapitalUsd);
        if (!sameSmokeBudget(budget, smoke.budget) || !smokePreflightChecks(snapshot, budget, this.now()).every((item) => item.passed)) {
          throw new RwaNeutralExecutionError(409, "connectivity_smoke_preflight_changed", "烟测执行前规则、余额或价格已变化。");
        }
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "blank", null, true);
        await this.openAndImmediatelyCloseConnectivitySmoke(client, state, smoke, snapshot);
      } catch (error) {
        smoke.errorCategory = errorCategory(error);
        smoke.message = sanitizeRwaAutomationError(error);
        if (isProviderActivityStop(error)) {
          smoke.stage = "manual_intervention";
          smoke.message = "Binance 账户活动或用户流无法确认，烟测已停止且不会自动撤单或平仓；必须人工核对。";
          state.config.globalExecutionEnabled = false;
          state.config.strategyEnabled = false;
          state.config.killSwitchActive = true;
        } else if (client && (
          smoke.providerMutationCount > 0
          || (
            smoke.errorCategory !== "connectivity_smoke_provider_snapshot_stale"
            && smoke.errorCategory !== "connectivity_smoke_leverage_not_1x"
          )
        )) {
          try {
            await this.reduceConnectivitySmokeRisk(client, state, smoke);
          } catch (recoveryError) {
            smoke.stage = "manual_intervention";
            smoke.errorCategory = errorCategory(recoveryError);
            smoke.message = "烟测状态无法由 provider 权威确认或退出，必须在 Binance 人工处理。";
            state.config.killSwitchActive = true;
          }
        } else if (!client) {
          smoke.stage = "manual_intervention";
          state.config.killSwitchActive = true;
        }
        if (
          smoke.errorCategory === "connectivity_smoke_leverage_not_1x"
          && smoke.providerMutationCount === 0
        ) {
          smoke.stage = "failed";
        } else if (smoke.stage === "reserved" && smoke.providerMutationCount === 0) {
          smoke.stage = "failed";
        }
        appendConnectivitySmokeTimeline(smoke, this.now());
        smoke.updatedAt = this.now();
        await this.store.writeState(state);
      }
      return publicConnectivitySmoke(smoke);
    });
  }

  async getConnectivitySmokeStatus(smokeId?: string) {
    const state = await this.store.readState();
    const smoke = smokeId
      ? state.connectivitySmokes.find((item) => item.smokeId === smokeId)
      : state.connectivitySmokes.at(-1);
    return smoke ? publicConnectivitySmoke(smoke) : null;
  }

  async getConnectivitySmokeReceipt(smokeId: string) {
    const state = await this.store.readState();
    const smoke = state.connectivitySmokes.find((item) => item.smokeId === smokeId);
    if (!smoke) throw new RwaNeutralExecutionError(404, "connectivity_smoke_not_found", "连通性烟测记录不存在。");
    if (!smoke.receipt) throw new RwaNeutralExecutionError(409, "connectivity_smoke_incomplete", "连通性烟测尚未形成 flat receipt。");
    return publicConnectivitySmokeReceipt(smoke);
  }

  async findConnectivitySmokeIdempotent(input: {
    accountId: string;
    challengeId: string;
    idempotencyKey: string;
    requestDigest: string;
  }) {
    const state = await this.store.readState();
    const scopedKey = `${this.store.userDomain}:smoke:${input.idempotencyKey}`;
    const smoke = state.connectivitySmokes.find((item) => item.idempotencyKey === scopedKey);
    if (!smoke) return null;
    if (
      smoke.accountId !== input.accountId
      || smoke.challengeId !== input.challengeId
      || smoke.requestDigest !== input.requestDigest
    ) throw new RwaNeutralExecutionError(409, "idempotency_conflict", "smoke 幂等键与持久请求范围冲突。");
    return publicConnectivitySmoke(smoke);
  }

  async lookupConnectivitySmokeExecution(input: {
    accountId: string;
    challengeId: string;
    idempotencyKey: string;
  }) {
    const state = await this.store.readStateView();
    const scopedKey = `${this.store.userDomain}:smoke:${input.idempotencyKey}`;
    const smoke = state.connectivitySmokes.find((item) => item.idempotencyKey === scopedKey);
    if (
      !smoke
      || smoke.accountId !== input.accountId
      || smoke.challengeId !== input.challengeId
    ) return null;
    return publicConnectivitySmoke(smoke);
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
      this.assertProductionSelfTestPermitConnectivitySmokeOnly(state.config);
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
        venue: "binance",
        reservedCapitalUsd: challenge.report.estimatedCapitalRequiredUsd,
      });
      state.executions.push(execution);
      await this.store.writeState(state);
      try {
        await this.assertReservedRiskCapacity(state, execution);
      } catch (error) {
        execution.state = "failed";
        execution.errorCategory = errorCategory(error);
        execution.message = sanitizeRwaAutomationError(error);
        execution.reservedCapitalUsd = 0;
        execution.updatedAt = this.now();
        await this.store.writeState(state);
        throw error;
      }
      this.assertExecutionLeaseHeld();
      let client: RwaBinanceClient | null = null;
      try {
        const metadata = await this.requireMetadata();
        client = await this.clientForNewRisk(state, metadata);
        const access = await this.validateActiveAccess(client, accountId, state);
        this.assertProductionSelfTestPermit(state.config, metadata, access);
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
          await this.riskExposures(state),
        );
        if (!report.passed) throw new RwaNeutralExecutionError(409, "preflight_changed", "执行前实时条件已变化，禁止建立对冲组合。");
        execution.reservedCapitalUsd = report.estimatedCapitalRequiredUsd;
        execution.updatedAt = this.now();
        await this.store.writeState(state);
        await this.assertReservedRiskCapacity(state, execution);
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
          if (isProviderActivityStop(error)) {
            execution.state = "manual_intervention";
            execution.message = "Binance 账户活动或用户流无法确认，已停止自动执行且不会自动撤单或平仓；必须人工核对。";
            state.config.globalExecutionEnabled = false;
            state.config.strategyEnabled = false;
            state.config.killSwitchActive = true;
            execution.updatedAt = this.now();
            await this.store.writeState(state);
            return redactExecution(execution);
          }
          if (client && hasNoStrategyExposureOrOrders(execution)) {
            try {
              this.assertExecutionLeaseHeld();
              execution.state = "failed";
              execution.reservedCapitalUsd = 0;
              execution.updatedAt = this.now();
              await this.store.writeState(state);
              return redactExecution(execution);
            } catch {
              // Lease or persistence uncertainty keeps the recovery path fail-closed.
            }
          }
          try {
            if (!client) throw error;
            this.assertExecutionLeaseHeld();
            execution.state = "compensating";
            await this.persistExecution(state, execution);
            await this.hedgeEngine.closeAll(
              client,
              execution.orderLinkPrefix,
              `${execution.orderLinkPrefix}x`,
              trackedExposureFromExecution(execution),
              (side, order) => this.persistCloseFill(state, [execution.executionId], side, order.positionQuantityXaut ?? order.filledQuantityXaut),
              (snapshot) => this.persistActivitySnapshot(state, [execution.executionId], snapshot),
              (side, orderId) => this.persistProviderOrder(state, [execution.executionId], side, orderId),
            );
            const fullyClosed = finalizeTrackedExecutions(state, [execution.executionId], this.now());
            execution.state = fullyClosed ? "failed" : "partial_closed";
            execution.message = fullyClosed
              ? "对冲未完成，已按 Binance 权威状态撤单并退出未对冲敞口。"
              : "对冲未完成且仍存在不可交易的策略残余，需要人工核对。";
            if (!fullyClosed) state.config.killSwitchActive = true;
          } catch {
            execution.state = "manual_intervention";
            execution.message = "自动建立或退出对冲组合未能闭环，需要当前用户在 Binance 人工处理。";
            state.config.killSwitchActive = true;
          }
          execution.updatedAt = this.now();
          await this.store.writeState(state);
        }
      }
      if (execution.state === "hedged") void this.startStrategyActivityMonitoring();
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
      const trackedExposure = trackedExposureFromState(
        state.executions,
        rwaAutomationProfileId(XAUT_BINANCE_PROFILE),
      );
      const execution = createNeutralExecutionRecord({
        userId: this.store.ownerUserId,
        accountId,
        userOrderPrefix: this.strategyOrderPrefix,
        idempotencyKey: scopedIdempotencyKey,
        challengeId: "close-all",
        now: this.now(),
        venue: "binance",
      });
      execution.state = "compensating";
      execution.message = "正在退出现货与永续对冲组合。";
      state.executions.push(execution);
      await this.store.writeState(state);
      this.assertExecutionLeaseHeld();
      try {
        await this.hedgeEngine.closeAll(
          client,
          this.strategyOrderPrefix,
          execution.orderLinkPrefix,
          trackedExposure,
          (side, order) => this.persistCloseFill(state, trackedExposure.sourceExecutionIds, side, order.positionQuantityXaut ?? order.filledQuantityXaut),
          (snapshot) => this.persistActivitySnapshot(state, trackedExposure.sourceExecutionIds, snapshot),
          (side, orderId) => this.persistProviderOrder(state, trackedExposure.sourceExecutionIds, side, orderId),
        );
        const fullyClosed = finalizeTrackedExecutions(state, trackedExposure.sourceExecutionIds, this.now());
        execution.state = fullyClosed ? "closed" : "partial_closed";
        execution.reconciliation = await this.buildReconciliationPreview(client, execution);
        execution.message = fullyClosed
          ? "策略订单已撤销，现货与永续两侧仓位已退出并确认。"
          : "策略订单已撤销，但仍存在不可交易的策略残余，需要人工核对。";
        if (!fullyClosed) state.config.killSwitchActive = true;
      } catch (error) {
        execution.reconciliation = await this.safeReconciliationPreview(client, execution);
        execution.state = execution.reconciliation && hasPartialClose(execution.reconciliation)
          ? "partial_closed"
          : "manual_intervention";
        execution.errorCategory = errorCategory(error);
        execution.message = "自动退出对冲组合未能闭环，需要当前用户在 Binance 人工处理。";
        state.config.killSwitchActive = true;
      }
      execution.updatedAt = this.now();
      await this.store.writeState(state);
      return redactExecution(execution);
    });
  }

  private async openAndImmediatelyCloseConnectivitySmoke(
    client: RwaBinanceClient,
    state: RwaAutomationStateData,
    smoke: RwaConnectivitySmokeRecord,
    snapshot: RwaBinancePreflightSnapshot,
  ) {
    smoke.stage = "spot_opening";
    await this.persistConnectivitySmoke(state, smoke);
    await this.verifyConnectivitySmokeWindow(client, state, smoke, "blank", null, true);
    this.assertExecutionLeaseHeld();
    await this.prepareSmokeProviderMutation(client, smoke, "place_spot_order", {
      orderLinkId: `${smoke.orderLinkPrefix}s1`,
    });
    const acceptedSpot = await client.placeOrder({
      category: "spot",
      symbol: "XAUTUSDT",
      side: "Buy",
      quantityXaut: smoke.budget.quantityXaut,
      limitPrice: smoke.budget.prices.spotOpenLimit,
      reduceOnly: false,
      orderLinkId: `${smoke.orderLinkPrefix}s1`,
    });
    smoke.providerMutationCount += 1;
    await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", {
      category: "spot",
      orderLinkId: `${smoke.orderLinkPrefix}s1`,
      providerOrderId: acceptedSpot.orderId,
    });
    const spot = await client.awaitOrder("spot", acceptedSpot.orderId, this.now() + 4_000);
    smoke.spotOpenOrder = spot;
    smoke.openedSpotQuantityXaut = orderPositionQuantity(spot);
    smoke.stage = "spot_open";
    await this.persistConnectivitySmoke(state, smoke);
    if (spot.status === "New" || spot.status === "PartiallyFilled") {
      this.assertExecutionLeaseHeld();
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "spot_only", {
        category: "spot",
        orderLinkId: `${smoke.orderLinkPrefix}s1`,
        providerOrderId: spot.orderId,
      });
      await this.prepareSmokeProviderMutation(client, smoke, "cancel_spot_order", {
        orderLinkId: spot.orderLinkId,
        providerOrderId: spot.orderId,
      });
      await client.cancelOrder("spot", spot.orderId);
      smoke.providerMutationCount += 1;
      const terminal = await client.findOrderByClientOrderId?.("spot", spot.orderLinkId);
      if (!terminal || terminal.status === "New" || terminal.status === "PartiallyFilled" || terminal.status === "Unknown") {
        throw new RwaNeutralExecutionError(409, "connectivity_smoke_provider_state_unknown", "Spot IOC 撤余量后无法确认订单终态。");
      }
      smoke.spotOpenOrder = terminal;
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "spot_only");
    }
    if (smoke.openedSpotQuantityXaut <= 1e-12) {
      await this.confirmConnectivitySmokeFlat(client, state, smoke, "failed", "现货 IOC 零成交，烟测未建立风险。");
      return;
    }
    const afterSpot = await this.verifyConnectivitySmokeWindow(client, state, smoke, "spot_only");
    const futuresQuantity = floorStep(smoke.openedSpotQuantityXaut, afterSpot.perpetual.qtyStep);
    if (
      futuresQuantity < afterSpot.perpetual.minOrderQty
      || futuresQuantity * afterSpot.perpetual.bid < afterSpot.perpetual.minNotionalUsd
    ) {
      await this.reduceConnectivitySmokeRisk(client, state, smoke);
      return;
    }
    smoke.stage = "futures_opening";
    await this.persistConnectivitySmoke(state, smoke);
    await this.verifyConnectivitySmokeWindow(client, state, smoke, "spot_only", null, true);
    this.assertExecutionLeaseHeld();
    await this.prepareSmokeProviderMutation(client, smoke, "place_futures_order", {
      orderLinkId: `${smoke.orderLinkPrefix}p1`,
    });
    const acceptedFutures = await client.placeOrder({
      category: "linear",
      symbol: "XAUTUSDT",
      side: "Sell",
      quantityXaut: futuresQuantity,
      limitPrice: smoke.budget.prices.futuresOpenLimit,
      reduceOnly: false,
      orderLinkId: `${smoke.orderLinkPrefix}p1`,
    });
    smoke.providerMutationCount += 1;
    await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", {
      category: "linear",
      orderLinkId: `${smoke.orderLinkPrefix}p1`,
      providerOrderId: acceptedFutures.orderId,
    });
    const futures = await client.awaitOrder("linear", acceptedFutures.orderId, this.now() + 4_000);
    smoke.futuresOpenOrder = futures;
    smoke.openedFuturesQuantityXaut = orderPositionQuantity(futures);
    await this.persistConnectivitySmoke(state, smoke);
    if (futures.status === "New" || futures.status === "PartiallyFilled") {
      this.assertExecutionLeaseHeld();
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "hedged", {
        category: "linear",
        orderLinkId: `${smoke.orderLinkPrefix}p1`,
        providerOrderId: futures.orderId,
      });
      await this.prepareSmokeProviderMutation(client, smoke, "cancel_futures_order", {
        orderLinkId: futures.orderLinkId,
        providerOrderId: futures.orderId,
      });
      await client.cancelOrder("linear", futures.orderId);
      smoke.providerMutationCount += 1;
      const terminal = await client.findOrderByClientOrderId?.("linear", futures.orderLinkId);
      if (!terminal || terminal.status === "New" || terminal.status === "PartiallyFilled" || terminal.status === "Unknown") {
        throw new RwaNeutralExecutionError(409, "connectivity_smoke_provider_state_unknown", "Futures IOC 撤余量后无法确认订单终态。");
      }
      smoke.futuresOpenOrder = terminal;
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "hedged");
    }
    const hedged = await this.verifyConnectivitySmokeWindow(client, state, smoke, "hedged");
    const netDeltaUsd = Math.abs(smoke.openedSpotQuantityXaut - smoke.openedFuturesQuantityXaut)
      * Math.max(hedged.spot.bid, hedged.perpetual.ask);
    if (smoke.openedFuturesQuantityXaut <= 1e-12 || netDeltaUsd > 5) {
      throw new RwaNeutralExecutionError(409, "connectivity_smoke_hedge_incomplete", "provider 未权威确认 smoke 已形成允许的 hedge。");
    }
    smoke.stage = "hedged";
    smoke.message = "provider 已权威确认 hedged；立即进入风险降低退出。";
    await this.persistConnectivitySmoke(state, smoke);
    await this.reduceConnectivitySmokeRisk(client, state, smoke);
  }

  private async reduceConnectivitySmokeRisk(
    client: RwaBinanceClient,
    state: RwaAutomationStateData,
    smoke: RwaConnectivitySmokeRecord,
  ) {
    const current = await this.verifyConnectivitySmokeWindow(
      client,
      state,
      smoke,
      "within_ledger",
      recoveryAllowedSmokeOpenOrder(smoke),
    );
    const deadline = this.now() + 8_000;
    if (current.existingPerpetualQuantityXaut > 1e-12) {
      smoke.stage = "futures_closing";
      await this.persistConnectivitySmoke(state, smoke);
      const quantity = floorStep(current.existingPerpetualQuantityXaut, current.perpetual.qtyStep);
      if (quantity < current.perpetual.minOrderQty) throw new Error("永续残余低于可退出数量，需人工处理。");
      const existing = await client.findOrderByClientOrderId?.("linear", `${smoke.orderLinkPrefix}c1`);
      const order = existing ?? await (async () => {
        this.assertExecutionLeaseHeld();
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger");
        await this.prepareSmokeProviderMutation(client, smoke, "place_futures_order", {
          orderLinkId: `${smoke.orderLinkPrefix}c1`,
        });
        const accepted = await client.placeOrder({
          category: "linear",
          symbol: "XAUTUSDT",
          side: "Buy",
          quantityXaut: quantity,
          limitPrice: smoke.budget.prices.futuresCloseLimit,
          reduceOnly: true,
          orderLinkId: `${smoke.orderLinkPrefix}c1`,
        });
        smoke.providerMutationCount += 1;
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", {
          category: "linear",
          orderLinkId: `${smoke.orderLinkPrefix}c1`,
          providerOrderId: accepted.orderId,
        });
        return client.awaitOrder("linear", accepted.orderId, deadline);
      })();
      smoke.exit.futuresCloseOrder = order;
      await this.persistConnectivitySmoke(state, smoke);
      if (order.status === "New" || order.status === "PartiallyFilled") {
        this.assertExecutionLeaseHeld();
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", {
          category: "linear",
          orderLinkId: `${smoke.orderLinkPrefix}c1`,
          providerOrderId: order.orderId,
        });
        await this.prepareSmokeProviderMutation(client, smoke, "cancel_futures_order", {
          orderLinkId: order.orderLinkId,
          providerOrderId: order.orderId,
        });
        await client.cancelOrder("linear", order.orderId);
        smoke.providerMutationCount += 1;
        const terminal = await client.findOrderByClientOrderId?.("linear", order.orderLinkId);
        if (!terminal || terminal.status === "New" || terminal.status === "PartiallyFilled" || terminal.status === "Unknown") {
          throw new RwaNeutralExecutionError(409, "connectivity_smoke_provider_state_unknown", "Futures 退出订单终态无法确认。");
        }
        smoke.exit.futuresCloseOrder = terminal;
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "futures_flat");
      }
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "futures_flat");
      smoke.exit.futuresFlatConfirmed = true;
      await this.persistConnectivitySmoke(state, smoke);
    } else {
      smoke.exit.futuresFlatConfirmed = true;
    }
    const beforeSpot = await this.verifyConnectivitySmokeWindow(
      client,
      state,
      smoke,
      "futures_flat",
      recoveryAllowedSmokeOpenOrder(smoke),
    );
    if (beforeSpot.existingSpotQuantityXaut > 1e-12) {
      smoke.stage = "spot_closing";
      await this.persistConnectivitySmoke(state, smoke);
      const quantity = floorStep(beforeSpot.spotAvailableQuantityXaut, beforeSpot.spot.qtyStep);
      if (quantity < beforeSpot.spot.minOrderQty) throw new Error("现货残余低于可退出数量，需人工处理。");
      const existing = await client.findOrderByClientOrderId?.("spot", `${smoke.orderLinkPrefix}c2`);
      const order = existing ?? await (async () => {
        this.assertExecutionLeaseHeld();
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "futures_flat");
        await this.prepareSmokeProviderMutation(client, smoke, "place_spot_order", {
          orderLinkId: `${smoke.orderLinkPrefix}c2`,
        });
        const accepted = await client.placeOrder({
          category: "spot",
          symbol: "XAUTUSDT",
          side: "Sell",
          quantityXaut: quantity,
          limitPrice: smoke.budget.prices.spotCloseLimit,
          reduceOnly: false,
          orderLinkId: `${smoke.orderLinkPrefix}c2`,
        });
        smoke.providerMutationCount += 1;
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", {
          category: "spot",
          orderLinkId: `${smoke.orderLinkPrefix}c2`,
          providerOrderId: accepted.orderId,
        });
        return client.awaitOrder("spot", accepted.orderId, deadline);
      })();
      smoke.exit.spotCloseOrder = order;
      await this.persistConnectivitySmoke(state, smoke);
      if (order.status === "New" || order.status === "PartiallyFilled") {
        this.assertExecutionLeaseHeld();
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", {
          category: "spot",
          orderLinkId: `${smoke.orderLinkPrefix}c2`,
          providerOrderId: order.orderId,
        });
        await this.prepareSmokeProviderMutation(client, smoke, "cancel_spot_order", {
          orderLinkId: order.orderLinkId,
          providerOrderId: order.orderId,
        });
        await client.cancelOrder("spot", order.orderId);
        smoke.providerMutationCount += 1;
        const terminal = await client.findOrderByClientOrderId?.("spot", order.orderLinkId);
        if (!terminal || terminal.status === "New" || terminal.status === "PartiallyFilled" || terminal.status === "Unknown") {
          throw new RwaNeutralExecutionError(409, "connectivity_smoke_provider_state_unknown", "Spot 退出订单终态无法确认。");
        }
        smoke.exit.spotCloseOrder = terminal;
        await this.verifyConnectivitySmokeWindow(client, state, smoke, "flat");
      }
    }
    await this.confirmConnectivitySmokeFlat(client, state, smoke, "flat", "provider 已权威确认两侧 flat。");
  }

  private async confirmConnectivitySmokeFlat(
    client: RwaBinanceClient,
    state: RwaAutomationStateData,
    smoke: RwaConnectivitySmokeRecord,
    stage: "flat" | "failed",
    message: string,
  ) {
    const final = await client.readPreflightSnapshot();
    if (!isFreshConnectivitySmokeSnapshot(final, this.now())) {
      smoke.providerState = providerStateFromSnapshot(
        final,
        "stale",
        "provider_snapshot_stale",
        this.now(),
      );
      await this.persistConnectivitySmoke(state, smoke);
      throw new RwaNeutralExecutionError(
        409,
        "connectivity_smoke_provider_snapshot_stale",
        "provider 私有快照已过期或时间无效，不能形成成功 receipt。",
      );
    }
    assertSmokeSnapshot(final, smoke, "flat");
    smoke.providerState = providerStateFromSnapshot(
      final,
      "verified",
      "provider_flat_confirmed",
      this.now(),
    );
    smoke.exit.futuresFlatConfirmed = true;
    smoke.exit.spotFlatConfirmed = true;
    smoke.stage = stage;
    smoke.message = message;
    smoke.receipt = stage === "flat" ? {
      receiptId: randomBytes(18).toString("base64url"),
      smokeId: smoke.smokeId,
          purpose: RWA_CONNECTIVITY_SMOKE_PURPOSE,
      venue: "binance",
      symbol: "XAUTUSDT",
          accountFingerprint: smoke.accountFingerprint,
          policyVersion: smoke.policyVersion,
          policyDigest: smoke.policyDigest,
      budget: smoke.budget,
      openedSpotQuantityXaut: smoke.openedSpotQuantityXaut,
      openedFuturesQuantityXaut: smoke.openedFuturesQuantityXaut,
      finalSpotQuantityXaut: final.existingSpotQuantityXaut,
      finalFuturesQuantityXaut: final.existingPerpetualQuantityXaut,
      providerFlatConfirmed: true,
      completedAt: this.now(),
    } : null;
    await this.persistConnectivitySmoke(state, smoke);
  }

  private async recoverConnectivitySmoke(state: RwaAutomationStateData) {
    const active = state.connectivitySmokes.find(isActiveConnectivitySmoke);
    if (!active) return;
    if (active.stage === "reserved" && active.providerMutationCount === 0) {
      active.stage = "failed";
      active.message = "服务重启发生在首次 provider mutation 前；烟测已终止且禁止重开。";
      active.updatedAt = this.now();
      appendConnectivitySmokeTimeline(active, this.now());
      await this.store.writeState(state);
      return;
    }
    try {
      const client = await this.client();
      if (active.stage === "spot_opening" || active.stage === "futures_opening") {
        const shouldContinue = await this.recoverConnectivitySmokeOpeningOrder(client, state, active);
        if (!shouldContinue) return;
      }
      await this.reduceConnectivitySmokeRisk(client, state, active);
    } catch (error) {
      active.stage = "manual_intervention";
      active.errorCategory = errorCategory(error);
      active.message = "服务重启后无法证明 smoke 风险降低退出已闭环，请在 Binance 人工处理。";
      active.updatedAt = this.now();
      appendConnectivitySmokeTimeline(active, this.now());
      state.config.killSwitchActive = true;
      state.config.strategyEnabled = false;
      state.config.globalExecutionEnabled = false;
      await this.store.writeState(state);
    }
  }

  private async recoverConnectivitySmokeOpeningOrder(
    client: RwaBinanceClient,
    state: RwaAutomationStateData,
    smoke: RwaConnectivitySmokeRecord,
  ) {
    const isSpot = smoke.stage === "spot_opening";
    const category = isSpot ? "spot" : "linear";
    const orderLinkId = `${smoke.orderLinkPrefix}${isSpot ? "s1" : "p1"}`;
    const order = await client.findOrderByClientOrderId?.(category, orderLinkId);
    if (!order) {
      const snapshot = await this.verifyConnectivitySmokeWindow(
        client,
        state,
        smoke,
        isSpot ? "blank" : "within_ledger",
      );
      if (
        snapshot.existingSpotQuantityXaut <= 1e-12
        && snapshot.existingPerpetualQuantityXaut <= 1e-12
      ) {
        await this.confirmConnectivitySmokeFlat(
          client,
          state,
          smoke,
          "failed",
          "重启恢复未发现固定开仓订单或任何权威敞口；烟测已终止且禁止重开。",
        );
        return false;
      }
      return true;
    }
    if (order.orderLinkId !== orderLinkId || order.status === "Unknown") {
      throw new RwaNeutralExecutionError(
        409,
        "connectivity_smoke_provider_state_unknown",
        "重启恢复无法确认固定 smoke 开仓订单状态。",
      );
    }
    if (isSpot) {
      smoke.spotOpenOrder = order;
      smoke.openedSpotQuantityXaut = orderPositionQuantity(order);
    } else {
      smoke.futuresOpenOrder = order;
      smoke.openedFuturesQuantityXaut = orderPositionQuantity(order);
    }
    await this.persistConnectivitySmoke(state, smoke);
    if (order.status === "New" || order.status === "PartiallyFilled") {
      const allowed = {
        category,
        orderLinkId,
        providerOrderId: order.orderId,
      } satisfies SmokeAllowedOpenOrder;
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger", allowed);
      this.assertExecutionLeaseHeld();
      await this.prepareSmokeProviderMutation(
        client,
        smoke,
        isSpot ? "cancel_spot_order" : "cancel_futures_order",
        { orderLinkId, providerOrderId: order.orderId },
      );
      await client.cancelOrder(category, order.orderId);
      smoke.providerMutationCount += 1;
      const terminal = await client.findOrderByClientOrderId?.(category, orderLinkId);
      if (
        !terminal
        || terminal.orderLinkId !== orderLinkId
        || terminal.status === "New"
        || terminal.status === "PartiallyFilled"
        || terminal.status === "Unknown"
      ) {
        throw new RwaNeutralExecutionError(
          409,
          "connectivity_smoke_provider_state_unknown",
          "重启撤销 smoke 开仓余量后无法确认订单终态。",
        );
      }
      if (isSpot) {
        smoke.spotOpenOrder = terminal;
        smoke.openedSpotQuantityXaut = orderPositionQuantity(terminal);
      } else {
        smoke.futuresOpenOrder = terminal;
        smoke.openedFuturesQuantityXaut = orderPositionQuantity(terminal);
      }
      await this.persistConnectivitySmoke(state, smoke);
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger");
    } else {
      await this.verifyConnectivitySmokeWindow(client, state, smoke, "within_ledger");
    }
    return true;
  }

  private async persistConnectivitySmoke(
    state: RwaAutomationStateData,
    smoke: RwaConnectivitySmokeRecord,
  ) {
    appendConnectivitySmokeTimeline(smoke, this.now());
    smoke.updatedAt = this.now();
    await this.store.writeState(state);
  }

  private async verifyConnectivitySmokeWindow(
    client: RwaBinanceClient,
    state: RwaAutomationStateData,
    smoke: RwaConnectivitySmokeRecord,
    expected: "blank" | "spot_only" | "hedged" | "within_ledger" | "futures_flat" | "flat",
    allowedOpenOrder: SmokeAllowedOpenOrder | null = null,
    requireLeverage1x = false,
  ) {
    this.assertExecutionLeaseHeld();
    await this.reconcileConnectivitySmokeOrders(client, smoke);
    let snapshot: RwaBinancePreflightSnapshot;
    try {
      snapshot = await client.readPreflightSnapshot();
    } catch (error) {
      smoke.providerState = unavailableSmokeProviderState("provider_snapshot_unavailable");
      throw error;
    }
    if (!isFreshConnectivitySmokeSnapshot(snapshot, this.now())) {
      smoke.providerState = providerStateFromSnapshot(
        snapshot,
        "stale",
        "provider_snapshot_stale",
        this.now(),
      );
      await this.persistConnectivitySmoke(state, smoke);
      throw new RwaNeutralExecutionError(
        409,
        "connectivity_smoke_provider_snapshot_stale",
        "provider 私有快照已过期或时间无效，已停止使用该证据继续写入。",
      );
    }
    if (!client.readConnectivitySmokeActivity) {
      throw new RwaNeutralExecutionError(409, "connectivity_smoke_activity_incomplete", "provider 不支持 smoke REST 活动扫描。");
    }
    let continuity = createUnmonitoredActivityContinuity(smoke.createdAt);
    for (const order of [
      smoke.spotOpenOrder, smoke.futuresOpenOrder,
      smoke.exit.futuresCloseOrder, smoke.exit.spotCloseOrder,
    ]) {
      if (!order) continue;
      continuity = recordStrategyProviderOrder(
        continuity,
        order === smoke.spotOpenOrder || order === smoke.exit.spotCloseOrder ? "spot" : "linear",
        order.orderId,
        this.now(),
      );
    }
    const activity = await client.readConnectivitySmokeActivity({
      strategyOrderPrefix: smoke.orderLinkPrefix,
      strategyOrderPrefixes: [smoke.orderLinkPrefix],
      since: smoke.createdAt,
      continuity,
    });
    if (
      activity.nonAtomic !== true
      || !activity.protocolComplete
      || activity.attribution.externalPositionActivity
      || activity.attribution.sources.some((source) => source.externalActivity)
    ) {
      smoke.providerState = providerStateFromSnapshot(
        snapshot,
        "ambiguous",
        "activity_evidence_incomplete",
        this.now(),
      );
      throw new RwaNeutralExecutionError(
        409,
        "connectivity_smoke_activity_incomplete",
        "截至扫描 cutoff 无法证明 REST 可见 XAUT 活动仅属于当前 smoke。",
      );
    }
    try {
      assertSmokeSnapshot(snapshot, smoke, expected, allowedOpenOrder, requireLeverage1x);
      smoke.providerState = providerStateFromSnapshot(
        snapshot,
        "verified",
        "verified_non_atomic_rest_snapshot",
        this.now(),
      );
    } catch (error) {
      smoke.providerState = providerStateFromSnapshot(
        snapshot,
        "ambiguous",
        "provider_ledger_mismatch",
        this.now(),
      );
      throw error;
    }
    smoke.message = "用户承诺的独占运维窗口；截至扫描 cutoff 未发现 REST 可见外部活动。";
    await this.persistConnectivitySmoke(state, smoke);
    return snapshot;
  }

  private async reconcileConnectivitySmokeOrders(
    client: RwaBinanceClient,
    smoke: RwaConnectivitySmokeRecord,
  ) {
    const ids = smokeOrderIds(smoke);
    const [spotOpen, futuresOpen, futuresClose, spotClose] = await Promise.all([
      client.findOrderByClientOrderId?.("spot", ids.spotOpen),
      client.findOrderByClientOrderId?.("linear", ids.futuresOpen),
      client.findOrderByClientOrderId?.("linear", ids.futuresClose),
      client.findOrderByClientOrderId?.("spot", ids.spotClose),
    ]);
    for (const [order, expectedId] of [
      [spotOpen, ids.spotOpen], [futuresOpen, ids.futuresOpen],
      [futuresClose, ids.futuresClose], [spotClose, ids.spotClose],
    ] as const) {
      if (order && order.orderLinkId !== expectedId) {
        throw new RwaNeutralExecutionError(409, "connectivity_smoke_order_unknown", "provider 返回未知 smoke 订单。");
      }
    }
    if (spotOpen) {
      smoke.spotOpenOrder = spotOpen;
      smoke.openedSpotQuantityXaut = orderPositionQuantity(spotOpen);
    }
    if (futuresOpen) {
      smoke.futuresOpenOrder = futuresOpen;
      smoke.openedFuturesQuantityXaut = orderPositionQuantity(futuresOpen);
    }
    if (futuresClose) smoke.exit.futuresCloseOrder = futuresClose;
    if (spotClose) smoke.exit.spotCloseOrder = spotClose;
  }

  private async client(): Promise<RwaBinanceClient> {
    this.assertExecutionLeaseHeld();
    if (!this.store.masterKeyConfigured) {
      throw keyProviderUnavailable(this.store.masterKeyError);
    }
    try {
      const credentials = await this.store.loadCredentials();
      const client = this.clientFactory(
        credentials,
        this.providerActivityGuard,
      );
      if (client.requiresProviderActivityStream) {
        await this.providerUserDataStream.ensureStarted(credentials);
      }
      return client;
    } catch (error) {
      if (error instanceof RwaBinanceActivityUnsafeError) throw error;
      throw credentialStoreExecutionError(error);
    }
  }

  private async prepareSmokeProviderMutation(
    client: RwaBinanceClient,
    smoke: RwaConnectivitySmokeRecord,
    mutation: Parameters<NonNullable<RwaBinanceClient["prepareProviderMutation"]>>[0]["mutation"],
    identity: {
      orderLinkId?: string;
      providerOrderId?: string;
      expectedLeverage?: 1 | 2 | 3;
    } = {},
  ) {
    await client.prepareProviderMutation?.({
      mutation,
      strategyOrderPrefixes: [smoke.orderLinkPrefix],
      since: smoke.createdAt,
      continuity: createMonitoredActivityContinuity(smoke.createdAt, smoke.orderLinkPrefix),
      ...identity,
    });
  }

  private async failClosedForProviderActivity(reason: string) {
    await this.withLock(async () => {
      const state = await this.store.readState();
      state.config.globalExecutionEnabled = false;
      state.config.strategyEnabled = false;
      state.config.killSwitchActive = true;
      state.challenges = [];
      this.armedChallengeIds.clear();
      for (const execution of state.executions) {
        if (["closed", "reconciled", "failed"].includes(execution.state)) continue;
        execution.state = "manual_intervention";
        execution.errorCategory = "provider_activity_ambiguous";
        execution.message = `Binance 账户活动无法确认（${reason}），已停止自动执行并转人工核对。`;
        execution.updatedAt = this.now();
      }
      await this.store.writeState(state);
    });
  }

  private async buildAccountAssetAuthorizationPreview(
    profile: typeof XAUT_BINANCE_PROFILE,
    metadata: BinanceCredentialMetadata,
  ) {
    const client = await this.client();
    if (!client.listAssetOpenOrders) {
      throw new RwaAccountAssetAuthorizationError(
        503,
        "asset_authorization_preview_invalid",
        "交易所活动订单只读接口不可用，无法生成资产授权预览。",
      );
    }
    const [snapshot, orders] = await Promise.all([
      client.readPreflightSnapshot(),
      client.listAssetOpenOrders(),
    ]);
    if (
      snapshot.accountId !== metadata.accountId
      || snapshot.accountFingerprint !== metadata.accountFingerprint
    ) throw invalidAccountAssetAuthorization();
    return createAccountAssetAuthorizationPreview({
      profile,
      snapshot,
      orders,
      now: this.now(),
    });
  }

  private async clientForNewRisk(
    state: RwaAutomationStateData,
    metadata: BinanceCredentialMetadata,
    allowConsumedConnectivitySmokePermit = false,
  ) {
    try {
      return this.withPermitMutationGuard(
        await this.client(),
        allowConsumedConnectivitySmokePermit,
      );
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

  private async clientForTakeover() {
    return this.withPermitMutationGuard(await this.client(), false);
  }

  private withPermitMutationGuard(
    client: RwaBinanceClient,
    allowConsumedConnectivitySmokePermit: boolean,
  ): RwaBinanceClient {
    return new Proxy(client, {
      get: (target, property, receiver) => {
        if (property === "setPerpetualLeverage") {
          return async (...args: Parameters<RwaBinanceClient["setPerpetualLeverage"]>) => {
            await this.assertCurrentPermitBeforeNewRiskMutation(
              allowConsumedConnectivitySmokePermit,
            );
            return target.setPerpetualLeverage(...args);
          };
        }
        if (property === "placeOrder") {
          return async (...args: Parameters<RwaBinanceClient["placeOrder"]>) => {
            const request = args[0];
            const riskReducing = request.reduceOnly
              || (request.category === "spot" && request.side === "Sell");
            if (!riskReducing) {
              await this.assertCurrentPermitBeforeNewRiskMutation(
                allowConsumedConnectivitySmokePermit,
              );
            }
            return target.placeOrder(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private async assertCurrentPermitBeforeNewRiskMutation(
    allowConsumedConnectivitySmokePermit: boolean,
  ) {
    const state = await this.store.readState();
    this.assertProductionSelfTestPermitConnectivitySmokeOnly(
      state.config,
      allowConsumedConnectivitySmokePermit,
    );
    const metadata = await this.requireMetadata();
    const permit = this.assertProductionSelfTestPermit(state.config, metadata, {
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
    } as Awaited<ReturnType<RwaBinanceClient["validateAccess"]>>);
    if (
      permit
      && !state.productionSelfTestPermitConsumptions.some((item) =>
        item.permitId === permit.permitId && item.digest === permit.digest
      )
    ) {
      throw new RwaNeutralExecutionError(
        409,
        "production_self_test_permit_not_consumed",
        "Production self-test Permit 尚未由连通性烟测原子消费，禁止 Provider 新增风险动作。",
      );
    }
  }

  private async requireMetadata() {
    const metadata = await this.store.readCredentialMetadata();
    if (!metadata) throw new RwaNeutralExecutionError(409, "credential_not_configured", "Binance API 凭证尚未配置。");
    if (metadata.version === 1) {
      throw new RwaNeutralExecutionError(409, "credential_format_unsupported", "旧版 Binance Credential 不受支持；必须安全解绑后重新绑定。");
    }
    return metadata;
  }

  private async validateActiveAccess(client: RwaBinanceClient, accountId: string, state: RwaAutomationStateData) {
    const metadata = await this.requireMetadata();
    assertAccountId(accountId, metadata.accountId);
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

  private async persistCloseFill(
    state: RwaAutomationStateData,
    executionIds: string[],
    side: "spot" | "linear",
    filledQuantityXaut: number,
  ) {
    applyTrackedCloseFill(state, executionIds, side, filledQuantityXaut, this.now());
    await this.store.writeState(state);
  }

  private async persistActivitySnapshot(
    state: RwaAutomationStateData,
    executionIds: string[],
    snapshot: RwaPositionAttributionSnapshot,
  ) {
    const ids = new Set(executionIds);
    for (const execution of state.executions) {
      if (!ids.has(execution.executionId)) continue;
      execution.activityContinuity = mergeActivitySnapshot(
        execution.activityContinuity,
        snapshot,
        [execution.orderLinkPrefix],
        this.now(),
      );
      execution.updatedAt = this.now();
      if (
        execution.activityContinuity.spot.coverage === "ambiguous"
        || execution.activityContinuity.perpetual.coverage === "ambiguous"
      ) {
        state.config.killSwitchActive = true;
        state.config.strategyEnabled = false;
        state.config.globalExecutionEnabled = false;
      }
    }
    await this.store.writeState(state);
  }

  private async persistProviderOrder(
    state: RwaAutomationStateData,
    executionIds: string[],
    side: "spot" | "linear",
    orderId: string,
  ) {
    const ids = new Set(executionIds);
    for (const execution of state.executions) {
      if (!ids.has(execution.executionId)) continue;
      execution.activityContinuity = recordStrategyProviderOrder(
        execution.activityContinuity,
        side,
        orderId,
        this.now(),
      );
      execution.updatedAt = this.now();
    }
    await this.store.writeState(state);
  }

  private async safeReconciliationPreview(client: RwaBinanceClient | null, execution: RwaExecutionRecord) {
    if (!client) return null;
    try {
      return await this.buildReconciliationPreview(client, execution);
    } catch {
      return null;
    }
  }

  private async buildReconciliationPreview(client: RwaBinanceClient, execution: RwaExecutionRecord): Promise<RwaExecutionReconciliationPreview> {
    const [pnl, snapshot] = await Promise.all([
      client.readStrategyPnl(this.strategyOrderPrefix, execution.createdAt),
      client.readPreflightSnapshot(),
    ]);
    const spotResidual = assessResidual(
      spotClosableQuantity(snapshot),
      snapshot.spot.bid || snapshot.spot.ask || snapshot.spot.minNotionalUsd,
      snapshot.spot.qtyStep,
      snapshot.spot.minOrderQty,
      snapshot.spot.minNotionalUsd,
    );
    const perpetualResidual = assessResidual(
      snapshot.existingPerpetualQuantityXaut,
      snapshot.perpetual.bid || snapshot.perpetual.ask || snapshot.perpetual.minNotionalUsd,
      snapshot.perpetual.qtyStep,
      snapshot.perpetual.minOrderQty,
      snapshot.perpetual.minNotionalUsd,
    );
    const stale = this.now() - snapshot.fetchedAt > RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS;
    const blockingReasons: string[] = [];
    if (stale) blockingReasons.push("交易所权威快照已过期，请稍后重试对账。");
    if (pnl.openOrders.length || snapshot.openSpotOrderCount > 0 || snapshot.openPerpetualOrderCount > 0) {
      blockingReasons.push("当前仍存在活动委托，不能人工结案。");
    }
    if (perpetualResidual.tradable) blockingReasons.push("永续侧仍存在可交易仓位，需先人工平仓。");
    if (spotResidual.tradable) blockingReasons.push("现货侧仍存在可交易余额，需先人工卖出。");
    const accountMismatch = execution.accountId !== snapshot.accountId;
    if (accountMismatch) blockingReasons.push("交易所账户与当前策略记录不匹配，禁止结案。");
    const recommendedAction = stale
      ? "retry_close"
      : perpetualResidual.tradable && spotResidual.tradable
        ? "manual_close_both"
        : perpetualResidual.tradable
          ? "manual_close_perpetual"
          : spotResidual.tradable
            ? "manual_close_spot"
            : "manual_finalize";
    return {
      reconciliationId: execution.executionId,
      strategyId: RWA_BINANCE_STRATEGY_ID,
      recordedState: execution.state,
      authoritativeState: {
        snapshotAt: snapshot.fetchedAt,
        status: stale ? "stale" : "ok",
        stale,
        openOrders: {
          spot: snapshot.openSpotOrderCount,
          perpetual: snapshot.openPerpetualOrderCount,
          total: snapshot.openSpotOrderCount + snapshot.openPerpetualOrderCount,
        },
        legs: {
          spot: {
            quantityXaut: snapshot.existingSpotQuantityXaut,
            freeQuantityXaut: snapshot.spotFreeXaut,
            markPrice: snapshot.spot.bid || snapshot.spot.ask || null,
            minOrderQty: snapshot.spot.minOrderQty,
            minNotionalUsd: snapshot.spot.minNotionalUsd,
            qtyStep: snapshot.spot.qtyStep,
          },
          perpetual: {
            quantityXaut: snapshot.existingPerpetualQuantityXaut,
            freeQuantityXaut: null,
            markPrice: snapshot.perpetual.mark || snapshot.perpetual.bid || null,
            minOrderQty: snapshot.perpetual.minOrderQty,
            minNotionalUsd: snapshot.perpetual.minNotionalUsd,
            qtyStep: snapshot.perpetual.qtyStep,
          },
        },
      },
      legDiffs: {
        spotQuantityXaut: roundResidual(snapshot.existingSpotQuantityXaut - pnl.legs.spot.quantityXaut),
        perpetualQuantityXaut: roundResidual(snapshot.existingPerpetualQuantityXaut - pnl.legs.perpetual.quantityXaut),
      },
      tradableResidual: {
        spot: spotResidual.tradable ? spotResidual : null,
        perpetual: perpetualResidual.tradable ? perpetualResidual : null,
      },
      dustResidual: {
        spot: !spotResidual.tradable && spotResidual.reason !== "zero" ? spotResidual : null,
        perpetual: !perpetualResidual.tradable && perpetualResidual.reason !== "zero" ? perpetualResidual : null,
      },
      recommendedAction,
      canFinalize: !blockingReasons.length,
      blockingReasons,
    };
  }

  private assertEntrySwitches(config: RwaExecutionConfig) {
    if (this.serverKillSwitchActive()) {
      throw new RwaNeutralExecutionError(409, "server_kill_switch_active", "服务端全局急停已激活，禁止新增风险动作。");
    }
    if (!config.globalExecutionEnabled) throw new RwaNeutralExecutionError(409, "global_execution_disabled", "全局真实执行开关未启用。");
    if (!config.strategyEnabled) throw new RwaNeutralExecutionError(409, "strategy_disabled", "Binance XAUT 对冲策略开关未启用。");
    if (config.killSwitchActive) throw new RwaNeutralExecutionError(409, "kill_switch_active", "Kill switch 已激活，禁止新增风险动作。");
    assertBinanceAccountIsolationForAutomaticExecution(config);
  }

  private async riskExposures(state: RwaAutomationStateData) {
    return mergeRwaAutomationCapitalExposures(
      await readRwaAutomationCapitalExposures(),
      automationCapitalExposuresFromExecutions(state.executions),
      automationCapitalExposuresFromTakeovers(state.assetTakeovers),
    );
  }

  private async assertReservedRiskCapacity(state: RwaAutomationStateData, execution: RwaExecutionRecord) {
    const limits = XAUT_BINANCE_PROFILE.asset.currentStageRiskLimits!;
    const usage = calculateRwaAutomationNewRiskUsage({
      exposures: await this.riskExposures(state),
      profile: XAUT_BINANCE_PROFILE,
      userId: execution.userId,
      accountId: execution.accountId,
      orderNotionalUsd: execution.reservedCapitalUsd,
      proposedCapitalUsd: 0,
    });
    try {
      assertRwaAutomationNewRisk({ limits, ...usage });
    } catch {
      throw new RwaNeutralExecutionError(409, "risk_limit_exceeded", "当前新增风险超过服务端资产 profile 的分层上限。");
    }
    if (usage.assetNotionalUsd > state.config.maxStrategyCapitalUsd) {
      throw new RwaNeutralExecutionError(409, "strategy_cap_exceeded", "当前资产新增风险超过受控策略资本配置。");
    }
  }

  private async assertProposedRiskCapacity(
    state: RwaAutomationStateData,
    accountId: string,
    proposedCapitalUsd: number,
  ) {
    const limits = XAUT_BINANCE_PROFILE.asset.currentStageRiskLimits!;
    const usage = calculateRwaAutomationNewRiskUsage({
      exposures: await this.riskExposures(state),
      profile: XAUT_BINANCE_PROFILE,
      userId: this.store.ownerUserId,
      accountId,
      orderNotionalUsd: 0,
      proposedCapitalUsd,
    });
    try {
      assertRwaAutomationNewRisk({ limits, ...usage });
    } catch {
      throw new RwaNeutralExecutionError(409, "risk_limit_exceeded", "当前新增风险超过服务端资产 profile 的分层上限。");
    }
    if (usage.assetNotionalUsd > state.config.maxStrategyCapitalUsd) {
      throw new RwaNeutralExecutionError(409, "strategy_cap_exceeded", "当前资产新增风险超过受控策略资本配置。");
    }
  }

  private async assertSelfTestNewRiskAllowed() {
    const state = await this.store.readState();
    this.assertProductionSelfTestPermitConnectivitySmokeOnly(state.config);
    if (
      !this.productionEnvironment()
      || state.config.accountIsolationMode !== "development_exclusive_account"
    ) return;
    this.assertEntrySwitches(state.config);
    const metadata = await this.requireMetadata();
    const client = await this.clientForNewRisk(state, metadata);
    const access = await this.validateActiveAccess(client, metadata.accountId, state);
    this.assertProductionSelfTestPermit(state.config, metadata, access);
  }

  private assertProductionSelfTestPermitConnectivitySmokeOnly(
    config: RwaExecutionConfig,
    allowConsumedConnectivitySmokePermit = false,
  ) {
    if (
      this.productionEnvironment()
      && config.accountIsolationMode === "development_exclusive_account"
      && !allowConsumedConnectivitySmokePermit
    ) {
      throw new RwaNeutralExecutionError(
        409,
        "production_self_test_permit_smoke_only",
        "Production self-test Permit 仅授权一次 Capital Test connectivity smoke，禁止其他新增风险路径。",
      );
    }
  }

  private confirmProductionSelfTestPermit(
    metadata: BinanceCredentialMetadata,
    access: Awaited<ReturnType<RwaBinanceClient["validateAccess"]>>,
  ) {
    const permit = this.requireMatchingProductionSelfTestPermit(metadata, access);
    return { ...permit, confirmedAt: this.now() };
  }

  private assertProductionSelfTestPermit(
    config: RwaExecutionConfig,
    metadata: BinanceCredentialMetadata,
    access: Awaited<ReturnType<RwaBinanceClient["validateAccess"]>>,
  ) {
    if (
      !this.productionEnvironment()
      || config.accountIsolationMode === "dedicated_subaccount"
    ) return null;
    const permit = this.requireMatchingProductionSelfTestPermit(metadata, access);
    const confirmation = config.productionSelfTestPermitConfirmation;
    if (
      !confirmation
      || !this.productionSelfTestPermitConfirmationMatches(confirmation, permit)
      || confirmation.confirmedAt >= permit.expiresAt
    ) throw accountIsolationUnconfirmed();
    return permit;
  }

  private requireConfirmedProductionSelfTestPermitForConsumption(
    config: RwaExecutionConfig,
  ): RwaBinanceProductionSelfTestPermit | null {
    if (
      !this.productionEnvironment()
      || config.accountIsolationMode === "dedicated_subaccount"
    ) return null;
    const permit = this.productionSelfTestPermit();
    const confirmation = config.productionSelfTestPermitConfirmation;
    if (
      !permit
      || this.now() >= permit.expiresAt
      || permit.ownerUserId !== this.store.ownerUserId
      || !validProductionSelfTestActionScope(permit.actionScope)
      || !/^[a-f0-9]{64}$/u.test(permit.authorizationDigest)
      || permit.digest !== productionSelfTestPermitDigest(permit)
      || !confirmation
      || !this.productionSelfTestPermitConfirmationMatches(confirmation, permit)
      || confirmation.confirmedAt >= permit.expiresAt
    ) throw accountIsolationUnconfirmed();
    return permit;
  }

  private productionSelfTestPermitConfirmationMatches(
    confirmation: NonNullable<RwaExecutionConfig["productionSelfTestPermitConfirmation"]>,
    permit: RwaBinanceProductionSelfTestPermit,
  ) {
    return confirmation.permitId === permit.permitId
      && confirmation.ownerUserId === permit.ownerUserId
      && confirmation.accountBindingSha256 === permit.accountBindingSha256
      && validProductionSelfTestActionScope(confirmation.actionScope)
      && confirmation.actionScope[0] === permit.actionScope[0]
      && confirmation.actionScope[1] === permit.actionScope[1]
      && confirmation.authorizationDigest === permit.authorizationDigest
      && confirmation.approvedCapitalUsd === permit.approvedCapitalUsd
      && confirmation.leverage === permit.leverage
      && confirmation.maxPositionUsd === permit.maxPositionUsd
      && confirmation.maxOrderSizeUsd === permit.maxOrderSizeUsd
      && confirmation.maxOrderCount === permit.maxOrderCount
      && confirmation.maxSlippageBps === permit.maxSlippageBps
      && confirmation.maxFeeBps === permit.maxFeeBps
      && confirmation.lossLimitUsd === permit.lossLimitUsd
      && confirmation.executionId === permit.executionId
      && confirmation.expiresAt === permit.expiresAt
      && confirmation.revision === permit.revision
      && confirmation.digest === permit.digest;
  }

  private requireMatchingProductionSelfTestPermit(
    metadata: BinanceCredentialMetadata,
    access: Awaited<ReturnType<RwaBinanceClient["validateAccess"]>>,
  ) {
    const permit = this.productionSelfTestPermit();
    const binding = binanceAccountBindingSha256(access.accountId, access.accountFingerprint);
    if (
      !permit
      || this.now() >= permit.expiresAt
      || permit.ownerUserId !== this.store.ownerUserId
      || !validProductionSelfTestActionScope(permit.actionScope)
      || !/^[a-f0-9]{64}$/u.test(permit.authorizationDigest)
      || permit.digest !== productionSelfTestPermitDigest(permit)
      || permit.accountBindingSha256 !== binding
      || access.accountId !== metadata.accountId
      || access.accountFingerprint !== metadata.accountFingerprint
    ) throw accountIsolationUnconfirmed();
    return permit;
  }

  private approvedConnectivitySmokeCapital(
    config: RwaExecutionConfig,
    metadata: BinanceCredentialMetadata,
    access: Awaited<ReturnType<RwaBinanceClient["validateAccess"]>>,
  ) {
    if (!this.productionEnvironment()) return config.maxStrategyCapitalUsd;
    return this.requireMatchingProductionSelfTestPermit(metadata, access).approvedCapitalUsd;
  }

  private async assertPersistedCapitalTestReservation(
    smoke: RwaConnectivitySmokeRecord,
    permit: RwaBinanceProductionSelfTestPermit | null,
  ) {
    if (!permit) return;
    const tuple = smoke.authorization.capitalTest;
    if (
      !tuple
      || tuple.accountBindingSha256 !== permit.accountBindingSha256
      || tuple.revision !== permit.revision
      || tuple.approvedCapitalUsd !== permit.approvedCapitalUsd
      || tuple.expiresAt !== permit.expiresAt
      || tuple.leverage !== permit.leverage
      || tuple.maxPositionUsd !== permit.maxPositionUsd
      || tuple.maxOrderSizeUsd !== permit.maxOrderSizeUsd
      || tuple.maxOrderCount !== permit.maxOrderCount
      || tuple.maxSlippageBps !== permit.maxSlippageBps
      || tuple.maxFeeBps !== permit.maxFeeBps
      || tuple.lossLimitUsd !== permit.lossLimitUsd
      || tuple.executionId !== permit.executionId
      || tuple.authorizationDigest !== permit.authorizationDigest
      || tuple.permitDigest !== permit.digest
      || smoke.budget.spotNotionalUsd > permit.maxPositionUsd + 1e-9
      || smoke.budget.spotNotionalUsd > permit.maxOrderSizeUsd + 1e-9
      || smoke.budget.slippageBpsPerAction > permit.maxSlippageBps
    ) throw accountIsolationUnconfirmed();
    const persisted = await this.store.readState();
    const reserved = persisted.connectivitySmokes.find((value) => value.smokeId === smoke.smokeId);
    const consumed = persisted.productionSelfTestPermitConsumptions.some((value) =>
      value.permitId === permit.permitId && value.digest === permit.digest);
    if (!reserved || reserved.stage !== "reserved" || reserved.providerMutationCount !== 0
      || reserved.authorization.capitalTest?.executionId !== permit.executionId || !consumed) {
      throw new RwaNeutralExecutionError(
        409,
        "capital_test_reservation_not_persisted",
        "Capital Test Permit consumption and execution reservation were not persisted atomically.",
      );
    }
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
    warnings?: string[];
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
      warnings: input.warnings ?? [],
    };
  }
}

function ipWhitelistWarnings(mode: "provider_list_exact" | "provider_restriction_only" | undefined) {
  return mode === "provider_restriction_only"
    ? ["Binance 已确认该 API Key 启用固定 IP 限制，但未返回完整 ipList；当前仅基于服务端固定出口配置与私有签名请求成功兼容通过。"]
    : [];
}

function binanceAccountIsolationMode(
  value: unknown,
): RwaExecutionConfig["accountIsolationMode"] {
  if (value === "dedicated_subaccount") return value;
  if (value === "development_exclusive_account") return value;
  throw new RwaNeutralExecutionError(
    400,
    "account_isolation_invalid",
    "正式自动执行必须确认专用 Binance 子账户；普通账户唯一写入例外仅允许非 production 开发验证。",
  );
}

function assertBinanceAccountIsolationForAutomaticExecution(config: RwaExecutionConfig) {
  if (
    config.accountIsolationMode === "dedicated_subaccount"
    && config.accountIsolationConfirmedAt !== null
  ) return;
  if (
    config.accountIsolationMode === "development_exclusive_account"
    && config.accountIsolationConfirmedAt !== null
  ) return;
  throw accountIsolationUnconfirmed();
}

function accountIsolationUnconfirmed() {
  return new RwaNeutralExecutionError(
    409,
    "account_isolation_unconfirmed",
    "自动执行要求可审计的账户唯一写入确认；production 普通账户自测还要求有效服务器 permit 与账户绑定确认。",
  );
}

function isProviderActivityStop(error: unknown) {
  return error instanceof RwaBinanceActivityUnsafeError
    || (error instanceof RwaBinanceProviderError
      && ["provider_activity_unavailable", "provider_activity_ambiguous"].includes(error.category));
}

function buildBinancePreflight(
  userId: string,
  opportunityId: string,
  snapshot: RwaBinancePreflightSnapshot,
  config: RwaExecutionConfig,
  mode: RwaAutomationMode,
  now: number,
  exposures: readonly RwaAutomationCapitalExposure[],
): RwaPreflightReport & {
  phase: "execution_capable";
  providerWritesEnabled: true;
  productAvailability: RwaBinancePreflightSnapshot["productAvailability"];
  marketChecksPassed: boolean;
  message: string;
} {
  const limits = XAUT_BINANCE_PROFILE.asset.currentStageRiskLimits!;
  const quantityXaut = calculateMinimumCommonBaseQuantity({
    spot: snapshot.spot,
    perpetual: snapshot.perpetual,
  }).quantity;
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
  const riskUsage = calculateRwaAutomationNewRiskUsage({
    exposures,
    profile: XAUT_BINANCE_PROFILE,
    userId,
    accountId: snapshot.accountId,
    orderNotionalUsd: capitalRequired,
    proposedCapitalUsd: capitalRequired,
  });
  const checks = [
    check("product_pair", snapshot.productAvailability.available, true, "Binance Mainnet 必须存在可执行的 XAUTUSDT 现货与 USD-M 永续对冲组合。"),
    check("permissions", permissionsValid(snapshot.permissions), true, "必须具备读取、现货交易和 USD-M Futures 交易权限，关闭提现，并通过服务端固定出口 IP 白名单核对。"),
    check("position_mode", snapshot.permissions.positionModeSupported, true, "当前只接受 one-way 持仓模式；hedge mode 暂不放行。"),
    check("spot_trading", snapshot.spot.status === "Trading", "Trading", "XAUTUSDT 现货必须为 TRADING。"),
    check("perpetual_trading", snapshot.perpetual.status === "Trading", "Trading", "XAUTUSDT USD-M 永续必须为 TRADING。"),
    check("spot_profile_rules", instrumentRulesMatch(XAUT_BINANCE_PROFILE, "spot", snapshot.spot), true, "现货精度与最小量必须匹配服务端冻结 profile。"),
    check("perpetual_profile_rules", instrumentRulesMatch(XAUT_BINANCE_PROFILE, "perpetual", snapshot.perpetual), true, "永续精度与最小量必须匹配服务端冻结 profile。"),
    check("quotes", snapshot.spot.bid > 0 && snapshot.spot.ask > 0 && snapshot.perpetual.bid > 0 && snapshot.perpetual.ask > 0, true, "现货侧与永续侧 Bid/Ask 必须完整。"),
    check("precision", quantityXaut > 0 && stepAligned(quantityXaut, snapshot.spot.qtyStep) && stepAligned(quantityXaut, snapshot.perpetual.qtyStep), true, "数量必须同时匹配现货和永续步长。"),
    check("spot_minimum", quantityXaut >= snapshot.spot.minOrderQty && spotNotional >= snapshot.spot.minNotionalUsd, true, "现货数量和名义必须达到实时最小值。"),
    check("perpetual_minimum", quantityXaut >= snapshot.perpetual.minOrderQty && perpetualNotional >= snapshot.perpetual.minNotionalUsd, true, "永续数量和名义必须达到实时最小值。"),
    check("spot_balance", snapshot.spotAvailableUsdt >= spotNotional + feesUsd, spotNotional + feesUsd, "现货账户 USDT 必须独立覆盖现货侧。"),
    check("futures_balance", snapshot.futuresAvailableUsdt >= perpetualNotional + feesUsd, perpetualNotional + feesUsd, "USD-M Futures 可用余额必须独立覆盖永续侧。"),
    check("no_existing_spot", snapshot.existingSpotQuantityXaut <= 1e-9 && snapshot.openSpotOrderCount === 0, 0, "专用账户不得已有 XAUT 现货或活动现货订单。"),
    check("no_existing_perpetual", snapshot.existingPerpetualQuantityXaut <= 1e-9 && snapshot.openPerpetualOrderCount === 0, 0, "专用账户不得已有 XAUT 永续仓位或活动合约订单。"),
    check("depth", snapshot.spot.depthUsd >= spotNotional && snapshot.perpetual.depthUsd >= perpetualNotional, true, "现货侧与永续侧公开盘口深度必须覆盖计划名义。"),
    check("order_cap", riskUsage.orderNotionalUsd <= limits.maxOrderNotionalUsd, limits.maxOrderNotionalUsd, "本次新增风险必须在当前 profile 单笔上限内。"),
    check("asset_cap", riskUsage.assetNotionalUsd <= Math.min(limits.maxAssetCapitalUsd, config.maxStrategyCapitalUsd), Math.min(limits.maxAssetCapitalUsd, config.maxStrategyCapitalUsd), "资产累计新增风险必须在受控上限内。"),
    check("strategy_cap", riskUsage.assetNotionalUsd <= Math.min(limits.maxAssetCapitalUsd, config.maxStrategyCapitalUsd), Math.min(limits.maxAssetCapitalUsd, config.maxStrategyCapitalUsd), "兼容字段：当前资产累计新增风险必须在受控策略资本上限内。"),
    check("account_cap", riskUsage.accountNotionalUsd <= limits.maxAccountCapitalUsd, limits.maxAccountCapitalUsd, "账户内自动策略累计新增风险必须在受控上限内。"),
    check("global_cap", riskUsage.globalNotionalUsd <= limits.maxGlobalCapitalUsd, limits.maxGlobalCapitalUsd, "全部自动策略累计新增风险必须在当前阶段上限内。"),
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
    totalBudgetUsd: capitalRequired,
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

function instrumentRulesMatch(
  profile: typeof XAUT_BINANCE_PROFILE,
  category: "spot" | "perpetual",
  instrument: RwaBinancePreflightSnapshot["spot"] | RwaBinancePreflightSnapshot["perpetual"],
) {
  try {
    assertRwaAutomationInstrumentRules(profile, category, instrument);
    return true;
  } catch {
    return false;
  }
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
  const { productionSelfTestPermitConfirmation: _privateConfirmation, ...publicExecutionConfig } = config;
  return {
    userId,
    accountId,
    ...publicExecutionConfig,
    serverGlobalKillSwitchActive,
    venue: "binance",
    phase: "execution_capable",
    providerWritesEnabled: true,
    automaticExecutionEnabled: false,
    armed: false,
  };
}

function invalidAccountAssetAuthorization() {
  return new RwaAccountAssetAuthorizationError(
    409,
    "asset_authorization_invalid",
    "账户资产授权与当前交易账户绑定不一致；已保持 fail-closed。",
  );
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

function assertRecoveryAutomationStopped(state: RwaAutomationStateData, serverKillSwitchActive: boolean) {
  const activeExecution = state.executions.some((execution) =>
    !["closed", "failed", "manual_intervention"].includes(execution.state));
  const activeReservation = state.executions.some((execution) => execution.reservedCapitalUsd > 0)
    || state.assetTakeovers.some((takeover) => takeover.reservedCapitalUsd > 0);
  const activeSmoke = state.connectivitySmokes.some((smoke) =>
    !["flat", "failed", "manual_intervention"].includes(smoke.stage));
  const activeTakeover = state.assetTakeovers.some((takeover) =>
    !["exited", "failed", "manual_intervention"].includes(takeover.state));
  if (
    state.config.globalExecutionEnabled
    || state.config.strategyEnabled
    || !state.config.killSwitchActive
    || !serverKillSwitchActive
    || state.challenges.length > 0
    || activeExecution
    || activeReservation
    || activeSmoke
    || activeTakeover
  ) {
    throw new RwaNeutralExecutionError(
      409,
      "recovery_unbind_automation_active",
      "自动化停止条件未全部确认，Recovery Unbind 已按 fail-closed 拒绝。",
    );
  }
}

function stopAutomationForCredentialRemoval(state: RwaAutomationStateData) {
  state.config = {
    ...state.config,
    globalExecutionEnabled: false,
    strategyEnabled: false,
    killSwitchActive: true,
    productionSelfTestPermitConfirmation: null,
  };
  state.challenges = [];
}

function credentialFailureLifecycle(error: unknown): Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active"> {
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
    return new RwaNeutralExecutionError(503, error.category, error.message);
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
        : ["provider_credential_invalid", "provider_request_invalid"].includes(error.category)
          ? 400
          : error.category === "provider_region_restricted"
            ? 451
            : error.category === "provider_permission_error"
              ? 403
              : error.category === "provider_rate_limited"
                ? 429
                : error.category === "provider_timeout"
                  ? 504
        : 502;
    return new RwaNeutralExecutionError(statusCode, error.category, error.message, {
      providerCode: error.providerCode,
    });
  }
  return new RwaNeutralExecutionError(502, "provider_unavailable", fallback);
}

function errorCategory(error: unknown) {
  return error instanceof RwaNeutralExecutionError
    || error instanceof RwaBinanceProviderError
    || error instanceof RwaExecutionSafetyError
    ? error.category
    : "automation_execution_error";
}

function finalizeTrackedExecutions(state: RwaAutomationStateData, executionIds: string[], now: number) {
  const ids = new Set(executionIds);
  let fullyClosed = true;
  for (const execution of state.executions) {
    if (!ids.has(execution.executionId)) continue;
    execution.strategyPosition.coverage = "complete";
    execution.strategyPosition.updatedAt = now;
    const hasResidual = execution.strategyPosition.spotRemainingXaut > 1e-12
      || execution.strategyPosition.perpetualRemainingXaut > 1e-12;
    if (!hasResidual) execution.reservedCapitalUsd = 0;
    fullyClosed = fullyClosed && !hasResidual;
    execution.state = hasResidual ? "partial_closed" : "closed";
    execution.message = hasResidual
      ? "策略持久归属仍有不可交易残余，需要人工核对。"
      : "策略持久归属仓位已由 close-all 权威确认退出。";
    execution.updatedAt = now;
  }
  return fullyClosed;
}

function applyTrackedCloseFill(
  state: RwaAutomationStateData,
  executionIds: string[],
  side: "spot" | "linear",
  filledQuantityXaut: number,
  now: number,
) {
  if (!Number.isFinite(filledQuantityXaut) || filledQuantityXaut < 0) {
    throw new RwaExecutionSafetyError("provider_snapshot_invalid", "交易所成交数量无效，已停止自动退出。");
  }
  let remaining = filledQuantityXaut;
  const ids = new Set(executionIds);
  for (const execution of state.executions) {
    if (!ids.has(execution.executionId) || remaining <= 1e-12) continue;
    if (execution.strategyPosition.coverage !== "complete") {
      throw new RwaExecutionSafetyError("strategy_ownership_ambiguous", "策略持仓归属记录不完整，已停止自动退出。");
    }
    const key = side === "spot" ? "spotRemainingXaut" : "perpetualRemainingXaut";
    const applied = Math.min(execution.strategyPosition[key], remaining);
    execution.strategyPosition[key] = normalizeStrategyQuantity(execution.strategyPosition[key] - applied);
    execution.strategyPosition.updatedAt = now;
    execution.updatedAt = now;
    remaining -= applied;
  }
  if (remaining > 1e-9) {
    throw new RwaExecutionSafetyError("strategy_ownership_ambiguous", "成交数量超过持久策略归属，已停止自动退出。");
  }
}

function normalizeStrategyQuantity(value: number) {
  return Math.max(0, Math.round(value * 1_000_000_000_000) / 1_000_000_000_000);
}

function hasNoStrategyExposureOrOrders(execution: RwaExecutionRecord) {
  return execution.strategyPosition.spotRemainingXaut <= 1e-12
    && execution.strategyPosition.perpetualRemainingXaut <= 1e-12
    && execution.activityContinuity.spot.providerOrderIds.length === 0
    && execution.activityContinuity.perpetual.providerOrderIds.length === 0;
}

function strategyExposureExecutions(executions: RwaExecutionRecord[]) {
  return executions.filter((execution) =>
    execution.challengeId !== "close-all"
    && (execution.strategyPosition.spotRemainingXaut > 1e-12
      || execution.strategyPosition.perpetualRemainingXaut > 1e-12));
}

function markExecutionsActivityAmbiguous(
  state: RwaAutomationStateData,
  executions: RwaExecutionRecord[],
  now: number,
) {
  const ids = new Set(executions.map((execution) => execution.executionId));
  for (const execution of state.executions) {
    if (!ids.has(execution.executionId)) continue;
    execution.activityContinuity.spot.coverage = "ambiguous";
    execution.activityContinuity.perpetual.coverage = "ambiguous";
    execution.activityContinuity.spot.updatedAt = now;
    execution.activityContinuity.perpetual.updatedAt = now;
    execution.state = "manual_intervention";
    execution.errorCategory = "strategy_ownership_ambiguous";
    execution.message = "交易所活动连续性无法完整证明，已关闭自动退出并要求人工核对。";
    execution.updatedAt = now;
  }
  state.config.killSwitchActive = true;
  state.config.strategyEnabled = false;
  state.config.globalExecutionEnabled = false;
  state.challenges = [];
}

function roundResidual(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function hasPartialClose(preview: RwaExecutionReconciliationPreview) {
  return Boolean(
    (preview.authoritativeState.legs.spot.quantityXaut > 1e-9 && preview.authoritativeState.legs.perpetual.quantityXaut <= 1e-9)
    || (preview.authoritativeState.legs.perpetual.quantityXaut > 1e-9 && preview.authoritativeState.legs.spot.quantityXaut <= 1e-9),
  );
}

function selectReconciliationExecution(executions: RwaExecutionRecord[], requestedId: unknown) {
  if (typeof requestedId === "string" && requestedId.trim()) {
    return executions.find((item) => item.executionId === requestedId.trim()) ?? null;
  }
  return [...executions]
    .filter((item) => item.state === "manual_intervention" || item.state === "partial_closed" || item.state === "compensating")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
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

function ceilStep(value: number, step: number) {
  return step > 0 ? Math.ceil((value - 1e-12) / step) * step : 0;
}

function orderPositionQuantity(order: { positionQuantityXaut?: number; filledQuantityXaut: number }) {
  const value = order.positionQuantityXaut ?? order.filledQuantityXaut;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

type SmokeAllowedOpenOrder = {
  category: "spot" | "linear";
  orderLinkId: string;
  providerOrderId: string;
};

function recoveryAllowedSmokeOpenOrder(
  smoke: RwaConnectivitySmokeRecord,
): SmokeAllowedOpenOrder | null {
  const order = smoke.stage === "futures_closing"
    ? smoke.exit.futuresCloseOrder
    : smoke.stage === "spot_closing"
      ? smoke.exit.spotCloseOrder
      : null;
  if (!order || (order.status !== "New" && order.status !== "PartiallyFilled")) return null;
  return {
    category: smoke.stage === "futures_closing" ? "linear" : "spot",
    orderLinkId: smoke.stage === "futures_closing"
      ? `${smoke.orderLinkPrefix}c1`
      : `${smoke.orderLinkPrefix}c2`,
    providerOrderId: order.orderId,
  };
}

function smokePreflightChecks(
  snapshot: RwaBinancePreflightSnapshot,
  budget: ReturnType<typeof calculateConnectivitySmokeBudget>,
  now: number,
) {
  const spotRequired = budget.spotNotionalUsd + budget.spotFeesUsd + budget.spotSlippageReserveUsd
    + budget.roundingReserveUsd;
  const futuresRequired = budget.futuresMarginUsd + budget.futuresFeesUsd + budget.futuresSlippageReserveUsd;
  return [
    { name: "product_status", passed: snapshot.productAvailability.available
      && snapshot.spot.status === "Trading" && snapshot.perpetual.status === "Trading", message: "两侧产品必须实时为 TRADING。" },
    { name: "permissions", passed: snapshot.permissions.read && snapshot.permissions.spotTrade
      && snapshot.permissions.contractTrade && snapshot.permissions.withdraw === false
      && snapshot.permissions.positionModeSupported, message: "必须具备 read/Spot/Futures、withdraw=false 且 one-way。" },
    { name: "blank_spot", passed: snapshot.existingSpotQuantityXaut <= 1e-12
      && snapshot.spotFreeXaut <= 1e-12 && snapshot.spotLockedXaut <= 1e-12, message: "专用子账户 Spot total/free/locked 必须为 0。" },
    { name: "blank_futures", passed: snapshot.existingPerpetualQuantityXaut <= 1e-12
      && snapshot.perpetualPositionSide === "flat", message: "专用子账户 Futures position 必须为 0。" },
    { name: "leverage_1x", passed: snapshot.perpetual.leverage === 1,
      message: "USD-M XAUTUSDT 当前杠杆必须已配置为 1x；smoke 仅只读验证，不执行杠杆配置写入。" },
    { name: "blank_orders", passed: snapshot.openSpotOrderCount === 0
      && snapshot.openPerpetualOrderCount === 0, message: "两侧 XAUT 活动订单必须为 0。" },
    { name: "dynamic_quantity", passed: budget.quantityXaut > 0
      && budget.totalCapitalUsd <= budget.limitUsd + 1e-9, message: "共同最小数量必须满足实时规则和本次 Gate 2 授权总预算。" },
    { name: "spot_balance", passed: snapshot.spotAvailableUsdt + 1e-9 >= spotRequired, message: "Spot USDT 余额必须独立覆盖本侧预算。" },
    { name: "futures_balance", passed: snapshot.futuresAvailableUsdt + 1e-9 >= futuresRequired, message: "Futures USDT 余额必须独立覆盖 1x 保证金及本侧准备金。" },
    { name: "snapshot_fresh", passed: now - snapshot.fetchedAt <= RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS,
      message: "provider 私有快照必须新鲜。" },
  ];
}

function assertSmokeSnapshot(
  snapshot: RwaBinancePreflightSnapshot,
  smoke: RwaConnectivitySmokeRecord,
  expected: "blank" | "spot_only" | "hedged" | "within_ledger" | "futures_flat" | "flat",
  allowedOpenOrder: SmokeAllowedOpenOrder | null = null,
  requireLeverage1x = false,
) {
  const allowedProviderOrder = allowedOpenOrder
    ? [
      smoke.spotOpenOrder,
      smoke.futuresOpenOrder,
      smoke.exit.futuresCloseOrder,
      smoke.exit.spotCloseOrder,
    ].find((order) =>
      order?.orderId === allowedOpenOrder.providerOrderId
      && order.orderLinkId === allowedOpenOrder.orderLinkId)
    : null;
  const allowedOrderIsExactAndActive = Boolean(allowedProviderOrder && (
    allowedProviderOrder.status === "New" || allowedProviderOrder.status === "PartiallyFilled"
  ) && (
    allowedOpenOrder?.category === "spot"
      ? snapshot.openSpotOrderCount === 1 && snapshot.openPerpetualOrderCount === 0
      : snapshot.openSpotOrderCount === 0 && snapshot.openPerpetualOrderCount === 1
  ));
  const allowedOrderBecameTerminal = Boolean(
    allowedProviderOrder
    && allowedProviderOrder.status !== "New"
    && allowedProviderOrder.status !== "PartiallyFilled"
    && allowedProviderOrder.status !== "Unknown"
    && snapshot.openSpotOrderCount === 0
    && snapshot.openPerpetualOrderCount === 0,
  );
  const openOrdersMatch = allowedOpenOrder
    ? allowedOrderIsExactAndActive || allowedOrderBecameTerminal
    : snapshot.openSpotOrderCount === 0 && snapshot.openPerpetualOrderCount === 0;
  if (requireLeverage1x && snapshot.perpetual.leverage !== 1) {
    throw new RwaNeutralExecutionError(
      409,
      "connectivity_smoke_leverage_not_1x",
      "XAUTUSDT USD-M 当前杠杆不再是 1x；smoke 已停止且不会自动修改杠杆。",
    );
  }
  if (
    snapshot.accountId !== smoke.accountId
    || snapshot.accountFingerprint !== smoke.accountFingerprint
    || !openOrdersMatch
    || Math.abs(snapshot.existingSpotQuantityXaut - snapshot.spotFreeXaut - snapshot.spotLockedXaut) > 1e-9
    || snapshot.existingSpotQuantityXaut > smoke.openedSpotQuantityXaut + 1e-9
    || snapshot.existingPerpetualQuantityXaut > smoke.openedFuturesQuantityXaut + 1e-9
  ) {
    throw new RwaNeutralExecutionError(
      409,
      "connectivity_smoke_external_activity",
      "检测到外部 XAUT 活动、归属不明或数量超过 smoke 账本。",
    );
  }
  const ledger = smokeCurrentLedger(smoke);
  const spot = snapshot.existingSpotQuantityXaut;
  const futures = snapshot.existingPerpetualQuantityXaut;
  const matches = expected === "blank" || expected === "flat"
    ? spot <= 1e-12 && futures <= 1e-12
    : expected === "spot_only"
      ? approximately(spot, ledger.spot) && futures <= 1e-12
      : expected === "hedged"
        ? approximately(spot, ledger.spot)
          && approximately(futures, ledger.futures)
        : expected === "futures_flat"
          ? futures <= 1e-12 && approximately(spot, ledger.spot)
          : expected === "within_ledger"
            ? approximately(spot, ledger.spot) && approximately(futures, ledger.futures)
            : true;
  if (!matches) {
    throw new RwaNeutralExecutionError(
      409,
      "connectivity_smoke_provider_state_unknown",
      "provider 权威数量与 smoke 当前阶段账本不一致。",
    );
  }
}

function smokeOrderIds(smoke: RwaConnectivitySmokeRecord) {
  return {
    spotOpen: `${smoke.orderLinkPrefix}s1`,
    futuresOpen: `${smoke.orderLinkPrefix}p1`,
    futuresClose: `${smoke.orderLinkPrefix}c1`,
    spotClose: `${smoke.orderLinkPrefix}c2`,
  };
}

function smokeCurrentLedger(smoke: RwaConnectivitySmokeRecord) {
  return {
    spot: Math.max(0, smoke.openedSpotQuantityXaut
      - orderPositionQuantity(smoke.exit.spotCloseOrder ?? { filledQuantityXaut: 0 })),
    futures: Math.max(0, smoke.openedFuturesQuantityXaut
      - orderPositionQuantity(smoke.exit.futuresCloseOrder ?? { filledQuantityXaut: 0 })),
  };
}

function sameSmokeBudget(
  current: ReturnType<typeof calculateConnectivitySmokeBudget>,
  reserved: ReturnType<typeof calculateConnectivitySmokeBudget>,
) {
  return current.limitUsd === reserved.limitUsd
    && current.quantityXaut === reserved.quantityXaut
    && current.commonQtyStep === reserved.commonQtyStep
    && current.slippageBpsPerAction === reserved.slippageBpsPerAction
    && approximately(current.prices.spotOpenLimit, reserved.prices.spotOpenLimit)
    && approximately(current.prices.futuresOpenLimit, reserved.prices.futuresOpenLimit)
    && approximately(current.prices.futuresCloseLimit, reserved.prices.futuresCloseLimit)
    && approximately(current.prices.spotCloseLimit, reserved.prices.spotCloseLimit)
    && approximately(current.spotNotionalUsd, reserved.spotNotionalUsd)
    && approximately(current.futuresMarginUsd, reserved.futuresMarginUsd)
    && approximately(current.spotFeesUsd, reserved.spotFeesUsd)
    && approximately(current.futuresFeesUsd, reserved.futuresFeesUsd)
    && approximately(current.spotSlippageReserveUsd, reserved.spotSlippageReserveUsd)
    && approximately(current.futuresSlippageReserveUsd, reserved.futuresSlippageReserveUsd)
    && approximately(current.roundingReserveUsd, reserved.roundingReserveUsd)
    && approximately(current.totalCapitalUsd, reserved.totalCapitalUsd);
}

function approximately(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9;
}

function publicConnectivitySmoke(smoke: RwaConnectivitySmokeRecord) {
  const orders = publicConnectivitySmokeOrders(smoke);
  return {
    smokeId: smoke.smokeId,
    purpose: smoke.purpose,
    mode: smoke.mode,
    venue: "binance" as const,
    accountFingerprint: smoke.accountFingerprint,
    stage: smoke.stage,
    policyVersion: smoke.policyVersion,
    policyDigest: smoke.policyDigest,
    budget: smoke.budget,
    openedSpotQuantityXaut: smoke.openedSpotQuantityXaut,
    openedFuturesQuantityXaut: smoke.openedFuturesQuantityXaut,
    orders,
    providerState: smoke.providerState,
    timeline: smoke.timeline,
    receipt: smoke.receipt ? publicConnectivitySmokeReceipt(smoke) : null,
    noReopen: smoke.noReopen,
    providerMutationCount: smoke.providerMutationCount,
    errorCategory: smoke.errorCategory,
    message: smoke.message,
    createdAt: smoke.createdAt,
    updatedAt: smoke.updatedAt,
  };
}

function publicConnectivitySmokeReceipt(smoke: RwaConnectivitySmokeRecord) {
  const receipt = smoke.receipt!;
  const orders = publicConnectivitySmokeOrders(smoke);
  const feeOrders = [
    smoke.spotOpenOrder,
    smoke.futuresOpenOrder,
    smoke.exit.futuresCloseOrder,
    smoke.exit.spotCloseOrder,
  ];
  const feesAvailable = feeOrders.every((order) =>
    order !== null && Number.isFinite(order.feeUsd) && order.feeUsd >= 0);
  const disclosureMatches = smoke.policyVersion === RWA_CONNECTIVITY_SMOKE_POLICY_VERSION
    && smoke.policyDigest === RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST;
  return {
    ...receipt,
    acceptedConfirmations: {
      exclusiveWindowConfirmed: true,
      manualRecoveryConfirmed: true,
      nonAtomicRiskAccepted: true,
    },
    disclosureAvailability: disclosureMatches ? "available" as const : "unavailable_for_historical_digest" as const,
    disclosure: disclosureMatches ? {
      continuity: RWA_CONNECTIVITY_SMOKE_POLICY.continuity,
      exclusiveWindowRules: RWA_CONNECTIVITY_SMOKE_POLICY.exclusiveWindowRules,
      manualRecoveryRequirements: RWA_CONNECTIVITY_SMOKE_POLICY.manualRecoveryRequirements,
      residualRisks: RWA_CONNECTIVITY_SMOKE_POLICY.residualRisks,
    } : null,
    disclosureReason: disclosureMatches ? null : "historical_policy_digest_not_available",
    orders,
    finalProviderState: smoke.providerState,
    timeline: smoke.timeline,
    metrics: {
      actualFeesUsd: feesAvailable ? {
        availability: "available" as const,
        value: feeOrders.reduce((sum, order) => sum + order!.feeUsd, 0),
        reason: null,
      } : unavailableActualMetric("authoritative_fee_inputs_incomplete"),
      actualSlippageUsd: unavailableActualMetric("authoritative_reference_prices_not_persisted"),
      actualRealizedPnlUsd: unavailableActualMetric("authoritative_pnl_inputs_not_persisted"),
    },
  };
}

function publicConnectivitySmokeOrders(smoke: RwaConnectivitySmokeRecord) {
  return {
    spotOpen: publicSmokeOrder(smoke.spotOpenOrder, smoke.orderLinkPrefix, RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.spotOpen),
    futuresOpen: publicSmokeOrder(smoke.futuresOpenOrder, smoke.orderLinkPrefix, RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.futuresOpen),
    futuresClose: publicSmokeOrder(smoke.exit.futuresCloseOrder, smoke.orderLinkPrefix, RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.futuresClose),
    spotClose: publicSmokeOrder(smoke.exit.spotCloseOrder, smoke.orderLinkPrefix, RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.spotClose),
  };
}

function publicSmokeOrder(
  order: RwaProviderOrder | null,
  prefix: string,
  slot: typeof RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS[keyof typeof RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS],
) {
  const expectedOrderLinkId = `${prefix}${slot.suffix}`;
  if (!order || order.orderLinkId !== expectedOrderLinkId) return null;
  return {
    orderId: order.orderId,
    orderLinkId: order.orderLinkId,
    category: slot.category,
    side: slot.side,
    status: order.status,
    requestedQuantityXaut: order.requestedQuantityXaut,
    filledQuantityXaut: order.filledQuantityXaut,
    averagePriceUsd: Number.isFinite(order.averagePrice) ? order.averagePrice : null,
    feeUsd: Number.isFinite(order.feeUsd) ? order.feeUsd : null,
    reduceOnly: slot.reduceOnly,
    updatedAt: order.updatedAt,
  };
}

function unavailableActualMetric(reason: string) {
  return { availability: "unavailable" as const, value: null, reason };
}

function unavailableSmokeProviderState(reason: string) {
  return {
    verificationStatus: "unavailable" as const,
    observedAt: null,
    residualSpotQuantityXaut: null,
    residualFuturesQuantityXaut: null,
    activeSpotOrderCount: null,
    activeFuturesOrderCount: null,
    activeTotalOrderCount: null,
    providerFlatConfirmed: null,
    reason,
  };
}

function providerStateFromSnapshot(
  snapshot: RwaBinancePreflightSnapshot,
  verificationStatus: "verified" | "stale" | "ambiguous",
  reason: string,
  now: number,
) {
  if (!Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt < 0 || snapshot.fetchedAt > now) {
    return unavailableSmokeProviderState("provider_snapshot_time_invalid");
  }
  const activeTotalOrderCount = snapshot.openSpotOrderCount + snapshot.openPerpetualOrderCount;
  return {
    verificationStatus,
    observedAt: snapshot.fetchedAt,
    residualSpotQuantityXaut: snapshot.existingSpotQuantityXaut,
    residualFuturesQuantityXaut: snapshot.existingPerpetualQuantityXaut,
    activeSpotOrderCount: snapshot.openSpotOrderCount,
    activeFuturesOrderCount: snapshot.openPerpetualOrderCount,
    activeTotalOrderCount,
    providerFlatConfirmed: verificationStatus === "verified"
      ? snapshot.existingSpotQuantityXaut === 0
        && snapshot.existingPerpetualQuantityXaut === 0
        && snapshot.openSpotOrderCount === 0
        && snapshot.openPerpetualOrderCount === 0
      : null,
    reason,
  };
}

export function isFreshConnectivitySmokeSnapshot(
  snapshot: RwaBinancePreflightSnapshot,
  now: number,
) {
  return Number.isFinite(snapshot.fetchedAt)
    && snapshot.fetchedAt >= 0
    && snapshot.fetchedAt <= now
    && now - snapshot.fetchedAt <= RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS;
}

function stepAligned(value: number, step: number) {
  if (!(step > 0)) return false;
  return Math.abs(value / step - Math.round(value / step)) <= 1e-8;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export const binancePhaseOneDefaultConfig = { ...defaultRwaExecutionConfig };
