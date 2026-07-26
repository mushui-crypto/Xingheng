import { randomBytes } from "node:crypto";
import {
  assertRwaAutomationNewRisk,
  calculateRwaAutomationNewRiskUsage,
  mergeRwaAutomationCapitalExposures,
  requireRwaAutomationExecutionProfile,
  type RwaAutomationResolvedAssetProfile,
} from "./RwaAutomationAssetProfile";
import {
  automationCapitalExposuresFromExecutions,
  automationCapitalExposuresFromTakeovers,
  readRwaAutomationCapitalExposures,
  type RwaAutomationPersistentStore,
  type RwaAutomationStateData,
} from "./RwaAutomationPersistentStore";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import {
  assertRwaAssetTakeoverPreview,
  createRwaAssetTakeoverPreview,
  createRwaAssetTakeoverRecord,
  publicRwaAssetTakeoverRecord,
  requireActiveTakeoverAuthorization,
  RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT,
  RwaAssetTakeoverError,
  validateRwaAssetTakeoverPreview,
  type RwaAssetTakeoverLeverage,
  type RwaAssetTakeoverPreview,
  type RwaAssetTakeoverRecord,
} from "./RwaAssetTakeover";
import { RwaAssetTakeoverExecutionEngine } from "./RwaAssetTakeoverExecutionEngine";
import {
  RWA_ASSET_RUNTIME_POLL_INTERVAL_MS,
  assertRwaAssetTakeoverExitPreview,
  createRwaAssetTakeoverRuntimeManual,
  createRwaAssetTakeoverExitPreview,
  validateRwaAssetTakeoverExitPreview,
  type RwaAssetTakeoverExitPreview,
  type RwaAssetTakeoverRuntimeReason,
} from "./RwaAssetTakeoverRuntime";
import {
  RwaAssetTakeoverRuntimeEngine,
  RwaAssetTakeoverRuntimeError,
} from "./RwaAssetTakeoverRuntimeEngine";
import type {
  RwaNeutralTradingClient,
  RwaVenueAccountIdentity,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";

type CredentialBinding = Pick<RwaVenueAccountIdentity, "accountId" | "accountFingerprint"> & {
  updatedAt: number;
};

export class RwaAssetTakeoverCoordinator<TPermissions extends RwaVenuePermissions> {
  private readonly engine: RwaAssetTakeoverExecutionEngine;
  private readonly runtimeEngine: RwaAssetTakeoverRuntimeEngine;

  constructor(private readonly options: {
    venue: "binance" | "bybit";
    store: RwaAutomationPersistentStore<any, TPermissions>;
    client: () => Promise<RwaNeutralTradingClient<TPermissions>>;
    publicMark: () => Promise<{ capturedAt: number; perpetualMark: number }>;
    credentialBinding: () => Promise<CredentialBinding>;
    assertExecutionLeaseHeld: () => void;
    serverKillSwitchActive: () => boolean;
    now?: () => number;
  }) {
    this.profile = requireRwaAutomationExecutionProfile("xaut", options.venue);
    this.now = options.now ?? Date.now;
    this.engine = new RwaAssetTakeoverExecutionEngine(this.profile, this.now);
    this.runtimeEngine = new RwaAssetTakeoverRuntimeEngine(this.profile, this.now);
  }

  private readonly profile: RwaAutomationResolvedAssetProfile;
  private readonly now: () => number;

  async preview(input: {
    assetId: string;
    newCapitalUsd: number;
    leverage: RwaAssetTakeoverLeverage;
  }) {
    this.requireAsset(input.assetId);
    const metadata = await this.options.credentialBinding();
    const state = await this.options.store.readState();
    const client = await this.options.client();
    if (!client.readAssetTakeoverSnapshot) throw unavailable();
    const provider = await client.readAssetTakeoverSnapshot();
    this.assertProviderBinding(provider.account, metadata);
    const authorization = requireActiveTakeoverAuthorization({
      authorizations: state.assetAuthorizations,
      profile: this.profile,
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
    });
    const preview = createRwaAssetTakeoverPreview({
      profile: this.profile,
      authorization,
      provider,
      newCapitalUsd: input.newCapitalUsd,
      selectedLeverage: input.leverage,
      now: this.now(),
    });
    await this.assertCapitalCapacity(state, preview, metadata);
    return preview;
  }

  async start(input: {
    assetId: string;
    preview: RwaAssetTakeoverPreview;
    idempotencyKey: string;
  }) {
    this.requireAsset(input.assetId);
    const provided = validateRwaAssetTakeoverPreview(input.preview);
    if (!validIdempotencyKey(input.idempotencyKey)) throw invalidRequest();
    this.options.assertExecutionLeaseHeld();
    const metadata = await this.options.credentialBinding();
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    this.assertExecutionEnabled(state);
    const prior = state.assetTakeovers.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (prior.previewDigest !== provided.previewDigest) throw invalidRequest();
      return publicRwaAssetTakeoverRecord(prior);
    }
    this.assertOnlyTakeoverForAuthorization(state, provided.authorizationId);
    const client = await this.options.client();
    this.options.assertExecutionLeaseHeld();
    if (!client.readAssetTakeoverSnapshot) throw unavailable();
    const provider = await client.readAssetTakeoverSnapshot();
    this.options.assertExecutionLeaseHeld();
    this.assertProviderBinding(provider.account, metadata);
    const authorization = requireActiveTakeoverAuthorization({
      authorizations: state.assetAuthorizations,
      profile: this.profile,
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
      authorizationId: provided.authorizationId,
    });
    const current = createRwaAssetTakeoverPreview({
      profile: this.profile,
      authorization,
      provider,
      newCapitalUsd: provided.newCapitalUsd,
      selectedLeverage: provided.selectedLeverage,
      now: this.now(),
    });
    assertRwaAssetTakeoverPreview({ provided, current, now: this.now() });
    await this.assertCapitalCapacity(state, current, metadata);
    const record = createRwaAssetTakeoverRecord({
      userId: this.options.store.ownerUserId,
      userDomain: this.options.store.userDomain,
      accountId: metadata.accountId,
      preview: provided,
      idempotencyKey: input.idempotencyKey,
      orderLinkPrefix: `t${this.options.store.userDomain.slice(0, 8)}${randomBytes(4).toString("hex")}`,
      now: this.now(),
    });
    state.assetTakeovers.push(record);
    await this.writeStateWithLease(state);
    const result = await this.engine.execute({
      client,
      authorization,
      preview: provided,
      record,
      hooks: this.hooks(state, record),
    });
    return result.status === "managed"
      ? publicRwaAssetTakeoverRecord(result.record)
      : {
        ...publicRwaAssetTakeoverRecord(result.record),
        reconfirmationPreview: result.preview,
      };
  }

  async reconfirm(input: {
    takeoverId: string;
    preview: RwaAssetTakeoverPreview;
  }) {
    this.options.assertExecutionLeaseHeld();
    const provided = validateRwaAssetTakeoverPreview(input.preview);
    const metadata = await this.options.credentialBinding();
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    this.assertExecutionEnabled(state);
    const record = state.assetTakeovers.find((item) => item.takeoverId === input.takeoverId);
    if (!record || record.state !== "awaiting_reconfirm" || record.previewDigest !== provided.previewDigest) {
      throw invalidRequest();
    }
    this.assertOnlyTakeoverForAuthorization(state, record.authorizationId, record.takeoverId);
    const authorization = requireActiveTakeoverAuthorization({
      authorizations: state.assetAuthorizations,
      profile: this.profile,
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
      authorizationId: record.authorizationId,
    });
    const client = await this.options.client();
    this.options.assertExecutionLeaseHeld();
    if (!client.readManagedAssetSnapshot) throw unavailable();
    const provider = await client.readManagedAssetSnapshot();
    this.options.assertExecutionLeaseHeld();
    this.assertProviderBinding(provider.account, metadata);
    const current = createRwaAssetTakeoverPreview({
      profile: this.profile,
      authorization,
      provider,
      newCapitalUsd: record.newCapitalUsd,
      selectedLeverage: record.leverage,
      now: this.now(),
    });
    assertRwaAssetTakeoverPreview({
      provided,
      current,
      now: this.now(),
      allowOrderChanges: true,
    });
    await this.assertCapitalCapacity(state, current, metadata, record.takeoverId);
    const result = await this.engine.execute({
      client,
      authorization,
      preview: provided,
      record,
      hooks: this.hooks(state, record),
      reconfirmed: true,
    });
    return result.status === "managed"
      ? publicRwaAssetTakeoverRecord(result.record)
      : {
        ...publicRwaAssetTakeoverRecord(result.record),
        reconfirmationPreview: result.preview,
      };
  }

  async status(takeoverId: string) {
    const state = await this.options.store.readState();
    const record = state.assetTakeovers.find((item) => item.takeoverId === takeoverId);
    if (!record) {
      throw new RwaAssetTakeoverError(404, "asset_takeover_invalid", "未找到当前账户的接管记录。");
    }
    return publicRwaAssetTakeoverRecord(record);
  }

  async pollManaged() {
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    const managed = state.assetTakeovers.filter((item) => item.state === "managed");
    if (!managed.length) return false;
    let metadata: CredentialBinding;
    let client: RwaNeutralTradingClient<TPermissions>;
    try {
      metadata = await this.options.credentialBinding();
      this.options.assertExecutionLeaseHeld();
      client = await this.options.client();
      this.options.assertExecutionLeaseHeld();
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      for (const record of managed) {
        if (!record.runtime) continue;
        await this.runtimeHooks(state, record).disarm(
          record,
          "account_changed",
          "自动运行无法核对当前账户凭证，已急停并要求人工处理。",
        );
      }
      return false;
    }
    for (const record of managed) {
      try {
        this.assertProviderBinding(record, metadata);
        const authorization = requireActiveTakeoverAuthorization({
          authorizations: state.assetAuthorizations,
          profile: this.profile,
          accountId: metadata.accountId,
          accountFingerprint: metadata.accountFingerprint,
          authorizationId: record.authorizationId,
        });
        await this.runtimeEngine.recover({
          client,
          record,
          hooks: this.runtimeHooks(state, record),
        });
        if (record.state !== "managed") continue;
        await this.runtimeEngine.poll({
          client,
          authorization,
          record,
          hooks: this.runtimeHooks(state, record),
          userKillSwitchActive: state.config.killSwitchActive,
          serverKillSwitchActive: this.options.serverKillSwitchActive(),
        });
      } catch (error) {
        if (error instanceof RwaAutomationExecutionLeaseError) throw error;
        if (
          error instanceof RwaAssetTakeoverRuntimeError
          && [
            "asset_takeover_runtime_paused",
            "asset_takeover_runtime_manual_intervention",
            "asset_takeover_exit_incomplete",
          ]
            .includes(error.category)
        ) continue;
        throw error;
      }
    }
    return state.assetTakeovers.some((item) => item.state === "managed");
  }

  async pollManagedPublicRisk() {
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    const managed = state.assetTakeovers.filter((item) =>
      item.state === "managed" && item.runtime !== null);
    if (!managed.length) return false;
    if (
      state.config.killSwitchActive
      || this.options.serverKillSwitchActive()
      || managed.some((item) =>
        item.runtime!.lastSuccessfulCheckAt === null
        || this.now() - item.runtime!.lastSuccessfulCheckAt! >= RWA_ASSET_RUNTIME_POLL_INTERVAL_MS)
    ) return this.pollManaged();

    try {
      const mark = await this.options.publicMark();
      this.options.assertExecutionLeaseHeld();
      if (
        !Number.isSafeInteger(mark.capturedAt)
        || mark.capturedAt <= 0
        || mark.capturedAt > this.now() + 5_000
        || !Number.isFinite(mark.perpetualMark)
        || mark.perpetualMark <= 0
      ) return this.pollManaged();
      for (const record of managed) {
        const snapshot = record.runtime!.authoritativeSnapshot;
        if (!snapshot || snapshot.perpetualQuantity <= 0) continue;
        if (snapshot.liquidationDistancePercent === null) return this.pollManaged();
        const liquidationPrice = snapshot.perpetualMark
          * (1 + snapshot.liquidationDistancePercent / 100);
        const currentDistance = (liquidationPrice - mark.perpetualMark)
          / mark.perpetualMark * 100;
        if (
          !Number.isFinite(currentDistance)
          || currentDistance < RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT
        ) return this.pollManaged();
      }
      return true;
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      return this.pollManaged();
    }
  }

  async previewExit(input: { takeoverId: string }) {
    this.options.assertExecutionLeaseHeld();
    const metadata = await this.options.credentialBinding();
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    const record = this.requireManagedTakeover(state, input.takeoverId, metadata);
    const client = await this.options.client();
    this.options.assertExecutionLeaseHeld();
    if (!client.readManagedAssetSnapshot) throw unavailable();
    const provider = await client.readManagedAssetSnapshot();
    this.options.assertExecutionLeaseHeld();
    this.assertProviderBinding(provider.account, metadata);
    const snapshot = this.runtimeEngine.snapshotForPreview(provider, record);
    if (
      Math.abs(snapshot.spotQuantity - snapshot.perpetualQuantity)
        > this.profile.asset.hedgeToleranceBase
      || snapshot.spotLockedQuantity > this.profile.asset.hedgeToleranceBase
    ) throw invalidExitPreview();
    return createRwaAssetTakeoverExitPreview({
      takeoverId: record.takeoverId,
      venue: record.venue,
      assetId: "xaut",
      profileId: record.profileId,
      authorizationId: record.authorizationId,
      authorizationCreatedAt: record.authorizationCreatedAt,
      snapshot,
      now: this.now(),
    });
  }

  async confirmExit(input: {
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
    idempotencyKey: string;
  }) {
    this.options.assertExecutionLeaseHeld();
    if (!validIdempotencyKey(input.idempotencyKey)) throw invalidExitPreview();
    const provided = validateRwaAssetTakeoverExitPreview(input.preview);
    const metadata = await this.options.credentialBinding();
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    const record = this.requireManagedTakeover(state, input.takeoverId, metadata);
    if (record.runtime?.exitIdempotencyKey) {
      if (record.runtime.exitIdempotencyKey !== input.idempotencyKey) throw invalidExitPreview();
      return publicRwaAssetTakeoverRecord(record);
    }
    const client = await this.options.client();
    this.options.assertExecutionLeaseHeld();
    if (!client.readAssetTakeoverSnapshot) throw unavailable();
    const provider = await client.readAssetTakeoverSnapshot();
    this.options.assertExecutionLeaseHeld();
    this.assertProviderBinding(provider.account, metadata);
    const snapshot = this.runtimeEngine.snapshotForPreview(provider, record);
    const current = createRwaAssetTakeoverExitPreview({
      takeoverId: record.takeoverId,
      venue: record.venue,
      assetId: "xaut",
      profileId: record.profileId,
      authorizationId: record.authorizationId,
      authorizationCreatedAt: record.authorizationCreatedAt,
      snapshot,
      now: this.now(),
    });
    try {
      assertRwaAssetTakeoverExitPreview({ provided, current, now: this.now() });
    } catch {
      throw invalidExitPreview();
    }
    record.runtime!.exitIdempotencyKey = input.idempotencyKey;
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await this.writeStateWithLease(state);
    const authorization = requireActiveTakeoverAuthorization({
      authorizations: state.assetAuthorizations,
      profile: this.profile,
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
      authorizationId: record.authorizationId,
    });
    void authorization;
    await this.runtimeEngine.exit({
      client,
      record,
      hooks: this.runtimeHooks(state, record),
      reason: "user_exit",
      emergency: false,
      idempotencyKey: input.idempotencyKey,
      initialProvider: provider,
    });
    return publicRwaAssetTakeoverRecord(record);
  }

  async exitStatus(takeoverId: string) {
    return this.status(takeoverId);
  }

  async recoverPending() {
    this.options.assertExecutionLeaseHeld();
    const state = await this.options.store.readState();
    this.options.assertExecutionLeaseHeld();
    const pending = state.assetTakeovers.filter((item) =>
      !["managed", "manual_intervention", "failed", "awaiting_reconfirm"].includes(item.state));
    if (!pending.length) return;
    let metadata: CredentialBinding;
    let client: RwaNeutralTradingClient<TPermissions>;
    try {
      metadata = await this.options.credentialBinding();
      this.options.assertExecutionLeaseHeld();
      client = await this.options.client();
      this.options.assertExecutionLeaseHeld();
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      this.options.assertExecutionLeaseHeld();
      for (const record of pending) {
        record.state = "manual_intervention";
        record.runtime = createRwaAssetTakeoverRuntimeManual(
          this.now(),
          "account_changed",
          "服务重启后无法读取权威账户状态，已停止接管并要求人工处理。",
        );
        record.errorCategory = "asset_takeover_manual_intervention";
        record.message = "服务重启后无法读取权威账户状态，已停止接管并要求人工处理。";
        record.updatedAt = this.now();
      }
      state.config.globalExecutionEnabled = false;
      state.config.strategyEnabled = false;
      state.config.killSwitchActive = true;
      await this.writeStateWithLease(state);
      return;
    }
    if (!client.readAssetTakeoverSnapshot) throw unavailable();
    for (const record of pending) {
      try {
        this.options.assertExecutionLeaseHeld();
        this.assertExecutionEnabled(state);
        this.assertOnlyTakeoverForAuthorization(state, record.authorizationId, record.takeoverId);
        const authorization = requireActiveTakeoverAuthorization({
          authorizations: state.assetAuthorizations,
          profile: this.profile,
          accountId: metadata.accountId,
          accountFingerprint: metadata.accountFingerprint,
          authorizationId: record.authorizationId,
        });
        const provider = await client.readAssetTakeoverSnapshot();
        this.options.assertExecutionLeaseHeld();
        this.assertProviderBinding(provider.account, metadata);
        const current = createRwaAssetTakeoverPreview({
          profile: this.profile,
          authorization,
          provider,
          newCapitalUsd: record.newCapitalUsd,
          selectedLeverage: record.leverage,
          now: this.now(),
        });
        await this.engine.execute({
          client,
          authorization,
          preview: current,
          record,
          hooks: this.hooks(state, record),
          reconfirmed: true,
        });
      } catch (error) {
        if (error instanceof RwaAutomationExecutionLeaseError) throw error;
        this.options.assertExecutionLeaseHeld();
        record.state = "manual_intervention";
        record.runtime = createRwaAssetTakeoverRuntimeManual(
          this.now(),
          "persistent_state_invalid",
          "服务重启恢复未能形成严格对冲，已停止并要求人工处理。",
        );
        record.errorCategory = "asset_takeover_manual_intervention";
        record.message = "服务重启恢复未能形成严格对冲，已停止并要求人工处理。";
        record.updatedAt = this.now();
        state.config.globalExecutionEnabled = false;
        state.config.strategyEnabled = false;
        state.config.killSwitchActive = true;
        await this.writeStateWithLease(state);
      }
    }
  }

  private hooks(state: RwaAutomationStateData, record: RwaAssetTakeoverRecord) {
    return {
      assertMutationAllowed: async () => {
        this.options.assertExecutionLeaseHeld();
        const [latest, metadata] = await Promise.all([
          this.options.store.readState(),
          this.options.credentialBinding(),
        ]);
        this.options.assertExecutionLeaseHeld();
        this.assertExecutionEnabled(latest);
        const persisted = latest.assetTakeovers.find((item) => item.takeoverId === record.takeoverId);
        if (
          !persisted
          || persisted.idempotencyKey !== record.idempotencyKey
          || persisted.accountId !== metadata.accountId
          || persisted.accountFingerprint !== metadata.accountFingerprint
          || persisted.profileId !== record.profileId
        ) throw invalidRequest();
        requireActiveTakeoverAuthorization({
          authorizations: latest.assetAuthorizations,
          profile: this.profile,
          accountId: metadata.accountId,
          accountFingerprint: metadata.accountFingerprint,
          authorizationId: record.authorizationId,
        });
      },
      persist: async () => {
        record.updatedAt = this.now();
        await this.writeStateWithLease(state);
      },
      disarm: async () => {
        this.options.assertExecutionLeaseHeld();
        state.config.globalExecutionEnabled = false;
        state.config.strategyEnabled = false;
        state.config.killSwitchActive = true;
        record.state = "manual_intervention";
        if (!record.runtime) {
          record.runtime = createRwaAssetTakeoverRuntimeManual(
            this.now(),
            "persistent_state_invalid",
            "接管未能形成严格对冲，已停止后续写入并要求人工处理。",
          );
        } else {
          record.runtime.phase = "manual_intervention";
          record.runtime.reason = "persistent_state_invalid";
          record.runtime.message = "接管未能形成严格对冲，已停止后续写入并要求人工处理。";
          record.runtime.updatedAt = this.now();
        }
        record.updatedAt = this.now();
        await this.writeStateWithLease(state);
      },
    };
  }

  private runtimeHooks(state: RwaAutomationStateData, record: RwaAssetTakeoverRecord) {
    return {
      assertLeaseHeld: () => this.options.assertExecutionLeaseHeld(),
      assertMutationAllowed: async () => {
        this.options.assertExecutionLeaseHeld();
        const [latest, metadata] = await Promise.all([
          this.options.store.readState(),
          this.options.credentialBinding(),
        ]);
        this.options.assertExecutionLeaseHeld();
        const persisted = latest.assetTakeovers.find((item) => item.takeoverId === record.takeoverId);
        if (
          !persisted
          || persisted.state !== "managed"
          || persisted.idempotencyKey !== record.idempotencyKey
          || persisted.accountId !== metadata.accountId
          || persisted.accountFingerprint !== metadata.accountFingerprint
          || persisted.profileId !== record.profileId
          || persisted.authorizationId !== record.authorizationId
          || persisted.runtime?.exitIdempotencyKey !== record.runtime?.exitIdempotencyKey
        ) throw invalidRequest();
        requireActiveTakeoverAuthorization({
          authorizations: latest.assetAuthorizations,
          profile: this.profile,
          accountId: metadata.accountId,
          accountFingerprint: metadata.accountFingerprint,
          authorizationId: record.authorizationId,
        });
      },
      persist: async () => {
        record.updatedAt = this.now();
        await this.writeStateWithLease(state);
      },
      disarm: async (
        _target: RwaAssetTakeoverRecord,
        reason: RwaAssetTakeoverRuntimeReason,
        message: string,
      ) => {
        this.options.assertExecutionLeaseHeld();
        state.config.globalExecutionEnabled = false;
        state.config.strategyEnabled = false;
        state.config.killSwitchActive = true;
        record.state = "manual_intervention";
        record.errorCategory = "asset_takeover_runtime_manual_intervention";
        record.message = message;
        if (record.runtime) {
          record.runtime.phase = "manual_intervention";
          record.runtime.reason = reason;
          record.runtime.message = message;
          record.runtime.updatedAt = this.now();
        }
        record.updatedAt = this.now();
        await this.writeStateWithLease(state);
      },
    };
  }

  private requireManagedTakeover(
    state: RwaAutomationStateData,
    takeoverId: string,
    metadata: CredentialBinding,
  ) {
    const record = state.assetTakeovers.find((item) => item.takeoverId === takeoverId);
    if (
      !record
      || record.state !== "managed"
      || !record.runtime
      || record.accountId !== metadata.accountId
      || record.accountFingerprint !== metadata.accountFingerprint
      || record.assetId !== this.profile.asset.assetId
      || record.profileId !== `${this.profile.asset.assetId}:${this.profile.venue.strategyId}`
    ) throw invalidExitPreview();
    requireActiveTakeoverAuthorization({
      authorizations: state.assetAuthorizations,
      profile: this.profile,
      accountId: metadata.accountId,
      accountFingerprint: metadata.accountFingerprint,
      authorizationId: record.authorizationId,
    });
    return record;
  }

  private async assertCapitalCapacity(
    state: RwaAutomationStateData,
    preview: RwaAssetTakeoverPreview,
    metadata: CredentialBinding,
    replacingTakeoverId?: string,
  ) {
    const all = mergeRwaAutomationCapitalExposures(
      await readRwaAutomationCapitalExposures(),
      automationCapitalExposuresFromExecutions(state.executions),
      automationCapitalExposuresFromTakeovers(state.assetTakeovers),
    ).filter((item) => item.executionId !== (
      replacingTakeoverId ? `takeover:${replacingTakeoverId}` : ""
    ));
    const limits = this.profile.asset.currentStageRiskLimits!;
    const usage = calculateRwaAutomationNewRiskUsage({
      exposures: all,
      profile: this.profile,
      userId: this.options.store.ownerUserId,
      accountId: metadata.accountId,
      orderNotionalUsd: preview.newCapitalUsd,
      proposedCapitalUsd: preview.totalManagedCapitalUsd,
    });
    try {
      assertRwaAutomationNewRisk({ limits, ...usage });
    } catch {
      throw new RwaAssetTakeoverError(
        409,
        "asset_takeover_risk_rejected",
        "接管后的单资产、账户或全局管理资金超过服务端 2000U 上限。",
      );
    }
    if (usage.assetNotionalUsd > state.config.maxStrategyCapitalUsd) {
      throw new RwaAssetTakeoverError(
        409,
        "asset_takeover_risk_rejected",
        "接管后的管理资金超过当前用户策略上限。",
      );
    }
  }

  private assertExecutionEnabled(state: RwaAutomationStateData) {
    if (
      this.options.serverKillSwitchActive()
      || state.config.killSwitchActive
      || !state.config.globalExecutionEnabled
      || !state.config.strategyEnabled
    ) {
      throw new RwaAssetTakeoverError(
        409,
        "asset_takeover_risk_rejected",
        "自动执行或用户急停仍处于关闭状态，接管不会发送交易所写请求。",
      );
    }
  }

  private assertProviderBinding(
    provider: Pick<RwaVenueAccountIdentity, "accountId" | "accountFingerprint">,
    metadata: CredentialBinding,
  ) {
    if (
      provider.accountId !== metadata.accountId
      || provider.accountFingerprint !== metadata.accountFingerprint
    ) throw invalidRequest();
  }

  private requireAsset(assetId: string) {
    if (assetId !== this.profile.asset.assetId) throw invalidRequest();
  }

  private assertOnlyTakeoverForAuthorization(
    state: RwaAutomationStateData,
    authorizationId: string,
    currentTakeoverId?: string,
  ) {
    if (state.assetTakeovers.some((item) =>
      item.authorizationId === authorizationId
      && item.takeoverId !== currentTakeoverId
      && !["failed", "exited"].includes(item.state))) {
      throw new RwaAssetTakeoverError(
        409,
        "asset_takeover_risk_rejected",
        "当前账户资产授权已有接管记录，不能并行创建第二条接管任务。",
      );
    }
  }

  private async writeStateWithLease(state: RwaAutomationStateData) {
    this.options.assertExecutionLeaseHeld();
    await this.options.store.writeState(state);
    this.options.assertExecutionLeaseHeld();
  }
}

function validIdempotencyKey(value: string) {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function invalidRequest() {
  return new RwaAssetTakeoverError(
    409,
    "asset_takeover_invalid",
    "接管请求与当前用户、账户、资产、授权或持久状态不匹配。",
  );
}

function unavailable() {
  return new RwaAssetTakeoverError(
    503,
    "asset_takeover_risk_rejected",
    "交易所未提供接管所需的权威只读接口，已停止接管。",
  );
}

function invalidExitPreview() {
  return new RwaAssetTakeoverRuntimeError(
    409,
    "asset_takeover_exit_preview_invalid",
    "退出确认不存在、已过期，或 XAUT 数量和订单已经变化，请重新确认。",
  );
}
