import { create } from "zustand";
import type { User, UserStatus } from "../types";

type RegisterInput = {
  email: string;
  password: string;
  nickname?: string;
  code: string;
};

type ResetPasswordInput = {
  email: string;
  password: string;
  code?: string;
  token?: string;
};

type UserStore = {
  users: User[];
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  loadCurrentUser: () => Promise<User | null>;
  loadAdminUsers: () => Promise<void>;
  requestRegisterCode: (email: string) => Promise<{ ok: true; message: string; devCode?: string } | { ok: false; message: string }>;
  registerUser: (input: RegisterInput) => Promise<{ ok: true; user: User } | { ok: false; message: string }>;
  requestPasswordReset: (email: string) => Promise<{ ok: true; message: string; devCode?: string; devToken?: string } | { ok: false; message: string }>;
  resetPassword: (input: ResetPasswordInput) => Promise<{ ok: true } | { ok: false; message: string }>;
  getById: (id: string | null) => User | undefined;
  setUserStatus: (id: string, status: UserStatus) => Promise<{ ok: true } | { ok: false; message: string }>;
  clear: () => void;
};

export const useUserStore = create<UserStore>((set, get) => ({
  users: [],
  currentUser: null,
  setCurrentUser: (user) => set({ currentUser: user }),
  loadCurrentUser: async () => {
    const response = await fetch("/api/auth/me");

    if (!response.ok) {
      set({ currentUser: null });
      return null;
    }

    const user = (await response.json()) as User;
    set({ currentUser: user });
    return user;
  },
  loadAdminUsers: async () => {
    const response = await fetch("/api/admin/users");

    if (!response.ok) {
      throw new Error("用户列表加载失败。");
    }

    const users = (await response.json()) as User[];
    set({ users });
  },
  requestRegisterCode: async (email) => {
    const response = await fetch("/api/auth/register-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, message: payload?.message ?? "验证码发送失败。" };
    }
    return { ok: true, message: payload?.message ?? "验证码已发送", devCode: payload?.devCode };
  },
  registerUser: async ({ email, password, nickname, code }) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, nickname, code }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.id) {
      return { ok: false, message: payload?.message ?? "注册失败。" };
    }

    return { ok: true, user: payload as User };
  },
  requestPasswordReset: async (email) => {
    const response = await fetch("/api/auth/password-reset-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      return { ok: false, message: payload?.message ?? "验证码发送失败。" };
    }
    return { ok: true, message: payload?.message ?? "验证码已发送", devCode: payload?.devCode, devToken: payload?.devToken };
  },
  resetPassword: async ({ email, password, code, token }) => {
    const response = await fetch("/api/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, code, token }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      return { ok: false, message: payload?.message ?? "密码重置失败。" };
    }
    return { ok: true };
  },
  getById: (id) => {
    if (!id) {
      return undefined;
    }
    const { currentUser, users } = get();
    if (currentUser?.id === id) {
      return currentUser;
    }
    return users.find((user) => user.id === id);
  },
  setUserStatus: async (id, status) => {
    const response = await fetch(`/api/admin/users/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return { ok: false, message: payload?.message ?? "用户状态更新失败。" };
    }

    const users = get().users.map((user) => (user.id === id ? { ...user, status } : user));
    set({ users });
    return { ok: true };
  },
  clear: () => set({ users: [], currentUser: null }),
}));
