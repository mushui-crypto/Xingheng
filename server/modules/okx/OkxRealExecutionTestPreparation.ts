import { createAsset } from "../cex/Asset";
import {
  ExecutionQuantityPlanner,
  type ExecutionQuantityDecimalQuote,
  type ExecutionQuantityInput,
  type ExecutionQuantityPlan,
  type ExecutionQuantityPlanningInstrument,
} from "../cex/ExecutionQuantityPlanner";
import type { ExecutionCapabilityRegistry } from "../cex/ExecutionCapabilityRegistry";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import {
  createExecutionRecordFromIntent,
  type ExecutionRecord,
} from "../cex/ExecutionRecord";
import {
  canonicalInstrumentFromId,
  type CanonicalInstrument,
  type VenueInstrument,
} from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import type { TradingRules } from "../cex/TradingRules";
import type { TradingRulesAdapter } from "../cex/TradingRulesAdapter";
import type {
  OkxAccountIdentity,
  OkxPerpetualPosition,
  OkxProviderOrder,
} from "./OkxTypes";

export type OkxRealExecutionScenarioId =
  | "OKX_SPOT_BUY_PERP_SHORT"
  | "OKX_PERP_LONG"
  | "OKX_PERP_SHORT";

export type OkxRealExecutionLegRole =
  | "SPOT_BUY"
  | "PERPETUAL_LONG"
  | "PERPETUAL_SHORT";

export type OkxRealExecutionPreparationStatus =
  | "READY_FOR_MANUAL_AUTHORIZATION"
  | "BLOCKED_PRECONDITION_FAILED";

export type OkxRealExecutionLegRequest = Readonly<{
  role: OkxRealExecutionLegRole;
  instrumentId: string;
  side: "buy" | "sell";
  quantityInput: ExecutionQuantityInput;
  quote: ExecutionQuantityDecimalQuote;
}>;

export type OkxRealExecutionScenarioRequest = Readonly<{
  scenarioId: OkxRealExecutionScenarioId;
  legs: readonly OkxRealExecutionLegRequest[];
}>;

export type OkxRealExecutionTestPreparationInput = Readonly<{
  userId: string;
  accountId: string;
  scenarios?: readonly OkxRealExecutionScenarioRequest[];
}>;

export type OkxRealExecutionAccountReadiness = Readonly<{
  credentialBinding: "PASS";
  accountIdentity: "PASS";
  account: OkxAccountIdentity;
  providerMutations: 0;
}>;

export type OkxRealExecutionReadinessSource = Readonly<{
  verifyAccount(input: Readonly<{
    userId: string;
    accountId: string;
  }>): Promise<OkxRealExecutionAccountReadiness>;
  readOpenOrders(input: Readonly<{
    userId: string;
    accountId: string;
    instId: string;
  }>): Promise<readonly OkxProviderOrder[]>;
  readPositions(input: Readonly<{
    userId: string;
    accountId: string;
    instId: string;
  }>): Promise<readonly OkxPerpetualPosition[]>;
}>;

export type OkxPreparedExecutionLeg = Readonly<{
  role: OkxRealExecutionLegRole;
  capabilityReadiness: "OKX_EXECUTION_CAPABILITY" | "BLOCKED_UNSUPPORTED_OKX_SPOT_EXECUTION_CAPABILITY";
  checks: Readonly<{
    instrumentResolution: "PASS";
    tradingRules: "PASS";
    quantityConversion: "PASS";
    accountReadiness: "PASS";
    openOrderReadiness: "PASS" | "BLOCKED_OPEN_ORDERS_PRESENT";
    positionReadiness: "PASS" | "NOT_APPLICABLE_SPOT";
    closeReadiness: "PASS" | "NOT_APPLICABLE_SPOT";
  }>;
  canonicalInstrumentId: string;
  venueInstrument: VenueInstrument;
  tradingRules: TradingRules;
  quantityPlan: ExecutionQuantityPlan;
  openOrders: readonly OkxProviderOrder[];
  positions: readonly OkxPerpetualPosition[];
  intentDraft: ExecutionIntent;
  executionRecordDraft: ExecutionRecord;
  closeIntentDraft: ExecutionIntent | null;
  closeExecutionRecordDraft: ExecutionRecord | null;
}>;

export type OkxPreparedExecutionScenario = Readonly<{
  scenarioId: OkxRealExecutionScenarioId;
  status: OkxRealExecutionPreparationStatus;
  blockers: readonly string[];
  legs: readonly OkxPreparedExecutionLeg[];
}>;

export type OkxRealExecutionTestPreparationResult = Readonly<{
  venue: "okx";
  providerMutations: 0;
  authorization: "PENDING_MANUAL_AUTHORIZATION";
  executionPath: readonly [
    "ExecutionIntent",
    "ExecutionCoordinator",
    "ExecutionCapabilityRegistry",
    "OKX ExecutionCapability",
    "ExecutionRecord",
  ];
  accountReadiness: OkxRealExecutionAccountReadiness;
  scenarios: readonly OkxPreparedExecutionScenario[];
}>;

export type OkxRealExecutionTestPreparationOptions = Readonly<{
  instrumentCapability?: InstrumentCapability;
  now?: () => number;
  expiresInMs?: number;
  createIntentId?: (scenarioId: OkxRealExecutionScenarioId, role: OkxRealExecutionLegRole) => string;
  createExecutionId?: (scenarioId: OkxRealExecutionScenarioId, role: OkxRealExecutionLegRole) => string;
}>;

const EXECUTION_PATH = Object.freeze([
  "ExecutionIntent",
  "ExecutionCoordinator",
  "ExecutionCapabilityRegistry",
  "OKX ExecutionCapability",
  "ExecutionRecord",
] as const);

export const DEFAULT_OKX_REAL_EXECUTION_TEST_SCENARIOS = defaultOkxRealExecutionTestScenarios(0);

function defaultOkxRealExecutionTestScenarios(fetchedAt: number) {
  return Object.freeze([
    Object.freeze({
      scenarioId: "OKX_SPOT_BUY_PERP_SHORT",
      legs: Object.freeze([
        leg("SPOT_BUY", "DOGE-USDT-SPOT", "buy", fetchedAt),
        leg("PERPETUAL_SHORT", "DOGE-USDT-PERP", "sell", fetchedAt),
      ]),
    }),
    Object.freeze({
      scenarioId: "OKX_PERP_LONG",
      legs: Object.freeze([
        leg("PERPETUAL_LONG", "DOGE-USDT-PERP", "buy", fetchedAt),
      ]),
    }),
    Object.freeze({
      scenarioId: "OKX_PERP_SHORT",
      legs: Object.freeze([
        leg("PERPETUAL_SHORT", "DOGE-USDT-PERP", "sell", fetchedAt),
      ]),
    }),
  ] satisfies readonly OkxRealExecutionScenarioRequest[]);
}

export class OkxRealExecutionTestPreparation {
  private readonly instrumentCapability: InstrumentCapability;
  private readonly now: () => number;
  private readonly expiresInMs: number;
  private readonly createIntentId: (scenarioId: OkxRealExecutionScenarioId, role: OkxRealExecutionLegRole) => string;
  private readonly createExecutionId: (scenarioId: OkxRealExecutionScenarioId, role: OkxRealExecutionLegRole) => string;

  constructor(
    private readonly capabilityRegistry: Pick<ExecutionCapabilityRegistry<unknown>, "resolve">,
    private readonly readiness: OkxRealExecutionReadinessSource,
    private readonly tradingRules: Pick<TradingRulesAdapter, "getTradingRules">,
    options: OkxRealExecutionTestPreparationOptions = {},
  ) {
    this.instrumentCapability = options.instrumentCapability ?? new InstrumentCapability();
    this.now = options.now ?? Date.now;
    this.expiresInMs = options.expiresInMs ?? 60_000;
    this.createIntentId = options.createIntentId ?? ((scenarioId, role) => `okx-preflight-${scenarioId}-${role}`);
    this.createExecutionId = options.createExecutionId ?? ((scenarioId, role) => `okx-preflight-record-${scenarioId}-${role}`);
  }

  async prepare(input: OkxRealExecutionTestPreparationInput): Promise<OkxRealExecutionTestPreparationResult> {
    const userId = identifier(input.userId, "userId");
    const accountId = identifier(input.accountId, "accountId");
    this.capabilityRegistry.resolve("okx");
    const accountReadiness = await this.readiness.verifyAccount({ userId, accountId });
    if (accountReadiness.account.accountId !== accountId) {
      throw new Error("OKX account readiness identity does not match the preparation request.");
    }

    const scenarios = await Promise.all(
      (input.scenarios ?? defaultOkxRealExecutionTestScenarios(this.timestamp())).map(
        (scenario) => this.prepareScenario(scenario, userId, accountId),
      ),
    );

    return Object.freeze({
      venue: "okx",
      providerMutations: 0,
      authorization: "PENDING_MANUAL_AUTHORIZATION",
      executionPath: EXECUTION_PATH,
      accountReadiness,
      scenarios: Object.freeze(scenarios),
    });
  }

  private async prepareScenario(
    scenario: OkxRealExecutionScenarioRequest,
    userId: string,
    accountId: string,
  ): Promise<OkxPreparedExecutionScenario> {
    const legs = await Promise.all(
      scenario.legs.map((scenarioLeg) => this.prepareLeg(scenario.scenarioId, scenarioLeg, userId, accountId)),
    );
    const blockers = legs.flatMap((prepared) => legBlockers(prepared));
    return Object.freeze({
      scenarioId: scenario.scenarioId,
      status: blockers.length === 0 ? "READY_FOR_MANUAL_AUTHORIZATION" : "BLOCKED_PRECONDITION_FAILED",
      blockers: Object.freeze(blockers),
      legs: Object.freeze(legs),
    });
  }

  private async prepareLeg(
    scenarioId: OkxRealExecutionScenarioId,
    scenarioLeg: OkxRealExecutionLegRequest,
    userId: string,
    accountId: string,
  ): Promise<OkxPreparedExecutionLeg> {
    const canonical = canonicalInstrumentFromId(scenarioLeg.instrumentId);
    const venueInstrument = this.instrumentCapability.resolveVenueInstrument(canonical, "okx");
    const rules = await this.tradingRules.getTradingRules(venueInstrument);
    const quantityPlan = await new ExecutionQuantityPlanner(
      { resolve: async () => quantityInstrument(canonical, venueInstrument) },
      { getTradingRules: async () => rules },
      { now: this.now },
    ).plan({
      instrumentId: canonical.instrumentId,
      side: scenarioLeg.side,
      quantityInput: scenarioLeg.quantityInput,
      quote: scenarioLeg.quote,
    });
    if (!quantityPlan.ok) {
      throw new Error(`OKX quantity conversion failed: ${quantityPlan.error.code}.`);
    }

    const openOrders = await this.readiness.readOpenOrders({
      userId,
      accountId,
      instId: venueInstrument.instId,
    });
    const isPerpetual = canonical.contractType === "perpetual";
    const positions = isPerpetual
      ? await this.readiness.readPositions({ userId, accountId, instId: venueInstrument.instId })
      : Object.freeze([] as OkxPerpetualPosition[]);
    const intentDraft = this.intentFor(scenarioId, scenarioLeg, userId, accountId, quantityPlan.plan);
    const executionRecordDraft = createExecutionRecordFromIntent(
      this.createExecutionId(scenarioId, scenarioLeg.role),
      intentDraft,
    );
    const closeIntentDraft = isPerpetual
      ? this.closeIntentFor(scenarioId, scenarioLeg, userId, accountId, quantityPlan.plan)
      : null;
    const closeExecutionRecordDraft = closeIntentDraft === null
      ? null
      : createExecutionRecordFromIntent(
        `${this.createExecutionId(scenarioId, scenarioLeg.role)}-close`,
        closeIntentDraft,
      );

    return Object.freeze({
      role: scenarioLeg.role,
      capabilityReadiness: isPerpetual
        ? "OKX_EXECUTION_CAPABILITY"
        : "BLOCKED_UNSUPPORTED_OKX_SPOT_EXECUTION_CAPABILITY",
      checks: Object.freeze({
        instrumentResolution: "PASS",
        tradingRules: "PASS",
        quantityConversion: "PASS",
        accountReadiness: "PASS",
        openOrderReadiness: openOrders.length === 0 ? "PASS" : "BLOCKED_OPEN_ORDERS_PRESENT",
        positionReadiness: isPerpetual ? "PASS" : "NOT_APPLICABLE_SPOT",
        closeReadiness: isPerpetual ? "PASS" : "NOT_APPLICABLE_SPOT",
      }),
      canonicalInstrumentId: canonical.instrumentId,
      venueInstrument,
      tradingRules: rules,
      quantityPlan: quantityPlan.plan,
      openOrders: Object.freeze([...openOrders]),
      positions: Object.freeze([...positions]),
      intentDraft,
      executionRecordDraft,
      closeIntentDraft,
      closeExecutionRecordDraft,
    });
  }

  private intentFor(
    scenarioId: OkxRealExecutionScenarioId,
    scenarioLeg: OkxRealExecutionLegRequest,
    userId: string,
    accountId: string,
    quantityPlan: ExecutionQuantityPlan,
  ) {
    const createdAt = this.timestamp();
    return createExecutionIntent({
      intentId: this.createIntentId(scenarioId, scenarioLeg.role),
      userId,
      venue: "okx",
      accountId,
      instrumentId: quantityPlan.instrumentId,
      side: scenarioLeg.side,
      ...(quantityPlan.instrumentId.endsWith("-PERP")
        ? { positionDirection: scenarioLeg.side === "buy" ? "LONG" as const : "SHORT" as const }
        : {}),
      quantity: quantityPlan.plannedAssetQuantity,
      orderConstraints: { reduceOnly: false },
      executionMode: "EXECUTION_PRIORITY",
      createdAt,
      expiresAt: createdAt + this.expiresInMs,
    });
  }

  private closeIntentFor(
    scenarioId: OkxRealExecutionScenarioId,
    scenarioLeg: OkxRealExecutionLegRequest,
    userId: string,
    accountId: string,
    quantityPlan: ExecutionQuantityPlan,
  ) {
    const createdAt = this.timestamp();
    return createExecutionIntent({
      intentId: `${this.createIntentId(scenarioId, scenarioLeg.role)}-close`,
      userId,
      venue: "okx",
      accountId,
      instrumentId: quantityPlan.instrumentId,
      side: scenarioLeg.side === "buy" ? "sell" : "buy",
      ...(quantityPlan.instrumentId.endsWith("-PERP")
        ? { positionDirection: scenarioLeg.side === "buy" ? "SHORT" as const : "LONG" as const }
        : {}),
      quantity: quantityPlan.plannedAssetQuantity,
      orderConstraints: { reduceOnly: true },
      executionMode: "EXECUTION_PRIORITY",
      createdAt,
      expiresAt: createdAt + this.expiresInMs,
    });
  }

  private timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("OKX real execution preparation clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}

function leg(
  role: OkxRealExecutionLegRole,
  instrumentId: string,
  side: "buy" | "sell",
  fetchedAt: number,
): OkxRealExecutionLegRequest {
  return Object.freeze({
    role,
    instrumentId,
    side,
    quantityInput: Object.freeze({ mode: "NOTIONAL_USDT", amountUsdt: "5" }),
    quote: Object.freeze({ bid: "0.1", ask: "0.11", fetchedAt }),
  });
}

function quantityInstrument(
  canonical: CanonicalInstrument,
  instrument: VenueInstrument,
): ExecutionQuantityPlanningInstrument {
  return Object.freeze({
    instrumentId: canonical.instrumentId,
    providerSymbol: instrument.instId,
    baseAsset: createAsset({ symbol: canonical.baseAsset, type: "DIGITAL_ASSET" }),
    quoteAsset: canonical.quoteAsset,
    ...(canonical.contractType === "perpetual" ? { settlementAsset: canonical.quoteAsset } : {}),
    marketType: canonical.contractType === "spot" ? "spot" : "perpetual",
    contractType: canonical.contractType === "spot" ? "spot" : "linear_perpetual",
    quantityUnit: canonical.contractType === "spot" ? "base" : "contract",
    status: "trading",
  });
}

function legBlockers(leg: OkxPreparedExecutionLeg): string[] {
  const blockers: string[] = [];
  if (leg.capabilityReadiness !== "OKX_EXECUTION_CAPABILITY") {
    blockers.push(`${leg.role}: ${leg.capabilityReadiness}`);
  }
  if (leg.checks.openOrderReadiness !== "PASS") {
    blockers.push(`${leg.role}: ${leg.checks.openOrderReadiness}`);
  }
  return blockers;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
