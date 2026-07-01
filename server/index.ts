import cors from "cors";
import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { UserService } from "./auth/UserService";
import { getEditableMarketSymbol, registerMarketRoutes } from "./modules/api/marketRoutes";
import { KlineStore } from "./modules/kline/KlineStore";
import { BinanceMarketService } from "./modules/market/BinanceMarketService";
import { defaultMarketSymbols, normalizeInterval, normalizeSymbol } from "./modules/market/marketConfig";
import { TradingService } from "./market/TradingService";
import { TradingStore } from "./storage/TradingStore";
import { OnchainWalletService } from "./wallet/OnchainWalletService";
import { WalletService } from "./wallet/WalletService";
import type { MarketSymbol, MarketTick, TradeSide, User, WalletAccountType } from "./types";

dotenv.config();

const port = Number(process.env.API_PORT ?? 8787);
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || "admin@example.com";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const app = express();
app.use(cors());
app.use(express.json());

const klineStore = new KlineStore();
const market = new BinanceMarketService(klineStore);
await market.start();
const tradingStore = new TradingStore();

const tradingMarket = {
  getSymbol(symbol: string) {
    const normalized = symbol.toUpperCase();
    return getEditableMarketSymbol(normalized) ?? defaultMarketSymbols.find((item) => item.symbol === normalized || item.apiSymbol === normalized) ?? null;
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
trading.getAccount("demo-user");
const onchainWallet = new OnchainWalletService(tradingStore);
const wallet = new WalletService(tradingStore, trading, onchainWallet);
const users = new UserService(tradingStore);
const activeAdminTokens = new Set<string>();

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

app.post("/api/auth/register", (request, response) => {
  try {
    response.status(201).json(users.register(request.body ?? {}));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/auth/login", (request, response) => {
  try {
    response.json(users.login(request.body?.email, request.body?.password));
  } catch (error) {
    response.status(401).json({ message: error instanceof Error ? error.message : "登录失败。" });
  }
});

app.post("/api/auth/logout", (request, response) => {
  users.logout(getUserBearerToken(request));
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

app.post("/api/admin/login", (request, response) => {
  const email = String(request.body?.email ?? "").trim().toLowerCase();
  const password = String(request.body?.password ?? "");
  if (email !== adminEmail || password !== adminPassword) {
    response.status(401).json({ message: "管理员账号或密码不正确。" });
    return;
  }

  const token = crypto.randomBytes(24).toString("hex");
  activeAdminTokens.add(token);
  response.json({ token });
});

app.post("/api/admin/logout", (request, response) => {
  const token = getAdminBearerToken(request);
  if (token) {
    activeAdminTokens.delete(token);
  }
  response.json({ ok: true });
});

app.use("/api/admin", (request, response, next) => {
  if (request.path === "/login") {
    next();
    return;
  }
  const token = getAdminBearerToken(request);
  if (!token || !activeAdminTokens.has(token)) {
    response.status(401).json({ message: "管理员未登录或登录已失效。" });
    return;
  }
  next();
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
  response.json(trading.getAccount(getUserId(request)));
});

app.get("/api/trading/positions", (request, response) => {
  response.json(trading.listPositions(getUserId(request)));
});

app.get("/api/trading/orders", (request, response) => {
  response.json(trading.listOrders(getUserId(request)));
});

app.post("/api/trading/order", (request, response) => {
  try {
    const symbol = normalizeSymbol(String(request.body?.symbol ?? "BTCUSDT"));
    const side = normalizeSide(request.body?.side);
    const volume = Number(request.body?.volume);
    response.json(trading.marketOrder(getUserId(request), symbol, side, volume));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/trading/positions/:positionId/close", (request, response) => {
  try {
    response.json(trading.closePosition(getUserId(request), request.params.positionId));
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

const server = app.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

registerSocketHub(server, market);

function registerSocketHub(httpServer: typeof server, marketService: BinanceMarketService) {
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  const subscriptions = new Map<WebSocket, Set<string>>();

  wss.on("connection", (socket) => {
    subscriptions.set(socket, new Set());
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, string>;
        if (message.type !== "subscribe") {
          return;
        }

        if (message.channel === "ticker") {
          subscriptions.get(socket)?.add(`ticker:${normalizeSymbol(message.symbol ?? "BTCUSDT")}`);
        }
        if (message.channel === "candle") {
          const interval = normalizeInterval(message.interval ?? "1m");
          subscriptions.get(socket)?.add(`candle:${normalizeSymbol(message.symbol ?? "BTCUSDT")}:${interval}`);
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "invalid message" }));
      }
    });
    socket.on("close", () => subscriptions.delete(socket));
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
}

function getAdminBearerToken(request: express.Request) {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token;
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
  if (value !== "funding" && value !== "trading" && value !== "simulation" && value !== "realTrading") {
    throw new Error("账户类型必须是 funding、trading、simulation 或 realTrading。");
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

function getUserBearerToken(request: express.Request) {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token;
}

function sendBadRequest(response: express.Response, error: unknown) {
  response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
}

process.on("SIGINT", async () => {
  await market.stop();
  tradingStore.close();
  server.close();
  process.exit(0);
});
