import { randomUUID } from "node:crypto";
import type { Asset } from "../cex/Asset";
import type { ExecutionIntent, ExecutionVenue } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
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
}>;

export type FundingArbitrageManualExecutionResult<TResult = unknown> = Readonly<{
  intentId: string;
  executionRecordId: string;
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

    const account = await this.accountResolver.resolve(userId, leg.venue, leg.instrumentId);
    const intent = this.adapter.createExecutionIntent(fundingIntent, {
      confirmed: true,
      intentId: this.options.createIntentId?.() ?? randomUUID(),
      legId: request.legId,
      userId,
      accountId: account.accountId,
      venue: leg.venue,
      quantityAsset: account.quantityAsset,
      orderConstraints: request.orderConstraints,
      executionMode: request.executionMode,
      confirmedAt: this.options.clock?.() ?? Date.now(),
      expiresAt: request.expiresAt,
    });

    const claimed = await this.linkStore.claimForUser(
      userId,
      fundingIntent.intentId,
      leg.legId,
      intent.intentId,
    );
    if (!claimed) throw duplicateExecution();

    const runtimeResult = await this.runtime.execute(intent);
    await this.linkStore.linkForUser(userId, fundingIntent.intentId, leg.legId, {
      executionIntentId: intent.intentId,
      executionRecordId: runtimeResult.executionRecord.executionId,
    });

    return Object.freeze({
      intentId: intent.intentId,
      executionRecordId: runtimeResult.executionRecord.executionId,
      fundingIntentId: request.fundingIntentId,
      legId: request.legId,
      userId: intent.userId,
      venue: intent.venue,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      execution: runtimeResult.execution,
    });
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
      | "unsupported_execution_venue",
    message: string,
  ) {
    super(message);
  }
}

type ManualExecutionRequest = Readonly<{
  fundingIntentId: string;
  fundingIntent: unknown;
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
    legId: identifier(value.legId, "legId"),
    confirmed: true,
    orderConstraints: Object.freeze({ reduceOnly: constraints.reduceOnly }),
    executionMode: value.executionMode,
    expiresAt: timestamp(value.expiresAt, "expiresAt"),
  });
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
