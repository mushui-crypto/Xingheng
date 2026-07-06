import { create } from "zustand";
import type { AuthState } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";
import { useUserStore } from "./userStore";

type LoginResult = { ok: true } | { ok: false; message: string };

type AuthStore = AuthState & {
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  expireSession: () => void;
  syncSession: () => Promise<void>;
};

const defaultAuthState: AuthState = {
  currentUserId: null,
  isLoggedIn: false,
};

const persistedAuth = readStorage<AuthState>(storageKeys.auth, defaultAuthState);
const initialAuthState =
  persistedAuth.isLoggedIn && persistedAuth.currentUserId
    ? { currentUserId: persistedAuth.currentUserId, isLoggedIn: true }
    : defaultAuthState;

export const useAuthStore = create<AuthStore>((set) => ({
  ...initialAuthState,
  login: async (email, password) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.user?.id) {
      return { ok: false, message: payload?.message ?? "邮箱或密码不正确。" };
    }

    const authState: AuthState = {
      currentUserId: String(payload.user.id),
      isLoggedIn: true,
    };
    writeStorage(storageKeys.auth, authState);
    set(authState);
    useUserStore.getState().setCurrentUser(payload.user);
    return { ok: true };
  },
  logout: () => {
    void fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    writeStorage(storageKeys.auth, defaultAuthState);
    set(defaultAuthState);
    useUserStore.getState().clear();
  },
  expireSession: () => {
    writeStorage(storageKeys.auth, defaultAuthState);
    set(defaultAuthState);
    useUserStore.getState().clear();
  },
  syncSession: async () => {
    const user = await useUserStore.getState().loadCurrentUser().catch(() => null);
    if (!user) {
      writeStorage(storageKeys.auth, defaultAuthState);
      set(defaultAuthState);
      useUserStore.getState().clear();
      return;
    }

    const nextState: AuthState = {
      currentUserId: user.id,
      isLoggedIn: true,
    };
    writeStorage(storageKeys.auth, nextState);
    set(nextState);
  },
}));
