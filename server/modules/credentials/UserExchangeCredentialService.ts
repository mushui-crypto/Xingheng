import { createHash } from "node:crypto";
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
    if (this.store.findSummary(userId, venue)) {
      throw new UserExchangeCredentialServiceError(
        "credential_already_configured",
        `Delete the existing ${venueLabel(venue)} credential before configuring another one.`,
      );
    }
    const body = object(input);
    assertOnlyKeys(body, ["apiKey", "apiSecret", "passphrase"]);
    const apiKey = requiredSecret(body.apiKey, "apiKey");
    const apiSecret = requiredSecret(body.apiSecret, "apiSecret");
    const passphrase = optionalPassphrase(venue, body.passphrase);

    if (venue !== "binance") {
      const identity = localCredentialIdentity(venue, apiKey);
      const summary = await this.store.save({
        userId,
        venue,
        ...identity,
        apiKey,
        apiSecret,
        ...(passphrase ? { passphrase } : {}),
        permissions: credentialOnlyPermissions,
        verifiedAt: Date.now(),
      });
      return status(venue, summary);
    }

    if (passphrase) {
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
    const summary = this.store.findSummary(userId, venue);
    if (!summary) return status(venue, null);
    if (this.options.deleteCredential) {
      const handled = await this.options.deleteCredential(userId, venue);
      if (handled) return status(venue, null);
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
  const implemented = true;
  return {
    venue,
    configured: Boolean(summary),
    implemented,
    accountId: summary?.accountId ?? null,
    accountFingerprint: summary?.accountFingerprint ?? null,
    maskedApiKey: summary?.maskedApiKey ?? null,
    permissions: summary?.permissions ?? null,
    lastVerifiedAt: summary?.lastVerifiedAt ?? null,
    message: message(venue, summary),
  };
}

const credentialOnlyPermissions = Object.freeze({
  read: false,
  spotTrade: false,
  contractTrade: false,
  withdraw: false,
  ipRestricted: false,
  providerVerified: false,
  executionEnabled: false,
});

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

function optionalPassphrase(venue: ExchangeVenue, value: unknown) {
  if (value !== undefined && typeof value !== "string") {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", "passphrase is invalid.");
  }
  const passphrase = value?.trim() ?? "";
  if ((venue === "bitget" || venue === "okx") && !passphrase) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", `${venueLabel(venue)} API passphrase is required.`);
  }
  if ((venue === "binance" || venue === "bybit") && passphrase) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", `${venueLabel(venue)} does not use an API passphrase.`);
  }
  if (passphrase.length > 512) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", "passphrase is invalid.");
  }
  return passphrase || undefined;
}

function localCredentialIdentity(venue: Exclude<ExchangeVenue, "binance">, apiKey: string) {
  const digest = createHash("sha256").update(`${venue}:credential-only:${apiKey}`).digest("hex");
  return {
    accountId: `${venue}:credential-only:${digest.slice(0, 20)}`,
    accountFingerprint: `${venue.toUpperCase()}-${digest.slice(20, 32).toUpperCase()}`,
  };
}

function venueLabel(venue: ExchangeVenue) {
  return venue === "binance" ? "Binance" : venue === "bybit" ? "Bybit" : venue === "bitget" ? "Bitget" : "OKX";
}

function message(venue: ExchangeVenue, summary: UserExchangeCredentialSummary | null) {
  if (venue === "binance") return null;
  return summary
    ? `${venueLabel(venue)} API credential is encrypted and saved. Private provider validation and execution are not enabled for this venue.`
    : `${venueLabel(venue)} supports encrypted API credential storage only; private provider validation and execution are not enabled.`;
}
