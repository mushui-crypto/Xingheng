import assert from "node:assert/strict";
import test from "node:test";
import { fetchNeutralAutomationStatus } from "./arbitrageAutomation";

test("neutral automation API uses the admin-only no-store endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedInput: RequestInfo | URL | undefined;
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedInput = input;
    requestedInit = init;
    return new Response(JSON.stringify({ phase: "phase_a_shadow" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  };
  try {
    const result = await fetchNeutralAutomationStatus();
    assert.equal(requestedInput, "/api/admin/arbitrage/neutral-automation");
    assert.equal(requestedInit?.cache, "no-store");
    assert.equal(requestedInit?.credentials, "include");
    assert.equal(result.phase, "phase_a_shadow");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
