import { create } from "zustand";
import type { User, UserStatus } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";

type RegisterInput = {
  email: string;
  password: string;
  nickname?: string;
};

type UserStore = {
  users: User[];
  reloadUsers: () => void;
  registerUser: (input: RegisterInput) => { ok: true; user: User } | { ok: false; message: string };
  findByEmail: (email: string) => User | undefined;
  getById: (id: string | null) => User | undefined;
  setUserStatus: (id: string, status: UserStatus) => void;
};

function persistUsers(users: User[]) {
  writeStorage(storageKeys.users, users);
}

export const useUserStore = create<UserStore>((set, get) => ({
  users: readStorage<User[]>(storageKeys.users, []),
  reloadUsers: () => {
    set({ users: readStorage<User[]>(storageKeys.users, []) });
  },
  registerUser: ({ email, password, nickname }) => {
    const normalizedEmail = email.trim().toLowerCase();
    const exists = get().users.some((user) => user.email.toLowerCase() === normalizedEmail);

    if (exists) {
      return { ok: false, message: "该邮箱已注册，请直接登录。" };
    }

    const user: User = {
      id: `USR-${Date.now().toString(36).toUpperCase()}`,
      email: normalizedEmail,
      password,
      nickname: nickname?.trim() || undefined,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    const users = [user, ...get().users];
    persistUsers(users);
    set({ users });
    return { ok: true, user };
  },
  findByEmail: (email) =>
    get().users.find((user) => user.email.toLowerCase() === email.trim().toLowerCase()),
  getById: (id) => get().users.find((user) => user.id === id),
  setUserStatus: (id, status) => {
    const users = get().users.map((user) => (user.id === id ? { ...user, status } : user));
    persistUsers(users);
    set({ users });
  },
}));
