import type { ArbitrageDashboardService } from "../ArbitrageDashboardService";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { randomUUID } from "node:crypto";
import { CredentialStoreError, discoverAutomationUsersWithExposure } from "./RwaAutomationPersistentStore";
import {
  RwaAutomationConnectorRegistry,
  RwaAutomationRegistryError,
  normalizeVenue,
} from "./RwaAutomationConnectorRegistry";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import type { RwaAutomationCandidate, RwaAutomationMode, RwaAutomationVenue, RwaVenueCredentialInput } from "./RwaAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";
import { categoryFromRwaAutomationError, sanitizeRwaAutomationError, stableHash } from "./RwaNeutralAutomationSecurity";
import {
  StepUpSecurityError,
  canonicalRequestDigest,
  validRequestDigest,
  type StepUpIntent,
  type StepUpOperation,
  type StepUpSecurityService,
} from "../../security/StepUpSecurityService";
import { StepUpSecurityStoreError } from "../../security/StepUpSecurityStore";
import {
  RwaAutomationGovernance,
  RwaAutomationGovernanceError,
  type RwaAutomationGovernanceContext,
  type RwaAutomationGovernedOperation,
} from "./RwaAutomationGovernance";
import { CredentialKeyProviderError } from "./CredentialKeyProvider";

export class RwaAutomationControlService {
  private challengeVenues = new Map<string, {
    userId: string;
    venue: RwaAutomationVenue;
    accountId: string;
    notionalUsd: number | null;
    expiresAt: number;
  }>();
  private readonly registries = new Map<string, { registry: RwaAutomationConnectorRegistry; lastUsedAt: number }>();
  private readonly activeRegistryUsers = new Map<string, number>();
  private readonly challengeReservations = new Map<string, number>();

  constructor(
    private readonly dashboard: ArbitrageDashboardService,
    private readonly registryFactory: (userId: string) => RwaAutomationConnectorRegistry,
    private readonly stepUpSecurity: Pick<StepUpSecurityService, "consume" | "recordCredentialBinding" | "revokeAutomationScope">,
    private readonly governance = new RwaAutomationGovernance(),
    private readonly now: () => number = () => Date.now(),
    private readonly assertExecutionLeaseHeld: () => void = () => {},
  ) {}

  async startPersistedActivityMonitoring() {
    this.assertExecutionLeaseHeld();
    const users = await discoverAutomationUsersWithExposure();
    if (users.length > this.governance.config.maxRegistries) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "持仓活动监控用户数超过 registry 安全上限；已拒绝启动自动执行。",
      );
    }
    for (const userId of users) {
      const registry = this.registry(userId);
      await registry.startActivityMonitoring();
    }
  }

  dispose() {
    for (const entry of this.registries.values()) entry.registry.dispose();
    this.registries.clear();
  }

  private registry(userId: string) {
    this.assertExecutionLeaseHeld();
    this.cleanupRegistries();
    const existing = this.registries.get(userId);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.registry;
    }
    if (this.registries.size >= this.governance.config.maxRegistries) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "自动套利用户状态容量已满；已拒绝新增风险操作。",
      );
    }
    const created = this.registryFactory(userId);
    this.registries.set(userId, { registry: created, lastUsedAt: this.now() });
    return created;
  }

  async listVenues(userId: string, sourceIp = "unknown") {
    this.admitRequest("private_read", sourceIp, userId, "multi");
    return this.governed("private_read", sourceIp, userId, "multi", "all-accounts", async () => {
      const registry = this.registry(userId);
      await registry.initialize();
      return (await registry.statuses()).map((status) => ({
        ...status,
        credential: { ...status.credential, userId },
      }));
    });
  }

  async getVenueStatus(userId: string, venue: string, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, connector.venue, accountId, async () => {
      await registry.initialize();
      return connector.getStatus();
    });
  }

  async putCredentials(userId: string, sessionDomain: string, venue: string, input: unknown, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    const supportsPassphrase = normalizedVenue === "bitget" || normalizedVenue === "okx";
    assertOnlyKeys(body, supportsPassphrase
      ? ["apiKey", "apiSecret", "passphrase", "stepUpToken"]
      : ["apiKey", "apiSecret", "stepUpToken"]);
    const credentials = normalizeCredentialInput(normalizedVenue, omitStepUp(body));
    const requestId = randomUUID();
    const diagnosticContext: CredentialPutDiagnosticContext = {
      requestId,
      venue: normalizedVenue,
      userId,
      sensitiveValues: [
        credentials.apiKey,
        credentials.apiSecret,
        credentials.passphrase,
        typeof body.stepUpToken === "string" ? body.stepUpToken : null,
      ],
    };
    logCredentialPutEvent("route_received", diagnosticContext);
    this.admitRequest("credential", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const existingAccountId = await connector.getConfiguredAccountId();
    try {
      const result = await this.governed("credential", sourceIp, userId, connector.venue, existingAccountId ?? "new-account", async () => {
        await registry.initialize();
        await connector.assertRiskCapacity?.();
        const credentialMutationSnapshot = await connector.captureCredentialMutationSnapshot?.();
        await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
          operation: "credential_put",
          venue: connector.venue,
          accountId: existingAccountId ?? "new-account",
          resourceId: null,
          requestDigest: canonicalRequestDigest(credentials),
          notionalUsd: null,
        });
        logCredentialPutEvent("step_up_consumed", diagnosticContext);
        logCredentialPutEvent("provider_validation_started", diagnosticContext);
        let result;
        try {
          result = await connector.putCredentials(credentials);
        } catch (error) {
          throw normalizeCredentialPutError(error, "validation", diagnosticContext);
        }
        const boundAccountId = (result as { credential?: { accountId?: unknown } })?.credential?.accountId;
        if (typeof boundAccountId !== "string" || !boundAccountId.trim()) {
          await rollbackCredentialMutation(connector, credentialMutationSnapshot, "identity", diagnosticContext);
          throw withCredentialPutDetails(
            new RwaAutomationControlError(503, "credential_identity_unavailable", "交易所账户身份未确认；已保持执行关闭。"),
            diagnosticContext,
            "binding",
          );
        }
        try {
          await this.stepUpSecurity.recordCredentialBinding(userId, boundAccountId);
        } catch (error) {
          await rollbackCredentialMutation(connector, credentialMutationSnapshot, "binding", diagnosticContext);
          throw normalizeCredentialPutError(error, "binding", diagnosticContext);
        }
        this.stepUpSecurity.revokeAutomationScope(userId, connector.venue);
        return result;
      });
      logCredentialPutEvent("response", diagnosticContext, { category: "success", statusCode: 200 });
      return result;
    } catch (error) {
      const augmented = augmentCredentialPutError(error, diagnosticContext);
      logCredentialPutEvent("response", diagnosticContext, {
        category: categoryOfCredentialPutError(augmented),
        error: augmented,
        statusCode: statusCodeOfCredentialPutError(augmented),
      });
      throw augmented;
    }
  }

  async deleteCredentials(userId: string, sessionDomain: string, venue: string, input: unknown, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "stepUpToken"]);
    const sanitized = omitStepUp(body);
    const accountId = requiredString(sanitized.accountId, "accountId", 100);
    this.admitRequest("credential", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const configuredAccountId = await connector.getConfiguredAccountId();
    const governedAccountId = configuredAccountId ?? "unconfigured";
    return this.governed("credential", sourceIp, userId, connector.venue, governedAccountId, async () => {
      await registry.initialize();
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "credential_delete",
        venue: connector.venue,
        accountId,
        resourceId: null,
        requestDigest: canonicalRequestDigest(sanitized),
        notionalUsd: null,
      });
      const result = await connector.deleteCredentials(sanitized);
      this.stepUpSecurity.revokeAutomationScope(userId, connector.venue, accountId);
      return result;
    });
  }

  async getConfig(userId: string, venue: string, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, connector.venue, accountId, async () => {
      await registry.initialize();
      return connector.getConfig();
    });
  }

  async updateConfig(userId: string, sessionDomain: string, venue: string, input: unknown, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    assertOnlyKeys(body, [
      "globalExecutionEnabled", "strategyEnabled", "maxStrategyCapitalUsd", "maxEntryBasisBps",
      "maxCombinedSlippageBps", "minNetAprPercent", "minLiquidationDistancePercent",
      "maxUnhedgedMs", "accountId", "stepUpToken",
    ]);
    const sanitized = omitStepUp(body);
    const enabling = sanitized.globalExecutionEnabled === true || sanitized.strategyEnabled === true;
    const disablingOnly = !enabling
      && Object.keys(sanitized).every((key) => ["globalExecutionEnabled", "strategyEnabled", "accountId"].includes(key))
      && (sanitized.globalExecutionEnabled === false || sanitized.strategyEnabled === false);
    if (!enabling && body.stepUpToken !== undefined) {
      throw new RwaAutomationControlError(400, "invalid_request", "关闭执行开关不接受 stepUpToken。");
    }
    if (!disablingOnly) this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const configuredAccountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    const operation = async () => {
      if (!disablingOnly) await registry.initialize();
      if (enabling) {
        await connector.assertRiskCapacity?.();
        const accountId = requiredString(sanitized.accountId, "accountId", 100);
        await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
          operation: "execution_enable",
          venue: connector.venue,
          accountId,
          resourceId: null,
          requestDigest: canonicalRequestDigest(sanitized),
          notionalUsd: null,
        });
      }
      const result = await connector.updateConfig(sanitized);
      if ("globalExecutionEnabled" in sanitized || "strategyEnabled" in sanitized) {
        this.stepUpSecurity.revokeAutomationScope(userId, connector.venue, typeof sanitized.accountId === "string" ? sanitized.accountId : undefined);
      }
      return result;
    };
    return disablingOnly
      ? operation()
      : this.governed("risk_control", sourceIp, userId, connector.venue, configuredAccountId, operation);
  }

  async setKillSwitch(userId: string, sessionDomain: string, venue: string, input: unknown, sourceIp = "unknown") {
    const body = record(input);
    assertOnlyKeys(body, ["active", "accountId", "stepUpToken"]);
    const active = body.active;
    if (typeof active !== "boolean") throw new RwaAutomationControlError(400, "invalid_request", "active 必须是布尔值。");
    const accountId = requiredString(body.accountId, "accountId", 100);
    const normalizedVenue = normalizeVenue(venue);
    const sanitized = { active, accountId };
    if (active && body.stepUpToken !== undefined) {
      throw new RwaAutomationControlError(400, "invalid_request", "激活急停不接受 stepUpToken。");
    }
    if (!active) this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const operation = async () => {
      if (!active) await registry.initialize();
      if (!active) {
        await connector.assertRiskCapacity?.();
        await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
          operation: "kill_switch_disable",
          venue: connector.venue,
          accountId,
          resourceId: null,
          requestDigest: canonicalRequestDigest(sanitized),
          notionalUsd: null,
        });
      }
      const result = await connector.setKillSwitch(active, accountId);
      this.stepUpSecurity.revokeAutomationScope(userId, connector.venue, accountId);
      return result;
    };
    return active ? operation() : this.governed("risk_control", sourceIp, userId, connector.venue, accountId, operation);
  }

  async getPrivateAccount(userId: string, venue: string, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, connector.venue, accountId, async () => {
      await registry.initialize();
      return connector.getPrivateAccount();
    });
  }

  async listOpportunities(userId: string, sourceIp = "unknown") {
    this.admitRequest("private_read", sourceIp, userId, "multi");
    return this.governed("private_read", sourceIp, userId, "multi", "all-accounts", async () => {
      const registry = this.registry(userId);
      await registry.initialize();
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
    });
  }

  async preflight(userId: string, input: unknown, sourceIp = "unknown") {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "opportunityId", "mode"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const opportunityId = requiredString(body.opportunityId, "opportunityId", 200);
    const mode = body.mode as RwaAutomationMode;
    if (mode !== "arbitrage_entry" && mode !== "manual_entry") {
      throw new RwaAutomationControlError(400, "mode_invalid", "mode 仅允许 arbitrage_entry 或 manual_entry；connectivity smoke 未开放。");
    }
    this.admitRequest("preflight", sourceIp, userId, "unknown");
    const registry = this.registry(userId);
    const accountConnector = await registry.findByAccountId(accountId);
    const governedVenue = accountConnector?.venue ?? "unknown";
    return this.governed("preflight", sourceIp, userId, governedVenue, accountConnector ? accountId : "unconfigured", async () => {
      await registry.initialize();
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
      const connector = registry.findForOpportunity(opportunity);
      if (!connector) {
        throw new RwaAutomationControlError(501, "opportunity_adapter_unavailable", "该机会对应的 venue/标的 adapter 尚未实现或默认 disabled。");
      }
      const configuredAccountId = await connector.getConfiguredAccountId();
      if (
        (accountConnector && accountConnector.venue !== connector.venue)
        || (configuredAccountId && configuredAccountId !== accountId)
      ) {
        throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与套利机会所属交易所不匹配。");
      }
      await connector.assertRiskCapacity?.();
      const releaseReservation = this.reserveChallenge(userId);
      let challenge;
      try {
        challenge = await connector.preflight(opportunity, accountId, mode);
      } finally {
        releaseReservation();
      }
      this.cleanupChallenges();
      this.assertChallengeCapacity(userId, 1);
      this.challengeVenues.set(challenge.challengeId, {
        userId,
        venue: connector.venue,
        accountId,
        notionalUsd: reportNotional(challenge.report),
        expiresAt: this.now() + this.governance.config.challengeTtlMs,
      });
      return challenge;
    });
  }

  async execute(userId: string, sessionDomain: string, input: unknown, sourceIp = "unknown") {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "challengeId", "challengeToken", "idempotencyKey", "stepUpToken"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    this.admitRequest("execute", sourceIp, userId, "unknown");
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
    this.cleanupChallenges();
    const challenge = this.challengeVenues.get(challengeId);
    if (!challenge) throw new RwaAutomationControlError(409, "challenge_disarmed", "challenge 不存在或服务重启后已解除 armed，请重新 preflight。");
    if (challenge.userId !== userId) throw new RwaAutomationControlError(404, "challenge_not_found", "challenge 不存在或不属于当前用户。");
    if (accountId !== challenge.accountId) throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 challenge 不匹配。");
    return this.governed("execute", sourceIp, userId, challenge.venue, accountId, async () => {
      await registry.initialize();
      await accountConnector?.assertRiskCapacity?.();
      const sanitized = omitStepUp(body);
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "hedge_execute",
        venue: challenge.venue,
        accountId,
        resourceId: challengeId,
        requestDigest: canonicalRequestDigest(sanitized),
        notionalUsd: challenge.notionalUsd,
      });
      return registry.requireImplemented(challenge.venue).execute(sanitized);
    });
  }

  async getPositions(userId: string, sourceIp = "unknown") {
    this.admitRequest("private_read", sourceIp, userId, "multi");
    return this.governed("private_read", sourceIp, userId, "multi", "all-accounts", async () => {
      const registry = this.registry(userId);
      await registry.initialize();
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
    });
  }

  async getPnl(userId: string, sourceIp = "unknown") {
    this.admitRequest("private_read", sourceIp, userId, "multi");
    return this.governed("private_read", sourceIp, userId, "multi", "all-accounts", async () => {
      const registry = this.registry(userId);
      await registry.initialize();
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
    });
  }

  async getAudit(userId: string, sourceIp = "unknown") {
    this.admitRequest("private_read", sourceIp, userId, "multi");
    return this.governed("private_read", sourceIp, userId, "multi", "all-accounts", async () => {
      const registry = this.registry(userId);
      await registry.initialize();
      const venues = [];
      for (const venue of registry.listVenues()) {
        const connector = registry.getImplemented(venue);
        if (!connector) continue;
        venues.push({ venue, ...(await connector.getAudit() as Record<string, unknown>) });
      }
      return { venues, governance: this.governance.auditForUser(userId) };
    });
  }

  async getReconciliation(userId: string, venue: string, input: unknown, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "reconciliationId"]);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const configuredAccountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, connector.venue, configuredAccountId, async () => {
      await registry.initialize();
      return connector.getReconciliation(body);
    });
  }

  async closePosition(userId: string, sessionDomain: string, positionId: string, input: unknown, sourceIp = "unknown") {
    const [venue] = positionId.split(":", 1);
    if (!venue) throw new RwaAutomationControlError(400, "position_id_invalid", "positionId 格式无效。");
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "idempotencyKey", "stepUpToken"]);
    const sanitized = omitStepUp(body);
    const accountId = requiredString(sanitized.accountId, "accountId", 100);
    this.admitRequest("position_close", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const configuredAccountId = await connector.getConfiguredAccountId();
    return this.governed("position_close", sourceIp, userId, connector.venue, configuredAccountId ?? "unconfigured", async () => {
      await registry.initialize();
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "position_close",
        venue: connector.venue,
        accountId,
        resourceId: positionId,
        requestDigest: canonicalRequestDigest({ positionId, ...sanitized }),
        notionalUsd: null,
      });
      return connector.closeAll(sanitized);
    });
  }

  async closeAll(userId: string, sessionDomain: string, venue: string, input: unknown, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "idempotencyKey", "stepUpToken"]);
    const sanitized = omitStepUp(body);
    const accountId = requiredString(sanitized.accountId, "accountId", 100);
    this.admitRequest("close_all", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const configuredAccountId = await connector.getConfiguredAccountId();
    return this.governed("close_all", sourceIp, userId, connector.venue, configuredAccountId ?? "unconfigured", async () => {
      await registry.initialize();
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "close_all",
        venue: connector.venue,
        accountId,
        resourceId: null,
        requestDigest: canonicalRequestDigest(sanitized),
        notionalUsd: null,
      });
      return connector.closeAll(sanitized);
    });
  }

  async finalizeReconciliation(userId: string, sessionDomain: string, venue: string, input: unknown, sourceIp = "unknown") {
    const normalizedVenue = normalizeVenue(venue);
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "reconciliationId", "idempotencyKey", "stepUpToken"]);
    const sanitized = omitStepUp(body);
    const accountId = requiredString(sanitized.accountId, "accountId", 100);
    this.admitRequest("close_all", sourceIp, userId, normalizedVenue);
    const registry = this.registry(userId);
    const connector = registry.requireImplemented(normalizedVenue);
    const configuredAccountId = await connector.getConfiguredAccountId();
    return this.governed("close_all", sourceIp, userId, connector.venue, configuredAccountId ?? "unconfigured", async () => {
      await registry.initialize();
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "reconciliation_finalize",
        venue: connector.venue,
        accountId,
        resourceId: typeof sanitized.reconciliationId === "string" ? sanitized.reconciliationId : null,
        requestDigest: canonicalRequestDigest(sanitized),
        notionalUsd: null,
      });
      return connector.finalizeReconciliation(sanitized);
    });
  }

  async resolveStepUpIntent(userId: string, input: unknown, sourceIp = "unknown"): Promise<StepUpIntent> {
    const body = record(input);
    assertOnlyKeys(body, ["operation", "venue", "accountId", "resourceId", "requestDigest"]);
    const operation = normalizeStepUpOperation(body.operation);
    const venue = normalizeVenue(requiredString(body.venue, "venue", 20));
    this.admitRequest("private_read", sourceIp, userId, venue);
    const connector = this.registry(userId).requireImplemented(venue);
    const configuredAccountId = await connector.getConfiguredAccountId();
    return this.governed("private_read", sourceIp, userId, venue, configuredAccountId ?? "unconfigured", async () => {
      const accountId = requiredString(body.accountId, "accountId", 100);
      if (operation === "credential_put") {
        const expected = configuredAccountId ?? "new-account";
        if (accountId !== expected) throw new RwaAutomationControlError(409, "account_mismatch", "二次验证账户意图与当前绑定状态不匹配。");
      } else if (!configuredAccountId || configuredAccountId !== accountId) {
        throw new RwaAutomationControlError(409, "account_mismatch", "二次验证账户意图不属于当前用户。");
      }
      if (!validRequestDigest(body.requestDigest)) throw new RwaAutomationControlError(400, "invalid_request", "requestDigest 格式无效。");
      const resourceId = body.resourceId === null || body.resourceId === undefined
        ? null
        : requiredString(body.resourceId, "resourceId", 200);
      let notionalUsd: number | null = null;
      if (operation === "hedge_execute") {
        if (!resourceId) throw new RwaAutomationControlError(400, "invalid_request", "建立对冲组合需要绑定 preflight challenge。");
        this.cleanupChallenges();
        const challenge = this.challengeVenues.get(resourceId);
        if (!challenge || challenge.userId !== userId || challenge.venue !== venue || challenge.accountId !== accountId) {
          throw new RwaAutomationControlError(409, "challenge_disarmed", "preflight challenge 不存在或不属于当前会话范围。");
        }
        notionalUsd = challenge.notionalUsd;
      } else if (operation === "position_close") {
        if (!resourceId || !resourceId.startsWith(`${venue}:`)) throw new RwaAutomationControlError(400, "position_id_invalid", "positionId 格式无效。");
      } else if (resourceId !== null) {
        throw new RwaAutomationControlError(400, "invalid_request", "当前操作不接受 resourceId。");
      }
      return { operation, venue, accountId, resourceId, requestDigest: body.requestDigest, notionalUsd };
    });
  }

  private consumeStepUp(userId: string, sessionDomain: string, tokenValue: unknown, intent: StepUpIntent) {
    if (typeof tokenValue !== "string" || !tokenValue.trim()) {
      throw new StepUpSecurityError(403, "step_up_required", "该敏感操作需要新的二次身份验证。");
    }
    const stepUpToken = requiredString(tokenValue, "stepUpToken", 200);
    return this.stepUpSecurity.consume(userId, sessionDomain, stepUpToken, intent);
  }

  private admitRequest(
    operation: RwaAutomationGovernedOperation,
    sourceIp: string,
    userId: string,
    venue: RwaAutomationGovernanceContext["venue"],
  ) {
    this.governance.admitRequest({ operation, sourceIp, userId, venue });
  }

  private async governed<T>(
    operation: RwaAutomationGovernedOperation,
    sourceIp: string,
    userId: string,
    venue: RwaAutomationGovernanceContext["venue"],
    accountId: string,
    action: () => Promise<T>,
  ) {
    const admission = this.governance.enter({ operation, sourceIp, userId, venue, accountId });
    this.activeRegistryUsers.set(userId, (this.activeRegistryUsers.get(userId) ?? 0) + 1);
    try {
      return await action();
    } finally {
      admission.release();
      const active = this.activeRegistryUsers.get(userId) ?? 0;
      if (active <= 1) this.activeRegistryUsers.delete(userId);
      else this.activeRegistryUsers.set(userId, active - 1);
    }
  }

  private cleanupRegistries() {
    const cutoff = this.now() - this.governance.config.registryIdleTtlMs;
    this.cleanupChallenges();
    for (const [userId, entry] of this.registries) {
      if (
        entry.lastUsedAt > cutoff
        || this.activeRegistryUsers.has(userId)
        || entry.registry.hasActivityMonitor()
        || [...this.challengeVenues.values()].some((challenge) => challenge.userId === userId)
      ) continue;
      entry.registry.dispose();
      this.registries.delete(userId);
    }
  }

  private cleanupChallenges() {
    const now = this.now();
    for (const [id, challenge] of this.challengeVenues) {
      if (challenge.expiresAt <= now) this.challengeVenues.delete(id);
    }
  }

  private assertChallengeCapacity(userId: string, pending = 0) {
    this.cleanupChallenges();
    const userCount = [...this.challengeVenues.values()].filter((item) => item.userId === userId).length;
    const reservedForUser = this.challengeReservations.get(userId) ?? 0;
    const totalReserved = [...this.challengeReservations.values()].reduce((sum, value) => sum + value, 0);
    if (
      this.challengeVenues.size + totalReserved + pending > this.governance.config.maxChallengesGlobal
      || userCount + reservedForUser + pending > this.governance.config.maxChallengesPerUser
    ) {
      throw new RwaAutomationGovernanceError(503, "automation_capacity_exceeded", "自动套利 challenge 容量已满；已拒绝新增风险操作。");
    }
  }

  private reserveChallenge(userId: string) {
    this.assertChallengeCapacity(userId, 1);
    this.challengeReservations.set(userId, (this.challengeReservations.get(userId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.challengeReservations.get(userId) ?? 0;
      if (current <= 1) this.challengeReservations.delete(userId);
      else this.challengeReservations.set(userId, current - 1);
    };
  }
}

export class RwaAutomationControlError extends Error {
  constructor(
    readonly statusCode: number,
    readonly category: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function automationErrorResponse(error: unknown) {
  if (
    error instanceof RwaAutomationControlError
    || error instanceof RwaAutomationRegistryError
    || error instanceof RwaNeutralExecutionError
    || error instanceof StepUpSecurityError
    || error instanceof StepUpSecurityStoreError
    || error instanceof RwaAutomationGovernanceError
    || error instanceof RwaAutomationExecutionLeaseError
    || error instanceof CredentialStoreError
    || error instanceof CredentialKeyProviderError
  ) {
    return {
      statusCode:
        error instanceof StepUpSecurityStoreError
        || error instanceof RwaAutomationExecutionLeaseError
        || error instanceof CredentialStoreError
        || error instanceof CredentialKeyProviderError
          ? 503
          : error.statusCode,
      retryAfterSeconds: "retryAfterSeconds" in error ? error.retryAfterSeconds : undefined,
      body: {
        category: error.category,
        message: error.message,
        ...(error instanceof RwaAutomationControlError && error.details ? error.details : {}),
        ...(error instanceof RwaNeutralExecutionError && error.details ? error.details : {}),
      },
    };
  }
  return { statusCode: 500, body: { category: "automation_internal_error", message: "自动套利服务暂不可用。" } };
}

function omitStepUp(body: Record<string, any>) {
  const { stepUpToken: _stepUpToken, ...sanitized } = body;
  return sanitized;
}

function normalizeStepUpOperation(value: unknown): StepUpOperation {
  const allowed: StepUpOperation[] = [
    "credential_put", "credential_delete", "execution_enable", "kill_switch_disable",
    "hedge_execute", "position_close", "close_all", "reconciliation_finalize",
  ];
  if (!allowed.includes(value as StepUpOperation)) throw new RwaAutomationControlError(400, "invalid_request", "operation 不受支持。");
  return value as StepUpOperation;
}

function reportNotional(report: unknown) {
  const value = Number((report as { estimatedCapitalRequiredUsd?: unknown })?.estimatedCapitalRequiredUsd);
  return Number.isFinite(value) && value >= 0 ? value : null;
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
  return passphrase === undefined ? { apiKey, apiSecret } : { apiKey, apiSecret, passphrase };
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

type CredentialPutStage = "validation" | "binding" | "identity_rollback" | "binding_rollback";

type CredentialPutDiagnosticContext = {
  requestId: string;
  venue: RwaAutomationVenue;
  userId: string;
  sensitiveValues: Array<unknown>;
};

function normalizeCredentialPutError(
  error: unknown,
  stage: CredentialPutStage,
  context: CredentialPutDiagnosticContext,
) {
  if (stage === "validation") {
    logCredentialPutEvent("provider_validation_failed", context, {
      category: categoryOfCredentialPutError(error),
      error,
      stage,
      statusCode: statusCodeOfCredentialPutError(error),
    });
  }
  if (
    error instanceof RwaAutomationControlError
    || error instanceof RwaAutomationRegistryError
    || error instanceof RwaNeutralExecutionError
    || error instanceof StepUpSecurityError
    || error instanceof StepUpSecurityStoreError
    || error instanceof RwaAutomationGovernanceError
    || error instanceof RwaAutomationExecutionLeaseError
    || error instanceof CredentialStoreError
    || error instanceof CredentialKeyProviderError
  ) {
    return withCredentialPutDetails(error, context, stage);
  }
  const category = stage === "binding" ? "credential_binding_unavailable" : "credential_validation_unavailable";
  return withCredentialPutDetails(new RwaAutomationControlError(
    503,
    category,
    stage === "binding"
      ? "交易所账户绑定记录暂不可用，请稍后重试。"
      : `${venueLabel(context.venue)} 凭证校验暂不可用，请稍后重试。`,
  ), context, stage, error);
}

function logCredentialPutEvent(
  event: "route_received" | "step_up_consumed" | "provider_validation_started" | "provider_validation_failed" | "response",
  context: CredentialPutDiagnosticContext,
  options: {
    category?: string;
    error?: unknown;
    stage?: CredentialPutStage;
    statusCode?: number;
  } = {},
) {
  const payload: Record<string, unknown> = {
    event: "rwa_automation_credential_put",
    stage: event,
    requestId: context.requestId,
    venue: context.venue,
    userRef: stableHash(context.userId),
  };
  if (options.stage) payload.failureStage = options.stage;
  if (options.category) payload.responseCategory = options.category;
  if (options.statusCode !== undefined) payload.statusCode = options.statusCode;
  if (options.error !== undefined) {
    const providerCode = providerCodeFromError(options.error);
    payload.errorCategory = categoryFromRwaAutomationError(options.error);
    payload.errorClass = options.error instanceof Error ? options.error.constructor.name : typeof options.error;
    if (providerCode !== null) payload.providerCode = providerCode;
    payload.safeMessage = sanitizeCredentialPutDiagnosticMessage(options.error, context.sensitiveValues);
  }
  const writer = event === "provider_validation_failed" ? console.warn : console.info;
  writer(JSON.stringify(payload));
}

async function rollbackCredentialMutation(
  connector: Pick<NonNullable<RwaAutomationConnectorLike>, "restoreCredentialMutationSnapshot" | "venue">,
  snapshot: unknown,
  stage: "identity" | "binding",
  context: CredentialPutDiagnosticContext,
) {
  if (snapshot === undefined || !connector.restoreCredentialMutationSnapshot) {
    return;
  }
  try {
    await connector.restoreCredentialMutationSnapshot(snapshot);
  } catch (error) {
    logCredentialPutEvent("response", context, {
      category: "credential_binding_rollback_failed",
      error,
      stage: stage === "identity" ? "identity_rollback" : "binding_rollback",
      statusCode: 503,
    });
    throw withCredentialPutDetails(
      new RwaAutomationControlError(503, "credential_binding_rollback_failed", "交易所账户绑定回滚失败；系统已保持执行关闭，请稍后重试。"),
      context,
      stage === "identity" ? "identity_rollback" : "binding_rollback",
      error,
    );
  }
}

type RwaAutomationConnectorLike = {
  venue: RwaAutomationVenue;
  restoreCredentialMutationSnapshot?: (snapshot: unknown) => Promise<void>;
};

function augmentCredentialPutError(error: unknown, context: CredentialPutDiagnosticContext) {
  return withCredentialPutDetails(error, context, "validation");
}

function withCredentialPutDetails(
  error: unknown,
  context: CredentialPutDiagnosticContext,
  stage: CredentialPutStage,
  sourceError?: unknown,
) {
  const existingStage = (
    error instanceof RwaNeutralExecutionError
      ? error.details?.stage
      : error instanceof RwaAutomationControlError
        ? error.details?.stage
        : null
  );
  const details = {
    requestId: context.requestId,
    stage: typeof existingStage === "string" ? existingStage : stage,
    ...(providerCodeFromError(sourceError ?? error) !== null
      ? { providerCode: providerCodeFromError(sourceError ?? error) }
      : {}),
  };
  if (error instanceof RwaNeutralExecutionError) {
    return new RwaNeutralExecutionError(error.statusCode, error.category, error.message, {
      ...error.details,
      ...details,
    });
  }
  if (error instanceof RwaAutomationControlError) {
    return new RwaAutomationControlError(error.statusCode, error.category, error.message, {
      ...error.details,
      ...details,
    });
  }
  return error;
}

function statusCodeOfCredentialPutError(error: unknown) {
  if (
    error instanceof RwaAutomationControlError
    || error instanceof RwaAutomationRegistryError
    || error instanceof RwaNeutralExecutionError
    || error instanceof StepUpSecurityError
    || error instanceof RwaAutomationGovernanceError
  ) return error.statusCode;
  if (
    error instanceof StepUpSecurityStoreError
    || error instanceof RwaAutomationExecutionLeaseError
    || error instanceof CredentialStoreError
    || error instanceof CredentialKeyProviderError
  ) return 503;
  return 500;
}

function categoryOfCredentialPutError(error: unknown) {
  if (
    error instanceof RwaAutomationControlError
    || error instanceof RwaAutomationRegistryError
    || error instanceof RwaNeutralExecutionError
    || error instanceof StepUpSecurityError
    || error instanceof StepUpSecurityStoreError
    || error instanceof RwaAutomationGovernanceError
    || error instanceof RwaAutomationExecutionLeaseError
    || error instanceof CredentialStoreError
    || error instanceof CredentialKeyProviderError
  ) return error.category;
  return "automation_internal_error";
}

function providerCodeFromError(error: unknown) {
  const value = error instanceof RwaNeutralExecutionError
    ? error.details?.providerCode
    : error instanceof RwaAutomationControlError
      ? error.details?.providerCode
      : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeCredentialPutDiagnosticMessage(error: unknown, sensitiveValues: Array<unknown>) {
  let message = sanitizeRwaAutomationError(error);
  for (const value of sensitiveValues) {
    if (typeof value !== "string" || !value.trim()) continue;
    message = message.split(value).join("[secret]");
  }
  return message;
}
