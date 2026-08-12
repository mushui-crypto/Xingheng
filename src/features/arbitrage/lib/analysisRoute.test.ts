import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageDashboardSnapshot, ArbitrageOpportunity } from "../model/types";
import {
  buildArbitrageAnalysisHref,
  findArbitrageAnalysisOpportunity,
  parseArbitrageAnalysisHorizon,
} from "./analysisRoute";

const opportunity = { id: "binance-btc-spot--okx-btc-perp" } as ArbitrageOpportunity;
const snapshot = { opportunities: [opportunity] } as ArbitrageDashboardSnapshot;

test("analysis href preserves the existing opportunity id and holding horizon", () => {
  const href = buildArbitrageAnalysisHref(opportunity.id, 365);
  const url = new URL(href, "https://stellax.local");

  assert.equal(url.pathname, "/app/funding-arbitrage");
  assert.equal(url.searchParams.get("opportunityId"), opportunity.id);
  assert.equal(url.searchParams.get("horizonDays"), "365");
});

test("analysis selection can be restored from a freshly loaded snapshot", () => {
  assert.equal(findArbitrageAnalysisOpportunity(snapshot, opportunity.id), opportunity);
  assert.equal(findArbitrageAnalysisOpportunity(snapshot, "missing-opportunity"), null);
  assert.equal(findArbitrageAnalysisOpportunity(null, opportunity.id), null);
});

test("analysis horizon accepts only the supported 90 and 365 day scenarios", () => {
  assert.equal(parseArbitrageAnalysisHorizon("365"), 365);
  assert.equal(parseArbitrageAnalysisHorizon("90"), 90);
  assert.equal(parseArbitrageAnalysisHorizon("invalid"), 90);
  assert.equal(parseArbitrageAnalysisHorizon(null), 90);
});
