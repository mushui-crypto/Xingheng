import { create } from "zustand";
import type { User, UserStatus } from "../types";

type RegisterInput = {
  email: string;
  password: string;
  nickname?: string;
};

type UserStore = {
  users: User[];
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  loadCurrentUser: () => Promise<User | null>;
  loadAdminUsers: () => Promise<void>;
  registerUser: (input: RegisterInput) => Promise<{ ok: true; user: User } | { ok: false; message: string }>;
  getById: (id: string | null) => User | undefined;
  setUserStatus: (id: string, status: UserStatus) => Promise<{ ok: true } | { ok: false; message: string }>;
  clear: () => void;
};

function getUserToken() {
  try {
    const raw = localStorage.getItem("xingheng.auth");
    const auth = raw ? (JSON.parse(raw) as { userToken?: string | null }) : null;
    return auth?.userToken ?? null;
  } catch {
    return null;
  }
}

function getAdminToken() {
  try {
    const raw = localStorage.getItem("xingheng.adminAuth");
    const auth = raw ? (JSON.parse(raw) as { adminToken?: string | null }) : null;
    return auth?.adminToken ?? null;
  } catch {
    return null;
  }
}

export const useUserStore = create<UserStore>((set, get) => ({
  users: [],
  currentUser: null,
  setCurrentUser: (user) => set({ currentUser: user }),
  loadCurrentUser: async () => {
    const token = getUserToken();
    if (!token) {
      set({ currentUser: null });
      return null;
    }

    const response = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      set({ currentUser: null });
      return null;
    }

    const user = (await response.json()) as User;
    set({ currentUser: user });
    return user;
  },
  loadAdminUsers: async () => {
    const token = getAdminToken();
    const response = await fetch("/api/admin/users", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) {
      throw new Error("用户列表加载失败。");
    }

    const users = (await response.json()) as User[];
    set({ users });
  },
  registerUser: async ({ email, password, nickname }) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, nickname }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.id) {
      return { ok: false, message: payload?.message ?? "注册失败。" };
    }

    return { ok: true, user: payload as User };
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
    const token = getAdminToken();
    const response = await fetch(`/api/admin/users/${id}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
