import type { TradingStore } from "../storage/TradingStore";
import crypto from "node:crypto";
import type { User } from "../types";
import type { EmailService } from "../modules/email/EmailService";
import { createSessionToken, hashPassword, hashSessionToken, isHashedPassword, secureTextEqual, verifyPassword } from "./security";

type UserRecord = User & { password: string };

type RegisterInput = {
  email: string;
  password: string;
  nickname?: string;
  code?: string;
};

type ResetPasswordInput = {
  email: string;
  password: string;
  code?: string;
  token?: string;
};

const emailTokenTtlMs = 10 * 60 * 1000;
const emailTokenCooldownMs = 60 * 1000;

const defaultSeedUser: UserRecord = {
  id: "demo-user",
  email: "demo@example.com",
  password: "demo123",
  nickname: "星衡演示用户",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
};

export class UserService {
  constructor(
    private store: TradingStore,
    private emailService: EmailService,
    private appPublicUrl: string,
  ) {
    const isProduction = process.env.NODE_ENV === "production";
    const seedEnabled = !isProduction && process.env.SEED_DEMO_USER_ENABLED !== "false";
    if (seedEnabled) {
      this.store.upsertSeedUser({ ...defaultSeedUser, password: hashPassword(process.env.SEED_DEMO_USER_PASSWORD || defaultSeedUser.password) });
    } else if (isProduction) {
      const existingDemoUser = this.store.findUserByEmail(defaultSeedUser.email);
      if (existingDemoUser?.id === defaultSeedUser.id && existingDemoUser.status !== "disabled") {
        this.store.updateUserStatus(existingDemoUser.id, "disabled");
      }
    }
    for (const user of this.store.listUserPasswordRecords()) {
      if (!isHashedPassword(user.password)) {
        this.store.updateUserPassword(user.id, hashPassword(user.password));
      }
    }
  }

  async requestRegisterCode(emailInput: string) {
    const email = normalizeEmail(emailInput);
    if (!isValidEmail(email)) {
      throw new Error("请输入有效的邮箱地址。");
    }
    if (this.store.findUserByEmail(email)) {
      throw new Error("该邮箱已注册，请直接登录。");
    }
    this.assertEmailTokenCooldown(email, "register");
    const token = this.createEmailToken(email, "register");
    this.store.createEmailToken(token.record);
    await this.emailService.sendVerificationMail({ to: email, code: token.code, purpose: "register" });
    return this.emailResponse(token.code);
  }

  register(input: RegisterInput) {
    const email = normalizeEmail(input.email);
    const password = String(input.password ?? "");
    const nickname = input.nickname?.trim() || undefined;
    const code = normalizeEmailCode(input.code);

    if (!isValidEmail(email)) {
      throw new Error("请输入有效的邮箱地址。");
    }
    if (password.length < 8 || password.length > 128) {
      throw new Error("密码长度需要在 8 到 128 位之间。");
    }
    if (this.store.findUserByEmail(email)) {
      throw new Error("该邮箱已注册，请直接登录。");
    }
    const token = this.verifyEmailCode(email, "register", code, "验证码无效或已过期。");
    const nowIso = new Date().toISOString();

    const user: UserRecord = {
      id: `USR-${Date.now().toString(36).toUpperCase()}`,
      email,
      password: hashPassword(password),
      nickname,
      status: "active",
      createdAt: nowIso,
      emailVerifiedAt: nowIso,
    };
    this.store.transaction(() => {
      this.store.createUser(user);
      this.store.markEmailTokenUsed(token.id);
    });
    return this.toUserView(user);
  }

  async requestPasswordReset(emailInput: string) {
    const email = normalizeEmail(emailInput);
    if (!isValidEmail(email)) {
      throw new Error("请输入有效的邮箱地址。");
    }
    this.assertEmailTokenCooldown(email, "password_reset");
    const user = this.store.findUserByEmail(email);
    const token = this.createEmailToken(email, "password_reset", user?.id);
    this.store.createEmailToken(token.record);
    if (!user) {
      return this.emailResponse();
    }
    await this.emailService.sendVerificationMail({
      to: email,
      code: token.code,
      purpose: "password_reset",
      resetLink: `${this.appPublicUrl}/reset-password?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token.rawToken)}`,
    });
    return this.emailResponse(token.code, token.rawToken);
  }

  resetPassword(input: ResetPasswordInput) {
    const email = normalizeEmail(input.email);
    const password = String(input.password ?? "");
    if (!isValidEmail(email)) {
      throw new Error("请输入有效的邮箱地址。");
    }
    if (password.length < 8 || password.length > 128) {
      throw new Error("密码长度需要在 8 到 128 位之间。");
    }
    const user = this.store.findUserByEmail(email);
    if (!user) {
      throw new Error("验证码无效或已过期。");
    }
    const token = input.token
      ? this.verifyResetLinkToken(email, input.token)
      : this.verifyEmailCode(email, "password_reset", normalizeEmailCode(input.code), "验证码无效或已过期。");
    if (token.userId !== user.id) {
      throw new Error("验证码无效或已过期。");
    }

    this.store.transaction(() => {
      this.store.updateUserPassword(user.id, hashPassword(password));
      this.store.markEmailTokenUsed(token.id);
      this.store.deleteAuthSessionsForSubject(user.id, "user");
    });
    return { ok: true };
  }


  login(emailInput: string, passwordInput: string) {
    const email = String(emailInput ?? "").trim().toLowerCase();
    const password = String(passwordInput ?? "");
    const user = this.store.findUserByEmail(email);

    if (!user || !verifyPassword(password, user.password)) {
      throw new Error("邮箱或密码不正确。");
    }
    if (user.status === "disabled") {
      throw new Error("账号已禁用，请联系管理员。");
    }

    if (!isHashedPassword(user.password)) {
      this.store.updateUserPassword(user.id, hashPassword(password));
    }
    const token = createSessionToken();
    const now = Date.now();
    this.store.createAuthSession({
      tokenHash: hashSessionToken(token),
      subjectId: user.id,
      role: "user",
      expiresAt: now + getSessionTtlMs(),
      createdAt: now,
    });
    return { token, user: this.toUserView(user) };
  }

  logout(token: string | null | undefined) {
    if (token) {
      this.store.deleteAuthSession(hashSessionToken(token), "user");
    }
  }

  authenticate(token: string | null | undefined) {
    if (!token) {
      return null;
    }
    const session = this.store.findAuthSession(hashSessionToken(token), "user");
    if (!session) {
      return null;
    }
    return this.store.findUserById(session.subjectId) ?? null;
  }

  getCurrentUser(token: string | null | undefined) {
    return this.authenticate(token);
  }

  listUsers() {
    return this.store.listUsers();
  }

  setUserStatus(id: string, status: User["status"]) {
    const user = this.store.findUserById(id);
    if (!user) {
      throw new Error("用户不存在。");
    }
    this.store.updateUserStatus(id, status);
    return this.store.findUserById(id);
  }

  private toUserView(user: UserRecord | User): User {
    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      status: user.status,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt ?? null,
    };
  }

  private assertEmailTokenCooldown(email: string, purpose: "register" | "password_reset") {
    const latest = this.store.findLatestEmailToken(email, purpose);
    if (latest && latest.createdAt + emailTokenCooldownMs > Date.now()) {
      throw new Error("验证码已发送，请 1 分钟后再试。");
    }
  }

  private createEmailToken(email: string, purpose: "register" | "password_reset", userId?: string) {
    const code = createEmailCode();
    const rawToken = createSessionToken();
    const id = `EML-${Date.now().toString(36).toUpperCase()}-${createSessionToken().slice(0, 8)}`;
    return {
      code,
      rawToken,
      record: {
        id,
        email,
        purpose,
        userId: userId ?? null,
        codeHash: hashEmailCode(id, code),
        tokenHash: hashSessionToken(rawToken),
        expiresAt: Date.now() + emailTokenTtlMs,
        usedAt: null,
        createdAt: Date.now(),
      },
    };
  }

  private verifyEmailCode(email: string, purpose: "register" | "password_reset", code: string, message: string) {
    const token = this.store.findLatestUsableEmailToken(email, purpose);
    if (!token || !secureTextEqual(token.codeHash, hashEmailCode(token.id, code))) {
      throw new Error(message);
    }
    return token;
  }

  private verifyResetLinkToken(email: string, rawToken: string) {
    const token = this.store.findUsableEmailTokenByTokenHash(email, "password_reset", hashSessionToken(String(rawToken ?? "")));
    if (!token) {
      throw new Error("验证码无效或已过期。");
    }
    return token;
  }

  private emailResponse(code?: string, token?: string) {
    return {
      ok: true,
      message: "验证码已发送",
      ...(!this.emailService.isConfigured && process.env.NODE_ENV !== "production" && code ? { devCode: code, devToken: token } : {}),
    };
  }
}

function getSessionTtlMs() {
  const hours = Number(process.env.USER_SESSION_TTL_HOURS ?? 24);
  return Math.max(1, Math.min(24 * 30, Number.isFinite(hours) ? hours : 24)) * 60 * 60 * 1000;
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email: unknown) {
  return String(email ?? "").trim().toLowerCase();
}

function normalizeEmailCode(code: unknown) {
  return String(code ?? "").replace(/\D/g, "").slice(0, 6);
}

function createEmailCode() {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function hashEmailCode(id: string, code: string) {
  return hashSessionToken(`${id}:${code}`);
}
