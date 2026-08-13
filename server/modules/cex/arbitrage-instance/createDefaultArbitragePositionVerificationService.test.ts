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
          readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
        };
      },
      okx: (credential) => {
        clientCredentials.push(`okx:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({ uid: "okx-uid", accountLevel: "3", permissions: null, boundIps: null, balances: [], fetchedAt: now }),
          readPerpetualPosition: async () => ({ instId: "XAUT-USDT-SWAP", side: "short", contractQuantity: "10", updatedAt: now }),
        };
      },
      bybit: (credential) => {
        clientCredentials.push(`bybit:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({ uid: "bybit-uid", unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN", readOnly: null, permissions: null, boundIps: null, balances: [], fetchedAt: now }),
          readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
        };
      },
      bitget: (credential) => {
        clientCredentials.push(`bitget:${credential.apiKey}`);
        return {
          readAccountSnapshot: async () => ({ uid: "bitget-uid", accountMode: "unified", assetMode: null, accountLevel: null, permType: null, permissions: null, boundIps: null, balances: [], fetchedAt: now }),
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
        readPerpetualPosition: async () => ({ symbol: "XAUTUSDT", side: "long", baseQuantity: "1", updatedAt: now }),
      }),
      okx: () => ({
        readAccountSnapshot: async () => ({ uid: "uid", accountLevel: "3", permissions: null, boundIps: null, balances: [], fetchedAt: now }),
        readPerpetualPosition: async () => { throw new Error("position must not be read without a catalog mapping"); },
      }),
    },
    now: () => now,
  });

  const result = await service.verify("user-a", "arb-a");
  assert.equal(result?.legs[0].verificationStatus, "MATCHED");
  assert.equal(result?.legs[1].verificationStatus, "UNKNOWN");
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

function venues(): FundingOpportunityReadVenue[] {
  return (["binance", "okx", "bybit", "bitget"] as const).map((venue) => ({
    venue,
    instrumentCatalog: { venue, listInstruments: async () => [instrument(venue)] },
    fundingRate: { venue, getFundingRate: async () => { throw new Error("not used"); } },
    marketData: { venue, getTopOfBook: async () => { throw new Error("not used"); } },
  }));
}

function instrument(venue: CexVenue): CanonicalInstrument {
  return {
    instrumentId: "XAUT-USDT-PERP",
    venue,
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: venue === "okx" ? "XAUT-USDT-SWAP" : "XAUTUSDT",
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
  const prefix = `${venue}:credential-only:`;
  const digest = createHash("sha256").update(`${prefix}${apiKey}`).digest("hex");
  return `${prefix}${digest.slice(0, 20)}`;
}
