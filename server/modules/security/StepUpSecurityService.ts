import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { secureTextEqual } from "../../auth/security";
import type { RwaAutomationVenue } from "../arbitrage/automation/RwaAutomationTypes";
import { provisioningUri, generateTotpSecret, verifyTotp } from "./Totp";
import {
  StepUpSecurityStore,
  type RecoveryCodeRecord,
  type StepUpSecurityState,
} from "./StepUpSecurityStore";

export type StepUpOperation =
  | "credential_put"
  | "credential_delete"
  | "execution_enable"
  | "kill_switch_disable"
  | "hedge_execute"
  | "position_close"
  | "close_all";

export type StepUpEnrollmentMethod = "totp" | "webauthn";

export type StepUpIntent = {
  operation: StepUpOperation;
  venue: RwaAutomationVenue;
  accountId: string;
  resourceId: string | null;
  requestDigest: string;
  notionalUsd: number | null;
};

type Authorization = StepUpIntent & {
  tokenHash: string;
  userId: string;
  sessionDomain: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
};

export type FactorInput = { method: "totp" | "recovery_code"; code: string };

const authorizationTtlMs = 120_000;
const enrollmentTtlMs = 10 * 60_000;
const verifyWindowMs = 5 * 60_000;
const verifyAttemptLimit = 5;
const recoveryCodeCount = 8;

export class StepUpSecurityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly category: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export class StepUpSecurityService {
  private readonly stores = new Map<string, StepUpSecurityStore>();
  private readonly authorizations = new Map<string, Authorization>();
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    storeFactory: (userId: string) => StepUpSecurityStore;
    verifyPassword: (userId: string, password: string) => boolean;
    getEnrollmentInvalidatedAt?: (userId: string) => number;
    now?: () => number;
  }) {}

  async status(userId: string) {
    return this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      return {
        enrolled: Boolean(state.active),
        pendingEnrollment: Boolean(state.pending),
        method: state.active ? "totp" as StepUpEnrollmentMethod : null,
        recoveryCodesRemaining: state.active?.recoveryCodes.filter((item) => item.usedAt === null).length ?? 0,
        enabledAt: state.active?.enabledAt ?? null,
      };
    });
  }

  async beginEnrollment(userId: string, sessionDomain: string, input: {
    currentPassword: string;
    currentFactor?: FactorInput;
  }) {
    const limitKey = verificationLimitKey(userId, sessionDomain);
    if (!this.options.verifyPassword(userId, input.currentPassword)) {
      throw invalidFactor("current_password_invalid", "当前密码或二次验证信息无效。");
    }
    return this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      let factorVerified = false;
      if (state.active) {
        if (!input.currentFactor) throw new StepUpSecurityError(403, "step_up_recovery_required", "重新设置二次验证需要当前验证器或恢复码。");
        this.hitLimit(limitKey);
        await this.verifyLifecycleFactor(state, input.currentFactor, this.now());
        factorVerified = true;
      }
      const enrollmentId = token();
      const secret = generateTotpSecret();
      const now = this.now();
      state.pending = {
        enrollmentIdHash: digest(enrollmentId),
        secret,
        createdAt: now,
        expiresAt: now + enrollmentTtlMs,
      };
      appendAudit(state, userId, null, "enrollment_begin", "success", "ok", now);
      await this.store(userId).write(state);
      if (factorVerified) this.clearLimit(limitKey);
      return {
        enrollmentId,
        otpauthUri: provisioningUri(secret, userDomain(userId).slice(0, 16)),
        expiresAt: state.pending.expiresAt,
      };
    });
  }

  async confirmEnrollment(userId: string, sessionDomain: string, input: { enrollmentId: string; code: string }) {
    const limitKey = verificationLimitKey(userId, sessionDomain);
    this.hitLimit(limitKey);
    return this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      const pending = state.pending;
      const now = this.now();
      if (!pending || pending.expiresAt <= now || !secureTextEqual(pending.enrollmentIdHash, digest(input.enrollmentId))) {
        throw new StepUpSecurityError(400, "step_up_expired", "二次验证设置已失效，请重新开始。");
      }
      const counter = verifyTotp(pending.secret, input.code, now);
      if (counter === null) throw invalidFactor("step_up_invalid", "验证码无效或已过期。");
      const recovery = createRecoveryCodes();
      state.active = {
        secret: pending.secret,
        enabledAt: now,
        lastAcceptedCounter: counter,
        recoveryCodes: recovery.records,
      };
      state.pending = null;
      appendAudit(state, userId, null, "enrollment_confirm", "success", "ok", now);
      await this.store(userId).write(state);
      this.revokeUserAuthorizations(userId);
      this.clearLimit(limitKey);
      return { ok: true, recoveryCodes: recovery.plaintext };
    });
  }

  async authorize(userId: string, sessionDomain: string, code: string, intent: StepUpIntent) {
    const limitKey = verificationLimitKey(userId, sessionDomain);
    this.hitLimit(limitKey);
    return this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      if (!state.active) throw new StepUpSecurityError(403, "step_up_not_enrolled", "请先设置身份验证器，才能执行敏感操作。");
      const now = this.now();
      const counter = verifyTotp(state.active.secret, code, now);
      if (counter === null) {
        appendAudit(state, userId, intent.accountId, intent.operation, "rejected", "step_up_invalid", now);
        await this.store(userId).write(state);
        throw invalidFactor("step_up_invalid", "验证码无效或已过期。");
      }
      if (state.active.lastAcceptedCounter !== null && counter <= state.active.lastAcceptedCounter) {
        appendAudit(state, userId, intent.accountId, intent.operation, "rejected", "step_up_replayed", now);
        await this.store(userId).write(state);
        throw new StepUpSecurityError(409, "step_up_replayed", "该验证码已使用，请等待新的验证码。");
      }
      state.active.lastAcceptedCounter = counter;
      appendAudit(state, userId, intent.accountId, intent.operation, "success", "authorized", now);
      await this.store(userId).write(state);
      const rawToken = token();
      const authorization: Authorization = {
        ...intent,
        tokenHash: digest(rawToken),
        userId,
        sessionDomain,
        nonce: token(),
        issuedAt: now,
        expiresAt: now + authorizationTtlMs,
        consumedAt: null,
      };
      this.authorizations.set(authorization.tokenHash, authorization);
      this.clearLimit(limitKey);
      this.purgeAuthorizations(now);
      return { authorizationToken: rawToken, expiresAt: authorization.expiresAt };
    });
  }

  async consume(userId: string, sessionDomain: string, rawToken: string, expected: StepUpIntent) {
    const tokenHash = digest(rawToken);
    const authorization = this.authorizations.get(tokenHash);
    const now = this.now();
    if (!authorization) throw new StepUpSecurityError(403, "step_up_required", "该敏感操作需要新的二次身份验证。");
    if (authorization.consumedAt !== null) throw new StepUpSecurityError(409, "step_up_replayed", "二次验证授权已使用。");
    if (authorization.expiresAt <= now) {
      authorization.consumedAt = now;
      throw new StepUpSecurityError(403, "step_up_expired", "二次验证授权已过期。");
    }
    if (!sameAuthorizationScope(authorization, { ...expected, userId, sessionDomain })) {
      throw new StepUpSecurityError(403, "step_up_scope_mismatch", "二次验证授权与当前操作不匹配。");
    }
    authorization.consumedAt = now;
    await this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      appendAudit(state, userId, expected.accountId, expected.operation, "success", "consumed", now);
      await this.store(userId).write(state);
    });
  }

  async regenerateRecoveryCodes(userId: string, sessionDomain: string, input: { currentPassword: string; factor: FactorInput }) {
    const limitKey = verificationLimitKey(userId, sessionDomain);
    this.hitLimit(limitKey);
    if (!this.options.verifyPassword(userId, input.currentPassword)) throw invalidFactor("current_password_invalid", "当前密码或二次验证信息无效。");
    return this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      if (!state.active) throw new StepUpSecurityError(403, "step_up_not_enrolled", "尚未设置二次身份验证。");
      await this.verifyLifecycleFactor(state, input.factor, this.now());
      const recovery = createRecoveryCodes();
      state.active.recoveryCodes = recovery.records;
      appendAudit(state, userId, null, "recovery_regenerate", "success", "ok", this.now());
      await this.store(userId).write(state);
      this.revokeUserAuthorizations(userId);
      this.clearLimit(limitKey);
      return { ok: true, recoveryCodes: recovery.plaintext };
    });
  }

  async disable(userId: string, sessionDomain: string, input: { currentPassword: string; factor: FactorInput }) {
    const limitKey = verificationLimitKey(userId, sessionDomain);
    this.hitLimit(limitKey);
    if (!this.options.verifyPassword(userId, input.currentPassword)) throw invalidFactor("current_password_invalid", "当前密码或二次验证信息无效。");
    return this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      if (!state.active) throw new StepUpSecurityError(403, "step_up_not_enrolled", "尚未设置二次身份验证。");
      await this.verifyLifecycleFactor(state, input.factor, this.now());
      state.active = null;
      state.pending = null;
      appendAudit(state, userId, null, "enrollment_disable", "success", "ok", this.now());
      await this.store(userId).write(state);
      this.revokeUserAuthorizations(userId);
      this.clearLimit(limitKey);
      return { ok: true };
    });
  }

  revokeSession(userId: string, sessionDomain: string) {
    for (const authorization of this.authorizations.values()) {
      if (authorization.userId === userId && authorization.sessionDomain === sessionDomain && authorization.consumedAt === null) {
        authorization.consumedAt = this.now();
      }
    }
  }

  async revokeAfterPasswordReset(userId: string) {
    this.revokeUserAuthorizations(userId);
    await this.withUserLock(userId, () => this.store(userId).clearPending()).catch(() => {
      // The durable user security epoch still makes the pending enrollment unusable.
    });
  }

  async revokeDisabledUser(userId: string) {
    this.revokeUserAuthorizations(userId);
    await this.withUserLock(userId, () => this.store(userId).clearPending());
  }

  revokeAutomationScope(userId: string, venue: RwaAutomationVenue, accountId?: string) {
    for (const authorization of this.authorizations.values()) {
      if (
        authorization.userId === userId
        && authorization.venue === venue
        && (!accountId || authorization.accountId === accountId)
        && authorization.consumedAt === null
      ) authorization.consumedAt = this.now();
    }
  }

  async recordCredentialBinding(userId: string, accountId: string) {
    await this.withUserLock(userId, async () => {
      const state = await this.readAndClean(userId);
      appendAudit(state, userId, accountId, "credential_put_binding", "success", "bound", this.now());
      await this.store(userId).write(state);
    });
  }

  private async verifyLifecycleFactor(state: StepUpSecurityState, factor: FactorInput, now: number) {
    if (!state.active) throw new StepUpSecurityError(403, "step_up_not_enrolled", "尚未设置二次身份验证。");
    if (factor.method === "totp") {
      const counter = verifyTotp(state.active.secret, factor.code, now);
      if (counter === null) throw invalidFactor("step_up_invalid", "验证码无效或已过期。");
      if (state.active.lastAcceptedCounter !== null && counter <= state.active.lastAcceptedCounter) {
        throw new StepUpSecurityError(409, "step_up_replayed", "该验证码已使用，请等待新的验证码。");
      }
      state.active.lastAcceptedCounter = counter;
      return;
    }
    const matching = verifyRecoveryCode(state.active.recoveryCodes, factor.code);
    if (!matching) throw invalidFactor("step_up_invalid", "恢复码无效或已使用。");
    matching.usedAt = now;
  }

  private async readAndClean(userId: string) {
    const state = await this.store(userId).read();
    const enrollmentInvalidatedAt = this.options.getEnrollmentInvalidatedAt?.(userId) ?? 0;
    if (state.pending && (
      state.pending.expiresAt <= this.now()
      || state.pending.createdAt <= enrollmentInvalidatedAt
    )) {
      state.pending = null;
      await this.store(userId).write(state);
    }
    return state;
  }

  private store(userId: string) {
    const existing = this.stores.get(userId);
    if (existing) return existing;
    const created = this.options.storeFactory(userId);
    this.stores.set(userId, created);
    return created;
  }

  private hitLimit(key: string) {
    const now = this.now();
    const current = this.attempts.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + verifyWindowMs } : current;
    entry.count += 1;
    this.attempts.set(key, entry);
    if (entry.count > verifyAttemptLimit) {
      throw new StepUpSecurityError(429, "step_up_rate_limited", "二次验证尝试过于频繁，请稍后再试。", Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
    }
  }

  private clearLimit(key: string) {
    this.attempts.delete(key);
  }

  private revokeUserAuthorizations(userId: string) {
    for (const authorization of this.authorizations.values()) {
      if (authorization.userId === userId && authorization.consumedAt === null) authorization.consumedAt = this.now();
    }
  }

  private purgeAuthorizations(now: number) {
    for (const [key, authorization] of this.authorizations) {
      if (authorization.expiresAt + authorizationTtlMs <= now) this.authorizations.delete(key);
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private async withUserLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(userId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(userId) === queued) this.locks.delete(userId);
    }
  }
}

export function canonicalRequestDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

export function validRequestDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function sameAuthorizationScope(actual: Authorization, expected: StepUpIntent & { userId: string; sessionDomain: string }) {
  return secureTextEqual(actual.userId, expected.userId)
    && secureTextEqual(actual.sessionDomain, expected.sessionDomain)
    && actual.operation === expected.operation
    && actual.venue === expected.venue
    && secureTextEqual(actual.accountId, expected.accountId)
    && nullableEqual(actual.resourceId, expected.resourceId)
    && secureTextEqual(actual.requestDigest, expected.requestDigest)
    && actual.notionalUsd === expected.notionalUsd;
}

function nullableEqual(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  return secureTextEqual(left, right);
}

function createRecoveryCodes() {
  const plaintext = Array.from({ length: recoveryCodeCount }, () => {
    const raw = randomBytes(10).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
  });
  const records = plaintext.map(hashRecoveryCode);
  return { plaintext, records };
}

function hashRecoveryCode(code: string): RecoveryCodeRecord {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeRecoveryCode(code), salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString("base64url"), hash: hash.toString("base64url"), usedAt: null };
}

function verifyRecoveryCode(records: RecoveryCodeRecord[], code: string) {
  const normalized = normalizeRecoveryCode(code);
  let matching: RecoveryCodeRecord | null = null;
  for (const record of records) {
    const expected = Buffer.from(record.hash, "base64url");
    const actual = scryptSync(normalized, Buffer.from(record.salt, "base64url"), expected.length, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const equal = expected.length === actual.length && timingSafeEqual(expected, actual);
    expected.fill(0);
    actual.fill(0);
    if (equal && record.usedAt === null) matching = record;
  }
  return matching;
}

function normalizeRecoveryCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function verificationLimitKey(userId: string, sessionDomain: string) {
  return `verification:${userId}:${sessionDomain}`;
}

function appendAudit(
  state: StepUpSecurityState,
  userId: string,
  accountId: string | null,
  operation: string,
  result: "success" | "rejected" | "revoked",
  category: string,
  occurredAt: number,
) {
  state.audit.push({
    userDomain: userDomain(userId),
    accountDomain: accountId ? domain("account", accountId) : null,
    operation,
    result,
    category,
    occurredAt,
  });
  state.audit = state.audit.slice(-200);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function userDomain(userId: string) {
  return domain("user", userId);
}

function domain(purpose: string, value: string) {
  return createHash("sha256").update(`step-up:${purpose}:${value}`).digest("base64url");
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function token() {
  return randomBytes(32).toString("base64url");
}

function invalidFactor(category: string, message: string) {
  return new StepUpSecurityError(400, category, message);
}
