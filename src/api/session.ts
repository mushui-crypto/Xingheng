import { storageKeys, writeStorage } from "../utils/storage";

const expiredAuthState = {
  currentUserId: null,
  isLoggedIn: false,
};

export const USER_AUTH_FAILED_EVENT = "xingheng:user-auth-failed";
export const USER_AUTH_MESSAGE_KEY = "xingheng.userAuthMessage";

export function handleUserAuthFailure(message = "账号已禁用或登录已失效，请重新登录。") {
  writeStorage(storageKeys.auth, expiredAuthState);
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(USER_AUTH_MESSAGE_KEY, message);
  window.dispatchEvent(new CustomEvent(USER_AUTH_FAILED_EVENT, { detail: { message } }));
}
