import type express from "express";
import { AccountReadRegistry, AccountReadRegistryError } from "../account-read/AccountReadRegistry";
import { BinanceProviderError } from "../binance/BinanceClient";
import { CredentialKeyProviderError, type ExchangeVenue } from "../credentials/CredentialKeyProvider";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";
import { OkxAccountReadError } from "../okx/OkxAccountReadClient";

const venues = new Set<ExchangeVenue>(["binance", "okx", "bybit", "bitget"]);

export function registerAccountReadRoutes(app: express.Express, registry: AccountReadRegistry) {
  app.get("/api/account-read/:venue", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await registry.read(userId(request), venue(request.params.venue)));
    } catch (error) {
      const result = errorResponse(error);
      response.status(result.status).json({ category: result.category, message: result.message });
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new AccountReadRegistryError("authentication_required", "User authentication is required.");
  }
  return request.user.id;
}

function venue(value: string | string[] | undefined) {
  const normalized = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  if (!normalized || !venues.has(normalized as ExchangeVenue)) {
    throw new AccountReadRegistryError("account_read_venue_invalid", "Account read venue is invalid.");
  }
  return normalized as ExchangeVenue;
}

function errorResponse(error: unknown) {
  if (error instanceof AccountReadRegistryError) {
    const status = error.category === "authentication_required" ? 401
      : error.category === "account_read_provider_not_implemented" ? 501
      : 400;
    return { status, category: error.category, message: error.message };
  }
  if (error instanceof UserExchangeCredentialStoreError) {
    return {
      status: error.category === "credential_not_configured" ? 409 : 503,
      category: error.category,
      message: error.message,
    };
  }
  if (error instanceof CredentialKeyProviderError) {
    return { status: 503, category: error.category, message: error.message };
  }
  if (error instanceof BinanceProviderError) {
    return { status: 502, category: error.category, message: error.message };
  }
  if (error instanceof OkxAccountReadError) {
    return { status: 502, category: error.category, message: error.message };
  }
  return { status: 502, category: "account_read_failed", message: "Exchange account read failed." };
}
