import type express from "express";
import { BinanceProviderError } from "../binance/BinanceClient";
import { BinanceCredentialInUseError } from "../binance/BinancePersonalTradingServiceRegistry";
import { BybitProviderError } from "../bybit/BybitClient";
import { BitgetAccountReadError } from "../bitget/BitgetAccountReadClient";
import { CredentialKeyProviderError } from "../credentials/CredentialKeyProvider";
import {
  UserExchangeCredentialService,
  UserExchangeCredentialServiceError,
} from "../credentials/UserExchangeCredentialService";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";
import { OkxProviderError } from "../okx/OkxClient";

export function registerExchangeCredentialRoutes(
  app: express.Express,
  service: UserExchangeCredentialService,
) {
  const route = (handler: (request: express.Request) => unknown | Promise<unknown>) =>
    async (request: express.Request, response: express.Response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        response.json(await handler(request));
      } catch (error) {
        const result = credentialErrorResponse(error);
        response.status(result.status).json({ category: result.category, message: result.message });
      }
    };

  app.get("/api/exchange-credentials", route((request) => service.list(userId(request))));
  app.put("/api/exchange-credentials/:venue", route((request) => (
    service.put(userId(request), singleParam(request.params.venue), request.body)
  )));
  app.post("/api/exchange-credentials/okx/rebind", route((request) => (
    service.rebindOkx(userId(request))
  )));
  app.post("/api/exchange-credentials/okx/execution/enable", route((request) => (
    service.enableOkxExecution(userId(request), request.body)
  )));
  app.post("/api/exchange-credentials/bybit/rebind", route((request) => (
    service.rebindBybit(userId(request))
  )));
  app.post("/api/exchange-credentials/bybit/execution/enable", route((request) => (
    service.enableBybitExecution(userId(request), request.body)
  )));
  app.post("/api/exchange-credentials/bitget/rebind", route((request) => (
    service.rebindBitget(userId(request))
  )));
  app.post("/api/exchange-credentials/bitget/execution/enable", route((request) => (
    service.enableBitgetExecution(userId(request), request.body)
  )));
  app.delete("/api/exchange-credentials/:venue", route((request) => (
    service.delete(userId(request), singleParam(request.params.venue))
  )));
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new UserExchangeCredentialServiceError("authentication_required", "User authentication is required.");
  return request.user.id;
}

function singleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function credentialErrorResponse(error: unknown) {
  if (error instanceof UserExchangeCredentialServiceError) {
    const status = error.category === "credential_adapter_not_implemented" ? 501
      : error.category === "credential_already_configured" ? 409
      : error.category === "authentication_required" ? 401
      : 400;
    return { status, category: error.category, message: error.message };
  }
  if (error instanceof UserExchangeCredentialStoreError) {
    const status = error.category === "credential_account_already_bound"
      || error.category === "credential_already_configured"
      || error.category === "credential_rebind_conflict" ? 409 : 503;
    return { status, category: error.category, message: error.message };
  }
  if (error instanceof CredentialKeyProviderError) {
    return { status: 503, category: error.category, message: error.message };
  }
  if (error instanceof BinanceProviderError) {
    return { status: 502, category: error.category, message: error.message };
  }
  if (error instanceof OkxProviderError) {
    return { status: 502, category: error.category, message: error.message };
  }
  if (error instanceof BybitProviderError) {
    return { status: 502, category: error.category, message: error.message };
  }
  if (error instanceof BitgetAccountReadError) {
    return { status: 502, category: error.category, message: error.message };
  }
  if (error instanceof BinanceCredentialInUseError) {
    return { status: 409, category: error.category, message: error.message };
  }
  return {
    status: 500,
    category: "credential_management_error",
    message: "Exchange credential request failed.",
  };
}
