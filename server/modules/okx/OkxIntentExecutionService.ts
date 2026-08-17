import { createHash } from "node:crypto";
import {
  createExecutionCancelObservation,
  type ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionStatus } from "../cex/ExecutionState";
import {
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
  type ExecutionProviderIdentityValidator,
} from "../cex/ExecutionMutationSafetyGuard";
import {
  OkxInstrumentMappingAdapter,
  type OkxInstrumentResolution,
} from "./OkxInstrumentMapping";
import {
  loadOkxQuantityRules,
  OKX_QUANTITY_RULES_MAX_AGE_MS,
  okxBaseQuantityToContracts,
  okxContractQuantityToBase,
  type OkxQuantityRulesSource,
} from "./OkxQuantitySemantics";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxOrderIdentity,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

export type OkxIntentExecutionClient = Readonly<{
  placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult>;
  getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder>;
  cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult>;
}>;

export type OkxLimitPriceResolver = (
  intent: ExecutionIntent,
  instrument: OkxInstrumentResolution,
) => Promise<string> | string;

export type OkxIntentExecutionServiceOptions = Readonly<{
  tdMode?: "cross" | "isolated";
  instrumentMapping?: OkxInstrumentMappingAdapter;
  limitPriceResolver?: OkxLimitPriceResolver;
  quantityRulesSource?: OkxQuantityRulesSource;
  quantityRulesMaxAgeMs?: number;
  clock?: () => number;
  mutationSafetyGuard?: ExecutionMutationSafetyGuard;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  persistRecoveryReference?: (
    reference: Readonly<{ instId: string; clOrdId: string }>,
  ) => Promise<void> | void;
}>;

export type OkxExecutionOrderIdentity = Readonly<OkxOrderIdentity>;

export type OkxIntentExecutionResult = Readonly<{
  executionAttemptId: string;
  providerOrderId: string;
  clientOrderId: string;
  instId: string;
  orderIdentity: OkxExecutionOrderIdentity;
  state: ExecutionStatus;
  confirmedQuantity: string;
  statusReason: string | null;
  expectedProviderQuantity?: string;
  expectedSide?: "buy" | "sell";
}>;

export type OkxExecutionQueryResult = Readonly<{
  observation: ExecutionQueryObservation;
  orderIdentity: OkxExecutionOrderIdentity;
  fee: string;
  statusReason: string | null;
}>;

export type OkxExecutionOrderLookup = Readonly<{
  instrumentId: string;
  instId: string;
  ordId?: string;
  clOrdId: string;
  expectedProviderQuantity?: string;
  expectedSide?: "buy" | "sell";
}>;

export class OkxIntentExecutionService {
  private readonly tdMode: "cross" | "isolated";
  private readonly instrumentMapping: OkxInstrumentMappingAdapter;
  private readonly clock: () => number;
  private readonly mutationSafetyGuard: ExecutionMutationSafetyGuard;

  constructor(
    private readonly client: OkxIntentExecutionClient,
    private readonly options: OkxIntentExecutionServiceOptions = {},
  ) {
    this.tdMode = options.tdMode ?? "cross";
    this.instrumentMapping = options.instrumentMapping ?? new OkxInstrumentMappingAdapter();
    this.clock = options.clock ?? Date.now;
    this.mutationSafetyGuard = options.mutationSafetyGuard ?? new ExecutionMutationSafetyGuard();
  }

  async execute(intent: ExecutionIntent): Promise<OkxIntentExecutionResult> {
    if (intent.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }
    const prepared = await this.prepare(intent);
    await this.mutationSafetyGuard.assertAllowed({
      venue: intent.venue,
      operation: "placeOrder",
      userId: intent.userId,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      providerInstrumentId: prepared.instId,
    }, this.options.validateProviderIdentity);
    await this.options.persistRecoveryReference?.({
      instId: prepared.instId,
      clOrdId: prepared.clOrdId,
    });
    const accepted = await this.client.placeOrder(prepared);
    assertAcceptedIdentity(accepted, prepared);
    return Object.freeze({
      executionAttemptId: intent.intentId,
      providerOrderId: accepted.ordId,
      clientOrderId: accepted.clOrdId,
      instId: accepted.instId,
      orderIdentity: Object.freeze({
        instId: accepted.instId,
        ordId: accepted.ordId,
        clOrdId: accepted.clOrdId,
      }),
      state: "SUBMITTED",
      confirmedQuantity: "0",
      statusReason: null,
    });
  }

  async query(lookup: OkxExecutionOrderLookup): Promise<OkxExecutionQueryResult> {
    const instrument = this.instrumentMapping.resolve(lookup.instrumentId);
    if (instrument.venueInstrument.instId !== lookup.instId) {
      throw new Error("OKX order lookup instrument identity does not match the mapped instrument.");
    }
    const observedAt = this.now();
    const rules = await loadOkxQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      observedAt,
      this.options.quantityRulesMaxAgeMs ?? OKX_QUANTITY_RULES_MAX_AGE_MS,
    );
    const order = await this.client.getOrder({
      instId: lookup.instId,
      ...(lookup.ordId === undefined ? {} : { ordId: lookup.ordId }),
      clOrdId: lookup.clOrdId,
    });
    if (order.instId !== lookup.instId) {
      throw new Error("OKX order response instrument identity does not match the execution order.");
    }
    return Object.freeze({
      observation: observationForOrder(order, rules, observedAt),
      orderIdentity: Object.freeze({
        instId: order.instId,
        ordId: order.ordId,
        clOrdId: order.clOrdId,
      }),
      fee: order.fee,
      statusReason: order.statusReason,
    });
  }

  async cancel(
    lookup: OkxExecutionOrderLookup,
    context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & {
      providerInstrumentId?: string;
    },
  ): Promise<ExecutionCancelObservation> {
    await this.mutationSafetyGuard.assertAllowed({
      venue: "okx",
      operation: "cancelOrder",
      userId: context.userId,
      accountId: context.accountId,
      instrumentId: context.instrumentId,
      providerInstrumentId: context.providerInstrumentId ?? lookup.instId,
    }, this.options.validateProviderIdentity);
    await this.client.cancelOrder({
      instId: lookup.instId,
      ...(lookup.ordId === undefined ? {} : { ordId: lookup.ordId }),
      clOrdId: lookup.clOrdId,
    });
    return createExecutionCancelObservation({
      state: "CANCEL_REQUESTED",
      observedAt: this.now(),
    });
  }

  resolveLookup(record: ExecutionRecord): OkxExecutionOrderLookup {
    if (record.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    const instrument = this.instrumentMapping.resolve(record.instrumentId);
    return Object.freeze({
      instrumentId: record.instrumentId,
      instId: instrument.venueInstrument.instId,
      ...(record.remoteOrderId === undefined ? {} : { ordId: record.remoteOrderId }),
      clOrdId: okxClientOrderIdFor(record),
    });
  }

  private async prepare(intent: ExecutionIntent): Promise<OkxPlaceOrderRequest> {
    const instrument = this.instrumentMapping.resolve(intent.instrumentId);
    assertIntentMatchesInstrument(intent, instrument);
    const rules = await loadOkxQuantityRules(
      this.options.quantityRulesSource,
      instrument,
      this.now(),
      this.options.quantityRulesMaxAgeMs ?? OKX_QUANTITY_RULES_MAX_AGE_MS,
    );
    const base = {
      instId: instrument.venueInstrument.instId,
      tdMode: this.tdMode,
      side: intent.side,
      quantity: okxBaseQuantityToContracts(intent.quantity.quantity, rules),
      clOrdId: okxClientOrderIdFor(intent),
      reduceOnly: intent.orderConstraints.reduceOnly,
    } as const;
    if (intent.executionMode === "EXECUTION_PRIORITY") {
      return Object.freeze({ ...base, ordType: "market" });
    }
    if (!this.options.limitPriceResolver) {
      throw new Error("OKX PRICE_PRIORITY execution requires an explicit limit price resolver.");
    }
    return Object.freeze({
      ...base,
      ordType: "limit",
      price: decimalQuantity(await this.options.limitPriceResolver(intent, instrument)),
    });
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("OKX execution clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}

export function okxClientOrderIdFor(
  intent: Pick<ExecutionIntent, "userId" | "accountId" | "intentId">,
) {
  const identity = `${intent.userId}\u0000${intent.accountId}\u0000${intent.intentId}`;
  return `sxokx${createHash("sha256").update(identity).digest("hex").slice(0, 27)}`;
}

function assertIntentMatchesInstrument(intent: ExecutionIntent, instrument: OkxInstrumentResolution) {
  if (intent.quantity.asset.symbol !== instrument.canonicalInstrument.baseAsset) {
    throw new Error("OKX intent quantity asset does not match the canonical instrument base asset.");
  }
  if (instrument.canonicalInstrument.contractType !== "perpetual") {
    throw new Error("OKX execution supports USDT linear perpetual instruments only.");
  }
}

function assertAcceptedIdentity(accepted: OkxCancelOrderResult, prepared: OkxPlaceOrderRequest) {
  if (
    accepted.instId !== prepared.instId
    || accepted.clOrdId !== prepared.clOrdId
  ) {
    throw new Error("OKX submit response identity does not match the exact execution order.");
  }
}

function observationForOrder(
  order: OkxProviderOrder,
  rules: Awaited<ReturnType<typeof loadOkxQuantityRules>>,
  observedAt: number,
): ExecutionQueryObservation {
  return createExecutionQueryObservation({
    state: queryStateFor(order.status),
    filledBaseQuantity: okxContractQuantityToBase(order.filledQuantity, rules),
    observedAt: order.updatedAt === null ? observedAt : Math.max(order.updatedAt, observedAt),
  });
}

function queryStateFor(status: OkxProviderOrder["status"]): ExecutionQueryObservation["state"] {
  if (status === "CONFIRMED") return "CONFIRMED";
  if (status === "SUBMITTED" || status === "PENDING_CONFIRMATION") return "PENDING_CONFIRMATION";
  if (status === "FAILED") return "FAILED";
  return "UNKNOWN";
}

function decimalQuantity(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new Error("OKX Decimal quantity or price must be an unsigned positive decimal string.");
  }
  return value;
}
