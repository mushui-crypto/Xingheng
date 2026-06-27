import { create } from "zustand";
import type { AdminAuthState } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";

type AdminAuthStore = AdminAuthState & {
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  logout: () => void;
};

const defaultAdminAuthState: AdminAuthState = {
  isAdminLoggedIn: false,
  adminToken: null,
};

const persistedAdminAuth = readStorage<AdminAuthState>(storageKeys.adminAuth, defaultAdminAuthState);
const initialAdminAuthState =
  persistedAdminAuth.isAdminLoggedIn && persistedAdminAuth.adminToken
    ? persistedAdminAuth
    : defaultAdminAuthState;

export const useAdminAuthStore = create<AdminAuthStore>((set) => ({
  ...initialAdminAuthState,
  login: async (email, password) => {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.token) {
      return { ok: false, message: payload?.message ?? "管理员账号或密码不正确。" };
    }
    const adminState = { isAdminLoggedIn: true, adminToken: String(payload.token) };
    writeStorage(storageKeys.adminAuth, adminState);
    set(adminState);
    return { ok: true };
  },
  logout: () => {
    const current = useAdminAuthStore.getState();
    if (current.adminToken) {
      void fetch("/api/admin/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${current.adminToken}` },
      }).catch(() => undefined);
    }
    writeStorage(storageKeys.adminAuth, defaultAdminAuthState);
    set(defaultAdminAuthState);
  },
}));
