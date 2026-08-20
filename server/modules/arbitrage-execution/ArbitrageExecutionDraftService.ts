import type { ArbitrageDashboardService } from "../arbitrage/ArbitrageDashboardService";
import type { ArbitrageOpportunity, ArbitrageOpportunityLeg, ArbitrageVenue } from "../arbitrage/arbitrageTypes";
import type { ExecutionQuantityInput } from "../cex/ExecutionQuantityPlanner";
import { ExecutionQuantityPlanner } from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentId } from "../cex/Instrument";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  ArbitrageExecutionDraft,
  ArbitrageExecutionDraftLeg,
  ArbitrageExecutionDraftStrategyType,
  ArbitrageExecutionDraftVenue,
} from "./ArbitrageExecutionDraft";
import type {
  ArbitrageExecutionPlanningContext,
  ArbitrageExecutionPlanningContextSource,
} from "./ArbitrageExecutionPlanningContext";
import type { FormalExecutionRuntimeResolver } from "./FormalExecutionRuntimeRegistry";

export class ArbitrageExecutionDraftError extends Error {
  constructor(
    readonly category: "invalid_execution_draft_request" | "opportunity_not_found" | "opportunity_not_supported",
    message: string,
  ) {
    super(message);
  }
}

type DashboardSource = Pick<ArbitrageDashboardService, "getSnapshot">;
type CredentialSummarySource = Pick<UserExchangeCredentialStore, "findSummary">;

export class ArbitrageExecutionDraftService {
  constructor(
    private readonly dashboard: DashboardSource,
    private readonly contexts: ArbitrageExecutionPlanningContextSource,
    private readonly credentials: CredentialSummarySource,
    private readonly runtimes: FormalExecutionRuntimeResolver,
    private readonly now: () => number = Date.now,
  ) {}

  async createDraft(authenticatedUserId: string, input: unknown): Promise<ArbitrageExecutionDraft> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseDraftRequest(input, false);
    return this.build(userId, request.opportunityId, request.horizonDays);
  }

  async preview(authenticatedUserId: string, input: unknown): Promise<ArbitrageExecutionDraft> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseDraftRequest(input, true);
    return this.build(userId, request.opportunityId, request.horizonDays, request.quantityInput);
  }

  private async build(
    userId: string,
    opportunityId: string,
    horizonDays: 90 | 365,
    quantityInput?: ExecutionQuantityInput,
  ) {
    const snapshot = await this.dashboard.getSnapshot(horizonDays, false);
    const opportunity = snapshot.opportunities.find((candidate) => candidate.id === opportunityId);
    if (!opportunity) {
      throw new ArbitrageExecutionDraftError("opportunity_not_found", "该套利机会当前已不可用或市场数据已更新。");
    }
    const strategyType = strategyTypeFor(opportunity);
    const resolved = await Promise.all([
      this.resolveLeg(userId, opportunity.longLeg, "LONG", quantityInput),
      this.resolveLeg(userId, opportunity.shortLeg, "SHORT", quantityInput),
    ]) as [ArbitrageExecutionDraftLeg, ArbitrageExecutionDraftLeg];
    const generatedAt = this.now();
    if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) throw new Error("Draft clock is invalid.");
    return Object.freeze({
      opportunityId: opportunity.id,
      sourceIdentity: `arbitrage-dashboard:${opportunity.id}:${snapshot.generatedAt}`,
      sourceSnapshotGeneratedAt: snapshot.generatedAt,
      horizonDays,
      strategyType,
      ...(quantityInput === undefined ? {} : { quantityInput }),
      legs: Object.freeze(resolved),
      allLegsExecutable: resolved.every((leg) => leg.executionAvailable)
        && !sameAccountPerpetualConflict(resolved),
      generatedAt,
    });
  }

  private async resolveLeg(
    userId: string,
    leg: ArbitrageOpportunityLeg,
    role: "LONG" | "SHORT",
    quantityInput?: ExecutionQuantityInput,
  ): Promise<ArbitrageExecutionDraftLeg> {
    const venue = executionVenue(leg.venue);
    const instrumentId = canonicalInstrumentId(leg.asset, leg.quoteAsset, leg.kind);
    const capability = this.resolveCapability(userId, venue);
    let context: ArbitrageExecutionPlanningContext;
    try {
      context = await this.contexts.load(venue, instrumentId);
      assertContext(context, venue, instrumentId);
    } catch {
      return Object.freeze({
        legId: leg.id,
        role,
        venue,
        instrumentId,
        providerSymbol: null,
        side: role === "LONG" ? "buy" : "sell",
        marketType: leg.kind,
        quote: null,
        tradingRules: null,
        capability,
        planning: quantityInput === undefined
          ? Object.freeze({ status: "NOT_REQUESTED" as const })
          : Object.freeze({ status: "UNAVAILABLE" as const, errorCode: "INSTRUMENT_CONTEXT_UNAVAILABLE" as const }),
        executionAvailable: false,
      });
    }
    const planning = quantityInput === undefined
      ? Object.freeze({ status: "NOT_REQUESTED" as const })
      : await plan(context, instrumentId, role === "LONG" ? "buy" : "sell", quantityInput);
    return Object.freeze({
      legId: leg.id,
      role,
      venue,
      instrumentId,
      providerSymbol: context.instrument.providerSymbol,
      side: role === "LONG" ? "buy" : "sell",
      marketType: leg.kind,
      quote: Object.freeze({ bid: context.quote.bid, ask: context.quote.ask, updatedAt: context.quote.fetchedAt }),
      tradingRules: context.tradingRules,
      capability,
      planning,
      executionAvailable: capability.status === "AVAILABLE" && planning.status === "PLANNED",
    });
  }

  private resolveCapability(userId: string, venue: ArbitrageExecutionDraftVenue) {
    try {
      this.runtimes.resolve(venue);
    } catch {
      return Object.freeze({
        status: "UNAVAILABLE" as const,
        reasonCode: "EXECUTION_CAPABILITY_NOT_IMPLEMENTED" as const,
      });
    }
    const credential = this.credentials.findSummary(userId, venue);
    if (!credential || !credentialExecutionAvailable(venue, credential.permissions)) {
      return Object.freeze({
        status: "UNAVAILABLE" as const,
        reasonCode: "CREDENTIAL_NOT_CONFIGURED" as const,
      });
    }
    return Object.freeze({ status: "AVAILABLE" as const, reasonCode: "AVAILABLE" as const });
  }
}

function credentialExecutionAvailable(
  venue: ArbitrageExecutionDraftVenue,
  permissions: Readonly<Record<string, boolean>>,
) {
  // Legacy Binance summaries predate explicit execution enablement; Provider-managed summaries must opt in.
  if (permissions.executionEnabled === undefined) return permissions.providerVerified === undefined;
  const credentialReady = permissions.executionEnabled === true
    && permissions.providerVerified === true
    && permissions.read === true
    && permissions.contractTrade === true
    && permissions.withdraw === false
    && permissions.ipRestricted === true
    && permissions.accountLevelSupported === true;
  if (!credentialReady) return false;
  // Binance/OKX persist an account-global one-way/net-mode capability. Bybit
  // validates positionIdx for the target instrument during execution prepare.
  return venue === "bybit" || permissions.positionModeSupported === true;
}

function sameAccountPerpetualConflict(legs: readonly [ArbitrageExecutionDraftLeg, ArbitrageExecutionDraftLeg]) {
  return legs[0].venue === legs[1].venue
    && legs[0].instrumentId === legs[1].instrumentId
    && legs.every((leg) => leg.marketType === "perpetual");
}

async function plan(
  context: ArbitrageExecutionPlanningContext,
  instrumentId: string,
  side: "buy" | "sell",
  quantityInput: ExecutionQuantityInput,
) {
  const planner = new ExecutionQuantityPlanner(
    { resolve: async (requested) => requested === instrumentId ? context.instrument : null },
    { getTradingRules: async () => context.tradingRules },
  );
  const result = await planner.plan({ instrumentId, side, quantityInput, quote: context.quote });
  if (result.ok) return Object.freeze({ status: "PLANNED" as const, plan: result.plan });
  return Object.freeze({
    status: "ERROR" as const,
    errorCode: result.error.code,
    ...(result.error.minimumRequiredAssetQuantity === undefined ? {} : { minimumRequiredAssetQuantity: result.error.minimumRequiredAssetQuantity }),
    ...(result.error.minimumRequiredVenueQuantity === undefined ? {} : { minimumRequiredVenueQuantity: result.error.minimumRequiredVenueQuantity }),
    ...(result.error.minimumRequiredNotionalUsdt === undefined ? {} : { minimumRequiredNotionalUsdt: result.error.minimumRequiredNotionalUsdt }),
    ...(result.error.nearestLegalAssetQuantity === undefined ? {} : { nearestLegalAssetQuantity: result.error.nearestLegalAssetQuantity }),
  });
}

function assertContext(
  context: ArbitrageExecutionPlanningContext,
  venue: ArbitrageExecutionDraftVenue,
  instrumentId: string,
) {
  if (context.instrument.instrumentId !== instrumentId || !context.instrument.providerSymbol) {
    throw new ArbitrageExecutionDraftError("opportunity_not_supported", `无法为 ${venue} 取得权威交易品种。`);
  }
}

function strategyTypeFor(opportunity: ArbitrageOpportunity): ArbitrageExecutionDraftStrategyType {
  const kinds = [opportunity.longLeg.kind, opportunity.shortLeg.kind];
  if (kinds.every((kind) => kind === "perpetual")) return "PERPETUAL_PERPETUAL";
  if (kinds.filter((kind) => kind === "spot").length === 1) return "SPOT_PERPETUAL";
  throw new ArbitrageExecutionDraftError("opportunity_not_supported", "当前机会类型不支持创建套利草案。");
}

function executionVenue(venue: ArbitrageVenue): ArbitrageExecutionDraftVenue {
  if (venue === "binance" || venue === "okx" || venue === "bybit" || venue === "bitget") return venue;
  throw new ArbitrageExecutionDraftError("opportunity_not_supported", "当前交易所不支持创建套利草案。");
}

function parseDraftRequest(input: unknown, requireQuantity: boolean) {
  const value = object(input, "execution draft request");
  const allowed = requireQuantity ? ["opportunityId", "horizonDays", "quantityInput"] : ["opportunityId", "horizonDays"];
  exactKeys(value, allowed);
  const horizonDays = value.horizonDays === 90 || value.horizonDays === 365 ? value.horizonDays : null;
  if (!horizonDays) throw invalid("horizonDays 必须为 90 或 365。");
  return Object.freeze({
    opportunityId: identifier(value.opportunityId, "opportunityId"),
    horizonDays,
    ...(requireQuantity ? { quantityInput: quantityInput(value.quantityInput) } : {}),
  });
}

function quantityInput(input: unknown): ExecutionQuantityInput {
  const value = object(input, "quantityInput");
  if (value.mode === "NOTIONAL_USDT") {
    exactKeys(value, ["mode", "amountUsdt"]);
    return Object.freeze({ mode: "NOTIONAL_USDT", amountUsdt: decimal(value.amountUsdt, "amountUsdt") });
  }
  if (value.mode === "ASSET_QUANTITY") {
    exactKeys(value, ["mode", "quantity"]);
    return Object.freeze({ mode: "ASSET_QUANTITY", quantity: decimal(value.quantity, "quantity") });
  }
  throw invalid("quantityInput.mode 不受支持。");
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${name} 必须为对象。`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(value);
  const unsupported = keys.find((key) => !allowed.includes(key));
  if (unsupported) throw invalid(`请求包含不允许的字段：${unsupported}。`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw invalid(`请求缺少字段：${missing}。`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) throw invalid(`${name} 无效。`);
  return value.trim();
}

function decimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw invalid(`${name} 必须为十进制字符串。`);
  return value;
}

function invalid(message: string) {
  return new ArbitrageExecutionDraftError("invalid_execution_draft_request", message);
}
