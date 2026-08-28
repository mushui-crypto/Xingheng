import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { UserExchangeCredentialSecret } from "../../credentials/UserExchangeCredentialStore";
import type { CanonicalInstrument, CexVenue } from "../CexCanonicalModels";
import type { FundingOpportunityReadVenue } from "../funding-arbitrage/CanonicalFundingOpportunitySource";
import type { ArbitrageInstance } from "./ArbitrageInstance";
import { ArbitrageInstanceQueryService } from "./ArbitrageInstanceQueryService";
import { createDefaultArbitragePositionVerificationService } from "./createDefaultArbitragePositionVerificationService";

const now = 1_800_000_000_000;
const secret: UserExchangeCredentialSecret = { apiKey: "api-key", apiSecret: "api-secret", passphrase: "passphrase" };

test("production composition routes four user-scoped credentials through venue providers and catalog quantities", async () => {
  const instances = [fixture("arb-a", "binance", "okx"), fixture("arb-b", "bybit", "bitget")];
  const loads: string[] = [];
  const clientCredentials: string[] = [];
  const query = new ArbitrageInstanceQueryService({
    get: (userId, arbitrageId) => instances.find((item) => item.userId === userId && item.arbitrageId === arbitrageId) ?? null,
    listActive: (userId) => instances.filter((item) => item.userId === userId),
    listHistory: () => [],
  });
  const service = createDefaultArbitragePositionVerificationService({
    query,
    credentials: {
      findSummary: (userId, venue) => ({
        userId,
        venue,
        accountId: credentialAccountId(venue, secret.apiKey),
        accountFingerprint: "fingerprint",
        maskedApiKey: "****",
        environment: "development",
        permissions: {},
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      loadForAccountRead: async (userId, venue) => {
        loads.push(`${userId}:${venue}`);
        return secret;
      },
    },
    readVenues: venues(),
    clients: {
      binance: (credential) => {
        clientCredentials.push(`binance:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({
            accountId: "binance:provider-account", accountFingerprint: "fingerprint", accountMode: "single_asset_one_way",
            fetchedAt: now, balances: [],
            permissions: { read: true, spotTrade: false, contractTrade: false, withdraw: false, ipRestricted: true, spotAccount: true, futuresAccount: true, positionModeSupported: true },
          }),
          readPositionMode: async () => "ONE_WAY" as const,
          readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
        };
      },
      okx: (credential) => {
        clientCredentials.push(`okx:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({ uid: "okx-uid", accountLevel: "3", permissions: null, boundIps: null, balances: [], fetchedAt: now }),
          readPositionMode: async () => "ONE_WAY" as const,
          readPerpetualPosition: async () => ({ instId: "XAUT-USDT-SWAP", side: "short", contractQuantity: "10", updatedAt: now }),
        };
      },
      bybit: (credential) => {
        clientCredentials.push(`bybit:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({ uid: "bybit-uid", unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN", readOnly: null, permissions: null, boundIps: null, balances: [], fetchedAt: now }),
          readLinearPositionMode: async (symbol) => ({
            category: "linear" as const,
            symbol,
            positionMode: "ONE_WAY" as const,
            positions: [{ category: "linear" as const, symbol, positionIdx: 0 as const, side: "long" as const, size: "1" }],
          }),
          readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
        };
      },
      bitget: (credential) => {
        clientCredentials.push(`bitget:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({ uid: "bitget-uid", accountMode: "unified", assetMode: null, accountLevel: null, holdMode: "one_way_mode", permType: null, permissions: null, boundIps: null, balances: [], fetchedAt: now }),
          readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "short", baseQuantity: "1", updatedAt: now }),
        };
      },
    },
    now: () => now,
  });

  const first = await service.verify("user-a", "arb-a");
  const second = await service.verify("user-a", "arb-b");

  assert.deepEqual(first?.legs.map((leg) => [leg.verificationStatus, leg.actualQuantity]), [["MATCHED", "1"], ["MATCHED", "1"]]);
  assert.deepEqual(second?.legs.map((leg) => [leg.verificationStatus, leg.actualQuantity]), [["MATCHED", "1"], ["MATCHED", "1"]]);
  assert.deepEqual(loads, ["user-a:binance", "user-a:okx", "user-a:bybit", "user-a:bitget"]);
  assert.deepEqual(clientCredentials, ["binance:api-key", "okx:api-key", "bybit:api-key", "bitget:api-key"]);
  assert.equal(await service.verify("user-b", "arb-a"), null);
});

test("production catalog composition returns UNKNOWN when OKX contract mapping is missing", async () => {
  const instance = fixture("arb-a", "binance", "okx");
  const query = new ArbitrageInstanceQueryService({
    get: (userId, arbitrageId) => userId === instance.userId && arbitrageId === instance.arbitrageId ? instance : null,
    listActive: () => [instance],
    listHistory: () => [],
  });
  const service = createDefaultArbitragePositionVerificationService({
    query,
    credentials: {
      findSummary: (userId, venue) => ({ userId, venue, accountId: credentialAccountId(venue, secret.apiKey), accountFingerprint: "fingerprint", maskedApiKey: "****", environment: "development", permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now }),
      loadForAccountRead: async () => secret,
    },
    readVenues: venues().map((venue) => venue.venue === "okx"
      ? { ...venue, instrumentCatalog: { venue: "okx", listInstruments: async () => [] } }
      : venue),
    clients: {
      binance: () => ({
        readAccountSnapshot: async () => ({ accountId: "provider", accountFingerprint: "fingerprint", accountMode: "unknown", fetchedAt: now, balances: [], permissions: { read: true, spotTrade: false, contractTrade: false, withdraw: false, ipRestricted: false, spotAccount: false, futuresAccount: false, positionModeSupported: false } }),
        readPositionMode: async () => "ONE_WAY" as const,
        readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
      }),
      okx: () => ({
        readAccountSnapshot: async () => ({ uid: "uid", accountLevel: "3", permissions: null, boundIps: null, balances: [], fetchedAt: now }),
        readPositionMode: async () => "ONE_WAY" as const,
        readPerpetualPosition: async () => { throw new Error("position must not be read without a catalog mapping"); },
      }),
    },
    now: () => now,
  });

  const result = await service.verify("user-a", "arb-a");
  assert.equal(result?.legs[0].verificationStatus, "MATCHED");
  assert.equal(result?.legs[1].verificationStatus, "UNKNOWN");
  assert.equal(result?.legs[1].reason, "instrument_mapping_unavailable");
});

test("OKX perpetual positions use canonical verification for open, close, quantity, and direction", async (t) => {
  const cases = [
    { name: "SHORT matched", role: "SHORT", closed: false, side: "short", contracts: "730", status: "MATCHED" },
    { name: "LONG matched", role: "LONG", closed: false, side: "long", contracts: "730", status: "MATCHED" },
    { name: "FLAT matched", role: "SHORT", closed: true, side: "flat", contracts: "0", status: "MATCHED" },
    { name: "existing same-direction insufficient net position", role: "SHORT", closed: false, side: "short", contracts: "720", status: "MISMATCH" },
    { name: "existing opposite-direction net position", role: "SHORT", closed: false, side: "long", contracts: "730", status: "MISMATCH" },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const accountId = credentialAccountId("okx", secret.apiKey);
      const base = fixture(`arb-okx-${scenario.name}`, "binance", "okx");
      const instance: ArbitrageInstance = {
        ...base,
        status: scenario.closed ? "CLOSED" : "HOLDING",
        closedAt: scenario.closed ? now : null,
        maxResidualBaseQuantity: "0",
        legs: [
          {
            ...base.legs[0],
            instrumentId: "DOGE-USDT-PERP",
            plannedQuantity: "73",
            confirmedOpenedQuantity: "73",
            confirmedClosedQuantity: scenario.closed ? "73" : "0",
          },
          {
            ...base.legs[1],
            role: scenario.role,
            accountId,
            instrumentId: "DOGE-USDT-PERP",
            plannedQuantity: "73",
            confirmedOpenedQuantity: "73",
            confirmedClosedQuantity: scenario.closed ? "73" : "0",
          },
        ],
      };
      const query = new ArbitrageInstanceQueryService({
        get: (userId, arbitrageId) => userId === instance.userId && arbitrageId === instance.arbitrageId ? instance : null,
        listActive: () => [instance],
        listHistory: () => [],
      });
      const service = createDefaultArbitragePositionVerificationService({
        query,
        credentials: {
          findSummary: (userId, venue) => ({
            userId,
            venue,
            accountId: venue === "okx" ? accountId : credentialAccountId(venue, secret.apiKey),
            accountFingerprint: "fingerprint",
            maskedApiKey: "****",
            environment: "development",
            permissions: {},
            lastVerifiedAt: now,
            createdAt: now,
            updatedAt: now,
          }),
          loadForAccountRead: async () => secret,
        },
        readVenues: venues("DOGE-USDT-PERP", "DOGE"),
        clients: {
          binance: () => ({
            readAccountSnapshot: async () => ({
              accountId: "binance:provider-account",
              accountFingerprint: "fingerprint",
              accountMode: "single_asset_one_way",
              fetchedAt: now,
              balances: [],
              permissions: { read: true, spotTrade: false, contractTrade: true, withdraw: false, ipRestricted: true, spotAccount: true, futuresAccount: true, positionModeSupported: true },
            }),
            readPositionMode: async () => "ONE_WAY" as const,
            readPerpetualPosition: async () => ({
              symbol: "DOGEUSDT",
              side: scenario.closed ? "flat" : "long",
              baseQuantity: scenario.closed ? "0" : "73",
              updatedAt: now,
            }),
          }),
          okx: () => ({
            readAccountSnapshot: async () => ({
              uid: "okx-uid",
              accountLevel: "3",
              permissions: null,
              boundIps: null,
              balances: [],
              fetchedAt: now,
            }),
            readPositionMode: async () => "ONE_WAY" as const,
            readPerpetualPosition: async () => ({
              instId: "DOGE-USDT-SWAP",
              side: scenario.side,
              contractQuantity: scenario.contracts,
              updatedAt: now,
            }),
          }),
        },
        now: () => now,
      });

      const result = await service.verify("user-a", instance.arbitrageId);

      assert.equal(result?.legs[1].verificationStatus, scenario.status);
      assert.equal(result?.legs[1].actualQuantity, scenario.contracts === "720" ? "72" : scenario.closed ? "0" : "73");
      assert.equal(result?.legs[1].reason, null);
    });
  }
});

test("OKX provider errors remain UNKNOWN after reader migration", async () => {
  const instance = fixture("arb-okx-error", "binance", "okx");
  const query = new ArbitrageInstanceQueryService({
    get: (userId, arbitrageId) => userId === instance.userId && arbitrageId === instance.arbitrageId ? instance : null,
    listActive: () => [instance],
    listHistory: () => [],
  });
  const service = createDefaultArbitragePositionVerificationService({
    query,
    credentials: {
      findSummary: (userId, venue) => ({ userId, venue, accountId: credentialAccountId(venue, secret.apiKey), accountFingerprint: "fingerprint", maskedApiKey: "****", environment: "development", permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now }),
      loadForAccountRead: async () => secret,
    },
    readVenues: venues(),
    clients: {
      binance: () => ({
        readAccountSnapshot: async () => ({ accountId: "binance:provider-account", accountFingerprint: "fingerprint", accountMode: "single_asset_one_way", fetchedAt: now, balances: [], permissions: { read: true, spotTrade: false, contractTrade: true, withdraw: false, ipRestricted: true, spotAccount: true, futuresAccount: true, positionModeSupported: true } }),
        readPositionMode: async () => "ONE_WAY" as const,
        readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
      }),
      okx: () => ({
        readAccountSnapshot: async () => ({ uid: "okx-uid", accountLevel: "3", permissions: null, boundIps: null, balances: [], fetchedAt: now }),
        readPositionMode: async () => "ONE_WAY" as const,
        readPerpetualPosition: async () => { throw new Error("provider unavailable"); },
      }),
    },
    now: () => now,
  });

  const result = await service.verify("user-a", "arb-okx-error");

  assert.equal(result?.legs[0].verificationStatus, "MATCHED");
  assert.equal(result?.legs[1].verificationStatus, "UNKNOWN");
  assert.equal(result?.legs[1].reason, "position_reality_unavailable");
});

test("Binance DOGE verification preserves SHORT 73 and closed FLAT 0 behavior", async () => {
  const accountId = credentialAccountId("binance", secret.apiKey);
  let instance: ArbitrageInstance = {
    ...fixture("arb-doge", "binance", "binance"),
    strategyType: "SPOT_PERPETUAL",
    maxResidualBaseQuantity: "0",
    legs: [
      { legId: "spot", role: "LONG", venue: "binance", accountId, instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "73", confirmedOpenedQuantity: "73", confirmedClosedQuantity: "0" },
      { legId: "perp", role: "SHORT", venue: "binance", accountId, instrumentId: "DOGE-USDT-PERP", plannedQuantity: "73", confirmedOpenedQuantity: "73", confirmedClosedQuantity: "0" },
    ],
  };
  let catalogReads = 0;
  let positionReads = 0;
  let providerSide: "short" | "flat" = "short";
  const query = new ArbitrageInstanceQueryService({
    get: (userId, arbitrageId) => userId === instance.userId && arbitrageId === instance.arbitrageId ? instance : null,
    listActive: () => [instance],
    listHistory: () => [],
  });
  const service = createDefaultArbitragePositionVerificationService({
    query,
    credentials: {
      findSummary: (userId, venue) => ({ userId, venue, accountId, accountFingerprint: "fingerprint", maskedApiKey: "****", environment: "development", permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now }),
      loadForAccountRead: async () => secret,
    },
    readVenues: [{
      venue: "binance",
      instrumentCatalog: {
        venue: "binance",
        listInstruments: async () => {
          catalogReads += 1;
          throw new Error("broad catalog must not gate an exact Binance verification read");
        },
      },
      fundingRate: { venue: "binance", getFundingRate: async () => { throw new Error("not used"); } },
      marketData: { venue: "binance", getTopOfBook: async () => { throw new Error("not used"); } },
    }],
    clients: {
      binance: () => ({
        readAccountSnapshot: async () => ({
          accountId: "binance:provider-account",
          accountFingerprint: "fingerprint",
          accountMode: "single_asset_one_way",
          fetchedAt: now,
          balances: [{ asset: "DOGE", accountType: "spot", total: providerSide === "short" ? 73.855 : 0, available: providerSide === "short" ? 73.855 : 0, locked: 0 }],
          permissions: { read: true, spotTrade: true, contractTrade: true, withdraw: false, ipRestricted: true, spotAccount: true, futuresAccount: true, positionModeSupported: true },
        }),
        readPositionMode: async () => "ONE_WAY" as const,
        readPerpetualPosition: async (symbol) => {
          positionReads += 1;
          assert.equal(symbol, "DOGEUSDT");
          return providerSide === "short"
            ? { symbol: "DOGEUSDT", side: "short", baseQuantity: "73", updatedAt: now }
            : { symbol: "DOGEUSDT", side: "flat", baseQuantity: "0", updatedAt: now };
        },
      }),
    },
    now: () => now,
  });

  const result = await service.verify("user-a", "arb-doge");

  assert.deepEqual(result?.legs.map(({ verificationStatus, actualQuantity, availableQuantity, reason }) => ({
    verificationStatus, actualQuantity, availableQuantity, reason,
  })), [
    { verificationStatus: "MATCHED", actualQuantity: "73.855", availableQuantity: "73.855", reason: null },
    { verificationStatus: "MATCHED", actualQuantity: "73", availableQuantity: null, reason: null },
  ]);

  providerSide = "flat";
  instance = {
    ...instance,
    status: "CLOSED",
    closedAt: now,
    legs: [
      { ...instance.legs[0], confirmedClosedQuantity: "73" },
      { ...instance.legs[1], confirmedClosedQuantity: "73" },
    ],
  };
  const closed = await service.verify("user-a", "arb-doge");

  assert.deepEqual(closed?.legs.map(({ verificationStatus, actualQuantity }) => ({
    verificationStatus,
    actualQuantity,
  })), [
    { verificationStatus: "MATCHED", actualQuantity: "0" },
    { verificationStatus: "MATCHED", actualQuantity: "0" },
  ]);
  assert.equal(catalogReads, 0);
  assert.equal(positionReads, 2);
});

test("Binance provider errors remain UNKNOWN after reader migration", async () => {
  const instance = fixture("arb-binance-error", "binance", "binance");
  const query = new ArbitrageInstanceQueryService({
    get: (userId, arbitrageId) => userId === instance.userId && arbitrageId === instance.arbitrageId ? instance : null,
    listActive: () => [instance],
    listHistory: () => [],
  });
  const service = createDefaultArbitragePositionVerificationService({
    query,
    credentials: {
      findSummary: (userId, venue) => ({ userId, venue, accountId: credentialAccountId(venue, secret.apiKey), accountFingerprint: "fingerprint", maskedApiKey: "****", environment: "development", permissions: {}, lastVerifiedAt: now, createdAt: now, updatedAt: now }),
      loadForAccountRead: async () => secret,
    },
    readVenues: venues(),
    clients: {
      binance: () => ({
        readAccountSnapshot: async () => ({
          accountId: "binance:provider-account",
          accountFingerprint: "fingerprint",
          accountMode: "single_asset_one_way",
          fetchedAt: now,
          balances: [],
          permissions: { read: true, spotTrade: false, contractTrade: true, withdraw: false, ipRestricted: true, spotAccount: true, futuresAccount: true, positionModeSupported: true },
        }),
        readPerpetualPosition: async () => { throw new Error("provider unavailable"); },
      }),
    },
    now: () => now,
  });

  const result = await service.verify("user-a", "arb-binance-error");

  assert.deepEqual(result?.legs.map(({ verificationStatus, reason }) => ({ verificationStatus, reason })), [
    { verificationStatus: "UNKNOWN", reason: "provider_read_failed" },
    { verificationStatus: "UNKNOWN", reason: "provider_read_failed" },
  ]);
});

function fixture(arbitrageId: string, longVenue: CexVenue, shortVenue: CexVenue): ArbitrageInstance {
  return {
    arbitrageId,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: null,
    maxResidualBaseQuantity: "0.001",
    status: "HOLDING",
    createdAt: now - 10,
    openedAt: now - 9,
    updatedAt: now - 1,
    closedAt: null,
    legs: [
      { legId: "long", role: "LONG", venue: longVenue, accountId: credentialAccountId(longVenue, secret.apiKey), instrumentId: "XAUT-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "1", confirmedClosedQuantity: "0" },
      { legId: "short", role: "SHORT", venue: shortVenue, accountId: credentialAccountId(shortVenue, secret.apiKey), instrumentId: "XAUT-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "1", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function venues(
  instrumentId = "XAUT-USDT-PERP",
  baseAsset = "XAUT",
): FundingOpportunityReadVenue[] {
  return (["binance", "okx", "bybit", "bitget"] as const).map((venue) => ({
    venue,
    instrumentCatalog: { venue, listInstruments: async () => [instrument(venue, instrumentId, baseAsset)] },
    fundingRate: { venue, getFundingRate: async () => { throw new Error("not used"); } },
    marketData: { venue, getTopOfBook: async () => { throw new Error("not used"); } },
  }));
}

function instrument(
  venue: CexVenue,
  instrumentId = "XAUT-USDT-PERP",
  baseAsset = "XAUT",
): CanonicalInstrument {
  return {
    instrumentId,
    venue,
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset,
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: venue === "okx" ? `${baseAsset}-USDT-SWAP` : `${baseAsset}USDT`,
    providerLocator: {},
    quantityUnit: venue === "okx" ? "contract" : "base",
    contractSize: venue === "okx" ? 0.1 : 1,
    priceTick: 0.1,
    quantityStep: 0.001,
    minQuantity: 0.001,
    minNotional: null,
    status: "trading",
    fetchedAt: now,
  };
}

function credentialAccountId(venue: CexVenue, apiKey: string) {
  if (venue === "bitget") {
    return `bitget:${createHash("sha256").update("bitget:bitget-uid").digest("hex").slice(0, 16)}`;
  }
  const prefix = `${venue}:credential-only:`;
  const digest = createHash("sha256").update(`${prefix}${apiKey}`).digest("hex");
  return `${prefix}${digest.slice(0, 20)}`;
}
