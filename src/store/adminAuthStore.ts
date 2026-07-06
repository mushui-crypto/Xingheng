import { create } from "zustand";
import type { AdminAuthState } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";

type AdminAuthStore = AdminAuthState & {
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  logout: () => void;
  expireSession: () => void;
  syncSession: () => Promise<boolean>;
};

const defaultAdminAuthState: AdminAuthState = {
  isAdminLoggedIn: false,
};

const persistedAdminAuth = readStorage<AdminAuthState>(storageKeys.adminAuth, defaultAdminAuthState);
const initialAdminAuthState = persistedAdminAuth.isAdminLoggedIn ? { isAdminLoggedIn: true } : defaultAdminAuthState;

export const useAdminAuthStore = create<AdminAuthStore>((set) => ({
  ...initialAdminAuthState,
  login: async (email, password) => {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      return { ok: false, message: payload?.message ?? "管理员账号或密码不正确。" };
    }
    const adminState = { isAdminLoggedIn: true };
    writeStorage(storageKeys.adminAuth, adminState);
    set(adminState);
    return { ok: true };
  },
  logout: () => {
    void fetch("/api/admin/logout", { method: "POST" }).catch(() => undefined);
    writeStorage(storageKeys.adminAuth, defaultAdminAuthState);
    set(defaultAdminAuthState);
  },
  expireSession: () => {
    writeStorage(storageKeys.adminAuth, defaultAdminAuthState);
    set(defaultAdminAuthState);
  },
  syncSession: async () => {
    const response = await fetch("/api/admin/me").catch(() => null);
    if (!response?.ok) {
      writeStorage(storageKeys.adminAuth, defaultAdminAuthState);
      set(defaultAdminAuthState);
      return false;
    }
    const nextState = { isAdminLoggedIn: true };
    writeStorage(storageKeys.adminAuth, nextState);
    set(nextState);
    return true;
  },
}));
