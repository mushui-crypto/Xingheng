import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_IDENTITY_PROOF_KINDS,
  productionSelfTestPermitDigest,
  validateIdentityTransition,
} from "./productionIdentityTransition.mjs";

test("production identity proof kinds are fixed", () => {
  assert.deepEqual(Object.values(PRODUCTION_IDENTITY_PROOF_KINDS).sort(), [
    "activated_lifecycle",
    "exact_baseline",
    "permit_transition",
  ]);
});

test("exact canonical identity produces exact_baseline proof without reading a Permit", () => {
  const promoted = identity();
  const result = validateIdentityTransition({
    promoted,
    current: structuredClone(promoted),
    readPermitReceipt: () => { throw new Error("Permit receipt must not be read"); },
  });
  assert.equal(result.kind, PRODUCTION_IDENTITY_PROOF_KINDS.EXACT_BASELINE);
});

test("verified lifecycle-only identity produces activated_lifecycle proof", () => {
  const promoted = identity();
  const current = structuredClone(promoted);
  current.lifecyclePointerSha256 = "9".repeat(64);
  const result = validateIdentityTransition({
    promoted,
    current,
    validateActivatedLifecycle: () => true,
  });
  assert.equal(result.kind, PRODUCTION_IDENTITY_PROOF_KINDS.ACTIVATED_LIFECYCLE);
});

test("verified Permit environment identity produces permit_transition proof", () => {
  const fixture = permitFixture();
  const result = validateIdentityTransition(fixture);
  assert.equal(result.kind, PRODUCTION_IDENTITY_PROOF_KINDS.PERMIT_TRANSITION);
});

test("Permit proof fails closed for every stable identity change", () => {
  for (const mutate of [
    (value) => { value.revision = "f".repeat(40); },
    (value) => { value.manifestSha256 = "f".repeat(64); },
    (value) => { value.releaseTreeSha256 = "f".repeat(64); },
    (value) => { value.images.api = `sha256:${"f".repeat(64)}`; },
  ]) {
    const fixture = permitFixture();
    mutate(fixture.current);
    assert.throws(() => validateIdentityTransition(fixture));
  }
});

test("Permit proof rejects status, SHA, digest, and runtime drift", () => {
  const mutations = [
    (fixture) => { fixture.permitReceipt.status = "failed"; },
    (fixture) => { fixture.permitReceipt.envBeforeSha256 = "f".repeat(64); },
    (fixture) => { fixture.permitReceipt.envAfterSha256 = "f".repeat(64); },
    (fixture) => { fixture.permitReceipt.permit.digest = "f".repeat(64); },
    (fixture) => { fixture.permitReceipt.runtimeAfter.api.imageDigest = `sha256:${"f".repeat(64)}`; },
  ];
  for (const mutate of mutations) {
    const fixture = permitFixture();
    mutate(fixture);
    assert.throws(() => validateIdentityTransition(fixture));
  }
});

function permitFixture() {
  const promoted = identity();
  const current = structuredClone(promoted);
  current.environmentSha256 = "3".repeat(64);
  const permit = {
    permitId: "4".repeat(32),
    ownerUserId: "USR-TEST",
    accountBindingSha256: "5".repeat(64),
    actionScope: ["READ", "TRADE"],
    executionMode: "single_connectivity_smoke",
    authorizationDigest: "6".repeat(64),
    approvedCapitalUsd: 40,
    expiresAt: "2026-08-07T12:00:00.000Z",
    revision: promoted.revision,
  };
  permit.digest = productionSelfTestPermitDigest(permit);
  const web = component("7", promoted.images.web, promoted.revision);
  return {
    promoted,
    current,
    permitReceipt: {
      schemaVersion: 2,
      status: "success",
      envBeforeSha256: promoted.environmentSha256,
      envAfterSha256: current.environmentSha256,
      releaseIdentity: {
        releaseRevision: promoted.revision,
        releaseTreeSha256: promoted.releaseTreeSha256,
        releaseManifestSha256: promoted.manifestSha256,
        apiImageDigest: promoted.images.api,
        webImageDigest: promoted.images.web,
      },
      permit,
      runtimeBefore: {
        api: component("8", promoted.images.api, promoted.revision),
        web,
      },
      runtimeAfter: {
        api: component("9", promoted.images.api, promoted.revision),
        web: structuredClone(web),
      },
    },
  };
}

function identity() {
  return {
    revision: "a".repeat(40),
    releaseTreeSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    environmentSha256: "1".repeat(64),
    lifecyclePointerSha256: "2".repeat(64),
    images: {
      api: `sha256:${"d".repeat(64)}`,
      web: `sha256:${"e".repeat(64)}`,
      strategyTools: `sha256:${"6".repeat(64)}`,
    },
    rootDev: 10,
    rootIno: 20,
  };
}

function component(character, imageDigest, revision) {
  return {
    containerId: character.repeat(64),
    imageDigest,
    revision,
    startedAt: "2026-08-07T09:00:00.000Z",
    running: true,
    health: "healthy",
  };
}
