import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
  RWA_CREDENTIAL_ENVELOPE_VERSION,
  canonicalCredentialAad,
  credentialEnvironment,
  type AutomationBackupKeyContext,
} from "./CredentialKeyProvider";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import {
  RWA_AUTOMATION_BACKUP_DOMAIN,
  RwaAutomationBackupError,
  RwaAutomationBackupService,
  assertBackupFileName,
} from "./RwaAutomationBackupService";
import {
  RWA_AUTOMATION_CURRENT_POINTER,
  RWA_AUTOMATION_INITIAL_GENERATION,
  readGenerationPointer,
} from "./RwaAutomationDataLayout";
import { createMonitoredActivityContinuity } from "./RwaProviderActivityContinuity";
import {
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
} from "./RwaAutomationAssetProfile";
import { createRwaAssetTakeoverRuntimeRecovery } from "./RwaAssetTakeoverRuntime";
import {
  RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
  RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
} from "./RwaConnectivitySmoke";

const baseNow = new Date("2026-07-24T10:20:30.000Z");
const credentialMarker = "private-api-secret-marker";
const totpMarker = "totp-secret-marker";
const recoveryMarker = "recovery-code-marker";

test("encrypted snapshot restores credential, TOTP, execution, PnL, audit, and fail-closed switches without ephemeral challenges", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.service.createBackup();
    const rawBackup = await readFile(join(fixture.backupRoot, result.fileName), "utf8");
    assert.doesNotMatch(rawBackup, new RegExp(credentialMarker));
    assert.doesNotMatch(rawBackup, new RegExp(totpMarker));
    assert.doesNotMatch(rawBackup, new RegExp(recoveryMarker));
    assert.doesNotMatch(rawBackup, /challenge-secret-marker/);
    assert.equal((await stat(join(fixture.backupRoot, result.fileName))).mode & 0o777, 0o600);
    const pointerBeforeVerify = await readFile(
      join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER),
      "utf8",
    );
    const verified = await fixture.service.verifyBackup(result.fileName);
    assert.equal(verified.backupId, result.backupId);
    assert.equal(verified.fileCount, result.fileCount);
    assert.equal(
      await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8"),
      pointerBeforeVerify,
    );

    await overwriteCurrentState(fixture, { marker: "newer-state-that-will-be-rollback" });
    const restored = await fixture.service.restoreBackup(result.fileName);
    const active = readGenerationPointer(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER, fixture.layoutOptions);
    assert.equal(basename(active), restored.restoredGeneration);
    const state = JSON.parse(await readFile(join(active, stateFileName), "utf8"));
    assert.equal(state.config.globalExecutionEnabled, false);
    assert.equal(state.config.strategyEnabled, false);
    assert.equal(state.config.killSwitchActive, true);
    assert.deepEqual(state.challenges, []);
    assert.equal(state.executions[0].state, "opening_perpetual");
    assert.equal(state.pnlSeries[0].netPnlUsd, 1.25);
    assert.equal(state.credentialAudit[0].action, "activated");
    assert.equal(state.assetAuthorizations[0].assetId, "xaut");
    assert.equal(state.assetAuthorizations[0].accountId, "binance:test");
    assert.equal(state.assetAuthorizations[0].revokedAt, null);
    assert.equal(state.assetTakeovers[0].takeoverId, "takeover-1");
    assert.equal(state.assetTakeovers[0].authorizationId, "authorization-1");
    assert.equal(state.assetTakeovers[0].state, "planned");
    assert.equal(state.assetTakeovers[0].runtime, null);
    const restoredCredential = JSON.parse(await readFile(join(active, credentialFileName), "utf8"));
    assert.equal(Buffer.from(restoredCredential.ciphertext, "base64url").toString("utf8"), credentialMarker);
    const restoredStepUp = JSON.parse(await readFile(join(active, "step-up-security", stepUpFileName), "utf8"));
    assert.equal(
      Buffer.from(restoredStepUp.ciphertext, "base64url").toString("utf8"),
      `${totpMarker}-${recoveryMarker}`,
    );

    const restarted = new RwaAutomationBackupService(fixture.provider, fixture.options);
    assert.equal(
      basename(readGenerationPointer(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER, fixture.layoutOptions)),
      restored.restoredGeneration,
    );
    const rollback = restarted.rollbackRestore();
    assert.equal(rollback.activeGeneration, RWA_AUTOMATION_INITIAL_GENERATION);
    const rolledBackState = JSON.parse(await readFile(join(
      readGenerationPointer(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER, fixture.layoutOptions),
      stateFileName,
    ), "utf8"));
    assert.equal(rolledBackState.marker, "newer-state-that-will-be-rollback");
  } finally {
    await fixture.cleanup();
  }
});

test("read-only verification preserves exact stage classifications", async () => {
  for (const [authenticationCategory, stage] of [
    ["wif_identity_invalid", "wif_identity"],
    ["sts_exchange_failed", "sts_exchange"],
  ] as const) {
    const fixture = await createFixture();
    try {
      const backup = await fixture.service.createBackup();
      fixture.provider.authenticationFailCategory = authenticationCategory;
      await assert.rejects(
        fixture.service.verifyBackup(backup.fileName),
        hasVerifyFailure(stage, authenticationCategory),
      );
    } finally {
      await fixture.cleanup();
    }
  }

  const healthFixture = await createFixture();
  try {
    const backup = await healthFixture.service.createBackup();
    healthFixture.provider.failCategory = "credential_key_provider_unavailable";
    await assert.rejects(
      healthFixture.service.verifyBackup(backup.fileName),
      hasVerifyFailure("kms_health", "kms_health_failed"),
    );
  } finally {
    await healthFixture.cleanup();
  }

  const decryptFixture = await createFixture();
  try {
    const backup = await decryptFixture.service.createBackup();
    decryptFixture.provider.unwrapDataKey = async () => {
      throw new Error("raw decrypt failure");
    };
    await assert.rejects(
      decryptFixture.service.verifyBackup(backup.fileName),
      hasVerifyFailure("kms_decrypt", "kms_decrypt_failed"),
    );
  } finally {
    await decryptFixture.cleanup();
  }

  const envelopeFixture = await createFixture();
  try {
    const name = "rwa-automation-20260724T102031Z.rwa.enc.json";
    await writeSecure(join(envelopeFixture.backupRoot, name), "{}");
    await assert.rejects(
      envelopeFixture.service.verifyBackup(name),
      hasVerifyFailure("backup_envelope", "backup_envelope_invalid"),
    );
  } finally {
    await envelopeFixture.cleanup();
  }

  const authenticationFixture = await createFixture();
  try {
    const backup = await authenticationFixture.service.createBackup();
    const path = join(authenticationFixture.backupRoot, backup.fileName);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.ciphertext = flipBase64url(envelope.ciphertext);
    await writeSecure(path, JSON.stringify(envelope));
    await assert.rejects(
      authenticationFixture.service.verifyBackup(backup.fileName),
      hasVerifyFailure("backup_authentication", "backup_authentication_failed"),
    );
  } finally {
    await authenticationFixture.cleanup();
  }

  const contentFixture = await createFixture();
  try {
    const backup = await contentFixture.service.createBackup();
    const contentName = "rwa-automation-20260724T102032Z.rwa.enc.json";
    await rewriteEncryptedSnapshot(
      contentFixture,
      join(contentFixture.backupRoot, backup.fileName),
      join(contentFixture.backupRoot, contentName),
      contentName,
      (snapshot) => {
        snapshot.manifest.totalBytes += 1;
      },
    );
    await assert.rejects(
      contentFixture.service.verifyBackup(contentName),
      hasVerifyFailure("backup_content", "backup_content_invalid"),
    );
  } finally {
    await contentFixture.cleanup();
  }
});

test("tampered ciphertext, wrong KMS key, AAD identity, manifest hash, and unsafe path all fail before the current pointer changes", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.service.createBackup();
    const source = join(fixture.backupRoot, created.fileName);
    const originalPointer = await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8");

    const tamperedName = "rwa-automation-20260724T102031Z.rwa.enc.json";
    const tamperedPath = join(fixture.backupRoot, tamperedName);
    const envelope = JSON.parse(await readFile(source, "utf8"));
    envelope.backupId = "20260724T102031Z";
    envelope.ciphertext = flipBase64url(envelope.ciphertext);
    await writeSecure(tamperedPath, JSON.stringify(envelope));
    await assert.rejects(fixture.service.restoreBackup(tamperedName), isBackupError());
    assert.equal(await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8"), originalPointer);
    await rm(tamperedPath);

    const wrongProviderService = new RwaAutomationBackupService(new FakeCredentialKeyProvider(), fixture.options);
    await assert.rejects(wrongProviderService.restoreBackup(created.fileName), isBackupError());
    assert.equal(await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8"), originalPointer);

    const aadName = "rwa-automation-20260724T102032Z.rwa.enc.json";
    await copyFile(source, join(fixture.backupRoot, aadName));
    await chmod(join(fixture.backupRoot, aadName), 0o600);
    await assert.rejects(fixture.service.restoreBackup(aadName), hasCategory("backup_envelope_invalid"));
    await rm(join(fixture.backupRoot, aadName));

    const wrapName = "rwa-automation-20260724T102035Z.rwa.enc.json";
    const wrapEnvelope = JSON.parse(await readFile(source, "utf8"));
    wrapEnvelope.backupId = "20260724T102035Z";
    wrapEnvelope.wrapReference = "fake:test-key/versions/999";
    await writeSecure(join(fixture.backupRoot, wrapName), JSON.stringify(wrapEnvelope));
    await assert.rejects(fixture.service.restoreBackup(wrapName), isBackupError());
    await rm(join(fixture.backupRoot, wrapName));

    const hashName = "rwa-automation-20260724T102033Z.rwa.enc.json";
    await rewriteEncryptedSnapshot(fixture, source, join(fixture.backupRoot, hashName), hashName, (snapshot) => {
      snapshot.manifest.files[0].sha256 = "0".repeat(64);
    });
    await assert.rejects(fixture.service.restoreBackup(hashName), hasCategory("backup_integrity_failed"));
    await rm(join(fixture.backupRoot, hashName));

    const pathName = "rwa-automation-20260724T102034Z.rwa.enc.json";
    await rewriteEncryptedSnapshot(fixture, source, join(fixture.backupRoot, pathName), pathName, (snapshot) => {
      snapshot.manifest.files[0].path = "../escape.json";
      snapshot.files[0].path = "../escape.json";
    });
    await assert.rejects(fixture.service.restoreBackup(pathName), hasCategory("backup_manifest_invalid"));
    assert.equal(await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8"), originalPointer);
  } finally {
    await fixture.cleanup();
  }
});

test("snapshot rejects symlinks, unsafe modes, unknown SQLite/WIF-style entries, and KMS outages", async () => {
  const fixture = await createFixture();
  try {
    const active = fixture.active;
    const credentialPath = join(active, credentialFileName);
    await chmod(credentialPath, 0o644);
    await assert.rejects(fixture.service.createBackup());
    await chmod(credentialPath, 0o600);

    const wrongOwner = new RwaAutomationBackupService(fixture.provider, {
      ...fixture.options,
      expectedUid: (process.getuid?.() ?? 0) + 1,
    });
    await assert.rejects(wrongOwner.createBackup(), isBackupError());

    const linkedName = `${"b".repeat(16)}-bybit-state.json`;
    await symlink(stateFileName, join(active, linkedName));
    await assert.rejects(fixture.service.createBackup(), isBackupError());
    await rm(join(active, linkedName));

    await writeSecure(join(active, "trading.sqlite"), "sqlite-must-never-enter-rwa-backup");
    await assert.rejects(fixture.service.createBackup(), hasCategory("backup_manifest_invalid"));
    await rm(join(active, "trading.sqlite"));

    await mkdir(join(active, "gcp-wif"), { mode: 0o700 });
    await assert.rejects(fixture.service.createBackup(), hasCategory("backup_manifest_invalid"));
    await rm(join(active, "gcp-wif"), { recursive: true });

    fixture.provider.failCategory = "credential_key_provider_unavailable";
    await assert.rejects(fixture.service.createBackup(), hasCategory("backup_key_unavailable"));
    assert.deepEqual(await readdir(fixture.backupRoot), []);
  } finally {
    await fixture.cleanup();
  }
});

test("takeover backup schema accepts legacy absence and rejects malformed, orphaned, or duplicate records", async () => {
  const legacy = await createFixture();
  try {
    const state = baseState() as any;
    delete state.assetTakeovers;
    await writeSecure(join(legacy.active, stateFileName), JSON.stringify(state));
    await legacy.service.createBackup();
  } finally {
    await legacy.cleanup();
  }

  const legacyManaged = await createFixture();
  try {
    const state = baseState() as any;
    state.assetTakeovers[0].state = "managed";
    await writeSecure(join(legacyManaged.active, stateFileName), JSON.stringify(state));
    const backup = await legacyManaged.service.createBackup();
    const restored = await legacyManaged.service.restoreBackup(backup.fileName);
    const restoredState = JSON.parse(await readFile(
      join(legacyManaged.dataRoot, restored.restoredGeneration, stateFileName),
      "utf8",
    ));
    assert.equal(restoredState.assetTakeovers[0].runtime.phase, "recovery_required");
    assert.equal(restoredState.assetTakeovers[0].runtime.authoritativeSnapshot, null);
  } finally {
    await legacyManaged.cleanup();
  }

  const invalidStates = [
    (state: any) => { state.assetTakeovers[0].unknown = true; },
    (state: any) => {
      state.assetTakeovers[0].state = "managed";
      state.assetTakeovers[0].runtime = { schemaVersion: 1 };
    },
    (state: any) => {
      state.assetTakeovers[0].state = "managed";
      state.assetTakeovers[0].runtime = {
        ...createRwaAssetTakeoverRuntimeRecovery(state.assetTakeovers[0].updatedAt),
        unknown: true,
      };
    },
    (state: any) => { state.assetTakeovers[0].authorizationId = "missing-authorization"; },
    (state: any) => {
      state.assetTakeovers.push({
        ...state.assetTakeovers[0],
        takeoverId: "takeover-2",
      });
    },
    (state: any) => {
      state.assetTakeovers.push({
        ...state.assetTakeovers[0],
        takeoverId: "takeover-2",
        idempotencyKey: "takeover-backup-second",
        orderLinkPrefix: "takeoverbackupsecond",
      });
    },
    (state: any) => {
      state.assetTakeovers = Array.from({ length: 101 }, (_, index) => ({
        ...state.assetTakeovers[0],
        takeoverId: `takeover-capacity-${index}`,
      }));
    },
  ];
  for (const mutate of invalidStates) {
    const fixture = await createFixture();
    try {
      const state = baseState() as any;
      mutate(state);
      await writeSecure(join(fixture.active, stateFileName), JSON.stringify(state));
      await assert.rejects(
        fixture.service.createBackup(),
        hasCategory("backup_manifest_invalid"),
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("connectivity smoke backup migrates exact parent records and rejects malformed or contradictory facts", async () => {
  const legacyFixture = await createFixture();
  try {
    const state = baseState() as any;
    const active = backupSmoke("spot_opening", "active");
    const terminal = backupSmoke("flat", "terminal");
    for (const smoke of [active, terminal]) {
      delete smoke.providerState;
      delete smoke.timeline;
    }
    state.connectivitySmokes = [active, terminal];
    await writeSecure(join(legacyFixture.active, stateFileName), JSON.stringify(state));
    const backup = await legacyFixture.service.createBackup();
    const restored = await legacyFixture.service.restoreBackup(backup.fileName);
    const restoredState = JSON.parse(await readFile(
      join(legacyFixture.dataRoot, restored.restoredGeneration, stateFileName),
      "utf8",
    ));
    assert.deepEqual(
      restoredState.connectivitySmokes.map((smoke: any) => [
        smoke.stage,
        smoke.providerState.verificationStatus,
        smoke.providerState.reason,
        smoke.receipt,
        smoke.timeline.at(-1).code,
      ]),
      [
        ["spot_opening", "unavailable", "legacy_provider_state_unavailable", null, "legacy_migration_current_stage"],
        ["flat", "unavailable", "legacy_provider_state_unavailable", null, "legacy_migration_current_stage"],
      ],
    );
  } finally {
    await legacyFixture.cleanup();
  }

  const malformedLegacyMutations: Array<(smoke: any) => void> = [
    (smoke) => { smoke.receipt.unknown = true; },
    (smoke) => { smoke.receipt.accountFingerprint = "other"; },
    (smoke) => { smoke.receipt.completedAt = smoke.updatedAt + 1; },
    (smoke) => {
      smoke.receipt.budget = {
        ...smoke.receipt.budget,
        quantityXaut: smoke.receipt.budget.quantityXaut + 0.001,
      };
    },
    (smoke) => { smoke.spotOpenOrder.feeUsd = -1; },
    (smoke) => { smoke.spotOpenOrder.orderLinkId = `${smoke.orderLinkPrefix}p1`; },
    (smoke) => { smoke.budget.totalCapitalUsd = 26; },
    (smoke) => { smoke.exit.futuresFlatConfirmed = "yes"; },
  ];
  for (const mutate of malformedLegacyMutations) {
    const fixture = await createFixture();
    try {
      const state = baseState() as any;
      const smoke = backupSmoke("flat", "legacy-invalid");
      delete smoke.providerState;
      delete smoke.timeline;
      mutate(smoke);
      state.connectivitySmokes = [smoke];
      await writeSecure(join(fixture.active, stateFileName), JSON.stringify(state));
      await assert.rejects(fixture.service.createBackup(), hasCategory("backup_manifest_invalid"));
    } finally {
      await fixture.cleanup();
    }
  }

  const mutations: Array<(smoke: any) => void> = [
    (smoke) => { smoke.spotOpenOrder.orderLinkId = `${smoke.orderLinkPrefix}p1`; },
    (smoke) => { smoke.futuresOpenOrder.filledQuantityXaut = 2; },
    (smoke) => { smoke.exit.spotCloseOrder.status = "Pending"; },
    (smoke) => { smoke.providerState.activeTotalOrderCount = 1; },
    (smoke) => {
      smoke.providerState.observedAt = null;
      smoke.providerState.residualSpotQuantityXaut = null;
      smoke.providerState.residualFuturesQuantityXaut = null;
      smoke.providerState.activeSpotOrderCount = null;
      smoke.providerState.activeFuturesOrderCount = null;
      smoke.providerState.activeTotalOrderCount = null;
      smoke.providerState.providerFlatConfirmed = null;
    },
    (smoke) => {
      smoke.providerState.verificationStatus = "stale";
      smoke.providerState.reason = "provider_snapshot_stale";
      smoke.providerState.providerFlatConfirmed = null;
      smoke.providerState.activeSpotOrderCount = null;
    },
    (smoke) => {
      smoke.providerState.verificationStatus = "ambiguous";
      smoke.providerState.reason = "provider_ledger_mismatch";
      smoke.providerState.providerFlatConfirmed = null;
      smoke.providerState.residualSpotQuantityXaut = null;
    },
    (smoke) => {
      smoke.providerState.verificationStatus = "unavailable";
      smoke.providerState.reason = "provider_snapshot_unavailable";
      smoke.providerState.providerFlatConfirmed = null;
    },
    (smoke) => { smoke.providerState.observedAt = smoke.updatedAt + 1; },
    (smoke) => { smoke.receipt.accountFingerprint = "other"; },
    (smoke) => { smoke.timeline.at(-1).code = "invalid"; },
  ];
  for (const mutate of mutations) {
    const fixture = await createFixture();
    try {
      const state = baseState() as any;
      const smoke = backupSmoke("flat", "invalid");
      mutate(smoke);
      state.connectivitySmokes = [smoke];
      await writeSecure(join(fixture.active, stateFileName), JSON.stringify(state));
      await assert.rejects(fixture.service.createBackup(), hasCategory("backup_manifest_invalid"));
    } finally {
      await fixture.cleanup();
    }
  }

  const partialFixture = await createFixture();
  try {
    const state = baseState() as any;
    const smoke = backupSmoke("flat", "partial");
    delete smoke.timeline;
    state.connectivitySmokes = [smoke];
    await writeSecure(join(partialFixture.active, stateFileName), JSON.stringify(state));
    await assert.rejects(partialFixture.service.createBackup(), hasCategory("backup_manifest_invalid"));
  } finally {
    await partialFixture.cleanup();
  }
});

test("credential, step-up, and automation state schemas reject unknown nested persistent fields before publication", async () => {
  const fixture = await createFixture();
  const cases = [
    {
      path: join(fixture.active, credentialFileName),
      mutate: (value: any) => { value.providerRawResponse = { marker: "must-not-back-up" }; },
    },
    {
      path: join(fixture.active, "step-up-security", stepUpFileName),
      mutate: (value: any) => { value.authorizationToken = "must-not-back-up"; },
    },
    {
      path: join(fixture.active, stateFileName),
      mutate: (value: any) => { value.executions[0].armed = true; },
    },
    {
      path: join(fixture.active, stateFileName),
      mutate: (value: any) => { value.executions[0].strategyPosition.cache = {}; },
    },
    {
      path: join(fixture.active, stateFileName),
      mutate: (value: any) => { value.executions[0].activityContinuity.spot.unknownWatermark = {}; },
    },
    {
      path: join(fixture.active, stateFileName),
      mutate: (value: any) => { value.executions[0].activityContinuity.spot.sources[0].unknownCursor = "unsafe"; },
    },
    {
      path: join(fixture.active, stateFileName),
      mutate: (value: any) => { value.executions[0].activityContinuity.spot.sources[0].eventDigest = "0".repeat(64); },
    },
    {
      path: join(fixture.active, stateFileName),
      mutate: (value: any) => { value.executions[0].activityContinuity.spot.sources.pop(); },
    },
  ];
  try {
    for (const item of cases) {
      const original = await readFile(item.path, "utf8");
      const value = JSON.parse(original);
      item.mutate(value);
      await writeSecure(item.path, JSON.stringify(value));
      await assert.rejects(fixture.service.createBackup(), hasCategory("backup_manifest_invalid"));
      assert.deepEqual(await readdir(fixture.backupRoot), []);
      await writeSecure(item.path, original);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("backup accepts legacy executions without reconciliation fields but rejects malformed finalize idempotency", async () => {
  const fixture = await createFixture();
  try {
    const statePath = join(fixture.active, stateFileName);
    const original = JSON.parse(await readFile(statePath, "utf8"));
    delete original.executions[0].reconciliation;
    delete original.executions[0].finalizeIdempotency;
    delete original.executions[0].strategyPosition;
    delete original.executions[0].activityContinuity;
    delete original.executions[0].asset;
    delete original.executions[0].profileId;
    delete original.executions[0].reservedCapitalUsd;
    await writeSecure(statePath, JSON.stringify(original));
    const created = await fixture.service.createBackup();
    assert.match(created.fileName, /^rwa-automation-/);

    original.executions[0].reconciliation = null;
    original.executions[0].strategyPosition = {
      coverage: "complete",
      spotRemainingXaut: 0,
      perpetualRemainingXaut: 0,
      updatedAt: 1,
    };
    original.executions[0].finalizeIdempotency = {
      scopedKey: "scoped:key",
      requestFingerprint: "fingerprint",
      resultState: "manual_intervention",
      completedAt: 1,
    };
    await writeSecure(statePath, JSON.stringify(original));
    const rejectingService = new RwaAutomationBackupService(fixture.provider, {
      ...fixture.options,
      now: () => new Date("2026-07-24T10:20:31.000Z"),
    });
    await assert.rejects(rejectingService.createBackup(), hasCategory("backup_manifest_invalid"));
  } finally {
    await fixture.cleanup();
  }
});

test("backup and restore interruption leave no partial backup and retain the original active generation", async () => {
  const fixture = await createFixture();
  try {
    const interruptedBackup = new RwaAutomationBackupService(fixture.provider, {
      ...fixture.options,
      faultHook: (point) => {
        if (point === "before_backup_publish") throw new Error("injected");
      },
    });
    await assert.rejects(interruptedBackup.createBackup(), hasCategory("backup_failed"));
    assert.deepEqual(await readdir(fixture.backupRoot), []);

    const created = await fixture.service.createBackup();
    for (const faultPoint of ["before_pointer_swap", "after_pointer_swap"] as const) {
      const pointerBefore = await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8");
      const interruptedRestore = new RwaAutomationBackupService(fixture.provider, {
        ...fixture.options,
        now: () => new Date(faultPoint === "before_pointer_swap" ? "2026-07-24T10:21:00Z" : "2026-07-24T10:22:00Z"),
        faultHook: (point) => {
          if (point === faultPoint) throw new Error("injected");
        },
      });
      await assert.rejects(interruptedRestore.restoreBackup(created.fileName), hasCategory("restore_failed"));
      assert.deepEqual(
        JSON.parse(await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8")),
        JSON.parse(pointerBefore),
      );
      const generations = (await readdir(fixture.dataRoot)).filter((name) => name.startsWith("generation-"));
      assert.deepEqual(generations, [RWA_AUTOMATION_INITIAL_GENERATION]);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("retention removes only strict old backup names and capacity limits fail closed", async () => {
  let now = new Date("2026-07-20T00:00:00Z");
  const fixture = await createFixture({ now: () => now, retentionDays: 1 });
  try {
    const first = await fixture.service.createBackup();
    await assert.rejects(fixture.service.createBackup(), hasCategory("backup_already_exists"));
    assert.deepEqual(await readdir(fixture.backupRoot), [first.fileName]);
    now = new Date("2026-07-24T00:00:00Z");
    const second = await fixture.service.createBackup();
    assert.deepEqual(await readdir(fixture.backupRoot), [second.fileName]);
    assert.notEqual(first.fileName, second.fileName);

    const constrained = new RwaAutomationBackupService(fixture.provider, {
      ...fixture.options,
      now: () => new Date("2026-07-24T00:00:01Z"),
      limits: { retentionDays: 1, maxTotalBytes: 1024 * 1024, maxSnapshotBytes: 1024 },
    });
    await assert.rejects(constrained.createBackup(), hasCategory("backup_capacity_exceeded"));
    assert.deepEqual(await readdir(fixture.backupRoot), [second.fileName]);
  } finally {
    await fixture.cleanup();
  }
});

test("restore rejects an oversized encrypted archive before JSON parsing or KMS access", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.service.createBackup();
    const source = join(fixture.backupRoot, created.fileName);
    await writeSecure(source, "x".repeat(4096));
    const pointerBefore = await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8");
    let kmsCalls = 0;
    const healthCheck = fixture.provider.healthCheck.bind(fixture.provider);
    const unwrapDataKey = fixture.provider.unwrapDataKey.bind(fixture.provider);
    fixture.provider.healthCheck = async (...args) => {
      kmsCalls += 1;
      return healthCheck(...args);
    };
    fixture.provider.unwrapDataKey = async (...args) => {
      kmsCalls += 1;
      return unwrapDataKey(...args);
    };
    const constrained = new RwaAutomationBackupService(fixture.provider, {
      ...fixture.options,
      limits: { retentionDays: 30, maxTotalBytes: 1024 * 1024, maxSnapshotBytes: 1024 },
    });
    await assert.rejects(constrained.restoreBackup(created.fileName), hasCategory("backup_capacity_exceeded"));
    assert.equal(kmsCalls, 0);
    assert.equal(await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8"), pointerBefore);

    await writeSecure(source, "x".repeat(600 * 1024));
    const secondName = "rwa-automation-20260724T102031Z.rwa.enc.json";
    await writeSecure(join(fixture.backupRoot, secondName), "x".repeat(600 * 1024));
    const totalCapacityConstrained = new RwaAutomationBackupService(fixture.provider, {
      ...fixture.options,
      limits: { retentionDays: 30, maxTotalBytes: 1024 * 1024, maxSnapshotBytes: 1024 * 1024 },
    });
    await assert.rejects(
      totalCapacityConstrained.restoreBackup(created.fileName),
      hasCategory("backup_capacity_exceeded"),
    );
    assert.equal(kmsCalls, 0);
    assert.equal(await readFile(join(fixture.dataRoot, RWA_AUTOMATION_CURRENT_POINTER), "utf8"), pointerBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("restore filename allowlist rejects traversal, suffixes, and command-like input", () => {
  assert.doesNotThrow(() => assertBackupFileName("rwa-automation-20260724T102030Z.rwa.enc.json"));
  for (const value of [
    "../rwa-automation-20260724T102030Z.rwa.enc.json",
    "rwa-automation-20260724T102030Z.rwa.enc.json.extra",
    "rwa-automation-20260724T102030Z.rwa.enc.json;id",
    "rwa-automation-20260724T102030Z.rwa.enc.json\nnext",
    "trading-20260724T102030Z.sqlite",
  ]) {
    assert.throws(() => assertBackupFileName(value), hasCategory("backup_name_invalid"));
  }
});

const stateFileName = `${"a".repeat(16)}-binance-state.json`;
const credentialFileName = `${"a".repeat(16)}-binance-credentials.enc.json`;
const stepUpFileName = `${"A".repeat(24)}.enc.json`;

async function createFixture(overrides: { now?: () => Date; retentionDays?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "xingheng-rwa-backup-"));
  const dataRoot = join(root, "data");
  const backupRoot = join(root, "backups");
  const active = join(dataRoot, RWA_AUTOMATION_INITIAL_GENERATION);
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  await mkdir(active, { recursive: true, mode: 0o700 });
  await mkdir(backupRoot, { mode: 0o700 });
  await writeSecure(join(dataRoot, RWA_AUTOMATION_CURRENT_POINTER), JSON.stringify({
    version: 1,
    generation: RWA_AUTOMATION_INITIAL_GENERATION,
    rollbackGeneration: null,
  }));
  await writeSecure(join(active, credentialFileName), JSON.stringify({
    version: 2,
    algorithm: "AES-256-GCM",
    provider: "fake",
    keyName: "fake:test-key",
    wrapReference: "fake:test-key/versions/1",
    wrappedDek: Buffer.from("wrapped").toString("base64url"),
    wrapBindingTag: Buffer.alloc(32, 1).toString("base64url"),
    ciphertext: Buffer.from(credentialMarker).toString("base64url"),
    nonce: Buffer.alloc(12, 2).toString("base64url"),
    tag: Buffer.alloc(16, 3).toString("base64url"),
    aadSchema: "rwa-credential:v2:userId:venue:accountId:environment",
    createdAt: baseNow.getTime(),
    updatedAt: baseNow.getTime(),
    maskedApiKey: "****",
    accountId: "binance:test",
    accountFingerprint: "fingerprint",
    accountMode: "single_asset_one_way",
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      ipRestricted: true,
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: true,
    },
    lastVerifiedAt: baseNow.getTime(),
  }));
  await writeSecure(join(active, stateFileName), JSON.stringify(baseState()));
  await mkdir(join(active, "step-up-security"), { mode: 0o700 });
  await writeSecure(join(active, "step-up-security", stepUpFileName), JSON.stringify({
    version: 2,
    algorithm: "AES-256-GCM",
    purpose: "step-up-security",
    securityDomain: "rwa-sensitive-operations",
    provider: "fake",
    keyName: "fake:test-key",
    wrapReference: "fake:test-key/versions/1",
    wrappedDek: Buffer.from("wrapped").toString("base64url"),
    wrapBindingTag: Buffer.alloc(32, 4).toString("base64url"),
    ciphertext: Buffer.from(`${totpMarker}-${recoveryMarker}`).toString("base64url"),
    nonce: Buffer.alloc(12, 5).toString("base64url"),
    tag: Buffer.alloc(16, 6).toString("base64url"),
    aadSchema: "step-up-security:v1:userId:purpose:environment",
    createdAt: baseNow.getTime(),
    updatedAt: baseNow.getTime(),
  }));
  const provider = new FakeCredentialKeyProvider();
  const layoutOptions = { root: dataRoot, expectedUid: uid, expectedGid: gid, production: false };
  const options = {
    dataRoot,
    backupRoot,
    expectedUid: uid,
    expectedGid: gid,
    production: false,
    now: overrides.now ?? (() => baseNow),
    limits: {
      retentionDays: overrides.retentionDays ?? 30,
      maxTotalBytes: 1024 * 1024,
      maxSnapshotBytes: 256 * 1024,
    },
  };
  return {
    root,
    dataRoot,
    backupRoot,
    active,
    provider,
    layoutOptions,
    options,
    service: new RwaAutomationBackupService(provider, options),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function baseState() {
  const profile = requireRwaAutomationExecutionProfile("xaut", "binance");
  return {
    version: 1,
    config: {
      globalExecutionEnabled: true,
      strategyEnabled: true,
      killSwitchActive: false,
      maxStrategyCapitalUsd: 300,
      maxEntryBasisBps: 30,
      maxCombinedSlippageBps: 20,
      minNetAprPercent: 8,
      minLiquidationDistancePercent: 30,
      maxUnhedgedMs: 10_000,
    },
    assetAuthorizations: [{
      authorizationId: "authorization-1",
      userDomain: "a".repeat(16),
      venue: "binance",
      accountId: "binance:test",
      accountFingerprint: "fingerprint",
      assetId: "xaut",
      profileId: rwaAutomationProfileId(profile),
      policyVersion: profile.asset.authorizationPolicy.version,
      policyDigest: profile.asset.authorizationPolicy.digest,
      previewDigest: "1".repeat(64),
      spotQuantity: 0.2,
      spotAvailableQuantity: 0.1,
      spotLockedQuantity: 0.1,
      perpetualQuantity: 0.2,
      perpetualSide: "short",
      spotOrderCount: 1,
      perpetualOrderCount: 1,
      ordersDigest: "2".repeat(64),
      maxManagedSpotQuantity: 0.2,
      maxManagedPerpetualQuantity: 0.2,
      maxManagedNotionalUsd: 1_600,
      previewedAt: baseNow.getTime(),
      createdAt: baseNow.getTime() + 1,
      revokedAt: null,
    }],
    assetTakeovers: [{
      takeoverId: "takeover-1",
      userId: "user-1",
      userDomain: "a".repeat(16),
      venue: "binance",
      accountId: "binance:test",
      accountFingerprint: "fingerprint",
      assetId: "xaut",
      profileId: rwaAutomationProfileId(profile),
      authorizationId: "authorization-1",
      authorizationCreatedAt: baseNow.getTime() + 1,
      policyVersion: profile.asset.authorizationPolicy.version,
      policyDigest: profile.asset.authorizationPolicy.digest,
      idempotencyKey: "takeover:idempotency:1",
      previewDigest: "3".repeat(64),
      newCapitalUsd: 100,
      totalManagedCapitalUsd: 200,
      reservedCapitalUsd: 200,
      leverage: 2,
      state: "planned",
      orderLinkPrefix: "takeover-order",
      plannedMutation: null,
      acceptedOrders: [],
      cancelledOrders: [],
      spotOrders: [],
      perpetualOrders: [],
      targetHedgedQuantity: 0.05,
      finalSpotQuantity: 0.05,
      finalPerpetualQuantity: 0.05,
      residualQuantity: 0,
      errorCategory: null,
      message: "接管计划已保存。",
      createdAt: baseNow.getTime() + 2,
      updatedAt: baseNow.getTime() + 2,
    }],
    challenges: [{
      id: "challenge-secret-marker",
      tokenHash: "challenge-token-hash",
      report: validPreflightReport(),
      expiresAt: baseNow.getTime() + 60_000,
      consumedAt: null,
    }],
    executions: [{
      userId: "user-1",
      accountId: "binance:test",
      asset: "XAUT",
      profileId: "xaut:binance-xaut-spot-perp-v1",
      reservedCapitalUsd: 25,
      executionId: "execution-1",
      idempotencyKey: "idempotency-1",
      challengeId: "challenge-secret-marker",
      state: "opening_perpetual",
      orderLinkPrefix: "strategy-order",
      spotOrder: {
        orderId: "spot-order-1",
        orderLinkId: "strategy-order-s1",
        status: "Filled",
        requestedQuantityXaut: 0.002,
        filledQuantityXaut: 0.002,
        positionQuantityXaut: 0.001999,
        averagePrice: 4_000,
        feeUsd: 0.001,
        updatedAt: baseNow.getTime(),
      },
      perpetualOrders: [],
      compensationOrders: [],
      hedgedQuantityXaut: 0,
      unhedgedDurationMs: 10,
      errorCategory: null,
      message: "正在建立现货与永续对冲组合。",
      reconciliation: null,
      finalizeIdempotency: null,
      strategyPosition: {
        coverage: "complete",
        spotRemainingXaut: 0.001999,
        perpetualRemainingXaut: 0,
        updatedAt: baseNow.getTime(),
      },
      activityContinuity: createMonitoredActivityContinuity(baseNow.getTime(), "strategy-order"),
      createdAt: baseNow.getTime(),
      updatedAt: baseNow.getTime(),
    }],
    pnlSeries: [{
      accountId: "binance:test",
      accountFingerprint: "fingerprint",
      strategyId: "binance-xaut-spot-perp-v1",
      capturedAt: baseNow.getTime(),
      legs: {
        spot: validPnlSide("spot_long"),
        perpetual: validPnlSide("perpetual_short"),
      },
      netDeltaXaut: 0,
      netDeltaUsd: 0,
      entryBasisBps: 1,
      currentBasisBps: 1,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 1.25,
      fundingPnlUsd: 0,
      feesUsd: 0,
      slippageUsd: 0,
      netPnlUsd: 1.25,
      openOrders: [],
    }],
    credentialLifecycle: "active",
    credentialAlert: null,
    credentialAudit: [{
      userId: "user-1",
      action: "activated",
      accountId: "binance:test",
      accountFingerprint: "fingerprint",
      maskedApiKey: "****",
      occurredAt: baseNow.getTime(),
    }],
  };
}

function backupSmoke(stage: "spot_opening" | "flat", suffix: string): any {
  const prefix = `rwacsbackup${suffix}`;
  const budget = {
    limitUsd: 25,
    quantityXaut: 0.002,
    commonQtyStep: 0.001,
    slippageBpsPerAction: 10,
    prices: {
      spotOpenLimit: 4_101,
      futuresOpenLimit: 4_099,
      futuresCloseLimit: 4_101,
      spotCloseLimit: 4_099,
    },
    spotNotionalUsd: 8.2,
    futuresMarginUsd: 8.2,
    spotFeesUsd: 0.01,
    futuresFeesUsd: 0.01,
    spotSlippageReserveUsd: 0.01,
    futuresSlippageReserveUsd: 0.01,
    roundingReserveUsd: 0.01,
    totalCapitalUsd: 16.45,
  };
  const order = (orderSuffix: string) => ({
    orderId: `order-${suffix}-${orderSuffix}`,
    orderLinkId: `${prefix}${orderSuffix}`,
    status: "Filled",
    requestedQuantityXaut: 0.002,
    filledQuantityXaut: 0.002,
    positionQuantityXaut: 0.002,
    averagePrice: 4_100,
    feeUsd: 0.001,
    updatedAt: baseNow.getTime() + 7,
  });
  const timeline = stage === "flat"
    ? [
      ["reserved", "reserved"],
      ["spot_opening", "stage_spot_opening"],
      ["spot_open", "stage_spot_open"],
      ["futures_opening", "stage_futures_opening"],
      ["hedged", "stage_hedged"],
      ["futures_closing", "stage_futures_closing"],
      ["spot_closing", "stage_spot_closing"],
      ["flat", "stage_flat"],
    ].map(([eventStage, code], index) => ({
      stage: eventStage,
      code,
      at: baseNow.getTime() + index,
    }))
    : [
      { stage: "reserved", code: "reserved", at: baseNow.getTime() },
      { stage: "spot_opening", code: "stage_spot_opening", at: baseNow.getTime() + 1 },
    ];
  const flat = stage === "flat";
  return {
    smokeId: `smoke-backup-${suffix}`,
    userId: "user-1",
    accountId: "binance:test",
    accountFingerprint: "fingerprint",
    purpose: "connectivity_smoke",
    mode: "connectivity_smoke",
    idempotencyKey: `smoke:backup:${suffix}`,
    challengeId: `challenge-${suffix}`,
    requestDigest: `request-${suffix}`,
    policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
    policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
    orderLinkPrefix: prefix,
    stage,
    budget,
    authorization: {
      operation: "connectivity_smoke_execute",
      consumedBeforeProviderMutation: true,
      exitAuthorized: true,
      reservedAt: baseNow.getTime(),
    },
    spotOpenOrder: flat ? order("s1") : null,
    futuresOpenOrder: flat ? order("p1") : null,
    openedSpotQuantityXaut: flat ? 0.002 : 0,
    openedFuturesQuantityXaut: flat ? 0.002 : 0,
    exit: {
      futuresCloseOrder: flat ? order("c1") : null,
      spotCloseOrder: flat ? order("c2") : null,
      futuresFlatConfirmed: flat,
      spotFlatConfirmed: flat,
    },
    providerState: flat ? {
      verificationStatus: "verified",
      observedAt: baseNow.getTime() + 7,
      residualSpotQuantityXaut: 0,
      residualFuturesQuantityXaut: 0,
      activeSpotOrderCount: 0,
      activeFuturesOrderCount: 0,
      activeTotalOrderCount: 0,
      providerFlatConfirmed: true,
      reason: "provider_flat_confirmed",
    } : {
      verificationStatus: "unavailable",
      observedAt: null,
      residualSpotQuantityXaut: null,
      residualFuturesQuantityXaut: null,
      activeSpotOrderCount: null,
      activeFuturesOrderCount: null,
      activeTotalOrderCount: null,
      providerFlatConfirmed: null,
      reason: "not_yet_observed",
    },
    timeline,
    receipt: flat ? {
      receiptId: `receipt-${suffix}`,
      smokeId: `smoke-backup-${suffix}`,
      purpose: "connectivity_smoke",
      venue: "binance",
      symbol: "XAUTUSDT",
      accountFingerprint: "fingerprint",
      policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
      policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
      budget,
      openedSpotQuantityXaut: 0.002,
      openedFuturesQuantityXaut: 0.002,
      finalSpotQuantityXaut: 0,
      finalFuturesQuantityXaut: 0,
      providerFlatConfirmed: true,
      completedAt: baseNow.getTime() + 7,
    } : null,
    noReopen: true,
    providerMutationCount: flat ? 5 : 1,
    errorCategory: null,
    message: stage,
    createdAt: baseNow.getTime(),
    updatedAt: baseNow.getTime() + timeline.length - 1,
  };
}

function validPreflightReport() {
  return {
    userId: "user-1",
    accountId: "binance:test",
    accountFingerprint: "fingerprint",
    strategyId: "binance-xaut-spot-perp-v1",
    network: "binance_mainnet",
    action: "arbitrage_entry",
    mode: "arbitrage_entry",
    opportunityId: "opportunity-1",
    venue: "binance",
    quantityXaut: 0.002,
    totalBudgetUsd: 25,
    estimatedSpotNotionalUsd: 8,
    estimatedPerpetualNotionalUsd: 8,
    estimatedCapitalRequiredUsd: 16,
    referenceSpotAsk: 4_000,
    referencePerpetualBid: 4_000,
    entryBasisBps: 0,
    fundingRate: 0.0001,
    estimatedNetAprPercent: 8,
    checks: [{ name: "eligible", passed: true, value: true, limit: true, message: "通过。" }],
    warnings: [],
    passed: true,
    generatedAt: baseNow.getTime(),
    expiresAt: baseNow.getTime() + 60_000,
  };
}

function validPnlSide(kind: "spot_long" | "perpetual_short") {
  return {
    kind,
    quantityXaut: 0.002,
    averageEntryPrice: 4_000,
    markPrice: 4_000,
    notionalUsd: 8,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: kind === "spot_long" ? 1.25 : 0,
  };
}

async function overwriteCurrentState(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  value: Record<string, unknown>,
) {
  await writeSecure(join(fixture.active, stateFileName), JSON.stringify({
    ...baseState(),
    ...value,
  }));
}

async function writeSecure(path: string, value: string) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function rewriteEncryptedSnapshot(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  source: string,
  destination: string,
  destinationName: string,
  mutate: (snapshot: any) => void,
) {
  const envelope = JSON.parse(await readFile(source, "utf8"));
  const sourceContext = backupContext(envelope.backupId);
  const key = await fixture.provider.unwrapDataKey(envelope, sourceContext);
  let plaintext: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
    decipher.setAAD(canonicalCredentialAad(sourceContext));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const snapshot = JSON.parse(plaintext.toString("utf8"));
    mutate(snapshot);
    const destinationId = assertBackupFileName(destinationName)[1]!;
    const destinationContext = backupContext(destinationId);
    const replacementKey = await fixture.provider.createDataKey(destinationContext);
    try {
      const nextEnvelope = {
        ...envelope,
        backupId: destinationId,
        createdAt: Date.parse(
          `${destinationId.slice(0, 4)}-${destinationId.slice(4, 6)}-${destinationId.slice(6, 8)}T`
          + `${destinationId.slice(9, 11)}:${destinationId.slice(11, 13)}:${destinationId.slice(13, 15)}Z`,
        ),
        provider: replacementKey.provider,
        keyName: replacementKey.keyName,
        wrapReference: replacementKey.wrapReference,
        wrappedDek: replacementKey.wrappedDek,
      };
      snapshot.manifest.backupId = destinationId;
      snapshot.manifest.createdAt = nextEnvelope.createdAt;
      const finalPlaintext = Buffer.from(JSON.stringify(snapshot), "utf8");
      const finalCipher = createCipheriv("aes-256-gcm", replacementKey.plaintextDek, Buffer.from(envelope.nonce, "base64url"));
      finalCipher.setAAD(canonicalCredentialAad(destinationContext));
      const finalCiphertext = Buffer.concat([finalCipher.update(finalPlaintext), finalCipher.final()]);
      nextEnvelope.ciphertext = finalCiphertext.toString("base64url");
      nextEnvelope.tag = finalCipher.getAuthTag().toString("base64url");
      nextEnvelope.wrapBindingTag = backupBinding(replacementKey.plaintextDek, nextEnvelope);
      await writeSecure(destination, JSON.stringify(nextEnvelope));
      finalPlaintext.fill(0);
      finalCiphertext.fill(0);
    } finally {
      replacementKey.plaintextDek.fill(0);
    }
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}

function backupContext(backupId: string): AutomationBackupKeyContext {
  return {
    purpose: "automation-backup",
    backupId,
    backupDomain: RWA_AUTOMATION_BACKUP_DOMAIN,
    environment: credentialEnvironment(),
    schemaVersion: RWA_CREDENTIAL_ENVELOPE_VERSION,
  };
}

function backupBinding(key: Buffer, envelope: Record<string, unknown>) {
  return createHmac("sha256", key).update(JSON.stringify({
    version: envelope.version,
    purpose: envelope.purpose,
    backupDomain: envelope.backupDomain,
    backupId: envelope.backupId,
    environment: envelope.environment,
    provider: envelope.provider,
    keyName: envelope.keyName,
    wrapReference: envelope.wrapReference,
    wrappedDek: envelope.wrappedDek,
    createdAt: envelope.createdAt,
  })).digest("base64url");
}

function flipBase64url(value: string) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

function hasCategory(category: string) {
  return (error: unknown) => error instanceof RwaAutomationBackupError && error.category === category;
}

function hasVerifyFailure(stage: string, category: string) {
  return (error: unknown) => error instanceof RwaAutomationBackupError
    && error.verifyStage === stage
    && error.category === category
    && !JSON.stringify(error).includes("raw decrypt failure");
}

function isBackupError() {
  return (error: unknown) => error instanceof RwaAutomationBackupError;
}
