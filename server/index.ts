import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { UserService } from "./auth/UserService";
import { loadRuntimeConfig } from "./config/runtimeConfig";
import { registerAuthRoutes, registerUserAuthMiddleware } from "./modules/auth/authRoutes";
import { registerAdminTradingRoutes } from "./modules/api/adminTradingRoutes";
import { registerArbitrageRoutes } from "./modules/api/arbitrageRoutes";
import { registerArbitrageExecutionDraftRoutes } from "./modules/api/arbitrageExecutionDraftRoutes";
import { registerArbitrageExecutionCommandRoutes } from "./modules/api/arbitrageExecutionCommandRoutes";
import { registerArbitrageExecutionCloseRoutes } from "./modules/api/arbitrageExecutionCloseRoutes";
import { registerArbitrageExecutionCancelRoutes } from "./modules/api/arbitrageExecutionCancelRoutes";
import { registerArbitrageInstanceRoutes } from "./modules/api/arbitrageInstanceRoutes";
import { registerFundingArbitrageRoutes } from "./modules/api/fundingArbitrageRoutes";
import { registerFundingArbitrageManualExecutionRoutes } from "./modules/api/fundingArbitrageManualExecutionRoutes";
import { FundingArbitrageManualExecutionService } from "./modules/api/FundingArbitrageManualExecutionService";
import { ManualRequestFundingArbitrageExecutionIntentSource } from "./modules/api/ManualRequestFundingArbitrageExecutionIntentSource";
import { CredentialVenueExecutionAccountResolver } from "./modules/api/CredentialVenueExecutionAccountResolver";
import { registerBinancePersonalTradingRoutes } from "./modules/api/binancePersonalTradingRoutes";
import { registerAccountReadRoutes } from "./modules/api/accountReadRoutes";
import { registerExchangeCredentialRoutes } from "./modules/api/exchangeCredentialRoutes";
import { registerAdminWalletRoutes } from "./modules/api/adminWalletRoutes";
import { getEditableMarketSymbol, registerMarketRoutes } from "./modules/api/marketRoutes";
import { registerRealTradingRoutes } from "./modules/api/realTradingRoutes";
import { registerStrategyRoutes } from "./modules/api/strategyRoutes";
import { registerUserTradingRoutes } from "./modules/api/userTradingRoutes";
import { registerUserWalletRoutes } from "./modules/api/userWalletRoutes";
import { EmailService } from "./modules/email/EmailService";
import { HyperliquidExchangeProxy } from "./modules/hyperliquid/HyperliquidExchangeProxy";
import { HyperliquidSignatureVerifier } from "./modules/hyperliquid/HyperliquidSignatureVerifier";
import { getHyperliquidRealTradingConfig } from "./modules/hyperliquid/hyperliquidConfig";
import { HyperliquidInfoClient } from "./modules/hyperliquid/HyperliquidInfoClient";
import { RealTradingOrderStateService } from "./modules/hyperliquid/RealTradingOrderStateService";
import { RealTradingRealtimeTokenService } from "./modules/hyperliquid/RealTradingRealtimeTokenService";
import { RealTradingReconciliationService } from "./modules/hyperliquid/RealTradingReconciliationService";
import { RealTradingRiskGuard } from "./modules/hyperliquid/RealTradingRiskGuard";
import { RealTradingUserStreamManager } from "./modules/hyperliquid/RealTradingUserStreamManager";
import { KlineStore } from "./modules/kline/KlineStore";
import { HyperliquidMarketService } from "./modules/market/HyperliquidMarketService";
import { ArbitrageDashboardService } from "./modules/arbitrage/ArbitrageDashboardService";
import { ArbitrageExecutionDraftService } from "./modules/arbitrage-execution/ArbitrageExecutionDraftService";
import { DefaultArbitrageExecutionPlanningContextSource } from "./modules/arbitrage-execution/ArbitrageExecutionPlanningContext";
import { ArbitrageExecutionCommandService } from "./modules/arbitrage-execution/ArbitrageExecutionCommandService";
import { ArbitrageExecutionCloseService } from "./modules/arbitrage-execution/ArbitrageExecutionCloseService";
import { ArbitrageExecutionCancelService } from "./modules/arbitrage-execution/ArbitrageExecutionCancelService";
import { BinanceSpotCloseBalanceSource } from "./modules/arbitrage-execution/BinanceSpotCloseBalanceSource";
import { BinanceFormalArbitrageExecutionRuntime } from "./modules/arbitrage-execution/BinanceFormalArbitrageExecutionRuntime";
import {
  createDefaultFundingOpportunityReadVenues,
  createDefaultFundingOpportunitySource,
} from "./modules/cex/funding-arbitrage/createDefaultFundingOpportunitySource";
import { FundingOpportunityQueryService } from "./modules/cex/funding-arbitrage/FundingOpportunityQueryService";
import { BinancePersonalTradingServiceRegistry } from "./modules/binance/BinancePersonalTradingServiceRegistry";
import { BinanceIntentExecutionRuntime } from "./modules/binance/BinanceIntentExecutionRuntime";
import { AccountReadRegistry } from "./modules/account-read/AccountReadRegistry";
import { BinanceAccountReadProviderFactory } from "./modules/account-read/BinanceAccountReadProvider";
import { BitgetAccountReadProviderFactory } from "./modules/account-read/BitgetAccountReadProvider";
import { BybitAccountReadProviderFactory } from "./modules/account-read/BybitAccountReadProvider";
import { OkxAccountReadProviderFactory } from "./modules/account-read/OkxAccountReadProvider";
import {
  AccountUsdtValuationService,
  ArbitrageDashboardUsdtSpotPriceSource,
} from "./modules/account-read/AccountUsdtValuationService";
import { loadBinanceTradingConfig } from "./modules/binance/BinanceTradingConfig";
import { SqliteExecutionRecordStore } from "./modules/cex/ExecutionRecordStore";
import { FundingLegExecutionLinkStore } from "./modules/cex/funding-arbitrage/FundingLegExecutionLinkStore";
import { ArbitrageInstanceStore } from "./modules/cex/arbitrage-instance/ArbitrageInstanceStore";
import { ArbitrageInstanceQueryService } from "./modules/cex/arbitrage-instance/ArbitrageInstanceQueryService";
import { createDefaultArbitragePositionVerificationService } from "./modules/cex/arbitrage-instance/createDefaultArbitragePositionVerificationService";
import { GcpKmsCredentialKeyProvider } from "./modules/credentials/GcpKmsCredentialKeyProvider";
import { UserExchangeCredentialService } from "./modules/credentials/UserExchangeCredentialService";
import { UserExchangeCredentialStore } from "./modules/credentials/UserExchangeCredentialStore";
import { normalizeInterval, normalizeSymbol } from "./modules/market/marketConfig";
import {
  createCorsMiddleware,
  createRejectCrossOriginMutation,
  createSecurityHeaders,
} from "./modules/security/httpSecurity";
import { TradingService } from "./market/TradingService";
import { TradingStore } from "./storage/TradingStore";
import { ForwardPaperWorker } from "./modules/strategy/runtime/ForwardPaperWorker";
import { IctStrategyRuntime } from "./modules/strategy/runtime/IctStrategyRuntime";
import { MartingaleGridPaperWorker } from "./modules/strategy/runtime/MartingaleGridPaperWorker";
import { FixedGridPaperWorker } from "./modules/strategy/runtime/FixedGridPaperWorker";
import { StrategyEmailNotifier } from "./modules/strategy/runtime/StrategyEmailNotifier";
import { OnchainWalletService } from "./wallet/OnchainWalletService";
import { WalletService } from "./wallet/WalletService";
import type { MarketSymbol, MarketTick } from "./types";

dotenv.config();

const config = loadRuntimeConfig();
const { port } = config;
const app = express();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}
app.disable("x-powered-by");
app.use(createSecurityHeaders(config.isProduction));
app.use(createCorsMiddleware(config.allowedOrigins));
app.use(createRejectCrossOriginMutation(config.allowedOrigins));
app.use(express.json({ limit: "64kb" }));

const klineStore = new KlineStore();
const market = new HyperliquidMarketService(klineStore);
await market.start();
const strategyRuntime = new IctStrategyRuntime(market, klineStore);
await strategyRuntime.start().catch((error) => {
  console.error("[strategy] ICT shadow runtime failed to start", error instanceof Error ? error.message : error);
});
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
const email = new EmailService(config);
const strategyNotifier = new StrategyEmailNotifier({ email });
const forwardPaperWorker = new ForwardPaperWorker({ notifier: strategyNotifier });
forwardPaperWorker.start();
const martingaleGridPaperWorker = new MartingaleGridPaperWorker();
martingaleGridPaperWorker.start();
const fixedGridPaperWorker = new FixedGridPaperWorker();
fixedGridPaperWorker.start();
const users = new UserService(tradingStore, email, config.appPublicUrl);
const realTradingConfig = getHyperliquidRealTradingConfig();
const realTradingInfo = new HyperliquidInfoClient(realTradingConfig.baseUrl);
const realTradingRisk = new RealTradingRiskGuard(realTradingInfo);
const realTradingExchange = new HyperliquidExchangeProxy(
  realTradingConfig.baseUrl,
  realTradingRisk,
  tradingStore,
  new HyperliquidSignatureVerifier(),
  realTradingInfo,
);
const realTradingOrderState = new RealTradingOrderStateService(realTradingInfo);
const realTradingRealtimeTokens = new RealTradingRealtimeTokenService();
const realTradingUserStreams = new RealTradingUserStreamManager(realTradingInfo, realTradingOrderState);
const realTradingReconciliation = new RealTradingReconciliationService(realTradingInfo, tradingStore);
realTradingReconciliation.start();
users.onStatusChange((userId, status) => {
  if (status !== "disabled") return;
  realTradingRealtimeTokens.revokeUser(userId);
  void realTradingUserStreams.revokeUser(userId);
});
registerAuthRoutes({ app, users, wallet, tradingStore, config });

registerMarketRoutes(app, market, tradingStore, {
  environment: config.deploymentEnvironment,
  composeProject: config.composeProject,
  revision: process.env.GIT_COMMIT ?? "development",
});

registerUserAuthMiddleware(app, users);
const arbitrageDashboard = new ArbitrageDashboardService();
const fundingOpportunityReadVenues = createDefaultFundingOpportunityReadVenues({ symbols: [] });
const fundingOpportunityQuery = new FundingOpportunityQueryService(createDefaultFundingOpportunitySource({
  venues: fundingOpportunityReadVenues,
}));
const credentialKeyProvider = new GcpKmsCredentialKeyProvider();
const userExchangeCredentials = new UserExchangeCredentialStore({ keyProvider: credentialKeyProvider });
const arbitrageExecutionPlanningContexts = new DefaultArbitrageExecutionPlanningContextSource();
const arbitrageExecutionDraft = new ArbitrageExecutionDraftService(
  arbitrageDashboard,
  arbitrageExecutionPlanningContexts,
  userExchangeCredentials,
);
const binancePersonalTrading = new BinancePersonalTradingServiceRegistry(userExchangeCredentials);
const accountRead = new AccountReadRegistry(userExchangeCredentials, [
  new BinanceAccountReadProviderFactory(),
  new BitgetAccountReadProviderFactory(),
  new BybitAccountReadProviderFactory(),
  new OkxAccountReadProviderFactory(),
], new AccountUsdtValuationService(new ArbitrageDashboardUsdtSpotPriceSource(arbitrageDashboard)));
const executionRecordStore = new SqliteExecutionRecordStore({ dbPath: process.env.TRADING_DB_PATH });
const fundingLegExecutionLinks = new FundingLegExecutionLinkStore({ dbPath: process.env.TRADING_DB_PATH });
const arbitrageInstances = new ArbitrageInstanceStore({ dbPath: process.env.TRADING_DB_PATH });
const arbitrageInstanceQuery = new ArbitrageInstanceQueryService(arbitrageInstances);
const arbitragePositionVerification = createDefaultArbitragePositionVerificationService({
  query: arbitrageInstanceQuery,
  credentials: userExchangeCredentials,
  readVenues: fundingOpportunityReadVenues,
});
const binanceExecutionRuntime = new BinanceIntentExecutionRuntime(
  binancePersonalTrading,
  { maxSlippageBps: loadBinanceTradingConfig().maxSlippageBps },
  executionRecordStore,
);
const binanceFormalArbitrageExecutionRuntime = new BinanceFormalArbitrageExecutionRuntime(binanceExecutionRuntime);
const arbitrageExecutionCommand = new ArbitrageExecutionCommandService(
  arbitrageExecutionDraft,
  arbitrageInstances,
  userExchangeCredentials,
  executionRecordStore,
  binanceFormalArbitrageExecutionRuntime,
);
const arbitrageExecutionClose = new ArbitrageExecutionCloseService(
  arbitrageInstances,
  arbitragePositionVerification,
  arbitrageExecutionPlanningContexts,
  new BinanceSpotCloseBalanceSource(binancePersonalTrading),
  binanceFormalArbitrageExecutionRuntime,
);
const arbitrageExecutionCancel = new ArbitrageExecutionCancelService(
  arbitrageInstances,
  executionRecordStore,
  binanceExecutionRuntime,
  arbitrageExecutionCommand,
);
const fundingManualExecution = new FundingArbitrageManualExecutionService(
  new ManualRequestFundingArbitrageExecutionIntentSource(),
  new CredentialVenueExecutionAccountResolver(userExchangeCredentials),
  binanceExecutionRuntime,
  fundingLegExecutionLinks,
  arbitrageInstances,
);
const userExchangeCredentialService = new UserExchangeCredentialService(userExchangeCredentials, {
  deleteCredential: (userId, venue) => venue === "binance"
    ? binancePersonalTrading.deleteCredential(userId)
    : Promise.resolve(false),
});
registerArbitrageRoutes(app, arbitrageDashboard);
registerArbitrageExecutionDraftRoutes(app, arbitrageExecutionDraft);
registerArbitrageExecutionCommandRoutes(app, arbitrageExecutionCommand);
registerArbitrageExecutionCloseRoutes(app, arbitrageExecutionClose);
registerArbitrageExecutionCancelRoutes(app, arbitrageExecutionCancel);
registerArbitrageInstanceRoutes(app, arbitrageInstanceQuery, arbitragePositionVerification);
registerFundingArbitrageRoutes(app, fundingOpportunityQuery);
registerFundingArbitrageManualExecutionRoutes(app, fundingManualExecution);
registerBinancePersonalTradingRoutes(app, binancePersonalTrading);
registerAccountReadRoutes(app, accountRead);
registerExchangeCredentialRoutes(app, userExchangeCredentialService);
registerStrategyRoutes(app, strategyRuntime, { forwardPaperWorker, martingaleGridPaperWorker, fixedGridPaperWorker });
registerRealTradingRoutes({
  app,
  info: realTradingInfo,
  exchange: realTradingExchange,
  orderState: realTradingOrderState,
  realtimeTokens: realTradingRealtimeTokens,
  auditStore: tradingStore,
  risk: realTradingRisk,
  userStreams: realTradingUserStreams,
  reconciliation: realTradingReconciliation,
});
registerUserTradingRoutes(app, trading);
registerAdminTradingRoutes({ app, trading, users, wallet });
registerUserWalletRoutes(app, wallet);
registerAdminWalletRoutes(app, wallet);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

const socketHub = registerSocketHub(server, market, realTradingRealtimeTokens, realTradingUserStreams);

function registerSocketHub(
  httpServer: typeof server,
  marketService: HyperliquidMarketService,
  realtimeTokens: RealTradingRealtimeTokenService,
  userStreams: RealTradingUserStreamManager,
) {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024, perMessageDeflate: false });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const releases = new Map<WebSocket, Map<string, () => void>>();
  const realTradingReleases = new Map<WebSocket, () => void>();

  wss.on("connection", (socket) => {
    subscriptions.set(socket, new Set());
    releases.set(socket, new Map());
    realTradingReleases.set(socket, () => {});
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
        if (message.channel === "real-trading-user") {
          const grant = realtimeTokens.consume(message.token);
          if (!grant) {
            socket.send(JSON.stringify({ type: "error", message: "真实交易实时订阅 token 无效或已过期。" }));
            return;
          }
          realTradingReleases.get(socket)?.();
          void userStreams.acquire(grant.userId, grant.address, (event) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
          }).then((release) => {
            if (socket.readyState !== socket.OPEN) release();
            else realTradingReleases.set(socket, release);
          }).catch((error) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "真实交易实时订阅失败。" }));
            }
          });
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "invalid message" }));
      }
    });
    socket.on("close", () => {
      releases.get(socket)?.forEach((release) => release());
      realTradingReleases.get(socket)?.();
      realTradingReleases.delete(socket);
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

function broadcast(subscriptions: Map<WebSocket, Set<string>>, key: string, payload: unknown) {
  for (const [socket, keys] of subscriptions) {
    if (socket.readyState === socket.OPEN && keys.has(key)) {
      socket.send(JSON.stringify(payload));
    }
  }
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
    forwardPaperWorker.stop();
    martingaleGridPaperWorker.stop();
    fixedGridPaperWorker.stop();
    strategyRuntime.stop();
    realTradingReconciliation.stop();
    await realTradingUserStreams.stop();
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
    userExchangeCredentials.close();
    fundingLegExecutionLinks.close();
    executionRecordStore.close();
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
