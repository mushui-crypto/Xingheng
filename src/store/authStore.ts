import { create } from "zustand";
import type { AuthState } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";
import { useUserStore } from "./userStore";

type LoginResult = { ok: true } | { ok: false; message: string };

type AuthStore = AuthState & {
  login: (email: string, password: string) => LoginResult;
  logout: () => void;
};

const defaultAuthState: AuthState = {
  currentUserId: null,
  isLoggedIn: false,
};

export const useAuthStore = create<AuthStore>((set) => ({
  ...readStorage<AuthState>(storageKeys.auth, defaultAuthState),
  login: (email, password) => {
    const user = useUserStore.getState().findByEmail(email);

    if (!user || user.password !== password) {
      return { ok: false, message: "邮箱或密码不正确。" };
    }

    if (user.status === "disabled") {
      return { ok: false, message: "账号已禁用，请联系管理员。" };
    }

    const authState: AuthState = {
      currentUserId: user.id,
      isLoggedIn: true,
    };
    writeStorage(storageKeys.auth, authState);
    set(authState);
    return { ok: true };
  },
  logout: () => {
    writeStorage(storageKeys.auth, defaultAuthState);
    set(defaultAuthState);
  },
}));
