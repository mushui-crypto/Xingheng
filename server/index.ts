import cors from "cors";
import dotenv from "dotenv";
import { isAddress } from "ethers";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { UserService } from "./auth/UserService";
import { createSessionToken, hashSessionToken, secureTextEqual } from "./auth/security";
import { getEditableMarketSymbol, registerMarketRoutes } from "./modules/api/marketRoutes";
import { KlineStore } from "./modules/kline/KlineStore";
import { HyperliquidMarketService } from "./modules/market/HyperliquidMarketService";
import { normalizeInterval, normalizeSymbol } from "./modules/market/marketConfig";
import { TradingService } from "./market/TradingService";
import { TradingStore } from "./storage/TradingStore";
import { OnchainWalletService } from "./wallet/OnchainWalletService";
import { WalletService } from "./wallet/WalletService";
import type { MarketSymbol, MarketTick, TradeSide, User, WalletAccountType } from "./types";

dotenv.config();

const port = Number(process.env.API_PORT ?? 8787);
const isProduction = process.env.NODE_ENV === "production";
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const adminAuthConfigured = Boolean(adminEmail && adminPassword.length >= 12);
const userCookieName = "xh_user_session";
const adminCookieName = "xh_admin_session";
const allowedOrigins = getAllowedOrigins();
validateProductionConfig();
const app = express();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
  }),
);
app.use(rejectCrossOriginMutation);
app.use(express.json({ limit: "64kb" }));
app.use("/api/auth", (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/admin", (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

const klineStore = new KlineStore();
const market = new HyperliquidMarketService(klineStore);
await market.start();
const tradingStore = new TradingStore();

const tradingMarket = {
  getSymbol(symbol: string) {
    return getEditableMarketSymbol(symbol);
  },
  getTicker(symbol: string) {
    const normalized = normalizeSymbol(symbol);
    const config = this.getSymbol(normalized);
    const ticker = market.getTicker(normalized);
    return {
      ...ticker,
      tick: ticker.tick && config ? applyConfiguredSpread(ticker.tick, config) : ticker.tick,
    };
  },
};

const trading = new TradingService(tradingMarket, tradingStore);
const onchainWallet = new OnchainWalletService(tradingStore);
const wallet = new WalletService(tradingStore, trading, onchainWallet);
const users = new UserService(tradingStore);
const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
});

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

app.post("/api/auth/register", authRateLimit, (request, response) => {
  try {
    response.status(201).json(users.register(request.body ?? {}));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/auth/login", authRateLimit, (request, response) => {
  try {
    const result = users.login(request.body?.email, request.body?.password);
    setSessionCookie(response, userCookieName, result.token, getUserSessionTtlMs());
    response.setHeader("Cache-Control", "no-store");
    response.json({ user: result.user });
  } catch (error) {
    response.status(401).json({ message: error instanceof Error ? error.message : "登录失败。" });
  }
});

app.post("/api/auth/logout", (request, response) => {
  users.logout(getUserBearerToken(request));
  clearSessionCookie(response, userCookieName);
  response.json({ ok: true });
});

app.get("/api/auth/me", (request, response) => {
  const user = users.getCurrentUser(getUserBearerToken(request));
  if (!user) {
    response.status(401).json({ message: "用户未登录或登录已失效。" });
    return;
  }
  response.json(user);
});

app.post("/api/admin/login", authRateLimit, (request, response) => {
  if (!adminAuthConfigured) {
    response.status(503).json({ message: "管理员登录尚未配置，请设置至少 12 位的 ADMIN_PASSWORD。" });
    return;
  }
  const email = String(request.body?.email ?? "").trim().toLowerCase();
  const password = String(request.body?.password ?? "");
  if (!secureTextEqual(email, adminEmail) || !secureTextEqual(password, adminPassword)) {
    response.status(401).json({ message: "管理员账号或密码不正确。" });
    return;
  }

  const token = createSessionToken();
  const now = Date.now();
  const ttlMs = getAdminSessionTtlMs();
  tradingStore.createAuthSession({
    tokenHash: hashSessionToken(token),
    subjectId: adminEmail,
    role: "admin",
    expiresAt: now + ttlMs,
    createdAt: now,
  });
  setSessionCookie(response, adminCookieName, token, ttlMs);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true });
});

app.post("/api/admin/logout", (request, response) => {
  const token = getAdminBearerToken(request);
  if (token) {
    tradingStore.deleteAuthSession(hashSessionToken(token), "admin");
  }
  clearSessionCookie(response, adminCookieName);
  response.json({ ok: true });
});

app.use("/api/admin", (request, response, next) => {
  if (request.path === "/login") {
    next();
    return;
  }
  const token = getAdminBearerToken(request);
  const session = token ? tradingStore.findAuthSession(hashSessionToken(token), "admin") : null;
  if (!adminAuthConfigured || !session || session.subjectId !== adminEmail) {
    response.status(401).json({ message: "管理员未登录或登录已失效。" });
    return;
  }
  next();
});

app.get("/api/admin/me", (_request, response) => {
  response.json({ email: adminEmail, role: "admin" });
});

registerMarketRoutes(app, market, tradingStore);

app.use(["/api/trading", "/api/wallet"], (request, response, next) => {
  const user = users.authenticate(getUserBearerToken(request));
  if (!user) {
    response.status(401).json({ message: "用户未登录或登录已失效。" });
    return;
  }
  if (user.status === "disabled") {
    response.status(403).json({ message: "账号已禁用，请联系管理员。" });
    return;
  }
  request.user = user;
  next();
});

app.get("/api/trading/account", (request, response) => {
  try {
    response.json(trading.getAccount(getUserId(request), getSimulationAccountId(request)));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/trading/positions", (request, response) => {
  response.json(trading.listPositions(getUserId(request), getSimulationAccountId(request)));
});

app.get("/api/trading/orders", (request, response) => {
  response.json(trading.listOrders(getUserId(request), getSimulationAccountId(request)));
});

app.post("/api/trading/order", (request, response) => {
  try {
    const symbol = normalizeSymbol(String(request.body?.symbol ?? "BTCUSDT"));
    const side = normalizeSide(request.body?.side);
    const volume = Number(request.body?.volume);
    response.json(trading.marketOrder(getUserId(request), getSimulationAccountId(request), symbol, side, volume));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/trading/positions/:positionId/close", (request, response) => {
  try {
    response.json(trading.closePosition(getUserId(request), request.params.positionId, getSimulationAccountId(request)));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/admin/accounts", (_request, response) => {
  response.json(trading.listAccounts());
});

app.get("/api/admin/users", (_request, response) => {
  response.json(users.listUsers());
});

app.post("/api/admin/users/:id/status", (request, response) => {
  try {
    const status = request.body?.status;
    if (status !== "active" && status !== "disabled") {
      throw new Error("用户状态不正确。");
    }
    response.json(users.setUserStatus(request.params.id, status));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/admin/positions", (_request, response) => {
  response.json(trading.listPositions());
});

app.get("/api/admin/orders", (_request, response) => {
  response.json(trading.listOrders());
});

app.get("/api/admin/balance-adjustments", (_request, response) => {
  response.json(trading.listAdjustments());
});

app.post("/api/admin/accounts/:userId/adjust-balance", (request, response) => {
  try {
    const type = request.body?.type;
    if (type !== "deposit" && type !== "withdraw" && type !== "reset") {
      throw new Error("资金调整类型不正确。");
    }
    response.json(wallet.adjustFundingBalance(request.params.userId, type, Number(request.body?.amount), request.body?.note));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/wallet/accounts", (request, response) => {
  response.json(wallet.getAccounts(getUserId(request)));
});

app.get("/api/wallet/simulation-accounts", (request, response) => {
  response.json(wallet.listSimulationAccounts(getUserId(request)));
});

app.post("/api/wallet/simulation-accounts", (request, response) => {
  try {
    response.json(wallet.createSimulationAccount(getUserId(request), { name: request.body?.name }));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.patch("/api/wallet/simulation-accounts/:id", (request, response) => {
  try {
    response.json(wallet.renameSimulationAccount(getUserId(request), request.params.id, { name: request.body?.name }));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.delete("/api/wallet/simulation-accounts/:id", (request, response) => {
  try {
    response.json(wallet.deleteSimulationAccount(getUserId(request), request.params.id));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/simulation-accounts/:id/reset", (request, response) => {
  try {
    response.json(wallet.resetSimulationAccount(getUserId(request), request.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "模拟账户每 24 小时只能重置一次。") {
      response.status(429).json({ message });
      return;
    }
    sendBadRequest(response, error);
  }
});

app.get("/api/wallet/overview", (request, response) => {
  response.json(wallet.getOverview(getUserId(request)));
});

app.get("/api/wallet/recent-activities", (request, response) => {
  response.json(wallet.listRecentActivities(getUserId(request)));
});

app.get("/api/wallet/funding-orders", (request, response) => {
  response.json(
    wallet.listFundingOrders(getUserId(request), {
      type: typeof request.query.type === "string" ? request.query.type : undefined,
      limit: Number(request.query.limit),
      page: Number(request.query.page),
      pageSize: Number(request.query.pageSize),
    }),
  );
});

app.get("/api/wallet/onchain-records", (request, response) => {
  response.json(
    wallet.listOnchainRecords(getUserId(request), {
      limit: Number(request.query.limit),
      page: Number(request.query.page),
      pageSize: Number(request.query.pageSize),
    }),
  );
});

app.post("/api/wallet/external/challenge", (request, response) => {
  try {
    response.json(
      wallet.createExternalWalletChallenge(getUserId(request), {
        walletAddress: request.body?.walletAddress,
        network: request.body?.network,
        provider: request.body?.provider,
      }),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/external-wallet/challenge", (request, response) => {
  try {
    response.json(
      wallet.createExternalWalletChallenge(getUserId(request), {
        walletAddress: request.body?.walletAddress,
        network: request.body?.network,
        provider: request.body?.provider,
      }),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/external/bind", (request, response) => {
  try {
    response.json(
      wallet.bindExternalWallet(getUserId(request), {
        challengeId: request.body?.challengeId,
        walletAddress: request.body?.walletAddress,
        signature: request.body?.signature,
      }),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/external-wallet/bind", (request, response) => {
  try {
    response.json(
      wallet.bindExternalWallet(getUserId(request), {
        challengeId: request.body?.challengeId,
        walletAddress: request.body?.walletAddress,
        signature: request.body?.signature,
      }),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/wallet/external", (request, response) => {
  response.json(wallet.getExternalWalletBinding(getUserId(request)));
});

app.get("/api/wallet/external-wallet", (request, response) => {
  response.json(wallet.getExternalWalletBinding(getUserId(request)));
});

app.delete("/api/wallet/external", (request, response) => {
  response.json(wallet.unbindExternalWallet(getUserId(request)));
});

app.delete("/api/wallet/external-wallet", (request, response) => {
  response.json(wallet.unbindExternalWallet(getUserId(request)));
});

app.get("/api/wallet/deposit-address", (request, response) => {
  try {
    response.json(wallet.getDepositAddress(getUserId(request)));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/wallet/deposits", (request, response) => {
  response.json(wallet.listOnchainDeposits(getUserId(request)));
});

app.get("/api/wallet/ledger", (request, response) => {
  response.json(wallet.listLedger(getUserId(request)));
});

app.get("/api/wallet/transfers", (request, response) => {
  response.json(wallet.listTransfers(getUserId(request)));
});

app.post("/api/wallet/transfer", (request, response) => {
  try {
    response.json(
      wallet.transfer(
        getUserId(request),
        normalizeWalletAccountType(request.body?.from),
        normalizeWalletAccountType(request.body?.to),
        Number(request.body?.amount),
        request.body?.remark,
      ),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/account-transfer", (request, response) => {
  try {
    response.json(
      wallet.accountTransfer(
        getUserId(request),
        normalizeWalletAccountType(request.body?.from),
        normalizeWalletAccountType(request.body?.to),
        Number(request.body?.amount),
        request.body?.remark,
      ),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/internal-transfer", (request, response) => {
  try {
    response.json(
      wallet.internalTransfer(getUserId(request), {
        recipient: request.body?.recipient,
        amount: Number(request.body?.amount),
        remark: request.body?.remark,
        clientRequestId: request.body?.clientRequestId,
      }),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/wallet/withdrawals", (request, response) => {
  try {
    response.json(
      wallet.createWithdrawal(getUserId(request), {
        amount: Number(request.body?.amount),
        network: request.body?.network,
        walletAddress: request.body?.walletAddress,
        remark: request.body?.remark,
      }),
    );
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.get("/api/wallet/withdrawals", (request, response) => {
  response.json(wallet.listWithdrawals(getUserId(request)));
});

app.get("/api/admin/wallet/accounts", (_request, response) => {
  response.json(wallet.listAccounts());
});

app.get("/api/admin/wallet/deposit-addresses", (_request, response) => {
  response.json(wallet.listDepositAddresses());
});

app.get("/api/admin/wallet/deposits", (_request, response) => {
  response.json(wallet.listOnchainDeposits());
});

app.get("/api/admin/wallet/ledger", (_request, response) => {
  response.json(wallet.listLedger());
});

app.get("/api/admin/wallet/transfers", (_request, response) => {
  response.json(wallet.listTransfers());
});

app.get("/api/admin/wallet/withdrawals", (_request, response) => {
  response.json(wallet.listWithdrawals());
});

app.get("/api/admin/wallet/external-bindings", (_request, response) => {
  response.json(wallet.listExternalWalletBindings());
});

app.post("/api/admin/wallet/deposit", (request, response) => {
  try {
    response.json(wallet.deposit(String(request.body?.userId ?? "demo-user"), Number(request.body?.amount), request.body?.remark));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/admin/wallet/onchain/scan", async (_request, response) => {
  try {
    response.json(await wallet.scanDeposits());
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/admin/wallet/withdrawals/confirm", async (_request, response) => {
  try {
    response.json(await wallet.confirmWithdrawals());
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/admin/wallet/withdrawals/:id/approve", async (request, response) => {
  try {
    response.json(await wallet.approveWithdrawal(request.params.id, request.body?.reviewNote));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/admin/wallet/withdrawals/:id/reject", (request, response) => {
  try {
    response.json(wallet.rejectWithdrawal(request.params.id, request.body?.reviewNote));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

const socketHub = registerSocketHub(server, market);

function registerSocketHub(httpServer: typeof server, marketService: HyperliquidMarketService) {
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const releases = new Map<WebSocket, Map<string, () => void>>();

  wss.on("connection", (socket) => {
    subscriptions.set(socket, new Set());
    releases.set(socket, new Map());
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, string>;
        if (message.type !== "subscribe") {
          return;
        }

        if (message.channel === "ticker") {
          const symbol = normalizeSymbol(message.symbol ?? "BTCUSDT");
          const key = `ticker:${symbol}`;
          subscriptions.get(socket)?.add(key);
          if (!releases.get(socket)?.has(key)) {
            releases.get(socket)?.set(key, marketService.addTickerSubscription(symbol));
          }
        }
        if (message.channel === "candle") {
          const interval = normalizeInterval(message.interval ?? "1m");
          const symbol = normalizeSymbol(message.symbol ?? "BTCUSDT");
          const key = `candle:${symbol}:${interval}`;
          subscriptions.get(socket)?.add(key);
          if (!releases.get(socket)?.has(key)) {
            releases.get(socket)?.set(key, marketService.addCandleSubscription(symbol, interval));
          }
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "invalid message" }));
      }
    });
    socket.on("close", () => {
      releases.get(socket)?.forEach((release) => release());
      releases.delete(socket);
      subscriptions.delete(socket);
    });
  });

  marketService.on("tick", (tick) => {
    const config = tradingMarket.getSymbol(tick.symbol);
    const quote = config ? applyConfiguredSpread(tick, config) : tick;
    broadcast(subscriptions, `ticker:${tick.symbol}`, {
      type: "ticker",
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      spread: quote.spread,
      source: quote.source,
      status: marketService.getStatus(quote.symbol),
      timestamp: quote.timestamp,
    });
  });

  marketService.on("status", (symbol, status) => {
    const ticker = tradingMarket.getTicker(symbol);
    broadcast(subscriptions, `ticker:${symbol}`, {
      type: "ticker",
      symbol,
      status,
      ...(ticker.tick ?? {}),
    });
  });

  marketService.on("kline", (candle) => {
    broadcast(subscriptions, `candle:${candle.symbol}:${candle.interval}`, {
      type: "candle",
      symbol: candle.symbol,
      interval: candle.interval,
      data: {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
    });
  });

  return wss;
}

function getAdminBearerToken(request: express.Request) {
  return getRequestToken(request, adminCookieName);
}

function broadcast(subscriptions: Map<WebSocket, Set<string>>, key: string, payload: unknown) {
  for (const [socket, keys] of subscriptions) {
    if (socket.readyState === socket.OPEN && keys.has(key)) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function normalizeSide(value: unknown): TradeSide {
  if (value !== "buy" && value !== "sell") {
    throw new Error("订单方向必须是 buy 或 sell。");
  }
  return value;
}

function normalizeWalletAccountType(value: unknown): WalletAccountType {
  if (value !== "wallet" && value !== "funding" && value !== "trading" && value !== "simulation" && value !== "realTrading") {
    throw new Error("账户类型必须是 wallet、funding、trading、simulation 或 realTrading。");
  }
  return value;
}

function applyConfiguredSpread(tick: MarketTick, config: MarketSymbol): MarketTick {
  const spread = config.spread;
  const halfSpread = spread / 2;
  return {
    ...tick,
    bid: Number((tick.last - halfSpread).toFixed(config.digits)),
    ask: Number((tick.last + halfSpread).toFixed(config.digits)),
    spread,
  };
}

function getUserId(request: express.Request) {
  return request.user?.id ?? "demo-user";
}

function getSimulationAccountId(request: express.Request) {
  const value = request.body?.simulationAccountId ?? request.query.simulationAccountId;
  return typeof value === "string" ? value.trim() : undefined;
}

function getUserBearerToken(request: express.Request) {
  return getRequestToken(request, userCookieName);
}

function sendBadRequest(response: express.Response, error: unknown) {
  response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
}

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[api] received ${signal}, shutting down`);

  const forceExit = setTimeout(() => {
    console.error("[api] graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  try {
    await market.stop();
    for (const client of socketHub.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      socketHub.close((socketError) => {
        if (socketError) reject(socketError);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.close((serverError) => {
        if (serverError) reject(serverError);
        else resolve();
      });
    });
    tradingStore.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("[api] graceful shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function getRequestToken(request: express.Request, cookieName: string) {
  const authorization = request.headers.authorization;
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme === "Bearer" && token) {
      return token;
    }
  }
  return parseCookies(request.headers.cookie)[cookieName] ?? null;
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function setSessionCookie(response: express.Response, name: string, token: string, ttlMs: number) {
  response.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}${isProduction ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(response: express.Response, name: string) {
  response.setHeader(
    "Set-Cookie",
    `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? "; Secure" : ""}`,
  );
}

function getUserSessionTtlMs() {
  return boundedHours(process.env.USER_SESSION_TTL_HOURS, 24, 24 * 30) * 60 * 60 * 1000;
}

function getAdminSessionTtlMs() {
  return boundedHours(process.env.ADMIN_SESSION_TTL_HOURS, 8, 24) * 60 * 60 * 1000;
}

function boundedHours(raw: string | undefined, fallback: number, maximum: number) {
  const value = Number(raw ?? fallback);
  return Math.max(1, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}

function getAllowedOrigins() {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!isProduction) {
    configured.push("http://localhost:5173", "http://127.0.0.1:5173");
  }
  return new Set(configured);
}

function validateProductionConfig() {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("API_PORT 必须是有效端口。");
  }
  const configuredChainId = Number(process.env.BSC_TESTNET_CHAIN_ID ?? 97);
  if (configuredChainId !== 97) {
    throw new Error("当前仅允许 BSC Testnet（BSC_TESTNET_CHAIN_ID=97）。");
  }
  if (!isProduction) return;

  const required = [
    ["DOMAIN", process.env.DOMAIN?.trim() ?? ""],
    ["ADMIN_EMAIL", adminEmail],
    ["ADMIN_PASSWORD（至少 12 位）", adminPassword.length >= 12 ? adminPassword : ""],
    ["TRADING_DB_PATH", process.env.TRADING_DB_PATH?.trim() ?? ""],
    ["CORS_ALLOWED_ORIGINS", process.env.CORS_ALLOWED_ORIGINS?.trim() ?? ""],
    ["BSC_TESTNET_RPC_URL", process.env.BSC_TESTNET_RPC_URL?.trim() ?? ""],
    ["BSC_TESTNET_TOKEN_ADDRESS", process.env.BSC_TESTNET_TOKEN_ADDRESS?.trim() ?? ""],
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`生产环境缺少必填配置：${missing.join("、")}。`);
  }
  const domain = process.env.DOMAIN!.trim();
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes(":") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)
  ) {
    throw new Error("DOMAIN 必须是纯域名，不得包含协议、路径或端口。");
  }
  if (domain === "trade.example.com" || domain.endsWith(".invalid") || domain.includes("replace-me")) {
    throw new Error("DOMAIN 仍是示例占位值，请填写正式域名。");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail === "admin@example.com" || adminEmail.endsWith("@example.invalid")) {
    throw new Error("ADMIN_EMAIL 必须是有效且非示例的管理员邮箱。");
  }
  if (
    adminPassword === "replace-with-a-long-random-secret" ||
    adminPassword.includes("REPLACE_WITH") ||
    adminPassword.toLowerCase().includes("replace-me")
  ) {
    throw new Error("ADMIN_PASSWORD 仍是示例占位值，请生成独立随机密码。");
  }
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) {
      throw new Error("生产环境 CORS_ALLOWED_ORIGINS 必须是 HTTPS origin，不得包含路径。");
    }
  }
  if (!allowedOrigins.has(`https://${domain}`)) {
    throw new Error("CORS_ALLOWED_ORIGINS 必须包含与 DOMAIN 对应的 HTTPS origin。");
  }
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(process.env.BSC_TESTNET_RPC_URL!.trim());
  } catch {
    throw new Error("BSC_TESTNET_RPC_URL 必须是有效的 HTTP(S) URL。");
  }
  if (!["http:", "https:"].includes(rpcUrl.protocol) || !rpcUrl.hostname) {
    throw new Error("BSC_TESTNET_RPC_URL 必须是 HTTP(S) URL。");
  }
  const tokenAddress = process.env.BSC_TESTNET_TOKEN_ADDRESS?.trim() ?? "";
  if (!isAddress(tokenAddress) || /^0x0{40}$/i.test(tokenAddress)) {
    throw new Error("BSC_TESTNET_TOKEN_ADDRESS 必须是有效且非零的测试网合约地址。");
  }
}

function rejectCrossOriginMutation(request: express.Request, response: express.Response, next: express.NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  const origin = request.headers.origin;
  if (!origin) {
    next();
    return;
  }
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProtocol === "string" ? forwardedProtocol.split(",")[0].trim() : request.protocol;
  const sameOrigin = `${protocol}://${request.get("host")}`;
  if (origin !== sameOrigin && !allowedOrigins.has(origin)) {
    response.status(403).json({ message: "请求来源不受信任。" });
    return;
  }
  next();
}

function securityHeaders(request: express.Request, response: express.Response, next: express.NextFunction) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isProduction) {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss:",
    );
    if (request.secure || request.headers["x-forwarded-proto"] === "https") {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  }
  next();
}

function createRateLimiter(options: { windowMs: number; max: number }) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const limit = Number.isFinite(options.max) ? Math.max(1, Math.floor(options.max)) : 10;
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const current = attempts.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current;
    entry.count += 1;
    attempts.set(key, entry);
    if (attempts.size > 10_000) {
      for (const [storedKey, value] of attempts) {
        if (value.resetAt <= now) {
          attempts.delete(storedKey);
        }
      }
    }
    if (entry.count > limit) {
      response.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      response.status(429).json({ message: "尝试次数过多，请稍后再试。" });
      return;
    }
    next();
  };
}
