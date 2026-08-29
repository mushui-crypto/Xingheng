import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ArbitrageExecutionCloseError, ArbitrageExecutionCloseService } from "../../arbitrage-execution/ArbitrageExecutionCloseService";
import { formalExecutionRuntime, FormalExecutionRuntimeRegistry } from "../../arbitrage-execution/FormalExecutionRuntimeRegistry";
import type { BitgetAccountReadSnapshot, BitgetPerpetualPositionSnapshot } from "../../bitget/BitgetAccountReadClient";
import type { UserExchangeCredentialSecret } from "../../credentials/UserExchangeCredentialStore";
import { createAsset } from "../Asset";
import type { CanonicalInstrument } from "../CexCanonicalModels";
import type { ExecutionIntent } from "../ExecutionIntent";
import type { FundingOpportunityReadVenue } from "../funding-arbitrage/CanonicalFundingOpportunitySource";
import { createTradingRules } from "../TradingRules";
import type { ArbitrageInstance } from "./ArbitrageInstance";
import { ArbitrageInstanceQueryService } from "./ArbitrageInstanceQueryService";
import { createDefaultArbitragePositionVerificationService } from "./createDefaultArbitragePositionVerificationService";

const now = 1_900_000_000_000;
const userId = "user-a";
const uid = "bitget-uid";
const accountId = `bitget:${createHash("sha256").update(`bitget:${uid}`).digest("hex").slice(0, 16)}`;
const secret: UserExchangeCredentialSecret = {
  apiKey: "api-key",
  apiSecret: "api-secret",
  passphrase: "passphrase",
};

test("production Bitget verification maps authoritative hedge_mode and scopes LONG/SHORT facts to each leg", async () => {
  const reads: Array<"long" | "short" | undefined> = [];
  const service = verificationService({
    holdMode: "hedge_mode",
    longQuantity: "7",
    shortQuantity: "99",
    reads,
  });

  const result = await service.verify(userId, "arb-bitget");

  assert.deepEqual(result?.legs.map((leg) => ({
    legId: leg.legId,
    status: leg.verificationStatus,
    positionMode: leg.positionMode,
    actualQuantity: leg.actualQuantity,
    actualLongQuantity: leg.actualLongQuantity,
    actualShortQuantity: leg.actualShortQuantity,
    actualSignedNetQuantity: leg.actualSignedNetQuantity,
  })), [
    {
      legId: "long",
      status: "MATCHED",
      positionMode: "HEDGE",
      actualQuantity: "7",
      actualLongQuantity: "7",
      actualShortQuantity: "99",
      actualSignedNetQuantity: null,
    },
    {
      legId: "short",
      status: "MATCHED",
      positionMode: "HEDGE",
      actualQuantity: "99",
      actualLongQuantity: "7",
      actualShortQuantity: "99",
      actualSignedNetQuantity: null,
    },
  ]);
  assert.deepEqual(reads, ["long", "short", "long", "short"]);
});

test("production Bitget verification preserves authoritative one_way_mode signed-net behavior", async () => {
  const reads: Array<"long" | "short" | undefined> = [];
  const service = verificationService({
    holdMode: "one_way_mode",
    longQuantity: "7",
    shortQuantity: "7",
    reads,
  });

  const result = await service.verify(userId, "arb-bitget");

  assert.deepEqual(result?.legs.map((leg) => ({
    status: leg.verificationStatus,
    positionMode: leg.positionMode,
    actualQuantity: leg.actualQuantity,
    actualSignedNetQuantity: leg.actualSignedNetQuantity,
  })), [
    { status: "MATCHED", positionMode: "ONE_WAY", actualQuantity: "7", actualSignedNetQuantity: "7" },
    { status: "MATCHED", positionMode: "ONE_WAY", actualQuantity: "7", actualSignedNetQuantity: "-7" },
  ]);
  assert.deepEqual(reads, ["long", "short"]);
});

test("production Bitget verification fails closed when the authoritative position mode is missing or unknown", async (t) => {
  for (const holdMode of [null, "mixed_mode"] as const) {
    await t.test(String(holdMode), async () => {
      const reads: Array<"long" | "short" | undefined> = [];
      const service = verificationService({ holdMode, longQuantity: "7", shortQuantity: "7", reads });

      const result = await service.verify(userId, "arb-bitget");

      assert.deepEqual(result?.legs.map((leg) => [leg.verificationStatus, leg.reason]), [
        ["UNKNOWN", "provider_read_failed"],
        ["UNKNOWN", "provider_read_failed"],
      ]);
      assert.deepEqual(reads, []);
    });
  }
});

test("CloseService reaches normal HEDGE SHORT close preparation after production verification MATCHED", async () => {
  const calls: ExecutionIntent[] = [];
  const { service, claims } = closeService("7", calls);

  await assert.rejects(
    () => service.closeLeg(userId, closeRequest()),
    (error: unknown) => error instanceof ArbitrageExecutionCloseError
      && error.category === "execution_state_unknown",
  );

  assert.equal(claims.count, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual({
    side: calls[0]?.side,
    positionDirection: calls[0]?.positionDirection,
    reduceOnly: calls[0]?.orderConstraints.reduceOnly,
    quantity: calls[0]?.quantity.quantity,
  }, {
    side: "buy",
    positionDirection: "SHORT",
    reduceOnly: true,
    quantity: "7",
  });
});

test("CloseService fails before runtime when the authoritative HEDGE SHORT bucket is insufficient", async () => {
  const calls: ExecutionIntent[] = [];
  const { service, claims } = closeService("6", calls);

  await assert.rejects(
    () => service.closeLeg(userId, closeRequest()),
    (error: unknown) => error instanceof ArbitrageExecutionCloseError
      && error.category === "close_quantity_unavailable",
  );

  assert.equal(claims.count, 0);
  assert.equal(calls.length, 0);
});

function verificationService(options: Readonly<{
  holdMode: string | null;
  longQuantity: string;
  shortQuantity: string;
  reads: Array<"long" | "short" | undefined>;
}>) {
  const instance = bitgetInstance();
  const query = new ArbitrageInstanceQueryService({
    get: (requestedUserId, arbitrageId) => requestedUserId === userId && arbitrageId === instance.arbitrageId ? instance : null,
    listActive: () => [instance],
    listHistory: () => [],
  });
  return createDefaultArbitragePositionVerificationService({
    query,
    credentials: {
      findSummary: (requestedUserId, venue) => venue === "bitget" ? {
        userId: requestedUserId,
        venue,
        accountId,
        accountFingerprint: "fingerprint",
        maskedApiKey: "****",
        environment: "development",
        permissions: {},
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      } : null,
      loadForAccountRead: async () => secret,
    },
    readVenues: [bitgetReadVenue()],
    clients: {
      bitget: () => ({
        readAccountSnapshot: async () => accountSnapshot(options.holdMode),
        readPerpetualPosition: async (symbol, expectedSide) => {
          assert.equal(symbol, "DOGEUSDT");
          options.reads.push(expectedSide);
          return position(expectedSide, options.longQuantity, options.shortQuantity);
        },
      }),
    },
    now: () => now,
  });
}

function closeService(shortQuantity: string, calls: ExecutionIntent[]) {
  const instance = bitgetInstance();
  const claims = { count: 0 };
  const positions = verificationService({
    holdMode: "hedge_mode",
    longQuantity: "99",
    shortQuantity,
    reads: [],
  });
  const execute = async (intent: ExecutionIntent) => {
    calls.push(intent);
    throw new Error("stop before Provider mutation");
  };
  const runtime = {
    execute,
    executeManagedClose: execute,
    reconcile: async () => { throw new Error("not used"); },
    cancel: async () => { throw new Error("not used"); },
  };
  const service = new ArbitrageExecutionCloseService(
    {
      get: (requestedUserId, arbitrageId) => requestedUserId === userId && arbitrageId === instance.arbitrageId ? instance : null,
      readCommandReplay: () => null,
      claimExecutionReference: () => { claims.count += 1; return instance; },
      linkExecutionRecord: () => instance,
      applyExecutionResult: () => instance,
    },
    positions,
    {
      load: async (_venue, instrumentId) => ({
        instrument: {
          instrumentId,
          providerSymbol: "DOGEUSDT",
          baseAsset: createAsset({ symbol: "DOGE", type: "DIGITAL_ASSET" }),
          quoteAsset: "USDT",
          settlementAsset: "USDT",
          marketType: "perpetual" as const,
          contractType: "linear_perpetual" as const,
          quantityUnit: "base" as const,
          status: "trading" as const,
        },
        tradingRules: createTradingRules({
          quantityStep: "1",
          minQuantity: "1",
          priceTick: "0.00001",
          minNotional: "5",
          contractSize: "1",
          precision: { quantity: 0, price: 5 },
        }),
        quote: { bid: "1", ask: "1.01", fetchedAt: now },
      }),
    },
    {
      readAvailableBalance: async () => { throw new Error("not used"); },
      readFreshBalance: async () => { throw new Error("not used"); },
    },
    { readAttributableBaseQuantity: async () => { throw new Error("not used"); } },
    new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("bitget", runtime)),
    { clock: () => now },
  );
  return { service, claims };
}

function closeRequest() {
  return {
    arbitrageId: "arb-bitget",
    legId: "short",
    commandId: "close-short",
    quantity: "7",
    executionMode: "EXECUTION_PRIORITY",
    confirmed: true,
  };
}

function bitgetInstance(): ArbitrageInstance {
  return {
    arbitrageId: "arb-bitget",
    userId,
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: null,
    maxResidualBaseQuantity: "0",
    status: "HOLDING",
    createdAt: now - 10,
    openedAt: now - 9,
    updatedAt: now - 1,
    closedAt: null,
    legs: [
      { legId: "long", role: "LONG", venue: "bitget", accountId, instrumentId: "DOGE-USDT-PERP", plannedQuantity: "7", confirmedOpenedQuantity: "7", confirmedClosedQuantity: "0" },
      { legId: "short", role: "SHORT", venue: "bitget", accountId, instrumentId: "DOGE-USDT-PERP", plannedQuantity: "7", confirmedOpenedQuantity: "7", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function accountSnapshot(holdMode: string | null): BitgetAccountReadSnapshot {
  return {
    uid,
    accountMode: "unified",
    assetMode: "multi_assets",
    accountLevel: "advanced",
    holdMode,
    permType: "read-and-write",
    permissions: ["uta_trade"],
    boundIps: "127.0.0.1",
    balances: [],
    fetchedAt: now,
  };
}

function position(
  expectedSide: "long" | "short" | undefined,
  longQuantity: string,
  shortQuantity: string,
): BitgetPerpetualPositionSnapshot {
  if (expectedSide === "long") return { symbol: "DOGEUSDT", side: "long", baseQuantity: longQuantity, updatedAt: now };
  if (expectedSide === "short") return { symbol: "DOGEUSDT", side: "short", baseQuantity: shortQuantity, updatedAt: now };
  return { symbol: "DOGEUSDT", side: "flat", baseQuantity: "0", updatedAt: now };
}

function bitgetReadVenue(): FundingOpportunityReadVenue {
  return {
    venue: "bitget",
    instrumentCatalog: { venue: "bitget", listInstruments: async () => [bitgetInstrument()] },
    fundingRate: { venue: "bitget", getFundingRate: async () => { throw new Error("not used"); } },
    marketData: { venue: "bitget", getTopOfBook: async () => { throw new Error("not used"); } },
  };
}

function bitgetInstrument(): CanonicalInstrument {
  return {
    instrumentId: "DOGE-USDT-PERP",
    venue: "bitget",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "DOGE",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: "DOGEUSDT",
    providerLocator: {},
    quantityUnit: "contract",
    contractSize: 1,
    priceTick: 0.00001,
    quantityStep: 1,
    minQuantity: 1,
    minNotional: 5,
    status: "trading",
    fetchedAt: now,
  };
}
