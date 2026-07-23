import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageOpportunity } from "../model/types";
import {
  matchesOpportunityEntryStatus,
  matchesOpportunityRecommendation,
  matchesOpportunityVenue,
  opportunityLegVenues,
} from "./opportunityFilters";

const bybitSameVenue = opportunity("same", "bybit", "bybit", "same_venue_neutral");
const bybitCrossVenue = opportunity("cross", "bybit", "okx", "cross_venue_arbitrage");

test("long and short venue filters match their corresponding legs independently", () => {
  assert.equal(matchesOpportunityVenue(bybitSameVenue, "bybit", "bybit"), true);
  assert.equal(matchesOpportunityVenue(bybitCrossVenue, "bybit", "okx"), true);
  assert.equal(matchesOpportunityVenue(bybitCrossVenue, "okx", "bybit"), false);
  assert.equal(matchesOpportunityVenue(bybitCrossVenue, "bybit", "all"), true);
  assert.equal(matchesOpportunityVenue(bybitCrossVenue, "all", "okx"), true);
});

test("venue options reflect the exchanges available on each leg", () => {
  const opportunities = [bybitSameVenue, bybitCrossVenue];
  assert.deepEqual([...opportunityLegVenues(opportunities, "long")], ["bybit"]);
  assert.deepEqual([...opportunityLegVenues(opportunities, "short")], ["bybit", "okx"]);
});

test("recommendation filter exposes every status without changing all-results behavior", () => {
  const watch = { ...bybitCrossVenue, recommendation: "watch" as const };
  assert.equal(matchesOpportunityRecommendation(watch, "all"), true);
  assert.equal(matchesOpportunityRecommendation(watch, "watch"), true);
  assert.equal(matchesOpportunityRecommendation(watch, "neutral"), false);
});

test("entry timing filter stays independent from long-term quality", () => {
  const waiting = {
    ...bybitCrossVenue,
    recommendation: "recommended" as const,
    entryStatus: "waiting" as const,
  };
  assert.equal(matchesOpportunityRecommendation(waiting, "recommended"), true);
  assert.equal(matchesOpportunityEntryStatus(waiting, "waiting"), true);
  assert.equal(matchesOpportunityEntryStatus(waiting, "favorable"), false);
});

function opportunity(
  id: string,
  longVenue: "bybit" | "okx",
  shortVenue: "bybit" | "okx",
  strategyType: ArbitrageOpportunity["strategyType"],
) {
  return {
    id,
    strategyType,
    longLeg: { venue: longVenue },
    shortLeg: { venue: shortVenue },
  } as ArbitrageOpportunity;
}
