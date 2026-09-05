import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArbitrageFundingStore } from "./ArbitrageFundingStore";
import { ArbitrageInstanceStore } from "./ArbitrageInstanceStore";
import type { ArbitrageFundingFact } from "./FundingAccounting";

test("funding facts are provider-id idempotent while attribution may converge", () => {
  withStore((store) => {
    const first = store.recordFact(fact({ attributionStatus: "AMBIGUOUS", arbitrageId: null }));
    assert.equal(first.attributionStatus, "AMBIGUOUS");
    const converged = store.recordFact(fact({ attributionStatus: "ATTRIBUTED", arbitrageId: "arb" }));
    assert.equal(converged.attributionStatus, "ATTRIBUTED");
    assert.equal(converged.createdAt, 100);
    store.recordFact(fact({ attributionStatus: "ATTRIBUTED", arbitrageId: "arb", createdAt: 300 }));
    assert.deepEqual(store.listFacts("bybit", "account", "DOGE-USDT-PERP"), [
      { ...fact({ attributionStatus: "ATTRIBUTED", arbitrageId: "arb" }), createdAt: 100 },
    ]);
  });
});

test("same provider id enriches missing raw position evidence without creating another row", () => {
  withStore((store) => {
    store.recordFact(fact({
      positionSideOrBucket: null, providerPositionSize: null,
      amountUsdt: null, arbitrageId: null, attributionStatus: "INCOMPLETE",
    }));
    const enriched = store.recordFact(fact({ createdAt: 200 }));
    assert.equal(enriched.positionSideOrBucket, "SHORT");
    assert.equal(enriched.providerPositionSize, "-68");
    assert.equal(enriched.attributionStatus, "ATTRIBUTED");
    assert.equal(enriched.createdAt, 100);
    assert.equal(store.listFacts("bybit", "account", "DOGE-USDT-PERP").length, 1);
  });
});

test("weaker replay cannot clear known Provider evidence or downgrade attribution", () => {
  withStore((store) => {
    store.recordFact(fact({}));
    const replay = store.recordFact(fact({
      positionSideOrBucket: null, providerPositionSize: null,
      amountUsdt: null, arbitrageId: null, attributionStatus: "INCOMPLETE",
    }));
    assert.equal(replay.positionSideOrBucket, "SHORT");
    assert.equal(replay.providerPositionSize, "-68");
    assert.equal(replay.amountUsdt, "0.001");
    assert.equal(replay.arbitrageId, "arb");
    assert.equal(replay.attributionStatus, "ATTRIBUTED");
  });
});

test("conflicting provider fact is quarantined and cannot advance as attributed", () => {
  withStore((store) => {
    store.recordFact(fact({ attributionStatus: "ATTRIBUTED", arbitrageId: "arb" }));
    const conflicted = store.recordFact({
      ...fact({ attributionStatus: "ATTRIBUTED", arbitrageId: "arb" }), amount: "0.002", amountUsdt: "0.002",
    });
    assert.equal(conflicted.amount, "0.002");
    assert.equal(conflicted.amountUsdt, null);
    assert.equal(conflicted.attributionStatus, "INCOMPLETE");
    assert.equal(conflicted.integrityStatus, "CONFLICT");
    const replay = store.recordFact({ ...fact({}), amount: "0.002", amountUsdt: "0.002", createdAt: 300 });
    assert.equal(replay.integrityStatus, "CONFLICT");
    assert.equal(replay.arbitrageId, null);
    assert.equal(store.listFacts("bybit", "account", "DOGE-USDT-PERP").length, 1);
  });
});

test("coverage persists only contiguous complete windows", () => {
  withStore((store) => {
    store.recordCoverage({
      venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
      coveredFrom: 100, coveredThrough: 200, lastSuccessfulReadAt: 210, paginationComplete: true,
    });
    const combined = store.recordCoverage({
      venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
      coveredFrom: 190, coveredThrough: 300, lastSuccessfulReadAt: 310, paginationComplete: true,
    });
    assert.deepEqual(combined, {
      venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
      coveredFrom: 100, coveredThrough: 300, lastSuccessfulReadAt: 310, paginationComplete: true,
    });
    assert.throws(() => store.recordCoverage({
      venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
      coveredFrom: 400, coveredThrough: 500, lastSuccessfulReadAt: 510, paginationComplete: true,
    }), /unproven gap/u);
  });
});

function fact(overrides: Partial<ArbitrageFundingFact>): ArbitrageFundingFact {
  return {
    providerFundingId: "funding-1", venue: "bybit", accountId: "account",
    instrumentId: "DOGE-USDT-PERP", positionSideOrBucket: "SHORT", providerPositionSize: "-68", settlementTime: 80,
    amount: "0.001", asset: "USDT", amountUsdt: "0.001", arbitrageId: "arb",
    attributionStatus: "ATTRIBUTED", integrityStatus: "VERIFIED", createdAt: 100, ...overrides,
  };
}

function withStore(run: (store: ArbitrageFundingStore) => void) {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-funding-store-"));
  const dbPath = join(root, "test.sqlite");
  const instances = new ArbitrageInstanceStore({ dbPath });
  instances.create({
    arbitrageId: "arb", userId: "user", strategyType: "SPOT_PERPETUAL",
    maxResidualBaseQuantity: "0", createdAt: 1,
    legs: [
      { legId: "spot", role: "LONG", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "68" },
      { legId: "perp", role: "SHORT", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "68" },
    ],
  });
  const store = new ArbitrageFundingStore({ dbPath });
  try { run(store); } finally { store.close(); instances.close(); rmSync(root, { recursive: true, force: true }); }
}
