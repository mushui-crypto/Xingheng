import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import { OkxClient } from "./OkxClient";
import type { OkxAccountIdentity, OkxCredentials } from "./OkxTypes";
import type { OkxIntentRuntimeService } from "./OkxIntentExecutionRuntime";

export type OkxExecutionCredentialSummary = Readonly<{
  userId: string;
  accountId: string;
}>;

type OkxExecutionProviderClient = Pick<
  OkxClient,
  "placeOrder" | "getOrder" | "cancelOrder" | "getAccountIdentity"
> & Partial<Pick<OkxClient, "readPositionMode">>;

export class OkxIntentExecutionServiceRegistry {
  private readonly locks = new Map<string, AsyncLock>();

  constructor(
    private readonly credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">,
    private readonly options: Readonly<{
      serviceFactory?: (credential: OkxCredentials, summary: OkxExecutionCredentialSummary) => OkxIntentRuntimeService;
      clientFactory?: (credential: OkxCredentials) => OkxExecutionProviderClient;
    }> = {},
  ) {}

  run<T>(userId: string, operation: (service: OkxIntentRuntimeService) => Promise<T> | T) {
    return this.lock(identifier(userId, "userId")).run(() => this.withService(userId, operation));
  }

  private async withService<T>(userId: string, operation: (service: OkxIntentRuntimeService) => Promise<T> | T) {
    const normalizedUserId = identifier(userId, "userId");
    const summary = this.credentials.findSummary(normalizedUserId, "okx");
    if (!summary) throw new Error("OKX credential is not configured for the authenticated user.");
    if (summary.permissions.executionEnabled !== true) {
      throw new Error("OKX credential is not enabled for execution.");
    }
    const secret = await this.credentials.loadForExecution(normalizedUserId, "okx");
    const credential = normalizeCredential(secret);
    const service = this.options.serviceFactory?.(credential, {
      userId: normalizedUserId,
      accountId: summary.accountId,
    }) ?? defaultService(credential, summary.accountId, this.options.clientFactory);
    return operation(service);
  }

  private lock(userId: string) {
    let lock = this.locks.get(userId);
    if (!lock) {
      lock = new AsyncLock();
      this.locks.set(userId, lock);
    }
    return lock;
  }
}

function defaultService(
  credential: OkxCredentials,
  accountId: string,
  clientFactory?: (credential: OkxCredentials) => OkxExecutionProviderClient,
): OkxIntentRuntimeService {
  const client = clientFactory?.(credential) ?? new OkxClient(() => credential);
  return Object.freeze({
    placeOrder: (request) => client.placeOrder(request),
    getOrder: (request) => client.getOrder(request),
    cancelOrder: (request) => client.cancelOrder(request),
    readPositionMode: () => client.readPositionMode?.() ?? Promise.resolve("ONE_WAY" as const),
    executionAccountIdentity: () => Object.freeze({ accountId }),
    validateExecutionProviderIdentity: (context) =>
      validateExecutionProviderIdentity(client, accountId, context),
  });
}

async function validateExecutionProviderIdentity(
  client: Pick<OkxExecutionProviderClient, "getAccountIdentity">,
  expectedAccountId: string,
  context: ExecutionMutationContext,
) {
  if (context.venue !== "okx" || context.accountId !== expectedAccountId) {
    throw new Error("OKX execution account binding does not match the mutation context.");
  }
  const providerIdentity: OkxAccountIdentity = await client.getAccountIdentity();
  if (providerIdentity.accountId !== expectedAccountId) {
    throw new Error("OKX Provider UID does not match the configured execution account.");
  }
}

function normalizeCredential(input: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): OkxCredentials {
  if (!input.passphrase) throw new Error("OKX credential passphrase is not configured.");
  return Object.freeze({
    apiKey: secret(input.apiKey, "OKX apiKey"),
    apiSecret: secret(input.apiSecret, "OKX apiSecret"),
    passphrase: secret(input.passphrase, "OKX passphrase"),
  });
}

function secret(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512) throw new Error(`${name} is invalid.`);
  return text;
}

function identifier(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw new Error(`${name} is invalid.`);
  return text;
}

class AsyncLock {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
