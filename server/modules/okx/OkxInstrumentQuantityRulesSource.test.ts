import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { InMemoryOkxExecutionOrderReferenceStore } from "./OkxExecutionOrderReferenceStore";
import { OkxFormalArbitrageExecutionRuntime } from "./OkxFormalArbitrageExecutionRuntime";
import { createOkxInstrumentQuantityRulesSource } from "./OkxInstrumentQuantityRulesSource";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import { OkxIntentExecutionService } from "./OkxIntentExecutionService";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;

test("loads authoritative OKX instrument quantity rules from the public production endpoint", async () => {
  const requests: URL[] = [];
  const source = sourceFor(okxResponse(), { requests });

  assert.deepEqual(await source("DOGE-USDT-SWAP"), {
    instType: "SWAP",
    instId: "DOGE-USDT-SWAP",
    uly: "DOGE-USDT",
    ctType: "linear",
    ctValCcy: "DOGE",
    settleCcy: "USDT",
    lotSz: "1",
    minSz: "1",
    ctVal: "10",
    state: "live",
    fetchedAt: now,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.pathname, "/api/v5/public/instruments");
  assert.equal(requests[0]?.searchParams.get("instType"), "SWAP");
  assert.equal(requests[0]?.searchParams.get("instId"), "DOGE-USDT-SWAP");
});

test("injects production rules through the formal runtime and OkxQuantitySemantics before provider mutation", async () => {
  const client = new FakeOkxExecutionClient();
  const records = new InMemoryExecutionRecordStore();
  const runtime = new OkxIntentExecutionRuntime(
    {
      run: async (_userId, operation) => operation(client),
    },
    records,
    new InMemoryOkxExecutionOrderReferenceStore(),
    {
      createExecutionId: () => "execution-okx-production-rules",
      clock: () => now,
      quantityRulesSource: sourceFor(okxResponse()),
      mutationSafetyGuard: mutationGuard(),
    },
  );
  const formalRuntime = new OkxFormalArbitrageExecutionRuntime(runtime);

  const result = await formalRuntime.execute(executionIntent());

  assert.equal(result.executionRecord.executionId, "execution-okx-production-rules");
  assert.equal(result.confirmedQuantity, "0");
  assert.equal(client.placeRequests.length, 1);
  assert.equal(client.placeRequests[0]?.quantity, "10");
  assert.equal(client.placeRequests[0]?.instId, "DOGE-USDT-SWAP");
});

test("missing, stale, invalid, or mismatched production rules fail closed before provider mutation", async (t) => {
  for (const fixture of [
    { name: "rules missing", payload: { code: "0", data: [] }, pattern: /unavailable/u },
    { name: "ctVal missing", payload: okxResponse({ ctVal: undefined }), pattern: /ctVal/u },
    { name: "ctVal invalid", payload: okxResponse({ ctVal: "0" }), pattern: /ctVal/u },
    { name: "lotSz invalid", payload: okxResponse({ lotSz: "0" }), pattern: /lotSz/u },
    { name: "minSz invalid", payload: okxResponse({ minSz: "0" }), pattern: /minSz/u },
    {
      name: "instrument mismatch",
      payload: okxResponse({ instId: "BTC-USDT-SWAP", uly: "BTC-USDT", ctValCcy: "BTC" }),
      pattern: /instrument identity/u,
    },
  ] as const) {
    await t.test(fixture.name, async () => {
      const client = new FakeOkxExecutionClient();
      const service = executionService(client, sourceFor(fixture.payload));

      await assert.rejects(() => service.execute(executionIntent()), fixture.pattern);
      assert.equal(client.placeRequests.length, 0);
    });
  }

  await t.test("rules stale", async () => {
    const client = new FakeOkxExecutionClient();
    const service = executionService(
      client,
      sourceFor(okxResponse(), { sourceClock: () => now - 300_001 }),
    );

    await assert.rejects(() => service.execute(executionIntent()), /stale/u);
    assert.equal(client.placeRequests.length, 0);
  });
});

function sourceFor(
  payload: unknown,
  options: Readonly<{
    requests?: URL[];
    sourceClock?: () => number;
  }> = {},
) {
  return createOkxInstrumentQuantityRulesSource({
    baseUrl: "https://okx-rules.test",
    clock: options.sourceClock ?? (() => now),
    fetchImpl: (async (input) => {
      options.requests?.push(new URL(String(input)));
      return Response.json(payload);
    }) as typeof fetch,
  });
}

function okxResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  const row: Record<string, unknown> = {
    instType: "SWAP",
    instId: "DOGE-USDT-SWAP",
    uly: "DOGE-USDT",
    ctType: "linear",
    ctValCcy: "DOGE",
    settleCcy: "USDT",
    lotSz: "1",
    minSz: "1",
    ctVal: "10",
    state: "live",
    ...overrides,
  };
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) delete row[key];
  }
  return { code: "0", data: [row] };
}

function executionService(
  client: FakeOkxExecutionClient,
  quantityRulesSource: ReturnType<typeof createOkxInstrumentQuantityRulesSource>,
) {
  return new OkxIntentExecutionService(client, {
    clock: () => now,
    quantityRulesSource,
    mutationSafetyGuard: mutationGuard(),
  });
}

function mutationGuard() {
  return new ExecutionMutationSafetyGuard({
    liveTradingEnabled: true,
    killSwitchActive: false,
  });
}

function executionIntent() {
  return createExecutionIntent({
    intentId: "intent-okx-production-rules",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
    side: "sell",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "100",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

class FakeOkxExecutionClient {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];

  async readPositionMode() {
    return "ONE_WAY" as const;
  }

  executionAccountIdentity() {
    return { accountId: "okx:account-user-a" };
  }

  validateExecutionProviderIdentity() {}

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return {
      instId: request.instId,
      ordId: "7001",
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(_request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    throw new Error("unused");
  }

  async cancelOrder(_request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    throw new Error("unused");
  }
}

class InMemoryExecutionRecordStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord) {
    this.records.set(record.executionId, record);
  }

  update(record: ExecutionRecord) {
    this.records.set(record.executionId, record);
  }

  loadForUser(userId: string, executionId: string) {
    const record = this.records.get(executionId);
    return record?.userId === userId ? record : null;
  }
}
