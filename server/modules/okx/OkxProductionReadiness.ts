import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type { OkxExecutionOrderReference } from "./OkxExecutionOrderReferenceStore";
import { OkxInstrumentMappingAdapter } from "./OkxInstrumentMapping";
import { OkxClient } from "./OkxClient";
import type {
  OkxAccountIdentity,
  OkxCredentials,
  OkxGetOrderRequest,
  OkxPerpetualPosition,
  OkxProviderOrder,
} from "./OkxTypes";

export type OkxProductionReadinessClient = Readonly<{
  getAccountIdentity(): Promise<OkxAccountIdentity>;
  getPosition(instId: string): Promise<readonly OkxPerpetualPosition[]>;
  getOpenOrders(instId: string): Promise<readonly OkxProviderOrder[]>;
  getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder>;
}>;

export type OkxProductionReadinessInput = Readonly<{
  userId: string;
  accountId: string;
  instrumentId: string;
  orderQuery?: OkxGetOrderRequest;
  reconciliation?: Readonly<{
    record: ExecutionRecord;
    reference: OkxExecutionOrderReference;
  }>;
}>;

export type OkxProductionReadinessResult = Readonly<{
  venue: "okx";
  userId: string;
  accountId: string;
  instrumentId: string;
  instId: string;
  checks: Readonly<{
    credentialLoading: "PASS";
    accountIdentity: "PASS";
    instrumentResolution: "PASS";
    positionRead: "PASS";
    openOrderRead: "PASS";
    orderQuery: "PASS" | "SKIPPED";
    reconciliationRead: "PASS" | "SKIPPED";
  }>;
  accountIdentity: OkxAccountIdentity;
  positions: readonly OkxPerpetualPosition[];
  openOrders: readonly OkxProviderOrder[];
  orderQuery: OkxProviderOrder | null;
  reconciliationOrder: OkxProviderOrder | null;
  providerMutations: 0;
}>;

export class OkxProductionReadinessService {
  private readonly instrumentMapping: OkxInstrumentMappingAdapter;

  constructor(
    private readonly credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">,
    private readonly options: Readonly<{
      clientFactory?: (credential: OkxCredentials) => OkxProductionReadinessClient;
      instrumentMapping?: OkxInstrumentMappingAdapter;
    }> = {},
  ) {
    this.instrumentMapping = options.instrumentMapping ?? new OkxInstrumentMappingAdapter();
  }

  async verify(input: OkxProductionReadinessInput): Promise<OkxProductionReadinessResult> {
    const userId = identifier(input.userId, "userId");
    const accountId = identifier(input.accountId, "accountId");
    const summary = this.credentials.findSummary(userId, "okx");
    if (!summary) throw new Error("OKX credential is not configured for the authenticated user.");
    if (summary.accountId !== accountId) {
      throw new Error("OKX credential accountId does not match the readiness request.");
    }
    const secret = await this.credentials.loadForExecution(userId, "okx");
    const client = this.clientFor(secret);
    const resolved = this.instrumentMapping.resolve(input.instrumentId);
    const instId = resolved.venueInstrument.instId;

    const accountIdentity = await client.getAccountIdentity();
    if (accountIdentity.accountId !== accountId) {
      throw new Error("OKX provider account identity does not match the readiness request.");
    }
    const positions = await client.getPosition(instId);
    const openOrders = await client.getOpenOrders(instId);
    const orderQuery = input.orderQuery === undefined
      ? null
      : await client.getOrder(normalizeOrderQuery(input.orderQuery, instId));
    const reconciliationOrder = input.reconciliation === undefined
      ? null
      : await client.getOrder(reconciliationQuery(input.reconciliation, userId, accountId, input.instrumentId, instId));

    return Object.freeze({
      venue: "okx",
      userId,
      accountId,
      instrumentId: resolved.canonicalInstrument.instrumentId,
      instId,
      checks: Object.freeze({
        credentialLoading: "PASS",
        accountIdentity: "PASS",
        instrumentResolution: "PASS",
        positionRead: "PASS",
        openOrderRead: "PASS",
        orderQuery: orderQuery === null ? "SKIPPED" : "PASS",
        reconciliationRead: reconciliationOrder === null ? "SKIPPED" : "PASS",
      }),
      accountIdentity,
      positions,
      openOrders,
      orderQuery,
      reconciliationOrder,
      providerMutations: 0,
    });
  }

  private clientFor(secret: Awaited<ReturnType<UserExchangeCredentialStore["loadForExecution"]>>) {
    const credential = normalizeCredential(secret);
    return this.options.clientFactory?.(credential)
      ?? new OkxClient(() => credential);
  }
}

function normalizeOrderQuery(request: OkxGetOrderRequest, instId: string): OkxGetOrderRequest {
  if (request.instId !== instId) throw new Error("OKX order query instId does not match the readiness instrument.");
  if (!request.ordId && !request.clOrdId) throw new Error("OKX order query requires ordId or clOrdId.");
  return request;
}

function reconciliationQuery(
  input: NonNullable<OkxProductionReadinessInput["reconciliation"]>,
  userId: string,
  accountId: string,
  instrumentId: string,
  instId: string,
): OkxGetOrderRequest {
  const { record, reference } = input;
  if (
    record.userId !== userId
    || record.accountId !== accountId
    || record.venue !== "okx"
    || record.instrumentId !== instrumentId
  ) {
    throw new Error("OKX reconciliation record identity does not match readiness input.");
  }
  if (
    reference.userId !== userId
    || reference.accountId !== accountId
    || reference.instrumentId !== instrumentId
    || reference.instId !== instId
  ) {
    throw new Error("OKX reconciliation order reference identity does not match readiness input.");
  }
  return Object.freeze({
    instId: reference.instId,
    ordId: reference.ordId,
    clOrdId: reference.clOrdId,
  });
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
