import type express from "express";
import type { TradingService } from "../../market/TradingService";
import { normalizeSymbol } from "../market/marketConfig";
import { sendBadRequest } from "./httpResponses";
import { getSimulationAccountId, getUserId, normalizeSide } from "./requestHelpers";

export function registerUserTradingRoutes(app: express.Express, trading: TradingService) {
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
}
