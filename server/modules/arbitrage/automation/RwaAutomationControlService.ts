import type { ArbitrageDashboardService } from "../ArbitrageDashboardService";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { randomUUID } from "node:crypto";
import {
  CredentialStoreError,
  discoverAutomationUsersWithExposure,
  rwaAutomationUserDomain,
} from "./RwaAutomationPersistentStore";
import {
  RwaAutomationConnectorRegistry,
  RwaAutomationRegistryError,
  normalizeVenue,
} from "./RwaAutomationConnectorRegistry";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import type {
  RwaAutomationCandidate,
  RwaAutomationConnector,
  RwaAutomationMode,
  RwaAutomationVenue,
  RwaVenueCredentialInput,
} from "./RwaAutomationTypes";
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
import {
  assertAccountAssetAuthorizationPreview,
  RWA_ASSET_AUTHORIZATION_PREVIEW_TTL_MS,
  RwaAccountAssetAuthorizationError,
  validateAccountAssetAuthorizationPreview,
  type RwaAccountAssetAuthorizationPreview,
} from "./RwaAccountAssetAuthorization";
import {
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
  RwaAutomationAssetProfileError,
} from "./RwaAutomationAssetProfile";
import {
  assertRwaAssetTakeoverPreview,
  RWA_ASSET_TAKEOVER_PREVIEW_TTL_MS,
  RwaAssetTakeoverError,
  validateRwaAssetTakeoverPreview,
  type RwaAssetTakeoverPreview,
} from "./RwaAssetTakeover";
import {
  RWA_ASSET_EXIT_PREVIEW_TTL_MS,
  validateRwaAssetTakeoverExitPreview,
  type RwaAssetTakeoverExitPreview,
} from "./RwaAssetTakeoverRuntime";
import { RwaAssetTakeoverRuntimeError } from "./RwaAssetTakeoverRuntimeEngine";

export class RwaAutomationControlService {
  private challengeVenues = new Map<string, {
    userId: string;
    venue: RwaAutomationVenue;
    accountId: string;
    notionalUsd: number | null;
    expiresAt: number;
    purpose: "hedge_execute" | "connectivity_smoke_execute";
  }>();
  private readonly assetAuthorizationPreviews = new Map<string, {
    userId: string;
    userDomain: string;
    sessionDomain: string;
    venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
    accountId: string;
    accountFingerprint: string;
    assetId: string;
    profileId: string;
    policyVersion: string;
    policyDigest: string;
    stateDigest: string;
    ordersDigest: string;
    generatedAt: number;
    expiresAt: number;
    requestDigest: string;
    preview: RwaAccountAssetAuthorizationPreview;
    intentResolvedAt: number | null;
    claimed: boolean;
  }>();
  private readonly assetAuthorizationPreviewReservations = new Map<string, number>();
  private readonly assetTakeoverPreviews = new Map<string, {
    userId: string;
    userDomain: string;
    sessionDomain: string;
    venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
    accountId: string;
    assetId: string;
    takeoverId: string | null;
    mode: "start" | "reconfirm";
    preview: RwaAssetTakeoverPreview;
    requestDigest: string;
    intentResolvedAt: number | null;
    claimed: boolean;
    expiresAt: number;
  }>();
  private readonly assetTakeoverPreviewReservations = new Map<string, number>();
  private readonly assetTakeoverExitPreviews = new Map<string, {
    userId: string;
    userDomain: string;
    sessionDomain: string;
    venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
    accountId: string;
    assetId: string;
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
    requestDigest: string;
    claimed: boolean;
    expiresAt: number;
  }>();
  private readonly assetTakeoverExitPreviewReservations = new Map<string, number>();
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
    this.assetAuthorizationPreviews.clear();
    this.assetAuthorizationPreviewReservations.clear();
    this.assetTakeoverPreviews.clear();
    this.assetTakeoverPreviewReservations.clear();
    this.assetTakeoverExitPreviews.clear();
    this.assetTakeoverExitPreviewReservations.clear();
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
        this.invalidateAssetAuthorizationPreviews(userId, connector.venue);
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
      this.invalidateAssetAuthorizationPreviews(userId, connector.venue);
      const result = await connector.deleteCredentials(sanitized);
      this.stepUpSecurity.revokeAutomationScope(userId, connector.venue, accountId);
      return result;
    });
  }

  async getAccountAssetAuthorization(
    userId: string,
    venue: string,
    assetId: string,
    sourceIp = "unknown",
  ) {
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, connector.venue, accountId, () =>
      connector.getAccountAssetAuthorization(normalizedAssetId));
  }

  async previewAccountAssetAuthorization(
    userId: string,
    venue: string,
    assetId: string,
    input: unknown,
    sourceIp = "unknown",
    sessionDomain?: string,
  ) {
    const body = record(input);
    assertOnlyKeys(body, []);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    const boundSessionDomain = requiredString(sessionDomain, "sessionDomain", 200);
    const releaseReservation = this.reserveAssetAuthorizationPreview(userId);
    try {
      return await this.governed("private_read", sourceIp, userId, connector.venue, accountId, async () => {
        const preview = await connector.previewAccountAssetAuthorization(normalizedAssetId);
        return this.issueAssetAuthorizationPreview({
          userId,
          sessionDomain: boundSessionDomain,
          venue: connector.venue,
          accountId,
          assetId: normalizedAssetId,
          preview,
        });
      });
    } finally {
      releaseReservation();
    }
  }

  async createAccountAssetAuthorization(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, ["preview", "stepUpToken"]);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    const preview = validateAccountAssetAuthorizationPreview(body.preview);
    this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    const issuance = this.claimAssetAuthorizationPreview({
      userId,
      sessionDomain,
      venue: connector.venue,
      accountId,
      assetId: normalizedAssetId,
      preview,
    });
    try {
      return await this.governed("risk_control", sourceIp, userId, connector.venue, accountId, async () => {
        const current = await connector.previewAccountAssetAuthorization(normalizedAssetId);
        assertAccountAssetAuthorizationPreview({
          provided: issuance.preview,
          current,
          now: this.now(),
        });
        await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
          operation: "asset_authorization_create",
          venue: connector.venue,
          accountId,
          resourceId: normalizedAssetId,
          requestDigest: issuance.requestDigest,
          notionalUsd: issuance.preview.maxManagedNotionalUsd,
        });
        return connector.createAccountAssetAuthorization(normalizedAssetId, issuance.preview);
      });
    } finally {
      this.assetAuthorizationPreviews.delete(preview.previewId);
    }
  }

  async revokeAccountAssetAuthorization(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, ["stepUpToken"]);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    return this.governed("risk_control", sourceIp, userId, connector.venue, accountId, async () => {
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "asset_authorization_revoke",
        venue: connector.venue,
        accountId,
        resourceId: normalizedAssetId,
        requestDigest: assetAuthorizationRevokeDigest(normalizedAssetId),
        notionalUsd: null,
      });
      const result = await connector.revokeAccountAssetAuthorization(normalizedAssetId);
      this.invalidateAssetAuthorizationPreviews(userId, connector.venue);
      this.stepUpSecurity.revokeAutomationScope(userId, connector.venue, accountId);
      return result;
    });
  }

  async previewAssetTakeover(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, ["leverage", "newCapitalUsd"]);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    const newCapitalUsd = positiveNumber(body.newCapitalUsd, "newCapitalUsd");
    const leverage = takeoverLeverage(body.leverage);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverConnector(connector);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    const release = this.reserveAssetTakeoverPreview(userId);
    try {
      return await this.governed("private_read", sourceIp, userId, normalizedVenue, accountId, async () => {
        const preview = await capability.previewAssetTakeover({
          assetId: normalizedAssetId,
          newCapitalUsd,
          leverage,
        });
        return this.issueAssetTakeoverPreview({
          userId,
          sessionDomain,
          venue: normalizedVenue,
          accountId,
          assetId: normalizedAssetId,
          takeoverId: null,
          mode: "start",
          preview,
        });
      });
    } finally {
      release();
    }
  }

  async startAssetTakeover(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, ["idempotencyKey", "preview", "stepUpToken"]);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    const preview = validateRwaAssetTakeoverPreview(body.preview);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 128);
    this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverConnector(connector);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    let claimed = false;
    try {
      return await this.governed("risk_control", sourceIp, userId, normalizedVenue, accountId, async () => {
        const issuance = this.claimAssetTakeoverPreview({
          userId,
          sessionDomain,
          venue: normalizedVenue,
          accountId,
          assetId: normalizedAssetId,
          takeoverId: null,
          mode: "start",
          preview,
        });
        claimed = true;
        await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
          operation: "asset_takeover_start",
          venue: normalizedVenue,
          accountId,
          resourceId: normalizedAssetId,
          requestDigest: issuance.requestDigest,
          notionalUsd: preview.totalManagedCapitalUsd,
        });
        const result = await capability.startAssetTakeover({
          assetId: normalizedAssetId,
          preview: issuance.preview,
          idempotencyKey,
        });
        return this.issueReconfirmationFromResult({
          userId,
          sessionDomain,
          venue: normalizedVenue,
          accountId,
          assetId: normalizedAssetId,
          result,
        });
      });
    } finally {
      if (claimed) this.assetTakeoverPreviews.delete(preview.previewId);
    }
  }

  async reconfirmAssetTakeover(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    takeoverId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, ["preview"]);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    const normalizedTakeoverId = requiredString(takeoverId, "takeoverId", 100);
    const preview = validateRwaAssetTakeoverPreview(body.preview);
    this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverConnector(connector);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    let claimed = false;
    try {
      return await this.governed("risk_control", sourceIp, userId, normalizedVenue, accountId, async () => {
        this.claimAssetTakeoverPreview({
          userId,
          sessionDomain,
          venue: normalizedVenue,
          accountId,
          assetId: normalizedAssetId,
          takeoverId: normalizedTakeoverId,
          mode: "reconfirm",
          preview,
        });
        claimed = true;
        const result = await capability.reconfirmAssetTakeover({
          takeoverId: normalizedTakeoverId,
          preview,
        });
        return this.issueReconfirmationFromResult({
          userId,
          sessionDomain,
          venue: normalizedVenue,
          accountId,
          assetId: normalizedAssetId,
          result,
        });
      });
    } finally {
      if (claimed) this.assetTakeoverPreviews.delete(preview.previewId);
    }
  }

  async getAssetTakeoverStatus(
    userId: string,
    venue: string,
    assetId: string,
    takeoverId: string,
    sourceIp = "unknown",
  ) {
    const normalizedVenue = normalizeVenue(venue);
    enabledAssetId(assetId, normalizedVenue);
    const normalizedTakeoverId = requiredString(takeoverId, "takeoverId", 100);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverConnector(connector);
    const accountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, normalizedVenue, accountId, () =>
      capability.getAssetTakeoverStatus(normalizedTakeoverId));
  }

  async getCurrentAssetTakeover(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    sourceIp = "unknown",
  ) {
    requiredString(sessionDomain, "sessionDomain", 200);
    const normalizedVenue = normalizeVenue(venue);
    enabledAssetId(assetId, normalizedVenue);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverLifecycleConnector(connector);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    return this.governed("private_read", sourceIp, userId, normalizedVenue, accountId, () =>
      capability.getCurrentAssetTakeover());
  }

  async abortAssetTakeover(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    takeoverId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, []);
    requiredString(sessionDomain, "sessionDomain", 200);
    const normalizedVenue = normalizeVenue(venue);
    enabledAssetId(assetId, normalizedVenue);
    const normalizedTakeoverId = requiredString(takeoverId, "takeoverId", 100);
    this.admitRequest("risk_control", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverLifecycleConnector(connector);
    const context = await capability.getAssetTakeoverAbortContext({
      takeoverId: normalizedTakeoverId,
    });
    const accountId = requiredString(context.accountId, "accountId", 200);
    return this.governed("risk_control", sourceIp, userId, normalizedVenue, accountId, () =>
      capability.abortAssetTakeover({ takeoverId: normalizedTakeoverId }));
  }

  async previewAssetTakeoverExit(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    takeoverId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, []);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    const normalizedTakeoverId = requiredString(takeoverId, "takeoverId", 100);
    const boundSessionDomain = requiredString(sessionDomain, "sessionDomain", 200);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverExitConnector(connector);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    return this.governed("private_read", sourceIp, userId, normalizedVenue, accountId, async () => {
      const release = this.reserveAssetTakeoverExitPreview(userId);
      try {
        const preview = await capability.previewAssetTakeoverExit({
          takeoverId: normalizedTakeoverId,
        });
        return this.issueAssetTakeoverExitPreview({
          userId,
          sessionDomain: boundSessionDomain,
          venue: normalizedVenue,
          accountId,
          assetId: normalizedAssetId,
          takeoverId: normalizedTakeoverId,
          preview,
        });
      } finally {
        release();
      }
    });
  }

  async confirmAssetTakeoverExit(
    userId: string,
    sessionDomain: string,
    venue: string,
    assetId: string,
    takeoverId: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, ["idempotencyKey", "preview"]);
    const normalizedVenue = normalizeVenue(venue);
    const normalizedAssetId = enabledAssetId(assetId, normalizedVenue);
    const normalizedTakeoverId = requiredString(takeoverId, "takeoverId", 100);
    const preview = exitPreview(body.preview);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 128);
    this.admitRequest("asset_takeover_exit", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverExitConnector(connector);
    const accountId = await connector.getConfiguredAccountId();
    if (!accountId) {
      throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
    }
    let claimed = false;
    try {
      return await this.governed(
        "asset_takeover_exit",
        sourceIp,
        userId,
        normalizedVenue,
        accountId,
        async () => {
          const issuance = this.claimAssetTakeoverExitPreview({
            userId,
            sessionDomain,
            venue: normalizedVenue,
            accountId,
            assetId: normalizedAssetId,
            takeoverId: normalizedTakeoverId,
            preview,
          });
          claimed = true;
          return capability.confirmAssetTakeoverExit({
            takeoverId: normalizedTakeoverId,
            preview: issuance.preview,
            idempotencyKey,
          });
        },
      );
    } finally {
      if (claimed) this.assetTakeoverExitPreviews.delete(preview.previewId);
    }
  }

  async getAssetTakeoverExitStatus(
    userId: string,
    venue: string,
    assetId: string,
    takeoverId: string,
    sourceIp = "unknown",
  ) {
    const normalizedVenue = normalizeVenue(venue);
    enabledAssetId(assetId, normalizedVenue);
    const normalizedTakeoverId = requiredString(takeoverId, "takeoverId", 100);
    this.admitRequest("private_read", sourceIp, userId, normalizedVenue);
    const connector = this.registry(userId).requireImplemented(normalizedVenue);
    const capability = requireTakeoverExitConnector(connector);
    const accountId = await connector.getConfiguredAccountId() ?? "unconfigured";
    return this.governed("private_read", sourceIp, userId, normalizedVenue, accountId, () =>
      capability.getAssetTakeoverExitStatus(normalizedTakeoverId));
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
        purpose: "hedge_execute",
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
    if (challenge.purpose !== "hedge_execute") throw new RwaAutomationControlError(409, "challenge_scope_mismatch", "challenge 不属于套利建仓操作。");
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

  async preflightConnectivitySmoke(userId: string, input: unknown, sourceIp = "unknown") {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "mode", "policyAcceptance"]);
    if (body.mode !== "connectivity_smoke") {
      throw new RwaAutomationControlError(400, "mode_invalid", "mode 必须为 connectivity_smoke。");
    }
    const accountId = requiredString(body.accountId, "accountId", 100);
    this.admitRequest("preflight", sourceIp, userId, "binance");
    const registry = this.registry(userId);
    const connector = await registry.findByAccountId(accountId);
    if (!connector || connector.venue !== "binance" || !connector.preflightConnectivitySmoke) {
      throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 Binance 烟测账户不匹配。");
    }
    return this.governed("preflight", sourceIp, userId, "binance", accountId, async () => {
      await registry.initialize();
      await connector.assertRiskCapacity?.();
      const challenge = await connector.preflightConnectivitySmoke!(accountId, body.policyAcceptance) as any;
      this.cleanupChallenges();
      this.assertChallengeCapacity(userId, 1);
      this.challengeVenues.set(challenge.challengeId, {
        userId,
        venue: "binance",
        accountId,
        notionalUsd: positiveNumber(
          challenge.report?.budget?.totalCapitalUsd,
          "connectivitySmokeBudgetTotalUsd",
        ),
        expiresAt: challenge.expiresAt,
        purpose: "connectivity_smoke_execute",
      });
      return challenge;
    });
  }

  async getConnectivitySmokePolicy(userId: string, input: unknown, sourceIp = "unknown") {
    const query = record(input);
    assertOnlyKeys(query, ["accountId"]);
    const accountId = requiredString(query.accountId, "accountId", 100);
    this.admitRequest("private_read", sourceIp, userId, "binance");
    const registry = this.registry(userId);
    const connector = registry.requireImplemented("binance");
    const configuredAccountId = await connector.getConfiguredAccountId();
    if (
      !configuredAccountId
      || configuredAccountId !== accountId
      || !connector.getConnectivitySmokePolicy
    ) {
      throw new RwaAutomationControlError(
        409,
        "account_mismatch",
        "accountId 与当前用户已绑定的 Binance smoke 账户不匹配。",
      );
    }
    return this.governed("private_read", sourceIp, userId, "binance", accountId, async () =>
      connector.getConnectivitySmokePolicy!(accountId));
  }

  async executeConnectivitySmoke(
    userId: string,
    sessionDomain: string,
    input: unknown,
    sourceIp = "unknown",
  ) {
    const body = record(input);
    assertOnlyKeys(body, [
      "accountId", "challengeId", "challengeToken", "idempotencyKey", "stepUpToken",
      "policyVersion", "policyDigest",
    ]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const challengeId = requiredString(body.challengeId, "challengeId", 100);
    this.admitRequest("execute", sourceIp, userId, "binance");
    const sanitized = omitStepUp(body);
    const requestDigest = canonicalRequestDigest(sanitized);
    const registry = this.registry(userId);
    const accountConnector = await registry.findByAccountId(accountId);
    if (!accountConnector || accountConnector.venue !== "binance") {
      throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 Binance 烟测账户不匹配。");
    }
    return this.governed("execute", sourceIp, userId, "binance", accountId, async () => {
      await registry.initialize();
      if (accountConnector.findConnectivitySmokeIdempotent) {
        const idempotent = await accountConnector.findConnectivitySmokeIdempotent({
          accountId,
          challengeId,
          idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey", 100),
          requestDigest,
        });
        if (idempotent) return idempotent;
      }
      this.cleanupChallenges();
      const challenge = this.challengeVenues.get(challengeId);
      if (!challenge || challenge.userId !== userId || challenge.venue !== "binance") {
        throw new RwaAutomationControlError(409, "challenge_disarmed", "smoke challenge 不存在或已解除 armed。");
      }
      if (challenge.purpose !== "connectivity_smoke_execute") {
        throw new RwaAutomationControlError(409, "challenge_scope_mismatch", "challenge 不属于 connectivity smoke。");
      }
      if (challenge.accountId !== accountId) {
        throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 smoke challenge 不匹配。");
      }
      if (!accountConnector.executeConnectivitySmoke) {
        throw new RwaAutomationControlError(501, "venue_not_implemented", "Binance smoke adapter 尚未实现。");
      }
      await accountConnector.assertRiskCapacity?.();
      await this.consumeStepUp(userId, sessionDomain, body.stepUpToken, {
        operation: "connectivity_smoke_execute",
        venue: "binance",
        accountId,
        resourceId: challengeId,
        requestDigest,
        notionalUsd: challenge.notionalUsd,
      });
      return accountConnector.executeConnectivitySmoke({ ...sanitized, requestDigest });
    });
  }

  async getConnectivitySmokeStatus(userId: string, input: unknown, sourceIp = "unknown") {
    const query = record(input);
    assertOnlyKeys(query, ["accountId", "smokeId"]);
    const accountId = requiredString(query.accountId, "accountId", 100);
    this.admitRequest("private_read", sourceIp, userId, "binance");
    return this.governed("private_read", sourceIp, userId, "binance", accountId, async () => {
      const registry = this.registry(userId);
      await registry.initialize();
      const connector = await registry.findByAccountId(accountId);
      if (!connector || connector.venue !== "binance" || !connector.getConnectivitySmokeStatus) {
        throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 Binance 烟测账户不匹配。");
      }
      return connector.getConnectivitySmokeStatus(
        typeof query.smokeId === "string" && query.smokeId ? query.smokeId : undefined,
      );
    });
  }

  async lookupConnectivitySmokeExecution(userId: string, input: unknown, sourceIp = "unknown") {
    const body = record(input);
    assertOnlyKeys(body, ["accountId", "challengeId", "idempotencyKey"]);
    const accountId = requiredString(body.accountId, "accountId", 100);
    const challengeId = requiredString(body.challengeId, "challengeId", 100);
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey", 100);
    if (!/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) {
      throw new RwaAutomationControlError(400, "invalid_request", "idempotencyKey 格式无效。");
    }
    this.admitRequest("private_read", sourceIp, userId, "binance");
    const registry = this.registry(userId);
    const connector = await registry.findByAccountId(accountId);
    if (!connector || connector.venue !== "binance" || !connector.lookupConnectivitySmokeExecution) {
      throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 Binance 烟测账户不匹配。");
    }
    return this.governed("private_read", sourceIp, userId, "binance", accountId, async () =>
      connector.lookupConnectivitySmokeExecution!({ accountId, challengeId, idempotencyKey }));
  }

  async getConnectivitySmokeReceipt(userId: string, smokeId: string, input: unknown, sourceIp = "unknown") {
    const query = record(input);
    assertOnlyKeys(query, ["accountId"]);
    const accountId = requiredString(query.accountId, "accountId", 100);
    this.admitRequest("private_read", sourceIp, userId, "binance");
    return this.governed("private_read", sourceIp, userId, "binance", accountId, async () => {
      const registry = this.registry(userId);
      await registry.initialize();
      const connector = await registry.findByAccountId(accountId);
      if (!connector || connector.venue !== "binance" || !connector.getConnectivitySmokeReceipt) {
        throw new RwaAutomationControlError(409, "account_mismatch", "accountId 与 Binance 烟测账户不匹配。");
      }
      return connector.getConnectivitySmokeReceipt(requiredString(smokeId, "smokeId", 100));
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

  async resolveStepUpIntent(
    userId: string,
    input: unknown,
    sourceIp = "unknown",
    sessionDomain?: string,
  ): Promise<StepUpIntent> {
    const body = record(input);
    assertOnlyKeys(body, [
      "operation",
      "venue",
      "accountId",
      "resourceId",
      "requestDigest",
      "authorizationPreview",
      "takeoverPreview",
    ]);
    const operation = normalizeStepUpOperation(body.operation);
    const venue = normalizeVenue(requiredString(body.venue, "venue", 20));
    this.admitRequest("private_read", sourceIp, userId, venue);
    const connector = this.registry(userId).requireImplemented(venue);
    const configuredAccountId = await connector.getConfiguredAccountId();
    return this.governed("private_read", sourceIp, userId, venue, configuredAccountId ?? "unconfigured", async () => {
      const authorizationOperation = operation === "asset_authorization_create"
        || operation === "asset_authorization_revoke";
      const serverBoundOperation = authorizationOperation || operation === "asset_takeover_start";
      if (serverBoundOperation && body.accountId !== undefined) {
        throw new RwaAutomationControlError(400, "invalid_request", "资产授权或接管操作不接受客户端账户标识。");
      }
      const accountId = serverBoundOperation
        ? configuredAccountId
        : requiredString(body.accountId, "accountId", 100);
      if (!accountId) {
        throw new RwaAutomationControlError(409, "credential_not_configured", "该 venue 尚未配置执行账户凭证。");
      }
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
      if (authorizationOperation) {
        if (!resourceId) {
          throw new RwaAutomationControlError(400, "invalid_request", "资产授权操作需要绑定 assetId。");
        }
        const assetId = enabledAssetId(resourceId, venue);
        if (operation === "asset_authorization_create") {
          const preview = validateAccountAssetAuthorizationPreview(body.authorizationPreview);
          const issuance = this.requireAssetAuthorizationPreview({
            userId,
            sessionDomain: requiredString(sessionDomain, "sessionDomain", 200),
            venue,
            accountId,
            assetId,
            preview,
          });
          const current = await connector.previewAccountAssetAuthorization(assetId);
          assertAccountAssetAuthorizationPreview({ provided: issuance.preview, current, now: this.now() });
          if (body.requestDigest !== issuance.requestDigest) {
            throw new RwaAutomationControlError(
              409,
              "request_digest_mismatch",
              "二次验证请求与当前资产授权预览不匹配。",
            );
          }
          issuance.intentResolvedAt = this.now();
          notionalUsd = issuance.preview.maxManagedNotionalUsd;
        } else {
          if (body.authorizationPreview !== undefined) {
            throw new RwaAutomationControlError(400, "invalid_request", "撤销资产授权不接受授权预览。");
          }
          if (!(await connector.getAccountAssetAuthorization(assetId))) {
            throw new RwaAccountAssetAuthorizationError(
              409,
              "asset_authorization_required",
              "当前账户资产尚未启用管理授权。",
            );
          }
          if (body.requestDigest !== assetAuthorizationRevokeDigest(assetId)) {
            throw new RwaAutomationControlError(
              409,
              "request_digest_mismatch",
              "二次验证请求与当前资产授权撤销操作不匹配。",
            );
          }
        }
      } else if (operation === "asset_takeover_start") {
        if (!resourceId) {
          throw new RwaAutomationControlError(400, "invalid_request", "资产接管需要绑定 assetId。");
        }
        if (body.authorizationPreview !== undefined) {
          throw new RwaAutomationControlError(400, "invalid_request", "资产接管不接受授权预览。");
        }
        const assetId = enabledAssetId(resourceId, venue);
        const preview = validateRwaAssetTakeoverPreview(body.takeoverPreview);
        const issuance = this.requireAssetTakeoverPreview({
          userId,
          sessionDomain: requiredString(sessionDomain, "sessionDomain", 200),
          venue,
          accountId,
          assetId,
          takeoverId: null,
          mode: "start",
          preview,
        });
        const capability = requireTakeoverConnector(connector);
        const current = await capability.previewAssetTakeover({
          assetId,
          newCapitalUsd: preview.newCapitalUsd,
          leverage: preview.selectedLeverage,
        });
        assertRwaAssetTakeoverPreview({ provided: issuance.preview, current, now: this.now() });
        if (body.requestDigest !== issuance.requestDigest) {
          throw new RwaAutomationControlError(
            409,
            "request_digest_mismatch",
            "二次验证请求与当前资产接管预览不匹配。",
          );
        }
        issuance.intentResolvedAt = this.now();
        notionalUsd = preview.totalManagedCapitalUsd;
      } else if (body.authorizationPreview !== undefined || body.takeoverPreview !== undefined) {
        throw new RwaAutomationControlError(400, "invalid_request", "当前操作不接受资产授权预览。");
      } else if (operation === "hedge_execute" || operation === "connectivity_smoke_execute") {
        if (!resourceId) throw new RwaAutomationControlError(400, "invalid_request", "执行操作需要绑定 preflight challenge。");
        this.cleanupChallenges();
        const challenge = this.challengeVenues.get(resourceId);
        if (!challenge || challenge.userId !== userId || challenge.venue !== venue || challenge.accountId !== accountId) {
          throw new RwaAutomationControlError(409, "challenge_disarmed", "preflight challenge 不存在或不属于当前会话范围。");
        }
        if (challenge.purpose !== operation) {
          throw new RwaAutomationControlError(409, "challenge_scope_mismatch", "preflight challenge 与二次验证操作不匹配。");
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

  private issueAssetTakeoverPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    takeoverId: string | null;
    mode: "start" | "reconfirm";
    preview: RwaAssetTakeoverPreview;
  }) {
    const preview = validateRwaAssetTakeoverPreview(input.preview);
    const now = this.now();
    if (
      preview.venue !== input.venue
      || preview.assetId !== input.assetId
      || preview.generatedAt > now
      || preview.expiresAt <= now
      || preview.expiresAt !== preview.generatedAt + RWA_ASSET_TAKEOVER_PREVIEW_TTL_MS
      || this.assetTakeoverPreviews.has(preview.previewId)
    ) throw invalidIssuedAssetTakeoverPreview();
    const requestDigest = assetTakeoverStartDigest(input.assetId, preview);
    this.assetTakeoverPreviews.set(preview.previewId, {
      userId: input.userId,
      userDomain: rwaAutomationUserDomain(input.userId),
      sessionDomain: input.sessionDomain,
      venue: input.venue as Extract<RwaAutomationVenue, "binance" | "bybit">,
      accountId: input.accountId,
      assetId: input.assetId,
      takeoverId: input.takeoverId,
      mode: input.mode,
      preview: { ...preview },
      requestDigest,
      intentResolvedAt: null,
      claimed: false,
      expiresAt: preview.expiresAt,
    });
    return { ...preview };
  }

  private requireAssetTakeoverPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    takeoverId: string | null;
    mode: "start" | "reconfirm";
    preview: RwaAssetTakeoverPreview;
  }) {
    this.cleanupAssetTakeoverPreviews();
    const provided = validateRwaAssetTakeoverPreview(input.preview);
    const record = this.assetTakeoverPreviews.get(provided.previewId);
    if (
      !record
      || record.claimed
      || record.userId !== input.userId
      || record.userDomain !== rwaAutomationUserDomain(input.userId)
      || record.sessionDomain !== input.sessionDomain
      || record.venue !== input.venue
      || record.accountId !== input.accountId
      || record.assetId !== input.assetId
      || record.takeoverId !== input.takeoverId
      || record.mode !== input.mode
      || record.expiresAt <= this.now()
      || record.requestDigest !== assetTakeoverStartDigest(input.assetId, provided)
      || canonicalRequestDigest(record.preview) !== canonicalRequestDigest(provided)
    ) throw invalidIssuedAssetTakeoverPreview();
    return record;
  }

  private claimAssetTakeoverPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    takeoverId: string | null;
    mode: "start" | "reconfirm";
    preview: RwaAssetTakeoverPreview;
  }) {
    const record = this.requireAssetTakeoverPreview(input);
    if (input.mode === "start" && record.intentResolvedAt === null) {
      throw invalidIssuedAssetTakeoverPreview();
    }
    record.claimed = true;
    return record;
  }

  private cleanupAssetTakeoverPreviews() {
    const now = this.now();
    for (const [id, preview] of this.assetTakeoverPreviews) {
      if (preview.expiresAt <= now) this.assetTakeoverPreviews.delete(id);
    }
  }

  private reserveAssetTakeoverPreview(userId: string) {
    this.cleanupChallenges();
    this.cleanupAssetAuthorizationPreviews();
    this.cleanupAssetTakeoverPreviews();
    this.cleanupAssetTakeoverExitPreviews();
    const userCount =
      [...this.challengeVenues.values()].filter((item) => item.userId === userId).length
      + [...this.assetAuthorizationPreviews.values()].filter((item) => item.userId === userId).length
      + [...this.assetTakeoverPreviews.values()].filter((item) => item.userId === userId).length
      + [...this.assetTakeoverExitPreviews.values()].filter((item) => item.userId === userId).length;
    const totalReservations =
      [...this.challengeReservations.values()].reduce((sum, value) => sum + value, 0)
      + [...this.assetAuthorizationPreviewReservations.values()].reduce((sum, value) => sum + value, 0)
      + [...this.assetTakeoverPreviewReservations.values()].reduce((sum, value) => sum + value, 0)
      + [...this.assetTakeoverExitPreviewReservations.values()].reduce((sum, value) => sum + value, 0);
    const userReservations =
      (this.challengeReservations.get(userId) ?? 0)
      + (this.assetAuthorizationPreviewReservations.get(userId) ?? 0)
      + (this.assetTakeoverPreviewReservations.get(userId) ?? 0)
      + (this.assetTakeoverExitPreviewReservations.get(userId) ?? 0);
    if (
      this.challengeVenues.size
        + this.assetAuthorizationPreviews.size
        + this.assetTakeoverPreviews.size
        + this.assetTakeoverExitPreviews.size
        + totalReservations + 1 > this.governance.config.maxChallengesGlobal
      || userCount + userReservations + 1 > this.governance.config.maxChallengesPerUser
    ) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "资产接管预览容量已满；已拒绝继续。",
      );
    }
    this.assetTakeoverPreviewReservations.set(
      userId,
      (this.assetTakeoverPreviewReservations.get(userId) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.assetTakeoverPreviewReservations.get(userId) ?? 0;
      if (current <= 1) this.assetTakeoverPreviewReservations.delete(userId);
      else this.assetTakeoverPreviewReservations.set(userId, current - 1);
    };
  }

  private issueReconfirmationFromResult(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    result: unknown;
  }) {
    const result = record(input.result);
    if (result.reconfirmationPreview === undefined) return input.result;
    const takeoverId = requiredString(result.takeoverId, "takeoverId", 100);
    const preview = validateRwaAssetTakeoverPreview(result.reconfirmationPreview);
    const release = this.reserveAssetTakeoverPreview(input.userId);
    try {
      return {
        ...result,
        reconfirmationPreview: this.issueAssetTakeoverPreview({
          userId: input.userId,
          sessionDomain: input.sessionDomain,
          venue: input.venue,
          accountId: input.accountId,
          assetId: input.assetId,
          takeoverId,
          mode: "reconfirm",
          preview,
        }),
      };
    } finally {
      release();
    }
  }

  private issueAssetTakeoverExitPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
  }) {
    const preview = exitPreview(input.preview);
    const now = this.now();
    if (
      preview.venue !== input.venue
      || preview.assetId !== input.assetId
      || preview.takeoverId !== input.takeoverId
      || preview.generatedAt > now
      || preview.expiresAt <= now
      || preview.expiresAt !== preview.generatedAt + RWA_ASSET_EXIT_PREVIEW_TTL_MS
      || this.assetTakeoverExitPreviews.has(preview.previewId)
    ) throw invalidIssuedAssetTakeoverExitPreview();
    const requestDigest = assetTakeoverExitDigest(input.assetId, input.takeoverId, preview);
    this.assetTakeoverExitPreviews.set(preview.previewId, {
      userId: input.userId,
      userDomain: rwaAutomationUserDomain(input.userId),
      sessionDomain: input.sessionDomain,
      venue: input.venue as Extract<RwaAutomationVenue, "binance" | "bybit">,
      accountId: input.accountId,
      assetId: input.assetId,
      takeoverId: input.takeoverId,
      preview: { ...preview },
      requestDigest,
      claimed: false,
      expiresAt: preview.expiresAt,
    });
    return { ...preview };
  }

  private requireAssetTakeoverExitPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
  }) {
    this.cleanupAssetTakeoverExitPreviews();
    const provided = exitPreview(input.preview);
    const record = this.assetTakeoverExitPreviews.get(provided.previewId);
    if (
      !record
      || record.claimed
      || record.userId !== input.userId
      || record.userDomain !== rwaAutomationUserDomain(input.userId)
      || record.sessionDomain !== input.sessionDomain
      || record.venue !== input.venue
      || record.accountId !== input.accountId
      || record.assetId !== input.assetId
      || record.takeoverId !== input.takeoverId
      || record.expiresAt <= this.now()
      || record.requestDigest !== assetTakeoverExitDigest(input.assetId, input.takeoverId, provided)
      || canonicalRequestDigest(record.preview) !== canonicalRequestDigest(provided)
    ) throw invalidIssuedAssetTakeoverExitPreview();
    return record;
  }

  private claimAssetTakeoverExitPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
  }) {
    const record = this.requireAssetTakeoverExitPreview(input);
    record.claimed = true;
    return record;
  }

  private cleanupAssetTakeoverExitPreviews() {
    const now = this.now();
    for (const [id, preview] of this.assetTakeoverExitPreviews) {
      if (preview.expiresAt <= now) this.assetTakeoverExitPreviews.delete(id);
    }
  }

  private reserveAssetTakeoverExitPreview(userId: string) {
    this.cleanupChallenges();
    this.cleanupAssetAuthorizationPreviews();
    this.cleanupAssetTakeoverPreviews();
    this.cleanupAssetTakeoverExitPreviews();
    const userCount =
      [...this.challengeVenues.values()].filter((item) => item.userId === userId).length
      + [...this.assetAuthorizationPreviews.values()].filter((item) => item.userId === userId).length
      + [...this.assetTakeoverPreviews.values()].filter((item) => item.userId === userId).length
      + [...this.assetTakeoverExitPreviews.values()].filter((item) => item.userId === userId).length;
    const totalReservations =
      [...this.challengeReservations.values()].reduce((sum, value) => sum + value, 0)
      + [...this.assetAuthorizationPreviewReservations.values()].reduce((sum, value) => sum + value, 0)
      + [...this.assetTakeoverPreviewReservations.values()].reduce((sum, value) => sum + value, 0)
      + [...this.assetTakeoverExitPreviewReservations.values()].reduce((sum, value) => sum + value, 0);
    const userReservations =
      (this.challengeReservations.get(userId) ?? 0)
      + (this.assetAuthorizationPreviewReservations.get(userId) ?? 0)
      + (this.assetTakeoverPreviewReservations.get(userId) ?? 0)
      + (this.assetTakeoverExitPreviewReservations.get(userId) ?? 0);
    if (
      this.challengeVenues.size
        + this.assetAuthorizationPreviews.size
        + this.assetTakeoverPreviews.size
        + this.assetTakeoverExitPreviews.size
        + totalReservations + 1 > this.governance.config.maxChallengesGlobal
      || userCount + userReservations + 1 > this.governance.config.maxChallengesPerUser
    ) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "资产退出确认容量已满；已拒绝继续。",
      );
    }
    this.assetTakeoverExitPreviewReservations.set(
      userId,
      (this.assetTakeoverExitPreviewReservations.get(userId) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.assetTakeoverExitPreviewReservations.get(userId) ?? 0;
      if (current <= 1) this.assetTakeoverExitPreviewReservations.delete(userId);
      else this.assetTakeoverExitPreviewReservations.set(userId, current - 1);
    };
  }

  private issueAssetAuthorizationPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    preview: RwaAccountAssetAuthorizationPreview;
  }) {
    const preview = validateAccountAssetAuthorizationPreview(input.preview);
    const profile = requireRwaAutomationExecutionProfile(input.assetId, input.venue);
    const now = this.now();
    if (
      preview.venue !== input.venue
      || preview.assetId !== profile.asset.assetId
      || preview.profileId !== rwaAutomationProfileId(profile)
      || preview.policyVersion !== profile.asset.authorizationPolicy.version
      || preview.policyDigest !== profile.asset.authorizationPolicy.digest
      || preview.generatedAt > now
      || preview.expiresAt <= now
      || preview.expiresAt !== preview.generatedAt + RWA_ASSET_AUTHORIZATION_PREVIEW_TTL_MS
      || this.assetAuthorizationPreviews.has(preview.previewId)
    ) throw invalidIssuedAssetAuthorizationPreview();
    const requestDigest = assetAuthorizationCreateDigest(profile.asset.assetId, preview);
    const record = {
      userId: input.userId,
      userDomain: rwaAutomationUserDomain(input.userId),
      sessionDomain: input.sessionDomain,
      venue: input.venue as Extract<RwaAutomationVenue, "binance" | "bybit">,
      accountId: input.accountId,
      accountFingerprint: preview.accountFingerprint,
      assetId: profile.asset.assetId,
      profileId: preview.profileId,
      policyVersion: preview.policyVersion,
      policyDigest: preview.policyDigest,
      stateDigest: preview.stateDigest,
      ordersDigest: preview.ordersDigest,
      generatedAt: preview.generatedAt,
      expiresAt: preview.expiresAt,
      requestDigest,
      preview: { ...preview },
      intentResolvedAt: null,
      claimed: false,
    };
    this.assetAuthorizationPreviews.set(preview.previewId, record);
    return { ...preview };
  }

  private requireAssetAuthorizationPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    preview: RwaAccountAssetAuthorizationPreview;
  }) {
    this.cleanupAssetAuthorizationPreviews();
    const provided = validateAccountAssetAuthorizationPreview(input.preview);
    const record = this.assetAuthorizationPreviews.get(provided.previewId);
    const now = this.now();
    if (
      !record
      || record.claimed
      || record.userId !== input.userId
      || record.userDomain !== rwaAutomationUserDomain(input.userId)
      || record.sessionDomain !== input.sessionDomain
      || record.venue !== input.venue
      || record.accountId !== input.accountId
      || record.accountFingerprint !== provided.accountFingerprint
      || record.assetId !== input.assetId
      || record.profileId !== provided.profileId
      || record.policyVersion !== provided.policyVersion
      || record.policyDigest !== provided.policyDigest
      || record.stateDigest !== provided.stateDigest
      || record.ordersDigest !== provided.ordersDigest
      || record.generatedAt !== provided.generatedAt
      || record.expiresAt !== provided.expiresAt
      || record.expiresAt !== record.generatedAt + RWA_ASSET_AUTHORIZATION_PREVIEW_TTL_MS
      || record.expiresAt <= now
      || record.requestDigest !== assetAuthorizationCreateDigest(input.assetId, provided)
      || canonicalRequestDigest(record.preview) !== canonicalRequestDigest(provided)
    ) throw invalidIssuedAssetAuthorizationPreview();
    return record;
  }

  private claimAssetAuthorizationPreview(input: {
    userId: string;
    sessionDomain: string;
    venue: RwaAutomationVenue;
    accountId: string;
    assetId: string;
    preview: RwaAccountAssetAuthorizationPreview;
  }) {
    const record = this.requireAssetAuthorizationPreview(input);
    if (record.intentResolvedAt === null) throw invalidIssuedAssetAuthorizationPreview();
    record.claimed = true;
    return record;
  }

  private cleanupAssetAuthorizationPreviews() {
    const now = this.now();
    for (const [id, preview] of this.assetAuthorizationPreviews) {
      if (preview.expiresAt <= now) this.assetAuthorizationPreviews.delete(id);
    }
  }

  private invalidateAssetAuthorizationPreviews(userId: string, venue: RwaAutomationVenue) {
    for (const [id, preview] of this.assetAuthorizationPreviews) {
      if (preview.userId === userId && preview.venue === venue) {
        this.assetAuthorizationPreviews.delete(id);
      }
    }
    for (const [id, preview] of this.assetTakeoverPreviews) {
      if (preview.userId === userId && preview.venue === venue) {
        this.assetTakeoverPreviews.delete(id);
      }
    }
    for (const [id, preview] of this.assetTakeoverExitPreviews) {
      if (preview.userId === userId && preview.venue === venue) {
        this.assetTakeoverExitPreviews.delete(id);
      }
    }
  }

  private reserveAssetAuthorizationPreview(userId: string) {
    this.cleanupChallenges();
    this.cleanupAssetAuthorizationPreviews();
    this.cleanupAssetTakeoverPreviews();
    this.cleanupAssetTakeoverExitPreviews();
    const userPreviewCount = [...this.assetAuthorizationPreviews.values()]
      .filter((item) => item.userId === userId).length;
    const userChallengeCount = [...this.challengeVenues.values()]
      .filter((item) => item.userId === userId).length;
    const reservedForUser = this.assetAuthorizationPreviewReservations.get(userId) ?? 0;
    const totalPreviewReserved = [...this.assetAuthorizationPreviewReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    const totalChallengeReserved = [...this.challengeReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    const userTakeoverPreviewCount = [...this.assetTakeoverPreviews.values()]
      .filter((item) => item.userId === userId).length;
    const takeoverReservedForUser = this.assetTakeoverPreviewReservations.get(userId) ?? 0;
    const totalTakeoverReserved = [...this.assetTakeoverPreviewReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    const userExitPreviewCount = [...this.assetTakeoverExitPreviews.values()]
      .filter((item) => item.userId === userId).length;
    const exitReservedForUser = this.assetTakeoverExitPreviewReservations.get(userId) ?? 0;
    const totalExitReserved = [...this.assetTakeoverExitPreviewReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    if (
      this.assetAuthorizationPreviews.size
        + this.assetTakeoverPreviews.size
        + this.assetTakeoverExitPreviews.size
        + this.challengeVenues.size
        + totalPreviewReserved
        + totalTakeoverReserved
        + totalExitReserved
        + totalChallengeReserved
        + 1 > this.governance.config.maxChallengesGlobal
      || userPreviewCount
        + userTakeoverPreviewCount
        + userExitPreviewCount
        + userChallengeCount
        + reservedForUser
        + takeoverReservedForUser
        + exitReservedForUser
        + (this.challengeReservations.get(userId) ?? 0)
        + 1 > this.governance.config.maxChallengesPerUser
    ) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "账户资产授权预览容量已满；已拒绝继续。",
      );
    }
    this.assetAuthorizationPreviewReservations.set(userId, reservedForUser + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.assetAuthorizationPreviewReservations.get(userId) ?? 0;
      if (current <= 1) this.assetAuthorizationPreviewReservations.delete(userId);
      else this.assetAuthorizationPreviewReservations.set(userId, current - 1);
    };
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
    this.cleanupAssetAuthorizationPreviews();
    this.cleanupAssetTakeoverPreviews();
    this.cleanupAssetTakeoverExitPreviews();
    for (const [userId, entry] of this.registries) {
      if (
        entry.lastUsedAt > cutoff
        || this.activeRegistryUsers.has(userId)
        || entry.registry.hasActivityMonitor()
        || [...this.challengeVenues.values()].some((challenge) => challenge.userId === userId)
        || [...this.assetAuthorizationPreviews.values()].some((preview) => preview.userId === userId)
        || [...this.assetTakeoverPreviews.values()].some((preview) => preview.userId === userId)
        || [...this.assetTakeoverExitPreviews.values()].some((preview) => preview.userId === userId)
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
    this.cleanupAssetAuthorizationPreviews();
    this.cleanupAssetTakeoverPreviews();
    this.cleanupAssetTakeoverExitPreviews();
    const userCount = [...this.challengeVenues.values()].filter((item) => item.userId === userId).length;
    const userPreviewCount = [...this.assetAuthorizationPreviews.values()]
      .filter((item) => item.userId === userId).length;
    const userTakeoverPreviewCount = [...this.assetTakeoverPreviews.values()]
      .filter((item) => item.userId === userId).length;
    const userExitPreviewCount = [...this.assetTakeoverExitPreviews.values()]
      .filter((item) => item.userId === userId).length;
    const reservedForUser = this.challengeReservations.get(userId) ?? 0;
    const totalReserved = [...this.challengeReservations.values()].reduce((sum, value) => sum + value, 0);
    const previewReservedForUser = this.assetAuthorizationPreviewReservations.get(userId) ?? 0;
    const totalPreviewReserved = [...this.assetAuthorizationPreviewReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    const takeoverReservedForUser = this.assetTakeoverPreviewReservations.get(userId) ?? 0;
    const totalTakeoverReserved = [...this.assetTakeoverPreviewReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    const exitReservedForUser = this.assetTakeoverExitPreviewReservations.get(userId) ?? 0;
    const totalExitReserved = [...this.assetTakeoverExitPreviewReservations.values()]
      .reduce((sum, value) => sum + value, 0);
    if (
      this.challengeVenues.size
        + this.assetAuthorizationPreviews.size
        + this.assetTakeoverPreviews.size
        + this.assetTakeoverExitPreviews.size
        + totalReserved
        + totalPreviewReserved
        + totalTakeoverReserved
        + totalExitReserved
        + pending > this.governance.config.maxChallengesGlobal
      || userCount
        + userPreviewCount
        + userTakeoverPreviewCount
        + userExitPreviewCount
        + reservedForUser
        + previewReservedForUser
        + takeoverReservedForUser
        + exitReservedForUser
        + pending > this.governance.config.maxChallengesPerUser
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
    || error instanceof RwaAccountAssetAuthorizationError
    || error instanceof RwaAssetTakeoverError
    || error instanceof RwaAssetTakeoverRuntimeError
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
    "hedge_execute", "connectivity_smoke_execute", "position_close", "close_all", "reconciliation_finalize",
    "asset_authorization_create", "asset_authorization_revoke", "asset_takeover_start",
  ];
  if (!allowed.includes(value as StepUpOperation)) throw new RwaAutomationControlError(400, "invalid_request", "operation 不受支持。");
  return value as StepUpOperation;
}

function enabledAssetId(assetId: string, venue: string) {
  try {
    return requireRwaAutomationExecutionProfile(assetId, venue).asset.assetId;
  } catch (error) {
    if (error instanceof RwaAutomationAssetProfileError) {
      throw new RwaAutomationControlError(409, error.category, "该资产尚未开放自动套利授权。");
    }
    throw error;
  }
}

function assetAuthorizationCreateDigest(
  assetId: string,
  preview: ReturnType<typeof validateAccountAssetAuthorizationPreview>,
) {
  return canonicalRequestDigest({ assetId, preview });
}

function assetAuthorizationRevokeDigest(assetId: string) {
  return canonicalRequestDigest({ assetId });
}

function assetTakeoverStartDigest(
  assetId: string,
  preview: ReturnType<typeof validateRwaAssetTakeoverPreview>,
) {
  return canonicalRequestDigest({ assetId, preview });
}

function assetTakeoverExitDigest(
  assetId: string,
  takeoverId: string,
  preview: RwaAssetTakeoverExitPreview,
) {
  return canonicalRequestDigest({ action: "exit_all", assetId, takeoverId, preview });
}

function exitPreview(value: unknown) {
  try {
    return validateRwaAssetTakeoverExitPreview(value);
  } catch {
    throw invalidIssuedAssetTakeoverExitPreview();
  }
}

function invalidIssuedAssetTakeoverExitPreview() {
  return new RwaAssetTakeoverRuntimeError(
    409,
    "asset_takeover_exit_preview_invalid",
    "资产退出确认不存在、已过期、已使用或与当前状态不匹配，请重新获取。",
  );
}

function invalidIssuedAssetTakeoverPreview() {
  return new RwaAssetTakeoverError(
    409,
    "asset_takeover_preview_invalid",
    "资产接管预览不存在、已过期或已使用，请重新获取。",
  );
}

function takeoverLeverage(value: unknown): 1 | 2 | 3 {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new RwaAutomationControlError(400, "invalid_request", "leverage 仅支持 1、2 或 3。");
}

function positiveNumber(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RwaAutomationControlError(400, "invalid_request", `${name} 必须是有限正数。`);
  }
  return value;
}

function requireTakeoverConnector(connector: RwaAutomationConnector) {
  if (
    !connector.previewAssetTakeover
    || !connector.startAssetTakeover
    || !connector.reconfirmAssetTakeover
    || !connector.getAssetTakeoverStatus
  ) {
    throw new RwaAutomationControlError(501, "asset_takeover_unavailable", "该 venue 尚未实现资产接管。");
  }
  return connector as RwaAutomationConnector & Required<Pick<
    RwaAutomationConnector,
    "previewAssetTakeover" | "startAssetTakeover" | "reconfirmAssetTakeover" | "getAssetTakeoverStatus"
  >>;
}

function requireTakeoverLifecycleConnector(connector: RwaAutomationConnector) {
  if (
    !connector.getCurrentAssetTakeover
    || !connector.getAssetTakeoverAbortContext
    || !connector.abortAssetTakeover
  ) {
    throw new RwaAutomationControlError(501, "asset_takeover_unavailable", "该 venue 尚未实现资产接管恢复。");
  }
  return connector as RwaAutomationConnector & Required<Pick<
    RwaAutomationConnector,
    "getCurrentAssetTakeover" | "getAssetTakeoverAbortContext" | "abortAssetTakeover"
  >>;
}

function requireTakeoverExitConnector(connector: RwaAutomationConnector) {
  if (
    !connector.previewAssetTakeoverExit
    || !connector.confirmAssetTakeoverExit
    || !connector.getAssetTakeoverExitStatus
  ) {
    throw new RwaAutomationControlError(501, "asset_takeover_exit_unavailable", "该 venue 尚未实现资产退出。");
  }
  return connector as RwaAutomationConnector & Required<Pick<
    RwaAutomationConnector,
    "previewAssetTakeoverExit" | "confirmAssetTakeoverExit" | "getAssetTakeoverExitStatus"
  >>;
}

function invalidIssuedAssetAuthorizationPreview() {
  return new RwaAccountAssetAuthorizationError(
    409,
    "asset_authorization_preview_invalid",
    "账户资产授权预览不存在、已过期或已使用，请重新获取。",
  );
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
