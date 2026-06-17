import { create } from "zustand";
import type { AdminAuthState } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";

type AdminAuthStore = AdminAuthState & {
  login: (email: string, password: string) => { ok: true } | { ok: false; message: string };
  logout: () => void;
};

const defaultAdminAuthState: AdminAuthState = {
  isAdminLoggedIn: false,
};

export const useAdminAuthStore = create<AdminAuthStore>((set) => ({
  ...readStorage<AdminAuthState>(storageKeys.adminAuth, defaultAdminAuthState),
  login: (email, password) => {
    if (email.trim().toLowerCase() !== "admin@example.com" || password !== "admin123") {
      return { ok: false, message: "管理员账号或密码不正确。" };
    }
    const adminState = { isAdminLoggedIn: true };
    writeStorage(storageKeys.adminAuth, adminState);
    set(adminState);
    return { ok: true };
  },
  logout: () => {
    writeStorage(storageKeys.adminAuth, defaultAdminAuthState);
    set(defaultAdminAuthState);
  },
}));
