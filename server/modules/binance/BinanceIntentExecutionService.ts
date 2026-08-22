import { createHash } from "node:crypto";
import { runExecutionPreMutationPhase } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionStatus } from "../cex/ExecutionState";
import type { BinanceGenericExecutionContext } from "./BinanceGenericExecutionReadContext";
import type { BinanceProviderMutationGuard } from "./BinanceOrderManager";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { binanceFilledBaseQuantity, type BinanceGenericRiskContext, type BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";
import { toBinanceExecutionPriceMode } from "./BinanceExecutionPolicy";

export type BinanceIntentExecutionServiceBinding = Pick<
  BinancePersonalTradingService,
  "loadExecutionReadContext" | "placeExecutionOrder"
> & Readonly<{ readExecutionPositionMode?: () => Promise<"ONE_WAY" | "HEDGE"> }>;

export type BinanceIntentExecutionResult = Readonly<{
  executionAttemptId: string;
  providerOrderId?: string;
  clientOrderId?: string;
  state: ExecutionStatus;
  confirmedQuantity?: string;
}>;

type BinanceIntentPreparedOrderBase = Readonly<{
  idempotencyKey: string;
  category: "spot" | "linear";
  symbol: string;
  side: "Buy" | "Sell";
  quantity: string;
  reduceOnly: boolean;
  positionDirection?: "LONG" | "SHORT";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  positionMode?: "ONE_WAY" | "HEDGE";
}>;

type BinanceIntentPreparedOrder = BinanceIntentPreparedOrderBase & (
  | Readonly<{ executionPriceMode: "IOC_LIMIT"; limitPrice: string }>
  | Readonly<{ executionPriceMode: "MARKET"; limitPrice?: never }>
);

type BinanceLegacyRiskPreparedOrder = Omit<BinanceIntentPreparedOrderBase, "limitPrice"> & Readonly<{
  executionPriceMode: "IOC_LIMIT" | "MARKET";
  limitPrice: number;
}>;

export class BinanceIntentExecutionService<TResult extends BinanceIntentExecutionResult = BinanceIntentExecutionResult> {
  constructor(
    private readonly service: BinanceIntentExecutionServiceBinding,
    private readonly config: Pick<BinanceTradingConfig, "maxSlippageBps">,
    private readonly assertSubmitAllowed: ((
      prepared: BinanceLegacyRiskPreparedOrder,
    ) => void | Promise<void>) | undefined = undefined,
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
    const prepared = await runExecutionPreMutationPhase(() => this.prepare(intent));
    const order = await this.service.placeExecutionOrder(
      prepared.order,
      this.assertSubmitAllowed
        ? (riskValuationPrice) => this.assertSubmitAllowed!({
            ...prepared.order,
            limitPrice: riskValuationPrice,
          })
        : undefined,
      prepared.riskContext,
      this.assertSubmitAllowed ? "legacy" : "generic",
    );
    return this.mapResult(Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: order.orderId,
      clientOrderId: order.orderLinkId,
      state: stateForOrder(order),
      confirmedQuantity: binanceFilledBaseQuantity(order),
    }));
  }

  private async prepare(intent: ExecutionIntent): Promise<Readonly<{
    order: BinanceIntentPreparedOrder;
    riskContext: BinanceGenericRiskContext;
  }>> {
    const context = await this.service.loadExecutionReadContext(intent.instrumentId);
    assertExecutionContext(intent, context);
    const category = context.instrument.marketType === "spot" ? "spot" : "linear";
    const side = intent.side === "buy" ? "Buy" : "Sell";
    const quantity = decimalQuantity(intent.quantity.quantity);
    const executionPriceMode = toBinanceExecutionPriceMode(intent.executionMode);
    const positionMode = category === "linear"
      ? await this.service.readExecutionPositionMode?.() ?? "ONE_WAY"
      : undefined;
    if (category === "linear" && positionMode === "HEDGE" && intent.positionDirection === undefined) {
      throw new Error("Binance HEDGE execution requires positionDirection.");
    }
    const limitPrice = executionPriceMode === "IOC_LIMIT"
      ? protectionPrice({
        referencePrice: side === "Buy" ? context.quote.ask : context.quote.bid,
        priceTick: context.tradingRules.priceTick,
        maxSlippageBps: this.config.maxSlippageBps,
        side,
      })
      : undefined;

    const base = {
      idempotencyKey: binanceExecutionIdempotencyKeyFor(intent),
      category,
      symbol: context.instrument.providerSymbol,
      side,
      quantity,
      reduceOnly: intent.orderConstraints.reduceOnly,
      ...(category === "linear" && intent.positionDirection !== undefined
        ? { positionDirection: intent.positionDirection }
        : {}),
      ...(category === "linear" && positionMode === "HEDGE"
        ? { positionSide: intent.positionDirection === "LONG" ? "LONG" as const : "SHORT" as const }
        : {}),
    } as const;
    const rawOrder = executionPriceMode === "MARKET"
      ? { ...base, executionPriceMode }
      : { ...base, executionPriceMode, limitPrice: limitPrice! };
    const order = attachPositionMode(rawOrder, positionMode);
    return Object.freeze({
      order,
      riskContext: Object.freeze({
        userId: intent.userId,
        accountId: intent.accountId,
        instrumentId: context.instrument.instrumentId,
        category,
        providerSymbol: context.instrument.providerSymbol,
        baseAsset: context.instrument.baseAsset.symbol,
        instrumentStatus: context.instrument.status,
        valuationPrice: executionPriceMode === "IOC_LIMIT"
          ? limitPrice!
          : side === "Buy" ? context.quote.ask : context.quote.bid,
        quoteFetchedAt: context.quote.fetchedAt,
      }),
    });
  }
}

function attachPositionMode<T extends object>(order: T, mode: "ONE_WAY" | "HEDGE" | undefined): T & { positionMode?: "ONE_WAY" | "HEDGE" } {
  if (mode !== undefined) Object.defineProperty(order, "positionMode", { value: mode, enumerable: false, writable: false });
  return Object.freeze(order) as T & { positionMode?: "ONE_WAY" | "HEDGE" };
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
  intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId" | "positionDirection">,
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

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function protectionPrice(input: Readonly<{
  referencePrice: string;
  priceTick: string;
  maxSlippageBps: number;
  side: "Buy" | "Sell";
}>) {
  const referencePrice = positiveDecimal(input.referencePrice, "quote");
  const priceTick = positiveDecimal(input.priceTick, "priceTick");
  const slippageBps = nonNegativeDecimal(String(input.maxSlippageBps), "maxSlippageBps");
  const basisPoints = decimal("10000");
  const factor = input.side === "Buy"
    ? add(basisPoints, slippageBps)
    : subtractPositive(basisPoints, slippageBps, "maxSlippageBps must be less than 10000 for Sell orders.");
  const numerator = multiply(referencePrice, factor);
  const denominator = multiply(priceTick, basisPoints);
  const tickCount = input.side === "Buy"
    ? ceilRatio(numerator, denominator)
    : floorRatio(numerator, denominator);
  if (tickCount <= 0n) throw new Error("Binance protection price must be positive.");
  return format(multiplyInteger(priceTick, tickCount));
}

function positiveDecimal(value: string, name: string) {
  const parsed = decimal(value);
  if (parsed.coefficient <= 0n) throw new Error(`Binance ${name} must be positive.`);
  return parsed;
}

function nonNegativeDecimal(value: string, name: string) {
  const parsed = decimal(value);
  if (parsed.coefficient < 0n) throw new Error(`Binance ${name} must be non-negative.`);
  return parsed;
}

function decimal(value: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error("Binance Decimal value is invalid.");
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalize({ coefficient: BigInt(`${integer}${normalizedFraction}`), scale: normalizedFraction.length });
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return normalize({
    coefficient: left.coefficient * powerOfTen(scale - left.scale)
      + right.coefficient * powerOfTen(scale - right.scale),
    scale,
  });
}

function subtractPositive(left: Decimal, right: Decimal, message: string): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const coefficient = left.coefficient * powerOfTen(scale - left.scale)
    - right.coefficient * powerOfTen(scale - right.scale);
  if (coefficient <= 0n) throw new Error(message);
  return normalize({ coefficient, scale });
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return normalize({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

function multiplyInteger(value: Decimal, multiplier: bigint): Decimal {
  return normalize({ coefficient: value.coefficient * multiplier, scale: value.scale });
}

function floorRatio(numerator: Decimal, denominator: Decimal) {
  return numerator.coefficient * powerOfTen(denominator.scale)
    / (denominator.coefficient * powerOfTen(numerator.scale));
}

function ceilRatio(numerator: Decimal, denominator: Decimal) {
  const dividend = numerator.coefficient * powerOfTen(denominator.scale);
  const divisor = denominator.coefficient * powerOfTen(numerator.scale);
  return (dividend + divisor - 1n) / divisor;
}

function format(value: Decimal) {
  const normalized = normalize(value);
  if (normalized.scale === 0) return normalized.coefficient.toString();
  const raw = normalized.coefficient.toString().padStart(normalized.scale + 1, "0");
  return `${raw.slice(0, -normalized.scale)}.${raw.slice(-normalized.scale)}`;
}

function normalize(value: Decimal): Decimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return Object.freeze({ coefficient, scale });
}

function powerOfTen(exponent: number) {
  return 10n ** BigInt(exponent);
}

export type { BinanceProviderMutationGuard };
