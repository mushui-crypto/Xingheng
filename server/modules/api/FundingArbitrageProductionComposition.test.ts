import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { FundingLegExecutionLinkStore } from "../cex/funding-arbitrage/FundingLegExecutionLinkStore";
import { CredentialVenueExecutionAccountResolver } from "./CredentialVenueExecutionAccountResolver";
import { FundingArbitrageManualExecutionService } from "./FundingArbitrageManualExecutionService";
import { ManualRequestFundingArbitrageExecutionIntentSource } from "./ManualRequestFundingArbitrageExecutionIntentSource";
import { registerFundingArbitrageManualExecutionRoutes } from "./fundingArbitrageManualExecutionRoutes";

const now = 1_800_000_000_000;

test("authenticated manual API creates a user-scoped ExecutionRecord without provider mutation", async () => {
  await withComposition({ accountId: "binance:account-user-a" }, async (composition) => {
    const response = await composition.request("user-a", request());

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.executionRecordId, "execution-record-1");
    assert.deepEqual(composition.credentialLookups, [{ userId: "user-a", venue: "binance" }]);
    assert.equal(composition.providerMutations(), 0);
    assert.equal(composition.capabilityCalls(), 1);

    const record = composition.records.loadForUser("user-a", "execution-record-1");
    assert.equal(record?.userId, "user-a");
    assert.equal(record?.accountId, "binance:account-user-a");
    assert.equal(record?.intentId, "execution-intent-1");
    assert.equal(record?.instrumentId, "XAUT-USDT-PERP");
    assert.equal(record?.status, "PENDING_CONFIRMATION");
    assert.equal(composition.records.loadForUser("user-b", "execution-record-1"), null);
  });
});

test("missing account binding rejects before runtime and provider mutation", async () => {
  await withComposition({}, async (composition) => {
    const response = await composition.request("user-a", request());

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.category, "credential_not_configured");
    assert.equal(composition.capabilityCalls(), 0);
    assert.equal(composition.providerMutations(), 0);
  });
});

test("manual payload cannot override authenticated user binding", async () => {
  await withComposition({ accountId: "binance:account-user-a" }, async (composition) => {
    const response = await composition.request("user-a", {
      ...request(),
      fundingIntent: { ...fundingIntent(), userId: "user-b" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.category, "invalid_manual_execution_request");
    assert.deepEqual(composition.credentialLookups, []);
    assert.equal(composition.capabilityCalls(), 0);
    assert.equal(composition.providerMutations(), 0);
  });
});

test("manual request cannot provide account binding", async () => {
  await withComposition({ accountId: "binance:account-user-a" }, async (composition) => {
    const response = await composition.request("user-a", {
      ...request(),
      accountId: "binance:client-selected-account",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.category, "invalid_manual_execution_request");
    assert.deepEqual(composition.credentialLookups, []);
    assert.equal(composition.capabilityCalls(), 0);
    assert.equal(composition.providerMutations(), 0);
  });
});

test("funding intent envelope identity must match the confirmed payload", async () => {
  await withComposition({ accountId: "binance:account-user-a" }, async (composition) => {
    const response = await composition.request("user-a", {
      ...request(),
      fundingIntentId: "different-funding-intent",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.category, "invalid_manual_execution_request");
    assert.deepEqual(composition.credentialLookups, []);
    assert.equal(composition.capabilityCalls(), 0);
    assert.equal(composition.providerMutations(), 0);
  });
});

test("duplicate funding leg is rejected before a second runtime execution", async () => {
  await withComposition({ accountId: "binance:account-user-a" }, async (composition) => {
    const first = await composition.request("user-a", request());
    const second = await composition.request("user-a", request());

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 400);
    assert.equal(second.body.category, "funding_leg_already_executed");
    assert.equal(composition.capabilityCalls(), 1);
    assert.equal(composition.providerMutations(), 0);
  });
});

async function withComposition(
  options: { accountId?: string },
  run: (composition: Awaited<ReturnType<typeof createComposition>>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "funding-production-composition-"));
  const composition = await createComposition(join(root, "trading.sqlite"), options);
  try {
    await run(composition);
  } finally {
    composition.links.close();
    composition.records.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function createComposition(dbPath: string, options: { accountId?: string }) {
  let capabilityCalls = 0;
  let providerMutations = 0;
  const credentialLookups: Array<{ userId: string; venue: string }> = [];
  const credentials = {
    findSummary(userId: string, venue: string) {
      credentialLookups.push({ userId, venue });
      if (!options.accountId || userId !== "user-a" || venue !== "binance") return null;
      return { userId, venue, accountId: options.accountId } as any;
    },
  };
  const registry = {
    async run<T>(userId: string, operation: (service: any) => Promise<T> | T) {
      assert.equal(userId, "user-a");
      return operation({
        async account() {
          return { accountId: options.accountId };
        },
        async market() {
          throw new Error("provider market read is not expected");
        },
        async placeExecutionOrder() {
          providerMutations += 1;
          throw new Error("provider mutation is forbidden in this test");
        },
        ordersState() {
          return { orders: [] };
        },
        async findExecutionOrderByClientOrderId() {
          throw new Error("provider query is not expected");
        },
        async cancelOrder() {
          providerMutations += 1;
          throw new Error("provider mutation is forbidden in this test");
        },
      });
    },
  };
  const records = new SqliteExecutionRecordStore({ dbPath });
  const links = new FundingLegExecutionLinkStore({ dbPath, now: () => now });
  const runtime = new BinanceIntentExecutionRuntime(
    registry,
    { maxSlippageBps: 20 },
    records,
    {
      clock: () => now,
      createExecutionId: () => "execution-record-1",
      createCapability: () => ({
        async execute(intent) {
          capabilityCalls += 1;
          return {
            executionAttemptId: intent.intentId,
            state: "PENDING_CONFIRMATION" as const,
          };
        },
      }),
    },
  );
  const service = new FundingArbitrageManualExecutionService(
    new ManualRequestFundingArbitrageExecutionIntentSource(),
    new CredentialVenueExecutionAccountResolver(credentials as any),
    runtime,
    links,
    { clock: () => now, createIntentId: () => "execution-intent-1" },
  );
  let handler: any;
  registerFundingArbitrageManualExecutionRoutes({
    post(path: string, route: unknown) {
      assert.equal(path, "/api/funding-arbitrage/executions/manual");
      handler = route;
    },
  } as any, service);

  return {
    records,
    links,
    credentialLookups,
    capabilityCalls: () => capabilityCalls,
    providerMutations: () => providerMutations,
    async request(userId: string, body: unknown) {
      const response = createMockResponse();
      await handler({ user: { id: userId }, body }, response);
      return response;
    },
  };
}

function request() {
  return {
    fundingIntentId: "funding-intent-1",
    fundingIntent: fundingIntent(),
    legId: "leg-binance",
    confirmed: true,
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    expiresAt: now + 30_000,
  };
}

function fundingIntent() {
  return {
    intentId: "funding-intent-1",
    sourcePlanId: "manual-plan-1",
    strategyType: "PERPETUAL_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.0001" },
    legs: [
      {
        legId: "leg-binance",
        role: "long",
        venue: "binance",
        instrumentId: "XAUT-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.002",
      },
      {
        legId: "leg-okx",
        role: "short",
        venue: "okx",
        instrumentId: "XAUT-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.002",
      },
    ],
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}
