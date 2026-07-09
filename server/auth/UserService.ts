import type { TradingStore } from "../storage/TradingStore";
import type { User } from "../types";
import { createSessionToken, hashPassword, hashSessionToken, isHashedPassword, verifyPassword } from "./security";

type UserRecord = User & { password: string };

type RegisterInput = {
  email: string;
  password: string;
  nickname?: string;
};

const defaultSeedUser: UserRecord = {
  id: "demo-user",
  email: "demo@example.com",
  password: "demo123",
  nickname: "星衡演示用户",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};

export class UserService {
  constructor(private store: TradingStore) {
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

  register(input: RegisterInput, afterCreate?: (user: User) => void) {
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const nickname = input.nickname?.trim() || undefined;

    if (!isValidEmail(email)) {
      throw new Error("请输入有效的邮箱地址。");
    }
    if (password.length < 8 || password.length > 128) {
      throw new Error("密码长度需要在 8 到 128 位之间。");
    }
    if (this.store.findUserByEmail(email)) {
      throw new Error("该邮箱已注册，请直接登录。");
    }

    const user: UserRecord = {
      id: `USR-${Date.now().toString(36).toUpperCase()}`,
      email,
      password: hashPassword(password),
      nickname,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.createUser(user);
      afterCreate?.(this.toUserView(user));
    });
    return this.toUserView(user);
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
