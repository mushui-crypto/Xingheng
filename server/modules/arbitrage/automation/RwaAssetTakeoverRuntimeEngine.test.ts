import assert from "node:assert/strict";
import test from "node:test";
import {
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
} from "./RwaAutomationAssetProfile";
import type { RwaAccountAssetAuthorization } from "./RwaAccountAssetAuthorization";
import type {
  RwaAssetTakeoverProviderSnapshot,
  RwaAssetTakeoverRecord,
} from "./RwaAssetTakeover";
import {
  createRwaAssetTakeoverRuntimeRecovery,
  createRwaAssetTakeoverRuntime,
  type RwaAssetFundingSettlement,
  type RwaAssetTakeoverRuntimeReason,
} from "./RwaAssetTakeoverRuntime";
import {
  RwaAssetTakeoverRuntimeEngine,
  rwaAssetTakeoverProviderStateDigest,
  type RwaAssetTakeoverRuntimeHooks,
} from "./RwaAssetTakeoverRuntimeEngine";
import { RwaAssetTakeoverCoordinator } from "./RwaAssetTakeoverCoordinator";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import { validateRwaAssetTakeoverRecord } from "./RwaAssetTakeover";
import type {
  RwaNeutralTradingClient,
  RwaProviderOrder,
  RwaProviderOrderRequest,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";

const profile = requireRwaAutomationExecutionProfile("xaut", "binance");
const authorization = {} as RwaAccountAssetAuthorization;

test("managed monitor keeps a strict hedge and counts only new provider funding settlements", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  const engine = new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now);
  const hooks = runtimeHooks(record);

  await engine.poll({
    client,
    authorization,
    record,
    hooks,
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(record.runtime?.phase, "monitoring");
  assert.equal(client.mutations.length, 0);

  client.settlements.push(settlement("funding-1", clock.advance(8 * 60 * 60_000), -1));
  await engine.poll({
    client,
    authorization,
    record,
    hooks,
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(record.runtime?.unfavorableFundingStreak, 1);
  assert.equal(record.runtime?.fundingSettlements.length, 1);

  await engine.poll({
    client,
    authorization,
    record,
    hooks,
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(record.runtime?.unfavorableFundingStreak, 1);
  assert.equal(record.runtime?.fundingSettlements.length, 1);
  assert.equal(client.mutations.length, 0);
});

test("two distinct adverse funding cycles exit perpetual first and spot second", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  const engine = new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now);
  const hooks = runtimeHooks(record);
  const firstAt = clock.advance(8 * 60 * 60_000);
  client.settlements.push(settlement("funding-1", firstAt, -1));
  await engine.poll({
    client,
    authorization,
    record,
    hooks,
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  const secondAt = clock.advance(8 * 60 * 60_000);
  client.settlements.push(settlement("funding-2", secondAt, -1));
  await engine.poll({
    client,
    authorization,
    record,
    hooks,
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });

  assert.equal(record.state, "exited");
  assert.equal(record.reservedCapitalUsd, 0);
  assert.equal(record.runtime?.unfavorableFundingStreak, 2);
  assert.deepEqual(client.mutations.map((item) =>
    item.type === "place" ? `${item.request.category}:${item.request.side}:${item.request.reduceOnly}` : item.type),
  ["linear:Buy:true", "spot:Sell:false"]);
});

test("external spot or short changes only reduce the larger leg", async () => {
  const clock = new Clock();
  const spotClient = new RuntimeClient(clock, 0.12, 0.1);
  const spotRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  const engine = new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now);
  await engine.poll({
    client: spotClient,
    authorization,
    record: spotRecord,
    hooks: runtimeHooks(spotRecord),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(spotClient.mutations.length, 1);
  assert.equal((spotClient.mutations[0] as PlaceMutation).request.side, "Sell");
  assert.equal((spotClient.mutations[0] as PlaceMutation).request.category, "spot");

  const shortClient = new RuntimeClient(clock, 0.1, 0.12);
  const shortRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  await engine.poll({
    client: shortClient,
    authorization,
    record: shortRecord,
    hooks: runtimeHooks(shortRecord),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(shortClient.mutations.length, 1);
  assert.equal((shortClient.mutations[0] as PlaceMutation).request.side, "Buy");
  assert.equal((shortClient.mutations[0] as PlaceMutation).request.reduceOnly, true);
});

test("unknown long position disarms without provider mutation", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  client.perpetualSide = "long";
  const record = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client,
    authorization,
    record,
    hooks: runtimeHooks(record),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }));
  assert.equal(record.state, "manual_intervention");
  assert.equal(client.mutations.length, 0);
});

test("three transient snapshot failures persist pause then manual intervention with zero writes", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  client.readFailures = 3;
  const record = managedRecord(clock, client.snapshot());
  const engine = new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now);
  const hooks = runtimeHooks(record);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(engine.poll({
      client,
      authorization,
      record,
      hooks,
      userKillSwitchActive: false,
      serverKillSwitchActive: false,
    }));
  }
  assert.equal(record.state, "manual_intervention");
  assert.equal(record.runtime?.consecutiveReadFailures, 3);
  assert.equal(client.mutations.length, 0);
});

test("first runtime recovery reduces only the larger leg and rejects equal growth above the confirmed target", async () => {
  const clock = new Clock();
  const engine = new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now);
  const reducingClient = new RuntimeClient(clock, 0.12, 0.1);
  const reducingRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  reducingRecord.runtime = createRwaAssetTakeoverRuntimeRecovery(clock.now);
  await engine.poll({
    client: reducingClient,
    authorization,
    record: reducingRecord,
    hooks: runtimeHooks(reducingRecord),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(reducingRecord.runtime?.phase, "monitoring");
  assert.deepEqual(reducingClient.placeRequests().map((item) => [item.category, item.side]), [
    ["spot", "Sell"],
  ]);

  const expandedClient = new RuntimeClient(clock, 0.12, 0.12);
  const expandedRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  expandedRecord.runtime = createRwaAssetTakeoverRuntimeRecovery(clock.now);
  await assert.rejects(engine.poll({
    client: expandedClient,
    authorization,
    record: expandedRecord,
    hooks: runtimeHooks(expandedRecord),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }));
  assert.equal(expandedRecord.state, "manual_intervention");
  assert.equal(expandedClient.mutations.length, 0);
});

test("other symbols fail closed before cancellation or placement", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  client.orders = [{
    category: "spot",
    orderId: "btc-order",
    clientOrderId: "manual-btc",
    symbol: "BTCUSDT",
  }];
  const record = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client,
    authorization,
    record,
    hooks: runtimeHooks(record),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }));
  assert.equal(record.state, "manual_intervention");
  assert.equal(client.mutations.length, 0);
});

test("a safe provider rule change uses emergency slippage tiers in server order", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  client.spotTakerFeeBps = 11;
  client.fillRatios.push(0, 0, 1, 1);
  await new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client,
    authorization,
    record,
    hooks: runtimeHooks(record),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(record.state, "exited");
  assert.deepEqual(
    client.placeRequests().filter((item) => item.category === "linear")
      .map((item) => Math.round((item.limitPrice / 1_001 - 1) * 10_000)),
    [15, 30, 50],
  );
});

test("partial perpetual fill sells only the authoritative reduced quantity", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  client.fillRatios.push(0.5, 1);
  const record = managedRecord(clock, client.snapshot());
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).exit({
    client,
    record,
    hooks: runtimeHooks(record),
    reason: "user_exit",
    emergency: false,
  }));
  const requests = client.placeRequests();
  assert.equal(requests[0]?.category, "linear");
  assert.equal(requests[0]?.quantityXaut, 0.1);
  assert.equal(requests[1]?.category, "spot");
  assert.equal(requests[1]?.quantityXaut, 0.05);
  assert.equal(record.state, "manual_intervention");
});

test("concurrent spot loss after perpetual reduction sends zero spot writes", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  client.fillRatios.push(0.5);
  client.afterFill = (request) => {
    if (request.category === "linear") client.setQuantities(0.02, 0.05);
  };
  const record = managedRecord(clock, client.snapshot());
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).exit({
    client,
    record,
    hooks: runtimeHooks(record),
    reason: "server_kill_switch",
    emergency: true,
  }));
  assert.deepEqual(client.placeRequests().map((item) => item.category), ["linear"]);
  assert.equal(record.state, "manual_intervention");
});

test("any positive perpetual residual is manual intervention, never dust", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.0000005, 0.0000005);
  const record = managedRecord(clock, client.snapshot());
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).exit({
    client,
    record,
    hooks: runtimeHooks(record),
    reason: "user_exit",
    emergency: false,
  }));
  assert.equal(record.state, "manual_intervention");
  assert.equal(record.runtime?.residualPerpetualQuantity, 0.0000005);
  assert.equal(client.mutations.length, 0);
});

test("multiple ledger rows from one provider funding cycle count once", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  const engine = new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now);
  await engine.poll({
    client,
    authorization,
    record,
    hooks: runtimeHooks(record),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  const settledAt = clock.advance(8 * 60 * 60_000);
  client.settlements.push(
    { ...settlement("row-1", settledAt, -0.5), cycleId: "cycle-one" },
    { ...settlement("row-2", settledAt, -0.5), cycleId: "cycle-one" },
  );
  await engine.poll({
    client,
    authorization,
    record,
    hooks: runtimeHooks(record),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  });
  assert.equal(record.runtime?.unfavorableFundingStreak, 1);
  assert.equal(record.runtime?.fundingSettlements.length, 1);
  assert.equal(client.mutations.length, 0);
});

test("lease loss after provider read propagates without state write or mutation", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  let leaseHeld = true;
  let persists = 0;
  client.afterRead = () => { leaseHeld = false; };
  const hooks = runtimeHooks(record, {
    assertLeaseHeld: () => {
      if (!leaseHeld) throw leaseLost();
    },
    onPersist: () => { persists += 1; },
  });
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client,
    authorization,
    record,
    hooks,
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }), isLeaseLoss);
  assert.equal(persists, 0);
  assert.equal(client.mutations.length, 0);
  assert.equal(record.state, "managed");
});

test("lease loss after cancel and order acceptance leaves restart-safe plans without later writes", async () => {
  const clock = new Clock();
  const cancelClient = new RuntimeClient(clock, 0.1, 0.1);
  cancelClient.orders = [{
    category: "spot",
    orderId: "xaut-open",
    clientOrderId: "manual-xaut",
    symbol: "XAUTUSDT",
  }];
  const cancelRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  let cancelLease = true;
  cancelClient.afterCancel = () => { cancelLease = false; };
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client: cancelClient,
    authorization,
    record: cancelRecord,
    hooks: runtimeHooks(cancelRecord, {
      assertLeaseHeld: () => {
        if (!cancelLease) throw leaseLost();
      },
    }),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }), isLeaseLoss);
  assert.equal(cancelRecord.runtime?.plannedMutation?.kind, "cancel");
  assert.deepEqual(cancelClient.mutations.map((item) => item.type), ["cancel"]);

  const placeClient = new RuntimeClient(clock, 0.12, 0.1);
  const placeRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  let placeLease = true;
  placeClient.afterPlace = () => { placeLease = false; };
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client: placeClient,
    authorization,
    record: placeRecord,
    hooks: runtimeHooks(placeRecord, {
      assertLeaseHeld: () => {
        if (!placeLease) throw leaseLost();
      },
    }),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }), isLeaseLoss);
  assert.equal(placeRecord.runtime?.plannedMutation?.kind, "place");
  assert.equal(placeRecord.runtime?.acceptedOrders.length, 0);
  assert.deepEqual(placeClient.placeRequests().map((item) => item.category), ["spot"]);

  const perpetualClient = new RuntimeClient(clock, 0.1, 0.12);
  const perpetualRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  let perpetualLease = true;
  perpetualClient.afterPlace = () => { perpetualLease = false; };
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client: perpetualClient,
    authorization,
    record: perpetualRecord,
    hooks: runtimeHooks(perpetualRecord, {
      assertLeaseHeld: () => {
        if (!perpetualLease) throw leaseLost();
      },
    }),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }), isLeaseLoss);
  assert.deepEqual(perpetualClient.placeRequests().map((item) => item.category), ["linear"]);
  assert.equal(perpetualRecord.runtime?.plannedMutation?.kind, "place");
});

test("lease loss while persisting a plan and after recovery lookup produces no provider mutation", async () => {
  const clock = new Clock();
  const persistClient = new RuntimeClient(clock, 0.12, 0.1);
  const persistRecord = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  let persistCount = 0;
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).poll({
    client: persistClient,
    authorization,
    record: persistRecord,
    hooks: runtimeHooks(persistRecord, {
      onPersist: () => {
        persistCount += 1;
        if (persistCount === 2) throw leaseLost();
      },
    }),
    userKillSwitchActive: false,
    serverKillSwitchActive: false,
  }), isLeaseLoss);
  assert.equal(persistClient.mutations.length, 0);
  assert.equal(persistRecord.runtime?.plannedMutation?.kind, "place");

  const recoveryClient = new RuntimeClient(clock, 0.1, 0.1);
  const recoveryRecord = managedRecord(clock, recoveryClient.snapshot());
  recoveryRecord.runtime!.plannedMutation = {
    kind: "place",
    category: "linear",
    orderLinkId: "runtimeorderxp1",
    quantityBase: 0.1,
    limitPrice: 1_002.51,
    reduceOnly: true,
    slippageBps: 15,
    attempt: 1,
  };
  recoveryRecord.runtime!.mutationSequence = 1;
  recoveryClient.recoveredOrder = {
    orderId: "provider-existing",
    orderLinkId: "runtimeorderxp1",
    status: "Filled",
    requestedQuantityXaut: 0.1,
    filledQuantityXaut: 0.1,
    positionQuantityXaut: 0.1,
    averagePrice: 1_002.51,
    feeUsd: 0,
    updatedAt: clock.now,
  };
  let recoveryLease = true;
  recoveryClient.afterFind = () => { recoveryLease = false; };
  await assert.rejects(new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).recover({
    client: recoveryClient,
    record: recoveryRecord,
    hooks: runtimeHooks(recoveryRecord, {
      assertLeaseHeld: () => {
        if (!recoveryLease) throw leaseLost();
      },
    }),
  }), isLeaseLoss);
  assert.equal(recoveryRecord.state, "managed");
  assert.notEqual(recoveryRecord.runtime?.plannedMutation, null);
  assert.equal(recoveryClient.mutations.length, 0);
});

test("planned accepted order recovery records the old client id and never repeats that leg", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0);
  const record = managedRecord(clock, new RuntimeClient(clock, 0.1, 0.1).snapshot());
  record.runtime!.phase = "exiting";
  record.runtime!.reason = "user_exit";
  record.runtime!.exitStartedAt = clock.now;
  record.runtime!.exitIdempotencyKey = "exit:recovery:1";
  record.runtime!.mutationSequence = 7;
  record.runtime!.plannedMutation = {
    kind: "place",
    category: "linear",
    orderLinkId: "runtimeorderxp7",
    quantityBase: 0.1,
    limitPrice: 1_002.51,
    reduceOnly: true,
    slippageBps: 15,
    attempt: 1,
  };
  client.recoveredOrder = {
    orderId: "provider-existing",
    orderLinkId: "runtimeorderxp7",
    status: "Filled",
    requestedQuantityXaut: 0.1,
    filledQuantityXaut: 0.1,
    positionQuantityXaut: 0.1,
    averagePrice: 1_002.51,
    feeUsd: 0,
    updatedAt: clock.now,
  };
  await new RwaAssetTakeoverRuntimeEngine(profile, () => clock.now).recover({
    client,
    record,
    hooks: runtimeHooks(record),
  });
  assert.equal(record.state, "exited");
  assert.ok(record.runtime?.acceptedOrders.some((item) =>
    item.orderLinkId === "runtimeorderxp7" && item.orderId === "provider-existing"));
  assert.equal(client.placeRequests().filter((item) => item.category === "linear").length, 0);
  assert.deepEqual(client.placeRequests().map((item) => item.orderLinkId), ["runtimeorderxs8"]);
});

test("public mark polling avoids early private reads and verifies liquidation risk authoritatively", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  record.runtime!.lastSuccessfulCheckAt = clock.now;
  const coordinator = runtimeCoordinator(clock, client, record);
  let privatePolls = 0;
  coordinator.pollManaged = async () => {
    privatePolls += 1;
    return true;
  };

  client.publicMark = 1_010;
  assert.equal(await coordinator.pollManagedPublicRisk(), true);
  assert.equal(client.publicMarkReads, 1);
  assert.equal(privatePolls, 0);

  client.publicMark = 1_300;
  assert.equal(await coordinator.pollManagedPublicRisk(), true);
  assert.equal(client.publicMarkReads, 2);
  assert.equal(privatePolls, 1);
});

test("public mark failures and invalid clocks fall back to a private authoritative poll", async () => {
  const clock = new Clock();
  for (const configure of [
    (client: RuntimeClient) => { client.publicReadError = new Error("public timeout"); },
    (client: RuntimeClient) => { client.publicCapturedAt = clock.now + 5_001; },
    (client: RuntimeClient) => { client.publicMark = Number.NaN; },
  ]) {
    const client = new RuntimeClient(clock, 0.1, 0.1);
    const record = managedRecord(clock, client.snapshot());
    record.runtime!.lastSuccessfulCheckAt = clock.now;
    configure(client);
    const coordinator = runtimeCoordinator(clock, client, record);
    let privatePolls = 0;
    coordinator.pollManaged = async () => {
      privatePolls += 1;
      return true;
    };
    assert.equal(await coordinator.pollManagedPublicRisk(), true);
    assert.equal(privatePolls, 1);
  }
});

test("lease loss after a public mark read propagates without a private poll", async () => {
  const clock = new Clock();
  const client = new RuntimeClient(clock, 0.1, 0.1);
  const record = managedRecord(clock, client.snapshot());
  record.runtime!.lastSuccessfulCheckAt = clock.now;
  let leaseHeld = true;
  client.afterPublicRead = () => { leaseHeld = false; };
  const coordinator = runtimeCoordinator(clock, client, record, () => {
    if (!leaseHeld) throw leaseLost();
  });
  let privatePolls = 0;
  coordinator.pollManaged = async () => {
    privatePolls += 1;
    return true;
  };

  await assert.rejects(coordinator.pollManagedPublicRisk(), isLeaseLoss);
  assert.equal(client.publicMarkReads, 1);
  assert.equal(privatePolls, 0);
  assert.equal(client.mutations.length, 0);
});

type PlaceMutation = { type: "place"; request: RwaProviderOrderRequest };

class Clock {
  now = 1_800_000_000_000;
  advance(ms: number) {
    this.now += ms;
    return this.now;
  }
}

class RuntimeClient implements RwaNeutralTradingClient<RwaVenuePermissions> {
  orders: RwaAssetTakeoverProviderSnapshot["orders"] = [];
  settlements: RwaAssetFundingSettlement[] = [];
  mutations: Array<PlaceMutation | { type: "cancel"; orderId: string }> = [];
  readFailures = 0;
  perpetualSide: "long" | "short" | "flat";
  spotTakerFeeBps = 10;
  fillRatios: number[] = [];
  afterFill: ((request: RwaProviderOrderRequest) => void) | null = null;
  afterRead: (() => void) | null = null;
  afterCancel: (() => void) | null = null;
  afterPlace: (() => void) | null = null;
  afterFind: (() => void) | null = null;
  afterPublicRead: (() => void) | null = null;
  publicMark = 1_000;
  publicCapturedAt: number | null = null;
  publicReadError: Error | null = null;
  publicMarkReads = 0;
  recoveredOrder: RwaProviderOrder | null = null;
  private orderSequence = 0;
  private requests = new Map<string, RwaProviderOrderRequest>();

  constructor(
    private readonly clock: Clock,
    private spotQuantity: number,
    private perpetualQuantity: number,
  ) {
    this.perpetualSide = perpetualQuantity > 0 ? "short" : "flat";
  }

  snapshot(): RwaAssetTakeoverProviderSnapshot {
    return {
      account: {
        accountId: "binance:runtime",
        accountFingerprint: "runtime-fingerprint",
        fetchedAt: this.clock.now,
        accountMode: "single_asset_one_way",
        permissions: {
          read: true,
          spotTrade: true,
          contractTrade: true,
          withdraw: false,
          ipRestricted: true,
        },
        availableUsdt: 1_000,
        existingSpotQuantityXaut: this.spotQuantity,
        spotAvailableQuantityXaut: this.spotQuantity,
        spotLockedQuantityXaut: 0,
        existingPerpetualQuantityXaut: this.perpetualQuantity,
        perpetualPositionSide: this.perpetualSide,
        openSpotOrderCount: this.orders.filter((item) => item.category === "spot").length,
        openPerpetualOrderCount: this.orders.filter((item) => item.category === "linear").length,
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
          liquidationDistancePercent: this.perpetualQuantity > 0 ? 50 : null,
        },
        fees: { spotTakerBps: this.spotTakerFeeBps, perpetualTakerBps: 5 },
      },
      orders: structuredClone(this.orders),
      spotAskDepth: [{ price: 1_000, quantityBase: 10 }],
      spotBidDepth: [{ price: 999, quantityBase: 10 }],
      perpetualBidDepth: [{ price: 1_000, quantityBase: 10 }],
      perpetualAskDepth: [{ price: 1_001, quantityBase: 10 }],
      fundingRates30d: [0.0001],
      perpetualInitialMarginUsd: this.perpetualQuantity * 500,
      perpetualLeverage: this.perpetualQuantity > 0 ? 2 : null,
      spotAvailableUsdt: 1_000,
      perpetualAvailableUsdt: 1_000,
    };
  }

  async validateAccess() {
    const snapshot = this.snapshot().account;
    return {
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      accountMode: snapshot.accountMode,
      permissions: snapshot.permissions,
    };
  }
  async readPreflightSnapshot() { return this.snapshot().account; }
  async readAssetTakeoverSnapshot() {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("provider timeout");
    }
    const snapshot = this.snapshot();
    this.afterRead?.();
    return snapshot;
  }
  async readManagedAssetSnapshot() {
    return this.readAssetTakeoverSnapshot();
  }
  async readManagedAssetPublicMark() {
    this.publicMarkReads += 1;
    if (this.publicReadError) throw this.publicReadError;
    const result = {
      capturedAt: this.publicCapturedAt ?? this.clock.now,
      perpetualMark: this.publicMark,
    };
    this.afterPublicRead?.();
    return result;
  }
  async readAssetFundingSettlements(input: { after: number; through: number }) {
    return this.settlements.filter((item) => item.settledAt > input.after && item.settledAt <= input.through);
  }
  async setPerpetualLeverage() {}
  async placeOrder(request: RwaProviderOrderRequest) {
    const orderId = `runtime-${++this.orderSequence}`;
    this.requests.set(orderId, request);
    this.mutations.push({ type: "place", request });
    this.afterPlace?.();
    return { orderId, orderLinkId: request.orderLinkId };
  }
  async awaitOrder(_category: "spot" | "linear", orderId: string): Promise<RwaProviderOrder> {
    const request = this.requests.get(orderId)!;
    const filledQuantity = request.quantityXaut * (this.fillRatios.shift() ?? 1);
    if (request.category === "spot") this.spotQuantity -= filledQuantity;
    else this.perpetualQuantity -= filledQuantity;
    if (this.perpetualQuantity <= 1e-12) {
      this.perpetualQuantity = 0;
      this.perpetualSide = "flat";
    }
    const result: RwaProviderOrder = {
      orderId,
      orderLinkId: request.orderLinkId,
      status: filledQuantity === request.quantityXaut
        ? "Filled"
        : filledQuantity > 0 ? "PartiallyFilled" : "Cancelled",
      requestedQuantityXaut: request.quantityXaut,
      filledQuantityXaut: filledQuantity,
      positionQuantityXaut: filledQuantity,
      averagePrice: request.limitPrice,
      feeUsd: 0,
      updatedAt: this.clock.now,
    };
    this.afterFill?.(request);
    return result;
  }
  async cancelOrder(_category: "spot" | "linear", orderId: string) {
    this.mutations.push({ type: "cancel", orderId });
    this.orders = this.orders.filter((item) => item.orderId !== orderId);
    this.afterCancel?.();
  }
  async cancelStrategyOrders() {}
  async listAssetOpenOrders() { return structuredClone(this.orders); }
  async findOrderByClientOrderId(
    _category: "spot" | "linear",
    orderLinkId: string,
  ) {
    const result = this.recoveredOrder?.orderLinkId === orderLinkId
      ? structuredClone(this.recoveredOrder)
      : null;
    this.afterFind?.();
    return result;
  }
  async readPositionAttribution(): Promise<any> {
    throw new Error("not used");
  }
  async readStrategyPnl(): Promise<any> {
    throw new Error("not used");
  }

  setQuantities(spot: number, perpetual: number) {
    this.spotQuantity = spot;
    this.perpetualQuantity = perpetual;
    this.perpetualSide = perpetual > 0 ? "short" : "flat";
  }

  placeRequests() {
    return this.mutations
      .filter((item): item is PlaceMutation => item.type === "place")
      .map((item) => item.request);
  }
}

function runtimeCoordinator(
  clock: Clock,
  client: RuntimeClient,
  record: RwaAssetTakeoverRecord,
  assertExecutionLeaseHeld: () => void = () => {},
) {
  const state = {
    assetTakeovers: [record],
    assetAuthorizations: [],
    config: {
      killSwitchActive: false,
      globalExecutionEnabled: true,
      strategyEnabled: true,
    },
  };
  return new RwaAssetTakeoverCoordinator({
    venue: "binance",
    store: {
      ownerUserId: record.userId,
      userDomain: record.userDomain,
      readState: async () => state,
      writeState: async () => {},
    } as any,
    client: async () => client,
    publicMark: () => client.readManagedAssetPublicMark(),
    credentialBinding: async () => ({
      accountId: record.accountId,
      accountFingerprint: record.accountFingerprint,
      updatedAt: clock.now,
    }),
    assertExecutionLeaseHeld,
    serverKillSwitchActive: () => false,
    now: () => clock.now,
  });
}

function managedRecord(clock: Clock, provider: RwaAssetTakeoverProviderSnapshot): RwaAssetTakeoverRecord {
  const snapshot = {
    capturedAt: provider.account.fetchedAt,
    ordersDigest: "0".repeat(64),
    providerStateDigest: rwaAssetTakeoverProviderStateDigest(provider),
    spotQuantity: provider.account.existingSpotQuantityXaut,
    spotAvailableQuantity: provider.account.spotAvailableQuantityXaut,
    spotLockedQuantity: provider.account.spotLockedQuantityXaut,
    spotBid: provider.account.spot.bid,
    perpetualQuantity: provider.account.existingPerpetualQuantityXaut,
    perpetualSide: "short" as const,
    perpetualAsk: provider.account.perpetual.ask,
    perpetualMark: provider.account.perpetual.mark,
    currentFundingRate: provider.account.perpetual.fundingRate,
    liquidationDistancePercent: provider.account.perpetual.liquidationDistancePercent,
    reserveUsd: provider.account.availableUsdt,
    managedCapitalUsd: 100,
  };
  return {
    takeoverId: "takeover-runtime-1",
    userId: "runtime-user",
    userDomain: "0123456789abcdef",
    venue: "binance",
    accountId: provider.account.accountId,
    accountFingerprint: provider.account.accountFingerprint,
    assetId: "xaut",
    profileId: rwaAutomationProfileId(profile),
    authorizationId: "authorization-runtime-1",
    authorizationCreatedAt: clock.now - 10_000,
    policyVersion: profile.asset.authorizationPolicy.version,
    policyDigest: profile.asset.authorizationPolicy.digest,
    idempotencyKey: "takeover:runtime:1",
    previewDigest: "1".repeat(64),
    newCapitalUsd: 100,
    totalManagedCapitalUsd: 500,
    reservedCapitalUsd: 500,
    leverage: 2,
    state: "managed",
    orderLinkPrefix: "runtimeorder",
    plannedMutation: null,
    acceptedOrders: [],
    cancelledOrders: [],
    spotOrders: [],
    perpetualOrders: [],
    targetHedgedQuantity: 0.1,
    finalSpotQuantity: 0.1,
    finalPerpetualQuantity: 0.1,
    residualQuantity: 0,
    runtime: createRwaAssetTakeoverRuntime(snapshot),
    errorCategory: null,
    message: "managed",
    createdAt: clock.now - 10_000,
    updatedAt: clock.now,
  };
}

function runtimeHooks(
  record: RwaAssetTakeoverRecord,
  options: {
    assertLeaseHeld?: () => void;
    onPersist?: () => void;
  } = {},
): RwaAssetTakeoverRuntimeHooks {
  return {
    assertLeaseHeld: options.assertLeaseHeld ?? (() => {}),
    async assertMutationAllowed() {},
    async persist() {
      options.onPersist?.();
      validateRwaAssetTakeoverRecord(record);
    },
    async disarm(
      _record: RwaAssetTakeoverRecord,
      reason: RwaAssetTakeoverRuntimeReason,
      message: string,
    ) {
      record.state = "manual_intervention";
      record.errorCategory = "asset_takeover_runtime_manual_intervention";
      record.message = message;
      record.runtime!.phase = "manual_intervention";
      record.runtime!.reason = reason;
      record.runtime!.message = message;
      record.runtime!.updatedAt = record.updatedAt;
      validateRwaAssetTakeoverRecord(record);
    },
  };
}

function leaseLost() {
  return new RwaAutomationExecutionLeaseError(
    "automation_execution_lease_lost",
    "simulated runtime lease loss",
  );
}

function isLeaseLoss(error: unknown) {
  return error instanceof RwaAutomationExecutionLeaseError
    && error.category === "automation_execution_lease_lost";
}

function settlement(
  settlementId: string,
  settledAt: number,
  netFundingUsd: number,
): RwaAssetFundingSettlement {
  return {
    cycleId: `binance:XAUTUSDT:${settledAt}`,
    settlementId,
    settledAt,
    netFundingUsd,
    fundingRate: null,
  };
}
