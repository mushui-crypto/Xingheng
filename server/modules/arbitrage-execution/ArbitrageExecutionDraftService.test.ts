import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ArbitrageDashboardSnapshot, ArbitrageOpportunity } from "../arbitrage/arbitrageTypes";
import { createAsset } from "../cex/Asset";
import type { ExecutionQuantityPlanningInstrument } from "../cex/ExecutionQuantityPlanner";
import { createTradingRules } from "../cex/TradingRules";
import type { ArbitrageExecutionDraftVenue } from "./ArbitrageExecutionDraft";
import { ArbitrageExecutionDraftService } from "./ArbitrageExecutionDraftService";
import type { ArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";
import type { FormalExecutionRuntime } from "./FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistry,
  formalExecutionRuntime,
} from "./FormalExecutionRuntimeRegistry";

const now = Date.now();

test("builds an authoritative two-leg NOTIONAL_USDT preview without trusting provider fields", async () => {
  const contexts = new FakeContexts();
  const service = draftService(opportunity("binance", "binance"), contexts);

  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
  });

  assert.equal(result.strategyType, "SPOT_PERPETUAL");
  assert.equal(result.legs[0].planning.status, "PLANNED");
  assert.equal(result.legs[1].planning.status, "PLANNED");
  assert.equal(result.legs[0].executionAvailable, true);
  assert.equal(result.legs[1].executionAvailable, true);
  assert.equal(result.allLegsExecutable, true);
  assert.deepEqual(contexts.calls, [
    { venue: "binance", instrumentId: "BTC-USDT-SPOT" },
    { venue: "binance", instrumentId: "BTC-USDT-PERP" },
  ]);
});

test("plans ASSET_QUANTITY and exposes OKX when its formal runtime and credential are eligible", async () => {
  const service = draftService(opportunity("binance", "okx"), new FakeContexts());

  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 365,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });

  assert.equal(result.legs[0].planning.status, "PLANNED");
  assert.equal(result.legs[1].planning.status, "PLANNED");
  assert.equal(result.legs[1].capability.reasonCode, "AVAILABLE");
  assert.equal(result.legs[1].executionAvailable, true);
  assert.equal(result.allLegsExecutable, true);
});

test("exposes an enabled Bybit Draft without a credential-global position mode field", async () => {
  const service = draftService(opportunity("binance", "bybit"), new FakeContexts(), {
    registeredVenues: ["binance", "bybit"],
    bybitCredential: "enabled",
  });
  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });
  assert.equal(result.legs[1].capability.reasonCode, "AVAILABLE");
  assert.equal(result.legs[1].executionAvailable, true);
  assert.equal(result.allLegsExecutable, true);
});

test("exposes an enabled Bitget Draft only when formal runtime and persisted one-way readiness are present", async () => {
  const service = draftService(opportunity("bitget", "bitget"), new FakeContexts(), {
    registeredVenues: ["bitget"],
    bitgetCredential: "enabled",
  });
  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });
  assert.equal(result.legs[0].planning.status, "PLANNED");
  assert.equal(result.legs[1].planning.status, "PLANNED");
  assert.equal(result.legs.every((leg) => leg.capability.reasonCode === "AVAILABLE"), true);
  assert.equal(result.allLegsExecutable, true);
});

test("keeps Bybit Draft credential readiness fail-closed", async (t) => {
  for (const [name, overrides] of [
    ["disabled", { bybitCredential: "disabled" as const }],
    ["missing contract permission", { bybitCredential: "enabled" as const, bybitPermissionOverrides: { contractTrade: false } }],
    ["withdraw permission", { bybitCredential: "enabled" as const, bybitPermissionOverrides: { withdraw: true } }],
  ] as const) {
    await t.test(name, async () => {
      const result = await draftService(opportunity("binance", "bybit"), new FakeContexts(), {
        registeredVenues: ["binance", "bybit"],
        ...overrides,
      }).preview("user-a", {
        opportunityId: "opportunity-1",
        horizonDays: 90,
        quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
      });
      assert.equal(result.legs[1].capability.reasonCode, "CREDENTIAL_NOT_CONFIGURED");
      assert.equal(result.legs[1].executionAvailable, false);
      assert.equal(result.allLegsExecutable, false);
    });
  }
});

test("keeps unregistered Bybit and Bitget capabilities unavailable without hiding their read-only plan", async () => {
  for (const venue of ["bybit", "bitget"] as const) {
    const result = await draftService(opportunity("binance", venue), new FakeContexts()).preview("user-a", {
      opportunityId: "opportunity-1",
      horizonDays: 90,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
    });
    assert.equal(result.legs[1].planning.status, "PLANNED");
    assert.equal(result.legs[1].capability.reasonCode, "EXECUTION_CAPABILITY_NOT_IMPLEMENTED");
    assert.equal(result.legs[1].executionAvailable, false);
  }
});

test("rejects an OKX Draft when the credential is not enabled", async () => {
  const service = draftService(opportunity("binance", "okx"), new FakeContexts(), {
    okxCredential: "disabled",
  });
  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });

  assert.equal(result.legs[0].executionAvailable, true);
  assert.equal(result.legs[1].capability.reasonCode, "CREDENTIAL_NOT_CONFIGURED");
  assert.equal(result.legs[1].executionAvailable, false);
  assert.equal(result.allLegsExecutable, false);
});

test("rejects an OKX Draft when persisted Provider conditions are not valid", async (t) => {
  for (const [name, permissions] of [
    ["provider identity", { providerVerified: false }],
    ["contract permission", { contractTrade: false }],
    ["position mode", { positionModeSupported: false }],
  ] as const) {
    await t.test(name, async () => {
      const service = draftService(opportunity("binance", "okx"), new FakeContexts(), {
        okxCredential: "enabled",
        okxPermissionOverrides: permissions,
      });
      const result = await service.preview("user-a", {
        opportunityId: "opportunity-1",
        horizonDays: 90,
        quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
      });
      assert.equal(result.legs[1].executionAvailable, false);
      assert.equal(result.allLegsExecutable, false);
    });
  }
});

test("rejects an OKX Draft when the formal runtime is not registered", async () => {
  const service = draftService(opportunity("binance", "okx"), new FakeContexts(), {
    registeredVenues: ["binance"],
  });
  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });

  assert.equal(result.legs[1].capability.reasonCode, "EXECUTION_CAPABILITY_NOT_IMPLEMENTED");
  assert.equal(result.legs[1].executionAvailable, false);
  assert.equal(result.allLegsExecutable, false);
});

test("isolates Binance and OKX Draft credential states", async () => {
  const okxDisabled = await draftService(opportunity("binance", "okx"), new FakeContexts(), {
    okxCredential: "disabled",
  }).preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });
  assert.equal(okxDisabled.legs[0].executionAvailable, true);
  assert.equal(okxDisabled.legs[1].executionAvailable, false);

  const binanceMissing = await draftService(opportunity("binance", "okx"), new FakeContexts(), {
    binanceCredential: false,
  }).preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });
  assert.equal(binanceMissing.legs[0].executionAvailable, false);
  assert.equal(binanceMissing.legs[1].executionAvailable, true);
});

test("same-account opposite perpetual legs are not advertised as jointly executable", async () => {
  const value = opportunity("binance", "binance");
  const perpetualPair = {
    ...value,
    longLeg: { ...value.longLeg, kind: "perpetual" as const, id: "binance-btc-perpetual" },
  };
  const result = await draftService(perpetualPair, new FakeContexts()).preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "2" },
  });
  assert.equal(result.legs.every((leg) => leg.executionAvailable), true);
  assert.equal(result.allLegsExecutable, false);
});

test("returns structured Planner minimum errors and never raises the user budget", async () => {
  const service = draftService(opportunity("binance", "binance"), new FakeContexts({ minNotional: "25" }));

  const result = await service.preview("user-a", {
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
  });

  for (const leg of result.legs) {
    assert.equal(leg.planning.status, "ERROR");
    if (leg.planning.status === "ERROR") {
      assert.equal(leg.planning.errorCode, "NOTIONAL_BELOW_MINIMUM");
      assert.equal(leg.planning.minimumRequiredNotionalUsdt, "25");
    }
    assert.equal(leg.executionAvailable, false);
  }
});

test("fails closed when a client supplies providerSymbol or a complete Funding Intent", async () => {
  const service = draftService(opportunity("binance", "binance"), new FakeContexts());
  await assert.rejects(
    () => service.preview("user-a", {
      opportunityId: "opportunity-1",
      horizonDays: 90,
      quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
      providerSymbol: "BTCUSDT",
    }),
    /不允许的字段：providerSymbol/u,
  );
  await assert.rejects(
    () => service.preview("user-a", {
      opportunityId: "opportunity-1",
      horizonDays: 90,
      quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
      fundingIntent: { intentId: "client-controlled" },
    }),
    /不允许的字段：fundingIntent/u,
  );
});

test("draft boundary contains no instance, intent, record, or provider mutation dependency", () => {
  const source = readFileSync(new URL("./ArbitrageExecutionDraftService.ts", import.meta.url), "utf8");
  const contextSource = readFileSync(new URL("./ArbitrageExecutionPlanningContext.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ArbitrageInstance|ExecutionIntent|ExecutionRecord|placeOrder|cancelOrder|ExecutionCoordinator/u);
  assert.doesNotMatch(contextSource, /placeOrder|cancelOrder|transfer|withdraw|method:\s*["']POST/u);
});

class FakeContexts implements ArbitrageExecutionPlanningContextSource {
  readonly calls: Array<{ venue: ArbitrageExecutionDraftVenue; instrumentId: string }> = [];

  constructor(private readonly rules: { minNotional?: string } = { minNotional: "5" }) {}

  async load(venue: ArbitrageExecutionDraftVenue, instrumentId: string) {
    this.calls.push({ venue, instrumentId });
    const perpetual = instrumentId.endsWith("-PERP");
    const instrument: ExecutionQuantityPlanningInstrument = Object.freeze({
      instrumentId,
      providerSymbol: venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
      baseAsset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }),
      quoteAsset: "USDT",
      ...(perpetual ? { settlementAsset: "USDT" } : {}),
      marketType: perpetual ? "perpetual" : "spot",
      contractType: perpetual ? "linear_perpetual" : "spot",
      quantityUnit: "base",
      status: "trading",
    });
    return Object.freeze({
      instrument,
      tradingRules: createTradingRules({
        quantityStep: "0.1",
        minQuantity: "0.1",
        priceTick: "0.01",
        ...(this.rules.minNotional ? { minNotional: this.rules.minNotional } : {}),
        precision: {},
      }),
      quote: Object.freeze({ bid: "10", ask: "10", fetchedAt: now }),
    });
  }
}

function draftService(
  value: ArbitrageOpportunity,
  contexts: ArbitrageExecutionPlanningContextSource,
  options: Readonly<{
    registeredVenues?: readonly ArbitrageExecutionDraftVenue[];
    binanceCredential?: boolean;
    okxCredential?: "enabled" | "disabled" | "missing";
    okxPermissionOverrides?: Readonly<Record<string, boolean>>;
    bybitCredential?: "enabled" | "disabled" | "missing";
    bybitPermissionOverrides?: Readonly<Record<string, boolean>>;
    bitgetCredential?: "enabled" | "disabled" | "missing";
    bitgetPermissionOverrides?: Readonly<Record<string, boolean>>;
  }> = {},
) {
  const runtimes = new FormalExecutionRuntimeRegistry();
  for (const venue of options.registeredVenues ?? ["binance", "okx"]) {
    runtimes.register(formalExecutionRuntime(venue, unusedRuntime));
  }
  return new ArbitrageExecutionDraftService(
    { getSnapshot: async (horizonDays: 90 | 365) => snapshot(horizonDays, value) },
    contexts,
    {
      findSummary: (userId: string, venue: string) => {
        if (userId !== "user-a") return null;
        if (venue === "binance") {
          return options.binanceCredential === false ? null : ({ accountId: "binance:account-a", permissions: {} } as any);
        }
        if (venue === "bybit") {
          if (options.bybitCredential === "missing") return null;
          const executionEnabled = options.bybitCredential !== "disabled";
          return {
            accountId: "bybit:account-a",
            permissions: {
              executionEnabled,
              providerVerified: true,
              read: true,
              contractTrade: true,
              withdraw: false,
              ipRestricted: true,
              accountLevelSupported: true,
              ...options.bybitPermissionOverrides,
            },
          } as any;
        }
        if (venue === "bitget") {
          if (options.bitgetCredential === "missing") return null;
          const executionEnabled = options.bitgetCredential !== "disabled";
          return {
            accountId: "bitget:0123456789abcdef",
            permissions: {
              executionEnabled,
              providerVerified: true,
              read: true,
              contractTrade: true,
              withdraw: false,
              ipRestricted: true,
              accountLevelSupported: true,
              positionModeSupported: true,
              ...options.bitgetPermissionOverrides,
            },
          } as any;
        }
        if (venue !== "okx" || options.okxCredential === "missing") return null;
        const executionEnabled = options.okxCredential !== "disabled";
        return {
          accountId: "okx:0123456789abcdef",
          permissions: {
            executionEnabled,
            providerVerified: true,
            read: true,
            contractTrade: true,
            withdraw: false,
            ipRestricted: true,
            accountLevelSupported: true,
            positionModeSupported: true,
            ...options.okxPermissionOverrides,
          },
        } as any;
      },
    },
    runtimes,
    () => now,
  );
}

const unusedRuntime: FormalExecutionRuntime = Object.freeze({
  execute: async () => { throw new Error("Draft capability resolution must not execute a Provider mutation."); },
  reconcile: async () => { throw new Error("Draft capability resolution must not query a Provider."); },
  cancel: async () => { throw new Error("Draft capability resolution must not execute a Provider mutation."); },
});

function snapshot(horizonDays: 90 | 365, value: ArbitrageOpportunity): ArbitrageDashboardSnapshot {
  return {
    horizonDays,
    generatedAt: now - 1_000,
    markets: [],
    opportunities: [value],
    summary: {
      bestScore: 80,
      bestNetApr: 5,
      eligibleOpportunityCount: 1,
      connectedVenueCount: 2,
      totalVenueCount: 5,
      trackedMarketCount: 2,
      usdcUsdtPrice: null,
      stablecoinBasisBps: null,
    },
    warnings: [],
  };
}

function opportunity(longVenue: ArbitrageExecutionDraftVenue, shortVenue: ArbitrageExecutionDraftVenue): ArbitrageOpportunity {
  const leg = (venue: ArbitrageExecutionDraftVenue, kind: "spot" | "perpetual") => ({
    id: `${venue}-btc-${kind}`,
    venue,
    venueLabel: venue,
    symbol: venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
    asset: "BTC" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 10,
    ask: 10,
    fundingRate: kind === "perpetual" ? 0.0001 : null,
    fundingIntervalHours: kind === "perpetual" ? 8 : null,
    currentFundingApr: kind === "perpetual" ? 10 : 0,
    historicalFundingApr: kind === "perpetual" ? 8 : 0,
    nextFundingTime: kind === "perpetual" ? now + 3_600_000 : null,
  });
  return {
    id: "opportunity-1",
    longLeg: leg(longVenue, "spot"),
    shortLeg: leg(shortVenue, "perpetual"),
    strategyType: longVenue === shortVenue ? "same_venue_neutral" : "cross_venue_arbitrage",
    strategyLabel: "套利",
    matchQuality: "exact",
    matchLabel: "精确匹配",
    currentGrossApr: 10,
    historicalGrossApr: 8,
    netApr: 5,
    persistenceRatio: 0.8,
    annualizedTradingCostApr: 2,
    roundTripCostBps: 10,
    entryBasisBps: 0,
    capacityUsd: 100_000,
    score: 80,
    historicalQualityScore: 75,
    confidence: "high",
    confidenceLabel: "高",
    opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率",
    recommendation: "watch",
    entryStatus: "favorable",
    scoreBreakdown: { conservativeNetReturn: 1, driverStrength: 1, persistence: 1, costEfficiency: 1, liquidity: 1, confidence: 1 },
    disqualifiers: [],
    warnings: [],
    automationEligible: false,
    automationDisqualifiers: [],
  };
}
