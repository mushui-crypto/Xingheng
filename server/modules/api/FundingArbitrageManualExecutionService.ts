import { randomUUID } from "node:crypto";
import type { Asset } from "../cex/Asset";
import type { ExecutionIntent, ExecutionVenue } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type {
  ArbitrageInstance,
  NewArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { FundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import { FundingArbitrageIntentAdapter } from "../cex/funding-arbitrage/FundingArbitrageIntentAdapter";
import type {
  FundingLegExecutionLink,
  FundingLegExecutionLinkStorePort,
} from "../cex/funding-arbitrage/FundingLegExecutionLinkStore";

export type { FundingLegExecutionLink } from "../cex/funding-arbitrage/FundingLegExecutionLinkStore";

type FundingLeg = FundingArbitrageExecutionIntent["legs"][number];

export type FundingArbitrageExecutionIntentSource = Readonly<{
  loadForUser(
    userId: string,
    fundingIntentId: string,
    input: unknown,
  ): Promise<FundingArbitrageExecutionIntent | null>;
}>;

export type VenueExecutionAccountBinding = Readonly<{
  accountId: string;
  quantityAsset: Asset;
}>;

export type VenueExecutionAccountResolver = Readonly<{
  resolve(
    userId: string,
    venue: ExecutionVenue,
    instrumentId: string,
  ): Promise<VenueExecutionAccountBinding>;
}>;

export type ManualExecutionRuntime<TResult = unknown> = Readonly<{
  execute(intent: ExecutionIntent): Promise<Readonly<{
    executionRecord: ExecutionRecord;
    execution: TResult;
  }>>;
}>;

export type FundingLegExecutionLinkStore = FundingLegExecutionLinkStorePort;

export type FundingArbitrageManualExecutionServiceOptions = Readonly<{
  clock?: () => number;
  createIntentId?: () => string;
  createArbitrageId?: () => string;
}>;

export type ArbitrageInstanceExecutionStore = Pick<
  ArbitrageInstanceStore,
  "create" | "get" | "claimExecutionReference" | "linkExecutionRecord"
>;

export type FundingArbitrageManualExecutionResult<TResult = unknown> = Readonly<{
  intentId: string;
  executionRecordId: string;
  arbitrageId: string;
  fundingIntentId: string;
  legId: string;
  userId: string;
  venue: ExecutionVenue;
  accountId: string;
  instrumentId: string;
  execution: TResult;
}>;

export class FundingArbitrageManualExecutionService<TResult = unknown> {
  private readonly adapter = new FundingArbitrageIntentAdapter();

  constructor(
    private readonly source: FundingArbitrageExecutionIntentSource,
    private readonly accountResolver: VenueExecutionAccountResolver,
    private readonly runtime: ManualExecutionRuntime<TResult>,
    private readonly linkStore: FundingLegExecutionLinkStore,
    private readonly arbitrageInstances: ArbitrageInstanceExecutionStore,
    private readonly options: FundingArbitrageManualExecutionServiceOptions = {},
  ) {}

  async execute(
    authenticatedUserId: string,
    input: unknown,
  ): Promise<FundingArbitrageManualExecutionResult<TResult>> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseRequest(input);
    const fundingIntent = await this.source.loadForUser(
      userId,
      request.fundingIntentId,
      request.fundingIntent,
    );
    if (!fundingIntent) {
      throw new FundingArbitrageManualExecutionError("funding_intent_not_found", "Funding intent was not found for the authenticated user.");
    }

    const leg = findLeg(fundingIntent, request.legId);
    if (leg.venue !== "binance") {
      throw new FundingArbitrageManualExecutionError("unsupported_execution_venue", "Manual execution currently supports Binance legs only.");
    }

    const existingLink = await this.linkStore.findForUser(userId, fundingIntent.intentId, leg.legId);
    if (existingLink) throw duplicateExecution();

    const confirmedAt = this.options.clock?.() ?? Date.now();
    const binding = request.arbitrageId
      ? await this.loadBinding(userId, fundingIntent, leg, request.arbitrageId)
      : await this.createBinding(userId, fundingIntent, leg, confirmedAt);
    const account = binding.account;
    const intent = this.adapter.createExecutionIntent(fundingIntent, {
      confirmed: true,
      intentId: this.options.createIntentId?.() ?? randomUUID(),
      arbitrageId: binding.instance.arbitrageId,
      legId: request.legId,
      userId,
      accountId: account.accountId,
      venue: leg.venue,
      quantityAsset: account.quantityAsset,
      orderConstraints: request.orderConstraints,
      executionMode: request.executionMode,
      confirmedAt,
      expiresAt: request.expiresAt,
    });

    const claimed = await this.linkStore.claimForUser(
      userId,
      fundingIntent.intentId,
      leg.legId,
      intent.intentId,
    );
    if (!claimed) throw duplicateExecution();

    this.arbitrageInstances.claimExecutionReference(
      userId,
      binding.instance.arbitrageId,
      {
        legId: leg.legId,
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: intent.intentId,
        requestedQuantity: intent.quantity.quantity,
        createdAt: confirmedAt,
      },
    );

    const runtimeResult = await this.runtime.execute(intent);
    this.arbitrageInstances.linkExecutionRecord(
      userId,
      binding.instance.arbitrageId,
      intent.intentId,
      runtimeResult.executionRecord.executionId,
      this.options.clock?.() ?? Date.now(),
    );
    await this.linkStore.linkForUser(userId, fundingIntent.intentId, leg.legId, {
      executionIntentId: intent.intentId,
      executionRecordId: runtimeResult.executionRecord.executionId,
    });

    return Object.freeze({
      intentId: intent.intentId,
      executionRecordId: runtimeResult.executionRecord.executionId,
      arbitrageId: binding.instance.arbitrageId,
      fundingIntentId: request.fundingIntentId,
      legId: request.legId,
      userId: intent.userId,
      venue: intent.venue,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      execution: runtimeResult.execution,
    });
  }

  private async createBinding(
    userId: string,
    fundingIntent: FundingArbitrageExecutionIntent,
    selectedLeg: FundingLeg,
    createdAt: number,
  ) {
    const accounts = await Promise.all(fundingIntent.legs.map(async (leg) => ({
      legId: leg.legId,
      account: await this.accountResolver.resolve(userId, leg.venue, leg.instrumentId),
    })));
    const instance = this.arbitrageInstances.create({
      arbitrageId: this.options.createArbitrageId?.() ?? randomUUID(),
      userId,
      strategyType: fundingIntent.strategyType,
      sourcePlanId: fundingIntent.sourcePlanId,
      maxResidualBaseQuantity: fundingIntent.constraints.maxResidualBaseQuantity,
      createdAt,
      legs: [
        newInstanceLeg(fundingIntent.legs[0], accounts),
        newInstanceLeg(fundingIntent.legs[1], accounts),
      ],
    });
    return Object.freeze({ instance, account: requireAccount(accounts, selectedLeg.legId) });
  }

  private async loadBinding(
    userId: string,
    fundingIntent: FundingArbitrageExecutionIntent,
    selectedLeg: FundingLeg,
    arbitrageId: string,
  ) {
    const instance = this.arbitrageInstances.get(userId, arbitrageId);
    if (!instance) {
      throw new FundingArbitrageManualExecutionError(
        "arbitrage_instance_not_found",
        "Arbitrage instance was not found for the authenticated user.",
      );
    }
    assertInstanceMatchesFundingIntent(instance, fundingIntent);
    const account = await this.accountResolver.resolve(
      userId,
      selectedLeg.venue,
      selectedLeg.instrumentId,
    );
    const instanceLeg = instance.legs.find((candidate) => candidate.legId === selectedLeg.legId);
    if (!instanceLeg || instanceLeg.accountId !== account.accountId) {
      throw new FundingArbitrageManualExecutionError(
        "arbitrage_instance_mismatch",
        "Arbitrage instance leg does not match the authenticated execution account.",
      );
    }
    return Object.freeze({ instance, account });
  }
}

export class FundingArbitrageManualExecutionError extends Error {
  constructor(
    readonly category:
      | "authentication_required"
      | "invalid_manual_execution_request"
      | "funding_intent_not_found"
      | "funding_leg_not_found"
      | "funding_leg_already_executed"
      | "arbitrage_instance_not_found"
      | "arbitrage_instance_mismatch"
      | "unsupported_execution_venue",
    message: string,
  ) {
    super(message);
  }
}

type ManualExecutionRequest = Readonly<{
  fundingIntentId: string;
  fundingIntent: unknown;
  arbitrageId?: string;
  legId: string;
  confirmed: true;
  orderConstraints: Readonly<{ reduceOnly: boolean }>;
  executionMode: ExecutionIntent["executionMode"];
  expiresAt: number;
}>;

function parseRequest(input: unknown): ManualExecutionRequest {
  const value = object(input, "ManualExecutionRequest");
  assertExactKeys(value, [
    "fundingIntentId",
    "fundingIntent",
    "arbitrageId",
    "legId",
    "confirmed",
    "orderConstraints",
    "executionMode",
    "expiresAt",
  ], "ManualExecutionRequest");

  if (value.confirmed !== true) {
    throw invalid("explicit human confirmation is required.");
  }
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw invalid("executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }
  const constraints = object(value.orderConstraints, "orderConstraints");
  assertExactKeys(constraints, ["reduceOnly"], "orderConstraints");
  if (typeof constraints.reduceOnly !== "boolean") {
    throw invalid("orderConstraints.reduceOnly must be a boolean.");
  }

  return Object.freeze({
    fundingIntentId: identifier(value.fundingIntentId, "fundingIntentId"),
    fundingIntent: value.fundingIntent,
    ...(value.arbitrageId === undefined
      ? {}
      : { arbitrageId: identifier(value.arbitrageId, "arbitrageId") }),
    legId: identifier(value.legId, "legId"),
    confirmed: true,
    orderConstraints: Object.freeze({ reduceOnly: constraints.reduceOnly }),
    executionMode: value.executionMode,
    expiresAt: timestamp(value.expiresAt, "expiresAt"),
  });
}

function requireAccount(
  accounts: readonly Readonly<{ legId: string; account: VenueExecutionAccountBinding }>[],
  legId: string,
) {
  const binding = accounts.find((candidate) => candidate.legId === legId);
  if (!binding) throw new Error("Arbitrage leg account binding was not resolved.");
  return binding.account;
}

function newInstanceLeg(
  leg: FundingLeg,
  accounts: readonly Readonly<{ legId: string; account: VenueExecutionAccountBinding }>[],
): NewArbitrageInstance["legs"][number] {
  return Object.freeze({
    legId: leg.legId,
    role: leg.role === "long" ? "LONG" : "SHORT",
    venue: leg.venue,
    accountId: requireAccount(accounts, leg.legId).accountId,
    instrumentId: leg.instrumentId,
    plannedQuantity: leg.targetDeltaBaseQuantity,
  });
}

function assertInstanceMatchesFundingIntent(
  instance: ArbitrageInstance,
  fundingIntent: FundingArbitrageExecutionIntent,
) {
  const matches = instance.strategyType === fundingIntent.strategyType
    && instance.sourcePlanId === fundingIntent.sourcePlanId
    && instance.maxResidualBaseQuantity === fundingIntent.constraints.maxResidualBaseQuantity
    && fundingIntent.legs.every((leg) => instance.legs.some((candidate) => (
      candidate.legId === leg.legId
      && candidate.role === (leg.role === "long" ? "LONG" : "SHORT")
      && candidate.venue === leg.venue
      && candidate.instrumentId === leg.instrumentId
      && candidate.plannedQuantity === leg.targetDeltaBaseQuantity
    )));
  if (!matches) {
    throw new FundingArbitrageManualExecutionError(
      "arbitrage_instance_mismatch",
      "Arbitrage instance does not match the confirmed funding intent.",
    );
  }
}

function findLeg(fundingIntent: FundingArbitrageExecutionIntent, legId: string): FundingLeg {
  const leg = fundingIntent.legs.find((candidate) => candidate.legId === legId);
  if (!leg) {
    throw new FundingArbitrageManualExecutionError("funding_leg_not_found", "Funding leg was not found in the funding intent.");
  }
  return leg;
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw invalid(`${name} contains unsupported field: ${unknown}.`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    if (name === "authenticated userId") {
      throw new FundingArbitrageManualExecutionError("authentication_required", "User authentication is required.");
    }
    throw invalid(`${name} is invalid.`);
  }
  return value.trim();
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}

function invalid(message: string) {
  return new FundingArbitrageManualExecutionError("invalid_manual_execution_request", message);
}

function duplicateExecution() {
  return new FundingArbitrageManualExecutionError(
    "funding_leg_already_executed",
    "Funding leg already has an execution claim.",
  );
}
