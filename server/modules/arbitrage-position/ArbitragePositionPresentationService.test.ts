import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageMarket, ArbitrageQuoteAsset } from "../arbitrage/arbitrageTypes";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitragePositionPresentationService } from "./ArbitragePositionPresentationService";

const now = 1_800_000_000_000;

test("presents spot/perpetual funding, executable spread, and paired managed scale from one snapshot", async () => {
  let reads = 0;
  const service = serviceFor([
    market("binance", "spot", 100, 102),
    market("binance", "perpetual", 110, 111, { fundingRate: 0.001, markPrice: 110 }),
  ], () => { reads += 1; });
  const [result] = await service.present([instance("binance", "binance", "DOGE-USDT-SPOT")]);

  assert.equal(reads, 1);
  assert.equal(result?.market.netFundingRate8h, 0.001);
  assert.equal(result?.market.fundingRate, 0.001);
  assert.equal(result?.market.fundingIntervalHours, 8);
  assert.deepEqual(result?.market.legs, [
    { legId: "long", venue: "binance", legRole: "LONG", marketType: "SPOT", fundingRate: null, fundingIntervalHours: null, cashflowDirection: "NOT_APPLICABLE", completeness: "COMPLETE" },
    { legId: "short", venue: "binance", legRole: "SHORT", marketType: "PERPETUAL", fundingRate: 0.001, fundingIntervalHours: 8, cashflowDirection: "INCOME", completeness: "COMPLETE" },
  ]);
  assert.equal(result?.market.nextFundingEvent.estimatedNetFee, "0.22");
  assert.equal(result?.market.nextFundingEvent.eventLegs.length, 1);
  assert.equal(result?.market.spreadQuotePerBase, 11);
  assert.equal(result?.market.managedScaleUsdt, "202");
  assert.equal(result?.market.managedScaleCompleteness, "COMPLETE");
  assert.equal(result?.market.completeness, "COMPLETE");
});

test("normalizes PP funding to 8h equivalents before summing income and expense", async () => {
  const service = serviceFor([
    market("binance", "perpetual", 99, 100, { fundingRate: 0.002, fundingIntervalHours: 4, markPrice: 100 }),
    market("bitget", "perpetual", 104, 105, { fundingRate: 0.003, fundingIntervalHours: 8, markPrice: 105 }),
  ]);
  const [result] = await service.present([instance("binance", "bitget", "DOGE-USDT-PERP")]);

  assert.equal(result?.market.netFundingRate8h, -0.001);
  assert.deepEqual(result?.market.legs.map((leg) => [leg.legRole, leg.fundingRate, leg.fundingIntervalHours, leg.cashflowDirection]), [
    ["LONG", 0.002, 4, "EXPENSE"],
    ["SHORT", 0.003, 8, "INCOME"],
  ]);
});

test("funding direction combines side and funding sign", async () => {
  const service = serviceFor([
    market("binance", "perpetual", 99, 100, { fundingRate: -0.002, markPrice: 100 }),
    market("bitget", "perpetual", 104, 105, { fundingRate: -0.003, markPrice: 105 }),
  ]);
  const [result] = await service.present([instance("binance", "bitget", "DOGE-USDT-PERP")]);
  assert.deepEqual(result?.market.legs.map((leg) => leg.cashflowDirection), ["INCOME", "EXPENSE"]);
});

test("groups only exactly equal next funding timestamps", async () => {
  const service = serviceFor([
    market("binance", "perpetual", 99, 100, { fundingRate: 0.002, markPrice: 100, nextFundingTime: now + 1_000 }),
    market("bitget", "perpetual", 104, 105, { fundingRate: 0.003, markPrice: 105, nextFundingTime: now + 1_001 }),
  ]);
  const [result] = await service.present([instance("binance", "bitget", "DOGE-USDT-PERP")]);

  assert.equal(result?.market.nextFundingEvent.time, now + 1_000);
  assert.equal(result?.market.nextFundingEvent.eventLegs.length, 1);
  assert.equal(result?.market.nextFundingEvent.eventLegs[0]?.legRole, "LONG");
  assert.equal(result?.market.nextFundingEvent.estimatedNetFee, "-0.4");
});

test("nets both legs when next funding timestamps are exactly equal", async () => {
  const service = serviceFor([
    market("binance", "perpetual", 99, 100, { fundingRate: 0.002, markPrice: 100 }),
    market("bitget", "perpetual", 104, 105, { fundingRate: 0.003, markPrice: 105 }),
  ]);
  const [result] = await service.present([instance("binance", "bitget", "DOGE-USDT-PERP")]);

  assert.equal(result?.market.nextFundingEvent.eventLegs.length, 2);
  assert.equal(result?.market.nextFundingEvent.estimatedNetFee, "0.23");
});

test("maps cross-venue long bid and short ask without extra snapshot reads", async () => {
  let reads = 0;
  const service = serviceFor([
    market("binance", "spot", 99, 100),
    market("bitget", "perpetual", 104, 105, { fundingRate: 0.002, markPrice: 104 }),
  ], () => { reads += 1; });
  const results = await service.present([
    instance("binance", "bitget", "DOGE-USDT-SPOT", "a"),
    instance("binance", "bitget", "DOGE-USDT-SPOT", "b"),
  ]);
  assert.equal(reads, 1);
  assert.equal(results[0]?.market.spreadQuotePerBase, 6);
  assert.equal(results[1]?.market.spreadQuotePerBase, 6);
});

test("managed scale uses spot midpoint and perpetual mark rather than safe-close or account reality", async () => {
  const base = instance("binance", "bitget", "DOGE-USDT-SPOT");
  const value = { ...base, legs: [
    { ...base.legs[0], confirmedOpenedQuantity: "3" },
    base.legs[1],
  ] } as ArbitrageInstance;
  const service = serviceFor([
    market("binance", "spot", 99, 101),
    market("bitget", "perpetual", 200, 201, { fundingRate: 0.001, markPrice: 150 }),
  ]);
  const [result] = await service.present([value]);
  assert.equal(result?.market.managedScaleUsdt, "300");
});

test("fails managed scale closed for non-USDT or stale valuation facts", async () => {
  const nonUsdtService = serviceFor([
    market("binance", "spot", 100, 101, { quoteAsset: "USDC" }),
    market("binance", "perpetual", 110, 111, { fundingRate: 0.001, markPrice: 110 }),
  ]);
  const [nonUsdt] = await nonUsdtService.present([instance("binance", "binance", "DOGE-USDT-SPOT")]);
  assert.equal(nonUsdt?.market.managedScaleUsdt, null);
  assert.equal(nonUsdt?.market.managedScaleCompleteness, "INCOMPLETE");

  const staleService = serviceFor([
    { ...market("binance", "spot", 100, 101), fetchedAt: now - 20_001 },
    market("binance", "perpetual", 110, 111, { fundingRate: 0.001, markPrice: 110 }),
  ]);
  const [stale] = await staleService.present([instance("binance", "binance", "DOGE-USDT-SPOT")]);
  assert.equal(stale?.market.managedScaleUsdt, null);
  assert.equal(stale?.market.spreadQuotePerBase, null);
});

test("keeps all four realized revenue fields null and incomplete without accounting facts", async () => {
  const service = serviceFor([
    market("binance", "spot", 100, 101),
    market("binance", "perpetual", 110, 111, { fundingRate: 0.001, markPrice: 110 }),
  ]);
  const [result] = await service.present([instance("binance", "binance", "DOGE-USDT-SPOT")]);
  assert.deepEqual(result?.revenue, {
    cumulativeFundingIncome: null,
    cumulativeFundingIncomeCompleteness: "INCOMPLETE",
    incurredFees: null,
    incurredFeesCompleteness: "INCOMPLETE",
    realizedSpreadProfit: null,
    realizedSpreadProfitCompleteness: "INCOMPLETE",
    realizedNetProfit: null,
    realizedNetProfitCompleteness: "INCOMPLETE",
    completeness: "INCOMPLETE",
  });
});

test("presents reliable fees and realized spread independently while funding and net profit remain incomplete", async () => {
  const base = instance("binance", "bitget", "DOGE-USDT-PERP");
  const references = [
    accountingReference("lo", "long", "OPENING", "2"),
    accountingReference("so", "short", "OPENING", "2"),
    accountingReference("lc", "long", "CLOSING", "1"),
    accountingReference("sc", "short", "CLOSING", "1"),
  ];
  const withFacts = { ...base, executionReferences: references } as ArbitrageInstance;
  const service = new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    return { generatedAt: now, markets: [
      market("binance", "perpetual", 104, 105, { fundingRate: 0.001, markPrice: 104 }),
      market("bitget", "perpetual", 102, 103, { fundingRate: 0.002, markPrice: 103 }),
    ] };
  } }, () => now, 20_000, {
    listExecutionAccountingFacts: () => [
      accountingFact("lo", "long", "OPENING", "2", "100", "0.01"),
      accountingFact("so", "short", "OPENING", "2", "110", "0.01"),
      accountingFact("lc", "long", "CLOSING", "1", "105", "0.01"),
      accountingFact("sc", "short", "CLOSING", "1", "103", "-0.005"),
    ],
  });
  const [result] = await service.present([withFacts]);
  assert.deepEqual(result?.revenue, {
    cumulativeFundingIncome: null,
    cumulativeFundingIncomeCompleteness: "INCOMPLETE",
    incurredFees: "0.025",
    incurredFeesCompleteness: "COMPLETE",
    realizedSpreadProfit: "12",
    realizedSpreadProfitCompleteness: "COMPLETE",
    realizedNetProfit: null,
    realizedNetProfitCompleteness: "INCOMPLETE",
    completeness: "INCOMPLETE",
  });
});

test("presentation recovers from a missing expected fact after a later authoritative upsert", async () => {
  const value = { ...instance("binance", "bitget", "DOGE-USDT-PERP"), executionReferences: [
    accountingReference("lo", "long", "OPENING", "2"),
    accountingReference("so", "short", "OPENING", "2"),
  ] } as ArbitrageInstance;
  const facts = [accountingFact("lo", "long", "OPENING", "2", "100", "0.1")];
  const service = serviceFor([
    market("binance", "perpetual", 99, 100, { fundingRate: 0.001, markPrice: 100 }),
    market("bitget", "perpetual", 109, 110, { fundingRate: 0.001, markPrice: 110 }),
  ], undefined, { listExecutionAccountingFacts: () => facts });

  const [missing] = await service.present([value]);
  assert.equal(missing?.revenue.incurredFees, null);
  assert.equal(missing?.revenue.realizedSpreadProfit, null);
  facts.push(accountingFact("so", "short", "OPENING", "2", "110", "0.1"));
  const [recovered] = await service.present([value]);
  assert.equal(recovered?.revenue.incurredFees, "0.2");
  assert.equal(recovered?.revenue.realizedSpreadProfit, "0");
});

test("isolates one invalid instrument mapping without failing the batch", async () => {
  const service = serviceFor([
    market("binance", "spot", 100, 101),
    market("binance", "perpetual", 110, 111, { fundingRate: 0.001, markPrice: 110 }),
  ]);
  const valid = instance("binance", "binance", "DOGE-USDT-SPOT", "valid");
  const invalid = { ...valid, arbitrageId: "invalid", legs: [{ ...valid.legs[0], instrumentId: "INVALID" }, valid.legs[1]] } as ArbitrageInstance;
  const results = await service.present([invalid, valid]);
  assert.equal(results[0]?.market.completeness, "INCOMPLETE");
  assert.equal(results[1]?.market.completeness, "COMPLETE");
});

function serviceFor(
  markets: ArbitrageMarket[],
  onRead = () => undefined,
  accountingSource?: ConstructorParameters<typeof ArbitragePositionPresentationService>[3],
) {
  return new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    onRead();
    return { generatedAt: now, markets };
  } }, () => now, undefined, accountingSource);
}

function accountingReference(id: string, legId: string, phase: "OPENING" | "CLOSING", quantity: string) {
  return {
    arbitrageId: "arb-1", legId, phase, quantityEffect: phase === "OPENING" ? "INCREASE" as const : "DECREASE" as const,
    executionIntentId: id, executionRecordId: `record-${id}`, requestedQuantity: quantity,
    confirmedQuantity: quantity, status: "CONFIRMED" as const, createdAt: now - 2, updatedAt: now - 1,
  };
}

function accountingFact(id: string, legId: string, executionPhase: "OPENING" | "CLOSING", quantity: string, price: string, fee: string) {
  return {
    executionRecordId: `record-${id}`, arbitrageId: "arb-1", legId, executionIntentId: id,
    providerOrderId: `order-${id}`, executionPhase,
    quantityEffect: executionPhase === "OPENING" ? "INCREASE" as const : "DECREASE" as const,
    terminalExecutionStatus: "CONFIRMED" as const, filledQuantity: quantity, averageFillPrice: price,
    feeAmountProvider: fee, feeAsset: "USDT", tradingFeeNetCostUsdt: fee,
    confirmedAt: now - 1, priceCompleteness: "COMPLETE" as const,
    feeCompleteness: "COMPLETE" as const, integrityStatus: "VERIFIED" as const,
    completeness: "COMPLETE" as const, createdAt: now - 1,
  };
}

function instance(longVenue: "binance" | "bitget", shortVenue: "binance" | "bitget", longInstrument: string, id = "arb-1") {
  return {
    arbitrageId: id, userId: "user-a", strategyType: longInstrument.endsWith("SPOT") ? "SPOT_PERPETUAL" : "PERPETUAL_PERPETUAL",
    sourcePlanId: null, maxResidualBaseQuantity: "0", status: "HOLDING", createdAt: now, openedAt: now, updatedAt: now, closedAt: null,
    legs: [
      { legId: "long", role: "LONG", venue: longVenue, accountId: "a", instrumentId: longInstrument, plannedQuantity: "2", confirmedOpenedQuantity: "2", confirmedClosedQuantity: "0" },
      { legId: "short", role: "SHORT", venue: shortVenue, accountId: "b", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "2", confirmedOpenedQuantity: "2", confirmedClosedQuantity: "0" },
    ], executionReferences: [], managementReleases: [], legacyUnresolvedExecutionSeals: [],
    pnl: { asset: "USDT", cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  } as ArbitrageInstance;
}

function market(
  venue: "binance" | "bitget",
  kind: "spot" | "perpetual",
  bid: number,
  ask: number,
  options: Partial<Pick<ArbitrageMarket, "fundingRate" | "fundingIntervalHours" | "markPrice" | "nextFundingTime">>
    & { quoteAsset?: ArbitrageQuoteAsset } = {},
): ArbitrageMarket {
  const quoteAsset = options.quoteAsset ?? "USDT";
  return {
    id: `${venue}:DOGEUSDT:${kind}`, venue, venueLabel: venue, symbol: "DOGEUSDT", asset: "DOGE", kind,
    quoteAsset, settlementAsset: quoteAsset, bid, ask, markPrice: options.markPrice ?? null, indexPrice: null, spreadBps: null,
    fundingRate: options.fundingRate ?? null,
    fundingIntervalHours: options.fundingIntervalHours ?? (kind === "perpetual" ? 8 : null),
    currentFundingApr: null, historicalFundingApr: null, fundingPositiveRatio: null, fundingCoverageRatio: null,
    slippageBps10k: null, slippageBps100k: null, depthUsd: null, volume24h: null, openInterest: null,
    nextFundingTime: options.nextFundingTime ?? (kind === "perpetual" ? now + 3_600_000 : null),
    takerFeeBps: 10, status: "connected", fetchedAt: now, warnings: [],
  };
}
