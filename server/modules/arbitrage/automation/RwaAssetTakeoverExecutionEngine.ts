import type { RwaAccountAssetAuthorization, RwaAssetOrderReference } from "./RwaAccountAssetAuthorization";
import type { RwaAutomationResolvedAssetProfile } from "./RwaAutomationAssetProfile";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import {
  createRwaAssetTakeoverPreview,
  RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS,
  RwaAssetTakeoverError,
  takeoverStateChanged,
  type RwaAssetTakeoverPreview,
  type RwaAssetTakeoverProviderSnapshot,
  type RwaAssetTakeoverRecord,
} from "./RwaAssetTakeover";
import type {
  RwaNeutralTradingClient,
  RwaProviderOrder,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";

const TAKEOVER_MAX_ORDER_ATTEMPTS = 3;
const TAKEOVER_EXECUTION_WINDOW_MS = 20_000;

export type RwaAssetTakeoverExecutionHooks = {
  assertMutationAllowed(record: RwaAssetTakeoverRecord): Promise<void> | void;
  persist(record: RwaAssetTakeoverRecord): Promise<void>;
  disarm(record: RwaAssetTakeoverRecord, error: unknown): Promise<void>;
};

export type RwaAssetTakeoverExecutionResult =
  | { status: "managed"; record: RwaAssetTakeoverRecord }
  | {
    status: "reconfirm_required";
    record: RwaAssetTakeoverRecord;
    preview: RwaAssetTakeoverPreview;
  };

export class RwaAssetTakeoverExecutionEngine {
  constructor(
    private readonly profile: RwaAutomationResolvedAssetProfile,
    private readonly now: () => number = Date.now,
  ) {}

  async execute<TPermissions extends RwaVenuePermissions>(input: {
    client: RwaNeutralTradingClient<TPermissions>;
    authorization: RwaAccountAssetAuthorization;
    preview: RwaAssetTakeoverPreview;
    record: RwaAssetTakeoverRecord;
    hooks: RwaAssetTakeoverExecutionHooks;
    reconfirmed?: boolean;
  }): Promise<RwaAssetTakeoverExecutionResult> {
    const { client, authorization, preview, record, hooks } = input;
    if (!client.readAssetTakeoverSnapshot) throw takeoverUnavailable();
    const deadlineAt = this.now() + TAKEOVER_EXECUTION_WINDOW_MS;
    try {
      await this.recoverPlannedMutation(client, record, hooks, deadlineAt);
      const beforeCancel = await client.readAssetTakeoverSnapshot();
      this.assertSnapshotBinding(beforeCancel, record);
      const currentBeforeCancel = this.preview(authorization, beforeCancel, record);
      if (takeoverStateChanged(preview, currentBeforeCancel) || preview.ordersDigest !== currentBeforeCancel.ordersDigest) {
        throw previewChanged();
      }

      record.state = "cancelling_orders";
      record.updatedAt = this.now();
      await hooks.persist(record);
      for (const order of beforeCancel.orders) {
        await this.cancelOrder(client, record, order, hooks);
      }

      const afterCancel = await client.readAssetTakeoverSnapshot();
      this.assertSnapshotBinding(afterCancel, record);
      const refreshed = this.preview(authorization, afterCancel, record);
      if (takeoverStateChanged(preview, refreshed)) {
        record.state = "awaiting_reconfirm";
        record.previewDigest = refreshed.previewDigest;
        record.totalManagedCapitalUsd = refreshed.totalManagedCapitalUsd;
        record.reservedCapitalUsd = refreshed.totalManagedCapitalUsd;
        record.targetHedgedQuantity = refreshed.targetHedgedQuantity;
        record.finalSpotQuantity = refreshed.spotQuantity;
        record.finalPerpetualQuantity = refreshed.perpetualQuantity;
        record.residualQuantity = refreshed.residualQuantity;
        record.message = "撤单后 XAUT 数量发生变化，请核对新预览后继续。";
        record.updatedAt = this.now();
        await hooks.persist(record);
        return { status: "reconfirm_required", record, preview: refreshed };
      }

      return await this.completeHedge(
        client,
        authorization,
        { preview: refreshed, provider: afterCancel },
        record,
        hooks,
        deadlineAt,
      );
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      if (
        error instanceof RwaAssetTakeoverError
        && ["asset_takeover_preview_changed", "asset_takeover_reconfirm_required"].includes(error.category)
      ) throw error;
      record.state = "manual_intervention";
      record.errorCategory = errorCategory(error);
      record.message = "接管未能形成严格对冲，已停止后续写入并要求人工处理。";
      record.updatedAt = this.now();
      await hooks.disarm(record, error);
      throw error instanceof RwaAssetTakeoverError ? error : manualIntervention();
    }
  }

  private async completeHedge<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    authorization: RwaAccountAssetAuthorization,
    initial: {
      preview: RwaAssetTakeoverPreview;
      provider: RwaAssetTakeoverProviderSnapshot;
    },
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverExecutionHooks,
    deadlineAt: number,
  ): Promise<RwaAssetTakeoverExecutionResult> {
    let { preview, provider } = initial;
    for (let attempt = 1; attempt <= TAKEOVER_MAX_ORDER_ATTEMPTS; attempt += 1) {
      const side = missingSide(preview);
      if (!side) return this.markManaged(record, preview, hooks);
      if (!isTradableMissing(preview, this.profile, provider, side)) {
        return this.markManaged(record, preview, hooks);
      }
      if (this.now() >= deadlineAt) throw manualIntervention();
      if (
        side === "linear"
        && record.perpetualOrders.length === 0
        && !record.acceptedOrders.some((item) => item.category === "linear")
      ) {
        await this.setLeverage(client, record, hooks);
      }
      const missingQuantity = side === "spot"
        ? preview.missingSpotQuantity
        : preview.missingPerpetualQuantity;
      const quantity = depthChunkQuantity(provider, side, missingQuantity);
      if (!isTradableQuantity(preview, this.profile, provider, side, quantity)) {
        throw manualIntervention();
      }
      const order = await this.placeMissingOrder(
        client,
        record,
        preview,
        side,
        quantity,
        attempt,
        hooks,
        deadlineAt,
      );
      if (side === "spot") record.spotOrders.push(order);
      else record.perpetualOrders.push(order);
      record.plannedMutation = null;
      record.updatedAt = this.now();
      await hooks.persist(record);

      if (!client.readAssetTakeoverSnapshot) throw takeoverUnavailable();
      provider = await client.readAssetTakeoverSnapshot();
      this.assertSnapshotBinding(provider, record);
      preview = this.preview(authorization, provider, record);
    }
    if (
      missingSide(preview)
      && isTradableMissing(preview, this.profile, provider, missingSide(preview)!)
    ) {
      throw manualIntervention();
    }
    return this.markManaged(record, preview, hooks);
  }

  private async cancelOrder<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    order: RwaAssetOrderReference,
    hooks: RwaAssetTakeoverExecutionHooks,
  ) {
    await hooks.assertMutationAllowed(record);
    record.plannedMutation = { kind: "cancel", category: order.category, orderId: order.orderId };
    record.updatedAt = this.now();
    await hooks.persist(record);
    await hooks.assertMutationAllowed(record);
    await client.cancelOrder(order.category, order.orderId);
    record.cancelledOrders.push({
      category: order.category,
      orderId: order.orderId,
      symbol: order.symbol,
    });
    record.plannedMutation = null;
    record.updatedAt = this.now();
    await hooks.persist(record);
  }

  private async setLeverage<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverExecutionHooks,
  ) {
    await hooks.assertMutationAllowed(record);
    record.state = "setting_leverage";
    record.plannedMutation = { kind: "leverage", leverage: record.leverage };
    record.updatedAt = this.now();
    await hooks.persist(record);
    await hooks.assertMutationAllowed(record);
    await client.setPerpetualLeverage(record.leverage);
    record.plannedMutation = null;
    record.updatedAt = this.now();
    await hooks.persist(record);
  }

  private async placeMissingOrder<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    preview: RwaAssetTakeoverPreview,
    category: "spot" | "linear",
    quantityBase: number,
    attempt: number,
    hooks: RwaAssetTakeoverExecutionHooks,
    deadlineAt: number,
  ) {
    const orderLinkId = `${record.orderLinkPrefix}${category === "spot" ? "s" : "p"}${attempt}`;
    const spec = category === "spot"
      ? this.profile.venue.spotRules
      : this.profile.venue.perpetualRules;
    const marketReference = category === "spot"
      ? preview.referenceSpotAsk
      : preview.referencePerpetualBid;
    const rawLimit = category === "spot"
      ? marketReference * (1 + RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000)
      : marketReference * (1 - RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000);
    const limitPrice = category === "spot"
      ? ceilStep(rawLimit, spec.allowedPriceSteps[0]!)
      : floorStep(rawLimit, spec.allowedPriceSteps[0]!);
    await hooks.assertMutationAllowed(record);
    record.state = category === "spot" ? "opening_spot" : "opening_perpetual";
    record.plannedMutation = { kind: "place", category, orderLinkId, quantityBase, attempt };
    record.updatedAt = this.now();
    await hooks.persist(record);
    await hooks.assertMutationAllowed(record);
    const accepted = await client.placeOrder({
      category,
      symbol: category === "spot" ? this.profile.venue.spotSymbol : this.profile.venue.perpetualSymbol,
      side: category === "spot" ? "Buy" : "Sell",
      quantityXaut: quantityBase,
      limitPrice,
      reduceOnly: false,
      orderLinkId,
    });
    record.acceptedOrders.push({ category, orderId: accepted.orderId, orderLinkId: accepted.orderLinkId });
    record.updatedAt = this.now();
    await hooks.persist(record);
    return client.awaitOrder(category, accepted.orderId, Math.min(deadlineAt, this.now() + 6_000));
  }

  private async recoverPlannedMutation<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions>,
    record: RwaAssetTakeoverRecord,
    hooks: RwaAssetTakeoverExecutionHooks,
    deadlineAt: number,
  ) {
    const planned = record.plannedMutation;
    if (!planned) return;
    if (planned.kind === "cancel") {
      if (!client.listAssetOpenOrders) throw takeoverUnavailable();
      const orders = await client.listAssetOpenOrders();
      const order = orders.find((item) =>
        item.category === planned.category && item.orderId === planned.orderId);
      if (order) await this.cancelOrder(client, record, order, hooks);
      else {
        record.plannedMutation = null;
        record.updatedAt = this.now();
        await hooks.persist(record);
      }
      return;
    }
    if (planned.kind === "leverage") {
      await this.setLeverage(client, record, hooks);
      return;
    }
    if (!client.findOrderByClientOrderId) throw takeoverUnavailable();
    const existing = await client.findOrderByClientOrderId(planned.category, planned.orderLinkId);
    if (!existing) {
      record.plannedMutation = null;
      record.updatedAt = this.now();
      await hooks.persist(record);
      return;
    }
    if (!record.acceptedOrders.some((item) => item.orderLinkId === planned.orderLinkId)) {
      record.acceptedOrders.push({
        category: planned.category,
        orderId: existing.orderId,
        orderLinkId: existing.orderLinkId,
      });
    }
    const confirmed = ["Filled", "Cancelled", "Rejected"].includes(existing.status)
      ? existing
      : await client.awaitOrder(planned.category, existing.orderId, deadlineAt);
    if (planned.category === "spot") record.spotOrders.push(confirmed);
    else record.perpetualOrders.push(confirmed);
    record.plannedMutation = null;
    record.updatedAt = this.now();
    await hooks.persist(record);
  }

  private preview(
    authorization: RwaAccountAssetAuthorization,
    provider: RwaAssetTakeoverProviderSnapshot,
    record: RwaAssetTakeoverRecord,
  ) {
    return createRwaAssetTakeoverPreview({
      profile: this.profile,
      authorization,
      provider,
      newCapitalUsd: record.newCapitalUsd,
      selectedLeverage: record.leverage,
      now: this.now(),
    });
  }

  private assertSnapshotBinding(
    snapshot: RwaAssetTakeoverProviderSnapshot,
    record: RwaAssetTakeoverRecord,
  ) {
    if (
      snapshot.account.accountId !== record.accountId
      || snapshot.account.accountFingerprint !== record.accountFingerprint
    ) throw previewChanged();
  }

  private async markManaged(
    record: RwaAssetTakeoverRecord,
    preview: RwaAssetTakeoverPreview,
    hooks: RwaAssetTakeoverExecutionHooks,
  ): Promise<RwaAssetTakeoverExecutionResult> {
    record.state = "managed";
    record.plannedMutation = null;
    record.previewDigest = preview.previewDigest;
    record.totalManagedCapitalUsd = preview.totalManagedCapitalUsd;
    record.reservedCapitalUsd = preview.totalManagedCapitalUsd;
    record.targetHedgedQuantity = preview.targetHedgedQuantity;
    record.finalSpotQuantity = preview.spotQuantity;
    record.finalPerpetualQuantity = preview.perpetualQuantity;
    record.residualQuantity = Math.abs(preview.spotQuantity - preview.perpetualQuantity);
    record.errorCategory = null;
    record.message = record.residualQuantity > this.profile.asset.hedgeToleranceBase
      ? "XAUT 已接管；剩余差额低于交易所最小可交易量，已记录为 residual/dust。"
      : "XAUT 现货多头与永续空头已严格对冲并完成接管。";
    record.updatedAt = this.now();
    await hooks.persist(record);
    return { status: "managed", record };
  }
}

function missingSide(preview: RwaAssetTakeoverPreview): "spot" | "linear" | null {
  if (preview.missingSpotQuantity > 0 && preview.missingPerpetualQuantity > 0) {
    throw manualIntervention();
  }
  if (preview.missingSpotQuantity > 0) return "spot";
  if (preview.missingPerpetualQuantity > 0) return "linear";
  return null;
}

function isTradableMissing(
  preview: RwaAssetTakeoverPreview,
  profile: RwaAutomationResolvedAssetProfile,
  provider: RwaAssetTakeoverProviderSnapshot,
  side: "spot" | "linear",
) {
  const quantity = side === "spot" ? preview.missingSpotQuantity : preview.missingPerpetualQuantity;
  return isTradableQuantity(preview, profile, provider, side, quantity);
}

function isTradableQuantity(
  preview: RwaAssetTakeoverPreview,
  profile: RwaAutomationResolvedAssetProfile,
  provider: RwaAssetTakeoverProviderSnapshot,
  side: "spot" | "linear",
  quantity: number,
) {
  if (quantity <= profile.asset.hedgeToleranceBase) return false;
  const rules = side === "spot" ? provider.account.spot : provider.account.perpetual;
  const notional = side === "spot"
    ? preview.referenceSpotAsk * quantity
    : preview.referencePerpetualBid * quantity;
  return quantity + 1e-12 >= rules.minOrderQty && notional + 1e-9 >= rules.minNotionalUsd;
}

function depthChunkQuantity(
  provider: RwaAssetTakeoverProviderSnapshot,
  side: "spot" | "linear",
  missingQuantity: number,
) {
  const levels = side === "spot" ? provider.spotAskDepth : provider.perpetualBidDepth;
  const reference = side === "spot"
    ? provider.account.spot.ask
    : provider.account.perpetual.bid;
  const limit = side === "spot"
    ? reference * (1 + RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000)
    : reference * (1 - RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000);
  const rules = side === "spot" ? provider.account.spot : provider.account.perpetual;
  let available = 0;
  for (const level of levels) {
    const executable = side === "spot" ? level.price <= limit : level.price >= limit;
    if (!executable) break;
    available += level.quantityBase;
    const candidate = floorStep(Math.min(missingQuantity, available), rules.qtyStep);
    const notional = candidate * reference;
    if (
      candidate + 1e-12 >= rules.minOrderQty
      && notional + 1e-9 >= rules.minNotionalUsd
    ) return candidate;
  }
  return 0;
}

function ceilStep(value: number, step: number) {
  return Math.ceil((value - 1e-12) / step) * step;
}

function floorStep(value: number, step: number) {
  return Math.floor((value + 1e-12) / step) * step;
}

function errorCategory(error: unknown) {
  return error instanceof RwaAssetTakeoverError
    ? error.category
    : "asset_takeover_manual_intervention";
}

function previewChanged() {
  return new RwaAssetTakeoverError(
    409,
    "asset_takeover_preview_changed",
    "XAUT 余额、仓位或活动订单已变化，请重新获取接管预览。",
  );
}

function takeoverUnavailable() {
  return new RwaAssetTakeoverError(
    503,
    "asset_takeover_risk_rejected",
    "交易所缺少接管所需的权威只读或恢复接口，已停止接管。",
  );
}

function manualIntervention() {
  return new RwaAssetTakeoverError(
    409,
    "asset_takeover_manual_intervention",
    "XAUT 接管无法在有限重试内形成严格对冲，需要人工处理。",
  );
}
