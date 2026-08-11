import { createHash } from "node:crypto";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionStatus } from "../cex/ExecutionState";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import type { BinanceProviderMutationGuard } from "./BinanceOrderManager";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";
import { toBinanceExecutionPriceMode } from "./BinanceExecutionPolicy";

export type BinanceIntentExecutionServiceBinding = Pick<
  BinancePersonalTradingService,
  "market" | "placeExecutionOrder"
>;

export type BinanceIntentExecutionResult = Readonly<{
  executionAttemptId: string;
  providerOrderId?: string;
  clientOrderId?: string;
  state: ExecutionStatus;
}>;

type BinanceIntentPreparedOrder = Readonly<{
  idempotencyKey: string;
  category: "spot" | "linear";
  symbol: "XAUTUSDT";
  side: "Buy" | "Sell";
  quantityXaut: number;
  limitPrice: number;
  executionPriceMode: "IOC_LIMIT" | "MARKET";
  reduceOnly: boolean;
}>;

export class BinanceIntentExecutionService<TResult extends BinanceIntentExecutionResult = BinanceIntentExecutionResult> {
  constructor(
    private readonly service: BinanceIntentExecutionServiceBinding,
    private readonly config: Pick<BinanceTradingConfig, "maxSlippageBps">,
    private readonly assertSubmitAllowed: (
      prepared: BinanceIntentPreparedOrder,
    ) => void | Promise<void> = () => undefined,
    private readonly mapResult: (result: BinanceIntentExecutionResult) => TResult = (result) => result as TResult,
    private readonly instrumentResolver: Pick<InstrumentCapability, "resolveVenueInstrument"> = new InstrumentCapability(),
  ) {
    if (!Number.isFinite(config.maxSlippageBps) || config.maxSlippageBps < 0) {
      throw new Error("Binance max slippage must be a non-negative number.");
    }
  }

  async execute(intent: ExecutionIntent): Promise<TResult> {
    if (intent.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }
    const prepared = await this.prepare(intent);
    const order = await this.service.placeExecutionOrder(
      prepared,
      (riskValuationPrice = prepared.limitPrice) => this.assertSubmitAllowed({
        ...prepared,
        limitPrice: riskValuationPrice,
      }),
    );
    return this.mapResult(Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: order.orderId,
      clientOrderId: order.orderLinkId,
      state: stateForOrder(order),
    }));
  }

  private async prepare(intent: ExecutionIntent): Promise<BinanceIntentPreparedOrder> {
    const venueInstrument = this.instrumentResolver.resolveVenueInstrument(
      canonicalInstrumentFromId(intent.instrumentId),
      intent.venue,
    );
    if (venueInstrument.symbol !== "XAUTUSDT"
      || (venueInstrument.category !== "spot" && venueInstrument.category !== "linear")) {
      throw new Error(`Unsupported Binance execution instrument: ${intent.instrumentId}.`);
    }
    const category = venueInstrument.category;
    assertQuantityAsset(intent, category);
    const side = intent.side === "buy" ? "Buy" : "Sell";
    const quantityXaut = decimalQuantityToNumber(intent.quantity.quantity);
    const market = await this.service.market();
    const instrument = category === "spot" ? market.spot : market.perpetual;
    const multiplier = 1 + (side === "Buy" ? 1 : -1) * this.config.maxSlippageBps / 10_000;
    const unroundedPrice = (side === "Buy" ? instrument.ask : instrument.bid) * multiplier;
    const limitPrice = side === "Buy"
      ? ceilStep(unroundedPrice, instrument.priceTick)
      : floorStep(unroundedPrice, instrument.priceTick);

    return Object.freeze({
      idempotencyKey: binanceExecutionIdempotencyKeyFor(intent),
      category,
      symbol: venueInstrument.symbol,
      side,
      quantityXaut,
      limitPrice,
      executionPriceMode: toBinanceExecutionPriceMode(intent.executionMode),
      reduceOnly: intent.orderConstraints.reduceOnly,
    });
  }
}

function assertQuantityAsset(intent: ExecutionIntent, category: "spot" | "linear") {
  if (intent.quantity.asset.symbol !== "XAUT") {
    throw new Error("Binance intent quantity asset must be XAUT.");
  }
  if (category === "linear" && intent.quantity.asset.type !== "RWA_ASSET") {
    throw new Error("Binance XAUT perpetual quantity asset must be an RWA asset.");
  }
}

function stateForOrder(order: BinanceProviderOrder): ExecutionStatus {
  if (order.status === "Filled") return "CONFIRMED";
  if (order.status === "Rejected" || order.status === "Expired" || order.status === "Cancelled") return "FAILED";
  if (order.status === "New" || order.status === "PartiallyFilled") return "PENDING_CONFIRMATION";
  return "UNKNOWN";
}

export function binanceExecutionIdempotencyKeyFor(
  intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId">,
) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}`;
  return `execution-intent:${createHash("sha256").update(identity).digest("hex")}`;
}

function decimalQuantityToNumber(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Binance intent quantity must be an unsigned decimal string.");
  }
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Binance intent quantity must be positive and representable.");
  }
  return quantity;
}

function ceilStep(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

function floorStep(value: number, step: number) {
  return Math.floor(value / step) * step;
}

export type { BinanceProviderMutationGuard };
