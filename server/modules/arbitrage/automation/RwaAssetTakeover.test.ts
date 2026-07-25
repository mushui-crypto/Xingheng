import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAccountAssetAuthorization,
  createAccountAssetAuthorizationPreview,
} from "./RwaAccountAssetAuthorization";
import { requireRwaAutomationExecutionProfile } from "./RwaAutomationAssetProfile";
import {
  createRwaAssetTakeoverPreview,
  createRwaAssetTakeoverRecord,
  RwaAssetTakeoverError,
  validateRwaTakeoverFundingWindow,
  type RwaAssetTakeoverProviderSnapshot,
  type RwaAssetTakeoverRecord,
} from "./RwaAssetTakeover";
import { RwaAssetTakeoverExecutionEngine } from "./RwaAssetTakeoverExecutionEngine";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import type {
  RwaNeutralTradingClient,
  RwaPositionAttributionSnapshot,
  RwaProviderOrder,
  RwaStrategyPnlSnapshot,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";

const now = 1_800_000_000_000;
const profile = requireRwaAutomationExecutionProfile("xaut", "binance");

test("takeover calculator counts a paired existing XAUT exposure once and adds new capital", () => {
  const fixture = takeoverFixture({ spot: 0.4, perpetual: 0.4 });
  const preview = createRwaAssetTakeoverPreview({
    profile,
    authorization: fixture.authorization,
    provider: fixture.provider,
    newCapitalUsd: 1_000,
    selectedLeverage: 2,
    now,
  });
  assert.equal(preview.existingManagedCapitalUsd, 400);
  assert.equal(preview.totalManagedCapitalUsd, 1_400);
  assert.equal(preview.recommendedLeverage, 2);
  assert.equal(preview.missingSpotQuantity, 0);
  assert.equal(preview.missingPerpetualQuantity, 0);
});

test("takeover calculator rejects perpetual long, insufficient liquidation distance, and over 2000U", () => {
  for (const provider of [
    takeoverFixture({ spot: 0.1, perpetual: 0.1, side: "long" }).provider,
    takeoverFixture({ spot: 0.1, perpetual: 0.1, liquidationDistancePercent: 20 }).provider,
    takeoverFixture({ spot: 1.1, perpetual: 1.1 }).provider,
  ]) {
    const authorization = authorizationFor(provider);
    assert.throws(
      () => createRwaAssetTakeoverPreview({
        profile,
        authorization,
        provider,
        newCapitalUsd: 1_000,
        selectedLeverage: 2,
        now,
      }),
      (error) => error instanceof RwaAssetTakeoverError
        && error.category === "asset_takeover_risk_rejected",
    );
  }
});

test("30-day funding input rejects gaps and accepts a complete ordered window", () => {
  const interval = 8 * 60 * 60_000;
  const start = now - 30 * 24 * 60 * 60_000;
  const complete = Array.from({ length: 91 }, (_, index) => ({
    time: start + index * interval,
    rate: index / 1_000_000,
  }));
  assert.equal(
    validateRwaTakeoverFundingWindow(
      complete,
      start,
      now,
      interval,
      (item) => item.time,
      (item) => item.rate,
    ).length,
    91,
  );
  const withGap = complete.filter((_, index) => index !== 40 && index !== 41);
  assert.throws(() => validateRwaTakeoverFundingWindow(
    withGap,
    start,
    now,
    interval,
    (item) => item.time,
    (item) => item.rate,
  ));
});

test("strictly hedged takeover persists managed state with zero provider mutation", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0.1 });
  const client = new FakeTakeoverClient(fixture.provider);
  const { preview, record } = takeoverRecord(fixture, 500);
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview,
    record,
    hooks: hooks(),
  });
  assert.equal(result.status, "managed");
  assert.equal(record.state, "managed");
  assert.equal(client.mutations.length, 0);
});

test("takeover adds only the missing perpetual short through IOC and confirms authoritative balance", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const client = new FakeTakeoverClient(fixture.provider);
  const { preview, record } = takeoverRecord(fixture, 500);
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview,
    record,
    hooks: hooks(),
  });
  assert.equal(result.status, "managed");
  assert.deepEqual(client.mutations.map((item) => item.kind), ["leverage", "place"]);
  assert.equal(client.mutations[1]?.category, "linear");
  assert.equal(client.mutations[1]?.side, "Sell");
  assert.equal(record.finalPerpetualQuantity, 0.1);
});

test("post-cancel quantity change returns an opaque reconfirmation boundary before place", async () => {
  const fixture = takeoverFixture({
    spot: 0.2,
    perpetual: 0.1,
    orders: [{ category: "spot", orderId: "manual-1", clientOrderId: "manual", symbol: "XAUTUSDT" }],
  });
  const client = new FakeTakeoverClient(fixture.provider);
  client.afterCancel = { spot: 0.15, perpetual: 0.05 };
  const { preview, record } = takeoverRecord(fixture, 500);
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview,
    record,
    hooks: hooks(),
  });
  assert.equal(result.status, "reconfirm_required");
  assert.equal(record.state, "awaiting_reconfirm");
  assert.deepEqual(client.mutations.map((item) => item.kind), ["cancel"]);
});

test("lease loss before a planned provider write produces zero provider mutation", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const client = new FakeTakeoverClient(fixture.provider);
  const { preview, record } = takeoverRecord(fixture, 500);
  let checks = 0;
  await assert.rejects(
    new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
      client,
      authorization: fixture.authorization,
      preview,
      record,
      hooks: hooks(() => {
        checks += 1;
        if (checks === 2) throw new Error("lease lost");
      }),
    }),
  );
  assert.equal(client.mutations.length, 0);
  assert.equal(record.state, "manual_intervention");
});

test("execution lease loss is rethrown without disarm or record mutation", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const client = new FakeTakeoverClient(fixture.provider);
  const { preview, record } = takeoverRecord(fixture, 500);
  let disarmed = 0;
  await assert.rejects(
    new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
      client,
      authorization: fixture.authorization,
      preview,
      record,
      hooks: {
        ...hooks(),
        persist: async () => {
          throw new RwaAutomationExecutionLeaseError(
            "automation_execution_lease_lost",
            "simulated lease loss",
          );
        },
        disarm: async () => { disarmed += 1; },
      },
    }),
    (error) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_lease_lost",
  );
  assert.equal(disarmed, 0);
  assert.equal(record.state, "cancelling_orders");
  assert.equal(client.mutations.length, 0);
});

test("partial IOC fills retry twice without resetting leverage and then become strictly hedged", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const client = new FakeTakeoverClient(fixture.provider);
  client.fillFractions = [0.5, 1];
  const { preview, record } = takeoverRecord(fixture, 500);
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview,
    record,
    hooks: hooks(),
  });
  assert.equal(result.status, "managed");
  assert.deepEqual(client.mutations.map((item) => item.kind), ["leverage", "place", "place"]);
  assert.equal(record.perpetualOrders.length, 2);
  assert.equal(record.finalPerpetualQuantity, 0.1);
  assert.equal(record.residualQuantity, 0);
});

test("missing exposure is split by authoritative executable depth across bounded IOC attempts", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  fixture.provider.perpetualBidDepth = [
    { price: 1_000, quantityBase: 0.04 },
    { price: 999.5, quantityBase: 0.06 },
  ];
  const client = new FakeTakeoverClient(fixture.provider);
  const { preview, record } = takeoverRecord(fixture, 500);
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview,
    record,
    hooks: hooks(),
  });
  assert.equal(result.status, "managed");
  assert.deepEqual(
    client.mutations
      .filter((item) => item.kind === "place")
      .map((item) => item.quantityXaut),
    [0.04, 0.04, 0.02],
  );
});

test("three exhausted IOC attempts preserve partial fills and disarm for manual intervention", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const client = new FakeTakeoverClient(fixture.provider);
  client.fillFractions = [0.25, 0.25, 0.25];
  const { preview, record } = takeoverRecord(fixture, 500);
  let disarmed = 0;
  await assert.rejects(
    new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
      client,
      authorization: fixture.authorization,
      preview,
      record,
      hooks: {
        ...hooks(),
        disarm: async () => { disarmed += 1; },
      },
    }),
    (error) => error instanceof RwaAssetTakeoverError
      && error.category === "asset_takeover_manual_intervention",
  );
  assert.equal(client.mutations.filter((item) => item.kind === "place").length, 3);
  assert.equal(client.mutations.filter((item) => item.kind === "leverage").length, 1);
  assert.ok(fixture.provider.account.existingPerpetualQuantityXaut > 0);
  assert.ok(fixture.provider.account.existingPerpetualQuantityXaut < 0.1);
  assert.equal(disarmed, 1);
  assert.equal(record.state, "manual_intervention");
});

test("an untradeable step residual is recorded as dust without sending the other leg", async () => {
  const fixture = takeoverFixture({ spot: 0.1005, perpetual: 0.1 });
  const client = new FakeTakeoverClient(fixture.provider);
  const { preview, record } = takeoverRecord(fixture, 500);
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview,
    record,
    hooks: hooks(),
  });
  assert.equal(result.status, "managed");
  assert.ok(Math.abs(record.residualQuantity - 0.0005) < 1e-12);
  assert.match(record.message, /residual\/dust/);
  assert.equal(client.mutations.length, 0);
});

test("restart recovery adopts an accepted provider order by client id without duplicate place", async () => {
  const fixture = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const record: RwaAssetTakeoverRecord = takeoverRecord(fixture, 500).record;
  record.state = "opening_perpetual";
  record.plannedMutation = {
    kind: "place",
    category: "linear",
    orderLinkId: "takeoverp1",
    quantityBase: 0.1,
    attempt: 1,
  };
  const recoveredOrder: RwaProviderOrder = {
    orderId: "provider-order-1",
    orderLinkId: "takeoverp1",
    status: "Filled",
    requestedQuantityXaut: 0.1,
    filledQuantityXaut: 0.1,
    positionQuantityXaut: 0.1,
    averagePrice: 1_000,
    feeUsd: 0.1,
    updatedAt: now,
  };
  fixture.provider.account.existingPerpetualQuantityXaut = 0.1;
  fixture.provider.account.perpetualPositionSide = "short";
  fixture.provider.account.perpetual.liquidationDistancePercent = 50;
  fixture.provider.perpetualInitialMarginUsd = 50;
  fixture.provider.perpetualLeverage = 2;
  const client = new FakeTakeoverClient(fixture.provider);
  client.recoveredOrders.set("takeoverp1", recoveredOrder);
  const recoveryPreview = createRwaAssetTakeoverPreview({
    profile,
    authorization: fixture.authorization,
    provider: fixture.provider,
    newCapitalUsd: 500,
    selectedLeverage: 2,
    now,
  });
  const result = await new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client,
    authorization: fixture.authorization,
    preview: recoveryPreview,
    record,
    hooks: hooks(),
    reconfirmed: true,
  });
  assert.equal(result.status, "managed");
  assert.equal(client.mutations.filter((item) => item.kind === "place").length, 0);
  assert.deepEqual(record.acceptedOrders, [{
    category: "linear",
    orderId: "provider-order-1",
    orderLinkId: "takeoverp1",
  }]);
  assert.equal(record.perpetualOrders.length, 1);
  assert.equal(record.plannedMutation, null);
});

test("lease loss after cancellation or leverage prevents every later provider write", async () => {
  const withOrder = takeoverFixture({
    spot: 0.1,
    perpetual: 0,
    orders: [{ category: "spot", orderId: "manual-1", clientOrderId: "manual", symbol: "XAUTUSDT" }],
  });
  const cancelClient = new FakeTakeoverClient(withOrder.provider);
  const cancelRecord = takeoverRecord(withOrder, 500);
  let cancelChecks = 0;
  await assert.rejects(new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client: cancelClient,
    authorization: withOrder.authorization,
    preview: cancelRecord.preview,
    record: cancelRecord.record,
    hooks: hooks(() => {
      cancelChecks += 1;
      if (cancelChecks === 3) throw new Error("lease lost after cancel");
    }),
  }));
  assert.deepEqual(cancelClient.mutations.map((item) => item.kind), ["cancel"]);

  const missingPerpetual = takeoverFixture({ spot: 0.1, perpetual: 0 });
  const leverageClient = new FakeTakeoverClient(missingPerpetual.provider);
  const leverageRecord = takeoverRecord(missingPerpetual, 500);
  let leverageChecks = 0;
  await assert.rejects(new RwaAssetTakeoverExecutionEngine(profile, () => now).execute({
    client: leverageClient,
    authorization: missingPerpetual.authorization,
    preview: leverageRecord.preview,
    record: leverageRecord.record,
    hooks: hooks(() => {
      leverageChecks += 1;
      if (leverageChecks === 3) throw new Error("lease lost after leverage");
    }),
  }));
  assert.deepEqual(leverageClient.mutations.map((item) => item.kind), ["leverage"]);
});

test("persistent takeover state is exact, authorization-linked, capacity bounded, and duplicate-safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-asset-takeover-state-"));
  try {
    const store = new RwaAutomationPersistentStore({
      userId: "user-a",
      venue: "binance",
      keyProvider: new FakeCredentialKeyProvider(),
      credentialPath: join(directory, "credentials.json"),
      statePath: join(directory, "state.json"),
    });
    const fixture = takeoverFixture({ spot: 0.1, perpetual: 0.1 });
    const preview = createRwaAssetTakeoverPreview({
      profile,
      authorization: fixture.authorization,
      provider: fixture.provider,
      newCapitalUsd: 500,
      selectedLeverage: 2,
      now,
    });
    const authorization = {
      ...fixture.authorization,
      userDomain: store.userDomain,
    };
    const record = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: store.userDomain,
      accountId: fixture.provider.account.accountId,
      preview,
      idempotencyKey: "takeover:persistence:0001",
      orderLinkPrefix: "takeover-persistence",
      now,
    });
    const state = await store.readState();
    state.assetAuthorizations.push(authorization);
    state.assetTakeovers.push(record);
    await store.writeState(state);
    const restored = await store.readState();
    assert.equal(restored.assetTakeovers[0]?.takeoverId, record.takeoverId);

    restored.assetTakeovers.push({ ...record, takeoverId: "duplicate-id" });
    await assert.rejects(store.writeState(restored));
    restored.assetTakeovers.pop();
    restored.assetTakeovers.push({
      ...record,
      takeoverId: "second-active-id",
      idempotencyKey: "takeover:persistence:0002",
      orderLinkPrefix: "takeover-persistence-second",
    });
    await assert.rejects(store.writeState(restored));
    restored.assetTakeovers.pop();
    restored.assetAuthorizations = [];
    await assert.rejects(store.writeState(restored));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function takeoverFixture(input: {
  spot: number;
  perpetual: number;
  side?: "long" | "short" | "flat";
  liquidationDistancePercent?: number | null;
  orders?: RwaAssetTakeoverProviderSnapshot["orders"];
}) {
  const side = input.side ?? (input.perpetual > 0 ? "short" : "flat");
  const provider: RwaAssetTakeoverProviderSnapshot = {
    account: {
      accountId: "binance:account",
      accountFingerprint: "fingerprint",
      fetchedAt: now,
      accountMode: "single_asset_one_way",
      permissions: {
        read: true,
        spotTrade: true,
        contractTrade: true,
        withdraw: false,
        ipRestricted: true,
      },
      availableUsdt: 3_000,
      existingSpotQuantityXaut: input.spot,
      spotAvailableQuantityXaut: input.spot,
      spotLockedQuantityXaut: 0,
      existingPerpetualQuantityXaut: input.perpetual,
      perpetualPositionSide: side,
      openSpotOrderCount: input.orders?.filter((item) => item.category === "spot").length ?? 0,
      openPerpetualOrderCount: input.orders?.filter((item) => item.category === "linear").length ?? 0,
      spot: {
        status: "Trading",
        minOrderQty: 0.0001,
        qtyStep: 0.0001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 999,
        ask: 1_000,
      },
      perpetual: {
        status: "Trading",
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 1_000,
        ask: 1_001,
        mark: 1_000,
        fundingRate: 0.0001,
        fundingIntervalHours: 8,
        liquidationDistancePercent: input.perpetual > 0
          ? input.liquidationDistancePercent ?? 50
          : null,
      },
      fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
    },
    orders: input.orders ?? [],
    spotAskDepth: [{ price: 1_000, quantityBase: 10 }],
    perpetualBidDepth: [{ price: 1_000, quantityBase: 10 }],
    fundingRates30d: [0.00008, 0.0001, 0.00012],
    perpetualInitialMarginUsd: input.perpetual * 500,
    perpetualLeverage: input.perpetual > 0 ? 2 : null,
    spotAvailableUsdt: 2_000,
    perpetualAvailableUsdt: 2_000,
  };
  return { provider, authorization: authorizationFor(provider) };
}

function authorizationFor(provider: RwaAssetTakeoverProviderSnapshot) {
  const preview = createAccountAssetAuthorizationPreview({
    profile,
    snapshot: provider.account,
    orders: provider.orders,
    now: now - 1_000,
  });
  return createAccountAssetAuthorization({
    userDomain: "0123456789abcdef",
    venue: "binance",
    accountId: provider.account.accountId,
    accountFingerprint: provider.account.accountFingerprint,
    assetId: "xaut",
    preview,
    now: now - 500,
  });
}

function takeoverRecord(
  fixture: ReturnType<typeof takeoverFixture>,
  newCapitalUsd: number,
) {
  const preview = createRwaAssetTakeoverPreview({
    profile,
    authorization: fixture.authorization,
    provider: fixture.provider,
    newCapitalUsd,
    selectedLeverage: 2,
    now,
  });
  return {
    preview,
    record: createRwaAssetTakeoverRecord({
      userId: "user",
      userDomain: "0123456789abcdef",
      accountId: fixture.provider.account.accountId,
      preview,
      idempotencyKey: "takeover-key",
      orderLinkPrefix: "takeover",
      now,
    }),
  };
}

function hooks(assertMutationAllowed: () => void = () => {}) {
  return {
    assertMutationAllowed,
    persist: async () => {},
    disarm: async () => {},
  };
}

class FakeTakeoverClient implements RwaNeutralTradingClient<RwaVenuePermissions> {
  readonly mutations: Array<Record<string, unknown>> = [];
  readonly recoveredOrders = new Map<string, RwaProviderOrder>();
  afterCancel: { spot: number; perpetual: number } | null = null;
  fillFractions: number[] = [];
  private orderSequence = 0;
  private readonly orderRequests = new Map<string, Parameters<RwaNeutralTradingClient["placeOrder"]>[0]>();

  constructor(private readonly provider: RwaAssetTakeoverProviderSnapshot) {}

  async validateAccess() {
    return {
      permissions: this.provider.account.permissions,
      accountId: this.provider.account.accountId,
      accountFingerprint: this.provider.account.accountFingerprint,
      accountMode: this.provider.account.accountMode,
    };
  }

  async readPreflightSnapshot() {
    return structuredClone(this.provider.account);
  }

  async readAssetTakeoverSnapshot() {
    return structuredClone(this.provider);
  }

  async setPerpetualLeverage(leverage: 1 | 2 | 3) {
    this.mutations.push({ kind: "leverage", leverage });
  }

  async placeOrder(request: Parameters<RwaNeutralTradingClient["placeOrder"]>[0]) {
    this.mutations.push({
      kind: "place",
      category: request.category,
      side: request.side,
      orderLinkId: request.orderLinkId,
      quantityXaut: request.quantityXaut,
    });
    this.orderSequence += 1;
    const orderId = `order-${this.orderSequence}`;
    this.orderRequests.set(orderId, request);
    return { orderId, orderLinkId: request.orderLinkId };
  }

  async awaitOrder(category: "spot" | "linear", orderId: string): Promise<RwaProviderOrder> {
    const request = this.orderRequests.get(orderId);
    if (!request) throw new Error("missing fake order request");
    const requestedQuantity = request.quantityXaut;
    const fillFraction = this.fillFractions.length ? this.fillFractions.shift()! : 1;
    const quantity = requestedQuantity * fillFraction;
    if (category === "spot") {
      this.provider.account.existingSpotQuantityXaut += quantity;
      this.provider.account.spotAvailableQuantityXaut += quantity;
    } else {
      this.provider.account.existingPerpetualQuantityXaut += quantity;
      this.provider.account.perpetualPositionSide = "short";
      this.provider.account.perpetual.liquidationDistancePercent = 50;
      this.provider.perpetualInitialMarginUsd += quantity * 500;
      this.provider.perpetualLeverage = 2;
    }
    return {
      orderId,
      orderLinkId: request.orderLinkId,
      status: fillFraction >= 1 ? "Filled" : "Cancelled",
      requestedQuantityXaut: requestedQuantity,
      filledQuantityXaut: quantity,
      positionQuantityXaut: quantity,
      averagePrice: 1_000,
      feeUsd: 0.1,
      updatedAt: now,
    };
  }

  async cancelOrder(category: "spot" | "linear", orderId: string) {
    this.mutations.push({ kind: "cancel", category, orderId });
    this.provider.orders = this.provider.orders.filter((item) => item.orderId !== orderId);
    if (this.afterCancel) {
      this.provider.account.existingSpotQuantityXaut = this.afterCancel.spot;
      this.provider.account.spotAvailableQuantityXaut = this.afterCancel.spot;
      this.provider.account.existingPerpetualQuantityXaut = this.afterCancel.perpetual;
      this.provider.account.perpetualPositionSide = this.afterCancel.perpetual > 0 ? "short" : "flat";
    }
  }

  async cancelStrategyOrders() {}
  async listAssetOpenOrders() { return structuredClone(this.provider.orders); }
  async findOrderByClientOrderId(_category: "spot" | "linear", orderLinkId: string) {
    return this.recoveredOrders.get(orderLinkId) ?? null;
  }
  async readPositionAttribution(): Promise<RwaPositionAttributionSnapshot> { throw new Error("not used"); }
  async readStrategyPnl(): Promise<RwaStrategyPnlSnapshot> { throw new Error("not used"); }
}
