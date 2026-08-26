import assert from "node:assert/strict";
import test from "node:test";
import { ProviderMutationSerializer } from "./ProviderMutationSerializer";

const base = {
  userId: "user-a",
  venue: "binance" as const,
  accountId: "account-a",
  canonicalInstrumentId: "BTC-USDT-PERP",
};

test("same account/instrument mutations serialize and the waiter reads state after ownership", async () => {
  const serializer = new ProviderMutationSerializer();
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let reality = "FLAT";
  const observations: string[] = [];

  const first = serializer.runExclusive(base, async () => {
    observations.push(reality);
    firstEntered();
    await hold;
    reality = "LONG";
  });
  await entered;
  const second = serializer.runExclusive(base, async () => { observations.push(reality); });
  await Promise.resolve();
  assert.deepEqual(observations, ["FLAT"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(observations, ["FLAT", "LONG"]);
});

test("different accounts and different instruments do not block each other", async () => {
  const serializer = new ProviderMutationSerializer();
  await assertIndependent(serializer, base, { ...base, accountId: "account-b" });
  await assertIndependent(serializer, base, { ...base, canonicalInstrumentId: "ETH-USDT-PERP" });
});

async function assertIndependent(
  serializer: ProviderMutationSerializer,
  first: typeof base,
  second: typeof base,
) {
  let entered = 0;
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => { release = resolve; });
  const operation = async () => {
    entered += 1;
    if (entered === 2) release();
    await bothEntered;
  };
  await Promise.all([serializer.runExclusive(first, operation), serializer.runExclusive(second, operation)]);
  assert.equal(entered, 2);
}

test("multi-key second-leg ownership uses deterministic ordering without deadlock", async () => {
  const serializer = new ProviderMutationSerializer();
  const first = { ...base, canonicalInstrumentId: "BTC-USDT-SPOT" };
  const second = { ...base, canonicalInstrumentId: "BTC-USDT-PERP" };
  const order: string[] = [];
  await Promise.all([
    serializer.runExclusiveMany([first, second], async () => {
      order.push("hedge-start");
      await Promise.resolve();
      order.push("hedge-end");
    }),
    serializer.runExclusiveMany([second, first], async () => { order.push("competing-mutation"); }),
  ]);
  assert.deepEqual(order, ["hedge-start", "hedge-end", "competing-mutation"]);
});
