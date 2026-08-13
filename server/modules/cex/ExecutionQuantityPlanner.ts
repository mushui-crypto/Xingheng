import type { Asset } from "./Asset";
import { createAssetQuantity, type AssetQuantity } from "./AssetQuantity";
import type { TradingRules } from "./TradingRules";

export type ExecutionQuantityInput =
  | Readonly<{
      mode: "NOTIONAL_USDT";
      amountUsdt: string;
    }>
  | Readonly<{
      mode: "ASSET_QUANTITY";
      quantity: string;
    }>;

export type ExecutionQuantityPlanningInstrument = Readonly<{
  instrumentId: string;
  providerSymbol: string;
  baseAsset: Asset;
  quoteAsset: string;
  settlementAsset?: string;
  marketType: "spot" | "perpetual";
  contractType: "spot" | "linear_perpetual" | "inverse_perpetual";
  quantityUnit: "base" | "contract";
  status: "trading" | "close_only" | "paused" | "delisted" | "unknown";
}>;

export type ExecutionQuantityDecimalQuote = Readonly<{
  bid: string;
  ask: string;
  fetchedAt: number;
}>;

export type ExecutionQuantityPlanRequest = Readonly<{
  instrumentId: string;
  side: "buy" | "sell";
  quantityInput: ExecutionQuantityInput;
  quote: ExecutionQuantityDecimalQuote;
}>;

export type ExecutionQuantityPlan = Readonly<{
  instrumentId: string;
  providerSymbol: string;
  baseAsset: string;
  quantityInput: ExecutionQuantityInput;
  sizingPrice: string;
  plannedAssetQuantity: AssetQuantity;
  plannedVenueQuantity?: string;
  estimatedNotionalUsdt: string;
  generatedAt: number;
}>;

export type ExecutionQuantityPlannerErrorCode =
  | "INVALID_NOTIONAL_USDT"
  | "INVALID_ASSET_QUANTITY"
  | "INSTRUMENT_NOT_FOUND"
  | "INSTRUMENT_RESOLUTION_FAILED"
  | "INSTRUMENT_INVALID"
  | "INSTRUMENT_NOT_TRADING"
  | "INSTRUMENT_NOT_USDT_QUOTED"
  | "TRADING_RULES_UNAVAILABLE"
  | "QUOTE_INVALID"
  | "QUOTE_STALE"
  | "CONTRACT_SIZE_REQUIRED"
  | "QUANTITY_ROUNDED_TO_ZERO"
  | "QUANTITY_STEP_MISMATCH"
  | "QUANTITY_BELOW_MINIMUM"
  | "NOTIONAL_BELOW_MINIMUM"
  | "BUDGET_EXCEEDED";

export type ExecutionQuantityPlannerError = Readonly<{
  code: ExecutionQuantityPlannerErrorCode;
  message: string;
  nearestLegalAssetQuantity?: string;
  minimumRequiredAssetQuantity?: string;
  minimumRequiredVenueQuantity?: string;
  minimumRequiredNotionalUsdt?: string;
}>;

export type ExecutionQuantityPlannerResult =
  | Readonly<{ ok: true; plan: ExecutionQuantityPlan }>
  | Readonly<{ ok: false; error: ExecutionQuantityPlannerError }>;

export interface ExecutionQuantityInstrumentResolver {
  resolve(instrumentId: string): Promise<ExecutionQuantityPlanningInstrument | null>;
}

export interface ExecutionQuantityTradingRulesSource {
  getTradingRules(instrument: ExecutionQuantityPlanningInstrument): Promise<TradingRules>;
}

export type ExecutionQuantityPlannerOptions = Readonly<{
  now?: () => number;
  maxQuoteAgeMs?: number;
}>;

export class ExecutionQuantityPlanner {
  private readonly now: () => number;
  private readonly maxQuoteAgeMs: number;

  constructor(
    private readonly instruments: ExecutionQuantityInstrumentResolver,
    private readonly rulesSource: ExecutionQuantityTradingRulesSource,
    options: ExecutionQuantityPlannerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxQuoteAgeMs) || this.maxQuoteAgeMs <= 0) {
      throw new Error("maxQuoteAgeMs must be a positive safe integer.");
    }
  }

  async plan(request: ExecutionQuantityPlanRequest): Promise<ExecutionQuantityPlannerResult> {
    const input = normalizeQuantityInput(request.quantityInput);
    if (!input.ok) return input;

    let instrument: ExecutionQuantityPlanningInstrument | null;
    try {
      instrument = await this.instruments.resolve(request.instrumentId);
    } catch {
      return failure("INSTRUMENT_RESOLUTION_FAILED", "Instrument resolution failed.");
    }
    if (!instrument) return failure("INSTRUMENT_NOT_FOUND", "Instrument was not found.");
    if (!validInstrument(instrument, request.instrumentId)) {
      return failure("INSTRUMENT_INVALID", "Resolved instrument identity is invalid.");
    }
    if (instrument.status !== "trading") {
      return failure("INSTRUMENT_NOT_TRADING", "Instrument is not currently trading.");
    }
    if (!eligibleUsdtInstrument(instrument)) {
      return failure("INSTRUMENT_NOT_USDT_QUOTED", "Quantity planning currently supports only USDT Spot and USDT-settled linear perpetual instruments.");
    }

    const generatedAt = this.now();
    const quote = normalizeQuote(request.quote, generatedAt, this.maxQuoteAgeMs);
    if (!quote.ok) return quote;
    const sizingPrice = request.side === "buy" ? quote.ask : quote.bid;

    let rules: TradingRules;
    try {
      rules = await this.rulesSource.getTradingRules(instrument);
    } catch {
      return failure("TRADING_RULES_UNAVAILABLE", "Trading rules are unavailable.");
    }

    const venueStep = effectiveVenueStep(rules);
    const contractSize = instrument.quantityUnit === "contract"
      ? parsePositiveDecimal(rules.contractSize)
      : ONE;
    if (!contractSize) {
      return failure("CONTRACT_SIZE_REQUIRED", "A positive contractSize is required for contract quantity planning.");
    }
    const baseQuantum = multiply(venueStep, contractSize);
    const minimum = minimumLegalPlan(rules, sizingPrice, baseQuantum, venueStep);

    const planned = input.value.mode === "NOTIONAL_USDT"
      ? planFromNotional(input.value.amountUsdt, sizingPrice, baseQuantum, venueStep, minimum)
      : planFromAssetQuantity(input.value.quantity, baseQuantum, venueStep);
    if (!planned.ok) return planned;

    const estimatedQuoteNotional = multiply(planned.assetQuantity, sizingPrice);
    if (input.value.mode === "NOTIONAL_USDT"
      && compare(estimatedQuoteNotional, parsePositiveDecimal(input.value.amountUsdt)!) > 0) {
      return failure("BUDGET_EXCEEDED", "Planned notional exceeds the user budget.");
    }

    // TradingRules quantityStep/minQuantity are always expressed in the venue's
    // order quantity unit: base asset units for `base`, contract counts for `contract`.
    if (compare(planned.venueQuantity, parsePositiveDecimal(rules.minQuantity)!) < 0) {
      return failureWithMinimum(
        "QUANTITY_BELOW_MINIMUM",
        "Planned quantity is below the venue minimum quantity.",
        minimum,
      );
    }
    if (rules.minNotional !== undefined
      && compare(estimatedQuoteNotional, parsePositiveDecimal(rules.minNotional)!) < 0) {
      return failureWithMinimum(
        "NOTIONAL_BELOW_MINIMUM",
        "Planned notional is below the venue minimum notional.",
        minimum,
      );
    }

    const plannedAssetQuantity = createAssetQuantity({
      asset: instrument.baseAsset,
      quantity: format(planned.assetQuantity),
    });
    const normalizedInput = freezeQuantityInput(input.value);
    return Object.freeze({
      ok: true,
      plan: Object.freeze({
        instrumentId: instrument.instrumentId,
        providerSymbol: instrument.providerSymbol,
        baseAsset: instrument.baseAsset.symbol,
        quantityInput: normalizedInput,
        sizingPrice: format(sizingPrice),
        plannedAssetQuantity,
        ...(instrument.quantityUnit === "contract"
          ? { plannedVenueQuantity: format(planned.venueQuantity) }
          : {}),
        estimatedNotionalUsdt: format(estimatedQuoteNotional),
        generatedAt,
      }),
    });
  }
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;
type NormalizedInputResult =
  | Readonly<{ ok: true; value: ExecutionQuantityInput }>
  | Readonly<{ ok: false; error: ExecutionQuantityPlannerError }>;
type QuoteResult =
  | Readonly<{ ok: true; bid: Decimal; ask: Decimal }>
  | Readonly<{ ok: false; error: ExecutionQuantityPlannerError }>;
type PlannedQuantityResult =
  | Readonly<{ ok: true; assetQuantity: Decimal; venueQuantity: Decimal }>
  | Readonly<{ ok: false; error: ExecutionQuantityPlannerError }>;
type MinimumLegalPlan = Readonly<{
  assetQuantity: Decimal;
  venueQuantity: Decimal;
  notionalUsdt: Decimal;
}>;

const ONE: Decimal = Object.freeze({ coefficient: 1n, scale: 0 });

function normalizeQuantityInput(input: ExecutionQuantityInput): NormalizedInputResult {
  if (!input || typeof input !== "object") {
    return failure("INVALID_ASSET_QUANTITY", "Quantity input is invalid.");
  }
  if (input.mode === "NOTIONAL_USDT") {
    const amount = parsePositiveDecimal(input.amountUsdt);
    if (!amount) return failure("INVALID_NOTIONAL_USDT", "amountUsdt must be a positive decimal string.");
    return Object.freeze({ ok: true, value: Object.freeze({ mode: input.mode, amountUsdt: format(amount) }) });
  }
  if (input.mode === "ASSET_QUANTITY") {
    const quantity = parsePositiveDecimal(input.quantity);
    if (!quantity) return failure("INVALID_ASSET_QUANTITY", "quantity must be a positive decimal string.");
    return Object.freeze({ ok: true, value: Object.freeze({ mode: input.mode, quantity: format(quantity) }) });
  }
  return failure("INVALID_ASSET_QUANTITY", "Quantity input mode is invalid.");
}

function normalizeQuote(
  quote: ExecutionQuantityDecimalQuote,
  generatedAt: number,
  maxQuoteAgeMs: number,
): QuoteResult {
  const bid = parsePositiveDecimal(quote?.bid);
  const ask = parsePositiveDecimal(quote?.ask);
  if (!bid || !ask || !Number.isSafeInteger(quote?.fetchedAt) || quote.fetchedAt < 0 || quote.fetchedAt > generatedAt) {
    return failure("QUOTE_INVALID", "Quote must contain positive decimal bid/ask values and a valid fetchedAt timestamp.");
  }
  if (generatedAt - quote.fetchedAt > maxQuoteAgeMs) {
    return failure("QUOTE_STALE", "Quote is stale.");
  }
  return Object.freeze({ ok: true, bid, ask });
}

function validInstrument(instrument: ExecutionQuantityPlanningInstrument, expectedId: string) {
  const parts = instrument.instrumentId.split("-");
  const expectedMarketType = parts[2] === "SPOT" ? "spot" : "perpetual";
  const contractTypeMatches = expectedMarketType === "spot"
    ? instrument.contractType === "spot"
    : instrument.contractType === "linear_perpetual" || instrument.contractType === "inverse_perpetual";
  return instrument.instrumentId === expectedId
    && /^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(instrument.instrumentId)
    && instrument.baseAsset.symbol === parts[0]
    && instrument.quoteAsset === parts[1]
    && instrument.marketType === expectedMarketType
    && contractTypeMatches
    && Boolean(instrument.providerSymbol.trim());
}

function eligibleUsdtInstrument(instrument: ExecutionQuantityPlanningInstrument) {
  if (instrument.marketType === "spot") {
    return instrument.contractType === "spot" && instrument.quoteAsset === "USDT";
  }
  return instrument.contractType === "linear_perpetual"
    && instrument.quoteAsset === "USDT"
    && instrument.settlementAsset === "USDT";
}

function effectiveVenueStep(rules: TradingRules) {
  const step = parsePositiveDecimal(rules.quantityStep)!;
  if (rules.precision.quantity === undefined) return step;
  const precisionStep: Decimal = rules.precision.quantity === 0
    ? ONE
    : Object.freeze({ coefficient: 1n, scale: rules.precision.quantity });
  return decimalLcm(step, precisionStep);
}

function planFromNotional(
  amountUsdtValue: string,
  sizingPrice: Decimal,
  baseQuantum: Decimal,
  venueStep: Decimal,
  minimum: MinimumLegalPlan,
): PlannedQuantityResult {
  const amountUsdt = parsePositiveDecimal(amountUsdtValue)!;
  const stepCount = floorRatio(amountUsdt, multiply(sizingPrice, baseQuantum));
  if (stepCount === 0n) {
    return failure(
      "QUANTITY_ROUNDED_TO_ZERO",
      "Notional produces zero quantity after venue step alignment.",
      minimumDetails(minimum),
    );
  }
  return Object.freeze({
    ok: true,
    assetQuantity: multiplyInteger(baseQuantum, stepCount),
    venueQuantity: multiplyInteger(venueStep, stepCount),
  });
}

function planFromAssetQuantity(
  quantityValue: string,
  baseQuantum: Decimal,
  venueStep: Decimal,
): PlannedQuantityResult {
  const quantity = parsePositiveDecimal(quantityValue)!;
  const stepCount = floorRatio(quantity, baseQuantum);
  if (stepCount === 0n) {
    return failure("QUANTITY_ROUNDED_TO_ZERO", "Asset quantity becomes zero after venue step alignment.");
  }
  const aligned = multiplyInteger(baseQuantum, stepCount);
  if (compare(aligned, quantity) !== 0) {
    return failure(
      "QUANTITY_STEP_MISMATCH",
      "Asset quantity does not align with the venue quantity step.",
      { nearestLegalAssetQuantity: format(aligned) },
    );
  }
  return Object.freeze({
    ok: true,
    assetQuantity: aligned,
    venueQuantity: multiplyInteger(venueStep, stepCount),
  });
}

function minimumLegalPlan(
  rules: TradingRules,
  sizingPrice: Decimal,
  baseQuantum: Decimal,
  venueStep: Decimal,
): MinimumLegalPlan {
  const minQuantity = parsePositiveDecimal(rules.minQuantity)!;
  let stepCount = ceilRatio(minQuantity, venueStep);
  if (rules.minNotional !== undefined) {
    const minNotional = parsePositiveDecimal(rules.minNotional)!;
    const byNotional = ceilRatio(minNotional, multiply(sizingPrice, baseQuantum));
    if (byNotional > stepCount) stepCount = byNotional;
  }
  if (stepCount < 1n) stepCount = 1n;
  const assetQuantity = multiplyInteger(baseQuantum, stepCount);
  const venueQuantity = multiplyInteger(venueStep, stepCount);
  return Object.freeze({
    assetQuantity,
    venueQuantity,
    notionalUsdt: multiply(assetQuantity, sizingPrice),
  });
}

function failureWithMinimum(
  code: "QUANTITY_BELOW_MINIMUM" | "NOTIONAL_BELOW_MINIMUM",
  message: string,
  minimum: MinimumLegalPlan,
): ExecutionQuantityPlannerResult {
  return failure(code, message, minimumDetails(minimum));
}

function minimumDetails(minimum: MinimumLegalPlan): Omit<ExecutionQuantityPlannerError, "code" | "message"> {
  return {
    minimumRequiredAssetQuantity: format(minimum.assetQuantity),
    minimumRequiredVenueQuantity: format(minimum.venueQuantity),
    minimumRequiredNotionalUsdt: format(minimum.notionalUsdt),
  };
}

function failure(
  code: ExecutionQuantityPlannerErrorCode,
  message: string,
  details: Omit<ExecutionQuantityPlannerError, "code" | "message"> = {},
): Readonly<{ ok: false; error: ExecutionQuantityPlannerError }> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message, ...details }) });
}

function freezeQuantityInput(input: ExecutionQuantityInput): ExecutionQuantityInput {
  return input.mode === "NOTIONAL_USDT"
    ? Object.freeze({ mode: input.mode, amountUsdt: input.amountUsdt })
    : Object.freeze({ mode: input.mode, quantity: input.quantity });
}

function parsePositiveDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const coefficient = BigInt(`${integer}${normalizedFraction}`);
  if (coefficient <= 0n) return null;
  return Object.freeze({ coefficient, scale: normalizedFraction.length });
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

function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * powerOfTen(scale - left.scale);
  const rightValue = right.coefficient * powerOfTen(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return normalize(Object.freeze({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  }));
}

function multiplyInteger(value: Decimal, multiplier: bigint): Decimal {
  return normalize(Object.freeze({ coefficient: value.coefficient * multiplier, scale: value.scale }));
}

function floorRatio(numerator: Decimal, denominator: Decimal) {
  return (numerator.coefficient * powerOfTen(denominator.scale))
    / (denominator.coefficient * powerOfTen(numerator.scale));
}

function ceilRatio(numerator: Decimal, denominator: Decimal) {
  const dividend = numerator.coefficient * powerOfTen(denominator.scale);
  const divisor = denominator.coefficient * powerOfTen(numerator.scale);
  return (dividend + divisor - 1n) / divisor;
}

function decimalLcm(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const leftInt = left.coefficient * powerOfTen(scale - left.scale);
  const rightInt = right.coefficient * powerOfTen(scale - right.scale);
  return normalize(Object.freeze({ coefficient: lcm(leftInt, rightInt), scale }));
}

function lcm(left: bigint, right: bigint) {
  return (left / gcd(left, right)) * right;
}

function gcd(left: bigint, right: bigint) {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function powerOfTen(exponent: number) {
  return 10n ** BigInt(exponent);
}
