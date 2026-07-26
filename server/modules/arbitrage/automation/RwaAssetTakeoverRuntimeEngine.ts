import { createHash } from "node:crypto";
import {
  assertRwaAssetTakeoverProviderSnapshot,
  digestRwaAssetOrders,
  RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT,
  type RwaAssetTakeoverProviderSnapshot,
  type RwaAssetTakeoverRecord,
} from "./RwaAssetTakeover";
import type { RwaAccountAssetAuthorization } from "./RwaAccountAssetAuthorization";
import type { RwaAutomationResolvedAssetProfile } from "./RwaAutomationAssetProfile";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import type {
  RwaNeutralTradingClient,
  RwaProviderOrder,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";
import {
  createRwaAssetTakeoverRuntime,
  RWA_ASSET_RUNTIME_EMERGENCY_SLIPPAGE_BPS,
  RWA_ASSET_RUNTIME_MAX_FUNDING_SETTLEMENTS,
  RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS,
  RWA_ASSET_RUNTIME_NORMAL_SLIPPAGE_BPS,
  RWA_ASSET_RUNTIME_READ_FAILURE_LIMIT,
  RWA_ASSET_RUNTIME_READ_FAILURE_MAX_MS,
  type RwaAssetFundingSettlement,
  type RwaAssetTakeoverRuntimeReason,
  type RwaAssetTakeoverRuntimeSnapshot,
} from "./RwaAssetTakeoverRuntime";

const quantityEpsilon = 1e-9;

export class RwaAssetTakeoverRuntimeError extends Error {
  constructor(
    readonly statusCode: number,
    readonly category:
      | "asset_takeover_runtime_invalid"
      | "asset_takeover_runtime_paused"
      | "asset_takeover_runtime_manual_intervention"
      | "asset_takeover_exit_preview_invalid"
      | "asset_takeover_exit_incomplete",
    message: string,
  ) {
    super(message);
  }
}

export type RwaAssetTakeoverRuntimeHooks = {
  assertLeaseHeld(): void;
  assertMutationAllowed(record: RwaAssetTakeoverRecord): Promise<void>;
  persist(record: RwaAssetTakeoverRecord): Promise<void>;
  disarm(record: RwaAssetTakeoverRecord, reason: RwaAssetTakeoverRuntimeReason, message: string): Promise<void>;
};

export class RwaAssetTakeoverRuntimeEngine {
  constructor(
    private readonly profile: RwaAutomationResolvedAssetProfile,
    private readonly now: () => number = Date.now,
    private readonly fundingCostBps = 0,
  ) {}

  snapshotForPreview<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    record: RwaAssetTakeoverRecord,
  ) {
    this.assertManagedRecord(record);
    this.assertRuntimeSnapshotSafe(provider, record, true);
    return this.runtimeSnapshot(provider);
  }

  async poll<TPermissions extends RwaVenuePermissions>(input: {
    client: RwaNeutralTradingClient<TPermissions>;
    authorization: RwaAccountAssetAuthorization;
    record: RwaAssetTakeoverRecord;
    hooks: RwaAssetTakeoverRuntimeHooks;
    userKillSwitchActive: boolean;
    serverKillSwitchActive: boolean;
  }) {
    const { client, record, hooks } = input;
    this.assertManagedRecord(record);
    hooks.assertLeaseHeld();
    try {
      if (record.runtime!.plannedMutation) {
        await this.recoverPlannedMutation(client, record, hooks);
      }
      const provider = await this.readSnapshot(client, record, hooks);
      const current = this.runtimeSnapshot(provider);
      if (record.runtime!.phase === "recovery_required") {
        this.assertRuntimeSnapshotSafe(provider, record);
        record.runtime = createRwaAssetTakeoverRuntime(current);
        record.finalSpotQuantity = current.spotQuantity;
        record.finalPerpetualQuantity = current.perpetualQuantity;
        record.residualQuantity = Math.abs(current.spotQuantity - current.perpetualQuantity);
        record.updatedAt = this.now();
        await hooks.persist(record);
        if (input.serverKillSwitchActive || input.userKillSwitchActive) {
          return this.exit({
            client,
            record,
            hooks,
            reason: input.serverKillSwitchActive ? "server_kill_switch" : "user_kill_switch",
            emergency: true,
            initialProvider: provider,
          });
        }
        if (
          Math.min(current.spotQuantity, current.perpetualQuantity)
            > record.targetHedgedQuantity + this.profile.asset.hedgeToleranceBase
        ) {
          await hooks.disarm(
            record,
            "external_position_change",
            "XAUT 双腿数量同时超过已确认接管上界，已急停且不会自动扩大管理范围。",
          );
          throw manualIntervention();
        }
        if (
          Math.abs(current.spotQuantity - current.perpetualQuantity)
            > this.profile.asset.hedgeToleranceBase
        ) {
          const afterCancel = await this.cancelAllAssetOrders(client, record, hooks, provider);
          await this.reduceOnlyToHedge(client, record, hooks, afterCancel);
        }
        return record;
      }
      this.resetReadFailure(record, current);
      if (input.serverKillSwitchActive || input.userKillSwitchActive) {
        return this.exit({
          client,
          record,
          hooks,
          reason: input.serverKillSwitchActive ? "server_kill_switch" : "user_kill_switch",
          emergency: true,
          initialProvider: provider,
        });
      }
      if (
        current.liquidationDistancePercent !== null
        && current.liquidationDistancePercent < RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT
      ) {
        return this.exit({
          client,
          record,
          hooks,
          reason: "liquidation_distance",
          emergency: true,
          initialProvider: provider,
        });
      }
      this.assertRuntimeSnapshotSafe(provider, record);
      const previous = record.runtime!.authoritativeSnapshot;
      if (previous && previous.providerStateDigest !== current.providerStateDigest) {
        return this.exit({
          client,
          record,
          hooks,
          reason: "account_changed",
          emergency: true,
          initialProvider: provider,
        });
      }
      const changed = !previous
        || previous.spotQuantity !== current.spotQuantity
        || previous.spotAvailableQuantity !== current.spotAvailableQuantity
        || previous.spotLockedQuantity !== current.spotLockedQuantity
        || previous.perpetualQuantity !== current.perpetualQuantity
        || previous.perpetualSide !== current.perpetualSide
        || previous.ordersDigest !== current.ordersDigest;
      if (changed) {
        const afterCancel = await this.cancelAllAssetOrders(client, record, hooks, provider);
        await this.reduceOnlyToHedge(client, record, hooks, afterCancel);
      } else {
        await this.consumeFundingSettlements(client, record, hooks, current);
      }
      if (record.runtime!.unfavorableFundingStreak >= 2) {
        return this.exit({
          client,
          record,
          hooks,
          reason: "funding_unfavorable",
          emergency: false,
        });
      }
      return record;
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      if (record.state === "exited" || record.state === "manual_intervention") throw error;
      if (
        error instanceof RwaAssetTakeoverRuntimeError
        && error.category === "asset_takeover_runtime_manual_intervention"
      ) {
        await hooks.disarm(
          record,
          "persistent_state_invalid",
          "XAUT 账户模式、权限、产品或仓位状态无法安全解释，已急停并要求人工处理。",
        );
        throw error;
      }
      await this.recordReadFailure(record, hooks, error);
      throw error;
    }
  }

  async exit<TPermissions extends RwaVenuePermissions>(input: {
    client: RwaNeutralTradingClient<TPermissions>;
    record: RwaAssetTakeoverRecord;
    hooks: RwaAssetTakeoverRuntimeHooks;
    reason: Exclude<RwaAssetTakeoverRuntimeReason, null>;
    emergency: boolean;
    idempotencyKey?: string;
    initialProvider?: RwaAssetTakeoverProviderSnapshot<TPermissions>;
  }) {
    try {
      return await this.performExit(input);
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      if (input.record.state !== "manual_intervention" && input.record.state !== "exited") {
        await input.hooks.disarm(
          input.record,
          input.reason,
          "XAUT 自动退出未能按权威数量完成，已急停并要求人工处理。",
        );
      }
      if (
        error instanceof RwaAssetTakeoverRuntimeError
        && error.category === "asset_takeover_exit_incomplete"
      ) throw error;
      throw new RwaAssetTakeoverRuntimeError(
        409,
        "asset_takeover_exit_incomplete",
        "XAUT 自动退出未完全完成，已急停并要求人工处理。",
      );
    }
  }

  private async performExit<TPermissions extends RwaVenuePermissions>(input: {
    client: RwaNeutralTradingClient<TPermissions>;
    record: RwaAssetTakeoverRecord;
    hooks: RwaAssetTakeoverRuntimeHooks;
    reason: Exclude<RwaAssetTakeoverRuntimeReason, null>;
    emergency: boolean;
    idempotencyKey?: string;
    initialProvider?: RwaAssetTakeoverProviderSnapshot<TPermissions>;
  }) {
    const { client, record, hooks } = input;
    this.assertManagedRecord(record);
    record.runtime!.phase = "exiting";
    record.runtime!.reason = input.reason;
    record.runtime!.exitIdempotencyKey ??= input.idempotencyKey
      ?? `system:${input.reason}:${record.takeoverId}`;
    record.runtime!.exitStartedAt ??= this.now();
    record.runtime!.message = "正在按先减永续空头、再卖对应现货的顺序退出 XAUT。";
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);

    let provider = input.initialProvider ?? await this.readSnapshot(client, record, hooks);
    this.assertRuntimeSnapshotSafe(provider, record, true);
    provider = await this.cancelAllAssetOrders(client, record, hooks, provider);
    this.assertRuntimeSnapshotSafe(provider, record, true);

    const slippageTiers = input.emergency
      ? [...RWA_ASSET_RUNTIME_EMERGENCY_SLIPPAGE_BPS]
      : [RWA_ASSET_RUNTIME_NORMAL_SLIPPAGE_BPS];
    for (let attempt = 1; attempt <= slippageTiers.length; attempt += 1) {
      const snapshot = this.runtimeSnapshot(provider);
      const common = Math.min(snapshot.spotAvailableQuantity, snapshot.perpetualQuantity);
      if (common <= this.profile.asset.hedgeToleranceBase) break;
      const perpQuantity = this.tradableQuantity(provider, "linear", common, "exit");
      if (perpQuantity <= 0) break;
      const beforePerpetual = snapshot.perpetualQuantity;
      await this.placeAndConfirm(
        client,
        record,
        hooks,
        provider,
        "linear",
        perpQuantity,
        slippageTiers[attempt - 1]!,
        attempt,
        true,
      );
      provider = await this.readSnapshot(client, record, hooks);
      const afterPerpetual = this.runtimeSnapshot(provider);
      const reducedPerpetual = clampQuantity(beforePerpetual - afterPerpetual.perpetualQuantity);
      if (reducedPerpetual <= 0) continue;
      if (
        afterPerpetual.spotQuantity + quantityEpsilon < afterPerpetual.perpetualQuantity
        || afterPerpetual.spotAvailableQuantity + quantityEpsilon < afterPerpetual.perpetualQuantity
      ) throw manualIntervention();
      const unhedgedSpotQuantity = Math.max(
        0,
        afterPerpetual.spotAvailableQuantity - afterPerpetual.perpetualQuantity,
      );
      const spotQuantity = this.tradableQuantity(
        provider,
        "spot",
        Math.min(reducedPerpetual, unhedgedSpotQuantity),
        "exit",
      );
      if (spotQuantity > 0) {
        const beforeSpot = afterPerpetual.spotQuantity;
        await this.placeAndConfirm(
          client,
          record,
          hooks,
          provider,
          "spot",
          spotQuantity,
          slippageTiers[attempt - 1]!,
          attempt,
          false,
        );
        provider = await this.readSnapshot(client, record, hooks);
        const afterSpot = this.runtimeSnapshot(provider);
        if (beforeSpot - afterSpot.spotQuantity + quantityEpsilon < spotQuantity) break;
      }
    }

    if (this.runtimeSnapshot(provider).perpetualQuantity === 0) {
      for (let attempt = 1; attempt <= slippageTiers.length; attempt += 1) {
        const snapshot = this.runtimeSnapshot(provider);
        const quantity = this.tradableQuantity(provider, "spot", snapshot.spotAvailableQuantity, "exit");
        if (quantity <= 0) break;
        await this.placeAndConfirm(
          client,
          record,
          hooks,
          provider,
          "spot",
          quantity,
          slippageTiers[attempt - 1]!,
          attempt,
          false,
        );
        provider = await this.readSnapshot(client, record, hooks);
      }
    }

    const final = this.runtimeSnapshot(provider);
    record.runtime!.authoritativeSnapshot = final;
    record.runtime!.lastSuccessfulCheckAt = final.capturedAt;
    record.runtime!.residualSpotQuantity = final.spotQuantity;
    record.runtime!.residualPerpetualQuantity = final.perpetualQuantity;
    record.finalSpotQuantity = final.spotQuantity;
    record.finalPerpetualQuantity = final.perpetualQuantity;
    record.residualQuantity = Math.max(final.spotQuantity, final.perpetualQuantity);
    record.updatedAt = this.now();
    if (
      final.perpetualQuantity !== 0
      || this.isTradable(provider, "spot", final.spotAvailableQuantity, "exit")
    ) {
      await hooks.disarm(
        record,
        input.reason,
        final.perpetualQuantity !== 0
          ? "退出后仍有 XAUT 永续空头，不能按小额忽略，必须人工处理。"
          : "退出后仍有可交易的 XAUT 现货，必须人工处理。",
      );
      throw new RwaAssetTakeoverRuntimeError(
        409,
        "asset_takeover_exit_incomplete",
        "XAUT 自动退出未完全完成，已急停并要求人工处理。",
      );
    }
    record.state = "exited";
    record.reservedCapitalUsd = 0;
    record.runtime!.phase = "exited";
    record.runtime!.exitCompletedAt = this.now();
    record.runtime!.message = final.spotQuantity > this.profile.asset.hedgeToleranceBase
      ? "XAUT 永续已全部退出；剩余现货低于交易所最小可交易量，已记录为 residual/dust。"
      : "XAUT 现货和永续已按权威数量完成退出。";
    record.runtime!.updatedAt = this.now();
    record.message = record.runtime!.message;
    record.errorCategory = null;
    record.updatedAt = this.now();
    await hooks.persist(record);
    return record;
  }

  async recover<TPermissions extends RwaVenuePermissions>(input: {
    client: RwaNeutralTradingClient<TPermissions>;
    record: RwaAssetTakeoverRecord;
    hooks: RwaAssetTakeoverRuntimeHooks;
  }) {
    this.assertManagedRecord(input.record);
    try {
      if (input.record.runtime!.plannedMutation) {
        await this.recoverPlannedMutation(input.client, input.record, input.hooks);
      }
      if (input.record.runtime!.phase === "exiting") {
        return this.exit({
          ...input,
          reason: input.record.runtime!.reason ?? "persistent_state_invalid",
          emergency: input.record.runtime!.reason !== "funding_unfavorable",
        });
      }
      return input.record;
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      if (input.record.state !== "manual_intervention") {
        await input.hooks.disarm(
          input.record,
          "persistent_state_invalid",
          "XAUT 运行中的交易所操作无法权威恢复，已急停并要求人工处理。",
        );
      }
      throw manualIntervention();
    }
  }

  private async reduceOnlyToHedge<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
    initial: RwaAssetTakeoverProviderSnapshot<TPermissions>,
  ) {
    let provider = initial;
    record.runtime!.phase = "reducing";
    record.runtime!.reason = "external_position_change";
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.assertRuntimeSnapshotSafe(provider, record);
      const snapshot = this.runtimeSnapshot(provider);
      if (
        Math.min(snapshot.spotQuantity, snapshot.perpetualQuantity)
          > record.targetHedgedQuantity + this.profile.asset.hedgeToleranceBase
      ) {
        await hooks.disarm(
          record,
          "external_position_change",
          "XAUT 双腿数量同时增加并超过已确认接管上界，已急停且不会自动扩大管理范围。",
        );
        throw manualIntervention();
      }
      const difference = snapshot.spotQuantity - snapshot.perpetualQuantity;
      if (Math.abs(difference) <= this.profile.asset.hedgeToleranceBase) {
        this.markMonitoring(record, snapshot);
        await hooks.persist(record);
        return;
      }
      const category = difference > 0 ? "spot" as const : "linear" as const;
      const requested = Math.abs(difference);
      const quantity = this.tradableQuantity(provider, category, requested, "reduce");
      if (quantity <= 0) break;
      await this.placeAndConfirm(
        client,
        record,
        hooks,
        provider,
        category,
        quantity,
        RWA_ASSET_RUNTIME_NORMAL_SLIPPAGE_BPS,
        attempt,
        category === "linear",
      );
      provider = await this.readSnapshot(client, record, hooks);
    }
    const final = this.runtimeSnapshot(provider);
    if (Math.abs(final.spotQuantity - final.perpetualQuantity) > this.profile.asset.hedgeToleranceBase) {
      await hooks.disarm(
        record,
        "external_position_change",
        "XAUT 数量变化后无法只靠减仓恢复严格对冲，已急停并要求人工处理。",
      );
      throw new RwaAssetTakeoverRuntimeError(
        409,
        "asset_takeover_runtime_manual_intervention",
        "XAUT 数量变化无法安全减险。",
      );
    }
    this.markMonitoring(record, final);
    await hooks.persist(record);
  }

  private async cancelAllAssetOrders<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
  ) {
    let current = provider;
    for (let attempt = 0; attempt <= RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS; attempt += 1) {
      this.assertRuntimeSnapshotSafe(current, record, record.runtime?.phase === "exiting");
      if (current.orders.length === 0) return current;
      if (attempt === RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS) throw manualIntervention();
      const candidate = current.orders[0]!;
      const beforeMutation = await this.readSnapshot(client, record, hooks);
      this.assertRuntimeSnapshotSafe(beforeMutation, record, record.runtime?.phase === "exiting");
      const order = beforeMutation.orders.find((item) =>
        item.category === candidate.category && item.orderId === candidate.orderId);
      if (!order) {
        current = beforeMutation;
        continue;
      }
      await hooks.assertMutationAllowed(record);
      record.runtime!.plannedMutation = {
        kind: "cancel",
        category: order.category,
        orderId: order.orderId,
      };
      record.runtime!.updatedAt = this.now();
      record.updatedAt = this.now();
      await hooks.persist(record);
      await hooks.assertMutationAllowed(record);
      await this.providerMutation(() => client.cancelOrder(order.category, order.orderId));
      hooks.assertLeaseHeld();
      record.runtime!.cancelledOrders.push({
        category: order.category,
        orderId: order.orderId,
        symbol: order.symbol,
      });
      record.runtime!.cancelledOrders = record.runtime!.cancelledOrders
        .slice(-RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS);
      record.runtime!.plannedMutation = null;
      record.runtime!.updatedAt = this.now();
      record.updatedAt = this.now();
      await hooks.persist(record);
      current = await this.readSnapshot(client, record, hooks);
    }
    throw manualIntervention();
  }

  private async placeAndConfirm<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    category: "spot" | "linear",
    quantityBase: number,
    slippageBps: 15 | 30 | 50,
    attempt: number,
    reduceOnly: boolean,
  ) {
    const beforeMutation = await this.readSnapshot(client, record, hooks);
    this.assertRuntimeSnapshotSafe(
      beforeMutation,
      record,
      record.runtime?.phase === "exiting",
    );
    this.assertNoOpenOrders(beforeMutation);
    this.assertSameQuantities(provider, beforeMutation);
    const executableQuantity = this.tradableQuantity(
      beforeMutation,
      category,
      quantityBase,
      record.runtime?.phase === "exiting" ? "exit" : "reduce",
    );
    if (executableQuantity + quantityEpsilon < quantityBase) throw manualIntervention();
    record.runtime!.mutationSequence += 1;
    const runtimeIndex = record.runtime!.mutationSequence;
    const orderLinkId = `${record.orderLinkPrefix}x${category === "spot" ? "s" : "p"}${runtimeIndex}`;
    const limitPrice = this.limitPrice(beforeMutation, category, slippageBps);
    await hooks.assertMutationAllowed(record);
    record.runtime!.plannedMutation = {
      kind: "place",
      category,
      orderLinkId,
      quantityBase,
      limitPrice,
      reduceOnly,
      slippageBps,
      attempt,
    };
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);
    await hooks.assertMutationAllowed(record);
    const accepted = await this.providerMutation(() => client.placeOrder({
      category,
      symbol: category === "spot" ? this.profile.venue.spotSymbol : this.profile.venue.perpetualSymbol,
      side: category === "spot" ? "Sell" : "Buy",
      quantityXaut: quantityBase,
      limitPrice,
      reduceOnly,
      orderLinkId,
    }));
    hooks.assertLeaseHeld();
    record.runtime!.acceptedOrders.push({ category, ...accepted });
    record.runtime!.acceptedOrders = record.runtime!.acceptedOrders
      .slice(-RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS);
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);
    const order = await this.providerMutation(() =>
      client.awaitOrder(category, accepted.orderId, this.now() + 6_000));
    hooks.assertLeaseHeld();
    this.pushProviderResult(record, order);
    record.runtime!.plannedMutation = null;
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);
    return order;
  }

  private async recoverPlannedMutation<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
  ) {
    const planned = record.runtime!.plannedMutation;
    if (!planned) return;
    hooks.assertLeaseHeld();
    if (planned.kind === "cancel") {
      const provider = await this.readSnapshot(client, record, hooks);
      this.assertRuntimeSnapshotSafe(provider, record, record.runtime!.phase === "exiting");
      const open = provider.orders.find((order) =>
        order.category === planned.category && order.orderId === planned.orderId);
      if (open) {
        await hooks.assertMutationAllowed(record);
        await this.providerMutation(() => client.cancelOrder(open.category, open.orderId));
        hooks.assertLeaseHeld();
        record.runtime!.cancelledOrders.push({
          category: open.category,
          orderId: open.orderId,
          symbol: open.symbol,
        });
        record.runtime!.cancelledOrders = record.runtime!.cancelledOrders
          .slice(-RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS);
      }
      record.runtime!.plannedMutation = null;
      record.runtime!.updatedAt = this.now();
      record.updatedAt = this.now();
      await hooks.persist(record);
      return;
    }
    if (!client.findOrderByClientOrderId) throw unavailable();
    let order = await client.findOrderByClientOrderId(planned.category, planned.orderLinkId);
    hooks.assertLeaseHeld();
    if (!order) {
      const provider = await this.readSnapshot(client, record, hooks);
      this.assertRuntimeSnapshotSafe(provider, record, record.runtime!.phase === "exiting");
      this.assertNoOpenOrders(provider);
      if (!record.runtime!.authoritativeSnapshot) throw unavailable();
      const current = this.runtimeSnapshot(provider);
      const expected = record.runtime!.authoritativeSnapshot;
      if (
        expected.spotQuantity !== current.spotQuantity
        || expected.spotAvailableQuantity !== current.spotAvailableQuantity
        || expected.spotLockedQuantity !== current.spotLockedQuantity
        || expected.perpetualQuantity !== current.perpetualQuantity
        || expected.perpetualSide !== current.perpetualSide
        || expected.providerStateDigest !== current.providerStateDigest
      ) throw manualIntervention();
      await hooks.assertMutationAllowed(record);
      const accepted = await this.providerMutation(() => client.placeOrder({
        category: planned.category,
        symbol: planned.category === "spot"
          ? this.profile.venue.spotSymbol
          : this.profile.venue.perpetualSymbol,
        side: planned.category === "spot" ? "Sell" : "Buy",
        quantityXaut: planned.quantityBase,
        limitPrice: planned.limitPrice,
        reduceOnly: planned.reduceOnly,
        orderLinkId: planned.orderLinkId,
      }));
      hooks.assertLeaseHeld();
      if (!record.runtime!.acceptedOrders.some((item) => item.orderLinkId === accepted.orderLinkId)) {
        record.runtime!.acceptedOrders.push({ category: planned.category, ...accepted });
        record.runtime!.acceptedOrders = record.runtime!.acceptedOrders
          .slice(-RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS);
      }
      await hooks.persist(record);
      order = await this.providerMutation(() =>
        client.awaitOrder(planned.category, accepted.orderId, this.now() + 6_000));
      hooks.assertLeaseHeld();
    } else {
      if (!record.runtime!.acceptedOrders.some((item) => item.orderLinkId === order!.orderLinkId)) {
        record.runtime!.acceptedOrders.push({
          category: planned.category,
          orderId: order.orderId,
          orderLinkId: order.orderLinkId,
        });
        record.runtime!.acceptedOrders = record.runtime!.acceptedOrders
          .slice(-RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS);
        await hooks.persist(record);
      }
      if (order.status === "New" || order.status === "PartiallyFilled") {
        order = await this.providerMutation(() =>
          client.awaitOrder(planned.category, order!.orderId, this.now() + 6_000));
        hooks.assertLeaseHeld();
      }
    }
    this.pushProviderResult(record, order);
    record.runtime!.plannedMutation = null;
    record.runtime!.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);
  }

  private async consumeFundingSettlements<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
    snapshot: RwaAssetTakeoverRuntimeSnapshot,
  ) {
    if (!client.readAssetFundingSettlements) throw unavailable();
    const runtime = record.runtime!;
    const settlements = await client.readAssetFundingSettlements({
      after: runtime.fundingCheckpointAt,
      through: snapshot.capturedAt,
    });
    hooks.assertLeaseHeld();
    const seen = new Set(runtime.fundingSettlements.map((item) => item.cycleId));
    const ordered = [...settlements].sort((left, right) =>
      left.settledAt - right.settledAt || left.settlementId.localeCompare(right.settlementId));
    for (const settlement of ordered) {
      if (seen.has(settlement.cycleId)) continue;
      this.validateFundingSettlement(settlement, runtime.fundingCheckpointAt, snapshot.capturedAt);
      seen.add(settlement.cycleId);
      runtime.fundingSettlements.push(settlement);
      const costUsd = snapshot.perpetualQuantity * snapshot.perpetualAsk * this.fundingCostBps / 10_000;
      runtime.unfavorableFundingStreak = settlement.netFundingUsd - costUsd < 0
        ? Math.min(2, runtime.unfavorableFundingStreak + 1)
        : 0;
      runtime.fundingCheckpointAt = settlement.settledAt;
    }
    runtime.fundingSettlements = runtime.fundingSettlements
      .slice(-RWA_ASSET_RUNTIME_MAX_FUNDING_SETTLEMENTS);
    runtime.authoritativeSnapshot = snapshot;
    runtime.lastSuccessfulCheckAt = snapshot.capturedAt;
    runtime.updatedAt = this.now();
    record.updatedAt = this.now();
    await hooks.persist(record);
  }

  private runtimeSnapshot<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
  ): RwaAssetTakeoverRuntimeSnapshot {
    const spot = provider.account.existingSpotQuantityXaut;
    const perpetual = provider.account.existingPerpetualQuantityXaut;
    const paired = Math.min(spot, perpetual);
    const managedCapitalUsd = paired * Math.max(
      provider.account.spot.bid,
      provider.account.perpetual.mark,
    ) + Math.max(0, spot - paired) * provider.account.spot.bid
      + Math.max(0, perpetual - paired) * provider.account.perpetual.mark;
    return {
      capturedAt: provider.account.fetchedAt,
      ordersDigest: digestRwaAssetOrders(provider.orders),
      providerStateDigest: rwaAssetTakeoverProviderStateDigest(provider),
      spotQuantity: spot,
      spotAvailableQuantity: provider.account.spotAvailableQuantityXaut,
      spotLockedQuantity: provider.account.spotLockedQuantityXaut,
      spotBid: provider.account.spot.bid,
      perpetualQuantity: perpetual,
      perpetualSide: provider.account.perpetualPositionSide === "short" ? "short" : "flat",
      perpetualAsk: provider.account.perpetual.ask,
      perpetualMark: provider.account.perpetual.mark,
      currentFundingRate: provider.account.perpetual.fundingRate,
      liquidationDistancePercent: provider.account.perpetual.liquidationDistancePercent,
      reserveUsd: provider.account.availableUsdt,
      managedCapitalUsd,
    };
  }

  private assertRuntimeSnapshotSafe<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    record: RwaAssetTakeoverRecord,
    exit = false,
  ) {
    const account = provider.account;
    try {
      assertRwaAssetTakeoverProviderSnapshot(this.profile, provider);
    } catch {
      throw manualIntervention();
    }
    const orderKeys = provider.orders.map((order) => `${order.category}:${order.orderId}`);
    if (
      account.accountId !== record.accountId
      || account.accountFingerprint !== record.accountFingerprint
      || account.perpetualPositionSide === "long"
      || (account.perpetualPositionSide === "flat" && account.existingPerpetualQuantityXaut > quantityEpsilon)
      || (account.existingPerpetualQuantityXaut > 0
        && account.perpetual.liquidationDistancePercent === null)
      || account.spotLockedQuantityXaut > this.profile.asset.hedgeToleranceBase
      || !account.permissions.read
      || !account.permissions.spotTrade
      || !account.permissions.contractTrade
      || account.permissions.withdraw
      || !this.allowedAccountMode(account.accountMode)
      || provider.orders.length > RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS
      || new Set(orderKeys).size !== orderKeys.length
    ) throw manualIntervention();
    const snapshot = this.runtimeSnapshot(provider);
    const limit = this.profile.asset.currentStageRiskLimits?.maxAssetCapitalUsd;
    if (!exit && (!limit || snapshot.managedCapitalUsd > limit + quantityEpsilon)) {
      throw manualIntervention();
    }
  }

  private async readSnapshot<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
  ) {
    if (!client.readManagedAssetSnapshot) throw unavailable();
    const provider = await client.readManagedAssetSnapshot();
    hooks.assertLeaseHeld();
    if (
      provider.account.accountId !== record.accountId
      || provider.account.accountFingerprint !== record.accountFingerprint
    ) throw manualIntervention();
    return provider;
  }

  private assertNoOpenOrders<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
  ) {
    if (provider.orders.length !== 0) throw manualIntervention();
  }

  private assertSameQuantities<TPermissions extends RwaVenuePermissions>(
    expected: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    current: RwaAssetTakeoverProviderSnapshot<TPermissions>,
  ) {
    const left = this.runtimeSnapshot(expected);
    const right = this.runtimeSnapshot(current);
    if (
      left.spotQuantity !== right.spotQuantity
      || left.spotAvailableQuantity !== right.spotAvailableQuantity
      || left.spotLockedQuantity !== right.spotLockedQuantity
      || left.perpetualQuantity !== right.perpetualQuantity
      || left.perpetualSide !== right.perpetualSide
      || left.providerStateDigest !== right.providerStateDigest
    ) throw manualIntervention();
  }

  private tradableQuantity<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    category: "spot" | "linear",
    requested: number,
    mode: "reduce" | "exit",
  ) {
    const spec = category === "spot" ? provider.account.spot : provider.account.perpetual;
    const reference = category === "spot" ? provider.account.spot.bid : provider.account.perpetual.ask;
    const depth = category === "spot" ? provider.spotBidDepth : provider.perpetualAskDepth;
    const stepQuantity = floorStep(requested, spec.qtyStep);
    const depthQuantity = floorStep(depth.reduce((total, level) => total + level.quantityBase, 0), spec.qtyStep);
    const quantity = Math.min(stepQuantity, depthQuantity);
    if (!this.isTradable(provider, category, quantity, mode)) return 0;
    return quantity * reference > 0 ? quantity : 0;
  }

  private isTradable<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    category: "spot" | "linear",
    quantity: number,
    _mode: "reduce" | "exit",
  ) {
    const spec = category === "spot" ? provider.account.spot : provider.account.perpetual;
    const price = category === "spot" ? provider.account.spot.bid : provider.account.perpetual.ask;
    return quantity + quantityEpsilon >= spec.minOrderQty
      && quantity * price + quantityEpsilon >= spec.minNotionalUsd;
  }

  private limitPrice<TPermissions extends RwaVenuePermissions>(
    provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
    category: "spot" | "linear",
    slippageBps: 15 | 30 | 50,
  ) {
    if (category === "spot") {
      return floorStep(
        provider.account.spot.bid * (1 - slippageBps / 10_000),
        provider.account.spot.priceTick,
      );
    }
    return ceilStep(
      provider.account.perpetual.ask * (1 + slippageBps / 10_000),
      provider.account.perpetual.priceTick,
    );
  }

  private markMonitoring(record: RwaAssetTakeoverRecord, snapshot: RwaAssetTakeoverRuntimeSnapshot) {
    record.runtime!.phase = "monitoring";
    record.runtime!.reason = null;
    record.runtime!.authoritativeSnapshot = snapshot;
    record.runtime!.lastSuccessfulCheckAt = snapshot.capturedAt;
    record.runtime!.consecutiveReadFailures = 0;
    record.runtime!.firstReadFailureAt = null;
    record.runtime!.message = "XAUT 现货多头与永续空头保持严格对冲。";
    record.runtime!.updatedAt = this.now();
    record.finalSpotQuantity = snapshot.spotQuantity;
    record.finalPerpetualQuantity = snapshot.perpetualQuantity;
    record.residualQuantity = Math.abs(snapshot.spotQuantity - snapshot.perpetualQuantity);
    record.updatedAt = this.now();
  }

  private resetReadFailure(record: RwaAssetTakeoverRecord, snapshot: RwaAssetTakeoverRuntimeSnapshot) {
    record.runtime!.consecutiveReadFailures = 0;
    record.runtime!.firstReadFailureAt = null;
    record.runtime!.lastSuccessfulCheckAt = snapshot.capturedAt;
    record.runtime!.updatedAt = this.now();
  }

  private async recordReadFailure(
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverRuntimeHooks,
    _error: unknown,
  ) {
    const runtime = record.runtime!;
    runtime.consecutiveReadFailures = Math.min(
      RWA_ASSET_RUNTIME_READ_FAILURE_LIMIT,
      runtime.consecutiveReadFailures + 1,
    );
    runtime.firstReadFailureAt ??= this.now();
    runtime.phase = "paused";
    runtime.reason = "provider_read_failure";
    runtime.message = "暂时无法确认交易所权威数量，已暂停且不会盲目下单。";
    runtime.updatedAt = this.now();
    record.updatedAt = this.now();
    if (
      runtime.consecutiveReadFailures >= RWA_ASSET_RUNTIME_READ_FAILURE_LIMIT
      || this.now() - runtime.firstReadFailureAt >= RWA_ASSET_RUNTIME_READ_FAILURE_MAX_MS
    ) {
      await hooks.disarm(
        record,
        "provider_read_failure",
        "交易所权威状态连续读取失败，已急停并要求人工处理；未发送退出订单。",
      );
      return;
    }
    await hooks.persist(record);
  }

  private pushProviderResult(record: RwaAssetTakeoverRecord, order: RwaProviderOrder) {
    record.runtime!.providerResults.push({
      ...order,
      positionQuantityXaut: order.positionQuantityXaut ?? order.filledQuantityXaut,
    });
    record.runtime!.providerResults = record.runtime!.providerResults
      .slice(-RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS);
  }

  private validateFundingSettlement(
    settlement: RwaAssetFundingSettlement,
    after: number,
    through: number,
  ) {
    if (
      !settlement.settlementId
      || !settlement.cycleId
      || !Number.isSafeInteger(settlement.settledAt)
      || settlement.settledAt <= after
      || settlement.settledAt > through
      || !Number.isFinite(settlement.netFundingUsd)
      || !(settlement.fundingRate === null || Number.isFinite(settlement.fundingRate))
    ) throw unavailable();
  }

  private assertManagedRecord(record: RwaAssetTakeoverRecord) {
    if (record.state !== "managed" || !record.runtime) throw invalidRuntime();
  }

  private allowedAccountMode(mode: string) {
    return this.profile.venue.venue === "bybit"
      ? mode === "uta"
      : ["single_asset_one_way", "multi_assets_one_way"].includes(mode);
  }

  private async providerMutation<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      throw manualIntervention();
    }
  }
}

function clampQuantity(value: number) {
  return Math.max(0, value > quantityEpsilon ? value : 0);
}

function floorStep(value: number, step: number) {
  return Math.floor((value + 1e-12) / step) * step;
}

function ceilStep(value: number, step: number) {
  return Math.ceil((value - 1e-12) / step) * step;
}

function invalidRuntime() {
  return new RwaAssetTakeoverRuntimeError(
    409,
    "asset_takeover_runtime_invalid",
    "当前 XAUT 接管记录尚未进入可监控的严格对冲状态。",
  );
}

function unavailable() {
  return new RwaAssetTakeoverRuntimeError(
    503,
    "asset_takeover_runtime_paused",
    "交易所没有返回可证明的 XAUT 运行数据，已暂停且不会盲目下单。",
  );
}

function manualIntervention() {
  return new RwaAssetTakeoverRuntimeError(
    409,
    "asset_takeover_runtime_manual_intervention",
    "XAUT 账户模式、权限、产品或仓位状态无法安全解释，已要求人工处理。",
  );
}

export function rwaAssetTakeoverExitStateDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function rwaAssetTakeoverProviderStateDigest<TPermissions extends RwaVenuePermissions>(
  provider: RwaAssetTakeoverProviderSnapshot<TPermissions>,
) {
  return rwaAssetTakeoverExitStateDigest({
    accountMode: provider.account.accountMode,
    permissions: provider.account.permissions,
    spot: {
      status: provider.account.spot.status,
      minOrderQty: provider.account.spot.minOrderQty,
      qtyStep: provider.account.spot.qtyStep,
      minNotionalUsd: provider.account.spot.minNotionalUsd,
      priceTick: provider.account.spot.priceTick,
    },
    perpetual: {
      status: provider.account.perpetual.status,
      minOrderQty: provider.account.perpetual.minOrderQty,
      qtyStep: provider.account.perpetual.qtyStep,
      minNotionalUsd: provider.account.perpetual.minNotionalUsd,
      priceTick: provider.account.perpetual.priceTick,
      fundingIntervalHours: provider.account.perpetual.fundingIntervalHours,
    },
    fees: provider.account.fees,
  });
}
