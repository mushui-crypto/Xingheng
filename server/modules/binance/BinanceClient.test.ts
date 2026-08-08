import assert from "node:assert/strict";
import test from "node:test";
import { BinanceClient } from "./BinanceClient";
import type { BinanceOrderRequest } from "./BinanceTypes";

test("production orders remain IOC while test orders use GTC", async () => {
  const timeInForce: string[] = [];
  let orderId = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") {
      return Response.json({ serverTime: Date.now() });
    }
    assert.equal(init?.method, "POST");
    timeInForce.push(url.searchParams.get("timeInForce") ?? "");
    orderId += 1;
    return Response.json({ orderId, clientOrderId: url.searchParams.get("newClientOrderId") });
  }) as typeof fetch;
  const client = new BinanceClient({ apiKey: "test-key", apiSecret: "test-secret" }, fetchFn, Date.now, ["203.0.113.10"]);
  const request: BinanceOrderRequest = {
    category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.002,
    limitPrice: 4_000, reduceOnly: false, orderLinkId: "ptmtestorder",
  };

  await client.placeOrder(request);
  await client.placeTestOrder({ ...request, orderLinkId: "ptmtestgtc" });

  assert.deepEqual(timeInForce, ["IOC", "GTC"]);
});
