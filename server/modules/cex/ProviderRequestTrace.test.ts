import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markPerpCloseSafetyPass, endPerpCloseTraceAttempt, summarizeProviderTraces, tracedProviderFetch, tracedProviderJson,
  withProviderCommandTrace, withProviderReconcileAttempt, type ProviderCommandTrace,
} from "./ProviderRequestTrace";
import { ArbitrageInstanceStore } from "./arbitrage-instance/ArbitrageInstanceStore";
import { BitgetClient } from "../bitget/BitgetClient";
import { OkxClient } from "../okx/OkxClient";
import { BybitClient } from "../bybit/BybitClient";
import { BinanceClient } from "../binance/BinanceClient";

const binding = { venue: "bitget", accountId: "bitget:account" };
const command = { userId: "user-a", instanceId: "instance-a", commandId: "command-a", phase: "EXIT", bindings: [binding] };
const fakeFetch = (() => Promise.resolve(Response.json({ code: "00000", data: [] }))) as typeof fetch;
const request = (transport: typeof fetch, endpoint: string, method = "GET", clientOid = "order-a") =>
  transport(`https://api.bitget.com${endpoint}?signature=NEVER_PERSIST_QUERY`, {
    method, headers: { Authorization: "NEVER_PERSIST_HEADER" },
    ...(method === "GET" ? {} : { body: JSON.stringify({ clientOid, category: "USDT-FUTURES",
      symbol: "DOGEUSDT", side: "buy", posSide: "short", secret: "NEVER_PERSIST_BODY" }) }),
  }).then(tracedProviderJson);

async function capture(run: () => Promise<unknown>, input = command) {
  const traces: ProviderCommandTrace[] = [];
  await withProviderCommandTrace(input, t => traces.push(t), run);
  await tick();
  return traces;
}

test("counts each actual GET/place/cancel/amend; bounded sanitized SQLite trace joins command without changing outcome", async () => {
  const transport = tracedProviderFetch("bitget", fakeFetch);
  const traces = await capture(async () => {
    await request(transport, "/api/v3/account/assets");
    await request(transport, "/api/v3/trade/place-order", "POST");
    await request(transport, "/api/v3/trade/cancel-order", "POST");
    await request(transport, "/api/v3/trade/modify-order", "POST");
  });
  const summary = summarizeProviderTraces(traces);
  assert.deepEqual([summary.PROVIDER_GET_COUNT, summary.PLACE_ORDER_COUNT, summary.CANCEL_COUNT, summary.AMEND_COUNT], [1, 1, 1, 1]);
  assert.equal(summary.EVIDENCE_COMPLETE, true);
  assert.equal(traces[0]!.requests[0]!.providerCode, "00000");
  assert.equal(traces[0]!.requests[0]!.mutationDisposition, "NOT_DISPATCHED");
  assert.equal(traces[0]!.requests[1]!.mutationDisposition, "DISPATCHED_OR_POSSIBLE");
  assert.doesNotMatch(JSON.stringify(traces), /NEVER_PERSIST|signature|Authorization|secret|rawBody/);
  const dir = mkdtempSync(join(tmpdir(), "provider-trace-"));
  const store = new ArbitrageInstanceStore({ dbPath: join(dir, "test.sqlite") });
  try {
    store.recordProviderTrace(traces[0]!);
    store.recordProviderTrace(traces[0]!);
    assert.equal(store.readProviderTraces("user-a", "instance-a", "command-a").traces.length, 1);
    assert.equal(store.readProviderTraces("other", "instance-a").traces.length, 0);
    store.recordProviderTrace({ ...traces[0]!, traceId: "expired", startedAt: 0 });
    assert.equal(store.readProviderTraces("user-a", "instance-a").traces.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  const overflow = await capture(async () => {
    for (let i = 0; i < 513; i++) await request(transport, "/api/v3/account/assets");
  });
  assert.equal(overflow[0]!.requests.length, 512);
  assert.equal(overflow[0]!.droppedRequests, 1);
  assert.equal(summarizeProviderTraces(overflow).EVIDENCE_COMPLETE, false);
  assert.equal(summarizeProviderTraces([]).EVIDENCE_COMPLETE, false);
});

test("post-safety interval counts zero/nonzero and excludes pre-safety/terminal reconcile reads", async () => {
  const transport = tracedProviderFetch("bitget", fakeFetch);
  for (const extra of [0, 1]) {
    const traces = await capture(async () => {
      await request(transport, "/api/v3/account/settings");
      markPerpCloseSafetyPass({ ...binding, executionIntentId: "close-a" });
      if (extra) await request(transport, "/api/v3/market/instruments");
      await request(transport, "/api/v3/trade/place-order", "POST");
      await withProviderReconcileAttempt(2, () => request(transport, "/api/v3/trade/order-info"));
    });
    const window = traces[0]!.postSafety[0]!;
    assert.equal(window.getCount, extra);
    assert.deepEqual(window.getEndpoints, extra ? ["bitget:/api/v3/market/instruments"] : []);
    assert.ok(window.placeOrderDispatchAt! >= window.safetyPassedAt);
    assert.equal(traces[0]!.requests.at(-1)!.reconcileAttempt, 2);
  }
  const acrossVenues = await capture(async () => {
    markPerpCloseSafetyPass({ ...binding, executionIntentId: "local-failed" });
    await request(tracedProviderFetch("bybit", fakeFetch), "/v5/market/instruments-info");
    endPerpCloseTraceAttempt(binding);
    await request(transport, "/api/v3/account/assets");
    markPerpCloseSafetyPass({ ...binding, executionIntentId: "fresh-attempt" });
    await request(transport, "/api/v3/trade/place-order", "POST");
  });
  assert.deepEqual(acrossVenues[0]!.postSafety.map(w => w.getCount), [1, 0]);
  assert.deepEqual(acrossVenues[0]!.postSafety[0]!.getEndpoints, ["bybit:/v5/market/instruments-info"]);
  assert.equal(acrossVenues[0]!.postSafety[0]!.placeOrderDispatchAt, null);
});

test("two concurrent venue commands cannot contaminate ownership; unexpected venue mutation is visible", async () => {
  const bitget = tracedProviderFetch("bitget", fakeFetch);
  const bybit = tracedProviderFetch("bybit", fakeFetch);
  const [a, b] = await Promise.all([
    capture(async () => { await tick(); await request(bitget, "/api/v3/trade/place-order", "POST"); }),
    capture(async () => { await request(bybit, "/v5/order/create", "POST"); await tick(); },
      { ...command, instanceId: "instance-b", commandId: "command-b", bindings: [{ venue: "bybit", accountId: "bybit:account" }] }),
  ]);
  assert.equal(a[0]!.requests[0]!.accountId, "bitget:account");
  assert.equal(b[0]!.requests[0]!.accountId, "bybit:account");
  assert.equal(a[0]!.requests[0]!.commandId, "command-a");
  assert.equal(b[0]!.requests[0]!.commandId, "command-b");
  const unexpected = await capture(() => request(bybit, "/v5/order/create", "POST"));
  assert.equal(summarizeProviderTraces(unexpected).UNEXPECTED_VENUE_MUTATION_COUNT, 1);
  assert.equal(unexpected[0]!.requests[0]!.accountId, null);
});

test("same-instance repeat identity/target dispatch is detected across independent commands, never treated as fill evidence", async () => {
  const transport = tracedProviderFetch("bitget", fakeFetch);
  const first = await capture(() => request(transport, "/api/v3/trade/place-order", "POST"));
  const second = await capture(() => request(transport, "/api/v3/trade/place-order", "POST"), { ...command, commandId: "command-b" });
  const third = await capture(() => request(transport, "/api/v3/trade/place-order", "POST", "different-id"), { ...command, commandId: "command-c" });
  const summary = summarizeProviderTraces([...first, ...second, ...third]);
  assert.equal(summary.PLACE_ORDER_COUNT, 3);
  assert.equal(summary.REPEATED_ORDER_IDENTITY_DISPATCH_COUNT, 1);
  assert.equal(summary.REPEATED_INSTANCE_MUTATION_TARGETS[0]!.dispatchCount, 3);
});

test("sync/async instrumentation storage failures preserve command result, transport failures and dispatch callback ordering", async () => {
  for (const persist of [() => { throw new Error("secret"); }, () => Promise.reject(new Error("secret"))]) {
    let dispatches = 0;
    const transport = tracedProviderFetch("binance", (() => { dispatches++; return Promise.resolve(Response.json({ code: 0 })); }) as typeof fetch);
    const result = await withProviderCommandTrace(command, persist, async () => {
      const pending = transport("https://api.binance.com/api/v3/order", { method: "POST" });
      assert.equal(dispatches, 1);
      await pending;
      return "CONFIRMED";
    });
    assert.equal(result, "CONFIRMED");
    await tick();
  }
  const original = new Error("transport failure");
  const failing = tracedProviderFetch("bitget", (() => { throw original; }) as typeof fetch);
  await assert.rejects(withProviderCommandTrace(command, () => {}, async () => failing("https://api.bitget.com/api/v3/trade/place-order", { method: "POST" })), e => e === original);
});

test("all four actual clients keep signed request payload and ACK semantics with tracing enabled", async () => {
  const credentials = { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-pass" };
  const now = 1_800_000_000_000;
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: now });
    if (url.pathname === "/api/v3/order") return Response.json({ symbol: "DOGEUSDT", orderId: "100", clientOrderId: body.newClientOrderId });
    if (url.pathname === "/api/v5/trade/order") return Response.json({ code: "0", data: [{ ordId: "101", clOrdId: body.clOrdId, sCode: "0" }] });
    if (url.pathname === "/v5/order/create") return Response.json({ retCode: 0, result: { orderId: "102", orderLinkId: body.orderLinkId } });
    if (url.pathname === "/api/v3/trade/place-order") return Response.json({ code: "00000", data: { orderId: "103", clientOid: body.clientOid } });
    throw new Error("Unexpected request");
  }) as typeof fetch;
  const traces = await capture(async () => {
    await new BinanceClient(credentials, transport, () => now, ["203.0.113.10"]).placeOrder({
      category: "spot", symbol: "DOGEUSDT", side: "Buy", quantity: "95", limitPrice: "0.1", reduceOnly: false, orderLinkId: "bn1" });
    await new OkxClient(() => credentials, { fetchImpl: transport, now: () => now }).placeOrder({
      instId: "DOGE-USDT-SWAP", tdMode: "cross", side: "buy", ordType: "market", quantity: "0.095", clOrdId: "ok1", reduceOnly: true });
    await new BybitClient(() => credentials, { fetchImpl: transport, now: () => now }).placeOrder({
      category: "linear", symbol: "DOGEUSDT", side: "Buy", orderType: "Market", qty: "95", orderLinkId: "by1", reduceOnly: true, positionIdx: 0 });
    await new BitgetClient(() => credentials, { fetchImpl: transport, now: () => now }).placeOrder({
      category: "USDT-FUTURES", symbol: "DOGEUSDT", side: "buy", orderType: "market", qty: "95", clientOid: "bg1", posSide: "short" });
  }, { ...command, bindings: ["binance", "okx", "bybit", "bitget"].map(venue => ({ venue, accountId: venue + ":account" })) });
  assert.equal(summarizeProviderTraces(traces).PLACE_ORDER_COUNT, 4);
  assert.equal(summarizeProviderTraces(traces).PROVIDER_GET_COUNT, 1);
  assert.equal(calls[1]!.body.quantity, "95");
  assert.equal(calls[1]!.body.timeInForce, "IOC");
  assert.equal(calls[2]!.body.sz, "0.095");
  assert.equal(calls[3]!.body.positionIdx, 0);
  assert.equal(calls[4]!.body.posSide, "short");
  assert.equal(calls[4]!.body.reduceOnly, undefined);
});
