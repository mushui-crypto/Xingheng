import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCapitalTestWindowLaunchIdentity,
  validatePermitInstalledTransition,
} from "./capitalTestWindowLaunchIdentity.mjs";
import { productionSelfTestPermitDigest } from "./productionSelfTestPermitInstall.mjs";
import {
  PRODUCTION_IDENTITY_PROOF_KINDS,
  validateIdentityTransition,
} from "./productionIdentityTransition.mjs";

test("Capital Test Window requires the Permit transition proof kind", () => {
  assert.throws(() => assertCapitalTestWindowLaunchIdentity({
    verifyPromotion: (options) => {
      assert.equal(
        options.requiredProofKind,
        PRODUCTION_IDENTITY_PROOF_KINDS.PERMIT_TRANSITION,
      );
      throw new Error("Permit transition proof is required");
    },
  }), /Permit transition proof is required/u);
});

test("valid Permit environment transition is accepted", () => {
  const fixture = transitionFixture();
  assert.equal(validatePermitInstalledTransition(fixture), true);
  assert.equal(assertCapitalTestWindowLaunchIdentity({
    verifyPromotion: (options) => validateIdentityTransition({
      ...fixture,
      permitReceipt: options.readPermitReceipt(),
    }).kind === options.requiredProofKind,
    readReceipt: () => fixture.receipt,
  }), true);
});

test("combined active lifecycle and Permit environment transition is accepted", () => {
  const fixture = transitionFixture();
  fixture.current.lifecyclePointerSha256 = "4".repeat(64);
  let lifecycleValidated = false;
  assert.equal(validatePermitInstalledTransition({
    ...fixture,
    validateActivatedLifecycle: () => {
      lifecycleValidated = true;
      return true;
    },
  }), true);
  assert.equal(lifecycleValidated, true);
});

test("combined Permit transition rejects invalid lifecycle continuity", () => {
  const fixture = transitionFixture();
  fixture.current.lifecyclePointerSha256 = "4".repeat(64);
  assert.throws(() => validatePermitInstalledTransition({
    ...fixture,
    validateActivatedLifecycle: () => false,
  }), /lifecycle continuity mismatch/u);
});

test("invalid environment mutation is rejected", () => {
  const fixture = transitionFixture();
  fixture.current.environmentSha256 = "f".repeat(64);
  assert.throws(
    () => validatePermitInstalledTransition(fixture),
    /environment transition identity mismatch/u,
  );
});

test("Permit digest mismatch is rejected", () => {
  const fixture = transitionFixture();
  fixture.receipt.permit.digest = "f".repeat(64);
  assert.throws(
    () => validatePermitInstalledTransition(fixture),
    /digest mismatch/u,
  );
});

test("missing Permit transition receipt is rejected", () => {
  const fixture = transitionFixture();
  assert.throws(() => assertCapitalTestWindowLaunchIdentity({
    verifyPromotion: (options) => validateIdentityTransition({
      ...fixture,
      permitReceipt: options.readPermitReceipt(),
    }),
    readReceipt: () => { throw Object.assign(new Error("missing receipt"), { code: "ENOENT" }); },
  }), /missing receipt/u);
});

function transitionFixture() {
  const releaseRevision = "a".repeat(40);
  const releaseTreeSha256 = "b".repeat(64);
  const releaseManifestSha256 = "c".repeat(64);
  const apiImageDigest = `sha256:${"d".repeat(64)}`;
  const webImageDigest = `sha256:${"e".repeat(64)}`;
  const promoted = {
    revision: releaseRevision,
    releaseTreeSha256,
    manifestSha256: releaseManifestSha256,
    environmentSha256: "1".repeat(64),
    lifecyclePointerSha256: "2".repeat(64),
    images: { api: apiImageDigest, web: webImageDigest, strategyTools: `sha256:${"6".repeat(64)}` },
    rootDev: 10,
    rootIno: 20,
  };
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
    revision: releaseRevision,
  };
  permit.digest = productionSelfTestPermitDigest(permit);
  const web = runtimeComponent("7", webImageDigest, releaseRevision);
  const runtimeBefore = {
    capturedAt: "2026-08-07T10:00:00.000Z",
    api: runtimeComponent("8", apiImageDigest, releaseRevision),
    web,
  };
  const runtimeAfter = {
    capturedAt: "2026-08-07T10:01:00.000Z",
    api: runtimeComponent("9", apiImageDigest, releaseRevision),
    web: structuredClone(web),
  };
  return {
    promoted,
    current,
    receipt: {
      schemaVersion: 2,
      status: "success",
      envBeforeSha256: promoted.environmentSha256,
      envAfterSha256: current.environmentSha256,
      releaseIdentity: {
        releaseRevision,
        releaseTreeSha256,
        releaseManifestSha256,
        apiImageDigest,
        webImageDigest,
      },
      permit,
      runtimeBefore,
      runtimeAfter,
    },
  };
}

function runtimeComponent(containerCharacter, imageDigest, revision) {
  return {
    containerId: containerCharacter.repeat(64),
    imageDigest,
    revision,
    startedAt: "2026-08-07T09:00:00.000Z",
    running: true,
    health: "healthy",
  };
}
