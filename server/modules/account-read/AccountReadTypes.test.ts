import assert from "node:assert/strict";
import test from "node:test";
import type { AccountReadAccountType, VenueAccountReadBalance } from "./AccountReadTypes";

test("public account type supports spot, derivatives, unified, and unknown", () => {
  const accountTypes: AccountReadAccountType[] = ["spot", "derivatives", "unified", "unknown"];
  const balances: VenueAccountReadBalance[] = accountTypes.map((accountType) => ({
    asset: "USDT",
    accountType,
    total: 1,
    available: 1,
    locked: 0,
  }));

  assert.deepEqual(balances.map((balance) => balance.accountType), accountTypes);
});

test("public account balance permits unavailable while retaining numeric venue values", () => {
  const balances: VenueAccountReadBalance[] = [
    { asset: "BTC", accountType: "unified", total: 1, available: null, locked: 0.1 },
    { asset: "USDT", accountType: "spot", total: 1, available: 0.8, locked: 0.2 },
  ];

  assert.equal(balances[0]?.available, null);
  assert.equal(typeof balances[1]?.available, "number");
});
