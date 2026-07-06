import type express from "express";
import type { UserService } from "../../auth/UserService";
import type { TradingService } from "../../market/TradingService";
import type { WalletService } from "../../wallet/WalletService";
import { sendBadRequest } from "./httpResponses";

type AdminTradingRouteDependencies = {
  app: express.Express;
  trading: TradingService;
  users: UserService;
  wallet: WalletService;
};

export function registerAdminTradingRoutes({ app, trading, users, wallet }: AdminTradingRouteDependencies) {
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
}
