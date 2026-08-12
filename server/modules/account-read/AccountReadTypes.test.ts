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
