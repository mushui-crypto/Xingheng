import type { OkxQuantityRulesSnapshot, OkxQuantityRulesSource } from "./OkxQuantitySemantics";

export function okxTestQuantityRules(
  fetchedAt: number,
  overrides: Partial<OkxQuantityRulesSnapshot> = {},
): OkxQuantityRulesSnapshot {
  return Object.freeze({
    instType: "SWAP",
    instId: "DOGE-USDT-SWAP",
    uly: "DOGE-USDT",
    ctType: "linear",
    ctValCcy: "DOGE",
    settleCcy: "USDT",
    lotSz: "1",
    minSz: "1",
    ctVal: "0.1",
    state: "live",
    fetchedAt,
    ...overrides,
  });
}

export function okxTestQuantityRulesSource(
  fetchedAt: number,
  overrides: Partial<OkxQuantityRulesSnapshot> = {},
): OkxQuantityRulesSource {
  const rules = okxTestQuantityRules(fetchedAt, overrides);
  return () => rules;
}
