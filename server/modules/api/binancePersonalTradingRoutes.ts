import type express from "express";
import type { BinancePersonalTradingServiceRegistry } from "../binance/BinancePersonalTradingServiceRegistry";
import { BinanceRiskError } from "../binance/BinanceRiskGuard";
import { BinanceProviderError } from "../binance/BinanceClient";
import { CredentialKeyProviderError } from "../credentials/CredentialKeyProvider";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";

export function registerBinancePersonalTradingRoutes(
  app: express.Express,
  registry: BinancePersonalTradingServiceRegistry,
) {
  const route = (handler: (request: express.Request) => unknown | Promise<unknown>) =>
    async (request: express.Request, response: express.Response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        response.json(await handler(request));
      } catch (error) {
        const result = errorResponse(error);
        response.status(result.status).json({ message: result.message, category: result.category });
      }
    };

  const run = <T>(request: express.Request, operation: Parameters<BinancePersonalTradingServiceRegistry["run"]>[1]) =>
    registry.run(userId(request), operation) as Promise<T>;

  app.get("/api/binance/status", route((request) => registry.status(userId(request))));
  app.post("/api/binance/connection-check", route((request) => registry.checkConnection(userId(request))));
  app.get("/api/binance/account", route((request) => run(request, (service) => service.account())));
  app.get("/api/binance/market", route((request) => run(request, (service) => service.market())));
  app.get("/api/binance/strategy", route((request) => run(request, (service) => service.strategyStatus())));
  app.post("/api/binance/strategy/enter", route((request) => run(request, (service) => service.enter(request.body))));
  app.post("/api/binance/strategy/exit", route((request) => run(request, (service) => service.exit(request.body))));
  app.post("/api/binance/orders", route((request) => run(request, (service) => service.placeOrder(request.body))));
  app.post("/api/binance/test-orders", route((request) => run(request, (service) => service.placeTestOrder(request.body))));
  app.post("/api/binance/orders/cancel", route((request) => run(request, (service) => service.cancelOrder(request.body))));
  app.get("/api/binance/orders", route((request) => run(request, (service) => service.ordersState())));
  app.post("/api/binance/reconciliation", route((request) => run(request, (service) => service.reconciliation())));
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new Error("User authentication is required.");
  return request.user.id;
}

function errorResponse(error: unknown) {
  if (error instanceof BinanceRiskError) return { status: 409, category: error.category, message: error.message };
  if (error instanceof BinanceProviderError) return { status: 502, category: error.category, message: error.message };
  if (error instanceof CredentialKeyProviderError) return { status: 503, category: error.category, message: error.message };
  if (error instanceof UserExchangeCredentialStoreError) {
    const status = error.category === "credential_not_configured" ? 409 : 503;
    return { status, category: error.category, message: error.message };
  }
  return {
    status: 400,
    category: "binance_personal_trading_error",
    message: error instanceof Error ? error.message : "Binance personal trading request failed.",
  };
}
