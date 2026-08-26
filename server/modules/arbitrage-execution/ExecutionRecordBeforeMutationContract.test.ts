import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionIntent, ExecutionVenue } from "../cex/ExecutionIntent";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import { OkxIntentExecutionRuntime } from "../okx/OkxIntentExecutionRuntime";
import { BybitIntentExecutionRuntime } from "../bybit/BybitIntentExecutionRuntime";
import { BitgetIntentExecutionRuntime } from "../bitget/BitgetIntentExecutionRuntime";

for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
  test(`${venue} persists ExecutionRecord before opening or closing Provider mutation`, async (t) => {
    for (const operation of ["opening", "closing"] as const) {
      await t.test(operation, async () => {
        let providerMutations = 0;
        const service = new Proxy({
          executionAccountIdentity: () => ({ accountId: `${venue}:account-a` }),
        }, {
          get(target, property, receiver) {
            if (property === "placeOrder" || property === "cancelOrder") {
              return async () => { providerMutations += 1; throw new Error("Provider mutation reached"); };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const records: ExecutionRecordStore = {
          create: () => { throw new Error("durable record create failed"); },
          update: () => { throw new Error("unexpected update"); },
          loadForUser: () => null,
        };
        const registry = { run: async (_userId: string, callback: (value: never) => unknown) => callback(service as never) };
        const runtime = createRuntime(venue, registry as never, records);

        await assert.rejects(
          () => runtime.execute(intent(venue, operation === "closing")),
          /durable record create failed/u,
        );
        assert.equal(providerMutations, 0);
      });
    }
  });
}

function createRuntime(
  venue: ExecutionVenue,
  registry: never,
  records: ExecutionRecordStore,
): { execute(intent: ExecutionIntent): Promise<unknown> } {
  if (venue === "binance") {
    return new BinanceIntentExecutionRuntime(registry, { maxSlippageBps: 50 }, records);
  }
  if (venue === "okx") return new OkxIntentExecutionRuntime(registry, records, {} as never);
  if (venue === "bybit") return new BybitIntentExecutionRuntime(registry, records, {} as never);
  return new BitgetIntentExecutionRuntime(registry, records, {} as never);
}

function intent(venue: ExecutionVenue, closing: boolean): ExecutionIntent {
  return {
    intentId: `${venue}-${closing ? "close" : "open"}`,
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    userId: "user-a",
    venue,
    accountId: `${venue}:account-a`,
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
    side: closing ? "sell" : "buy",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "100" },
    orderConstraints: { reduceOnly: closing },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_030_000,
  };
}
