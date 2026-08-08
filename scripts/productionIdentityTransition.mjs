import { createHash } from "node:crypto";

export const PRODUCTION_IDENTITY_PROOF_KINDS = Object.freeze({
  EXACT_BASELINE: "exact_baseline",
  ACTIVATED_LIFECYCLE: "activated_lifecycle",
  PERMIT_TRANSITION: "permit_transition",
});

export function validateIdentityTransition({
  promoted,
  current,
  permitReceipt,
  readPermitReceipt,
  validateActivatedLifecycle,
}) {
  if (!promoted || !current) {
    throw new Error("production identity transition evidence is incomplete");
  }
  if (canonical(promoted) === canonical(current)) {
    return proof(PRODUCTION_IDENTITY_PROOF_KINDS.EXACT_BASELINE);
  }

  if (canonicalWithoutLifecycle(promoted) === canonicalWithoutLifecycle(current)) {
    assertLifecycleContinuity(validateActivatedLifecycle);
    return proof(PRODUCTION_IDENTITY_PROOF_KINDS.ACTIVATED_LIFECYCLE);
  }

  const receipt = permitReceipt ?? readPermitReceipt?.();
  validatePermitTransition({
    promoted,
    current,
    receipt,
    validateActivatedLifecycle,
  });
  return proof(PRODUCTION_IDENTITY_PROOF_KINDS.PERMIT_TRANSITION);
}

/** @deprecated Use the canonical production promotion guard. */
export function validatePermitInstalledTransition(input) {
  return validateIdentityTransition({
    ...input,
    permitReceipt: input.receipt,
  }).kind === PRODUCTION_IDENTITY_PROOF_KINDS.PERMIT_TRANSITION;
}

export function productionSelfTestPermitDigest(input) {
  return createHash("sha256").update(Buffer.from([
    "production", "binance", "xaut", input.permitId, input.ownerUserId,
    input.accountBindingSha256, "READ", "TRADE", input.executionMode,
    input.authorizationDigest, String(input.approvedCapitalUsd), input.revision,
    input.expiresAt,
  ].join(":"))).digest("hex");
}

function validatePermitTransition({ promoted, current, receipt, validateActivatedLifecycle }) {
  if (!receipt || receipt.schemaVersion !== 2 || receipt.status !== "success") {
    throw new Error("Permit environment transition receipt is missing or incomplete");
  }
  const release = receipt.releaseIdentity;
  const permit = receipt.permit;
  if (!release || !permit
    || receipt.envBeforeSha256 !== promoted.environmentSha256
    || receipt.envAfterSha256 !== current.environmentSha256
    || receipt.envBeforeSha256 === receipt.envAfterSha256) {
    throw new Error("Permit environment transition identity mismatch");
  }

  const lifecycleChanged = promoted.lifecyclePointerSha256 !== current.lifecyclePointerSha256;
  const stablePromoted = lifecycleChanged
    ? withoutEnvironmentAndLifecycle(promoted)
    : withoutEnvironment(promoted);
  const stableCurrent = lifecycleChanged
    ? withoutEnvironmentAndLifecycle(current)
    : withoutEnvironment(current);
  if (canonical(stablePromoted) !== canonical(stableCurrent)) {
    throw new Error("Permit environment transition changed the stable promotion identity");
  }
  if (lifecycleChanged) assertLifecycleContinuity(validateActivatedLifecycle);

  if (release.releaseRevision !== current.revision
    || release.releaseTreeSha256 !== current.releaseTreeSha256
    || release.releaseManifestSha256 !== current.manifestSha256
    || release.apiImageDigest !== current.images?.api
    || release.webImageDigest !== current.images?.web
    || permit.revision !== release.releaseRevision) {
    throw new Error("Permit environment transition release identity mismatch");
  }
  if (permit.executionMode !== "single_connectivity_smoke"
    || permit.approvedCapitalUsd !== 40
    || permit.digest !== productionSelfTestPermitDigest(permit)) {
    throw new Error("Permit environment transition digest mismatch");
  }

  validateRuntimeIdentity(receipt.runtimeBefore, release, "before");
  validateRuntimeIdentity(receipt.runtimeAfter, release, "after");
  if (canonical(receipt.runtimeBefore.web) !== canonical(receipt.runtimeAfter.web)
    || receipt.runtimeBefore.api.containerId === receipt.runtimeAfter.api.containerId) {
    throw new Error("Permit environment transition runtime identity mismatch");
  }
}

function validateRuntimeIdentity(snapshot, release, phase) {
  if (!snapshot?.api || !snapshot?.web) {
    throw new Error(`Permit environment transition runtime ${phase} receipt is missing`);
  }
  for (const [name, expectedImage] of [
    ["api", release.apiImageDigest],
    ["web", release.webImageDigest],
  ]) {
    const component = snapshot[name];
    if (component.revision !== release.releaseRevision
      || component.imageDigest !== expectedImage
      || component.running !== true
      || component.health !== "healthy"
      || typeof component.containerId !== "string"
      || component.containerId.length < 12) {
      throw new Error(`Permit environment transition runtime ${phase} identity mismatch`);
    }
  }
}

function assertLifecycleContinuity(validateActivatedLifecycle) {
  if (typeof validateActivatedLifecycle !== "function"
    || validateActivatedLifecycle() !== true) {
    throw new Error("production identity transition lifecycle continuity mismatch");
  }
}

function proof(kind) {
  return Object.freeze({ kind });
}

function canonicalWithoutLifecycle(value) {
  const { lifecyclePointerSha256: _lifecyclePointerSha256, ...identity } = value;
  return canonical(identity);
}

function withoutEnvironment(value) {
  const { environmentSha256: _environmentSha256, ...identity } = value;
  return identity;
}

function withoutEnvironmentAndLifecycle(value) {
  const {
    environmentSha256: _environmentSha256,
    lifecyclePointerSha256: _lifecyclePointerSha256,
    ...identity
  } = value;
  return identity;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
