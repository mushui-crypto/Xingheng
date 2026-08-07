#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
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
import {
  CAPITAL_TEST_WINDOW_HOST_ROOT,
  validateCapitalTestWindowReceipt,
} from "./capitalTestWindowReceipt.mjs";
import { assertCapitalTestWindowLaunchIdentity } from "./capitalTestWindowLaunchIdentity.mjs";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import {
  PERMIT_ENV_KEYS,
  PERMIT_INSTALL_ATTEMPTS,
  PERMIT_INSTALL_RECEIPT,
  readInstallReceipt,
} from "./productionSelfTestPermitInstall.mjs";
import {
  PERMIT_TERMINALIZATION_ROOT,
} from "./productionSelfTestPermitTerminalizationLaunchIdentity.mjs";
import { assertPromotionStateAllowsProduction } from "./releasePromotionTransaction.mjs";
import {
  assertTrustedProductionReleaseRoot,
  createTrustedPermitTerminalizationDockerContext,
  execTrustedDockerSync,
  execTrustedPermitTerminalizationDockerSync,
} from "./trustedDockerRuntime.mjs";

export const PERMIT_TERMINALIZATION_WRAPPER =
  "/opt/xingheng-release/code/scripts/terminalize-production-self-test-permit.sh";

const PRODUCTION_ROOT = "/opt/xingheng-release/code";
const PRODUCTION_ENVIRONMENT = `${PRODUCTION_ROOT}/.env.production`;
const PRODUCTION_COMPOSE = `${PRODUCTION_ROOT}/scripts/production-compose.sh`;
const TRUSTED_LAUNCHER = `${PRODUCTION_ROOT}/scripts/trusted-operation-launcher.mjs`;
const CURRENT_MODE = "single_connectivity_smoke";
const PERMIT_PREFIX = "RWA_BINANCE_PRODUCTION_SELF_TEST_";
const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_40 = /^[a-f0-9]{40}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const PREPARED_FILE = "prepared.json";
const ENVIRONMENT_RESTORED_FILE = "environment-restored.json";
const API_RESTARTED_FILE = "api-restarted.json";
const TERMINAL_FILE = "terminal-receipt.json";
const PHASE_FILES = Object.freeze([
  PREPARED_FILE,
  ENVIRONMENT_RESTORED_FILE,
  API_RESTARTED_FILE,
  TERMINAL_FILE,
]);

export function terminalizeExpiredSuccessfulPermit(options = {}) {
  const now = options.now ?? new Date();
  const nowAt = strictUtc(now, "Permit terminalization time is invalid");
  const operationId = exactHex(
    options.operationId,
    32,
    "Permit terminalization operation ID is invalid",
  );
  const expectedReceiptSha256 = exactHex(
    options.expectedReceiptSha256,
    64,
    "Permit terminalization source SHA256 is invalid",
  );
  const paths = terminalizationPaths(options);
  removeStaleEnvironmentTemps(paths.environmentPath, options);
  const source = readSuccessfulReceipt(paths, expectedReceiptSha256, options);
  try {
    if (Date.parse(source.receipt.expiresAt) > now.getTime()) {
      throw new Error("Successful Permit has not expired");
    }
    const attempt = validateAttemptArtifacts(paths, source.receipt, options);
    try {
      validateExactPermitEnvironmentTransition(source.receipt, attempt.before.bytes, attempt.proposed.bytes);
      assertNoWindowForPermit(paths.windowRoot, source.receipt.permit.digest, options);

      const operation = readOperation(paths, operationId, expectedReceiptSha256, options);
      if (operation.completed) throw new Error("Permit terminalization has already completed");
      const environment = secureFile(paths.environmentPath, 1024 * 1024, 0o600, options);
      try {
        const activeEnvironment = environment.sha256 === source.receipt.envAfterSha256;
        const restoredEnvironment = environment.sha256 === source.receipt.envBeforeSha256;
        if (!activeEnvironment && !restoredEnvironment) {
          throw new Error("Permit terminalization environment CAS mismatch");
        }
        if (restoredEnvironment && operation.prepared === null) {
          throw new Error("Permit terminalization resume journal is missing");
        }

        let prepared = operation.prepared;
        let preRuntime = prepared?.preRuntime ?? null;
        if (activeEnvironment) {
          (options.verifyActiveTransition ?? assertCapitalTestWindowLaunchIdentity)();
          preRuntime = captureRuntime(source.receipt, options, true, source.identity, attempt);
          validateActiveRuntime(preRuntime, source.receipt);
          if (prepared !== null && canonicalJson(preRuntime) !== canonicalJson(prepared.preRuntime)) {
            throw new Error("Permit terminalization runtime changed after preparation");
          }
        }

        if (prepared === null) {
          if (!activeEnvironment || preRuntime === null) {
            throw new Error("Permit terminalization cannot prepare from restored state");
          }
          ensureOperationRoot(paths, operationId, options);
          prepared = validatePrepared({
            schemaVersion: 1,
            kind: "expired_success_permit_terminalization",
            state: "prepared",
            operationId,
            sourceReceiptSha256: expectedReceiptSha256,
            sourceReceiptIdentity: source.identity,
            sourceAttemptIdentity: attempt.identity,
            sourceAttemptReceiptSha256: source.receipt.attemptReceiptSha256,
            environmentBeforeIdentity: attempt.before.identity,
            environmentProposedIdentity: attempt.proposed.identity,
            envBeforeSha256: source.receipt.envBeforeSha256,
            envAfterSha256: source.receipt.envAfterSha256,
            permitDigestSha256: sha256(Buffer.from(source.receipt.permit.digest)),
            expiresAt: source.receipt.expiresAt,
            releaseRevision: source.receipt.releaseIdentity.releaseRevision,
            apiImageDigest: source.receipt.releaseIdentity.apiImageDigest,
            preRuntime,
            startedAt: nowAt,
          });
          writePhase(resolve(paths.operationRoot(operationId), PREPARED_FILE), prepared, options);
          options.hooks?.afterPrepared?.();
        } else {
          assertPreparedIdentity(prepared, source, attempt);
        }

        let environmentRestored = operation.environmentRestored;
        if (environmentRestored === null) {
          if (activeEnvironment) {
            replaceEnvironment(
              paths.environmentPath,
              environment.pathIdentity,
              attempt.before.bytes,
              source.receipt.envBeforeSha256,
              options,
            );
            options.hooks?.afterEnvironmentRename?.();
          }
          const restored = secureFile(paths.environmentPath, 1024 * 1024, 0o600, options);
          try {
            if (restored.sha256 !== source.receipt.envBeforeSha256) {
              throw new Error("Permit terminalization environment restoration failed");
            }
            environmentRestored = validateEnvironmentRestored({
              schemaVersion: 1,
              kind: prepared.kind,
              state: "environment_restored",
              operationId,
              previousPhaseSha256: phaseSha256(paths, operationId, PREPARED_FILE, options),
              restoredEnvironmentIdentity: restored.identity,
              restoredEnvironmentSha256: restored.sha256,
              updatedAt: monotonicUtc(
                options.now ?? new Date(),
                prepared.startedAt,
                "Permit terminalization time is invalid",
              ),
            }, prepared);
            writePhase(
              resolve(paths.operationRoot(operationId), ENVIRONMENT_RESTORED_FILE),
              environmentRestored,
              options,
            );
          } finally {
            restored.bytes.fill(0);
          }
          options.hooks?.afterEnvironmentRestored?.();
        } else if (canonicalJson(environmentRestored.restoredEnvironmentIdentity)
          !== canonicalJson(environment.identity)) {
          throw new Error("Permit terminalization restored environment identity changed");
        }

        let apiRestarted = operation.apiRestarted;
        if (apiRestarted === null) {
          let postRuntime = captureRuntimeWithWait(
            source.receipt,
            options,
            source.identity,
            attempt,
          );
          if (!runtimeIsTerminal(postRuntime, prepared.preRuntime, source.receipt)) {
            if (!runtimeIsOriginalActive(postRuntime, prepared.preRuntime, source.receipt)) {
              throw new Error("Permit terminalization API runtime is not resumable");
            }
            (options.restartApi ?? restartProductionApi)();
            options.hooks?.afterApiRestart?.();
            postRuntime = captureRuntimeWithWait(
              source.receipt,
              options,
              source.identity,
              attempt,
            );
          }
          validateTerminalRuntime(postRuntime, prepared.preRuntime, source.receipt);
          apiRestarted = validateApiRestarted({
            schemaVersion: 1,
            kind: prepared.kind,
            state: "api_restarted",
            operationId,
            previousPhaseSha256: phaseSha256(
              paths,
              operationId,
              ENVIRONMENT_RESTORED_FILE,
              options,
            ),
            postRuntime,
            updatedAt: monotonicUtc(
              options.now ?? new Date(),
              environmentRestored.updatedAt,
              "Permit terminalization time is invalid",
            ),
          }, prepared);
          writePhase(resolve(paths.operationRoot(operationId), API_RESTARTED_FILE), apiRestarted, options);
          options.hooks?.afterApiRestartedRecorded?.();
        } else {
          const currentRuntime = captureRuntimeWithWait(
            source.receipt,
            options,
            source.identity,
            attempt,
          );
          validateTerminalRuntime(currentRuntime, prepared.preRuntime, source.receipt);
          if (canonicalJson(currentRuntime) !== canonicalJson(apiRestarted.postRuntime)) {
            throw new Error("Permit terminalization API runtime changed after restart");
          }
        }

        const baseline = (options.verifyPromotionBaseline ?? assertPromotionStateAllowsProduction)();
        const terminal = withTerminalDigest({
          schemaVersion: 1,
          kind: prepared.kind,
          state: "completed",
          operationId,
          sourceReceiptSha256: prepared.sourceReceiptSha256,
          sourceReceiptIdentity: prepared.sourceReceiptIdentity,
          sourceAttemptIdentity: prepared.sourceAttemptIdentity,
          sourceAttemptReceiptSha256: prepared.sourceAttemptReceiptSha256,
          envBeforeSha256: prepared.envBeforeSha256,
          envAfterSha256: prepared.envAfterSha256,
          releaseRevision: prepared.releaseRevision,
          apiImageDigest: prepared.apiImageDigest,
          previousPhaseSha256: phaseSha256(paths, operationId, API_RESTARTED_FILE, options),
          promotionOperationId: baseline.operationId ?? null,
          promotionBaselineVerified: true,
          completedAt: monotonicUtc(
            options.now ?? new Date(),
            apiRestarted.updatedAt,
            "Permit terminalization time is invalid",
          ),
        });
        writePhase(resolve(paths.operationRoot(operationId), TERMINAL_FILE), terminal, options);
        options.hooks?.afterCompleted?.();
        assertSourceEvidenceUnchanged(paths, source, attempt, options);
        return Object.freeze({
          operationId,
          sourceReceiptSha256: expectedReceiptSha256,
          terminalReceiptSha256: phaseSha256(paths, operationId, TERMINAL_FILE, options),
        });
      } finally {
        environment.bytes.fill(0);
      }
    } finally {
      attempt.before.bytes.fill(0);
      attempt.proposed.bytes.fill(0);
      attempt.receipt.bytes.fill(0);
    }
  } finally {
    source.bytes.fill(0);
  }
}

export function assertIncompletePermitTerminalization(input, options = {}) {
  const paths = terminalizationPaths(options);
  const operationId = exactHex(input.operationId, 32, "Permit terminalization operation ID is invalid");
  const sourceReceiptSha256 = exactHex(
    input.sourceReceiptSha256,
    64,
    "Permit terminalization source SHA256 is invalid",
  );
  const operation = readOperation(paths, operationId, sourceReceiptSha256, options);
  if (operation.prepared === null || operation.completed) {
    throw new Error("Permit terminalization resume journal is missing or terminal");
  }
  return operation;
}

function readSuccessfulReceipt(paths, expectedSha256, options) {
  const file = secureFile(paths.receiptPath, 64 * 1024, 0o400, options);
  try {
    if (file.sha256 !== expectedSha256) throw new Error("Permit terminalization source SHA256 mismatch");
    const receipt = readInstallReceipt(paths.receiptPath, {
      ...options,
      attemptsRoot: paths.attemptsRoot,
    });
    if (receipt.schemaVersion !== 2 || receipt.status !== "success"
      || receipt.request.executionMode !== CURRENT_MODE
      || receipt.permit.executionMode !== CURRENT_MODE) {
      throw new Error("Permit terminalization requires an exact successful schema v2 receipt");
    }
    return { receipt, bytes: file.bytes, sha256: file.sha256, identity: file.identity };
  } catch (error) {
    file.bytes.fill(0);
    throw error;
  }
}

function validateAttemptArtifacts(paths, receipt, options) {
  const entries = readdirSync(paths.attemptsRoot).sort();
  if (entries.length !== 1 || entries[0] !== receipt.operationId) {
    throw new Error("Permit terminalization attempt set is invalid");
  }
  const root = resolve(paths.attemptsRoot, receipt.operationId);
  const identity = directoryIdentity(root, 0o700, options);
  const names = readdirSync(root).sort();
  if (names.join(",") !== ["attempt-receipt.json", "environment.before", "environment.proposed"].join(",")) {
    throw new Error("Permit terminalization attempt directory is incomplete");
  }
  const before = secureFile(resolve(root, "environment.before"), 1024 * 1024, 0o600, options);
  const proposed = secureFile(resolve(root, "environment.proposed"), 1024 * 1024, 0o600, options);
  const attempt = secureFile(resolve(root, "attempt-receipt.json"), 64 * 1024, 0o400, options);
  if (before.sha256 !== receipt.envBeforeSha256 || proposed.sha256 !== receipt.envAfterSha256
    || attempt.sha256 !== receipt.attemptReceiptSha256) {
    before.bytes.fill(0); proposed.bytes.fill(0); attempt.bytes.fill(0);
    throw new Error("Permit terminalization attempt identity mismatch");
  }
  return { root, identity, before, proposed, receipt: attempt };
}

function validateExactPermitEnvironmentTransition(receipt, beforeBytes, proposedBytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(beforeBytes);
  const beforeEntries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/u.exec(line.trim());
    if (match && PERMIT_ENV_KEYS.includes(match[1])) {
      throw new Error("Permit terminalization baseline already contains Permit keys");
    }
    if (match) beforeEntries.set(match[1], line.trim().slice(line.trim().indexOf("=") + 1));
  }
  if (beforeEntries.get("RWA_AUTOMATION_SERVER_KILL_SWITCH") !== "true") {
    throw new Error("Permit terminalization requires the server kill switch ON");
  }
  const suffix = text.endsWith("\n") ? "" : "\n";
  const expected = Buffer.from(`${text}${suffix}${permitEnvironment(receipt.permit)
    .map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  try {
    if (!expected.equals(proposedBytes)) {
      throw new Error("Permit terminalization environment transition is not exact");
    }
  } finally {
    expected.fill(0);
  }
}

function permitEnvironment(permit) {
  return [
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
  ];
}

function assertNoWindowForPermit(root, permitDigest, options) {
  if (!exists(root)) return;
  const owner = expectedOwner(options);
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== owner.uid || metadata.gid !== owner.gid
    || (metadata.mode & 0o777) !== 0o555) {
    throw new Error("Permit terminalization Window root boundary is invalid");
  }
  const entries = readdirSync(root).sort();
  if (entries.some((name) => !["completed", "current.json"].includes(name))) {
    throw new Error("Permit terminalization Window root contains unknown files");
  }
  if (entries.includes("current.json")) {
    throw new Error("Permit terminalization requires no Window receipt or lease");
  }
  const completed = resolve(root, "completed");
  if (!exists(completed)) return;
  const completedMetadata = lstatSync(completed);
  if (!completedMetadata.isDirectory() || completedMetadata.isSymbolicLink()
    || completedMetadata.uid !== owner.uid || completedMetadata.gid !== owner.gid
    || (completedMetadata.mode & 0o777) !== 0o555) {
    throw new Error("Permit terminalization Window archive boundary is invalid");
  }
  for (const name of readdirSync(completed)) {
    if (!/^operation-[a-f0-9]{32}\.json$/u.test(name)) {
      throw new Error("Permit terminalization Window archive is invalid");
    }
    const file = secureFile(resolve(completed, name), 64 * 1024, 0o444, options);
    try {
      const receipt = validateCapitalTestWindowReceipt(JSON.parse(file.bytes.toString("utf8")));
      if (receipt.permitDigest === permitDigest) {
        throw new Error("Permit terminalization rejects a Permit with Window history");
      }
    } finally { file.bytes.fill(0); }
  }
}

function captureRuntime(receipt, options, activeTransition, receiptIdentity, attempt) {
  if (options.captureRuntime) return options.captureRuntime({ receipt, activeTransition });
  const docker = activeTransition
    ? (args, dockerOptions) => execTrustedPermitTerminalizationDockerSync(
      args,
      createTrustedPermitTerminalizationDockerContext({
        schemaVersion: 1,
        kind: "permit-terminalization-transient",
        operationId: options.operationId,
        sourceReceiptSha256: options.expectedReceiptSha256,
        sourceReceiptIdentity: receiptIdentity,
        sourceAttemptIdentity: attempt.identity,
        apiContainerId: receipt.runtimeAfter.api.containerId,
        ownerUserId: receipt.permit.ownerUserId,
        environmentBeforeSha256: receipt.envBeforeSha256,
        environmentAfterSha256: receipt.envAfterSha256,
        wrapperIdentity: trustedDescriptorIdentity(6),
        launcherIdentity: trustedDescriptorIdentity(7),
        operationLocks: inheritedOperationLocks("production").receipts,
      }, process.env),
      dockerOptions,
    )
    : execTrustedDockerSync;
  const expectedContainer = receipt.runtimeAfter.api.containerId;
  const ids = String(docker([
    "ps", "-a", "--filter", "label=com.docker.compose.project=xingheng",
    "--filter", "label=com.docker.compose.service=api", "--format", "{{.ID}}",
  ], dockerOutputOptions())).trim().split(/\s+/u).filter(Boolean);
  if (ids.length !== 1) throw new Error("Permit terminalization API container set is invalid");
  if (activeTransition && !expectedContainer.startsWith(ids[0])) {
    throw new Error("Permit terminalization API container identity mismatch");
  }
  const inspectTarget = activeTransition ? expectedContainer : ids[0];
  const inspected = JSON.parse(String(docker(
    ["container", "inspect", inspectTarget],
    dockerOutputOptions(),
  )));
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error("Permit terminalization API runtime identity is invalid");
  }
  const api = inspected[0];
  const environment = new Map((api.Config?.Env ?? []).map(splitEnvironmentEntry));
  const stateResult = String(docker([
    "exec", api.Id, "node", "/app/scripts/verify-production-self-test-permit-state.mjs",
    receipt.permit.ownerUserId,
  ], dockerOutputOptions())).trim();
  return validateRuntimeEvidence({
    containerId: api.Id,
    imageDigest: api.Image,
    revision: api.Config?.Labels?.["org.opencontainers.image.revision"],
    running: api.State?.Running,
    health: api.State?.Health?.Status,
    killSwitchOn: environment.get("RWA_AUTOMATION_SERVER_KILL_SWITCH") === "true",
    permitEnvironment: Object.fromEntries([...environment]
      .filter(([key]) => key.startsWith(PERMIT_PREFIX))
      .sort(([left], [right]) => left.localeCompare(right))),
    persistedStateSafe: stateResult === "permit-state-safe",
    expectedOriginalContainer: expectedContainer,
  });
}

function captureRuntimeWithWait(receipt, options, receiptIdentity, attempt) {
  const attempts = options.runtimeHealthAttempts ?? (options.captureRuntime ? 1 : 60);
  const waitMilliseconds = options.runtimeHealthWaitMilliseconds ?? 1_000;
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return captureRuntime(receipt, options, false, receiptIdentity, attempt);
    } catch (error) {
      lastError = error;
      if (index + 1 < attempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMilliseconds);
      }
    }
  }
  throw lastError ?? new Error("Permit terminalization API health verification timed out");
}

function validateActiveRuntime(runtime, receipt) {
  if (runtime.containerId !== receipt.runtimeAfter.api.containerId
    || runtime.imageDigest !== receipt.releaseIdentity.apiImageDigest
    || runtime.revision !== receipt.releaseIdentity.releaseRevision
    || runtime.running !== true || runtime.health !== "healthy"
    || runtime.killSwitchOn !== true || runtime.persistedStateSafe !== true
    || canonicalJson(runtime.permitEnvironment) !== canonicalJson(Object.fromEntries(permitEnvironment(receipt.permit)))) {
    throw new Error("Permit terminalization active runtime precondition failed");
  }
}

function runtimeIsOriginalActive(runtime, preRuntime, receipt) {
  try { validateActiveRuntime(runtime, receipt); } catch { return false; }
  return runtime.containerId === preRuntime.containerId;
}

function runtimeIsTerminal(runtime, preRuntime, receipt) {
  try { validateTerminalRuntime(runtime, preRuntime, receipt); return true; } catch { return false; }
}

function validateTerminalRuntime(runtime, preRuntime, receipt) {
  if (runtime.containerId === preRuntime.containerId
    || runtime.imageDigest !== receipt.releaseIdentity.apiImageDigest
    || runtime.revision !== receipt.releaseIdentity.releaseRevision
    || runtime.running !== true || runtime.health !== "healthy"
    || runtime.killSwitchOn !== true || runtime.persistedStateSafe !== true
    || Object.keys(runtime.permitEnvironment).length !== 0) {
    throw new Error("Permit terminalization API restart verification failed");
  }
}

function validateRuntimeEvidence(value) {
  const keys = [
    "containerId", "expectedOriginalContainer", "health", "imageDigest", "killSwitchOn",
    "permitEnvironment", "persistedStateSafe", "revision", "running",
  ];
  exactObject(value, keys, "Permit terminalization runtime evidence is invalid");
  if (!/^[a-f0-9]{12,64}$/u.test(value.containerId ?? "")
    || !/^[a-f0-9]{12,64}$/u.test(value.expectedOriginalContainer ?? "")
    || !IMAGE.test(value.imageDigest ?? "") || !HEX_40.test(value.revision ?? "")
    || value.running !== true || value.health !== "healthy"
    || typeof value.killSwitchOn !== "boolean" || typeof value.persistedStateSafe !== "boolean"
    || !value.permitEnvironment || typeof value.permitEnvironment !== "object"
    || Array.isArray(value.permitEnvironment)
    || Object.keys(value.permitEnvironment).some((key) => !PERMIT_ENV_KEYS.includes(key))) {
    throw new Error("Permit terminalization runtime evidence is invalid");
  }
  return value;
}

function restartProductionApi() {
  const result = spawnSync(PRODUCTION_COMPOSE, ["up", "-d", "api"], {
    cwd: PRODUCTION_ROOT,
    encoding: "utf8",
    env: cleanOperationEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe", 3, 4],
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error("Permit terminalization trusted API restart failed");
  }
}

function cleanOperationEnvironment(source) {
  const output = {
    HOME: "/root",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    XINGHENG_OPERATION_LOCK_CONTEXT: "production",
  };
  for (const key of [
    "XINGHENG_REVISION", "XINGHENG_API_IMAGE", "XINGHENG_WEB_IMAGE",
    "XINGHENG_STRATEGY_TOOLS_IMAGE", "RELEASE_MANIFEST_FILE",
  ]) if (source[key] !== undefined) output[key] = source[key];
  return output;
}

function readOperation(paths, operationId, sourceReceiptSha256, options) {
  if (!exists(paths.root)) return emptyOperation();
  validateDirectory(paths.root, 0o700, options);
  const rootEntries = readdirSync(paths.root).sort();
  if (rootEntries.length === 0) return emptyOperation();
  if (rootEntries.length !== 1 || rootEntries[0] !== operationId) {
    throw new Error("Permit terminalization operation set is invalid");
  }
  const root = paths.operationRoot(operationId);
  validateDirectory(root, 0o700, options);
  removeStalePhaseTemps(root, options);
  const names = readdirSync(root).sort();
  if (names.some((name) => !PHASE_FILES.includes(name))) {
    throw new Error("Permit terminalization operation contains unknown files");
  }
  const expectedNames = PHASE_FILES.slice(0, names.length).sort();
  if (names.join(",") !== expectedNames.join(",")) {
    throw new Error("Permit terminalization journal sequence is invalid");
  }
  const prepared = names.includes(PREPARED_FILE)
    ? validatePrepared(readPhase(root, PREPARED_FILE, options)) : null;
  if (prepared && (prepared.operationId !== operationId
    || prepared.sourceReceiptSha256 !== sourceReceiptSha256)) {
    throw new Error("Permit terminalization operation identity mismatch");
  }
  const environmentRestored = names.includes(ENVIRONMENT_RESTORED_FILE)
    ? validateEnvironmentRestored(readPhase(root, ENVIRONMENT_RESTORED_FILE, options), prepared) : null;
  const apiRestarted = names.includes(API_RESTARTED_FILE)
    ? validateApiRestarted(readPhase(root, API_RESTARTED_FILE, options), prepared) : null;
  const terminal = names.includes(TERMINAL_FILE)
    ? validateTerminal(readPhase(root, TERMINAL_FILE, options), prepared) : null;
  if ((environmentRestored && !prepared) || (apiRestarted && !environmentRestored)
    || (terminal && !apiRestarted)) {
    throw new Error("Permit terminalization journal sequence is invalid");
  }
  if ((environmentRestored
      && environmentRestored.previousPhaseSha256 !== phaseSha256(paths, operationId, PREPARED_FILE, options))
    || (apiRestarted
      && apiRestarted.previousPhaseSha256 !== phaseSha256(paths, operationId, ENVIRONMENT_RESTORED_FILE, options))
    || (terminal
      && terminal.previousPhaseSha256 !== phaseSha256(paths, operationId, API_RESTARTED_FILE, options))) {
    throw new Error("Permit terminalization journal chain mismatch");
  }
  if ((environmentRestored && Date.parse(environmentRestored.updatedAt) < Date.parse(prepared.startedAt))
    || (apiRestarted && Date.parse(apiRestarted.updatedAt) < Date.parse(environmentRestored.updatedAt))
    || (terminal && Date.parse(terminal.completedAt) < Date.parse(apiRestarted.updatedAt))) {
    throw new Error("Permit terminalization journal time moved backwards");
  }
  return { prepared, environmentRestored, apiRestarted, terminal, completed: terminal !== null };
}

function emptyOperation() {
  return { prepared: null, environmentRestored: null, apiRestarted: null, terminal: null, completed: false };
}

function validatePrepared(value) {
  const keys = [
    "apiImageDigest", "envAfterSha256", "envBeforeSha256", "environmentBeforeIdentity",
    "environmentProposedIdentity", "expiresAt", "kind", "operationId", "permitDigestSha256",
    "preRuntime", "releaseRevision", "schemaVersion", "sourceAttemptIdentity",
    "sourceAttemptReceiptSha256", "sourceReceiptIdentity", "sourceReceiptSha256", "startedAt", "state",
  ];
  exactObject(value, keys, "Permit terminalization prepared journal is invalid");
  if (value.schemaVersion !== 1 || value.kind !== "expired_success_permit_terminalization"
    || value.state !== "prepared" || !HEX_32.test(value.operationId ?? "")
    || !HEX_64.test(value.sourceReceiptSha256 ?? "")
    || !HEX_64.test(value.sourceAttemptReceiptSha256 ?? "")
    || !HEX_64.test(value.envBeforeSha256 ?? "") || !HEX_64.test(value.envAfterSha256 ?? "")
    || value.envBeforeSha256 === value.envAfterSha256
    || !HEX_64.test(value.permitDigestSha256 ?? "") || !strictUtcString(value.expiresAt)
    || !HEX_40.test(value.releaseRevision ?? "") || !IMAGE.test(value.apiImageDigest ?? "")
    || !strictUtcString(value.startedAt)) {
    throw new Error("Permit terminalization prepared journal is invalid");
  }
  for (const identity of [
    value.sourceReceiptIdentity, value.sourceAttemptIdentity,
    value.environmentBeforeIdentity, value.environmentProposedIdentity,
  ]) validateIdentity(identity);
  validateRuntimeEvidence(value.preRuntime);
  return value;
}

function validateEnvironmentRestored(value, prepared) {
  exactObject(value, [
    "kind", "operationId", "previousPhaseSha256", "restoredEnvironmentIdentity",
    "restoredEnvironmentSha256", "schemaVersion", "state", "updatedAt",
  ], "Permit terminalization environment journal is invalid");
  if (!prepared || value.schemaVersion !== 1 || value.kind !== prepared.kind
    || value.state !== "environment_restored" || value.operationId !== prepared.operationId
    || !HEX_64.test(value.previousPhaseSha256 ?? "")
    || value.restoredEnvironmentSha256 !== prepared.envBeforeSha256
    || !strictUtcString(value.updatedAt)) {
    throw new Error("Permit terminalization environment journal is invalid");
  }
  validateIdentity(value.restoredEnvironmentIdentity);
  return value;
}

function validateApiRestarted(value, prepared) {
  exactObject(value, [
    "kind", "operationId", "postRuntime", "previousPhaseSha256", "schemaVersion", "state", "updatedAt",
  ], "Permit terminalization API journal is invalid");
  if (!prepared || value.schemaVersion !== 1 || value.kind !== prepared.kind
    || value.state !== "api_restarted" || value.operationId !== prepared.operationId
    || !HEX_64.test(value.previousPhaseSha256 ?? "") || !strictUtcString(value.updatedAt)) {
    throw new Error("Permit terminalization API journal is invalid");
  }
  validateRuntimeEvidence(value.postRuntime);
  validateTerminalRuntime(value.postRuntime, prepared.preRuntime, {
    releaseIdentity: { apiImageDigest: prepared.apiImageDigest, releaseRevision: prepared.releaseRevision },
  });
  return value;
}

function validateTerminal(value, prepared) {
  exactObject(value, [
    "apiImageDigest", "completedAt", "digest", "envAfterSha256", "envBeforeSha256", "kind",
    "operationId", "previousPhaseSha256", "promotionBaselineVerified", "promotionOperationId",
    "releaseRevision", "schemaVersion", "sourceAttemptIdentity", "sourceAttemptReceiptSha256",
    "sourceReceiptIdentity", "sourceReceiptSha256", "state",
  ], "Permit terminalization terminal receipt is invalid");
  if (!prepared || value.schemaVersion !== 1 || value.kind !== prepared.kind || value.state !== "completed"
    || value.operationId !== prepared.operationId || value.sourceReceiptSha256 !== prepared.sourceReceiptSha256
    || canonicalJson(value.sourceReceiptIdentity) !== canonicalJson(prepared.sourceReceiptIdentity)
    || canonicalJson(value.sourceAttemptIdentity) !== canonicalJson(prepared.sourceAttemptIdentity)
    || value.sourceAttemptReceiptSha256 !== prepared.sourceAttemptReceiptSha256
    || value.envBeforeSha256 !== prepared.envBeforeSha256 || value.envAfterSha256 !== prepared.envAfterSha256
    || value.releaseRevision !== prepared.releaseRevision || value.apiImageDigest !== prepared.apiImageDigest
    || !HEX_64.test(value.previousPhaseSha256 ?? "") || value.promotionBaselineVerified !== true
    || (value.promotionOperationId !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.promotionOperationId))
    || !strictUtcString(value.completedAt) || !HEX_64.test(value.digest ?? "")
    || value.digest !== terminalDigest(value)) {
    throw new Error("Permit terminalization terminal receipt is invalid");
  }
  return value;
}

function withTerminalDigest(value) {
  return validateTerminal({ ...value, digest: sha256(Buffer.from(canonicalJson(value))) }, {
    kind: value.kind,
    operationId: value.operationId,
    sourceReceiptSha256: value.sourceReceiptSha256,
    sourceReceiptIdentity: value.sourceReceiptIdentity,
    sourceAttemptIdentity: value.sourceAttemptIdentity,
    sourceAttemptReceiptSha256: value.sourceAttemptReceiptSha256,
    envBeforeSha256: value.envBeforeSha256,
    envAfterSha256: value.envAfterSha256,
    releaseRevision: value.releaseRevision,
    apiImageDigest: value.apiImageDigest,
  });
}

function terminalDigest(value) {
  const copy = { ...value };
  delete copy.digest;
  return sha256(Buffer.from(canonicalJson(copy)));
}

function assertPreparedIdentity(prepared, source, attempt) {
  if (prepared.sourceReceiptSha256 !== source.sha256
    || canonicalJson(prepared.sourceReceiptIdentity) !== canonicalJson(source.identity)
    || canonicalJson(prepared.sourceAttemptIdentity) !== canonicalJson(attempt.identity)
    || prepared.sourceAttemptReceiptSha256 !== source.receipt.attemptReceiptSha256
    || canonicalJson(prepared.environmentBeforeIdentity) !== canonicalJson(attempt.before.identity)
    || canonicalJson(prepared.environmentProposedIdentity) !== canonicalJson(attempt.proposed.identity)
    || prepared.envBeforeSha256 !== source.receipt.envBeforeSha256
    || prepared.envAfterSha256 !== source.receipt.envAfterSha256) {
    throw new Error("Permit terminalization source evidence changed after preparation");
  }
}

function assertSourceEvidenceUnchanged(paths, source, attempt, options) {
  const confirmed = readSuccessfulReceipt(paths, source.sha256, options);
  try {
    if (canonicalJson(confirmed.identity) !== canonicalJson(source.identity)) {
      throw new Error("Permit terminalization source receipt identity changed");
    }
    const confirmedAttempt = validateAttemptArtifacts(paths, confirmed.receipt, options);
    try {
      if (canonicalJson(confirmedAttempt.identity) !== canonicalJson(attempt.identity)
        || canonicalJson(confirmedAttempt.before.identity) !== canonicalJson(attempt.before.identity)
        || canonicalJson(confirmedAttempt.proposed.identity) !== canonicalJson(attempt.proposed.identity)
        || canonicalJson(confirmedAttempt.receipt.identity) !== canonicalJson(attempt.receipt.identity)) {
        throw new Error("Permit terminalization source attempt identity changed");
      }
    } finally {
      confirmedAttempt.before.bytes.fill(0);
      confirmedAttempt.proposed.bytes.fill(0);
      confirmedAttempt.receipt.bytes.fill(0);
    }
  } finally { confirmed.bytes.fill(0); }
}

function ensureOperationRoot(paths, operationId, options) {
  ensureDirectory(paths.root, 0o700, options);
  const entries = readdirSync(paths.root);
  if (entries.length === 0) {
    ensureDirectory(paths.operationRoot(operationId), 0o700, options);
    return;
  }
  if (entries.length !== 1 || entries[0] !== operationId) {
    throw new Error("Permit terminalization operation already exists");
  }
  validateDirectory(paths.operationRoot(operationId), 0o700, options);
  removeStalePhaseTemps(paths.operationRoot(operationId), options);
  if (readdirSync(paths.operationRoot(operationId)).length !== 0) {
    throw new Error("Permit terminalization operation already exists");
  }
}

function removeStalePhaseTemps(root, options) {
  for (const name of readdirSync(root)) {
    if (!/^(?:prepared|environment-restored|api-restarted|terminal-receipt)\.json\.[0-9]+\.[a-f0-9]{16}\.tmp$/u.test(name)) continue;
    const path = resolve(root, name);
    const file = secureFile(path, 64 * 1024, 0o400, options);
    file.bytes.fill(0);
    unlinkSync(path);
    fsyncDirectory(root, options);
  }
}

function removeStaleEnvironmentTemps(environmentPath, options) {
  const directory = dirname(environmentPath);
  const prefix = `${environmentPath.split("/").at(-1)}.`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)
      || !/^\.env\.production\.[0-9]+\.[a-f0-9]{16}\.terminalize\.tmp$/u.test(name)) continue;
    const path = resolve(directory, name);
    const file = secureFile(path, 1024 * 1024, 0o600, options);
    file.bytes.fill(0);
    unlinkSync(path);
    fsyncDirectory(directory, options);
  }
}

function writePhase(path, value, options) {
  if (exists(path)) throw new Error("Permit terminalization phase already exists");
  atomicCreate(path, jsonBytes(value), 0o400, options);
}

function readPhase(root, name, options) {
  const file = secureFile(resolve(root, name), 64 * 1024, 0o400, options);
  try { return JSON.parse(file.bytes.toString("utf8")); } finally { file.bytes.fill(0); }
}

function phaseSha256(paths, operationId, name, options) {
  const file = secureFile(resolve(paths.operationRoot(operationId), name), 64 * 1024, 0o400, options);
  try { return file.sha256; } finally { file.bytes.fill(0); }
}

function replaceEnvironment(path, expectedIdentity, bytes, expectedSha256, options) {
  const current = secureFile(path, 1024 * 1024, 0o600, options);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.terminalize.tmp`;
  try {
    if (canonicalJson(current.pathIdentity) !== canonicalJson(expectedIdentity)) {
      throw new Error("Permit terminalization environment identity changed before CAS");
    }
    atomicWrite(temporary, bytes, 0o600, options);
    const staged = secureFile(temporary, 1024 * 1024, 0o600, options);
    try {
      if (staged.sha256 !== expectedSha256) throw new Error("Permit terminalization staged environment mismatch");
    } finally { staged.bytes.fill(0); }
    options.hooks?.beforeEnvironmentTargetRevalidate?.({ path, expectedIdentity });
    assertSameFileIdentity(path, expectedIdentity, 0o600, options);
    invokeFs(options, "rename", () => renameSync(temporary, path));
    fsyncDirectory(dirname(path), options);
  } finally {
    current.bytes.fill(0);
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function atomicCreate(path, bytes, mode, options) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    atomicWrite(temporary, bytes, mode, options);
    if (exists(path)) throw new Error("Permit terminalization file already exists");
    invokeFs(options, "rename", () => renameSync(temporary, path));
    fsyncDirectory(dirname(path), options);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function atomicWrite(path, bytes, mode, options) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    const owner = expectedOwner(options);
    fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
    invokeFs(options, "fileFsync", () => fsyncSync(fd));
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(path), options);
  const verified = secureFile(path, Math.max(bytes.length, 1), mode, options);
  try {
    if (verified.sha256 !== sha256(bytes)) {
      throw new Error("Permit terminalization file verification failed");
    }
  } finally { verified.bytes.fill(0); }
}

function secureFile(path, maximum, mode, options = {}) {
  const before = lstatSync(path);
  const owner = expectedOwner(options);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== owner.uid || before.gid !== owner.gid || (before.mode & 0o777) !== mode
    || before.size < 1 || before.size > maximum) {
    throw new Error("Permit terminalization file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameStat(before, opened)) throw new Error("Permit terminalization file changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameStat(opened, after)) {
      bytes.fill(0);
      throw new Error("Permit terminalization file changed while reading");
    }
    return {
      bytes,
      sha256: sha256(bytes),
      identity: statIdentity(opened),
      pathIdentity: statPathIdentity(opened),
    };
  } finally { closeSync(fd); }
}

function ensureDirectory(path, mode, options) {
  if (!exists(path)) {
    validateSecureParent(dirname(path), options);
    mkdirSync(path, { mode, recursive: false });
    fsyncDirectory(dirname(path), options);
  }
  validateDirectory(path, mode, options);
}

function validateDirectory(path, mode, options) {
  const value = lstatSync(path);
  const owner = expectedOwner(options);
  if (!value.isDirectory() || value.isSymbolicLink()
    || value.uid !== owner.uid || value.gid !== owner.gid || (value.mode & 0o777) !== mode) {
    throw new Error("Permit terminalization directory boundary is invalid");
  }
}

function validateSecureParent(path, options) {
  const value = lstatSync(path);
  const owner = expectedOwner(options);
  if (!value.isDirectory() || value.isSymbolicLink()
    || value.uid !== owner.uid || value.gid !== owner.gid || (value.mode & 0o022) !== 0) {
    throw new Error("Permit terminalization parent boundary is invalid");
  }
}

function directoryIdentity(path, mode, options) {
  validateDirectory(path, mode, options);
  return statIdentity(lstatSync(path));
}

function assertSameFileIdentity(path, identity, mode, options) {
  const current = lstatSync(path);
  const owner = expectedOwner(options);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
    || current.uid !== owner.uid || current.gid !== owner.gid || (current.mode & 0o777) !== mode
    || canonicalJson(statPathIdentity(current)) !== canonicalJson(identity)) {
    throw new Error("Permit terminalization environment changed before atomic replacement");
  }
}

function trustedDescriptorIdentity(fd) {
  return statIdentity(fstatSync(fd));
}

function validateIdentity(value) {
  exactObject(value, ["dev", "gid", "ino", "mode", "size", "uid"], "Permit terminalization identity is invalid");
  if (![value.dev, value.ino, value.size, value.uid, value.gid, value.mode].every(Number.isSafeInteger)
    || value.dev < 0 || value.ino < 0 || value.size < 0 || value.uid < 0 || value.gid < 0
    || value.mode < 0 || value.mode > 0o777) {
    throw new Error("Permit terminalization identity is invalid");
  }
  return value;
}

function assertTrustedTerminalizationContext(operationId, sourceReceiptSha256) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("Permit terminalization requires controlled Linux root");
  }
  if (process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
    || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY !== "terminalize-production-self-test-permit.sh"
    || process.env.XINGHENG_PERMIT_TERMINALIZATION_OPERATION_ID !== operationId
    || process.env.XINGHENG_PERMIT_TERMINALIZATION_SOURCE_SHA256 !== sourceReceiptSha256) {
    throw new Error("Permit terminalization trusted wrapper context is invalid");
  }
  inheritedOperationLocks("production");
  for (const [path, fd] of [[PERMIT_TERMINALIZATION_WRAPPER, 6], [TRUSTED_LAUNCHER, 7]]) {
    const metadata = lstatSync(path);
    const descriptor = fstatSync(fd);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o022) !== 0
      || (metadata.mode & 0o111) === 0 || descriptor.dev !== metadata.dev
      || descriptor.ino !== metadata.ino || descriptor.size !== metadata.size
      || descriptor.uid !== 0 || descriptor.gid !== 0 || descriptor.nlink !== 1) {
      throw new Error("Permit terminalization trusted descriptor is invalid");
    }
  }
  assertTrustedProductionReleaseRoot(PRODUCTION_ROOT);
}

function terminalizationPaths(options) {
  const root = resolve(options.rootPath ?? PERMIT_TERMINALIZATION_ROOT);
  return {
    root,
    operationRoot: (operationId) => resolve(root, operationId),
    receiptPath: resolve(options.receiptPath ?? PERMIT_INSTALL_RECEIPT),
    attemptsRoot: resolve(options.attemptsRoot ?? PERMIT_INSTALL_ATTEMPTS),
    environmentPath: resolve(options.environmentPath ?? PRODUCTION_ENVIRONMENT),
    windowRoot: resolve(options.windowRoot ?? CAPITAL_TEST_WINDOW_HOST_ROOT),
  };
}

function dockerOutputOptions() {
  return { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
}

function splitEnvironmentEntry(entry) {
  const index = entry.indexOf("=");
  return index < 1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
}

function expectedOwner(options) {
  return options.testMode === true
    ? { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }
    : { uid: 0, gid: 0 };
}

function statIdentity(value) {
  return { dev: value.dev, ino: value.ino, size: value.size, uid: value.uid, gid: value.gid, mode: value.mode & 0o777 };
}

function statPathIdentity(value) {
  return { ...statIdentity(value), mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && (left.mode & 0o777) === (right.mode & 0o777);
}

function exactHex(value, length, message) {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/u.test(value)) throw new Error(message);
  return value;
}

function exactObject(value, keys, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(message);
  return value;
}

function strictUtcString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function strictUtc(value, message) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(message);
  return value.toISOString();
}

function monotonicUtc(value, minimum, message) {
  const current = strictUtc(value, message);
  if (!strictUtcString(minimum) || Date.parse(current) < Date.parse(minimum)) throw new Error(message);
  return current;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function invokeFs(options, name, operation) { return options.operations?.[name] ? options.operations[name](operation) : operation(); }
function fsyncDirectory(path, options) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { invokeFs(options, "directoryFsync", () => fsyncSync(fd)); } finally { closeSync(fd); } }

async function main() {
  if (process.argv[2] !== "terminalize-success" || process.argv.length !== 5) {
    throw new Error("usage: productionSelfTestPermitTerminalization.mjs terminalize-success SOURCE_RECEIPT_SHA OPERATION_ID");
  }
  const sourceReceiptSha256 = process.argv[3] ?? "";
  const operationId = process.argv[4] ?? "";
  assertTrustedTerminalizationContext(operationId, sourceReceiptSha256);
  const result = terminalizeExpiredSuccessfulPermit({ operationId, expectedReceiptSha256: sourceReceiptSha256 });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Permit terminalization failed");
    process.exitCode = 1;
  });
}
