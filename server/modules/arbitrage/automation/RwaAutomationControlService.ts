import type { ArbitrageDashboardService } from "../ArbitrageDashboardService";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import {
  RwaAutomationConnectorRegistry,
  RwaAutomationRegistryError,
  normalizeVenue,
} from "./RwaAutomationConnectorRegistry";
import type { RwaAutomationCandidate, RwaAutomationMode, RwaAutomationVenue, RwaVenueCredentialInput } from "./RwaAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";

export class RwaAutomationControlService {
  private challengeVenues = new Map<string, { userId: string; venue: RwaAutomationVenue; accountId: string }>();
  private readonly registries = new Map<string, RwaAutomationConnectorRegistry>();

  constructor(
    private readonly dashboard: ArbitrageDashboardService,
    private readonly registryFactory: (userId: string) => RwaAutomationConnectorRegistry,
  ) {}

  private registry(userId: string) {
    const existing = this.registries.get(userId);
    if (existing) return existing;
    const created = this.registryFactory(userId);
    this.registries.set(userId, created);
    return created;
  }

  async listVenues(userId: string) {
    return (await this.registry(userId).statuses()).map((status) => ({
      ...status,
      credential: { ...status.credential, userId },
    }));
  }

  getVenueStatus(userId: string, venue: string) {
    return this.registry(userId).requireImplemented(venue).getStatus();
  }

  putCredentials(userId: string, venue: string, input: unknown) {
    const connector = this.registry(userId).requireImplemented(venue);
    return connector.putCredentials(normalizeCredentialInput(connector.venue, input));
  }

  deleteCredentials(userId: string, venue: string, input: unknown) {
    return this.registry(userId).requireImplemented(venue).deleteCredentials(input);
  }

  getConfig(userId: string, venue: string) {
    return this.registry(userId).requireImplemented(venue).getConfig();
  }

  updateConfig(userId: string, venue: string, input: unknown) {
    return this.registry(userId).requireImplemented(venue).updateConfig(input);
  }

  setKillSwitch(userId: string, venue: string, input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, ["active", "accountId"]);
    const active = body.active;
    if (typeof active !== "boolean") throw new RwaAutomationControlError(400, "invalid_request", "active 必须是布尔值。");
    const accountId = requiredString(body.accountId, "accountId", 100);
    return this.registry(userId).requireImplemented(venue).setKillSwitch(active, accountId);
  }

  getPrivateAccount(userId: string, venue: string) {
    return this.registry(userId).requireImplemented(venue).getPrivateAccount();
  }

  async listOpportunities(userId: string) {
    const registry = this.registry(userId);
    const snapshot = await this.dashboard.getSnapshot(90);
    const items = snapshot.opportunities
      .filter((item) => item.strategyType === "same_venue_neutral")
      .map((item) => candidate(item, Boolean(registry.findForOpportunity(item))));
    return {
      generatedAt: snapshot.generatedAt,
      mode: "arbitrage_entry" as const,
      items,
      eligibleCount: items.filter((item) => item.automationEligible && item.adapterImplemented).length,
      noEligibleOpportunity: !items.some((item) => item.automationEligible && item.adapterImplemented),
    };
  }

  async preflight(userId: string, input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "opportunityId", "mode"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const opportunityId = requiredString(body.opportunityId, "opportunityId", 200);
    const mode = body.mode as RwaAutomationMode;
    if (mode !== "arbitrage_entry" && mode !== "manual_entry") {
      throw new RwaAutomationControlError(400, "mode_invalid", "mode 仅允许 arbitrage_entry 或 manual_entry；connectivity smoke 未开放。");
    }
    const snapshot = await this.dashboard.getSnapshot(90, true);
    const opportunity = snapshot.opportunities.find((item) => item.id === opportunityId);
    if (!opportunity) throw new RwaAutomationControlError(404, "opportunity_not_found", "公开套利机会不存在或已失效。");
    const safety = assessSafety(opportunity);
    if (mode === "manual_entry" && !safety.eligible) {
      throw new RwaAutomationControlError(409, "safety_opportunity_blocked", `当前机会无法安全执行：${safety.reasons.join("；")}。`);
    }
    if (mode === "arbitrage_entry" && (
      !safety.eligible
      || !opportunity.automationEligible
    )) {
      const reasons = opportunity.automationDisqualifiers.length
        ? opportunity.automationDisqualifiers.join("；")
        : safety.reasons.join("；") || "该机会不是已合格的同所中性组合";
      throw new RwaAutomationControlError(409, "automation_opportunity_blocked", `当前机会不符合自动套利入场规则：${reasons}。`);
    }
    const connector = this.registry(userId).findForOpportunity(opportunity);
    if (!connector) {
      throw new RwaAutomationControlError(501, "opportunity_adapter_unavailable", "该机会对应的 venue/标的 adapter 尚未实现或默认 disabled。");
    }
    const challenge = await connector.preflight(opportunity, accountId, mode);
    this.challengeVenues.set(challenge.challengeId, { userId, venue: connector.venue, accountId });
    return challenge;
  }

  async execute(userId: string, input: unknown) {
    const body = record(input);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const registry = this.registry(userId);
    const accountConnector = await registry.findByAccountId(accountId);
    if (accountConnector && !accountConnector.providerWritesEnabled) {
      throw new RwaAutomationControlError(
        501,
        `${accountConnector.venue}_provider_writes_disabled`,
        `${venueLabel(accountConnector.venue)} 第一阶段未开放 provider 写调用。`,
      );
    }
    const challengeId = requiredString(body.challengeId, "challengeId", 100);
    const challenge = this.challengeVenues.get(challengeId);
    if (!challenge) throw new RwaAutomationControlError(409, "challenge_disarmed", "challenge 不存在或服务重启后已解除 armed，请重新 preflight。");
    if (challenge.userId !== userId) throw new RwaAutomationControlError(404, "challenge_not_found", "challenge 不存在或不属于当前用户。");
    if (accountId !== challenge.accountId) throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 challenge 不匹配。");
    return registry.requireImplemented(challenge.venue).execute(input);
  }

  async getPositions(userId: string) {
    const registry = this.registry(userId);
    const positions = [];
    for (const venue of registry.listVenues()) {
      const connector = registry.getImplemented(venue);
      if (!connector) continue;
      try {
        const value = await connector.getPnl() as any;
        const current = value?.current;
        if (!current) continue;
        const spotQuantity = Number(current.legs?.spot?.quantityXaut ?? 0);
        const perpetualQuantity = Number(current.legs?.perpetual?.quantityXaut ?? 0);
        if (spotQuantity <= 0 && perpetualQuantity <= 0) continue;
        positions.push({
          positionId: `${venue}:${String(current.accountFingerprint ?? "account")}:${String(current.strategyId ?? "strategy")}`,
          venue,
          strategyId: current.strategyId,
          status: "open",
          ...current,
        });
      } catch {
        // A missing/disabled connector is represented by venue status, not a fabricated position.
      }
    }
    return { items: positions };
  }

  async getPnl(userId: string) {
    const registry = this.registry(userId);
    const venues = [];
    for (const venue of registry.listVenues()) {
      const connector = registry.getImplemented(venue);
      if (!connector) continue;
      try {
        venues.push({ venue, ...(await connector.getPnl() as Record<string, unknown>) });
      } catch (error) {
        venues.push({ venue, unavailable: true, message: safeMessage(error) });
      }
    }
    return { venues };
  }

  async getAudit(userId: string) {
    const registry = this.registry(userId);
    const venues = [];
    for (const venue of registry.listVenues()) {
      const connector = registry.getImplemented(venue);
      if (!connector) continue;
      venues.push({ venue, ...(await connector.getAudit() as Record<string, unknown>) });
    }
    return { venues };
  }

  closePosition(userId: string, positionId: string, input: unknown) {
    const [venue] = positionId.split(":", 1);
    if (!venue) throw new RwaAutomationControlError(400, "position_id_invalid", "positionId 格式无效。");
    return this.registry(userId).requireImplemented(normalizeVenue(venue)).closeAll(input);
  }

  closeAll(userId: string, venue: string, input: unknown) {
    return this.registry(userId).requireImplemented(venue).closeAll(input);
  }
}

export class RwaAutomationControlError extends Error {
  constructor(readonly statusCode: number, readonly category: string, message: string) {
    super(message);
  }
}

export function automationErrorResponse(error: unknown) {
  if (error instanceof RwaAutomationControlError || error instanceof RwaAutomationRegistryError || error instanceof RwaNeutralExecutionError) {
    return {
      statusCode: error.statusCode,
      body: {
        category: error.category,
        message: error.message,
        ...(error instanceof RwaNeutralExecutionError && error.details ? error.details : {}),
      },
    };
  }
  return { statusCode: 500, body: { category: "automation_internal_error", message: "自动套利服务暂不可用。" } };
}

function candidate(item: ArbitrageOpportunity, adapterImplemented: boolean): RwaAutomationCandidate {
  const venue = item.longLeg.venue === item.shortLeg.venue
    ? (["bybit", "bitget", "binance", "okx"].includes(item.longLeg.venue) ? item.longLeg.venue as RwaAutomationVenue : null)
    : null;
  const safety = assessSafety(item);
  return {
    id: item.id,
    longLeg: item.longLeg,
    shortLeg: item.shortLeg,
    strategyType: item.strategyType,
    netApr: item.netApr,
    persistenceRatio: item.persistenceRatio,
    entryBasisBps: item.entryBasisBps,
    automationEligible: item.automationEligible,
    automationDisqualifiers: item.automationDisqualifiers,
    venue,
    adapterImplemented,
    safetyEligible: safety.eligible,
    safetyDisqualifiers: safety.reasons,
  };
}

function assessSafety(opportunity: ArbitrageOpportunity) {
  const reasons = [...opportunity.disqualifiers];
  if (opportunity.strategyType !== "same_venue_neutral") reasons.push("仅支持同所中性组合");
  if (opportunity.longLeg.venue !== opportunity.shortLeg.venue) reasons.push("现货侧与永续侧必须位于同一交易所");
  if (opportunity.longLeg.asset !== opportunity.shortLeg.asset) reasons.push("现货侧与永续侧必须为同一资产");
  if (opportunity.longLeg.kind !== "spot") reasons.push("做多侧必须为现货");
  if (opportunity.shortLeg.kind !== "perpetual") reasons.push("做空侧必须为永续");
  const uniqueReasons = [...new Set(reasons)];
  return { eligible: uniqueReasons.length === 0, reasons: uniqueReasons };
}

function normalizeCredentialInput(venue: RwaAutomationVenue, input: unknown): RwaVenueCredentialInput {
  const body = record(input);
  const supportsPassphrase = venue === "bitget" || venue === "okx";
  assertOnlyKeys(body, supportsPassphrase ? ["apiKey", "apiSecret", "passphrase"] : ["apiKey", "apiSecret"]);
  const apiKey = requiredString(body.apiKey, "apiKey", 128);
  const apiSecret = requiredString(body.apiSecret, "apiSecret", 256);
  const passphrase = body.passphrase === undefined ? undefined : requiredString(body.passphrase, "passphrase", 256);
  return { apiKey, apiSecret, passphrase };
}

function venueLabel(venue: RwaAutomationVenue) {
  return venue === "binance" ? "Binance" : venue === "bybit" ? "Bybit" : venue === "bitget" ? "Bitget" : "OKX";
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new RwaAutomationControlError(400, "invalid_request", `请求包含不支持的字段：${unknown.join("、")}。`);
}

function requiredString(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new RwaAutomationControlError(400, "invalid_request", `${field} 格式无效。`);
  }
  return value.trim();
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function safeMessage(error: unknown) {
  return error instanceof RwaNeutralExecutionError || error instanceof RwaAutomationRegistryError
    ? error.message
    : "该 venue 私有数据暂不可用。";
}
