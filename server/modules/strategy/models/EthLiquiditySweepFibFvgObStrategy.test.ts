import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  buildEthV2ExitPlan,
  buildHigherTimeframeEmaBias,
  ethLiquiditySweepFibFvgObV2AConfig,
  ethLiquiditySweepFibFvgObV2BConfig,
  resolveEthPointStop,
  selectOrderBlockNearFvg,
} from "./EthLiquiditySweepFibFvgObStrategy";

const baseTime = Date.parse("2026-07-13T11:00:00Z") / 1000;

function candle(
  index: number,
  values: Pick<Candle, "open" | "high" | "low" | "close">,
  interval: Candle["interval"] = "5m",
): Candle {
  return {
    symbol: "ETHUSDT",
    interval,
    time: baseTime + index * (interval === "15m" ? 900 : 300),
    volume: 100,
    ...values,
  };
}

test("ETH point stop expands a close structure to 20 points and preserves a valid 20-40 point structure", () => {
  assert.deepEqual(resolveEthPointStop({
    side: "long",
    entryPrice: 3_000,
    structuralStopPrice: 2_985,
    minimumStopPoints: 20,
    maximumStopPoints: 40,
  }), {
    stopPrice: 2_980,
    riskDistance: 20,
    structuralRiskDistance: 15,
    expandedToMinimum: true,
  });

  assert.deepEqual(resolveEthPointStop({
    side: "short",
    entryPrice: 3_000,
    structuralStopPrice: 3_032,
    minimumStopPoints: 20,
    maximumStopPoints: 40,
  }), {
    stopPrice: 3_032,
    riskDistance: 32,
    structuralRiskDistance: 32,
    expandedToMinimum: false,
  });
});

test("ETH point stop rejects structure beyond 40 points instead of truncating it", () => {
  assert.equal(resolveEthPointStop({
    side: "long",
    entryPrice: 3_000,
    structuralStopPrice: 2_959.99,
    minimumStopPoints: 20,
    maximumStopPoints: 40,
  }), null);
  assert.equal(resolveEthPointStop({
    side: "short",
    entryPrice: 3_000,
    structuralStopPrice: 2_990,
    minimumStopPoints: 20,
    maximumStopPoints: 40,
  }), null);
});

test("order-block selector uses the nearest opposite candle and FVG-to-range distance", () => {
  const candles: Candle[] = [
    candle(0, { open: 108, high: 109, low: 106, close: 107 }),
    candle(1, { open: 112, high: 113, low: 110, close: 111 }),
    candle(2, { open: 111, high: 112, low: 108, close: 109 }),
    candle(3, { open: 109, high: 118, low: 109, close: 117 }),
  ];
  const selected = selectOrderBlockNearFvg({
    candles,
    mssIndex: 3,
    side: "long",
    fvg: { index: 3, lower: 112, upper: 114, midpoint: 113, side: "bullish" },
    atr: 4,
    lookbackBars: 6,
    maximumDistanceAtr: 0.5,
  });

  assert.ok(selected);
  assert.equal(selected.index, 2);
  assert.equal(selected.distance, 0);
  assert.equal(selected.distanceAtr, 0);
});

test("order-block selector rejects when the nearest opposite block is too far even if an older block is close", () => {
  const candles: Candle[] = [
    candle(0, { open: 113, high: 114, low: 111, close: 112 }),
    candle(1, { open: 100, high: 101, low: 98, close: 99 }),
    candle(2, { open: 105, high: 106, low: 104, close: 104.5 }),
    candle(3, { open: 110, high: 120, low: 109, close: 119 }),
  ];
  assert.equal(selectOrderBlockNearFvg({
    candles,
    mssIndex: 3,
    side: "long",
    fvg: { index: 3, lower: 112, upper: 114, midpoint: 113, side: "bullish" },
    atr: 4,
    lookbackBars: 6,
    maximumDistanceAtr: 0.5,
  }), null);
});

test("15m EMA bias is neutral before 20 completed buckets and directional afterward", () => {
  const higher: Candle[] = [];
  for (let index = 0; index < 19; index += 1) {
    higher.push(candle(index, { open: 100, high: 101, low: 99, close: 100 }, "15m"));
  }
  higher.push(candle(19, { open: 100, high: 111, low: 99, close: 110 }, "15m"));
  higher.push(candle(20, { open: 110, high: 111, low: 89, close: 90 }, "15m"));

  const bias = buildHigherTimeframeEmaBias(higher, 20);
  assert.equal(bias.get(higher[18].time), "neutral");
  assert.equal(bias.get(higher[19].time), "bullish");
  assert.equal(bias.get(higher[20].time), "bearish");
});

test("V2A and V2B keep identical 2.5R final targets while V2B scales 50 percent at 1R", () => {
  assert.equal(ethLiquiditySweepFibFvgObV2AConfig.rewardRisk, 2.5);
  assert.equal(ethLiquiditySweepFibFvgObV2BConfig.rewardRisk, 2.5);
  assert.equal(buildEthV2ExitPlan("long", 3_000, 20, "single_2_5r"), null);
  assert.deepEqual(buildEthV2ExitPlan("long", 3_000, 20, "scale_1r_2_5r"), {
    targets: [
      {
        price: 3_020,
        quantityFraction: 0.5,
        moveStopToBreakEvenAfterFill: true,
        label: "tp1_1r",
      },
      { price: 3_050, quantityFraction: 0.5, label: "tp2_2_5r" },
    ],
  });
  assert.deepEqual(buildEthV2ExitPlan("short", 3_000, 20, "scale_1r_2_5r")?.targets.map((target) => target.price), [
    2_980,
    2_950,
  ]);
});
