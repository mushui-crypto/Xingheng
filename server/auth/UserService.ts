import crypto from "node:crypto";
import type { TradingStore } from "../storage/TradingStore";
import type { User } from "../types";

type UserRecord = User & { password: string };

type RegisterInput = {
  email: string;
  password: string;
  nickname?: string;
};

export class UserService {
  private activeTokens = new Map<string, string>();

  constructor(private store: TradingStore) {}

  register(input: RegisterInput) {
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const nickname = input.nickname?.trim() || undefined;

    if (!isValidEmail(email)) {
      throw new Error("请输入有效的邮箱地址。");
    }
    if (password.length < 6) {
      throw new Error("密码至少需要 6 位。");
    }
    if (this.store.findUserByEmail(email)) {
      throw new Error("该邮箱已注册，请直接登录。");
    }

    const user: UserRecord = {
      id: `USR-${Date.now().toString(36).toUpperCase()}`,
      email,
      password,
      nickname,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.store.createUser(user);
    return this.toUserView(user);
  }

  login(emailInput: string, passwordInput: string) {
    const email = String(emailInput ?? "").trim().toLowerCase();
    const password = String(passwordInput ?? "");
    const user = this.store.findUserByEmail(email);

    if (!user || user.password !== password) {
      throw new Error("邮箱或密码不正确。");
    }
    if (user.status === "disabled") {
      throw new Error("账号已禁用，请联系管理员。");
    }

    const token = crypto.randomBytes(24).toString("hex");
    this.activeTokens.set(token, user.id);
    return { token, user: this.toUserView(user) };
  }

  logout(token: string | null | undefined) {
    if (token) {
      this.activeTokens.delete(token);
    }
  }

  authenticate(token: string | null | undefined) {
    if (!token) {
      return null;
    }
    const userId = this.activeTokens.get(token);
    if (!userId) {
      return null;
    }
    return this.store.findUserById(userId) ?? null;
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

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
