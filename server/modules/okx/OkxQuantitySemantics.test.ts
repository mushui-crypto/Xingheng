import assert from "node:assert/strict";
import test from "node:test";
import { OkxInstrumentMappingAdapter } from "./OkxInstrumentMapping";
import {
  loadOkxQuantityRules,
  okxBaseQuantityToContracts,
  okxContractQuantityToBase,
} from "./OkxQuantitySemantics";
import { okxTestQuantityRules, okxTestQuantityRulesSource } from "./OkxTestFixtures";

const now = 1_800_000_000_000;
const instrument = new OkxInstrumentMappingAdapter().resolve("DOGE-USDT-PERP");

test("converts base=100 to sz=10 and accFillSz=7 to filledBase=70 for ctVal=10", async () => {
  const rules = await loadOkxQuantityRules(okxTestQuantityRulesSource(now, { ctVal: "10" }), instrument, now);

  assert.equal(okxBaseQuantityToContracts("100", rules), "10");
  assert.equal(okxContractQuantityToBase("7", rules), "70");
  assert.equal(okxContractQuantityToBase("0", rules), "0");
});

test("supports a non-unit fractional ctVal exactly", () => {
  const rules = okxTestQuantityRules(now);

  assert.equal(okxBaseQuantityToContracts("73", rules), "730");
  assert.equal(okxContractQuantityToBase("730", rules), "73");
  assert.equal(
    okxContractQuantityToBase("12.5", okxTestQuantityRules(now, { lotSz: "0.1", minSz: "0.1" })),
    "1.25",
  );
});

test("preserves quantities beyond Number precision without floating-point arithmetic", () => {
  const rules = okxTestQuantityRules(now, { ctVal: "0.00000001", lotSz: "0.001", minSz: "0.001" });

  assert.equal(
    okxBaseQuantityToContracts("123456789012345.12345678", rules),
    "12345678901234512345678",
  );
  assert.equal(
    okxContractQuantityToBase("12345678901234512345678", rules),
    "123456789012345.12345678",
  );
});

test("rejects contract quantities that do not satisfy lotSz", () => {
  const rules = okxTestQuantityRules(now, { lotSz: "0.5", minSz: "0.5" });

  assert.throws(() => okxBaseQuantityToContracts("0.12", rules), /lotSz/u);
  assert.throws(() => okxContractQuantityToBase("1.25", rules), /lotSz/u);
});
