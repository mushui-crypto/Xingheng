import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeCredentialKeyProvider } from "../arbitrage/automation/FakeCredentialKeyProvider";
import type { StepUpIntent } from "./StepUpSecurityService";
import { StepUpSecurityError, StepUpSecurityService } from "./StepUpSecurityService";
import { StepUpSecurityStore, StepUpSecurityStoreError } from "./StepUpSecurityStore";
import { totpCode } from "./Totp";

const baseNow = 1_800_000_000_000;

test("RFC 6238 enrollment encrypts the secret and returns recovery codes only once", async () => {
  const fixture = await createFixture();
  try {
    const status = await fixture.service.status("user-a");
    assert.deepEqual(status, {
      enrolled: false,
      pendingEnrollment: false,
      method: null,
      recoveryCodesRemaining: 0,
      enabledAt: null,
    });

    const enrollment = await fixture.service.beginEnrollment("user-a", "session-a", { currentPassword: "correct-password" });
    const secret = secretFromUri(enrollment.otpauthUri);
    const confirmed = await fixture.service.confirmEnrollment("user-a", "session-a", {
      enrollmentId: enrollment.enrollmentId,
      code: totpCode(secret, Math.floor(fixture.now() / 30_000)),
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.recoveryCodes.length, 8);
    assert.equal(new Set(confirmed.recoveryCodes).size, 8);

    const raw = await readFile(fixture.pathFor("user-a"), "utf8");
    assert.doesNotMatch(raw, new RegExp(secret));
    for (const code of confirmed.recoveryCodes) assert.doesNotMatch(raw, new RegExp(code));
    assert.doesNotMatch(JSON.stringify(await fixture.service.status("user-a")), /otpauth|recoveryCodes"/);
  } finally {
    await fixture.cleanup();
  }
});

test("authorization is one-time and bound to user, session, venue, account, operation, resource, digest, and notional", async () => {
  const fixture = await createFixture();
  try {
    await enroll(fixture, "user-a");
    fixture.advance(30_000);
    const intent = makeIntent();
    const grant = await fixture.service.authorize(
      "user-a",
      "session-a",
      totpCode(fixture.secret("user-a"), Math.floor(fixture.now() / 30_000)),
      intent,
    );

    const mismatches: Array<[string, string, StepUpIntent]> = [
      ["user-b", "session-a", intent],
      ["user-a", "session-b", intent],
      ["user-a", "session-a", { ...intent, venue: "binance" }],
      ["user-a", "session-a", { ...intent, accountId: "bybit:other" }],
      ["user-a", "session-a", { ...intent, operation: "close_all" }],
      ["user-a", "session-a", { ...intent, resourceId: "challenge-b" }],
      ["user-a", "session-a", { ...intent, requestDigest: "b".repeat(43) }],
      ["user-a", "session-a", { ...intent, notionalUsd: 26 }],
    ];
    for (const [userId, sessionDomain, mismatch] of mismatches) {
      await assert.rejects(
        fixture.service.consume(userId, sessionDomain, grant.authorizationToken, mismatch),
        hasCategory("step_up_scope_mismatch"),
      );
    }

    const [first, second] = await Promise.allSettled([
      fixture.service.consume("user-a", "session-a", grant.authorizationToken, intent),
      fixture.service.consume("user-a", "session-a", grant.authorizationToken, intent),
    ]);
    assert.equal([first, second].filter((item) => item.status === "fulfilled").length, 1);
    const rejected = [first, second].find((item) => item.status === "rejected") as PromiseRejectedResult;
    assert.ok(hasCategory("step_up_replayed")(rejected.reason));
  } finally {
    await fixture.cleanup();
  }
});

test("TOTP counters, authorization expiry, restart, logout, and password reset revoke grants fail closed", async () => {
  const fixture = await createFixture();
  try {
    await enroll(fixture, "user-a");
    fixture.advance(30_000);
    const code = totpCode(fixture.secret("user-a"), Math.floor(fixture.now() / 30_000));
    const first = await fixture.service.authorize("user-a", "session-a", code, makeIntent());
    await assert.rejects(
      fixture.service.authorize("user-a", "session-a", code, makeIntent()),
      hasCategory("step_up_replayed"),
    );

    fixture.service.revokeSession("user-a", "session-a");
    await assert.rejects(fixture.service.consume("user-a", "session-a", first.authorizationToken, makeIntent()), hasCategory("step_up_replayed"));

    fixture.advance(30_000);
    const expiring = await fixture.service.authorize(
      "user-a", "session-a", totpCode(fixture.secret("user-a"), Math.floor(fixture.now() / 30_000)), makeIntent(),
    );
    fixture.advance(120_001);
    await assert.rejects(fixture.service.consume("user-a", "session-a", expiring.authorizationToken, makeIntent()), hasCategory("step_up_expired"));

    fixture.advance(30_000);
    const beforeRestart = await fixture.service.authorize(
      "user-a", "session-a", totpCode(fixture.secret("user-a"), Math.floor(fixture.now() / 30_000)), makeIntent(),
    );
    const restarted = fixture.restart();
    await assert.rejects(restarted.consume("user-a", "session-a", beforeRestart.authorizationToken, makeIntent()), hasCategory("step_up_required"));

    fixture.advance(30_000);
    const beforeReset = await restarted.authorize(
      "user-a", "session-a", totpCode(fixture.secret("user-a"), Math.floor(fixture.now() / 30_000)), makeIntent(),
    );
    await restarted.revokeAfterPasswordReset("user-a");
    await assert.rejects(restarted.consume("user-a", "session-a", beforeReset.authorizationToken, makeIntent()), hasCategory("step_up_replayed"));
    assert.equal((await restarted.status("user-a")).enrolled, true, "password reset preserves enabled TOTP");
  } finally {
    await fixture.cleanup();
  }
});

test("pending enrollment is durably invalidated by password reset or disabled-user epoch", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.beginEnrollment("user-a", "session-a", { currentPassword: "correct-password" });
    const secret = secretFromUri(pending.otpauthUri);
    fixture.invalidate("user-a", fixture.now());
    await fixture.service.revokeAfterPasswordReset("user-a");
    await assert.rejects(
      fixture.service.confirmEnrollment("user-a", "session-a", {
        enrollmentId: pending.enrollmentId,
        code: totpCode(secret, Math.floor(fixture.now() / 30_000)),
      }),
      hasCategory("step_up_expired"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("recovery codes are strongly hashed, consumed once, and lifecycle actions require the current password", async () => {
  const fixture = await createFixture();
  try {
    const enrollment = await enroll(fixture, "user-a");
    const recoveryCode = enrollment.recoveryCodes[0]!;
    const regenerated = await fixture.service.regenerateRecoveryCodes("user-a", "session-a", {
      currentPassword: "correct-password",
      factor: { method: "recovery_code", code: recoveryCode },
    });
    await assert.rejects(
      fixture.service.disable("user-a", "session-a", {
        currentPassword: "wrong-password",
        factor: { method: "recovery_code", code: regenerated.recoveryCodes[0]! },
      }),
      hasCategory("current_password_invalid"),
    );
    await assert.rejects(
      fixture.service.disable("user-a", "session-a", {
        currentPassword: "correct-password",
        factor: { method: "recovery_code", code: recoveryCode },
      }),
      hasCategory("step_up_invalid"),
    );
    await fixture.service.disable("user-a", "session-a", {
      currentPassword: "correct-password",
      factor: { method: "recovery_code", code: regenerated.recoveryCodes[0]! },
    });
    assert.equal((await fixture.service.status("user-a")).enrolled, false);
  } finally {
    await fixture.cleanup();
  }
});

test("factor verification shares one user-session rate budget across operations without exposing submitted factors", async () => {
  const fixture = await createFixture();
  try {
    await enroll(fixture, "user-a");
    await enroll(fixture, "user-b");
    fixture.advance(30_000);
    const pending = await fixture.service.beginEnrollment("user-a", "session-a", {
      currentPassword: "correct-password",
      currentFactor: {
        method: "totp",
        code: totpCode(fixture.secret("user-a"), Math.floor(fixture.now() / 30_000)),
      },
    });
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(fixture.service.authorize("user-a", "session-a", "bad-code", makeIntent()), hasCategory("step_up_invalid"));
    }

    const crossOperationAttempts = [
      fixture.service.disable("user-a", "session-a", {
        currentPassword: "correct-password",
        factor: { method: "totp" as const, code: "sensitive-totp-code" },
      }),
      fixture.service.regenerateRecoveryCodes("user-a", "session-a", {
        currentPassword: "correct-password",
        factor: { method: "recovery_code" as const, code: "sensitive-recovery-code" },
      }),
      fixture.service.confirmEnrollment("user-a", "session-a", {
        enrollmentId: pending.enrollmentId,
        code: "sensitive-confirm-code",
      }),
      fixture.service.beginEnrollment("user-a", "session-a", {
        currentPassword: "correct-password",
        currentFactor: { method: "totp" as const, code: "sensitive-reenrollment-code" },
      }),
    ];
    for (const attempt of crossOperationAttempts) {
      await assert.rejects(
        attempt,
        hasSanitizedRateLimit([
          "sensitive-totp-code",
          "sensitive-recovery-code",
          "sensitive-confirm-code",
          "sensitive-reenrollment-code",
          pending.enrollmentId,
          "user-a",
          "session-a",
          "verification:",
        ]),
      );
    }

    await assert.rejects(
      fixture.service.authorize("user-a", "session-b", "bad-code", makeIntent()),
      hasCategory("step_up_invalid"),
      "a different session must have an isolated budget",
    );
    await assert.rejects(
      fixture.service.authorize("user-b", "session-a", "bad-code", makeIntent()),
      hasCategory("step_up_invalid"),
      "a different user must have an isolated budget",
    );

    fixture.advance(verifyWindowMsForTest);
    await assert.rejects(
      fixture.service.disable("user-a", "session-a", {
        currentPassword: "correct-password",
        factor: { method: "totp", code: "bad-code" },
      }),
      hasCategory("step_up_invalid"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("disable failures exhaust the shared factor budget for authorize", async () => {
  const fixture = await createFixture();
  try {
    await enroll(fixture, "user-a");
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        fixture.service.disable("user-a", "session-a", {
          currentPassword: "correct-password",
          factor: { method: "totp", code: "bad-code" },
        }),
        hasCategory("step_up_invalid"),
      );
    }
    await assert.rejects(
      fixture.service.authorize("user-a", "session-a", "bad-code", makeIntent()),
      hasSanitizedRateLimit(["bad-code", "user-a", "session-a", "verification:"]),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("password-only enrollment does not consume the shared factor verification budget", async () => {
  const fixture = await createFixture();
  try {
    let pending: Awaited<ReturnType<typeof fixture.service.beginEnrollment>> | null = null;
    for (let index = 0; index < 7; index += 1) {
      pending = await fixture.service.beginEnrollment("user-a", "session-a", {
        currentPassword: "correct-password",
      });
    }
    assert.ok(pending);
    const secret = secretFromUri(pending.otpauthUri);
    const confirmed = await fixture.service.confirmEnrollment("user-a", "session-a", {
      enrollmentId: pending.enrollmentId,
      code: totpCode(secret, Math.floor(fixture.now() / 30_000)),
    });
    assert.equal(confirmed.ok, true);
  } finally {
    await fixture.cleanup();
  }
});

const verifyWindowMsForTest = 5 * 60_000;

test("security envelopes isolate the AAD domain and reject replacement, tampering, KMS failure, and unsafe permissions", async () => {
  const fixture = await createFixture();
  try {
    await enroll(fixture, "user-a");
    const source = fixture.pathFor("user-a");
    const raw = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
    assert.equal(raw.purpose, "step-up-security");
    assert.equal(raw.securityDomain, "rwa-sensitive-operations");
    assert.equal(raw.aadSchema, "step-up-security:v1:userId:purpose:environment");
    assert.equal("accountId" in raw, false);
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700);
    await assert.rejects(
      fixture.provider.unwrapDataKey(raw as any, {
        purpose: "exchange-credential",
        userId: "user-a",
        venue: "bybit",
        accountId: "bybit:test-account",
        environment: "test",
        schemaVersion: 2,
      }),
      /AAD|身份/,
    );

    await copyFile(source, fixture.pathFor("user-b"));
    await assert.rejects(fixture.restart().status("user-b"), hasStoreCategory("step_up_key_unavailable"));

    await chmod(source, 0o644);
    await assert.rejects(fixture.restart().status("user-a"), hasStoreCategory("step_up_storage_permissions"));
    await chmod(source, 0o600);

    raw.wrapReference = "fake:test-key/versions/2";
    await writeFile(source, JSON.stringify(raw), { mode: 0o600 });
    await assert.rejects(fixture.restart().status("user-a"), hasStoreCategory("step_up_key_identity_mismatch"));

    fixture.provider.failCategory = "credential_key_provider_unavailable";
    await assert.rejects(fixture.restart().status("user-a"), hasStoreCategory("step_up_key_unavailable"));
    fixture.provider.failCategory = null;

    const unsafePath = join(fixture.directory, "unsafe", "state.enc.json");
    await mkdir(join(fixture.directory, "unsafe"), { mode: 0o700 });
    await chmod(join(fixture.directory, "unsafe"), 0o777);
    const unsafe = new StepUpSecurityStore("unsafe-user", fixture.provider, { statePath: unsafePath });
    await assert.rejects(unsafe.write({ version: 1, pending: null, active: null, audit: [] }), hasStoreCategory("step_up_storage_permissions"));
  } finally {
    await fixture.cleanup();
  }
});

function makeIntent(): StepUpIntent {
  return {
    operation: "hedge_execute",
    venue: "bybit",
    accountId: "bybit:test-account",
    resourceId: "challenge-a",
    requestDigest: "a".repeat(43),
    notionalUsd: 25,
  };
}

async function enroll(fixture: Awaited<ReturnType<typeof createFixture>>, userId: string) {
  const pending = await fixture.service.beginEnrollment(userId, "session-a", { currentPassword: "correct-password" });
  const secret = secretFromUri(pending.otpauthUri);
  fixture.rememberSecret(userId, secret);
  return fixture.service.confirmEnrollment(userId, "session-a", {
    enrollmentId: pending.enrollmentId,
    code: totpCode(secret, Math.floor(fixture.now() / 30_000)),
  });
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-step-up-"));
  const provider = new FakeCredentialKeyProvider();
  const secrets = new Map<string, string>();
  const invalidated = new Map<string, number>();
  let currentNow = baseNow;
  const pathFor = (userId: string) => join(directory, `${userId}.enc.json`);
  const storeFactory = (userId: string) => new StepUpSecurityStore(userId, provider, { statePath: pathFor(userId) });
  const createService = () => new StepUpSecurityService({
    storeFactory,
    verifyPassword: (_userId, password) => password === "correct-password",
    getEnrollmentInvalidatedAt: (userId) => invalidated.get(userId) ?? 0,
    now: () => currentNow,
  });
  let service = createService();
  return {
    directory,
    provider,
    get service() { return service; },
    now: () => currentNow,
    advance: (milliseconds: number) => { currentNow += milliseconds; },
    pathFor,
    rememberSecret: (userId: string, secret: string) => secrets.set(userId, secret),
    secret: (userId: string) => secrets.get(userId)!,
    invalidate: (userId: string, at: number) => invalidated.set(userId, at),
    restart: () => { service = createService(); return service; },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function secretFromUri(uri: string) {
  const secret = new URL(uri).searchParams.get("secret");
  assert.ok(secret);
  return secret;
}

function hasCategory(category: string) {
  return (error: unknown) => error instanceof StepUpSecurityError && error.category === category;
}

function hasSanitizedRateLimit(sensitiveValues: string[]) {
  return (error: unknown) => {
    if (!(error instanceof StepUpSecurityError)
      || error.category !== "step_up_rate_limited"
      || error.retryAfterSeconds !== 300) return false;
    const serialized = `${error.message} ${JSON.stringify(error)}`;
    return sensitiveValues.every((value) => !serialized.includes(value));
  };
}

function hasStoreCategory(category: string) {
  return (error: unknown) => error instanceof StepUpSecurityStoreError && error.category === category;
}
