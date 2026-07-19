export type HyperliquidSessionIdentity<TProvider = unknown> = {
  provider: TProvider | null;
  userId: string | null;
  walletAddress: string;
};

export type HyperliquidSessionIdentityChange = {
  changed: boolean;
  message: string;
};

export function resolveHyperliquidSessionIdentityChange<TProvider>(
  previous: HyperliquidSessionIdentity<TProvider>,
  current: HyperliquidSessionIdentity<TProvider>,
  hadActiveSession: boolean,
): HyperliquidSessionIdentityChange {
  const previousAddress = normalizeWalletAddress(previous.walletAddress);
  const currentAddress = normalizeWalletAddress(current.walletAddress);
  const providerChanged = previous.provider !== current.provider;
  const userChanged = previous.userId !== current.userId;
  const walletChanged = previousAddress !== currentAddress;

  if (!providerChanged && !userChanged && !walletChanged) {
    return { changed: false, message: "" };
  }

  if (!hadActiveSession || !current.userId || !currentAddress) {
    return { changed: true, message: "" };
  }

  if (userChanged) {
    return { changed: true, message: "登录用户已变化，需要重新初始化会话签名器。" };
  }
  if (walletChanged) {
    return { changed: true, message: "钱包地址已变化，需要重新初始化会话签名器。" };
  }
  return { changed: true, message: "钱包连接已变化，需要重新初始化会话签名器。" };
}

function normalizeWalletAddress(value: string) {
  return value.trim().toLowerCase();
}
