#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchownSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseManifest } from "./deploymentRevision.mjs";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import {
  assertTrustedProductionReleaseRoot,
  createTrustedPermitPreparedDockerContext,
  execTrustedDockerSync,
} from "./trustedDockerRuntime.mjs";
import {
  PERMIT_RECOVERY_ROOT,
  assertCompletedPermitRecovery,
} from "./productionSelfTestPermitRecovery.mjs";

export const PERMIT_INSTALL_RECEIPT = "/var/lib/xingheng/production-self-test-permit-install.json";
export const AUTHORIZATION_MANIFEST = "/var/lib/xingheng/capital-test-authorization-manifest.json";
export const PERMIT_INSTALL_ATTEMPTS = "/var/lib/xingheng/production-self-test-permit-attempts";
export const RELEASE_LIFECYCLE_POINTER = "/var/lib/xingheng/release-lifecycle/current.json";
export const RELEASE_LIFECYCLE_OPERATIONS = "/var/lib/xingheng/release-lifecycle/operations";
export const PERMIT_INSTALL_WRAPPER = "/opt/xingheng-release/code/scripts/install-production-self-test-permit.sh";
export const TRUSTED_OPERATION_LAUNCHER = "/opt/xingheng-release/code/scripts/trusted-operation-launcher.mjs";
export const PERMIT_ENV_KEYS = Object.freeze([
  "RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_DIGEST",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD",
  "RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT",
]);

const REQUEST_KEYS = [
  "accountBindingSha256", "actionScope", "approvedCapitalUsd",
  "apiImageDigest", "authorizationManifestSha256", "executionMode", "gitTreeSha",
  "leverage",
  "maximumDurationMinutes", "maximumExecutionDurationMinutes", "ownerUserId",
  "permitId", "releaseManifestSha256", "releaseRevision", "releaseTreeSha256",
  "schemaVersion", "webImageDigest",
];
const RECEIPT_KEYS = [
  "activatedAt", "attemptReceiptSha256", "envAfterSha256", "envBeforeSha256",
  "expiresAt", "operationId", "permit", "releaseIdentity", "request", "runtimeAfter",
  "runtimeBefore", "schemaVersion", "status", "updatedAt",
];
const ATTEMPT_RECEIPT_KEYS = RECEIPT_KEYS.filter((key) => key !== "attemptReceiptSha256");
const PERMIT_KEYS = [
  "accountBindingSha256", "actionScope", "approvedCapitalUsd", "authorizationDigest",
  "digest", "executionMode", "expiresAt", "ownerUserId", "permitId", "revision",
];
const EXECUTION_MODE = "single_connectivity_smoke";
const RELEASE_IDENTITY_KEYS = [
  "apiImageDigest", "gitTreeSha", "lifecycleEstablishedAt", "lifecycleOperationId",
  "releaseManifestSha256", "releaseRevision", "releaseTreeSha256", "webImageDigest",
];
const AUTHORIZATION_KEYS = REQUEST_KEYS.filter((key) => key !== "authorizationManifestSha256");
const RUNTIME_KEYS = ["api", "capturedAt", "web"];
const RUNTIME_COMPONENT_KEYS = [
  "containerId", "health", "imageDigest", "revision", "running", "startedAt",
];

export function parseInstallRequest(value) {
  const input = assertObject(value, "Permit install request is invalid");
  assertExactKeys(input, REQUEST_KEYS, "Permit install request contains unsupported fields");
  if (
    input.schemaVersion !== 2
    || typeof input.permitId !== "string" || !/^[a-f0-9]{32}$/u.test(input.permitId)
    || typeof input.ownerUserId !== "string" || !/^USR-[A-Z0-9]+$/u.test(input.ownerUserId)
    || typeof input.accountBindingSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.accountBindingSha256)
    || !Array.isArray(input.actionScope) || input.actionScope.length !== 2
    || input.actionScope[0] !== "READ" || input.actionScope[1] !== "TRADE"
    || typeof input.authorizationManifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(input.authorizationManifestSha256)
    || typeof input.gitTreeSha !== "string" || !/^[a-f0-9]{40}$/u.test(input.gitTreeSha)
    || typeof input.releaseTreeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.releaseTreeSha256)
    || typeof input.releaseManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.releaseManifestSha256)
    || typeof input.apiImageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.apiImageDigest)
    || typeof input.webImageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.webImageDigest)
    || input.approvedCapitalUsd !== 40
    || input.leverage !== 1
    || input.executionMode !== EXECUTION_MODE
    || input.maximumDurationMinutes !== 60
    || input.maximumExecutionDurationMinutes !== 30
    || typeof input.releaseRevision !== "string" || !/^[a-f0-9]{40}$/u.test(input.releaseRevision)
  ) throw new Error("Permit install request is invalid");
  return input;
}

export function parseCanonicalAuthorization(value) {
  const authorization = assertObject(value, "Canonical authorization manifest is invalid");
  assertExactKeys(authorization, AUTHORIZATION_KEYS, "Canonical authorization manifest is invalid");
  parseInstallRequest({
    ...authorization,
    authorizationManifestSha256: "0".repeat(64),
  });
  return authorization;
}

export function productionSelfTestPermitDigest(input) {
  return sha256(Buffer.from([
    "production", "binance", "xaut", input.permitId, input.ownerUserId,
    input.accountBindingSha256, "READ", "TRADE", input.executionMode, input.authorizationDigest,
    String(input.approvedCapitalUsd), input.revision, input.expiresAt,
  ].join(":")));
}

export function preparePermitInstallation(options) {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Trusted UTC is invalid");
  const request = parseInstallRequest(options.request);
  const paths = installPaths(options);
  assertNoTerminalReceipt(paths, options);
  const releaseManifestBytes = readSecureFile(paths.releaseManifestPath, 16 * 1024, 0o444, options);
  const authorizationBytes = readSecureFile(paths.authorizationManifestPath, 1024 * 1024, 0o400, options);
  try {
    const releaseManifest = validateReleaseManifest(JSON.parse(releaseManifestBytes.toString("utf8")));
    const authorization = parseCanonicalAuthorization(JSON.parse(authorizationBytes.toString("utf8")));
    if (sha256(authorizationBytes) !== request.authorizationManifestSha256) {
      throw new Error("Canonical authorization manifest identity mismatch");
    }
    const { authorizationManifestSha256: _digest, ...requestSemantics } = request;
    if (canonicalJson(authorization) !== canonicalJson(requestSemantics)) {
      throw new Error("Canonical authorization semantics do not match the install request");
    }
    const releaseIdentity = resolveReleaseIdentity({
      request,
      releaseManifest,
      releaseManifestSha256: sha256(releaseManifestBytes),
      paths,
      options,
    });
    const activatedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    const permit = {
      permitId: request.permitId,
      ownerUserId: request.ownerUserId,
      accountBindingSha256: request.accountBindingSha256,
      actionScope: ["READ", "TRADE"],
      executionMode: request.executionMode,
      authorizationDigest: request.authorizationManifestSha256,
      approvedCapitalUsd: 40,
      expiresAt,
      revision: request.releaseRevision,
    };
    permit.digest = productionSelfTestPermitDigest(permit);
    const environmentBytes = readSecureFile(paths.environmentPath, 1024 * 1024, 0o600, options);
    try {
      const envBeforeSha256 = sha256(environmentBytes);
      const proposed = installPermitEnvironment(environmentBytes, permit);
      const operationId = options.operationId ?? randomBytes(16).toString("hex");
      if (!/^[a-f0-9]{32}$/u.test(operationId)) throw new Error("Permit install operation ID is invalid");
      const attemptDir = resolve(paths.attemptsRoot, operationId);
      ensureDirectory(paths.stateRoot, 0o700, options);
      ensureDirectory(paths.attemptsRoot, 0o700, options);
      ensureDirectory(attemptDir, 0o700, options);
      const beforePath = resolve(attemptDir, "environment.before");
      const proposedPath = resolve(attemptDir, "environment.proposed");
      atomicWrite(beforePath, environmentBytes, 0o600, options);
      atomicWrite(proposedPath, proposed, 0o600, options);
      const attemptReceipt = {
        schemaVersion: 2,
        operationId,
        status: "prepared",
        request,
        permit,
        releaseIdentity,
        runtimeBefore: null,
        runtimeAfter: null,
        activatedAt,
        expiresAt,
        envBeforeSha256,
        envAfterSha256: sha256(proposed),
        updatedAt: activatedAt,
      };
      const attemptReceiptBytes = Buffer.from(`${JSON.stringify(attemptReceipt)}\n`);
      atomicWrite(resolve(attemptDir, "attempt-receipt.json"), attemptReceiptBytes, 0o400, options);
      const receipt = {
        ...attemptReceipt,
        attemptReceiptSha256: sha256(attemptReceiptBytes),
      };
      atomicWrite(paths.receiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`), 0o400, options);
      try {
        replaceEnvironment(
          proposedPath,
          paths.environmentPath,
          receipt.envAfterSha256,
          receipt.envBeforeSha256,
          options,
        );
        return receipt;
      } catch (error) {
        markPreparedReceiptUnknown(paths.receiptPath, receipt, options.now ?? new Date(), options);
        throw error;
      }
    } finally {
      environmentBytes.fill(0);
    }
  } finally {
    releaseManifestBytes.fill(0);
    authorizationBytes.fill(0);
  }
}

export function finalizePermitInstallation(status, operationId, options = {}) {
  if (!new Set(["success", "failed", "unknown"]).has(status)) throw new Error("Permit install terminal status is invalid");
  if (!/^[a-f0-9]{32}$/u.test(operationId)) throw new Error("Permit install operation ID is invalid");
  const paths = installPaths(options);
  const receipt = readInstallReceipt(paths.receiptPath, options);
  if (receipt.operationId !== operationId || receipt.status !== "prepared") {
    throw new Error("Permit install operation is not prepared");
  }
  let terminalStatus = status;
  if (status === "success" && receipt.runtimeAfter === null) terminalStatus = "unknown";
  const currentEnvironmentSha256 = secureFileSha256(paths.environmentPath, 1024 * 1024, 0o600, options);
  if (status === "success" && currentEnvironmentSha256 !== receipt.envAfterSha256) {
    terminalStatus = "unknown";
  } else if (status === "failed") {
    if (currentEnvironmentSha256 === receipt.envAfterSha256) {
      const beforePath = resolve(paths.attemptsRoot, operationId, "environment.before");
      try {
        replaceEnvironment(
          beforePath,
          paths.environmentPath,
          receipt.envBeforeSha256,
          receipt.envAfterSha256,
          options,
        );
      } catch {
        terminalStatus = "unknown";
      }
    } else if (currentEnvironmentSha256 !== receipt.envBeforeSha256) {
      terminalStatus = "unknown";
    }
  }
  const terminal = {
    ...receipt,
    status: terminalStatus,
    updatedAt: strictUtc(options.now ?? new Date(), "Permit install terminal time is invalid"),
  };
  atomicReplace(paths.receiptPath, Buffer.from(`${JSON.stringify(terminal)}\n`), 0o400, options);
  if (terminalStatus !== status) throw new Error("Permit installation outcome is UNKNOWN");
  return terminal;
}

export function captureRuntimeBefore(operationId, options = {}) {
  const paths = installPaths(options);
  const receipt = readInstallReceipt(paths.receiptPath, options);
  if (receipt.operationId !== operationId || receipt.status !== "prepared"
    || receipt.runtimeBefore !== null || receipt.runtimeAfter !== null) {
    throw new Error("Permit runtime snapshot is not eligible");
  }
  revalidateReleaseIdentity(receipt, paths, options);
  const runtimeBefore = captureRuntimeSnapshot(receipt, options);
  const updated = {
    ...receipt,
    runtimeBefore,
    updatedAt: strictUtc(options.now ?? new Date(), "Permit runtime snapshot time is invalid"),
  };
  atomicReplace(paths.receiptPath, Buffer.from(`${JSON.stringify(updated)}\n`), 0o400, options);
  return updated;
}

export function verifyAndRecordRuntimeAfter(operationId, options = {}) {
  const paths = installPaths(options);
  const receipt = readInstallReceipt(paths.receiptPath, options);
  if (receipt.operationId !== operationId || receipt.status !== "prepared"
    || receipt.runtimeBefore === null || receipt.runtimeAfter !== null) {
    throw new Error("Permit runtime verification is not eligible");
  }
  revalidateReleaseIdentity(receipt, paths, options);
  const runtimeAfter = captureRuntimeAfterWithWait(receipt, options);
  assertWebUnchanged(receipt.runtimeBefore.web, runtimeAfter.web);
  if (runtimeAfter.api.containerId === receipt.runtimeBefore.api.containerId) {
    throw new Error("Permit API container was not rebuilt");
  }
  verifyApiLoadedPermit(receipt, runtimeAfter.api.containerId, options);
  const updated = {
    ...receipt,
    runtimeAfter,
    updatedAt: strictUtc(options.now ?? new Date(), "Permit runtime verification time is invalid"),
  };
  atomicReplace(paths.receiptPath, Buffer.from(`${JSON.stringify(updated)}\n`), 0o400, options);
  return updated;
}

function captureRuntimeAfterWithWait(receipt, options) {
  const attempts = options.runtimeHealthAttempts ?? (options.docker ? 1 : 60);
  const waitMilliseconds = options.runtimeHealthWaitMilliseconds ?? 1_000;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return captureRuntimeSnapshot(receipt, options);
    } catch (error) {
      lastError = error;
      if (error?.code !== "PERMIT_API_HEALTH_STARTING" || attempt + 1 >= attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMilliseconds);
    }
  }
  throw lastError ?? new Error("Permit API health verification timed out");
}

export function captureRuntimeSnapshot(receipt, options = {}) {
  const docker = options.docker ?? productionDocker;
  const components = {};
  for (const [service, expectedImage] of [
    ["api", receipt.releaseIdentity.apiImageDigest],
    ["web", receipt.releaseIdentity.webImageDigest],
  ]) {
    const ids = docker([
      "ps", "-a",
      "--filter", "label=com.docker.compose.project=xingheng",
      "--filter", `label=com.docker.compose.service=${service}`,
      "--format", "{{.ID}}",
    ]).trim().split(/\s+/u).filter(Boolean);
    if (ids.length !== 1) throw new Error("Permit runtime container set is invalid");
    const inspected = JSON.parse(docker(["container", "inspect", ids[0]]));
    if (!Array.isArray(inspected) || inspected.length !== 1) {
      throw new Error("Permit runtime container inspection is invalid");
    }
    const container = inspected[0];
    const revision = container?.Config?.Labels?.["org.opencontainers.image.revision"];
    const component = {
      containerId: String(container?.Id ?? ""),
      imageDigest: String(container?.Image ?? ""),
      revision: String(revision ?? ""),
      startedAt: normalizeUtc(String(container?.State?.StartedAt ?? "")),
      running: container?.State?.Running === true,
      health: String(container?.State?.Health?.Status ?? ""),
    };
    if (component.imageDigest !== expectedImage
      || component.revision !== receipt.releaseIdentity.releaseRevision) {
      throw new Error("Permit runtime release identity mismatch");
    }
    components[service] = component;
  }
  const snapshot = {
    capturedAt: strictUtc(options.now ?? new Date(), "Permit runtime snapshot time is invalid"),
    api: components.api,
    web: components.web,
  };
  if (snapshot.api.running && snapshot.api.health === "starting"
    && snapshot.web.running && snapshot.web.health === "healthy") {
    const error = new Error("Permit API health verification is still starting");
    error.code = "PERMIT_API_HEALTH_STARTING";
    throw error;
  }
  return validateRuntimeSnapshot(snapshot);
}

function verifyApiLoadedPermit(receipt, apiContainerId, options) {
  const docker = options.docker ?? productionDocker;
  const inspected = JSON.parse(docker(["container", "inspect", apiContainerId]));
  const environment = new Map((inspected?.[0]?.Config?.Env ?? []).map((entry) => {
    const offset = entry.indexOf("=");
    return [entry.slice(0, offset), entry.slice(offset + 1)];
  }));
  for (const [key, value] of permitEnvironment(receipt.permit)) {
    if (environment.get(key) !== value) throw new Error("API container Permit identity mismatch");
  }
  const result = docker([
    "exec", apiContainerId, "node",
    "/app/scripts/verify-production-self-test-permit-state.mjs",
    receipt.request.ownerUserId,
    "runtime",
    receipt.permit.digest,
    receipt.releaseIdentity.releaseRevision,
    receipt.request.authorizationManifestSha256,
    receipt.expiresAt,
    receipt.permit.executionMode,
  ]).trim();
  if (result !== "permit-runtime-safe") throw new Error("API process Permit identity mismatch");
}

function assertWebUnchanged(before, after) {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error("Web container identity changed during Permit installation");
  }
}

function productionDocker(args) {
  return execTrustedDockerSync(args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function revalidateReleaseIdentity(receipt, paths, options) {
  if (options.releaseIdentity !== undefined) {
    validateReleaseIdentity(options.releaseIdentity, receipt.request);
    return;
  }
  const manifestBytes = readSecureFile(paths.releaseManifestPath, 16 * 1024, 0o444, options);
  try {
    const manifest = validateReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
    const current = resolveReleaseIdentity({
      request: receipt.request,
      releaseManifest: manifest,
      releaseManifestSha256: sha256(manifestBytes),
      paths,
      options,
    });
    if (canonicalJson(current) !== canonicalJson(receipt.releaseIdentity)) {
      throw new Error("Permit release identity changed after preparation");
    }
  } finally { manifestBytes.fill(0); }
}

export function assertPermitEnvironmentAuthorized(input) {
  const present = PERMIT_ENV_KEYS.filter((key) => input.entries.has(key));
  if (present.length === 0) return Object.freeze({ state: "absent" });
  if (present.length !== PERMIT_ENV_KEYS.length) throw new Error("Production self-test Permit environment is incomplete");
  const receiptOptions = input.options ?? {};
  const receipt = readInstallReceipt(input.receiptPath ?? PERMIT_INSTALL_RECEIPT, receiptOptions);
  revalidateReleaseIdentity(receipt, installPaths(receiptOptions), receiptOptions);
  if (receipt.status === "unknown") throw new Error("Production self-test Permit installation is UNKNOWN");
  const prepared = receipt.status === "prepared"
    && input.operationEntry === "install-production-self-test-permit.sh"
    && input.operationId === receipt.operationId
    && isPermitInstallComposeOperation(input.composeArgs, receipt.request.ownerUserId);
  if (receipt.status !== "success" && !prepared) {
    throw new Error("Production self-test Permit installation receipt is not active");
  }
  if (input.environmentSha256 !== receipt.envAfterSha256) {
    throw new Error("Production self-test Permit environment identity mismatch");
  }
  const expected = permitEnvironment(receipt.permit);
  for (const [key, value] of expected) {
    if (input.entries.get(key) !== value) throw new Error("Production self-test Permit environment does not match its receipt");
  }
  return Object.freeze({
    state: prepared ? "prepared" : "active",
    operationId: receipt.operationId,
    receiptSha256: secureFileSha256(
      input.receiptPath ?? PERMIT_INSTALL_RECEIPT,
      64 * 1024,
      0o400,
      receiptOptions,
    ),
  });
}

export function assertPermitPreparedTransientContext(input) {
  const operationId = input.operationId ?? "";
  const trusted = assertTrustedMutationContext(operationId);
  const paths = installPaths(input.options ?? {});
  const receipt = readInstallReceipt(paths.receiptPath, input.options ?? {});
  if (receipt.status !== "prepared"
    || input.operationEntry !== "install-production-self-test-permit.sh"
    || operationId !== receipt.operationId
    || !isPermitInstallComposeOperation(input.composeArgs, receipt.request.ownerUserId)) {
    throw new Error("Permit prepared transient context is not authorized");
  }
  revalidateReleaseIdentity(receipt, paths, input.options ?? {});
  const lifecycle = readLifecycleIdentity(paths);
  if (lifecycle.environmentSha256 !== receipt.envBeforeSha256
    || lifecycle.revision !== receipt.releaseIdentity.releaseRevision
    || lifecycle.manifestSha256 !== receipt.releaseIdentity.releaseManifestSha256
    || lifecycle.images.api !== receipt.releaseIdentity.apiImageDigest
    || lifecycle.images.web !== receipt.releaseIdentity.webImageDigest) {
    throw new Error("Permit prepared transient lifecycle identity mismatch");
  }
  const environmentSha256 = secureFileSha256(
    input.environmentPath ?? paths.environmentPath,
    1024 * 1024,
    0o600,
    input.options ?? {},
  );
  if (environmentSha256 !== receipt.envAfterSha256
    || receipt.envBeforeSha256 === receipt.envAfterSha256) {
    throw new Error("Permit prepared transient environment identity mismatch");
  }
  const authorizationManifestSha256 = secureFileSha256(
    paths.authorizationManifestPath,
    1024 * 1024,
    0o400,
    input.options ?? {},
  );
  if (authorizationManifestSha256 !== receipt.request.authorizationManifestSha256
    || receipt.permit.authorizationDigest !== authorizationManifestSha256) {
    throw new Error("Permit prepared transient authorization binding mismatch");
  }
  const receiptSha256 = secureFileSha256(
    paths.receiptPath,
    64 * 1024,
    0o400,
    input.options ?? {},
  );
  const confirmedReceipt = readInstallReceipt(paths.receiptPath, input.options ?? {});
  if (canonicalJson(confirmedReceipt) !== canonicalJson(receipt)) {
    throw new Error("Permit prepared transient receipt changed during validation");
  }
  return createTrustedPermitPreparedDockerContext(Object.freeze({
    schemaVersion: 1,
    kind: "permit-prepared-transient",
    operationId,
    operationLockContext: "production",
    receiptSha256,
    attemptReceiptSha256: receipt.attemptReceiptSha256,
    environmentBeforeSha256: receipt.envBeforeSha256,
    environmentAfterSha256: receipt.envAfterSha256,
    releaseIdentitySha256: sha256(Buffer.from(canonicalJson(receipt.releaseIdentity))),
    authorizationManifestSha256,
    wrapperIdentity: trusted.wrapperIdentity,
    launcherIdentity: trusted.launcherIdentity,
    operationLocks: trusted.operationLocks,
  }), process.env);
}

export function readInstallReceipt(path = PERMIT_INSTALL_RECEIPT, options = {}) {
  const bytes = readSecureFile(path, 64 * 1024, 0o400, options);
  try {
    const receipt = assertObject(JSON.parse(bytes.toString("utf8")), "Permit install receipt is invalid");
    assertExactKeys(receipt, RECEIPT_KEYS, "Permit install receipt is invalid");
    parseInstallRequest(receipt.request);
    if (
      receipt.schemaVersion !== 2
      || typeof receipt.operationId !== "string" || !/^[a-f0-9]{32}$/u.test(receipt.operationId)
      || !["prepared", "success", "failed", "unknown"].includes(receipt.status)
      || !isStrictUtc(receipt.activatedAt) || !isStrictUtc(receipt.expiresAt)
      || Date.parse(receipt.expiresAt) - Date.parse(receipt.activatedAt) !== 60 * 60_000
      || !isStrictUtc(receipt.updatedAt)
      || typeof receipt.attemptReceiptSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(receipt.attemptReceiptSha256)
      || typeof receipt.envBeforeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.envBeforeSha256)
      || typeof receipt.envAfterSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.envAfterSha256)
    ) throw new Error("Permit install receipt is invalid");
    validateReleaseIdentity(receipt.releaseIdentity, receipt.request);
    validateRuntimeSnapshot(receipt.runtimeBefore, true);
    validateRuntimeSnapshot(receipt.runtimeAfter, true);
    validateReceiptRuntimeRelationship(receipt);
    validateAttemptReceipt(receipt, options);
    const permit = assertObject(receipt.permit, "Permit install receipt is invalid");
    assertExactKeys(permit, PERMIT_KEYS, "Permit install receipt is invalid");
    if (
      permit.permitId !== receipt.request.permitId
      || permit.ownerUserId !== receipt.request.ownerUserId
      || permit.accountBindingSha256 !== receipt.request.accountBindingSha256
      || !Array.isArray(permit.actionScope) || permit.actionScope.length !== 2
      || permit.actionScope[0] !== "READ" || permit.actionScope[1] !== "TRADE"
      || permit.executionMode !== EXECUTION_MODE
      || permit.executionMode !== receipt.request.executionMode
      || permit.authorizationDigest !== receipt.request.authorizationManifestSha256
      || permit.approvedCapitalUsd !== 40
      || permit.expiresAt !== receipt.expiresAt
      || permit.revision !== receipt.request.releaseRevision
      || typeof permit.digest !== "string" || !/^[a-f0-9]{64}$/u.test(permit.digest)
      || permit.digest !== productionSelfTestPermitDigest(permit)
    ) throw new Error("Permit install receipt digest is invalid");
    return receipt;
  } finally {
    bytes.fill(0);
  }
}

function installPermitEnvironment(source, permit) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const lines = text.split(/\r?\n/u);
  for (const line of lines) {
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/u.exec(line.trim());
    if (match && PERMIT_ENV_KEYS.includes(match[1])) throw new Error("Production environment already contains a self-test Permit");
  }
  const suffix = text.endsWith("\n") ? "" : "\n";
  return Buffer.from(`${text}${suffix}${[...permitEnvironment(permit)].map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function permitEnvironment(permit) {
  return new Map([
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED", "true"],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID", permit.permitId],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID", permit.ownerUserId],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256", permit.accountBindingSha256],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE", '["READ","TRADE"]'],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE", permit.executionMode],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST", permit.authorizationDigest],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_DIGEST", permit.digest],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD", String(permit.approvedCapitalUsd)],
    ["RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT", permit.expiresAt],
  ]);
}

function installPaths(options) {
  const stateRoot = resolve(options.stateRoot ?? dirname(options.receiptPath ?? PERMIT_INSTALL_RECEIPT));
  return {
    stateRoot,
    receiptPath: resolve(options.receiptPath ?? PERMIT_INSTALL_RECEIPT),
    attemptsRoot: resolve(options.attemptsRoot ?? PERMIT_INSTALL_ATTEMPTS),
    authorizationManifestPath: resolve(options.authorizationManifestPath ?? AUTHORIZATION_MANIFEST),
    releaseManifestPath: resolve(options.releaseManifestPath ?? "/opt/xingheng-release/code/deploy/release-manifest.json"),
    environmentPath: resolve(options.environmentPath ?? "/opt/xingheng-release/code/.env.production"),
    lifecyclePointerPath: resolve(options.lifecyclePointerPath ?? RELEASE_LIFECYCLE_POINTER),
    lifecycleOperationsRoot: resolve(options.lifecycleOperationsRoot ?? RELEASE_LIFECYCLE_OPERATIONS),
    recoveryRoot: resolve(options.recoveryRoot ?? PERMIT_RECOVERY_ROOT),
  };
}

function resolveReleaseIdentity({ request, releaseManifest, releaseManifestSha256, paths, options }) {
  const supplied = options.releaseIdentity;
  let releaseIdentity;
  if (supplied !== undefined) {
    releaseIdentity = supplied;
  } else {
    const trusted = assertTrustedProductionReleaseRoot("/opt/xingheng-release/code");
    const lifecycle = readLifecycleIdentity(paths);
    if (
      lifecycle.revision !== releaseManifest.revision
      || lifecycle.manifestSha256 !== releaseManifestSha256
      || lifecycle.images?.api !== releaseManifest.images.api
      || lifecycle.images?.web !== releaseManifest.images.web
    ) throw new Error("Active release lifecycle does not match the release manifest");
    releaseIdentity = {
      releaseRevision: releaseManifest.revision,
      gitTreeSha: request.gitTreeSha,
      releaseTreeSha256: trusted.releaseTree.sha256,
      releaseManifestSha256,
      apiImageDigest: releaseManifest.images.api,
      webImageDigest: releaseManifest.images.web,
      lifecycleEstablishedAt: lifecycle.establishedAt,
      lifecycleOperationId: lifecycle.operationId,
    };
  }
  validateReleaseIdentity(releaseIdentity, request);
  if (
    releaseIdentity.releaseRevision !== releaseManifest.revision
    || releaseIdentity.releaseManifestSha256 !== releaseManifestSha256
    || releaseIdentity.apiImageDigest !== releaseManifest.images.api
    || releaseIdentity.webImageDigest !== releaseManifest.images.web
  ) throw new Error("Permit release identity does not match the active manifest");
  return releaseIdentity;
}

function readLifecycleIdentity(paths) {
  const pointerBytes = readSecureFile(paths.lifecyclePointerPath, 1024 * 1024, 0o600);
  try {
    const pointer = assertObject(JSON.parse(pointerBytes.toString("utf8")), "Active release lifecycle is invalid");
    assertExactKeys(pointer, [
      "daemon", "environmentArtifact", "environmentSha256", "establishedAt", "images",
      "manifestSha256", "operationId", "revision", "schemaVersion",
    ], "Active release lifecycle is invalid");
    if (
      pointer.schemaVersion !== 1
      || !/^[a-f0-9]{40}$/u.test(pointer.revision ?? "")
      || !isStrictUtc(pointer.establishedAt)
      || !pointer.images || pointer.images.api === undefined || pointer.images.web === undefined
      || (pointer.operationId !== null
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(pointer.operationId ?? ""))
    ) throw new Error("Active release lifecycle is invalid");
    if (pointer.operationId !== null) {
      const journalPath = resolve(
        paths.lifecycleOperationsRoot,
        `operation-${pointer.operationId}`,
        "journal.json",
      );
      const journalBytes = readSecureFile(journalPath, 1024 * 1024, 0o600);
      try {
        const journal = JSON.parse(journalBytes.toString("utf8"));
        if (journal?.operationId !== pointer.operationId || journal?.phase !== "active") {
          throw new Error("Active release lifecycle journal is invalid");
        }
      } finally {
        journalBytes.fill(0);
      }
    }
    return pointer;
  } finally {
    pointerBytes.fill(0);
  }
}

function validateReleaseIdentity(value, request) {
  const identity = assertObject(value, "Permit release identity is invalid");
  assertExactKeys(identity, RELEASE_IDENTITY_KEYS, "Permit release identity is invalid");
  if (
    identity.releaseRevision !== request.releaseRevision
    || identity.gitTreeSha !== request.gitTreeSha
    || identity.releaseTreeSha256 !== request.releaseTreeSha256
    || identity.releaseManifestSha256 !== request.releaseManifestSha256
    || identity.apiImageDigest !== request.apiImageDigest
    || identity.webImageDigest !== request.webImageDigest
    || !isStrictUtc(identity.lifecycleEstablishedAt)
    || (identity.lifecycleOperationId !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(identity.lifecycleOperationId ?? ""))
  ) throw new Error("Permit release identity does not match the authorization");
  return identity;
}

function validateRuntimeSnapshot(value, nullable = false) {
  if (nullable && value === null) return null;
  const snapshot = assertObject(value, "Permit runtime identity is invalid");
  assertExactKeys(snapshot, RUNTIME_KEYS, "Permit runtime identity is invalid");
  if (!isStrictUtc(snapshot.capturedAt)) throw new Error("Permit runtime identity is invalid");
  for (const componentName of ["api", "web"]) {
    const component = assertObject(snapshot[componentName], "Permit runtime identity is invalid");
    assertExactKeys(component, RUNTIME_COMPONENT_KEYS, "Permit runtime identity is invalid");
    if (
      !/^[a-f0-9]{12,64}$/u.test(component.containerId ?? "")
      || !/^sha256:[a-f0-9]{64}$/u.test(component.imageDigest ?? "")
      || !/^[a-f0-9]{40}$/u.test(component.revision ?? "")
      || !isStrictUtc(component.startedAt)
      || component.running !== true
      || component.health !== "healthy"
    ) throw new Error("Permit runtime identity is invalid");
  }
  return snapshot;
}

function validateReceiptRuntimeRelationship(receipt) {
  const before = receipt.runtimeBefore;
  const after = receipt.runtimeAfter;
  const hasBefore = before !== null;
  const hasAfter = after !== null;
  const allowedSnapshots = receipt.status === "success"
    ? hasBefore && hasAfter
    : receipt.status === "failed"
      ? !hasAfter
      : !hasAfter || hasBefore;
  if (!allowedSnapshots) throw new Error("Permit receipt runtime snapshot state is invalid");

  for (const snapshot of [before, after]) {
    if (snapshot === null) continue;
    if (
      snapshot.api.revision !== receipt.releaseIdentity.releaseRevision
      || snapshot.web.revision !== receipt.releaseIdentity.releaseRevision
      || snapshot.api.imageDigest !== receipt.releaseIdentity.apiImageDigest
      || snapshot.web.imageDigest !== receipt.releaseIdentity.webImageDigest
    ) throw new Error("Permit receipt runtime snapshot does not match the release identity");
  }
  if (!hasBefore || !hasAfter) return;
  if (canonicalJson(before.web) !== canonicalJson(after.web)) {
    throw new Error("Permit receipt Web runtime identity changed");
  }
  if (before.api.containerId === after.api.containerId) {
    throw new Error("Permit receipt API container identity did not change");
  }
}

function assertNoTerminalReceipt(paths, options) {
  try {
    readInstallReceipt(paths.receiptPath, options);
    throw new Error("Production self-test Permit installation has already been attempted");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const entries = readdirSync(paths.attemptsRoot);
    if (entries.length === 0) {
      assertCompletedPermitRecovery({
        ...options,
        recoveryRoot: paths.recoveryRoot,
        receiptPath: paths.receiptPath,
        attemptsRoot: paths.attemptsRoot,
      });
      return;
    }
    throw new Error("Production self-test Permit installation has already been attempted");
  } catch (error) {
    if (error?.code === "ENOENT") {
      assertCompletedPermitRecovery({
        ...options,
        recoveryRoot: paths.recoveryRoot,
        receiptPath: paths.receiptPath,
        attemptsRoot: paths.attemptsRoot,
      });
      return;
    }
    throw error;
  }
}

function validateAttemptReceipt(receipt, options) {
  const paths = installPaths(options);
  const path = resolve(paths.attemptsRoot, receipt.operationId, "attempt-receipt.json");
  const bytes = readSecureFile(path, 64 * 1024, 0o400, options);
  try {
    if (sha256(bytes) !== receipt.attemptReceiptSha256) {
      throw new Error("Permit attempt receipt identity mismatch");
    }
    const attempt = assertObject(JSON.parse(bytes.toString("utf8")), "Permit attempt receipt is invalid");
    assertExactKeys(attempt, ATTEMPT_RECEIPT_KEYS, "Permit attempt receipt is invalid");
    if (attempt.operationId !== receipt.operationId || attempt.status !== "prepared"
      || attempt.runtimeBefore !== null || attempt.runtimeAfter !== null) {
      throw new Error("Permit attempt receipt is invalid");
    }
    const expected = {
      schemaVersion: receipt.schemaVersion,
      operationId: receipt.operationId,
      status: "prepared",
      request: receipt.request,
      permit: receipt.permit,
      releaseIdentity: receipt.releaseIdentity,
      runtimeBefore: null,
      runtimeAfter: null,
      activatedAt: receipt.activatedAt,
      expiresAt: receipt.expiresAt,
      envBeforeSha256: receipt.envBeforeSha256,
      envAfterSha256: receipt.envAfterSha256,
      updatedAt: receipt.activatedAt,
    };
    if (canonicalJson(attempt) !== canonicalJson(expected)) {
      throw new Error("Permit attempt receipt does not match the installation receipt");
    }
  } finally { bytes.fill(0); }
}

function isPermitInstallComposeOperation(args, ownerUserId) {
  return (args.length === 3
      && args[0] === "up" && args[1] === "-d" && args[2] === "api"
    || args.length === 6
      && args[0] === "exec" && args[1] === "-T" && args[2] === "api"
      && args[3] === "node"
      && args[4] === "/app/scripts/verify-production-self-test-permit-state.mjs"
      && args[5] === ownerUserId);
}

function markPreparedReceiptUnknown(path, receipt, now, options = {}) {
  const terminal = {
    ...receipt,
    status: "unknown",
    updatedAt: strictUtc(now, "Permit install terminal time is invalid"),
  };
  atomicReplace(path, Buffer.from(`${JSON.stringify(terminal)}\n`), 0o400, options);
}

function secureFileSha256(path, maximum, mode, options = {}) {
  const bytes = readSecureFile(path, maximum, mode, options);
  try { return sha256(bytes); } finally { bytes.fill(0); }
}

function replaceEnvironment(sourcePath, targetPath, expectedSha256, expectedTargetSha256, options = {}) {
  const bytes = readSecureFile(sourcePath, 1024 * 1024, 0o600, options);
  try {
    if (sha256(bytes) !== expectedSha256) throw new Error("Permit environment transaction identity mismatch");
    const target = secureFileReceipt(targetPath, 1024 * 1024, 0o600, options);
    target.bytes.fill(0);
    if (target.sha256 !== expectedTargetSha256) {
      throw new Error("Permit environment target identity mismatch");
    }
    atomicReplace(targetPath, bytes, 0o600, options, target);
  } finally {
    bytes.fill(0);
  }
}

function atomicWrite(path, bytes, mode, options = {}) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    const { uid, gid } = expectedOwner(options);
    fchownSync(fd, uid, gid);
    fchmodSync(fd, mode);
    invokeFs(options, "fileFsync", () => fsyncSync(fd));
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== uid
      || metadata.gid !== gid || (metadata.mode & 0o777) !== mode) {
      throw new Error("Permit installation pending file boundary is invalid");
    }
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path), options);
  const verified = secureFileReceipt(path, Math.max(bytes.length, 1), mode, options);
  try {
    if (verified.sha256 !== sha256(bytes)) throw new Error("Permit installation file verification failed");
  } finally { verified.bytes.fill(0); }
}

function atomicReplace(path, bytes, mode, options = {}, expectedTarget = null) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    atomicWrite(temporary, bytes, mode, options);
    const target = expectedTarget ?? secureFileReceipt(path, 1024 * 1024, mode, options);
    target.bytes.fill(0);
    options.hooks?.beforeTargetRevalidate?.({ path, target });
    assertSamePathIdentity(path, target, mode, options);
    invokeFs(options, "rename", () => renameSync(temporary, path));
    fsyncDirectory(dirname(path), options);
    const verified = secureFileReceipt(path, Math.max(bytes.length, 1), mode, options);
    try {
      if (verified.sha256 !== sha256(bytes)) throw new Error("Permit installation replacement verification failed");
    } finally { verified.bytes.fill(0); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function readSecureFile(path, maximum, mode, options = {}) {
  const receipt = secureFileReceipt(path, maximum, mode, options);
  return receipt.bytes;
}

function secureFileReceipt(path, maximum, mode, options = {}) {
  const before = lstatSync(path);
  const { uid, gid } = expectedOwner(options);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== uid || before.gid !== gid
    || (before.mode & 0o777) !== mode || before.size < 1 || before.size > maximum) {
    throw new Error("Permit installation file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.nlink !== 1 || opened.uid !== uid
      || opened.gid !== gid || (opened.mode & 0o777) !== mode) {
      throw new Error("Permit installation file changed while opening");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      bytes.fill(0);
      throw new Error("Permit installation file changed while reading");
    }
    return {
      bytes,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      uid: opened.uid,
      gid: opened.gid,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: sha256(bytes),
    };
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(path, mode, options = {}) {
  try {
    validateDirectory(path, mode, options);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  validateSecureParentDirectory(dirname(path), options);
  mkdirSync(path, { recursive: false, mode });
  validateDirectory(path, mode, options);
}

function validateDirectory(path, mode, options) {
  const metadata = lstatSync(path);
  const { uid, gid } = expectedOwner(options);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || metadata.gid !== gid
    || (metadata.mode & 0o777) !== mode) {
    throw new Error("Permit installation directory boundary is invalid");
  }
}

function validateSecureParentDirectory(path, options) {
  const metadata = lstatSync(path);
  const { uid, gid } = expectedOwner(options);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || metadata.gid !== gid
    || (metadata.mode & 0o022) !== 0) {
    throw new Error("Permit installation parent directory boundary is invalid");
  }
}

function assertSamePathIdentity(path, expected, mode, options) {
  const current = lstatSync(path);
  const { uid, gid } = expectedOwner(options);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
    || current.dev !== expected.dev || current.ino !== expected.ino
    || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs
    || current.ctimeMs !== expected.ctimeMs || current.uid !== uid || current.gid !== gid
    || (current.mode & 0o777) !== mode) {
    throw new Error("Permit installation target changed before replacement");
  }
}

function expectedOwner(options) {
  if (options.testMode === true) {
    return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
  }
  return { uid: 0, gid: 0 };
}

function invokeFs(options, name, operation) {
  const replacement = options.operations?.[name];
  return replacement ? replacement(operation) : operation();
}

function fsyncDirectory(path, options = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { invokeFs(options, "directoryFsync", () => fsyncSync(fd)); } finally { closeSync(fd); }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isStrictUtc(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}
function strictUtc(value, message) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(message);
  return value.toISOString();
}
function normalizeUtc(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString();
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}
function assertExactKeys(value, keys, message) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(message);
}

async function main() {
  const command = process.argv[2];
  if (command === "prepare") {
    const operationId = process.argv[3] ?? "";
    assertTrustedMutationContext(operationId);
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16 * 1024) throw new Error("Permit install request is too large");
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const receipt = preparePermitInstallation({ request, operationId });
    process.stdout.write(`${receipt.operationId} ${receipt.request.ownerUserId} ${receipt.permit.digest}\n`);
    return;
  }
  if (["runtime-before", "runtime-after"].includes(command)) {
    const operationId = process.argv[3] ?? "";
    assertTrustedMutationContext(operationId);
    if (command === "runtime-before") captureRuntimeBefore(operationId);
    else verifyAndRecordRuntimeAfter(operationId);
    return;
  }
  if (["success", "failed", "unknown"].includes(command)) {
    const operationId = process.argv[3] ?? "";
    assertTrustedMutationContext(operationId);
    finalizePermitInstallation(command, operationId);
    return;
  }
  throw new Error("usage: productionSelfTestPermitInstall.mjs prepare|runtime-before|runtime-after|success|failed|unknown OPERATION_ID");
}

function assertTrustedMutationContext(operationId) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("Permit installation requires controlled Linux root");
  }
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
    || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY !== "install-production-self-test-permit.sh"
    || process.env.XINGHENG_PERMIT_INSTALL_OPERATION_ID !== operationId
    || !/^[a-f0-9]{32}$/u.test(operationId)
  ) throw new Error("Permit installation trusted wrapper context is invalid");
  const operationLocks = inheritedOperationLocks("production");
  const wrapperPath = resolve(PERMIT_INSTALL_WRAPPER);
  const pathMetadata = lstatSync(wrapperPath);
  const descriptor = fstatSync(6);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1
    || pathMetadata.uid !== 0 || pathMetadata.gid !== 0 || (pathMetadata.mode & 0o022) !== 0
    || (pathMetadata.mode & 0o111) === 0 || descriptor.dev !== pathMetadata.dev
    || descriptor.ino !== pathMetadata.ino || descriptor.size !== pathMetadata.size
    || descriptor.uid !== 0 || descriptor.gid !== 0 || descriptor.nlink !== 1) {
    throw new Error("Permit installation trusted wrapper descriptor is invalid");
  }
  const launcherMetadata = lstatSync(TRUSTED_OPERATION_LAUNCHER);
  const launcherDescriptor = fstatSync(7);
  if (!launcherMetadata.isFile() || launcherMetadata.isSymbolicLink()
    || launcherMetadata.nlink !== 1 || launcherMetadata.uid !== 0 || launcherMetadata.gid !== 0
    || (launcherMetadata.mode & 0o022) !== 0 || (launcherMetadata.mode & 0o111) === 0
    || launcherDescriptor.dev !== launcherMetadata.dev || launcherDescriptor.ino !== launcherMetadata.ino
    || launcherDescriptor.size !== launcherMetadata.size || launcherDescriptor.uid !== 0
    || launcherDescriptor.gid !== 0 || launcherDescriptor.nlink !== 1) {
    throw new Error("Permit installation trusted launcher descriptor is invalid");
  }
  return Object.freeze({
    wrapperIdentity: Object.freeze({
      dev: descriptor.dev,
      ino: descriptor.ino,
      size: descriptor.size,
    }),
    launcherIdentity: Object.freeze({
      dev: launcherDescriptor.dev,
      ino: launcherDescriptor.ino,
      size: launcherDescriptor.size,
    }),
    operationLocks: Object.freeze(operationLocks.receipts.map((receipt) => Object.freeze({ ...receipt }))),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production self-test Permit installation failed");
    process.exitCode = 1;
  });
}
