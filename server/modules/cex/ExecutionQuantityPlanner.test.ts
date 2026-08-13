import assert from "node:assert/strict";
import test from "node:test";
import { createAsset } from "./Asset";
import {
  ExecutionQuantityPlanner,
  type ExecutionQuantityInput,
  type ExecutionQuantityPlanningInstrument,
} from "./ExecutionQuantityPlanner";
import { createTradingRules, type TradingRules } from "./TradingRules";

const now = 1_800_000_000_000;
const btc = createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" });

test("Perpetual BUY uses Decimal ask and never exceeds the user budget", async () => {
  const result = await planner().plan(request({
    side: "buy",
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
    quote: { bid: "2.9", ask: "3", fetchedAt: now - 1 },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.sizingPrice, "3");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "6.66");
  assert.equal(result.plan.estimatedNotionalUsdt, "19.98");
  assert.deepEqual(result.plan.quantityInput, { mode: "NOTIONAL_USDT", amountUsdt: "20" });
});

test("Perpetual SELL uses Decimal bid", async () => {
  const result = await planner().plan(request({
    side: "sell",
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
    quote: { bid: "4", ask: "5", fetchedAt: now },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.sizingPrice, "4");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "5");
  assert.equal(result.plan.estimatedNotionalUsdt, "20");
});

test("USDT Spot BUY uses ask without requiring an irrelevant settlement asset", async () => {
  const spot = instrument({
    instrumentId: "BTC-USDT-SPOT",
    marketType: "spot",
    contractType: "spot",
    settlementAsset: undefined,
  });
  const result = await planner({ instrument: spot }).plan(request({
    instrumentId: spot.instrumentId,
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "10" },
    quote: { bid: "4", ask: "5", fetchedAt: now },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.sizingPrice, "5");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "2");
  assert.equal("limitPrice" in result.plan, false);
});

test("Spot SELL uses bid and validates base-unit step, minimum quantity, and minimum notional", async () => {
  const spot = instrument({
    instrumentId: "BTC-USDT-SPOT",
    marketType: "spot",
    contractType: "spot",
    settlementAsset: undefined,
  });
  const result = await planner({
    instrument: spot,
    rules: rules({ quantityStep: "0.1", minQuantity: "0.2", minNotional: "5" }),
  }).plan(request({
    instrumentId: spot.instrumentId,
    side: "sell",
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "7.9" },
    quote: { bid: "10", ask: "11", fetchedAt: now },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.sizingPrice, "10");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "0.7");
  assert.equal(result.plan.estimatedNotionalUsdt, "7");
});

test("priceTick is not applied when bid/ask is only a sizing quote", async () => {
  const result = await planner({
    rules: rules({ priceTick: "1000" }),
  }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
    quote: { bid: "2.9", ask: "3", fetchedAt: now },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.sizingPrice, "3");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "6.66");
});

test("quantity steps 0.1, 0.01, and 0.001 are aligned with Decimal arithmetic", async () => {
  for (const [step, expected] of [
    ["0.1", "0.3"],
    ["0.01", "0.33"],
    ["0.001", "0.333"],
  ] as const) {
    const result = await planner({ rules: rules({ quantityStep: step, minQuantity: step }) }).plan(request({
      quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "1" },
      quote: { bid: "2.9", ask: "3", fetchedAt: now },
    }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plan.plannedAssetQuantity.quantity, expected);
  }
});

test("base quantity venue applies quantityStep and minQuantity in base asset units", async () => {
  const result = await planner({
    rules: rules({ quantityStep: "0.1", minQuantity: "0.3" }),
  }).plan(request({ quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.3" } }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.plannedAssetQuantity.quantity, "0.3");
  assert.equal(result.plan.plannedVenueQuantity, undefined);
});

test("many decimal places remain exact", async () => {
  const quantity = "0.123456789123456789";
  const result = await planner({
    rules: rules({
      quantityStep: "0.000000000000000001",
      minQuantity: "0.000000000000000001",
      priceTick: "0.000000000000000001",
    }),
  }).plan(request({ quantityInput: { mode: "ASSET_QUANTITY", quantity } }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.plannedAssetQuantity.quantity, quantity);
  assert.equal(result.plan.estimatedNotionalUsdt, "1234.56789123456789");
});

test("ASSET_QUANTITY returns a structured mismatch and nearest lower legal quantity", async () => {
  const result = await planner({ rules: rules({ quantityStep: "0.01" }) }).plan(request({
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "1.234" },
  }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "QUANTITY_STEP_MISMATCH");
  assert.equal(result.error.nearestLegalAssetQuantity, "1.23");
});

test("contract quantity is aligned and converted back to base AssetQuantity", async () => {
  const result = await planner({
    instrument: instrument({ quantityUnit: "contract" }),
    rules: rules({ quantityStep: "0.1", minQuantity: "0.1", contractSize: "0.01" }),
  }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "2.55" },
    quote: { bid: "99", ask: "100", fetchedAt: now },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.plannedVenueQuantity, "2.5");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "0.025");
  assert.equal(result.plan.estimatedNotionalUsdt, "2.5");
});

test("contract minQuantity is compared in contracts rather than BTC base quantity", async () => {
  const result = await planner({
    instrument: instrument({ quantityUnit: "contract" }),
    rules: rules({ quantityStep: "0.1", minQuantity: "0.5", contractSize: "0.01" }),
  }).plan(request({ quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" } }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.plannedVenueQuantity, "1");
  assert.equal(result.plan.plannedAssetQuantity.quantity, "0.01");
});

test("contract minQuantity failure reports contract and converted base minimums", async () => {
  const result = await planner({
    instrument: instrument({ quantityUnit: "contract" }),
    rules: rules({ quantityStep: "1", minQuantity: "3", contractSize: "0.01" }),
  }).plan(request({ quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.02" } }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "QUANTITY_BELOW_MINIMUM");
  assert.equal(result.error.minimumRequiredVenueQuantity, "3");
  assert.equal(result.error.minimumRequiredAssetQuantity, "0.03");
});

test("ASSET_QUANTITY contract input must map to an exact venue step", async () => {
  const result = await planner({
    instrument: instrument({ quantityUnit: "contract" }),
    rules: rules({ quantityStep: "0.1", minQuantity: "0.1", contractSize: "0.01" }),
  }).plan(request({ quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.0251" } }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "QUANTITY_STEP_MISMATCH");
  assert.equal(result.error.nearestLegalAssetQuantity, "0.025");
});

test("flooring below one step returns QUANTITY_ROUNDED_TO_ZERO", async () => {
  const result = await planner({ rules: rules({ quantityStep: "0.1", minQuantity: "0.1" }) }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "0.5" },
    quote: { bid: "9", ask: "10", fetchedAt: now },
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "QUANTITY_ROUNDED_TO_ZERO");
    assert.equal(result.error.minimumRequiredAssetQuantity, "0.1");
    assert.equal(result.error.minimumRequiredNotionalUsdt, "1");
  }
});

test("minQuantity failure returns the current minimum legal hint without raising the budget", async () => {
  const result = await planner({ rules: rules({ quantityStep: "0.1", minQuantity: "0.3" }) }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "0.25" },
    quote: { bid: "1", ask: "1", fetchedAt: now },
  }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "QUANTITY_BELOW_MINIMUM");
  assert.equal(result.error.minimumRequiredAssetQuantity, "0.3");
  assert.equal(result.error.minimumRequiredNotionalUsdt, "0.3");
});

test("minNotional exact boundary passes and a lower budget fails with a minimum hint", async () => {
  const exact = await planner({ rules: rules({ quantityStep: "1", minQuantity: "1", minNotional: "10" }) }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "10" },
    quote: { bid: "2", ask: "2", fetchedAt: now },
  }));
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.plan.estimatedNotionalUsdt, "10");

  const below = await planner({ rules: rules({ quantityStep: "1", minQuantity: "1", minNotional: "10" }) }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "9.999" },
    quote: { bid: "2", ask: "2", fetchedAt: now },
  }));
  assert.equal(below.ok, false);
  if (!below.ok) {
    assert.equal(below.error.code, "NOTIONAL_BELOW_MINIMUM");
    assert.equal(below.error.minimumRequiredAssetQuantity, "5");
    assert.equal(below.error.minimumRequiredNotionalUsdt, "10");
  }
});

test("a 5 USDT budget is rejected instead of being raised to a 6.4 USDT minimum", async () => {
  const result = await planner({
    rules: rules({ quantityStep: "0.1", minQuantity: "0.1", minNotional: "6.4" }),
  }).plan(request({
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "5" },
    quote: { bid: "1", ask: "1", fetchedAt: now },
  }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "NOTIONAL_BELOW_MINIMUM");
  assert.equal(result.error.minimumRequiredAssetQuantity, "6.4");
  assert.equal(result.error.minimumRequiredNotionalUsdt, "6.4");
});

test("invalid input amounts are rejected", async () => {
  for (const quantityInput of [
    { mode: "NOTIONAL_USDT", amountUsdt: "0" },
    { mode: "NOTIONAL_USDT", amountUsdt: "-1" },
    { mode: "ASSET_QUANTITY", quantity: "0" },
    { mode: "ASSET_QUANTITY", quantity: "-1" },
  ] as ExecutionQuantityInput[]) {
    const result = await planner().plan(request({ quantityInput }));
    assert.equal(result.ok, false);
  }
});

test("instrument existence, status, and USDT quote/settlement are fail-closed for both input modes", async () => {
  const missing = await planner({ instrument: null }).plan(request());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "INSTRUMENT_NOT_FOUND");

  const paused = await planner({ instrument: instrument({ status: "paused" }) }).plan(request());
  assert.equal(paused.ok, false);
  if (!paused.ok) assert.equal(paused.error.code, "INSTRUMENT_NOT_TRADING");

  const nonUsdtInstrument = instrument({
    instrumentId: "BTC-USDC-PERP",
    quoteAsset: "USDC",
    settlementAsset: "USDC",
  });
  const nonUsdtNotional = await planner({ instrument: nonUsdtInstrument }).plan(request({
    instrumentId: nonUsdtInstrument.instrumentId,
  }));
  assert.equal(nonUsdtNotional.ok, false);
  if (!nonUsdtNotional.ok) assert.equal(nonUsdtNotional.error.code, "INSTRUMENT_NOT_USDT_QUOTED");

  const nonUsdtAsset = await planner({ instrument: nonUsdtInstrument }).plan(request({
    instrumentId: nonUsdtInstrument.instrumentId,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" },
  }));
  assert.equal(nonUsdtAsset.ok, false);
  if (!nonUsdtAsset.ok) assert.equal(nonUsdtAsset.error.code, "INSTRUMENT_NOT_USDT_QUOTED");
});

test("instrument eligibility distinguishes Spot quote from linear perpetual settlement", async () => {
  const usdtSpot = instrument({
    instrumentId: "BTC-USDT-SPOT",
    marketType: "spot",
    contractType: "spot",
    settlementAsset: undefined,
  });
  const spotResult = await planner({ instrument: usdtSpot }).plan(request({
    instrumentId: usdtSpot.instrumentId,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" },
  }));
  assert.equal(spotResult.ok, true);

  const nonUsdtSpot = instrument({
    instrumentId: "BTC-USDC-SPOT",
    quoteAsset: "USDC",
    settlementAsset: undefined,
    marketType: "spot",
    contractType: "spot",
  });
  const nonUsdtSpotResult = await planner({ instrument: nonUsdtSpot }).plan(request({
    instrumentId: nonUsdtSpot.instrumentId,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" },
  }));
  assert.equal(nonUsdtSpotResult.ok, false);
  if (!nonUsdtSpotResult.ok) assert.equal(nonUsdtSpotResult.error.code, "INSTRUMENT_NOT_USDT_QUOTED");

  const usdtLinear = instrument();
  const linearResult = await planner({ instrument: usdtLinear }).plan(request({
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" },
  }));
  assert.equal(linearResult.ok, true);

  const nonUsdtSettlement = instrument({ settlementAsset: "USDC" });
  const nonUsdtSettlementResult = await planner({ instrument: nonUsdtSettlement }).plan(request({
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" },
  }));
  assert.equal(nonUsdtSettlementResult.ok, false);
  if (!nonUsdtSettlementResult.ok) {
    assert.equal(nonUsdtSettlementResult.error.code, "INSTRUMENT_NOT_USDT_QUOTED");
  }

  const inverse = instrument({ contractType: "inverse_perpetual", settlementAsset: "BTC" });
  const inverseResult = await planner({ instrument: inverse }).plan(request({
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.01" },
  }));
  assert.equal(inverseResult.ok, false);
  if (!inverseResult.ok) assert.equal(inverseResult.error.code, "INSTRUMENT_NOT_USDT_QUOTED");
});

test("invalid and stale quotes are rejected", async () => {
  const invalid = await planner().plan(request({ quote: { bid: "0", ask: "10000", fetchedAt: now } }));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "QUOTE_INVALID");

  const stale = await planner().plan(request({ quote: { bid: "9999", ask: "10000", fetchedAt: now - 10_001 } }));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "QUOTE_STALE");

  const missingAsk = await planner().plan(request({
    quote: { bid: "9999", fetchedAt: now } as never,
  }));
  assert.equal(missingAsk.ok, false);
  if (!missingAsk.ok) assert.equal(missingAsk.error.code, "QUOTE_INVALID");
});

test("contract instruments fail closed without contractSize", async () => {
  const result = await planner({
    instrument: instrument({ quantityUnit: "contract" }),
    rules: rules({ contractSize: undefined }),
  }).plan(request());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CONTRACT_SIZE_REQUIRED");
});

type PlannerOptions = Readonly<{
  instrument?: ExecutionQuantityPlanningInstrument | null;
  rules?: TradingRules;
}>;

function planner(options: PlannerOptions = {}) {
  const resolvedInstrument = options.instrument === undefined ? instrument() : options.instrument;
  return new ExecutionQuantityPlanner(
    { resolve: async () => resolvedInstrument },
    { getTradingRules: async () => options.rules ?? rules() },
    { now: () => now, maxQuoteAgeMs: 10_000 },
  );
}

function request(overrides: Partial<Parameters<ExecutionQuantityPlanner["plan"]>[0]> = {}) {
  return {
    instrumentId: "BTC-USDT-PERP",
    side: "buy" as const,
    quantityInput: { mode: "NOTIONAL_USDT" as const, amountUsdt: "20" },
    quote: { bid: "9999", ask: "10000", fetchedAt: now },
    ...overrides,
  };
}

function instrument(overrides: Partial<ExecutionQuantityPlanningInstrument> = {}): ExecutionQuantityPlanningInstrument {
  return Object.freeze({
    instrumentId: "BTC-USDT-PERP",
    providerSymbol: "BTCUSDT",
    baseAsset: btc,
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    quantityUnit: "base",
    status: "trading",
    ...overrides,
  });
}

function rules(overrides: Partial<{
  quantityStep: string;
  minQuantity: string;
  priceTick: string;
  minNotional: string;
  contractSize: string | undefined;
}> = {}) {
  return createTradingRules({
    quantityStep: overrides.quantityStep ?? "0.01",
    minQuantity: overrides.minQuantity ?? "0.01",
    priceTick: overrides.priceTick ?? "0.01",
    ...(overrides.minNotional === undefined ? {} : { minNotional: overrides.minNotional }),
    ...(overrides.contractSize === undefined ? {} : { contractSize: overrides.contractSize }),
    precision: {},
  });
}
