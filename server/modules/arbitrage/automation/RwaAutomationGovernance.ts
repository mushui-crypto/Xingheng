import { createHash } from "node:crypto";
import type { RwaAutomationVenue } from "./RwaAutomationTypes";

export type RwaAutomationGovernedOperation =
  | "credential"
  | "risk_control"
  | "preflight"
  | "execute"
  | "position_close"
  | "close_all"
  | "asset_takeover_exit"
  | "private_read";

export type RwaAutomationGovernanceContext = {
  operation: RwaAutomationGovernedOperation;
  sourceIp: string;
  userId: string;
  venue: RwaAutomationVenue | "multi" | "unknown";
  accountId: string;
};

export type RwaAutomationGovernanceConfig = {
  credentialMax: number;
  credentialWindowMs: number;
  riskControlMax: number;
  riskControlWindowMs: number;
  preflightBurstMax: number;
  preflightBurstWindowMs: number;
  preflightSustainedMax: number;
  preflightSustainedWindowMs: number;
  executeBurstMax: number;
  executeBurstWindowMs: number;
  executeSustainedMax: number;
  executeSustainedWindowMs: number;
  exitOperationMax: number;
  exitOperationWindowMs: number;
  exitSharedMax: number;
  exitSharedWindowMs: number;
  exitReserveMax: number;
  exitReserveWindowMs: number;
  privateReadMax: number;
  privateReadWindowMs: number;
  executeConcurrencyPerAccount: number;
  exitConcurrencyPerAccount: number;
  maxInFlight: number;
  maxInFlightPerUser: number;
  maxBuckets: number;
  maxBucketsPerUser: number;
  maxAuditEntries: number;
  maxAuditEntriesPerUser: number;
  challengeTtlMs: number;
  maxChallengesGlobal: number;
  maxChallengesPerUser: number;
  maxRegistries: number;
  registryIdleTtlMs: number;
  maxStepUpAuthorizationsGlobal: number;
  maxStepUpAuthorizationsPerUser: number;
  maxStepUpAttempts: number;
  maxStepUpAttemptsPerUser: number;
  maxStepUpStores: number;
  stateCompletedExecutionRetentionMs: number;
  stateMaxCompletedExecutions: number;
  stateMaxCompletedExecutionsHard: number;
  stateMaxActiveExecutions: number;
  stateMaxPnlPoints: number;
  stateMaxCredentialAuditEntries: number;
  stateMaxBytes: number;
  stateMaxBytesHard: number;
};

type RateSpec = {
  family: string;
  max: number;
  windowMs: number;
};

type Bucket = {
  userDomain: string;
  count: number;
  resetAt: number;
};

type GovernanceAudit = {
  operation: RwaAutomationGovernedOperation;
  venue: RwaAutomationGovernanceContext["venue"];
  result: "allowed" | "rate_limited" | "concurrency_limited" | "exit_reserve";
  category: string;
  occurredAt: number;
};

const defaultConfig: RwaAutomationGovernanceConfig = {
  credentialMax: 4,
  credentialWindowMs: 10 * 60_000,
  riskControlMax: 6,
  riskControlWindowMs: 10 * 60_000,
  preflightBurstMax: 4,
  preflightBurstWindowMs: 10_000,
  preflightSustainedMax: 30,
  preflightSustainedWindowMs: 10 * 60_000,
  executeBurstMax: 2,
  executeBurstWindowMs: 60_000,
  executeSustainedMax: 6,
  executeSustainedWindowMs: 60 * 60_000,
  exitOperationMax: 8,
  exitOperationWindowMs: 60_000,
  exitSharedMax: 12,
  exitSharedWindowMs: 60_000,
  exitReserveMax: 3,
  exitReserveWindowMs: 60 * 60_000,
  privateReadMax: 120,
  privateReadWindowMs: 60_000,
  executeConcurrencyPerAccount: 1,
  exitConcurrencyPerAccount: 1,
  maxInFlight: 1_000,
  maxInFlightPerUser: 10,
  maxBuckets: 20_000,
  maxBucketsPerUser: 200,
  maxAuditEntries: 5_000,
  maxAuditEntriesPerUser: 100,
  challengeTtlMs: 60_000,
  maxChallengesGlobal: 5_000,
  maxChallengesPerUser: 20,
  maxRegistries: 1_000,
  registryIdleTtlMs: 30 * 60_000,
  maxStepUpAuthorizationsGlobal: 10_000,
  maxStepUpAuthorizationsPerUser: 20,
  maxStepUpAttempts: 20_000,
  maxStepUpAttemptsPerUser: 100,
  maxStepUpStores: 1_000,
  stateCompletedExecutionRetentionMs: 30 * 24 * 60 * 60_000,
  stateMaxCompletedExecutions: 2_000,
  stateMaxCompletedExecutionsHard: 2_200,
  stateMaxActiveExecutions: 100,
  stateMaxPnlPoints: 1_000,
  stateMaxCredentialAuditEntries: 500,
  stateMaxBytes: 8 * 1024 * 1024,
  stateMaxBytesHard: 10 * 1024 * 1024,
};

export class RwaAutomationGovernanceError extends Error {
  constructor(
    readonly statusCode: 429 | 503,
    readonly category: "automation_rate_limited" | "automation_concurrency_limited"
      | "automation_capacity_exceeded" | "automation_risk_state_invalid",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export class RwaAutomationGovernance {
  private readonly buckets = new Map<string, Bucket>();
  private readonly inFlight = new Map<string, number>();
  private readonly audit = new Map<string, GovernanceAudit[]>();

  constructor(
    readonly config = loadRwaAutomationGovernanceConfig(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  admitRequest(context: Omit<RwaAutomationGovernanceContext, "accountId">) {
    const now = this.now();
    this.cleanup(now);
    const userDomain = domain("user", context.userId);
    const ipDomain = domain("ip", context.sourceIp || "unknown");
    const consume = (specs: RateSpec[]) => {
      const candidates = specs.flatMap((spec) => {
        const admissionSpec = { ...spec, family: `admission-${spec.family}` };
        return [
          `global-user:${userDomain}`,
          `global-ip:${ipDomain}`,
          `venue-user:${userDomain}:${context.venue}`,
          `venue-ip:${ipDomain}:${context.venue}`,
        ].map((scope) => this.bucketCandidate(scope, admissionSpec, userDomain, now));
      });
      this.consumeCandidates(context, candidates, userDomain, now);
    };
    try {
      consume(this.rateSpecs(context.operation));
    } catch (error) {
      if (!isExitOperation(context.operation) || !(error instanceof RwaAutomationGovernanceError)) throw error;
      consume([{
        family: "exit-reserve",
        max: this.config.exitReserveMax,
        windowMs: this.config.exitReserveWindowMs,
      }]);
    }
  }

  enter(context: RwaAutomationGovernanceContext) {
    const now = this.now();
    this.cleanup(now);
    const userDomain = domain("user", context.userId);
    const specs = this.rateSpecs(context.operation);
    let usedExitReserve = false;
    try {
      this.consumeSpecs(context, specs, userDomain, now);
    } catch (error) {
      if (!isExitOperation(context.operation) || !(error instanceof RwaAutomationGovernanceError)) throw error;
      this.consumeSpecs(context, [{
        family: "exit-reserve",
        max: this.config.exitReserveMax,
        windowMs: this.config.exitReserveWindowMs,
      }], userDomain, now);
      usedExitReserve = true;
    }

    const concurrency = this.concurrencyPolicy(context);
    let concurrencyKey: string | null = null;
    if (concurrency) {
      concurrencyKey = [
        concurrency.family,
        userDomain,
        context.venue,
        domain("account", context.accountId),
      ].join(":");
      const current = this.inFlight.get(concurrencyKey) ?? 0;
      if (current >= concurrency.max) {
        this.appendAudit(userDomain, context, "concurrency_limited", "automation_concurrency_limited", now);
        throw new RwaAutomationGovernanceError(
          429,
          "automation_concurrency_limited",
          isExitOperation(context.operation)
            ? "该账户已有退出操作正在进行；请等待当前退出完成。"
            : "该账户已有自动套利操作正在进行；请稍后重试。",
          1,
        );
      }
      const userInFlight = [...this.inFlight.keys()].filter((key) => key.includes(`:${userDomain}:`)).length;
      if (
        !this.inFlight.has(concurrencyKey)
        && (this.inFlight.size >= this.config.maxInFlight || userInFlight >= this.config.maxInFlightPerUser)
      ) {
        throw new RwaAutomationGovernanceError(
          503,
          "automation_capacity_exceeded",
          "自动套利并发安全状态容量已满；已拒绝新增风险操作。",
        );
      }
      this.inFlight.set(concurrencyKey, current + 1);
    }

    this.appendAudit(
      userDomain,
      context,
      usedExitReserve ? "exit_reserve" : "allowed",
      usedExitReserve ? "automation_exit_reserve_used" : "ok",
      now,
    );
    let released = false;
    return {
      usedExitReserve,
      release: () => {
        if (released || !concurrencyKey) return;
        released = true;
        const current = this.inFlight.get(concurrencyKey) ?? 0;
        if (current <= 1) this.inFlight.delete(concurrencyKey);
        else this.inFlight.set(concurrencyKey, current - 1);
      },
    };
  }

  auditForUser(userId: string) {
    return [...(this.audit.get(domain("user", userId)) ?? [])];
  }

  inspect() {
    return {
      bucketCount: this.buckets.size,
      inFlightCount: this.inFlight.size,
      auditCount: [...this.audit.values()].reduce((sum, entries) => sum + entries.length, 0),
    };
  }

  private consumeSpecs(
    context: RwaAutomationGovernanceContext,
    specs: RateSpec[],
    userDomain: string,
    now: number,
  ) {
    const candidates = specs.flatMap((spec) => this.bucketCandidates(context, userDomain, spec, now));
    this.consumeCandidates(context, candidates, userDomain, now);
  }

  private consumeCandidates(
    context: Omit<RwaAutomationGovernanceContext, "accountId">,
    candidates: Array<{ key: string; spec: RateSpec; entry: Bucket }>,
    userDomain: string,
    now: number,
  ) {
    const blocked = candidates
      .filter(({ entry, spec }) => entry.count >= spec.max)
      .sort((left, right) => left.entry.resetAt - right.entry.resetAt)[0];
    if (blocked) {
      const retryAfter = Math.max(1, Math.ceil((blocked.entry.resetAt - now) / 1000));
      this.appendAudit(userDomain, context, "rate_limited", "automation_rate_limited", now);
      throw new RwaAutomationGovernanceError(
        429,
        "automation_rate_limited",
        isExitOperation(context.operation)
          ? "退出请求过于频繁；已保留急停和交易所人工退出路径。"
          : "自动套利请求过于频繁，请稍后再试。",
        retryAfter,
      );
    }
    const newKeys = candidates.filter(({ key }) => !this.buckets.has(key));
    if (newKeys.length) this.assertBucketCapacity(userDomain, newKeys.length);
    for (const { key, entry } of candidates) {
      entry.count += 1;
      this.buckets.set(key, entry);
    }
  }

  private bucketCandidates(
    context: RwaAutomationGovernanceContext,
    userDomain: string,
    spec: RateSpec,
    now: number,
  ) {
    const ipDomain = domain("ip", context.sourceIp || "unknown");
    const accountDomain = domain("account", context.accountId);
    const scopes = [
      `combined:${ipDomain}:${userDomain}:${context.venue}:${accountDomain}`,
      `user:${userDomain}:${context.venue}:${accountDomain}`,
      `ip:${ipDomain}`,
    ];
    return scopes.map((scope) => this.bucketCandidate(scope, spec, userDomain, now));
  }

  private bucketCandidate(scope: string, spec: RateSpec, userDomain: string, now: number) {
    const key = `${spec.family}:${spec.windowMs}:${scope}`;
    const current = this.buckets.get(key);
    return {
      key,
      spec,
      entry: !current || current.resetAt <= now
        ? { userDomain, count: 0, resetAt: now + spec.windowMs }
        : current,
    };
  }

  private assertBucketCapacity(userDomain: string, additions: number) {
    const userCount = [...this.buckets.values()].filter((entry) => entry.userDomain === userDomain).length;
    if (
      this.buckets.size + additions > this.config.maxBuckets
      || userCount + additions > this.config.maxBucketsPerUser
    ) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "自动套利安全状态容量已满；已拒绝新增风险操作。",
      );
    }
  }

  private cleanup(now: number) {
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(key);
    }
  }

  private appendAudit(
    userDomain: string,
    context: Omit<RwaAutomationGovernanceContext, "accountId">,
    result: GovernanceAudit["result"],
    category: string,
    occurredAt: number,
  ) {
    const userEntries = this.audit.get(userDomain) ?? [];
    userEntries.push({ operation: context.operation, venue: context.venue, result, category, occurredAt });
    if (userEntries.length > this.config.maxAuditEntriesPerUser) {
      userEntries.splice(0, userEntries.length - this.config.maxAuditEntriesPerUser);
    }
    this.audit.set(userDomain, userEntries);
    let total = [...this.audit.values()].reduce((sum, entries) => sum + entries.length, 0);
    if (total <= this.config.maxAuditEntries) return;
    for (const [key, entries] of this.audit) {
      while (entries.length && total > this.config.maxAuditEntries) {
        entries.shift();
        total -= 1;
      }
      if (!entries.length) this.audit.delete(key);
      if (total <= this.config.maxAuditEntries) break;
    }
  }

  private rateSpecs(operation: RwaAutomationGovernedOperation): RateSpec[] {
    if (operation === "credential") {
      return [{ family: "credential", max: this.config.credentialMax, windowMs: this.config.credentialWindowMs }];
    }
    if (operation === "risk_control") {
      return [{ family: "risk-control", max: this.config.riskControlMax, windowMs: this.config.riskControlWindowMs }];
    }
    if (operation === "preflight") {
      return [
        { family: "preflight-burst", max: this.config.preflightBurstMax, windowMs: this.config.preflightBurstWindowMs },
        { family: "preflight-sustained", max: this.config.preflightSustainedMax, windowMs: this.config.preflightSustainedWindowMs },
      ];
    }
    if (operation === "execute") {
      return [
        { family: "execute-burst", max: this.config.executeBurstMax, windowMs: this.config.executeBurstWindowMs },
        { family: "execute-sustained", max: this.config.executeSustainedMax, windowMs: this.config.executeSustainedWindowMs },
      ];
    }
    if (isExitOperation(operation)) {
      return [
        { family: `exit-${operation}`, max: this.config.exitOperationMax, windowMs: this.config.exitOperationWindowMs },
        { family: "exit-shared", max: this.config.exitSharedMax, windowMs: this.config.exitSharedWindowMs },
      ];
    }
    return [{ family: "private-read", max: this.config.privateReadMax, windowMs: this.config.privateReadWindowMs }];
  }

  private concurrencyPolicy(context: RwaAutomationGovernanceContext) {
    if (context.operation === "execute") {
      return { family: "execute", max: this.config.executeConcurrencyPerAccount };
    }
    if (isExitOperation(context.operation)) {
      return { family: "exit", max: this.config.exitConcurrencyPerAccount };
    }
    if (context.operation === "credential" || context.operation === "preflight") {
      return { family: context.operation, max: 1 };
    }
    return null;
  }
}

export function loadRwaAutomationGovernanceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RwaAutomationGovernanceConfig {
  const seconds = (name: string, fallbackMs: number, min: number, max: number) =>
    integer(environment[name] ?? String(fallbackMs / 1000), min, max, name) * 1000;
  const count = (name: string, fallback: number, min: number, max: number) =>
    integer(environment[name] ?? String(fallback), min, max, name);
  const bytes = (name: string, fallback: number, min: number, max: number) =>
    integer(environment[name] ?? String(fallback), min, max, name);
  const value: RwaAutomationGovernanceConfig = {
    credentialMax: count("RWA_AUTOMATION_CREDENTIAL_RATE_MAX", defaultConfig.credentialMax, 1, 20),
    credentialWindowMs: seconds("RWA_AUTOMATION_CREDENTIAL_RATE_WINDOW_SECONDS", defaultConfig.credentialWindowMs, 60, 3_600),
    riskControlMax: count("RWA_AUTOMATION_RISK_CONTROL_RATE_MAX", defaultConfig.riskControlMax, 1, 30),
    riskControlWindowMs: seconds("RWA_AUTOMATION_RISK_CONTROL_RATE_WINDOW_SECONDS", defaultConfig.riskControlWindowMs, 60, 3_600),
    preflightBurstMax: count("RWA_AUTOMATION_PREFLIGHT_BURST_MAX", defaultConfig.preflightBurstMax, 1, 20),
    preflightBurstWindowMs: seconds("RWA_AUTOMATION_PREFLIGHT_BURST_WINDOW_SECONDS", defaultConfig.preflightBurstWindowMs, 1, 60),
    preflightSustainedMax: count("RWA_AUTOMATION_PREFLIGHT_SUSTAINED_MAX", defaultConfig.preflightSustainedMax, 1, 120),
    preflightSustainedWindowMs: seconds("RWA_AUTOMATION_PREFLIGHT_SUSTAINED_WINDOW_SECONDS", defaultConfig.preflightSustainedWindowMs, 60, 3_600),
    executeBurstMax: count("RWA_AUTOMATION_EXECUTE_BURST_MAX", defaultConfig.executeBurstMax, 1, 5),
    executeBurstWindowMs: seconds("RWA_AUTOMATION_EXECUTE_BURST_WINDOW_SECONDS", defaultConfig.executeBurstWindowMs, 10, 300),
    executeSustainedMax: count("RWA_AUTOMATION_EXECUTE_SUSTAINED_MAX", defaultConfig.executeSustainedMax, 1, 24),
    executeSustainedWindowMs: seconds("RWA_AUTOMATION_EXECUTE_SUSTAINED_WINDOW_SECONDS", defaultConfig.executeSustainedWindowMs, 300, 86_400),
    exitOperationMax: count("RWA_AUTOMATION_EXIT_OPERATION_MAX", defaultConfig.exitOperationMax, 1, 60),
    exitOperationWindowMs: seconds("RWA_AUTOMATION_EXIT_OPERATION_WINDOW_SECONDS", defaultConfig.exitOperationWindowMs, 10, 600),
    exitSharedMax: count("RWA_AUTOMATION_EXIT_SHARED_MAX", defaultConfig.exitSharedMax, 1, 120),
    exitSharedWindowMs: seconds("RWA_AUTOMATION_EXIT_SHARED_WINDOW_SECONDS", defaultConfig.exitSharedWindowMs, 10, 600),
    exitReserveMax: count("RWA_AUTOMATION_EXIT_RESERVE_MAX", defaultConfig.exitReserveMax, 1, 12),
    exitReserveWindowMs: seconds("RWA_AUTOMATION_EXIT_RESERVE_WINDOW_SECONDS", defaultConfig.exitReserveWindowMs, 300, 86_400),
    privateReadMax: count("RWA_AUTOMATION_PRIVATE_READ_MAX", defaultConfig.privateReadMax, 10, 600),
    privateReadWindowMs: seconds("RWA_AUTOMATION_PRIVATE_READ_WINDOW_SECONDS", defaultConfig.privateReadWindowMs, 10, 600),
    executeConcurrencyPerAccount: count("RWA_AUTOMATION_EXECUTE_CONCURRENCY", defaultConfig.executeConcurrencyPerAccount, 1, 1),
    exitConcurrencyPerAccount: count("RWA_AUTOMATION_EXIT_CONCURRENCY", defaultConfig.exitConcurrencyPerAccount, 1, 1),
    maxInFlight: count("RWA_AUTOMATION_MAX_IN_FLIGHT", defaultConfig.maxInFlight, 10, 10_000),
    maxInFlightPerUser: count("RWA_AUTOMATION_MAX_IN_FLIGHT_PER_USER", defaultConfig.maxInFlightPerUser, 1, 100),
    maxBuckets: count("RWA_AUTOMATION_MAX_RATE_BUCKETS", defaultConfig.maxBuckets, 1_000, 100_000),
    maxBucketsPerUser: count("RWA_AUTOMATION_MAX_RATE_BUCKETS_PER_USER", defaultConfig.maxBucketsPerUser, 20, 1_000),
    maxAuditEntries: count("RWA_AUTOMATION_MAX_GOVERNANCE_AUDIT", defaultConfig.maxAuditEntries, 100, 50_000),
    maxAuditEntriesPerUser: count("RWA_AUTOMATION_MAX_GOVERNANCE_AUDIT_PER_USER", defaultConfig.maxAuditEntriesPerUser, 10, 1_000),
    challengeTtlMs: seconds("RWA_AUTOMATION_CHALLENGE_TTL_SECONDS", defaultConfig.challengeTtlMs, 30, 120),
    maxChallengesGlobal: count("RWA_AUTOMATION_MAX_CHALLENGES", defaultConfig.maxChallengesGlobal, 100, 50_000),
    maxChallengesPerUser: count("RWA_AUTOMATION_MAX_CHALLENGES_PER_USER", defaultConfig.maxChallengesPerUser, 1, 100),
    maxRegistries: count("RWA_AUTOMATION_MAX_USER_REGISTRIES", defaultConfig.maxRegistries, 10, 10_000),
    registryIdleTtlMs: seconds("RWA_AUTOMATION_REGISTRY_IDLE_TTL_SECONDS", defaultConfig.registryIdleTtlMs, 300, 86_400),
    maxStepUpAuthorizationsGlobal: count("RWA_AUTOMATION_MAX_STEP_UP_AUTHORIZATIONS", defaultConfig.maxStepUpAuthorizationsGlobal, 100, 100_000),
    maxStepUpAuthorizationsPerUser: count("RWA_AUTOMATION_MAX_STEP_UP_AUTHORIZATIONS_PER_USER", defaultConfig.maxStepUpAuthorizationsPerUser, 1, 100),
    maxStepUpAttempts: count("RWA_AUTOMATION_MAX_STEP_UP_ATTEMPTS", defaultConfig.maxStepUpAttempts, 100, 100_000),
    maxStepUpAttemptsPerUser: count("RWA_AUTOMATION_MAX_STEP_UP_ATTEMPTS_PER_USER", defaultConfig.maxStepUpAttemptsPerUser, 5, 1_000),
    maxStepUpStores: count("RWA_AUTOMATION_MAX_STEP_UP_STORES", defaultConfig.maxStepUpStores, 10, 10_000),
    stateCompletedExecutionRetentionMs: seconds("RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS", defaultConfig.stateCompletedExecutionRetentionMs, 30 * 86_400, 90 * 86_400),
    stateMaxCompletedExecutions: count("RWA_AUTOMATION_MAX_COMPLETED_EXECUTIONS", defaultConfig.stateMaxCompletedExecutions, 100, 20_000),
    stateMaxCompletedExecutionsHard: count("RWA_AUTOMATION_MAX_COMPLETED_EXECUTIONS_HARD", defaultConfig.stateMaxCompletedExecutionsHard, 120, 22_000),
    stateMaxActiveExecutions: count("RWA_AUTOMATION_MAX_ACTIVE_EXECUTIONS", defaultConfig.stateMaxActiveExecutions, 10, 500),
    stateMaxPnlPoints: count("RWA_AUTOMATION_MAX_PNL_POINTS", defaultConfig.stateMaxPnlPoints, 100, 10_000),
    stateMaxCredentialAuditEntries: count("RWA_AUTOMATION_MAX_CREDENTIAL_AUDIT", defaultConfig.stateMaxCredentialAuditEntries, 50, 5_000),
    stateMaxBytes: bytes("RWA_AUTOMATION_STATE_MAX_BYTES", defaultConfig.stateMaxBytes, 1024 * 1024, 64 * 1024 * 1024),
    stateMaxBytesHard: bytes("RWA_AUTOMATION_STATE_MAX_BYTES_HARD", defaultConfig.stateMaxBytesHard, 1024 * 1024, 80 * 1024 * 1024),
  };
  if (
    value.preflightSustainedWindowMs <= value.preflightBurstWindowMs
    || value.executeSustainedWindowMs <= value.executeBurstWindowMs
    || value.stateMaxCompletedExecutionsHard < value.stateMaxCompletedExecutions
    || value.stateMaxBytesHard < value.stateMaxBytes
    || value.maxChallengesPerUser > value.maxChallengesGlobal
    || value.maxAuditEntriesPerUser > value.maxAuditEntries
    || value.maxInFlightPerUser > value.maxInFlight
    || value.maxStepUpAttemptsPerUser > value.maxStepUpAttempts
  ) {
    throw new RwaAutomationGovernanceError(503, "automation_capacity_exceeded", "自动套利限流或容量配置无效。");
  }
  return value;
}

function integer(value: string, minimum: number, maximum: number, name: string) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new RwaAutomationGovernanceError(503, "automation_capacity_exceeded", `自动套利 ${name} 配置无效。`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RwaAutomationGovernanceError(503, "automation_capacity_exceeded", `自动套利 ${name} 配置超出安全范围。`);
  }
  return parsed;
}

function domain(purpose: string, value: string) {
  return createHash("sha256").update(`rwa-governance:${purpose}:${value}`).digest("base64url");
}

function isExitOperation(operation: RwaAutomationGovernedOperation) {
  return operation === "position_close"
    || operation === "close_all"
    || operation === "asset_takeover_exit";
}
