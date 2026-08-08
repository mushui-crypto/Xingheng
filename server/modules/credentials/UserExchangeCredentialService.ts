import { BinanceClient } from "../binance/BinanceClient";
import type { BinanceAccountIdentity, BinancePermissions } from "../binance/BinanceTypes";
import type { ExchangeVenue } from "./CredentialKeyProvider";
import {
  UserExchangeCredentialStoreError,
  type UserExchangeCredentialStore,
  type UserExchangeCredentialSummary,
} from "./UserExchangeCredentialStore";

const venues: ExchangeVenue[] = ["bybit", "bitget", "binance", "okx"];

type BinanceAccessClient = {
  validateAccess(): Promise<BinanceAccountIdentity & { permissions: BinancePermissions }>;
};

export class UserExchangeCredentialService {
  constructor(
    private readonly store: Pick<UserExchangeCredentialStore, "findSummary" | "listForUser" | "save" | "delete">,
    private readonly options: {
      binanceClientFactory?: (credentials: { apiKey: string; apiSecret: string }) => BinanceAccessClient;
      assertCanDelete?: (userId: string, venue: ExchangeVenue) => Promise<void>;
      deleteCredential?: (userId: string, venue: ExchangeVenue) => Promise<boolean>;
      onDeleted?: (userId: string, venue: ExchangeVenue) => void;
    } = {},
  ) {}

  list(userId: string) {
    const summaries = new Map(this.store.listForUser(userId).map((summary) => [summary.venue, summary]));
    return venues.map((venue) => status(venue, summaries.get(venue) ?? null));
  }

  async put(userId: string, venueInput: string, input: unknown) {
    const venue = normalizeVenue(venueInput);
    if (venue !== "binance") throw notImplemented(venue);
    if (this.store.findSummary(userId, venue)) {
      throw new UserExchangeCredentialServiceError(
        "credential_already_configured",
        "Delete the existing Binance credential before configuring another one.",
      );
    }
    const body = object(input);
    assertOnlyKeys(body, ["apiKey", "apiSecret", "passphrase"]);
    const apiKey = requiredSecret(body.apiKey, "apiKey");
    const apiSecret = requiredSecret(body.apiSecret, "apiSecret");
    if (body.passphrase !== undefined && String(body.passphrase).trim()) {
      throw new UserExchangeCredentialServiceError("credential_input_invalid", "Binance does not use an API passphrase.");
    }

    const client = this.options.binanceClientFactory?.({ apiKey, apiSecret })
      ?? new BinanceClient({ apiKey, apiSecret });
    const access = await client.validateAccess();
    assertBinancePermissions(access.permissions);
    const summary = await this.store.save({
      userId,
      venue,
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      apiKey,
      apiSecret,
      permissions: access.permissions,
      verifiedAt: Date.now(),
    });
    return status(venue, summary);
  }

  async delete(userId: string, venueInput: string) {
    const venue = normalizeVenue(venueInput);
    if (venue !== "binance") throw notImplemented(venue);
    const summary = this.store.findSummary(userId, venue);
    if (!summary) return status(venue, null);
    if (this.options.deleteCredential) {
      await this.options.deleteCredential(userId, venue);
      return status(venue, null);
    }
    await this.options.assertCanDelete?.(userId, venue);
    this.store.delete(userId, venue);
    this.options.onDeleted?.(userId, venue);
    return status(venue, null);
  }
}

export class UserExchangeCredentialServiceError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

function status(venue: ExchangeVenue, summary: UserExchangeCredentialSummary | null) {
  const implemented = venue === "binance";
  return {
    venue,
    configured: Boolean(summary),
    implemented,
    accountId: summary?.accountId ?? null,
    accountFingerprint: summary?.accountFingerprint ?? null,
    maskedApiKey: summary?.maskedApiKey ?? null,
    permissions: summary?.permissions ?? null,
    lastVerifiedAt: summary?.lastVerifiedAt ?? null,
    message: implemented ? null : `${venue} credential adapter is not implemented.`,
  };
}

function assertBinancePermissions(permissions: BinancePermissions) {
  if (
    !permissions.read
    || !permissions.spotTrade
    || !permissions.contractTrade
    || permissions.withdraw
    || !permissions.ipRestricted
    || !permissions.positionModeSupported
  ) {
    throw new UserExchangeCredentialServiceError(
      "credential_permissions_invalid",
      "Binance credential must allow read, spot, and futures trading, deny withdrawals, use an IP whitelist, and use one-way position mode.",
    );
  }
}

function normalizeVenue(value: string): ExchangeVenue {
  if (value === "binance" || value === "bybit" || value === "bitget" || value === "okx") return value;
  throw new UserExchangeCredentialServiceError("credential_venue_invalid", "Unsupported exchange venue.");
}

function notImplemented(venue: ExchangeVenue) {
  return new UserExchangeCredentialServiceError(
    "credential_adapter_not_implemented",
    `${venue} credential adapter is not implemented.`,
  );
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", "Credential request body must be an object.");
  }
  return value as Record<string, unknown>;
}

function requiredSecret(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", `${name} is invalid.`);
  }
  return text;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", "Credential request contains unsupported fields.");
  }
}
