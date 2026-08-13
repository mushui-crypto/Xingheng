import { createHash } from "node:crypto";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionStatus } from "../cex/ExecutionState";
import type { BinanceGenericExecutionContext } from "./BinanceGenericExecutionReadContext";
import type { BinanceProviderMutationGuard } from "./BinanceOrderManager";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";
import { toBinanceExecutionPriceMode } from "./BinanceExecutionPolicy";

export type BinanceIntentExecutionServiceBinding = Pick<
  BinancePersonalTradingService,
  "loadExecutionReadContext" | "placeExecutionOrder"
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
  symbol: string;
  side: "Buy" | "Sell";
  quantity: string;
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
    const context = await this.service.loadExecutionReadContext(intent.instrumentId);
    assertExecutionContext(intent, context);
    const category = context.instrument.marketType === "spot" ? "spot" : "linear";
    const side = intent.side === "buy" ? "Buy" : "Sell";
    const quantity = decimalQuantity(intent.quantity.quantity);
    const referencePrice = positiveDecimalNumber(side === "Buy" ? context.quote.ask : context.quote.bid, "quote");
    const priceTick = positiveDecimalNumber(context.tradingRules.priceTick, "priceTick");
    const multiplier = 1 + (side === "Buy" ? 1 : -1) * this.config.maxSlippageBps / 10_000;
    const unroundedPrice = referencePrice * multiplier;
    const limitPrice = side === "Buy"
      ? ceilStep(unroundedPrice, priceTick)
      : floorStep(unroundedPrice, priceTick);

    return Object.freeze({
      idempotencyKey: binanceExecutionIdempotencyKeyFor(intent),
      category,
      symbol: context.instrument.providerSymbol,
      side,
      quantity,
      limitPrice,
      executionPriceMode: toBinanceExecutionPriceMode(intent.executionMode),
      reduceOnly: intent.orderConstraints.reduceOnly,
    });
  }
}

function assertExecutionContext(intent: ExecutionIntent, context: BinanceGenericExecutionContext) {
  if (context.instrument.instrumentId !== intent.instrumentId) {
    throw new Error("Binance execution context instrument identity does not match the intent.");
  }
  if (intent.quantity.asset.symbol !== context.instrument.baseAsset.symbol
    || intent.quantity.asset.type !== context.instrument.baseAsset.type) {
    throw new Error("Binance intent quantity asset does not match the canonical instrument base asset.");
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

function decimalQuantity(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new Error("Binance intent quantity must be an unsigned decimal string.");
  }
  return value;
}

function positiveDecimalNumber(value: string, name: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`Binance ${name} must be positive.`);
  return result;
}

function ceilStep(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

function floorStep(value: number, step: number) {
  return Math.floor(value / step) * step;
}

export type { BinanceProviderMutationGuard };
