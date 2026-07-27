import assert from "node:assert/strict";
import test from "node:test";
import {
  connectivitySmokeStepUpRequest,
  createConnectivitySmokeClient,
} from "./arbitrageAutomationConsole";
import type {
  ConnectivitySmokePolicy,
  ConnectivitySmokePreflight,
} from "../features/arbitrageAutomation/model/connectivitySmokeTypes";

const policy: ConnectivitySmokePolicy = {
  mode: "connectivity_smoke",
  venue: "binance",
  accountId: "binance:test-account",
  executionAuthorized: false,
  message: "server authorization warning",
  policy: {
    version: "server-policy-v9",
    digest: "server-policy-digest",
    maxPlannedCapitalUsd: 25,
    dedicatedBlankSubaccount: true,
    singleExecution: true,
    immediateExit: true,
    challengeTtlMs: 60_000,
    continuity: "non_atomic_incomplete",
    requiredConfirmations: ["exclusive_window", "manual_recovery", "non_atomic_risk"],
    exclusiveWindowRules: [{ code: "exclusive", message: "server exclusive" }],
    manualRecoveryRequirements: [{ code: "manual", message: "server manual" }],
    residualRisks: [{ code: "risk", message: "server risk" }],
  },
};

const report = {
  purpose: "connectivity_smoke" as const,
  mode: "connectivity_smoke" as const,
  venue: "binance" as const,
  network: "binance_mainnet" as const,
  accountId: policy.accountId,
  accountFingerprint: "fingerprint",
  symbol: "XAUTUSDT" as const,
  policy: {
    version: policy.policy.version,
    digest: policy.policy.digest,
    accepted: true as const,
    continuity: "nonAtomic/incomplete" as const,
  },
  budget: {
    limitUsd: 25, quantityXaut: 0.01, commonQtyStep: 0.001, slippageBpsPerAction: 10,
    prices: { spotOpenLimit: 1, futuresOpenLimit: 1, futuresCloseLimit: 1, spotCloseLimit: 1 },
    spotNotionalUsd: 10, futuresMarginUsd: 10, spotFeesUsd: 1, futuresFeesUsd: 1,
    spotSlippageReserveUsd: 1, futuresSlippageReserveUsd: 1, roundingReserveUsd: 1,
    totalCapitalUsd: 25,
  },
  checks: [{ name: "server-check", passed: true, message: "server passed" }],
  passed: true,
  generatedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_060_000,
};

test("policy discovery is the only source for the exact preflight acceptance payload", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(input).includes("/policy?")) return jsonResponse(policy);
    return jsonResponse({ challengeId: "challenge-1", challengeToken: "memory-only", expiresAt: report.expiresAt, report });
  }) as typeof fetch;
  try {
    const client = createConnectivitySmokeClient();
    const discovered = await client.policy(policy.accountId);
    const preflight = await client.preflight(policy.accountId, discovered, {
      exclusiveWindowConfirmed: true,
      manualRecoveryConfirmed: true,
      nonAtomicRiskAccepted: true,
    });
    assert.equal(preflight.report.policy.version, "server-policy-v9");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]?.body, {
      accountId: policy.accountId,
      mode: "connectivity_smoke",
      policyAcceptance: {
        version: "server-policy-v9",
        digest: "server-policy-digest",
        exclusiveWindowConfirmed: true,
        manualRecoveryConfirmed: true,
        nonAtomicRiskAccepted: true,
      },
    });
    for (const forbidden of ["symbol", "side", "quantity", "price", "budget"]) {
      assert.equal(forbidden in (requests[1]!.body as Record<string, unknown>), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("step-up intent binds the exact stable execute request and excludes the TOTP token", async () => {
  const preflight: ConnectivitySmokePreflight = {
    challengeId: "challenge-1",
    challengeToken: "memory-only",
    expiresAt: report.expiresAt,
    idempotencyKey: "stable-idempotency-key",
    report,
  };
  const first = await connectivitySmokeStepUpRequest(preflight);
  const second = await connectivitySmokeStepUpRequest(preflight);
  assert.deepEqual(first.request, second.request);
  assert.equal(first.intent.operation, "connectivity_smoke_execute");
  assert.equal(first.intent.resourceId, "challenge-1");
  assert.equal("stepUpToken" in first.request, false);
  assert.equal("totp" in first.request, false);
});

test("lost execute response uses exact lookup and never reads account-latest or replays execute", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (requests.length === 1) throw new TypeError("connection lost");
    return jsonResponse(null);
  }) as typeof fetch;
  try {
    const client = createConnectivitySmokeClient();
    const result = await client.execute({
      accountId: policy.accountId,
      challengeId: "challenge-1",
      challengeToken: "memory-only",
      idempotencyKey: "stable-idempotency-key",
      policyVersion: policy.policy.version,
      policyDigest: policy.policy.digest,
    }, "memory-step-up-token");
    assert.equal(result, null);
    assert.equal(requests.filter(({ path }) => path.endsWith("/connectivity-smoke/execute")).length, 1);
    assert.equal(requests.filter(({ path }) => path.endsWith("/connectivity-smoke/lookup")).length, 1);
    assert.equal(requests.some(({ path }) => path.includes("/connectivity-smoke/status?")), false);
    assert.deepEqual(requests[1]?.body, {
      accountId: policy.accountId,
      challengeId: "challenge-1",
      idempotencyKey: "stable-idempotency-key",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact lookup null remains R2 unknown even when account-latest R1 could exist", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return jsonResponse(null);
  }) as typeof fetch;
  try {
    const client = createConnectivitySmokeClient();
    const result = await client.lookup({
      accountId: policy.accountId,
      challengeId: "challenge-r2",
      idempotencyKey: "idempotency-r2",
    });
    assert.equal(result, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.path.endsWith("/connectivity-smoke/lookup"), true);
    assert.deepEqual(requests[0]?.body, {
      accountId: policy.accountId,
      challengeId: "challenge-r2",
      idempotencyKey: "idempotency-r2",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
