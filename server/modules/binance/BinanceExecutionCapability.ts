import { createHash } from "node:crypto";
import type {
  FundingArbitrageCancelLegResult,
  FundingArbitrageExecutionAttemptIdentity,
  FundingArbitrageExecutionCapability,
  FundingArbitrageLegExecutionReference,
  FundingArbitrageLegObservation,
  FundingArbitrageSubmitLegRequest,
} from "../cex/funding-arbitrage/FundingArbitrageExecutionCapability";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export type BoundBinanceExecutionService = Pick<
  BinancePersonalTradingService,
  "market" | "placeOrder" | "cancelOrder" | "ordersState" | "reconciliation"
>;

type BinancePreparedExecutionPrice = Readonly<{
  quantityXaut: number;
  limitPrice: number;
}>;

export class BinanceExecutionCapability implements FundingArbitrageExecutionCapability {
  constructor(
    private readonly service: BoundBinanceExecutionService,
    private readonly config: Pick<BinanceTradingConfig, "maxSlippageBps">,
    private readonly clock: () => number = Date.now,
    private readonly assertSubmitAllowed: (
      prepared: BinancePreparedExecutionPrice,
    ) => void | Promise<void> = () => undefined,
  ) {
    if (!Number.isFinite(config.maxSlippageBps) || config.maxSlippageBps < 0) {
      throw new Error("Binance max slippage must be a non-negative number.");
    }
  }

  async submitLeg(
    request: FundingArbitrageSubmitLegRequest,
  ): Promise<FundingArbitrageExecutionAttemptIdentity> {
    const prepared = await this.prepareLeg(request);
    await this.service.placeOrder(prepared, () => this.assertSubmitAllowed(prepared));
    return { executionAttemptId: request.executionAttemptId };
  }

  async queryLegState(
    request: FundingArbitrageLegExecutionReference,
  ): Promise<FundingArbitrageLegObservation> {
    assertReference(request);
    const stored = findAttempt(this.service.ordersState().orders, request);
    return stored
      ? toObservation(request.executionAttemptId, stored, this.clock())
      : unresolvedObservation(request.executionAttemptId, this.clock());
  }

  async cancelLeg(
    request: FundingArbitrageLegExecutionReference,
  ): Promise<FundingArbitrageCancelLegResult> {
    assertReference(request);
    try {
      const result = await this.service.cancelOrder({ idempotencyKey: idempotencyKeyFor(request) });
      return {
        executionAttemptId: request.executionAttemptId,
        result: ["New", "PartiallyFilled", "Cancelled", "Unknown"].includes(result.status)
          ? "CANCEL_REQUESTED"
          : "NO_ACTIVE_EXECUTION",
        observedAt: result.updatedAt,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Binance order was not found.") {
        return {
          executionAttemptId: request.executionAttemptId,
          result: "NO_ACTIVE_EXECUTION",
          observedAt: this.clock(),
        };
      }
      throw error;
    }
  }

  async reconcileLeg(
    request: FundingArbitrageLegExecutionReference,
  ): Promise<FundingArbitrageLegObservation> {
    assertReference(request);
    const result = await this.service.reconciliation();
    const stored = findAttempt(result.orders, request);
    return stored
      ? toObservation(request.executionAttemptId, stored, this.clock())
      : {
        executionAttemptId: request.executionAttemptId,
        observation: "REMOTE_NOT_FOUND",
        confirmedExecutedQuantity: "0",
        observedAt: this.clock(),
      };
  }

  private async prepareLeg(request: FundingArbitrageSubmitLegRequest) {
    assertSubmitRequest(request);
    const category = categoryFor(request.instrumentId, request.marketType);
    const side = request.role === "long" ? "Buy" as const : "Sell" as const;
    const quantityXaut = decimalQuantityToNumber(request.targetDeltaBaseQuantity);
    const market = await this.service.market();
    const instrument = category === "spot" ? market.spot : market.perpetual;
    const multiplier = 1 + (side === "Buy" ? 1 : -1) * this.config.maxSlippageBps / 10_000;
    const unroundedPrice = (side === "Buy" ? instrument.ask : instrument.bid) * multiplier;
    const limitPrice = side === "Buy"
      ? ceilStep(unroundedPrice, instrument.priceTick)
      : floorStep(unroundedPrice, instrument.priceTick);

    return {
      idempotencyKey: idempotencyKeyFor(request),
      category,
      symbol: "XAUTUSDT" as const,
      side,
      quantityXaut,
      limitPrice,
      reduceOnly: false,
    };
  }
}

function categoryFor(instrumentId: string, marketType: string): "spot" | "linear" {
  if (instrumentId === BINANCE_SPOT_INSTRUMENT_ID && marketType === "spot") return "spot";
  if (instrumentId === BINANCE_PERPETUAL_INSTRUMENT_ID && marketType === "perpetual") return "linear";
  throw new Error(`Unsupported Binance execution instrument: ${instrumentId}.`);
}

function findAttempt(
  orders: readonly BinanceStoredOrder[],
  reference: FundingArbitrageLegExecutionReference,
) {
  const idempotencyKey = idempotencyKeyFor(reference);
  return orders.find((order) => order.idempotencyKey === idempotencyKey) ?? null;
}

function toObservation(
  executionAttemptId: string,
  stored: BinanceStoredOrder,
  fallbackObservedAt: number,
): FundingArbitrageLegObservation {
  const order = stored.order;
  if (!order) {
    return stored.status === "processing"
      ? unresolvedObservation(executionAttemptId, stored.updatedAt)
      : {
        executionAttemptId,
        observation: "REMOTE_NOT_FOUND",
        confirmedExecutedQuantity: "0",
        observedAt: stored.updatedAt,
      };
  }
  return {
    executionAttemptId,
    observation: order.status === "New" || order.status === "PartiallyFilled"
      ? "OPEN"
      : order.status === "Filled"
        ? "FILLED"
        : order.status === "Cancelled" || order.status === "Expired"
          ? "CANCELED"
          : order.status === "Rejected"
            ? "REJECTED"
            : "UNKNOWN_REMOTE_STATE",
    confirmedExecutedQuantity: numberToDecimal(order.filledQuantityXaut),
    observedAt: order.updatedAt || stored.updatedAt || fallbackObservedAt,
  };
}

function unresolvedObservation(
  executionAttemptId: string,
  observedAt: number,
): FundingArbitrageLegObservation {
  return {
    executionAttemptId,
    observation: "UNKNOWN_REMOTE_STATE",
    confirmedExecutedQuantity: "0",
    observedAt,
  };
}

function idempotencyKeyFor(reference: Pick<
  FundingArbitrageLegExecutionReference,
  "executionId" | "executionAttemptId" | "legId"
>) {
  assertReference(reference);
  const identity = `${reference.executionId}\u0000${reference.legId}\u0000${reference.executionAttemptId}`;
  return `funding-arbitrage:${createHash("sha256").update(identity).digest("hex")}`;
}

function assertSubmitRequest(request: FundingArbitrageSubmitLegRequest) {
  assertReference(request);
  if (request.venue !== "binance") throw new Error(`Unsupported execution venue: ${request.venue}.`);
  if (request.role !== "long" && request.role !== "short") {
    throw new Error("Binance execution leg role must be long or short.");
  }
}

function assertReference(reference: Pick<
  FundingArbitrageLegExecutionReference,
  "executionId" | "executionAttemptId" | "legId"
>) {
  for (const [name, value] of [
    ["executionId", reference.executionId],
    ["executionAttemptId", reference.executionAttemptId],
    ["legId", reference.legId],
  ] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > 200) {
      throw new Error(`${name} is invalid.`);
    }
  }
}

function decimalQuantityToNumber(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Binance execution quantity must be an unsigned decimal string.");
  }
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Binance execution quantity must be positive and representable.");
  }
  return quantity;
}

function numberToDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Binance confirmed quantity is invalid.");
  const text = String(value);
  if (!/[eE]/u.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer!.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function floorStep(value: number, step: number) {
  assertPriceInputs(value, step);
  return Math.floor((value + 1e-12) / step) * step;
}

function ceilStep(value: number, step: number) {
  assertPriceInputs(value, step);
  return Math.ceil((value - 1e-12) / step) * step;
}

function assertPriceInputs(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0) {
    throw new Error("Binance execution price inputs are invalid.");
  }
}
