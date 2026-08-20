import { createHash } from "node:crypto";
import { BinanceClient } from "../binance/BinanceClient";
import type { BinanceAccountIdentity, BinancePermissions } from "../binance/BinanceTypes";
import { BybitClient } from "../bybit/BybitClient";
import type { BybitAccountAccess, BybitCredentials } from "../bybit/BybitTypes";
import { OkxClient } from "../okx/OkxClient";
import type { OkxAccountAccess, OkxCredentials } from "../okx/OkxTypes";
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

type OkxAccessClient = {
  validateAccess(): Promise<OkxAccountAccess>;
};

type BybitAccessClient = {
  validateAccess(): Promise<BybitAccountAccess>;
};

export class UserExchangeCredentialService {
  constructor(
    private readonly store: Pick<
      UserExchangeCredentialStore,
      "findSummary" | "listForUser" | "save" | "replace" | "loadForExecution" | "delete"
    >,
    private readonly options: {
      binanceClientFactory?: (credentials: { apiKey: string; apiSecret: string }) => BinanceAccessClient;
      bybitClientFactory?: (credentials: BybitCredentials) => BybitAccessClient;
      okxClientFactory?: (credentials: OkxCredentials) => OkxAccessClient;
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

    if (venue === "okx") {
      const credentials = okxCredentials(apiKey, apiSecret, passphrase);
      const client = this.options.okxClientFactory?.(credentials)
        ?? new OkxClient(() => credentials);
      const access = await client.validateAccess();
      assertOkxProviderIdentity(access);
      const summary = await this.store.save({
        userId,
        venue,
        accountId: access.accountId,
        accountFingerprint: access.accountFingerprint,
        ...credentials,
        permissions: {
          ...access.permissions,
          executionEnabled: false,
        },
        verifiedAt: Date.now(),
      });
      return status(venue, summary);
    }

    if (venue === "bybit") {
      const credentials = Object.freeze({ apiKey, apiSecret });
      const client = this.options.bybitClientFactory?.(credentials)
        ?? new BybitClient(() => credentials);
      const access = await client.validateAccess();
      assertBybitProviderIdentity(access);
      const summary = await this.store.save({
        userId,
        venue,
        accountId: access.accountId,
        accountFingerprint: access.accountFingerprint,
        ...credentials,
        permissions: { ...access.permissions, executionEnabled: false },
        verifiedAt: Date.now(),
      });
      return status(venue, summary);
    }

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

  async enableOkxExecution(userIdInput: string, input: unknown) {
    assertOkxExecutionEnableConfirmation(input);
    const userId = requiredIdentifier(userIdInput, "userId");
    const venue = "okx" as const;
    const existing = this.store.findSummary(userId, venue);
    if (!existing) {
      throw new UserExchangeCredentialServiceError(
        "credential_not_configured",
        "OKX credential is not configured.",
      );
    }
    if (
      existing.userId !== userId
      || existing.venue !== venue
      || !isProviderDerivedOkxIdentity(existing.accountId)
    ) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_invalid",
        "Stored OKX credential identity is not eligible for execution enablement.",
      );
    }

    const secret = await this.store.loadForExecution(userId, venue);
    const credentials = okxCredentials(secret.apiKey, secret.apiSecret, secret.passphrase);
    const client = this.options.okxClientFactory?.(credentials)
      ?? new OkxClient(() => credentials);
    const access = await client.validateAccess();
    assertOkxProviderIdentity(access);
    if (
      access.accountId !== existing.accountId
      || access.accountFingerprint !== existing.accountFingerprint
    ) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_mismatch",
        "OKX Provider identity does not match the stored credential identity.",
      );
    }
    assertOkxExecutionPermissions(access);

    const summary = await this.store.replace({
      userId,
      venue,
      expectedAccountId: existing.accountId,
      accountId: existing.accountId,
      accountFingerprint: existing.accountFingerprint,
      ...credentials,
      permissions: {
        ...access.permissions,
        executionEnabled: true,
      },
      verifiedAt: Date.now(),
    });
    return status(venue, summary);
  }

  async enableBybitExecution(userIdInput: string, input: unknown) {
    assertBybitExecutionEnableConfirmation(input);
    const userId = requiredIdentifier(userIdInput, "userId");
    const venue = "bybit" as const;
    const existing = this.store.findSummary(userId, venue);
    if (!existing) {
      throw new UserExchangeCredentialServiceError("credential_not_configured", "Bybit credential is not configured.");
    }
    if (existing.userId !== userId || existing.venue !== venue || !isProviderDerivedBybitIdentity(existing.accountId)) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_invalid",
        "Stored Bybit credential identity is not eligible for execution enablement.",
      );
    }
    const secret = await this.store.loadForExecution(userId, venue);
    const credentials = Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret });
    const client = this.options.bybitClientFactory?.(credentials) ?? new BybitClient(() => credentials);
    const access = await client.validateAccess();
    assertBybitProviderIdentity(access);
    if (access.accountId !== existing.accountId || access.accountFingerprint !== existing.accountFingerprint) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_mismatch",
        "Bybit Provider identity does not match the stored credential identity.",
      );
    }
    assertBybitExecutionPermissions(access);
    const summary = await this.store.replace({
      userId,
      venue,
      expectedAccountId: existing.accountId,
      accountId: existing.accountId,
      accountFingerprint: existing.accountFingerprint,
      ...credentials,
      permissions: { ...access.permissions, executionEnabled: true },
      verifiedAt: Date.now(),
    });
    return status(venue, summary);
  }

  async rebindBybit(userIdInput: string) {
    const userId = requiredIdentifier(userIdInput, "userId");
    const venue = "bybit" as const;
    const existing = this.store.findSummary(userId, venue);
    if (!existing) throw new UserExchangeCredentialServiceError("credential_not_configured", "Bybit credential is not configured.");
    const legacy = isLegacyBybitIdentity(existing.accountId);
    if (!legacy && !isProviderDerivedBybitIdentity(existing.accountId)) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_invalid",
        "Stored Bybit credential identity is not eligible for Provider rebind.",
      );
    }
    const secret = await this.store.loadForExecution(userId, venue);
    const credentials = Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret });
    const client = this.options.bybitClientFactory?.(credentials) ?? new BybitClient(() => credentials);
    const access = await client.validateAccess();
    assertBybitProviderIdentity(access);
    if (!legacy && access.accountId !== existing.accountId) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_mismatch",
        "Bybit Provider identity does not match the stored credential identity.",
      );
    }
    const summary = await this.store.replace({
      userId,
      venue,
      expectedAccountId: existing.accountId,
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      ...credentials,
      permissions: {
        ...access.permissions,
        executionEnabled: legacy ? false : existing.permissions.executionEnabled === true && access.permissions.executionEnabled,
      },
      verifiedAt: Date.now(),
    });
    return status(venue, summary);
  }

  async rebindOkx(userId: string) {
    const venue = "okx" as const;
    const existing = this.store.findSummary(userId, venue);
    if (!existing) {
      throw new UserExchangeCredentialServiceError(
        "credential_not_configured",
        "OKX credential is not configured.",
      );
    }
    const legacyIdentity = isLegacyOkxIdentity(existing.accountId);
    if (!legacyIdentity && !isProviderDerivedOkxIdentity(existing.accountId)) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_invalid",
        "Stored OKX credential identity is not eligible for Provider rebind.",
      );
    }

    const secret = await this.store.loadForExecution(userId, venue);
    const credentials = okxCredentials(secret.apiKey, secret.apiSecret, secret.passphrase);
    const client = this.options.okxClientFactory?.(credentials)
      ?? new OkxClient(() => credentials);
    const access = await client.validateAccess();
    assertOkxProviderIdentity(access);
    if (!legacyIdentity && access.accountId !== existing.accountId) {
      throw new UserExchangeCredentialServiceError(
        "credential_provider_identity_mismatch",
        "OKX Provider identity does not match the stored credential identity.",
      );
    }

    const summary = await this.store.replace({
      userId,
      venue,
      expectedAccountId: existing.accountId,
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      ...credentials,
      permissions: {
        ...access.permissions,
        executionEnabled: legacyIdentity
          ? false
          : existing.permissions.executionEnabled === true && access.permissions.executionEnabled,
      },
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

function requiredIdentifier(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) {
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

function localCredentialIdentity(venue: Exclude<ExchangeVenue, "binance" | "okx">, apiKey: string) {
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
  if (venue === "bybit") {
    if (!summary) return "Bybit credential requires Provider identity validation before storage.";
    if (isLegacyBybitIdentity(summary.accountId)) {
      return "Bybit credential requires a controlled Provider identity rebind before execution.";
    }
    return summary.permissions.executionEnabled
      ? "Bybit credential identity and execution permissions are Provider-verified."
      : "Bybit credential identity is Provider-verified, but execution remains disabled.";
  }
  if (venue === "okx") {
    if (!summary) return "OKX credential requires Provider identity validation before storage.";
    if (isLegacyOkxIdentity(summary.accountId)) {
      return "OKX credential requires a controlled Provider identity rebind before execution.";
    }
    return summary.permissions.executionEnabled
      ? "OKX credential identity and execution permissions are Provider-verified."
      : "OKX credential identity is Provider-verified, but execution remains disabled.";
  }
  return summary
    ? `${venueLabel(venue)} API credential is encrypted and saved. Private provider validation and execution are not enabled for this venue.`
    : `${venueLabel(venue)} supports encrypted API credential storage only; private provider validation and execution are not enabled.`;
}

function okxCredentials(apiKey: string, apiSecret: string, passphrase: string | undefined): OkxCredentials {
  if (!passphrase) {
    throw new UserExchangeCredentialServiceError("credential_input_invalid", "OKX API passphrase is required.");
  }
  return Object.freeze({ apiKey, apiSecret, passphrase });
}

function assertOkxProviderIdentity(access: OkxAccountAccess) {
  if (
    !/^okx:[a-f0-9]{16}$/u.test(access.accountId)
    || access.accountFingerprint !== access.accountId.slice("okx:".length)
    || !/^[a-f0-9]{64}$/u.test(access.uidHash)
    || !access.uidHash.startsWith(access.accountFingerprint)
  ) {
    throw new UserExchangeCredentialServiceError(
      "credential_provider_identity_invalid",
      "OKX Provider returned an invalid account identity.",
    );
  }
}

function assertBybitProviderIdentity(access: BybitAccountAccess) {
  if (!/^bybit:[a-f0-9]{16}$/u.test(access.accountId)
    || access.accountFingerprint !== access.accountId.slice("bybit:".length)
    || !/^[a-f0-9]{64}$/u.test(access.uidHash)
    || !access.uidHash.startsWith(access.accountFingerprint)) {
    throw new UserExchangeCredentialServiceError(
      "credential_provider_identity_invalid",
      "Bybit Provider returned an invalid account identity.",
    );
  }
}

function assertOkxExecutionEnableConfirmation(input: unknown) {
  const body = object(input);
  assertOnlyKeys(body, ["confirmation"]);
  if (body.confirmation !== "ENABLE_OKX_EXECUTION") {
    throw new UserExchangeCredentialServiceError(
      "credential_execution_enable_confirmation_required",
      "Explicit OKX execution enablement confirmation is required.",
    );
  }
}

function assertBybitExecutionEnableConfirmation(input: unknown) {
  const body = object(input);
  assertOnlyKeys(body, ["confirmation"]);
  if (body.confirmation !== "ENABLE_BYBIT_EXECUTION") {
    throw new UserExchangeCredentialServiceError(
      "credential_execution_enable_confirmation_required",
      "Explicit Bybit execution enablement confirmation is required.",
    );
  }
}

function assertOkxExecutionPermissions(access: OkxAccountAccess) {
  const permissions = access.permissions;
  if (
    !permissions.providerVerified
    || !permissions.read
    || !permissions.contractTrade
    || permissions.withdraw
    || !permissions.ipRestricted
    || !permissions.accountLevelSupported
    || !permissions.positionModeSupported
    || !permissions.executionEnabled
  ) {
    throw new UserExchangeCredentialServiceError(
      "credential_permissions_invalid",
      "OKX credential must be Provider-verified, allow read and perpetual trading, deny withdrawals, use an IP whitelist, and use net position mode before execution can be enabled.",
    );
  }
}

function assertBybitExecutionPermissions(access: BybitAccountAccess) {
  const permissions = access.permissions;
  if (!permissions.providerVerified || !permissions.read || !permissions.spotTrade
    || !permissions.contractTrade || permissions.withdraw || !permissions.ipRestricted
    || !permissions.accountLevelSupported || !permissions.executionEnabled) {
    throw new UserExchangeCredentialServiceError(
      "credential_permissions_invalid",
      "Bybit credential must be Provider-verified, allow read, Spot, and Linear trading, deny withdrawals, use an IP whitelist, and use UTA 2.0 REGULAR_MARGIN before execution can be enabled.",
    );
  }
}

function isLegacyOkxIdentity(accountId: string) {
  return /^okx:credential-only:[a-f0-9]{20}$/u.test(accountId);
}

function isProviderDerivedOkxIdentity(accountId: string) {
  return /^okx:[a-f0-9]{16}$/u.test(accountId);
}

function isLegacyBybitIdentity(accountId: string) {
  return /^bybit:credential-only:[a-f0-9]{20}$/u.test(accountId);
}

function isProviderDerivedBybitIdentity(accountId: string) {
  return /^bybit:[a-f0-9]{16}$/u.test(accountId);
}
