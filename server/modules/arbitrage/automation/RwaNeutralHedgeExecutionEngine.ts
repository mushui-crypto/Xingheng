import { randomUUID } from "node:crypto";
import type { RwaAutomationStateData } from "./RwaAutomationPersistentStore";
import type {
  RwaResidualAssessment,
  RwaExecutionConfig,
  RwaExecutionRecord,
  RwaNeutralTradingClient,
  RwaProviderPreflightSnapshot,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";

type PersistExecution = (state: RwaAutomationStateData, execution: RwaExecutionRecord) => Promise<void>;

export class RwaNeutralHedgeExecutionEngine {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly assertExecutionLeaseHeld: () => void = () => {},
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
    this.assertExecutionLeaseHeld();
    const halfSlippage = config.maxCombinedSlippageBps / 2 / 10_000;
    const deadline = this.now() + config.maxUnhedgedMs;
    const hedgeDeadline = deadline - Math.min(3_000, Math.floor(config.maxUnhedgedMs / 3));
    execution.state = "opening_spot";
    await persist(state, execution);
    this.assertExecutionLeaseHeld();
    const spotAccepted = await client.placeOrder({
      category: "spot",
      symbol: "XAUTUSDT",
      side: "Buy",
      quantityXaut: input.quantityXaut,
      limitPrice: ceilStep(snapshot.spot.ask * (1 + halfSlippage), snapshot.spot.priceTick),
      reduceOnly: false,
      orderLinkId: `${execution.orderLinkPrefix}s1`,
    });
    this.assertExecutionLeaseHeld();
    const spot = await client.awaitOrder("spot", spotAccepted.orderId, Math.min(deadline, this.now() + 4_000));
    const firstSideFilledAt = this.now();
    execution.spotOrder = spot;
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
        symbol: "XAUTUSDT",
        side: "Sell",
        quantityXaut: remaining,
        limitPrice: floorStep(snapshot.perpetual.bid * (1 - halfSlippage), snapshot.perpetual.priceTick),
        reduceOnly: false,
        orderLinkId: `${execution.orderLinkPrefix}p${attempt}`,
      });
      this.assertExecutionLeaseHeld();
      const order = await client.awaitOrder("linear", accepted.orderId, hedgeDeadline);
      execution.perpetualOrders.push(order);
      if (order.status === "PartiallyFilled" || order.status === "New") {
        this.assertExecutionLeaseHeld();
        await client.cancelOrder("linear", order.orderId);
      }
      remaining = floorStep(Math.max(0, remaining - order.filledQuantityXaut), snapshot.perpetual.qtyStep);
      await persist(state, execution);
    }

    const perpetualFilled = execution.perpetualOrders.reduce((sum, order) => sum + order.filledQuantityXaut, 0);
    const excessSpot = floorStep(Math.max(0, spot.filledQuantityXaut - perpetualFilled), snapshot.spot.qtyStep);
    if (excessSpot >= snapshot.spot.minOrderQty) {
      execution.state = "compensating";
      await persist(state, execution);
      this.assertExecutionLeaseHeld();
      const accepted = await client.placeOrder({
        category: "spot",
        symbol: "XAUTUSDT",
        side: "Sell",
        quantityXaut: excessSpot,
        limitPrice: floorStep(snapshot.spot.bid * (1 - halfSlippage), snapshot.spot.priceTick),
        reduceOnly: false,
        orderLinkId: `${execution.orderLinkPrefix}x1`,
      });
      this.assertExecutionLeaseHeld();
      const compensation = await client.awaitOrder("spot", accepted.orderId, deadline);
      execution.compensationOrders.push(compensation);
      if (compensation.filledQuantityXaut + 1e-9 < excessSpot) throw new Error("未对冲敞口未能在时限内退出。");
    }

    const paired = Math.min(spot.filledQuantityXaut, perpetualFilled);
    if (paired < snapshot.perpetual.minOrderQty) throw new Error("现货与永续未形成最小对冲组合。");
    execution.hedgedQuantityXaut = paired;
    execution.unhedgedDurationMs = Math.max(0, this.now() - firstSideFilledAt);
    if (execution.unhedgedDurationMs > config.maxUnhedgedMs) throw new Error("未对冲敞口超过配置时限。");
    execution.state = "hedged";
    execution.message = "已在 25 USDT 总预算内建立 XAUT 现货与永续对冲组合。";
    execution.updatedAt = this.now();
    await persist(state, execution);
  }

  async closeAll<TPermissions extends RwaVenuePermissions>(
    client: RwaNeutralTradingClient<TPermissions, RwaProviderPreflightSnapshot<TPermissions>>,
    scope: string,
    orderLinkPrefix: string,
  ) {
    this.assertExecutionLeaseHeld();
    const market = await client.readPreflightSnapshot();
    const pnl = await client.readStrategyPnl(scope, null);
    const deadline = this.now() + 10_000;
    const perpetualResidual = assessResidual(
      market.existingPerpetualQuantityXaut,
      market.perpetual.bid || market.perpetual.ask || market.perpetual.minNotionalUsd,
      market.perpetual.qtyStep,
      market.perpetual.minOrderQty,
      market.perpetual.minNotionalUsd,
    );
    const spotResidual = assessResidual(
      spotClosableQuantity(market),
      market.spot.bid || market.spot.ask || market.spot.minNotionalUsd,
      market.spot.qtyStep,
      market.spot.minOrderQty,
      market.spot.minNotionalUsd,
    );
    if (perpetualResidual.tradable) await this.closeSide(client, {
      category: "linear",
      side: "Buy",
      quantity: perpetualResidual.quantityXaut,
      qtyStep: market.perpetual.qtyStep,
      minOrderQty: market.perpetual.minOrderQty,
      limitPrice: ceilStep(market.perpetual.ask * 1.001, market.perpetual.priceTick),
      reduceOnly: true,
      orderLinkPrefix: `${orderLinkPrefix}cp`,
      deadline,
      failureMessage: "永续侧仓位未完全退出。",
    });
    if (spotResidual.tradable) await this.closeSide(client, {
      category: "spot",
      side: "Sell",
      quantity: spotResidual.quantityXaut,
      qtyStep: market.spot.qtyStep,
      minOrderQty: market.spot.minOrderQty,
      limitPrice: floorStep(market.spot.bid * 0.999, market.spot.priceTick),
      reduceOnly: false,
      orderLinkPrefix: `${orderLinkPrefix}cs`,
      deadline,
      failureMessage: "现货侧仓位未完全退出。",
    });
    this.assertExecutionLeaseHeld();
    const confirmedPnl = await client.readStrategyPnl(scope, null);
    const confirmedMarket = await client.readPreflightSnapshot();
    const confirmedSpot = assessResidual(
      spotClosableQuantity(confirmedMarket),
      confirmedMarket.spot.bid || confirmedMarket.spot.ask || confirmedMarket.spot.minNotionalUsd,
      confirmedMarket.spot.qtyStep,
      confirmedMarket.spot.minOrderQty,
      confirmedMarket.spot.minNotionalUsd,
    );
    const confirmedPerpetual = assessResidual(
      confirmedMarket.existingPerpetualQuantityXaut,
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
    side: "Buy" | "Sell";
    quantity: number;
    qtyStep: number;
    minOrderQty: number;
    limitPrice: number;
    reduceOnly: boolean;
    orderLinkPrefix: string;
    deadline: number;
    failureMessage: string;
    },
  ) {
    let remaining = floorStep(input.quantity, input.qtyStep);
    let attempt = 0;
    while (remaining >= input.minOrderQty && attempt < 2 && this.now() < input.deadline) {
      attempt += 1;
      this.assertExecutionLeaseHeld();
      const accepted = await client.placeOrder({
        category: input.category,
        symbol: "XAUTUSDT",
        side: input.side,
        quantityXaut: remaining,
        limitPrice: input.limitPrice,
        reduceOnly: input.reduceOnly,
        orderLinkId: `${input.orderLinkPrefix}${attempt}`,
      });
      this.assertExecutionLeaseHeld();
      const order = await client.awaitOrder(input.category, accepted.orderId, input.deadline);
      if (order.status === "PartiallyFilled" || order.status === "New") {
        this.assertExecutionLeaseHeld();
        await client.cancelOrder(input.category, order.orderId);
      }
      remaining = floorStep(Math.max(0, remaining - order.filledQuantityXaut), input.qtyStep);
    }
    if (remaining >= input.minOrderQty) throw new Error(input.failureMessage);
  }
}

export function createNeutralExecutionRecord(input: {
  userId: string;
  accountId: string;
  userOrderPrefix: string;
  idempotencyKey: string;
  challengeId: string;
  now: number;
}): RwaExecutionRecord {
  const executionId = randomUUID();
  return {
    userId: input.userId,
    accountId: input.accountId,
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
