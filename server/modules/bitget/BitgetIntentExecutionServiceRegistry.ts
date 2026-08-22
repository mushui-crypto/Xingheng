import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import { BitgetClient } from "./BitgetClient";
import type { BitgetCredentials } from "./BitgetTypes";
import type { BitgetIntentRuntimeService } from "./BitgetIntentExecutionRuntime";

export type BitgetExecutionCredentialSummary = Readonly<{ userId: string; accountId: string }>;
type BitgetExecutionProviderClient = Pick<BitgetClient, "assertOneWayMode" | "placeOrder" | "getOrder" | "cancelOrder" | "getAccountIdentity">
  & Partial<Pick<BitgetClient, "readPositionMode">>;

export class BitgetIntentExecutionServiceRegistry {
  private readonly locks = new Map<string, AsyncLock>();

  constructor(
    private readonly credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">,
    private readonly options: Readonly<{
      serviceFactory?: (credential: BitgetCredentials, summary: BitgetExecutionCredentialSummary) => BitgetIntentRuntimeService;
      clientFactory?: (credential: BitgetCredentials) => BitgetExecutionProviderClient;
    }> = {},
  ) {}

  run<T>(userId: string, operation: (service: BitgetIntentRuntimeService) => Promise<T> | T) {
    return this.lock(identifier(userId, "userId")).run(() => this.withService(userId, operation));
  }

  private async withService<T>(userId: string, operation: (service: BitgetIntentRuntimeService) => Promise<T> | T) {
    const normalized = identifier(userId, "userId");
    const summary = this.credentials.findSummary(normalized, "bitget");
    if (!summary) throw new Error("Bitget credential is not configured for the authenticated user.");
    if (summary.permissions.executionEnabled !== true || summary.permissions.providerVerified !== true
      ) {
      throw new Error("Bitget credential is not enabled for execution.");
    }
    const secret = await this.credentials.loadForExecution(normalized, "bitget");
    const credential = Object.freeze({
      apiKey: secretValue(secret.apiKey, "Bitget apiKey"), apiSecret: secretValue(secret.apiSecret, "Bitget apiSecret"),
      passphrase: secretValue(secret.passphrase, "Bitget passphrase"),
    });
    const service = this.options.serviceFactory?.(credential, { userId: normalized, accountId: summary.accountId })
      ?? defaultService(credential, summary.accountId, this.options.clientFactory);
    return operation(service);
  }

  private lock(userId: string) {
    let lock = this.locks.get(userId);
    if (!lock) { lock = new AsyncLock(); this.locks.set(userId, lock); }
    return lock;
  }
}

function defaultService(
  credential: BitgetCredentials,
  accountId: string,
  clientFactory?: (credential: BitgetCredentials) => BitgetExecutionProviderClient,
): BitgetIntentRuntimeService {
  const client = clientFactory?.(credential) ?? new BitgetClient(() => credential);
  return Object.freeze({
    assertOneWayMode: () => client.assertOneWayMode(),
    readPositionMode: () => client.readPositionMode?.() ?? client.assertOneWayMode().then(() => "ONE_WAY" as const),
    placeOrder: (request) => client.placeOrder(request),
    getOrder: (request) => client.getOrder(request),
    cancelOrder: (request) => client.cancelOrder(request),
    executionAccountIdentity: () => Object.freeze({ accountId }),
    validateExecutionProviderIdentity: (context) => validateProviderIdentity(client, accountId, context),
  });
}

async function validateProviderIdentity(
  client: Pick<BitgetExecutionProviderClient, "getAccountIdentity">,
  expectedAccountId: string,
  context: ExecutionMutationContext,
) {
  if (context.venue !== "bitget" || context.accountId !== expectedAccountId) {
    throw new Error("Bitget execution account binding does not match the mutation context.");
  }
  if ((await client.getAccountIdentity()).accountId !== expectedAccountId) {
    throw new Error("Bitget Provider UID does not match the configured execution account.");
  }
}

function identifier(value: unknown, name: string) { const text = typeof value === "string" ? value.trim() : ""; if (!text || text.length > 200) throw new Error(`${name} is invalid.`); return text; }
function secretValue(value: unknown, name: string) { const text = typeof value === "string" ? value.trim() : ""; if (!text || text.length > 512) throw new Error(`${name} is invalid.`); return text; }
class AsyncLock {
  private tail = Promise.resolve();
  async run<T>(operation: () => Promise<T>) { const previous = this.tail; let release!: () => void; this.tail = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
}
