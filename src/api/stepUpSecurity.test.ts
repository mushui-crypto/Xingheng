import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  StepUpSecurityContractError,
  canonicalJson,
  canonicalRequestDigest,
  createStepUpIntent,
  createStepUpSecurityClient,
  presentStepUpError,
} from "./stepUpSecurity";

test("canonical JSON recursively sorts object keys, preserves arrays and produces SHA-256 base64url", async () => {
  const value = {
    z: 1,
    nested: { b: true, a: "x" },
    array: [{ d: 4, c: 3 }, null, false],
  };
  const canonical = '{"array":[{"c":3,"d":4},null,false],"nested":{"a":"x","b":true},"z":1}';
  assert.equal(canonicalJson(value), canonical);
  const expected = createHash("sha256").update(canonical).digest("base64url");
  const digest = await canonicalRequestDigest(value);
  assert.equal(digest, expected);
  assert.match(digest, /^[A-Za-z0-9_-]{43}$/u);
  await assert.rejects(() => canonicalRequestDigest({ value: Number.NaN }), TypeError);
});

test("step-up intent contains only scoped metadata and a digest, never the sensitive request", async () => {
  const secret = "fixture-sensitive-secret";
  const intent = await createStepUpIntent({
    operation: "credential_put",
    venue: "binance",
    accountId: "new-account",
    resourceId: null,
    requestBody: { apiKey: "fixture-key", apiSecret: secret },
  });
  assert.deepEqual(Object.keys(intent).sort(), [
    "accountId",
    "operation",
    "requestDigest",
    "resourceId",
    "venue",
  ]);
  assert.equal(JSON.stringify(intent).includes(secret), false);
  assert.equal(intent.requestDigest.length, 43);
});

test("security client sends strict session-scoped bodies without query secrets or persistence", async () => {
  const calls: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const secretValues = [
    "fixture-current-password",
    "123456",
    "fixture-recovery-code",
    "fixture-enrollment-id",
    "fixture-authorization-token",
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/status")) {
      return jsonResponse({ enrolled: false, pendingEnrollment: false, method: null, recoveryCodesRemaining: 0, enabledAt: null });
    }
    if (url.endsWith("/enrollment/begin")) {
      return jsonResponse({
        enrollmentId: "fixture-enrollment-id",
        otpauthUri: "otpauth://totp/Stella%20X:fixture?secret=FIXTURESECRET&issuer=Stella%20X",
        expiresAt: Date.now() + 600_000,
      });
    }
    if (url.endsWith("/enrollment/confirm") || url.endsWith("/recovery-codes/regenerate")) {
      return jsonResponse({
        ok: true,
        recoveryCodes: Array.from({ length: 8 }, (_, index) => `RECOVERY-${index + 1}`),
      });
    }
    if (url.endsWith("/authorize")) {
      return jsonResponse({ authorizationToken: "fixture-authorization-token", expiresAt: Date.now() + 120_000 });
    }
    return jsonResponse({ ok: true });
  };

  try {
    const client = createStepUpSecurityClient();
    await client.status();
    await client.beginEnrollment({ currentPassword: "fixture-current-password" });
    await client.confirmEnrollment({ enrollmentId: "fixture-enrollment-id", code: "123456" });
    await client.authorize({
      code: "123456",
      intent: {
        operation: "close_all",
        venue: "binance",
        accountId: "binance:fixture",
        resourceId: null,
        requestDigest: "A".repeat(43),
      },
    });
    await client.regenerateRecoveryCodes({
      currentPassword: "fixture-current-password",
      factor: { method: "recovery_code", code: "fixture-recovery-code" },
    });
    await client.disable({
      currentPassword: "fixture-current-password",
      factor: { method: "totp", code: "123456" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    "GET /api/auth/security/step-up/status",
    "POST /api/auth/security/step-up/enrollment/begin",
    "POST /api/auth/security/step-up/enrollment/confirm",
    "POST /api/auth/security/step-up/authorize",
    "POST /api/auth/security/step-up/recovery-codes/regenerate",
    "POST /api/auth/security/step-up/disable",
  ]);
  assert.deepEqual(calls[1]?.body, { currentPassword: "fixture-current-password" });
  assert.deepEqual(calls[2]?.body, { enrollmentId: "fixture-enrollment-id", code: "123456" });
  assert.deepEqual(Object.keys(calls[3]?.body ?? {}).sort(), ["code", "intent"]);
  assert.deepEqual(calls[4]?.body, {
    currentPassword: "fixture-current-password",
    factor: { method: "recovery_code", code: "fixture-recovery-code" },
  });
  for (const call of calls) {
    assert.equal(call.url.includes("?"), false);
    assert.equal(JSON.stringify(call.body ?? {}).includes("userId"), false);
    for (const sensitive of secretValues) {
      assert.equal(call.url.includes(sensitive), false);
    }
  }
});

test("step-up errors remain category-specific and never expose unrelated raw failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(
    { category: "step_up_rate_limited", message: "too many", private: "must-not-leak" },
    429,
    { "Retry-After": "17" },
  );
  try {
    await assert.rejects(
      () => createStepUpSecurityClient().authorize({
        code: "000000",
        intent: {
          operation: "close_all",
          venue: "binance",
          accountId: "binance:fixture",
          resourceId: null,
          requestDigest: "A".repeat(43),
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof StepUpSecurityContractError);
        assert.equal(error.category, "step_up_rate_limited");
        assert.equal(error.retryAfterSeconds, 17);
        assert.match(presentStepUpError(error), /17 秒/);
        assert.doesNotMatch(presentStepUpError(error), /must-not-leak/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("step-up business 403 remains in the security flow instead of expiring the user session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(
    { category: "step_up_not_enrolled", message: "请先设置身份验证器。" },
    403,
  );
  try {
    await assert.rejects(
      () => createStepUpSecurityClient().authorize({
        code: "000000",
        intent: {
          operation: "close_all",
          venue: "binance",
          accountId: "binance:fixture",
          resourceId: null,
          requestDigest: "A".repeat(43),
        },
      }),
      (error: unknown) => error instanceof StepUpSecurityContractError
        && error.category === "step_up_not_enrolled",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed security responses fail closed without preserving unknown sensitive fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    authorizationToken: "fixture-token",
    expiresAt: "not-a-number",
    rawSecret: "must-not-leak",
  });
  try {
    await assert.rejects(
      () => createStepUpSecurityClient().authorize({
        code: "123456",
        intent: {
          operation: "close_all",
          venue: "binance",
          accountId: "binance:fixture",
          resourceId: null,
          requestDigest: "A".repeat(43),
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof StepUpSecurityContractError);
        assert.equal(error.category, "step_up_invalid_response");
        assert.doesNotMatch(error.message, /must-not-leak|fixture-token/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type CapturedRequest = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
