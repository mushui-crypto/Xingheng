import assert from "node:assert/strict";
import test from "node:test";
import type { UserExchangeCredentialSecret } from "../../credentials/UserExchangeCredentialStore";
import type { ArbitrageInstance } from "./ArbitrageInstance";
import { ArbitragePositionVerificationService } from "./ArbitragePositionVerificationService";
import type { ArbitrageLegReadProviderFactory } from "./ArbitragePositionVerification";

const now = 1_800_000_000_000;

test("verifies known perpetual legs as MATCHED without mutating the arbitrage instance", async () => {
  const instance = fixture();
  const before = structuredClone(instance);
  const service = serviceFor([instance], {
    long: { actualQuantity: "1.0005", direction: "LONG", observedAt: now - 1 },
    short: { actualQuantity: "1", direction: "SHORT", observedAt: now - 1 },
  });

  const result = await service.verify("user-a", "arb-1");

  assert.deepEqual(result?.legs.map((leg) => leg.verificationStatus), ["MATCHED", "MATCHED"]);
  assert.deepEqual(result?.legs.map((leg) => leg.expectedManagedQuantity), ["1", "1"]);
  assert.deepEqual(instance, before);
});

test("reports MISMATCH for quantity or direction changes without changing lifecycle or quantities", async () => {
  const instance = fixture();
  const service = serviceFor([instance], {
    long: { actualQuantity: "1.01", direction: "LONG", observedAt: now },
    short: { actualQuantity: "1", direction: "LONG", observedAt: now },
  });

  const result = await service.verify("user-a", "arb-1");

  assert.deepEqual(result?.legs.map((leg) => leg.verificationStatus), ["MISMATCH", "MISMATCH"]);
  assert.equal(instance.status, "HOLDING");
  assert.deepEqual(instance.legs.map((leg) => leg.confirmedOpenedQuantity), ["1", "1"]);
});

test("uses spot balance observations and keeps provider failures UNKNOWN", async () => {
  const spot = fixture({ strategyType: "SPOT_PERPETUAL", longInstrumentId: "XAUT-USDT-SPOT" });
  const service = serviceFor([spot], {
    long: { actualQuantity: "1", availableQuantity: "0.9", direction: "LONG", observedAt: now },
    short: new Error("provider failed"),
  });

  const result = await service.verify("user-a", "arb-1");

  assert.equal(result?.legs[0].verificationStatus, "MATCHED");
  assert.equal(result?.legs[0].availableQuantity, "0.9");
  assert.equal(result?.legs[1].verificationStatus, "UNKNOWN");
  assert.equal(result?.legs[1].actualQuantity, null);
});

test("keeps missing, cross-user, credential mismatch, and overlapping aggregate positions invisible or UNKNOWN", async () => {
  const target = fixture();
  const overlap = fixture({ arbitrageId: "arb-2" });
  const service = serviceFor([target, overlap], {
    long: { actualQuantity: "2", direction: "LONG", observedAt: now },
    short: { actualQuantity: "2", direction: "SHORT", observedAt: now },
  });

  assert.equal(await service.verify("user-b", "arb-1"), null);
  assert.equal(await service.verify("user-a", "missing"), null);
  const result = await service.verify("user-a", "arb-1");
  assert.deepEqual(result?.legs.map((leg) => leg.verificationStatus), ["UNKNOWN", "UNKNOWN"]);
});

test("loads user-scoped credentials and disposes a short-lived provider on success and failure", async () => {
  const instance = fixture();
  const events: string[] = [];
  const service = new ArbitragePositionVerificationService(
    query([instance]),
    {
      findSummary: (userId, venue) => ({
        userId, venue, accountId: `${venue}:account-a`, accountFingerprint: "fingerprint",
        maskedApiKey: "****", environment: "development", permissions: {}, lastVerifiedAt: now,
        createdAt: now, updatedAt: now,
      }),
      loadForAccountRead: async (userId, venue) => {
        events.push(`load:${userId}:${venue}`);
        return secret();
      },
    },
    [factory("binance", events, false), factory("okx", events, true)],
    () => now,
  );

  const result = await service.verify("user-a", "arb-1");

  assert.deepEqual(result?.legs.map((leg) => leg.verificationStatus), ["MATCHED", "UNKNOWN"]);
  assert.deepEqual(events, [
    "load:user-a:binance", "load:user-a:okx",
    "read:binance:long", "read:okx:short",
    "dispose:binance", "dispose:okx",
  ]);
});

test("rejects a replaced credential when an instance is bound to a credential-only account id", async () => {
  const base = fixture();
  const instance: ArbitrageInstance = {
    ...base,
    legs: [base.legs[0], {
      ...base.legs[1],
      accountId: "okx:credential-only:00000000000000000000",
    }],
  };
  let providers = 0;
  const service = new ArbitragePositionVerificationService(
    query([instance]),
    {
      findSummary: (userId, venue) => ({
        userId, venue, accountId: instance.legs.find((leg) => leg.venue === venue)!.accountId,
        accountFingerprint: "fingerprint", maskedApiKey: "****", environment: "development",
        permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now,
      }),
      loadForAccountRead: async () => secret(),
    },
    [{
      venue: "okx",
      create: () => {
        providers += 1;
        throw new Error("must not create provider");
      },
    }],
    () => now,
  );

  const result = await service.verify("user-a", "arb-1");
  assert.equal(result?.legs[1].verificationStatus, "UNKNOWN");
  assert.equal(providers, 0);
});

function serviceFor(
  instances: ArbitrageInstance[],
  observations: Record<string, { actualQuantity: string; availableQuantity?: string | null; direction: "LONG" | "SHORT" | "FLAT"; observedAt: number | null } | Error>,
) {
  const factories = ["binance", "okx"] as const;
  return new ArbitragePositionVerificationService(
    query(instances),
    {
      findSummary: (userId, venue) => {
        const instance = instances.find((candidate) => candidate.userId === userId);
        const leg = instance?.legs.find((candidate) => candidate.venue === venue);
        return leg ? {
          userId, venue, accountId: leg.accountId, accountFingerprint: "fingerprint", maskedApiKey: "****",
          environment: "development", permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now,
        } : null;
      },
      loadForAccountRead: async () => secret(),
    },
    factories.map((venue) => ({
      venue,
      create: () => ({
        venue,
        readLeg: async (leg) => {
          const observation = observations[leg.legId];
          if (observation instanceof Error) throw observation;
          if (!observation) throw new Error("missing observation");
          return observation;
        },
        dispose: () => undefined,
      }),
    })),
    () => now,
  );
}

function query(instances: ArbitrageInstance[]) {
  return {
    getById: (userId: string, arbitrageId: string) => instances.find((candidate) => (
      candidate.userId === userId && candidate.arbitrageId === arbitrageId
    )) ?? null,
    listActive: (userId: string) => instances.filter((candidate) => candidate.userId === userId),
  };
}

function factory(
  venue: "binance" | "okx",
  events: string[],
  fail: boolean,
): ArbitrageLegReadProviderFactory {
  return {
    venue,
    create: () => ({
      venue,
      readLeg: async (leg) => {
        events.push(`read:${venue}:${leg.legId}`);
        if (fail) throw new Error("failed");
        return { actualQuantity: "1", direction: leg.role, observedAt: now };
      },
      dispose: () => { events.push(`dispose:${venue}`); },
    }),
  };
}

function secret(): UserExchangeCredentialSecret {
  return { apiKey: "key", apiSecret: "secret", passphrase: "passphrase" };
}

function fixture(overrides: {
  arbitrageId?: string;
  strategyType?: ArbitrageInstance["strategyType"];
  longInstrumentId?: string;
} = {}): ArbitrageInstance {
  return {
    arbitrageId: overrides.arbitrageId ?? "arb-1",
    userId: "user-a",
    strategyType: overrides.strategyType ?? "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.001",
    status: "HOLDING",
    createdAt: now - 100,
    openedAt: now - 90,
    updatedAt: now - 10,
    closedAt: null,
    legs: [
      {
        legId: "long", role: "LONG", venue: "binance", accountId: "binance:account-a",
        instrumentId: overrides.longInstrumentId ?? "XAUT-USDT-PERP", plannedQuantity: "1",
        confirmedOpenedQuantity: "1", confirmedClosedQuantity: "0",
      },
      {
        legId: "short", role: "SHORT", venue: "okx", accountId: "okx:account-a",
        instrumentId: "XAUT-USDT-PERP", plannedQuantity: "1",
        confirmedOpenedQuantity: "1", confirmedClosedQuantity: "0",
      },
    ],
    executionReferences: [],
    pnl: {
      asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null,
      feesCosts: null, cumulativeNetPnl: null, updatedAt: null,
    },
  };
}
