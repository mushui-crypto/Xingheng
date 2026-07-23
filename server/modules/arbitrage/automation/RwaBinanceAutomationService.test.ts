import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import { RwaBinanceAutomationConnector } from "./RwaBinanceAutomationConnector";
import { RwaBinanceAutomationService } from "./RwaBinanceAutomationService";
import type {
  RwaBinanceClient,
  RwaBinanceCredentials,
  RwaBinancePermissions,
  RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";

const masterKey = "11".repeat(32);
const now = 20_000;

test("Binance credentials remain user-isolated, default disabled, and reject withdrawal permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-automation-"));
  try {
    const client = new FakeBinanceClient();
    const first = service(directory, "user-a", client);
    const second = service(directory, "user-b", client);
    const connector = new RwaBinanceAutomationConnector(first);

    await first.putCredentials({ apiKey: "fake-key-a", apiSecret: "fake-secret-a" });
    const firstStatus = await connector.getStatus();
    const secondStatus = await second.getCredentialStatus();
    assert.equal(firstStatus.implemented, true);
    assert.equal(firstStatus.enabled, false);
    assert.equal(firstStatus.phase, "phase_1_read_only_shadow");
    assert.equal(firstStatus.providerWritesEnabled, false);
    assert.equal((firstStatus.productAvailability as any).available, true);
    assert.equal(firstStatus.credential.lifecycleStatus, "active");
    assert.equal(firstStatus.credential.maskedApiKey?.includes("fake-secret-a"), false);
    assert.equal(secondStatus.lifecycleStatus, "unconfigured");

    const rejectedClient = new FakeBinanceClient({ permissions: permissions({ withdraw: true }) });
    const rejected = service(directory, "user-c", rejectedClient);
    await assert.rejects(
      rejected.putCredentials({ apiKey: "fake-key-c", apiSecret: "must-not-leak" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "permission_rejected"
        && !error.message.includes("must-not-leak"),
    );
    assert.equal((await rejected.getCredentialStatus()).stored, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance Shadow preflight checks precision and freshness but never enables provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-preflight-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await current.getCredentialStatus()).accountId;
    assert.ok(accountId);

    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => {
        assert.ok(error instanceof RwaNeutralExecutionError);
        assert.equal(error.category, "binance_provider_writes_disabled");
        assert.equal((error.details?.report as any).marketChecksPassed, true);
        assert.equal((error.details?.report as any).providerWritesEnabled, false);
        return true;
      },
    );
    assert.equal(client.readCount > 0, true);
    assert.equal(client.writeCount, 0);
    assert.throws(() => current.execute(), (error: unknown) =>
      error instanceof RwaNeutralExecutionError && error.category === "binance_provider_writes_disabled");
    assert.throws(() => current.closeAll(), (error: unknown) =>
      error instanceof RwaNeutralExecutionError && error.category === "binance_provider_writes_disabled");
    assert.equal(client.writeCount, 0);

    client.snapshot.fetchedAt = 1;
    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any).checks.some((item: any) => item.name === "freshness" && !item.passed),
    );

    client.snapshot.fetchedAt = now;
    client.snapshot.perpetual.minOrderQty = 0.01;
    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any).checks.some((item: any) => item.name === "perpetual_minimum" && !item.passed),
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function service(directory: string, userId: string, client: FakeBinanceClient) {
  const store = new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
    userId,
    venue: "binance",
    masterKey,
    credentialPath: join(directory, `${userId}-credentials.json`),
    statePath: join(directory, `${userId}-state.json`),
  });
  return new RwaBinanceAutomationService(store, () => client, () => now, () => true);
}

class FakeBinanceClient implements RwaBinanceClient {
  readCount = 0;
  writeCount = 0;
  readonly access;
  snapshot: RwaBinancePreflightSnapshot;

  constructor(input: { permissions?: RwaBinancePermissions } = {}) {
    const currentPermissions = input.permissions ?? permissions();
    this.access = {
      accountId: "binance:test-account",
      accountFingerprint: "test-account",
      accountMode: "single_asset_one_way" as const,
      permissions: currentPermissions,
    };
    this.snapshot = {
      ...this.access,
      fetchedAt: now,
      productAvailability: {
        available: true,
        status: "available",
        spotSymbol: "XAUTUSDT",
        perpetualSymbol: "XAUTUSDT",
        checkedAt: now,
        message: null,
      },
      spotAvailableUsdt: 20,
      futuresAvailableUsdt: 20,
      existingSpotQuantityXaut: 0,
      existingPerpetualQuantityXaut: 0,
      openSpotOrderCount: 0,
      openPerpetualOrderCount: 0,
      spot: {
        status: "Trading",
        minOrderQty: 0.0001,
        qtyStep: 0.0001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 4_129,
        ask: 4_130,
        depthUsd: 100_000,
      },
      perpetual: {
        status: "Trading",
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 4_128,
        ask: 4_129,
        depthUsd: 100_000,
        mark: 4_128.5,
        fundingRate: 0.0002,
        fundingIntervalHours: 4,
        nextFundingTime: now + 3_600_000,
        liquidationDistancePercent: null,
      },
      fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
    };
  }

  async validateAccess() {
    this.readCount += 1;
    return this.access;
  }

  async readPreflightSnapshot() {
    this.readCount += 1;
    return structuredClone(this.snapshot);
  }

  async readProductAvailability() {
    this.readCount += 1;
    return this.snapshot.productAvailability;
  }
}

function permissions(overrides: Partial<RwaBinancePermissions> = {}): RwaBinancePermissions {
  return {
    read: true,
    spotTrade: true,
    contractTrade: true,
    withdraw: false,
    ipRestricted: false,
    spotAccount: true,
    futuresAccount: true,
    positionModeSupported: true,
    ...overrides,
  };
}

function opportunity(): ArbitrageOpportunity {
  const leg = (kind: "spot" | "perpetual") => ({
    id: `binance-xaut-${kind}`,
    venue: "binance" as const,
    venueLabel: "Binance",
    symbol: "XAUTUSDT",
    asset: "XAUT" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 4_128,
    ask: 4_130,
    fundingRate: kind === "perpetual" ? 0.0002 : null,
    fundingIntervalHours: kind === "perpetual" ? 4 : null,
    currentFundingApr: kind === "perpetual" ? 43 : 0,
    historicalFundingApr: kind === "perpetual" ? 12 : 0,
    nextFundingTime: null,
  });
  return {
    id: "binance-xaut-spot--binance-xaut-perp",
    longLeg: leg("spot"),
    shortLeg: leg("perpetual"),
    strategyType: "same_venue_neutral",
    strategyLabel: "同所中性",
    matchQuality: "exact",
    matchLabel: "同一资产",
    currentGrossApr: 10,
    historicalGrossApr: 10,
    netApr: 9,
    persistenceRatio: 0.8,
    annualizedTradingCostApr: 1,
    roundTripCostBps: 20,
    entryBasisBps: -4.8,
    capacityUsd: 1_000,
    score: 80,
    historicalQualityScore: 80,
    confidence: "high",
    confidenceLabel: "高",
    opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率驱动",
    recommendation: "recommended",
    entryStatus: "favorable",
    scoreBreakdown: {
      conservativeNetReturn: 20,
      driverStrength: 20,
      persistence: 20,
      costEfficiency: 5,
      liquidity: 10,
      confidence: 5,
    },
    disqualifiers: [],
    warnings: [],
    automationEligible: true,
    automationDisqualifiers: [],
  };
}
