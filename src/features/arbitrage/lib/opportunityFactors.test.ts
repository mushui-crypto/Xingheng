import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityFactors } from "./opportunityFactors";

const opportunity = {
  capacityUsd: 25_000,
  confidence: "high" as const,
  currentGrossApr: 8,
  disqualifiers: [] as string[],
  entryBasisBps: 4,
  longLeg: { ask: 3_000 },
  netApr: 6,
  opportunityDriver: "mixed" as const,
  persistenceRatio: 0.76,
  recommendation: "recommended" as const,
  shortLeg: { bid: 3_001 },
  warnings: [] as string[],
};

test("opportunity factors cover the six decision categories without exposing scores", () => {
  const factors = buildOpportunityFactors(opportunity as Parameters<typeof buildOpportunityFactors>[0]);

  assert.deepEqual(factors.map((factor) => factor.label), [
    "收益",
    "持续性",
    "比较置信度",
    "流动性 / 报价",
    "基差 / 资金费率",
    "数据 / 条件状态",
  ]);
  assert.equal(factors.every((factor) => !factor.value.includes("/ 100")), true);
  assert.match(factors[0]?.value ?? "", /^估算净 APR /u);
  assert.equal(factors[2]?.value, "数据覆盖、标的匹配与结算兼容性支持高置信比较");
});

test("safety disqualifiers remain a negative conclusion factor", () => {
  const [,,,,, safety] = buildOpportunityFactors({
    ...opportunity,
    disqualifiers: ["报价已过期"],
    recommendation: "blocked",
  } as Parameters<typeof buildOpportunityFactors>[0]);

  assert.equal(safety.tone, "negative");
  assert.equal(safety.value, "报价已过期");
});
