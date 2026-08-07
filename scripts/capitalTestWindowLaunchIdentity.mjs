import {
  assertPromotionStateAllowsProductionWithTransition,
} from "./releasePromotionTransaction.mjs";
import {
  PERMIT_INSTALL_RECEIPT,
  productionSelfTestPermitDigest,
  readInstallReceipt,
} from "./productionSelfTestPermitInstall.mjs";

export function assertCapitalTestWindowLaunchIdentity(options = {}) {
  const verifyPromotion = options.verifyPromotion
    ?? assertPromotionStateAllowsProductionWithTransition;
  const readReceipt = options.readReceipt ?? readInstallReceipt;
  return verifyPromotion(
    ({ promoted, current, validateActivatedLifecycle }) => validatePermitInstalledTransition({
      promoted,
      current,
      validateActivatedLifecycle,
      receipt: readReceipt(options.receiptPath ?? PERMIT_INSTALL_RECEIPT, options.receiptOptions),
    }),
    options.promotionOptions,
  );
}

export function validatePermitInstalledTransition({
  promoted,
  current,
  receipt,
  validateActivatedLifecycle,
}) {
  if (!promoted || !current || !receipt || receipt.status !== "success") {
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
  if (lifecycleChanged
    && (typeof validateActivatedLifecycle !== "function"
      || validateActivatedLifecycle() !== true)) {
    throw new Error("Permit environment transition lifecycle continuity mismatch");
  }
  if (
    release.releaseRevision !== current.revision
    || release.releaseTreeSha256 !== current.releaseTreeSha256
    || release.releaseManifestSha256 !== current.manifestSha256
    || release.apiImageDigest !== current.images?.api
    || release.webImageDigest !== current.images?.web
    || permit.revision !== release.releaseRevision
  ) throw new Error("Permit environment transition release identity mismatch");
  if (permit.digest !== productionSelfTestPermitDigest(permit)) {
    throw new Error("Permit environment transition digest mismatch");
  }
  validateRuntimeIdentity(receipt.runtimeBefore, release, "before");
  validateRuntimeIdentity(receipt.runtimeAfter, release, "after");
  if (canonical(receipt.runtimeBefore.web) !== canonical(receipt.runtimeAfter.web)
    || receipt.runtimeBefore.api.containerId === receipt.runtimeAfter.api.containerId) {
    throw new Error("Permit environment transition runtime identity mismatch");
  }
  return true;
}

function validateRuntimeIdentity(snapshot, release, phase) {
  if (!snapshot || !snapshot.api || !snapshot.web) {
    throw new Error(`Permit environment transition runtime ${phase} receipt is missing`);
  }
  if (snapshot.api.revision !== release.releaseRevision
    || snapshot.web.revision !== release.releaseRevision
    || snapshot.api.imageDigest !== release.apiImageDigest
    || snapshot.web.imageDigest !== release.webImageDigest) {
    throw new Error(`Permit environment transition runtime ${phase} identity mismatch`);
  }
}

function withoutEnvironment(identity) {
  const { environmentSha256: _environmentSha256, ...stableIdentity } = identity;
  return stableIdentity;
}

function withoutEnvironmentAndLifecycle(identity) {
  const {
    environmentSha256: _environmentSha256,
    lifecyclePointerSha256: _lifecyclePointerSha256,
    ...stableIdentity
  } = identity;
  return stableIdentity;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
