import assert from "node:assert/strict";
import test from "node:test";
import { calculateEquivalentApy, formatFundingCountdown, formatFundingRate } from "./formatters";

test("90-day APY compounds the equivalent net APR over repeated holding periods", () => {
  const netApr = 8;
  const apy = calculateEquivalentApy(netApr, 90);

  assert.ok(apy !== null && apy > netApr);
});

test("365-day APY equals APR when the holding period compounds once per year", () => {
  const netApr = 8;
  const apy = calculateEquivalentApy(netApr, 365);

  assert.ok(apy !== null && Math.abs(apy - netApr) < 1e-10);
});

test("funding rate preserves the exchange interval value as a percentage", () => {
  assert.equal(formatFundingRate(0.000123), "+0.0123%");
  assert.equal(formatFundingRate(-0.00005), "-0.0050%");
});

test("funding countdown renders a stable clock and handles settlement rollover", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatFundingCountdown(now + ((2 * 60 + 3) * 60 + 4) * 1000, now), "距结算 02:03:04");
  assert.equal(formatFundingCountdown(now - 1, now), "等待结算更新");
  assert.equal(formatFundingCountdown(null, now), "结算时间待更新");
});
