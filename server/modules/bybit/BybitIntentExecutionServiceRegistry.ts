import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import { BybitClient } from "./BybitClient";
import type { BybitCredentials } from "./BybitTypes";
import type { BybitIntentRuntimeService } from "./BybitIntentExecutionRuntime";

export type BybitExecutionCredentialSummary = Readonly<{ userId: string; accountId: string }>;

type BybitExecutionProviderClient = Pick<
  BybitClient,
  "getLinearPositionIdx" | "placeOrder" | "getOrder" | "cancelOrder" | "getAccountIdentity"
>;

export class BybitIntentExecutionServiceRegistry {
  private readonly locks = new Map<string, AsyncLock>();

  constructor(
    private readonly credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">,
    private readonly options: Readonly<{
      serviceFactory?: (credential: BybitCredentials, summary: BybitExecutionCredentialSummary) => BybitIntentRuntimeService;
      clientFactory?: (credential: BybitCredentials) => BybitExecutionProviderClient;
    }> = {},
  ) {}

  run<T>(userId: string, operation: (service: BybitIntentRuntimeService) => Promise<T> | T) {
    return this.lock(identifier(userId, "userId")).run(() => this.withService(userId, operation));
  }

  private async withService<T>(userId: string, operation: (service: BybitIntentRuntimeService) => Promise<T> | T) {
    const normalized = identifier(userId, "userId");
    const summary = this.credentials.findSummary(normalized, "bybit");
    if (!summary) throw new Error("Bybit credential is not configured for the authenticated user.");
    if (summary.permissions.executionEnabled !== true) throw new Error("Bybit credential is not enabled for execution.");
    const secret = await this.credentials.loadForExecution(normalized, "bybit");
    const credential = Object.freeze({ apiKey: secretValue(secret.apiKey, "Bybit apiKey"), apiSecret: secretValue(secret.apiSecret, "Bybit apiSecret") });
    const service = this.options.serviceFactory?.(credential, { userId: normalized, accountId: summary.accountId })
      ?? defaultService(credential, summary.accountId, this.options.clientFactory);
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
  credential: BybitCredentials,
  accountId: string,
  clientFactory?: (credential: BybitCredentials) => BybitExecutionProviderClient,
): BybitIntentRuntimeService {
  const client = clientFactory?.(credential) ?? new BybitClient(() => credential);
  return Object.freeze({
    getLinearPositionIdx: (symbol) => client.getLinearPositionIdx(symbol),
    placeOrder: (request) => client.placeOrder(request),
    getOrder: (request) => client.getOrder(request),
    cancelOrder: (request) => client.cancelOrder(request),
    executionAccountIdentity: () => Object.freeze({ accountId }),
    validateExecutionProviderIdentity: (context) => validateProviderIdentity(client, accountId, context),
  });
}

async function validateProviderIdentity(
  client: Pick<BybitExecutionProviderClient, "getAccountIdentity">,
  expectedAccountId: string,
  context: ExecutionMutationContext,
) {
  if (context.venue !== "bybit" || context.accountId !== expectedAccountId) {
    throw new Error("Bybit execution account binding does not match the mutation context.");
  }
  const identity = await client.getAccountIdentity();
  if (identity.accountId !== expectedAccountId) {
    throw new Error("Bybit Provider UID does not match the configured execution account.");
  }
}

function identifier(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw new Error(`${name} is invalid.`);
  return text;
}
function secretValue(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512) throw new Error(`${name} is invalid.`);
  return text;
}
class AsyncLock {
  private tail = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
