import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "../cex/Asset";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecordFromIntent } from "../cex/ExecutionRecord";
import type {
  FundingArbitrageExecutionIntent,
  PerpetualPerpetualFundingArbitrageExecutionIntent,
} from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import {
  FundingArbitrageManualExecutionError,
  FundingArbitrageManualExecutionService,
  type FundingLegExecutionLink,
  type ManualExecutionRuntime,
} from "./FundingArbitrageManualExecutionService";

const now = 1_800_000_000_000;
const xaut: Asset = Object.freeze({ symbol: "XAUT", type: "RWA_ASSET" });

test("manual confirmation creates a canonical intent and executes through the runtime", async () => {
  const source = new FakeFundingIntentSource({ "user-a": fundingIntent() });
  const accounts = new FakeAccountResolver();
  const runtime = new FakeRuntime();
  const links = new FakeFundingLegExecutionLinkStore();
  const service = newService(source, accounts, runtime, links);

  const result = await service.execute("user-a", request());

  assert.equal(result.intentId, "execution-intent-1");
  assert.equal(result.executionRecordId, "execution-record-1");
  assert.equal(result.userId, "user-a");
  assert.equal(result.accountId, "binance:account-user-a");
  assert.equal(result.instrumentId, "XAUT-USDT-PERP");
  assert.equal(result.execution, "executed");
  assert.deepEqual(source.loads, [{
    userId: "user-a",
    fundingIntentId: "funding-intent-1",
    input: fundingIntent(),
  }]);
  assert.deepEqual(accounts.resolutions, [{ userId: "user-a", venue: "binance" }]);
  assert.equal(runtime.intents.length, 1);
  assert.equal(runtime.intents[0]?.userId, "user-a");
  assert.equal(runtime.intents[0]?.quantity.quantity, "0.002");
  assert.deepEqual(links.links, [{
    userId: "user-a",
    fundingIntentId: "funding-intent-1",
    legId: "leg-binance",
    link: {
      executionIntentId: "execution-intent-1",
      executionRecordId: "execution-record-1",
    },
  }]);
  assert.deepEqual(links.findForUser("user-a", "funding-intent-1", "leg-binance"), {
    executionIntentId: "execution-intent-1",
    executionRecordId: "execution-record-1",
  });
});

test("rejects a repeated funding leg before account resolution or provider mutation", async () => {
  const accounts = new FakeAccountResolver();
  const runtime = new FakeRuntime();
  const links = new FakeFundingLegExecutionLinkStore();
  links.seed("user-a", "funding-intent-1", "leg-binance", {
    executionIntentId: "existing-intent",
    executionRecordId: "existing-record",
  });
  const service = newService(
    new FakeFundingIntentSource({ "user-a": fundingIntent() }),
    accounts,
    runtime,
    links,
  );

  await assert.rejects(
    () => service.execute("user-a", request()),
    (error: unknown) => error instanceof FundingArbitrageManualExecutionError
      && error.category === "funding_leg_already_executed",
  );
  assert.deepEqual(accounts.resolutions, []);
  assert.equal(runtime.providerMutations, 0);
});

test("execution links are isolated by authenticated user", async () => {
  const links = new FakeFundingLegExecutionLinkStore();
  links.seed("user-b", "funding-intent-1", "leg-binance", {
    executionIntentId: "user-b-intent",
    executionRecordId: "user-b-record",
  });
  const runtime = new FakeRuntime();
  const service = newService(
    new FakeFundingIntentSource({ "user-a": fundingIntent() }),
    new FakeAccountResolver(),
    runtime,
    links,
  );

  await service.execute("user-a", request());

  assert.equal(runtime.providerMutations, 1);
  assert.equal(links.findForUser("user-b", "funding-intent-1", "leg-binance")?.executionRecordId, "user-b-record");
  assert.equal(links.findForUser("user-a", "funding-intent-1", "leg-binance")?.executionRecordId, "execution-record-1");
});

test("missing confirmation rejects before runtime execution", async () => {
  const runtime = new FakeRuntime();
  const service = newService(new FakeFundingIntentSource({ "user-a": fundingIntent() }), new FakeAccountResolver(), runtime);

  await assert.rejects(
    () => service.execute("user-a", request({ confirmed: false })),
    /explicit human confirmation/u,
  );
  assert.equal(runtime.intents.length, 0);
});

test("client userId override is rejected and authenticated user remains authoritative", async () => {
  const source = new FakeFundingIntentSource({ "user-a": fundingIntent() });
  const runtime = new FakeRuntime();
  const service = newService(source, new FakeAccountResolver(), runtime);

  await assert.rejects(
    () => service.execute("user-a", request({ userId: "user-b" })),
    /unsupported field: userId/u,
  );
  assert.deepEqual(source.loads, []);
  assert.equal(runtime.intents.length, 0);
});

test("account mismatch is stopped by the runtime before provider mutation", async () => {
  const runtime = new FakeRuntime({ expectedAccountId: "binance:actual-account" });
  const service = newService(
    new FakeFundingIntentSource({ "user-a": fundingIntent() }),
    new FakeAccountResolver({ accountId: "binance:wrong-account" }),
    runtime,
  );

  await assert.rejects(
    () => service.execute("user-a", request()),
    /account mismatch/u,
  );
  assert.equal(runtime.providerMutations, 0);
});

test("venue mismatch rejects before account binding or provider mutation", async () => {
  const accounts = new FakeAccountResolver();
  const runtime = new FakeRuntime();
  const service = newService(
    new FakeFundingIntentSource({ "user-a": fundingIntent({
      legs: [
        { ...fundingIntent().legs[0], venue: "okx" },
        fundingIntent().legs[1],
      ],
    }) }),
    accounts,
    runtime,
  );

  await assert.rejects(
    () => service.execute("user-a", request()),
    /supports Binance legs only/u,
  );
  assert.deepEqual(accounts.resolutions, []);
  assert.equal(runtime.providerMutations, 0);
});

test("kill switch block propagates before provider mutation", async () => {
  const runtime = new FakeRuntime({ error: new Error("Binance kill switch is active.") });
  const service = newService(new FakeFundingIntentSource({ "user-a": fundingIntent() }), new FakeAccountResolver(), runtime);

  await assert.rejects(
    () => service.execute("user-a", request()),
    /kill switch/u,
  );
  assert.equal(runtime.providerMutations, 0);
});

test("LIVE disabled block propagates before provider mutation", async () => {
  const runtime = new FakeRuntime({ error: new Error("LIVE_TRADING_ENABLED is not true.") });
  const service = newService(new FakeFundingIntentSource({ "user-a": fundingIntent() }), new FakeAccountResolver(), runtime);

  await assert.rejects(
    () => service.execute("user-a", request()),
    /LIVE_TRADING_ENABLED/u,
  );
  assert.equal(runtime.providerMutations, 0);
});

test("RiskGuard rejection propagates before provider mutation", async () => {
  const runtime = new FakeRuntime({ error: new Error("RiskGuard rejected order.") });
  const service = newService(new FakeFundingIntentSource({ "user-a": fundingIntent() }), new FakeAccountResolver(), runtime);

  await assert.rejects(
    () => service.execute("user-a", request()),
    /RiskGuard/u,
  );
  assert.equal(runtime.providerMutations, 0);
});

class FakeFundingIntentSource {
  readonly loads: { userId: string; fundingIntentId: string; input: unknown }[] = [];

  constructor(private readonly intentsByUser: Record<string, FundingArbitrageExecutionIntent>) {}

  async loadForUser(userId: string, fundingIntentId: string, input: unknown) {
    this.loads.push({ userId, fundingIntentId, input });
    const intent = this.intentsByUser[userId];
    return intent?.intentId === fundingIntentId ? intent : null;
  }
}

class FakeAccountResolver {
  readonly resolutions: { userId: string; venue: ExecutionIntent["venue"] }[] = [];

  constructor(private readonly binding: { accountId?: string; quantityAsset?: Asset } = {}) {}

  async resolve(userId: string, venue: ExecutionIntent["venue"]) {
    this.resolutions.push({ userId, venue });
    return {
      accountId: this.binding.accountId ?? `binance:account-${userId}`,
      quantityAsset: this.binding.quantityAsset ?? xaut,
    };
  }
}

class FakeFundingLegExecutionLinkStore {
  readonly links: Array<{
    userId: string;
    fundingIntentId: string;
    legId: string;
    link: FundingLegExecutionLink;
  }> = [];
  private readonly records = new Map<string, FundingLegExecutionLink & { completed: boolean }>();

  findForUser(userId: string, fundingIntentId: string, legId: string) {
    const record = this.records.get(linkKey(userId, fundingIntentId, legId));
    if (!record?.completed) return null;
    return {
      executionIntentId: record.executionIntentId,
      executionRecordId: record.executionRecordId,
    };
  }

  claimForUser(userId: string, fundingIntentId: string, legId: string, executionIntentId: string) {
    const key = linkKey(userId, fundingIntentId, legId);
    if (this.records.has(key)) return false;
    this.records.set(key, { executionIntentId, executionRecordId: "pending", completed: false });
    return true;
  }

  linkForUser(
    userId: string,
    fundingIntentId: string,
    legId: string,
    link: FundingLegExecutionLink,
  ) {
    const key = linkKey(userId, fundingIntentId, legId);
    const claimed = this.records.get(key);
    if (!claimed || claimed.executionIntentId !== link.executionIntentId) {
      throw new Error("execution claim mismatch");
    }
    this.records.set(key, { ...link, completed: true });
    this.links.push({ userId, fundingIntentId, legId, link });
  }

  seed(
    userId: string,
    fundingIntentId: string,
    legId: string,
    link: FundingLegExecutionLink,
  ) {
    this.records.set(linkKey(userId, fundingIntentId, legId), { ...link, completed: true });
  }
}

class FakeRuntime implements ManualExecutionRuntime<"executed"> {
  readonly intents: ExecutionIntent[] = [];
  providerMutations = 0;

  constructor(private readonly options: { expectedAccountId?: string; error?: Error } = {}) {}

  async execute(intent: ExecutionIntent) {
    this.intents.push(intent);
    if (this.options.expectedAccountId && intent.accountId !== this.options.expectedAccountId) {
      throw new Error("account mismatch before provider mutation");
    }
    if (this.options.error) throw this.options.error;
    this.providerMutations += 1;
    return Object.freeze({
      executionRecord: createExecutionRecordFromIntent("execution-record-1", intent),
      execution: "executed" as const,
    });
  }
}

function newService(
  source: FakeFundingIntentSource,
  accounts: FakeAccountResolver,
  runtime: FakeRuntime,
  links = new FakeFundingLegExecutionLinkStore(),
) {
  return new FundingArbitrageManualExecutionService(source, accounts, runtime, links, {
    clock: () => now,
    createIntentId: () => "execution-intent-1",
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    fundingIntentId: "funding-intent-1",
    fundingIntent: fundingIntent(),
    legId: "leg-binance",
    confirmed: true,
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    expiresAt: now + 30_000,
    ...overrides,
  };
}

function fundingIntent(
  overrides: Partial<PerpetualPerpetualFundingArbitrageExecutionIntent> = {},
): PerpetualPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "funding-intent-1",
    sourcePlanId: "plan-1",
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
    ...overrides,
  };
}

function linkKey(userId: string, fundingIntentId: string, legId: string) {
  return `${userId}\u0000${fundingIntentId}\u0000${legId}`;
}
