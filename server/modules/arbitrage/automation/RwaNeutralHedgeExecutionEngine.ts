import { randomUUID } from "node:crypto";
import type { RwaAutomationStateData } from "./RwaAutomationPersistentStore";
import { RwaExecutionSafetyError } from "./RwaNeutralExecutionTypes";
import type {
  RwaResidualAssessment,
  RwaExecutionConfig,
  RwaExecutionRecord,
  RwaNeutralTradingClient,
  RwaPositionAttributionSnapshot,
  RwaProviderOrder,
  RwaProviderPreflightSnapshot,
  RwaTrackedStrategyExposure,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";
import {
  combineActivityContinuities,
  createUnmonitoredActivityContinuity,
  mergeActivitySnapshot,
  recordStrategyProviderOrder,
  RWA_ACTIVITY_MAX_GAP_MS,
} from "./RwaProviderActivityContinuity";
import {
  assertRwaAutomationInstrumentRules,
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
  type RwaAutomationResolvedAssetProfile,
} from "./RwaAutomationAssetProfile";

type PersistExecution = (state: RwaAutomationStateData, execution: RwaExecutionRecord) => Promise<void>;
type PersistCloseFill = (category: "spot" | "linear", order: RwaProviderOrder) => Promise<void>;

export class RwaNeutralHedgeExecutionEngine {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly assertExecutionLeaseHeld: () => void = () => {},
    private readonly marketProfile: RwaAutomationResolvedAssetProfile =
      requireRwaAutomationExecutionProfile("xaut", "bybit"),
  ) {}

  async open<TPermissions extends RwaVenuePermissions>(input: {
    client: RwaNeutralTradingClient<TPermissions, RwaProviderPreflightSnapshot<TPermissions>>;
    execution: RwaExecutionRecord;
    snapshot: RwaProviderPreflightSnapshot<TPermissions>;
    config: RwaExecutionConfig;
    state: RwaAutomationStateData;
    quantityXaut: number;
    persist: PersistExecution;
  }) {
    const { client, execution, snapshot, config, state, persist } = input;
    if (
      execution.asset !== this.marketProfile.asset.baseAsset
      || execution.profileId !== rwaAutomationProfileId(this.marketProfile)
    ) {
      throw new RwaExecutionSafetyError(
        "strategy_ownership_ambiguous",
        "执行记录与服务端资产 profile 不匹配，已拒绝新增风险。",
      );
    }
    this.assertSnapshotMatchesProfile(snapshot);
    this.assertExecutionLeaseHeld();
    if (
      snapshot.existingSpotQuantityXaut > 1e-12
      || snapshot.existingPerpetualQuantityXaut > 1e-12
      || snapshot.openSpotOrderCount !== 0
      || snapshot.openPerpetualOrderCount !== 0
    ) {
      throw new RwaExecutionSafetyError(
        "strategy_ownership_ambiguous",
        "建立活动监控前账户已有 XAUT 仓位或活动订单，已拒绝新增风险。",
      );
    }
    const baseline = await client.readPositionAttribution({
      strategyOrderPrefix: execution.orderLinkPrefix,
      strategyOrderPrefixes: [execution.orderLinkPrefix],
      since: snapshot.fetchedAt,
      continuity: execution.activityContinuity,
    });
    execution.activityContinuity = mergeActivitySnapshot(
      execution.activityContinuity,
      baseline,
      [execution.orderLinkPrefix],
      this.now(),
    );
    assertPositionAttribution(baseline, {
      complete: true,
      spotQuantityXaut: 0,
      perpetualQuantityXaut: 0,
      sourceExecutionIds: [execution.executionId],
      strategyOrderPrefixes: [execution.orderLinkPrefix],
      attributionSince: snapshot.fetchedAt,
      activityContinuity: execution.activityContinuity,
    }, snapshot.fetchedAt);
    await persist(state, execution);
    this.assertExecutionLeaseHeld();
    await client.setPerpetualLeverage(1);
    this.assertExecutionLeaseHeld();
    const halfSlippage = config.maxCombinedSlippageBps / 2 / 10_000;
    const deadline = this.now() + config.maxUnhedgedMs;
    const hedgeDeadline = deadline - Math.min(3_000, Math.floor(config.maxUnhedgedMs / 3));
    execution.state = "opening_spot";
    await persist(state, execution);
    this.assertExecutionLeaseHeld();
    const spotAccepted = await client.placeOrder({
      category: "spot",
      symbol: this.marketProfile.venue.spotSymbol,
      side: "Buy",
      quantityXaut: input.quantityXaut,
      limitPrice: ceilStep(snapshot.spot.ask * (1 + halfSlippage), snapshot.spot.priceTick),
      reduceOnly: false,
      orderLinkId: `${execution.orderLinkPrefix}s1`,
    });
    execution.activityContinuity = recordStrategyProviderOrder(
      execution.activityContinuity,
      "spot",
      spotAccepted.orderId,
      this.now(),
    );
    await persist(state, execution);
    this.assertExecutionLeaseHeld();
    const spot = await client.awaitOrder("spot", spotAccepted.orderId, Math.min(deadline, this.now() + 4_000));
    const firstSideFilledAt = this.now();
    const spotPositionQuantity = positionQuantity(spot);
    execution.spotOrder = spot;
    execution.strategyPosition.spotRemainingXaut = spotPositionQuantity;
    execution.strategyPosition.updatedAt = this.now();
    await persist(state, execution);
    if (spot.status === "PartiallyFilled" || spot.status === "New") {
      this.assertExecutionLeaseHeld();
      await client.cancelOrder("spot", spot.orderId);
    }
    if (spot.filledQuantityXaut < snapshot.perpetual.minOrderQty) throw new Error("现货侧未形成可对冲的最小成交量。");

    execution.state = "opening_perpetual";
    await persist(state, execution);
    let remaining = floorStep(spot.filledQuantityXaut, snapshot.perpetual.qtyStep);
    let attempt = 0;
    while (remaining >= snapshot.perpetual.minOrderQty && attempt < 2 && this.now() < hedgeDeadline) {
      attempt += 1;
      this.assertExecutionLeaseHeld();
      const accepted = await client.placeOrder({
        category: "linear",
        symbol: this.marketProfile.venue.perpetualSymbol,
        side: "Sell",
        quantityXaut: remaining,
        limitPrice: floorStep(snapshot.perpetual.bid * (1 - halfSlippage), snapshot.perpetual.priceTick),
        reduceOnly: false,
        orderLinkId: `${execution.orderLinkPrefix}p${attempt}`,
      });
      execution.activityContinuity = recordStrategyProviderOrder(
        execution.activityContinuity,
        "linear",
        accepted.orderId,
        this.now(),
      );
      await persist(state, execution);
      this.assertExecutionLeaseHeld();
      const order = await client.awaitOrder("linear", accepted.orderId, hedgeDeadline);
      const perpetualPositionQuantity = positionQuantity(order);
      execution.perpetualOrders.push(order);
      execution.strategyPosition.perpetualRemainingXaut += perpetualPositionQuantity;
      execution.strategyPosition.updatedAt = this.now();
      await persist(state, execution);
      if (order.status === "PartiallyFilled" || order.status === "New") {
        this.assertExecutionLeaseHeld();
        await client.cancelOrder("linear", order.orderId);
      }
      remaining = floorStep(Math.max(0, remaining - order.filledQuantityXaut), snapshot.perpetual.qtyStep);
    }

    const perpetualFilled = execution.perpetualOrders.reduce((sum, order) => sum + order.filledQuantityXaut, 0);
    const excessSpot = floorStep(Math.max(0, spot.filledQuantityXaut - perpetualFilled), snapshot.spot.qtyStep);
    if (excessSpot >= snapshot.spot.minOrderQty) {
      execution.state = "compensating";
      await persist(state, execution);
      this.assertExecutionLeaseHeld();
      const accepted = await client.placeOrder({
        category: "spot",
        symbol: this.marketProfile.venue.spotSymbol,
        side: "Sell",
        quantityXaut: excessSpot,
        limitPrice: floorStep(snapshot.spot.bid * (1 - halfSlippage), snapshot.spot.priceTick),
        reduceOnly: false,
        orderLinkId: `${execution.orderLinkPrefix}x1`,
      });
      execution.activityContinuity = recordStrategyProviderOrder(
        execution.activityContinuity,
        "spot",
        accepted.orderId,
        this.now(),
      );
      await persist(state, execution);
      this.assertExecutionLeaseHeld();
      const compensation = await client.awaitOrder("spot", accepted.orderId, deadline);
      const compensationPositionQuantity = positionQuantity(compensation);
      execution.compensationOrders.push(compensation);
      execution.strategyPosition.spotRemainingXaut = Math.max(
        0,
        execution.strategyPosition.spotRemainingXaut - compensationPositionQuantity,
      );
      execution.strategyPosition.updatedAt = this.now();
      await persist(state, execution);
      if (compensation.filledQuantityXaut + 1e-9 < excessSpot) throw new Error("未对冲敞口未能在时限内退出。");
    }

    const paired = Math.min(spot.filledQuantityXaut, perpetualFilled);
    if (paired < snapshot.perpetual.minOrderQty) throw new Error("现货与永续未形成最小对冲组合。");
    execution.hedgedQuantityXaut = paired;
    execution.unhedgedDurationMs = Math.max(0, this.now() - firstSideFilledAt);
    if (execution.unhedgedDurationMs > config.maxUnhedgedMs) throw new Error("未对冲敞口超过配置时限。");
    execution.state = "hedged";
    execution.message = `已在服务端资产 profile 的受控预算内建立 ${this.marketProfile.asset.displayName} 现货与永续对冲组合。`;
    execution.updatedAt = this.now();
    await persist(state, execution);
  }

  async closeAll<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions, RwaProviderPreflightSnapshot<TPermissions>>,
    scope: string,
    orderLinkPrefix: string,
    trackedExposure: RwaTrackedStrategyExposure,
    persistCloseFill: PersistCloseFill,
    persistActivitySnapshot?: (snapshot: RwaPositionAttributionSnapshot) => Promise<void>,
    persistProviderOrder?: (category: "spot" | "linear", orderId: string) => Promise<void>,
  ) {
    this.assertExecutionLeaseHeld();
    assertTrackedExposure(trackedExposure);
    const market = await client.readPreflightSnapshot();
    assertValidProviderSnapshot(market);
    this.assertSnapshotMatchesProfile(market);
    assertOwnershipMatches(trackedExposure, market);
    const attribution = await client.readPositionAttribution({
      strategyOrderPrefix: scope,
      strategyOrderPrefixes: trackedExposure.strategyOrderPrefixes,
      since: trackedExposure.attributionSince,
      continuity: trackedExposure.activityContinuity,
    });
    await persistActivitySnapshot?.(attribution);
    assertPositionAttribution(attribution, trackedExposure, market.fetchedAt);
    this.assertExecutionLeaseHeld();
    await client.cancelStrategyOrders(scope);
    this.assertExecutionLeaseHeld();
    const closableMarket = await client.readPreflightSnapshot();
    assertValidProviderSnapshot(closableMarket);
    this.assertSnapshotMatchesProfile(closableMarket);
    assertOwnershipMatches(trackedExposure, closableMarket);
    const closableAttribution = await client.readPositionAttribution({
      strategyOrderPrefix: scope,
      strategyOrderPrefixes: trackedExposure.strategyOrderPrefixes,
      since: trackedExposure.attributionSince,
      continuity: trackedExposure.activityContinuity,
    });
    await persistActivitySnapshot?.(closableAttribution);
    assertPositionAttribution(closableAttribution, trackedExposure, closableMarket.fetchedAt);
    const deadline = this.now() + 10_000;
    const perpetualResidual = assessResidual(
      trackedExposure.perpetualQuantityXaut,
      closableMarket.perpetual.bid || closableMarket.perpetual.ask || closableMarket.perpetual.minNotionalUsd,
      closableMarket.perpetual.qtyStep,
      closableMarket.perpetual.minOrderQty,
      closableMarket.perpetual.minNotionalUsd,
    );
    const spotResidual = assessResidual(
      trackedExposure.spotQuantityXaut,
      closableMarket.spot.bid || closableMarket.spot.ask || closableMarket.spot.minNotionalUsd,
      closableMarket.spot.qtyStep,
      closableMarket.spot.minOrderQty,
      closableMarket.spot.minNotionalUsd,
    );
    let remainingPerpetual = trackedExposure.perpetualQuantityXaut;
    let remainingSpot = trackedExposure.spotQuantityXaut;
    if (perpetualResidual.tradable) await this.closeSide(client, {
      category: "linear",
      symbol: this.marketProfile.venue.perpetualSymbol,
      side: "Buy",
      quantity: perpetualResidual.quantityXaut,
      qtyStep: closableMarket.perpetual.qtyStep,
      minOrderQty: closableMarket.perpetual.minOrderQty,
      limitPrice: ceilStep(closableMarket.perpetual.ask * 1.001, closableMarket.perpetual.priceTick),
      reduceOnly: true,
      orderLinkPrefix: `${orderLinkPrefix}cp`,
      deadline,
      failureMessage: "永续侧仓位未完全退出。",
      persistFill: async (order) => {
        await persistCloseFill("linear", order);
        remainingPerpetual = Math.max(0, remainingPerpetual - positionQuantity(order));
      },
      persistAcceptedOrder: persistProviderOrder,
    });
    if (spotResidual.tradable) await this.closeSide(client, {
      category: "spot",
      symbol: this.marketProfile.venue.spotSymbol,
      side: "Sell",
      quantity: spotResidual.quantityXaut,
      qtyStep: closableMarket.spot.qtyStep,
      minOrderQty: closableMarket.spot.minOrderQty,
      limitPrice: floorStep(closableMarket.spot.bid * 0.999, closableMarket.spot.priceTick),
      reduceOnly: false,
      orderLinkPrefix: `${orderLinkPrefix}cs`,
      deadline,
      failureMessage: "现货侧仓位未完全退出。",
      persistFill: async (order) => {
        await persistCloseFill("spot", order);
        remainingSpot = Math.max(0, remainingSpot - positionQuantity(order));
      },
      persistAcceptedOrder: persistProviderOrder,
    });
    this.assertExecutionLeaseHeld();
    const confirmedPnl = await client.readStrategyPnl(scope, null);
    const confirmedMarket = await client.readPreflightSnapshot();
    assertValidProviderSnapshot(confirmedMarket);
    this.assertSnapshotMatchesProfile(confirmedMarket);
    assertOwnershipMatches({
      ...trackedExposure,
      spotQuantityXaut: remainingSpot,
      perpetualQuantityXaut: remainingPerpetual,
    }, confirmedMarket);
    const confirmedSpot = assessResidual(
      remainingSpot,
      confirmedMarket.spot.bid || confirmedMarket.spot.ask || confirmedMarket.spot.minNotionalUsd,
      confirmedMarket.spot.qtyStep,
      confirmedMarket.spot.minOrderQty,
      confirmedMarket.spot.minNotionalUsd,
    );
    const confirmedPerpetual = assessResidual(
      remainingPerpetual,
      confirmedMarket.perpetual.bid || confirmedMarket.perpetual.ask || confirmedMarket.perpetual.minNotionalUsd,
      confirmedMarket.perpetual.qtyStep,
      confirmedMarket.perpetual.minOrderQty,
      confirmedMarket.perpetual.minNotionalUsd,
    );
    if (confirmedPnl.openOrders.length || confirmedSpot.tradable || confirmedPerpetual.tradable) {
      throw new Error("交易所权威状态仍存在策略活动订单或未退出的两侧仓位。");
    }
    return { spot: confirmedSpot, perpetual: confirmedPerpetual };
  }

  private async closeSide<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions, RwaProviderPreflightSnapshot<TPermissions>>,
    input: {
    category: "spot" | "linear";
    symbol: string;
    side: "Buy" | "Sell";
    quantity: number;
    qtyStep: number;
    minOrderQty: number;
    limitPrice: number;
    reduceOnly: boolean;
    orderLinkPrefix: string;
    deadline: number;
    failureMessage: string;
    persistFill: (order: RwaProviderOrder) => Promise<void>;
    persistAcceptedOrder?: (category: "spot" | "linear", orderId: string) => Promise<void>;
    },
  ) {
    let remaining = floorStep(input.quantity, input.qtyStep);
    let attempt = 0;
    while (remaining >= input.minOrderQty && attempt < 2 && this.now() < input.deadline) {
      attempt += 1;
      this.assertExecutionLeaseHeld();
      const accepted = await client.placeOrder({
        category: input.category,
        symbol: input.symbol,
        side: input.side,
        quantityXaut: remaining,
        limitPrice: input.limitPrice,
        reduceOnly: input.reduceOnly,
        orderLinkId: `${input.orderLinkPrefix}${attempt}`,
      });
      await input.persistAcceptedOrder?.(input.category, accepted.orderId);
      this.assertExecutionLeaseHeld();
      const order = await client.awaitOrder(input.category, accepted.orderId, input.deadline);
      const filledPositionQuantity = positionQuantity(order);
      if (order.filledQuantityXaut > 0) await input.persistFill(order);
      if (order.status === "PartiallyFilled" || order.status === "New") {
        this.assertExecutionLeaseHeld();
        await client.cancelOrder(input.category, order.orderId);
      }
      remaining = floorStep(Math.max(0, remaining - filledPositionQuantity), input.qtyStep);
    }
    if (remaining >= input.minOrderQty) throw new Error(input.failureMessage);
  }

  private assertSnapshotMatchesProfile<TPermissions extends RwaVenuePermissions>(
    snapshot: RwaProviderPreflightSnapshot<TPermissions>,
  ) {
    assertRwaAutomationInstrumentRules(this.marketProfile, "spot", snapshot.spot);
    assertRwaAutomationInstrumentRules(this.marketProfile, "perpetual", snapshot.perpetual);
    if (
      snapshot.fees.spotTakerBps > this.marketProfile.venue.spotRules.maxTakerFeeBps
      || snapshot.fees.perpetualTakerBps > this.marketProfile.venue.perpetualRules.maxTakerFeeBps
    ) {
      throw new RwaExecutionSafetyError(
        "provider_snapshot_invalid",
        "交易所费率超过服务端资产 profile 上限，已拒绝自动执行。",
      );
    }
  }

}

export function createNeutralExecutionRecord(input: {
  userId: string;
  accountId: string;
  userOrderPrefix: string;
  idempotencyKey: string;
  challengeId: string;
  now: number;
  venue?: "bybit" | "binance";
  reservedCapitalUsd?: number;
}): RwaExecutionRecord {
  const executionId = randomUUID();
  const profile = requireRwaAutomationExecutionProfile("xaut", input.venue ?? "bybit");
  return {
    userId: input.userId,
    accountId: input.accountId,
    asset: "XAUT",
    profileId: rwaAutomationProfileId(profile),
    reservedCapitalUsd: input.reservedCapitalUsd ?? 0,
    executionId,
    idempotencyKey: input.idempotencyKey,
    challengeId: input.challengeId,
    state: "accepted",
    orderLinkPrefix: `${input.userOrderPrefix}${executionId.replace(/-/g, "").slice(0, 10)}`,
    spotOrder: null,
    perpetualOrders: [],
    compensationOrders: [],
    hedgedQuantityXaut: 0,
    unhedgedDurationMs: null,
    errorCategory: null,
    message: "执行请求已接受，等待建立现货与永续对冲组合。",
    reconciliation: null,
    finalizeIdempotency: null,
    strategyPosition: {
      coverage: "complete",
      spotRemainingXaut: 0,
      perpetualRemainingXaut: 0,
      updatedAt: input.now,
    },
    activityContinuity: createUnmonitoredActivityContinuity(input.now),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function calculateNeutralExecutionSlippage(state: RwaAutomationStateData) {
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

function floorStep(value: number, step: number) {
  return step > 0 ? Math.floor((value + 1e-12) / step) * step : 0;
}

function ceilStep(value: number, step: number) {
  return step > 0 ? Math.ceil((value - 1e-12) / step) * step : 0;
}

export function spotClosableQuantity<TPermissions extends RwaVenuePermissions>(market: RwaProviderPreflightSnapshot<TPermissions>) {
  const explicitFree = (market as { spotFreeXaut?: unknown }).spotFreeXaut;
  const free = typeof explicitFree === "number" && Number.isFinite(explicitFree)
    ? explicitFree
    : market.existingSpotQuantityXaut;
  return Math.max(0, free);
}

export function trackedExposureFromExecution(execution: RwaExecutionRecord): RwaTrackedStrategyExposure {
  return {
    complete: execution.strategyPosition.coverage === "complete",
    spotQuantityXaut: execution.strategyPosition.spotRemainingXaut,
    perpetualQuantityXaut: execution.strategyPosition.perpetualRemainingXaut,
    sourceExecutionIds: [execution.executionId],
    strategyOrderPrefixes: [execution.orderLinkPrefix],
    attributionSince: execution.createdAt,
    activityContinuity: execution.activityContinuity,
  };
}

export function trackedExposureFromState(
  executions: RwaExecutionRecord[],
  profileId?: string,
): RwaTrackedStrategyExposure {
  const strategyExecutions = executions.filter((execution) =>
    execution.challengeId !== "close-all"
    && (profileId === undefined || execution.profileId === profileId));
  const sources = strategyExecutions.filter((execution) =>
    execution.strategyPosition.spotRemainingXaut > 0 || execution.strategyPosition.perpetualRemainingXaut > 0);
  const ambiguous = strategyExecutions.some((execution) => execution.strategyPosition.coverage !== "complete");
  const attributionSince = sources.reduce(
    (earliest, execution) => Math.min(earliest, execution.createdAt),
    Number.POSITIVE_INFINITY,
  );
  return {
    complete: !ambiguous,
    spotQuantityXaut: sources.reduce((total, execution) => total + execution.strategyPosition.spotRemainingXaut, 0),
    perpetualQuantityXaut: sources.reduce((total, execution) => total + execution.strategyPosition.perpetualRemainingXaut, 0),
    sourceExecutionIds: sources.map((execution) => execution.executionId),
    strategyOrderPrefixes: strategyExecutions.map((execution) => execution.orderLinkPrefix),
    attributionSince,
    activityContinuity: combineActivityContinuities(
      sources.map((execution) => execution.activityContinuity),
      attributionSince,
    ),
  };
}

function assertTrackedExposure(exposure: RwaTrackedStrategyExposure) {
  if (
    !exposure.complete
    || !Number.isFinite(exposure.spotQuantityXaut)
    || !Number.isFinite(exposure.perpetualQuantityXaut)
    || exposure.spotQuantityXaut < 0
    || exposure.perpetualQuantityXaut < 0
    || !Number.isFinite(exposure.attributionSince)
    || exposure.attributionSince < 0
    || exposure.strategyOrderPrefixes.length === 0
    || exposure.strategyOrderPrefixes.some((prefix) => !prefix)
    || exposure.activityContinuity.spot.coverage !== "monitored"
    || exposure.activityContinuity.perpetual.coverage !== "monitored"
  ) {
    throw new RwaExecutionSafetyError(
      "strategy_ownership_ambiguous",
      "策略持仓归属记录不完整，已拒绝自动退出并要求人工核对。",
    );
  }
}

function assertPositionAttribution(
  attribution: RwaPositionAttributionSnapshot,
  exposure: RwaTrackedStrategyExposure,
  snapshotFetchedAt: number,
) {
  const continuityStart = Math.min(
    exposure.activityContinuity.spot.immutableStartAt,
    exposure.activityContinuity.perpetual.immutableStartAt,
  );
  const previousCheckedThrough = Math.min(
    exposure.activityContinuity.spot.checkedThrough,
    exposure.activityContinuity.perpetual.checkedThrough,
  );
  if (
    attribution.coverage !== "complete"
    || attribution.externalPositionActivity
    || !Number.isFinite(attribution.checkedFrom)
    || !Number.isFinite(attribution.checkedThrough)
    || continuityStart > exposure.attributionSince
    || attribution.checkedFrom > previousCheckedThrough
    || attribution.checkedThrough - previousCheckedThrough > RWA_ACTIVITY_MAX_GAP_MS
    || attribution.checkedThrough < snapshotFetchedAt
    || attribution.checkedThrough < attribution.checkedFrom
  ) {
    throw new RwaExecutionSafetyError(
      "strategy_ownership_ambiguous",
      "交易所活动连续性无法完整证明策略持仓归属，已拒绝自动退出并要求人工核对。",
    );
  }
}

function assertValidProviderSnapshot<TPermissions extends RwaVenuePermissions>(
  market: RwaProviderPreflightSnapshot<TPermissions>,
) {
  const requiredNonNegative = [
    market.fetchedAt,
    market.availableUsdt,
    market.existingSpotQuantityXaut,
    market.spotAvailableQuantityXaut,
    market.spotLockedQuantityXaut,
    market.existingPerpetualQuantityXaut,
    market.spot.minOrderQty,
    market.spot.qtyStep,
    market.spot.minNotionalUsd,
    market.spot.priceTick,
    market.spot.bid,
    market.spot.ask,
    market.perpetual.minOrderQty,
    market.perpetual.qtyStep,
    market.perpetual.minNotionalUsd,
    market.perpetual.priceTick,
    market.perpetual.bid,
    market.perpetual.ask,
  ];
  const optionalNonNegative = [
    (market as { spotFreeXaut?: unknown }).spotFreeXaut,
    (market as { spotLockedXaut?: unknown }).spotLockedXaut,
  ].filter((value) => value !== undefined);
  if (
    !market.accountId
    || requiredNonNegative.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)
    || optionalNonNegative.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)
    || !Number.isSafeInteger(market.openSpotOrderCount) || market.openSpotOrderCount < 0
    || !Number.isSafeInteger(market.openPerpetualOrderCount) || market.openPerpetualOrderCount < 0
    || !["long", "short", "flat"].includes(market.perpetualPositionSide)
    || Math.abs(
      market.existingSpotQuantityXaut
      - market.spotAvailableQuantityXaut
      - market.spotLockedQuantityXaut
    ) > 1e-9
    || (market.existingPerpetualQuantityXaut <= 1e-12) !== (market.perpetualPositionSide === "flat")
    || !(market.spot.qtyStep > 0 && market.spot.minOrderQty > 0 && market.spot.priceTick > 0)
    || !(market.perpetual.qtyStep > 0 && market.perpetual.minOrderQty > 0 && market.perpetual.priceTick > 0)
    || !(market.spot.bid > 0 && market.spot.ask > 0 && market.perpetual.bid > 0 && market.perpetual.ask > 0)
  ) {
    throw new RwaExecutionSafetyError(
      "provider_snapshot_invalid",
      "交易所权威快照字段无效，已拒绝自动执行。",
    );
  }
}

function assertOwnershipMatches<TPermissions extends RwaVenuePermissions>(
  exposure: RwaTrackedStrategyExposure,
  market: RwaProviderPreflightSnapshot<TPermissions>,
) {
  const spotTolerance = Math.max(market.spot.qtyStep * 1e-6, 1e-9);
  const perpetualTolerance = Math.max(market.perpetual.qtyStep * 1e-6, 1e-9);
  if (
    Math.abs(market.existingSpotQuantityXaut - exposure.spotQuantityXaut) > spotTolerance + 1e-12
    || Math.abs(market.existingPerpetualQuantityXaut - exposure.perpetualQuantityXaut) > perpetualTolerance + 1e-12
  ) {
    throw new RwaExecutionSafetyError(
      "strategy_ownership_ambiguous",
      "交易所权威仓位与持久策略归属不一致，已拒绝自动退出并要求人工核对。",
    );
  }
}

function positionQuantity(order: RwaProviderOrder) {
  const quantity = order.positionQuantityXaut ?? order.filledQuantityXaut;
  if (
    !Number.isFinite(order.requestedQuantityXaut)
    || order.requestedQuantityXaut <= 0
    || !Number.isFinite(order.filledQuantityXaut)
    || order.filledQuantityXaut < 0
    || order.filledQuantityXaut > order.requestedQuantityXaut * 1.01 + 1e-12
    || !Number.isFinite(quantity)
    || quantity < 0
    || quantity > Math.max(order.requestedQuantityXaut, order.filledQuantityXaut) * 1.01 + 1e-12
  ) {
    throw new RwaExecutionSafetyError(
      "provider_snapshot_invalid",
      "交易所订单持仓变化数量无效，已停止自动执行。",
    );
  }
  return quantity;
}

export function assessResidual(
  quantity: number,
  referencePrice: number,
  qtyStep: number,
  minOrderQty: number,
  minNotionalUsd: number,
): RwaResidualAssessment {
  const rawQuantity = Math.max(0, quantity);
  const alignedQuantity = floorStep(rawQuantity, qtyStep);
  const rawNotionalUsd = rawQuantity * Math.max(0, referencePrice);
  const alignedNotionalUsd = alignedQuantity * Math.max(0, referencePrice);
  if (!(rawQuantity > 0)) {
    return { quantityXaut: 0, notionalUsd: 0, minOrderQty, minNotionalUsd, qtyStep, tradable: false, reason: "zero" };
  }
  if (alignedQuantity + 1e-12 < minOrderQty) {
    return { quantityXaut: normalizeResidualNumber(rawQuantity), notionalUsd: normalizeResidualNumber(rawNotionalUsd), minOrderQty, minNotionalUsd, qtyStep, tradable: false, reason: "below_min_qty" };
  }
  if (alignedNotionalUsd + 1e-9 < minNotionalUsd) {
    return { quantityXaut: normalizeResidualNumber(rawQuantity), notionalUsd: normalizeResidualNumber(rawNotionalUsd), minOrderQty, minNotionalUsd, qtyStep, tradable: false, reason: "below_min_notional" };
  }
  return { quantityXaut: normalizeResidualNumber(alignedQuantity), notionalUsd: normalizeResidualNumber(alignedNotionalUsd), minOrderQty, minNotionalUsd, qtyStep, tradable: true, reason: "tradable" };
}

function normalizeResidualNumber(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
