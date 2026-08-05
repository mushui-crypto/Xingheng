import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRevisionEnv, validateReleaseManifest } from "./deploymentRevision.mjs";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import { readTrustedReleaseCandidateReceipt, releaseCandidatePaths } from "./trustedReleaseCandidate.mjs";
import { captureTrustedReleaseTree } from "./trustedReleaseTree.mjs";
import {
  executePromotionAtomicExchange,
  readValidatedProductionTrustReceipt,
  readValidatedPromotionHelperReceipt,
} from "./trustedDockerRuntime.mjs";

export const PROMOTION_STATES = Object.freeze([
  "PROMOTION_STARTED",
  "PROMOTION_EXCHANGED",
  "PROMOTION_COMPLETED",
  "PROMOTION_UNKNOWN",
]);
export const PROMOTION_ROOT = "/var/lib/xingheng/release-promotion";
export const PROMOTION_RECORD = `${PROMOTION_ROOT}/current.json`;
export const PROMOTION_HELPER = "/usr/local/libexec/xingheng-promotion-atomic-exchange";
export const PROMOTION_HELPER_RECEIPT = "/etc/xingheng/promotion-atomic-exchange.json";

const RELEASE_PARENT = "/opt/xingheng-release";
const CANONICAL_ROOT = `${RELEASE_PARENT}/code`;
const TRUST_RECEIPT = "/etc/xingheng/trusted-operations.json";
const LIFECYCLE_POINTER = "/var/lib/xingheng/release-lifecycle/current.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROMOTION_WRAPPER = join(SCRIPT_DIRECTORY, "release-promote.sh");
const TRUSTED_OPERATION_LAUNCHER = join(SCRIPT_DIRECTORY, "trusted-operation-launcher.mjs");

export class ReleasePromotionTransaction {
  constructor(options = {}) {
    this.testMode = options.testMode === true;
    this.uid = this.testMode ? (process.getuid?.() ?? -1) : 0;
    this.gid = this.testMode ? (process.getgid?.() ?? -1) : 0;
    if (!this.testMode && (process.platform !== "linux"
      || process.getuid?.() !== 0 || process.getgid?.() !== 0)) {
      throw new Error("release promotion requires controlled root on Linux");
    }
    this.paths = Object.freeze({
      releaseParent: resolve(options.releaseParent ?? RELEASE_PARENT),
      canonicalRoot: resolve(options.canonicalRoot ?? CANONICAL_ROOT),
      candidatesRoot: resolve(options.candidatesRoot ?? `${RELEASE_PARENT}/candidates`),
      stateRoot: resolve(options.stateRoot ?? PROMOTION_ROOT),
      statePath: resolve(options.statePath ?? PROMOTION_RECORD),
      trustReceipt: resolve(options.trustReceipt ?? TRUST_RECEIPT),
      lifecyclePointer: resolve(options.lifecyclePointer ?? LIFECYCLE_POINTER),
      helperPath: resolve(options.helperPath ?? PROMOTION_HELPER),
      helperReceipt: resolve(options.helperReceipt ?? PROMOTION_HELPER_RECEIPT),
    });
    this.exchange = options.exchange ?? ((input) => executePromotionAtomicExchange(input));
    this.installTrust = options.installTrust ?? (() => this.installTrustedOperations());
    this.now = options.now ?? (() => new Date());
    this.fault = options.fault ?? (() => {});
    this.validateMainTrust = options.validateMainTrust ?? (() => readValidatedProductionTrustReceipt());
    this.validateHelper = options.validateHelper ?? (() => readValidatedPromotionHelperReceipt({
      helperPath: this.paths.helperPath,
      receiptPath: this.paths.helperReceipt,
    }));
  }

  promote(expected) {
    if (!this.testMode) assertTrustedPromotionMutationContext();
    validateExpectedCandidate(expected);
    if (existsNoFollow(this.paths.statePath)) {
      const current = readPromotionRecord(this.paths.statePath, this.uid, this.gid);
      if (current.state === "PROMOTION_COMPLETED"
        && current.candidate.revision === expected.revision) {
        throw new Error("candidate promotion is already completed");
      }
      throw new Error("release promotion state is not IDLE");
    }
    const operationId = expected.operationId ?? randomUUID();
    if (!UUID.test(operationId)) throw new Error("promotion operation ID is invalid");
    const candidate = this.captureCandidate(expected);
    const oldCanonical = captureCanonicalIdentity(this.paths, this.uid, this.gid);
    ensureSecureDirectory(this.paths.stateRoot, this.uid, this.gid, 0o700);
    const stagingPath = join(this.paths.releaseParent, `.promotion-staging-${operationId}`);
    const staging = this.prepareStaging(stagingPath, candidate, oldCanonical);
    this.fault("staging_prepared");
    const started = {
      schemaVersion: 1,
      state: "PROMOTION_STARTED",
      operationId,
      startedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      candidate,
      oldCanonical,
      staging,
      newCanonical: null,
      trustReceiptSha256: null,
      helperReceiptSha256: null,
      success: null,
      failureStage: null,
    };
    this.fault("before_started_publish");
    writePromotionRecord(this.paths.statePath, started, this.uid, this.gid, true);
    let exchangeInvoked = false;
    try {
      this.fault("after_started_publish");
      this.assertUnchangedBeforeExchange(candidate, oldCanonical, staging);
      const context = secureFile(this.paths.statePath, this.uid, this.gid, 0o400, 1024 * 1024);
      try {
        exchangeInvoked = true;
        this.exchange({
          operationId,
          contextSha256: context.sha256,
          contextFd: context.fd,
          canonical: directoryIdentity(this.paths.canonicalRoot, this.uid, this.gid),
          staging: directoryIdentity(stagingPath, this.uid, this.gid),
          helperPath: this.paths.helperPath,
          testMode: this.testMode,
        });
        this.fault("after_exchange");
      } finally {
        closeSync(context.fd);
      }
      const exchanged = {
        ...started,
        state: "PROMOTION_EXCHANGED",
        updatedAt: this.now().toISOString(),
      };
      writePromotionRecord(this.paths.statePath, exchanged, this.uid, this.gid);
      this.fault("after_exchanged_publish");
      let newCanonical = captureCanonicalIdentity(this.paths, this.uid, this.gid);
      assertNewCanonical(candidate, newCanonical, oldCanonical, staging);
      const trustReceiptSha256 = this.installTrust();
      this.fault("after_trust_install");
      const currentRecord = readPromotionRecord(this.paths.statePath, this.uid, this.gid);
      if (currentRecord.state !== "PROMOTION_EXCHANGED"
        || canonical(currentRecord) !== canonical(exchanged)) {
        throw new Error("promotion record changed before completion");
      }
      newCanonical = captureCanonicalIdentity(this.paths, this.uid, this.gid);
      assertNewCanonical(candidate, newCanonical, oldCanonical, staging);
      const trusted = this.validateMainTrust();
      if (trusted.receiptSha256 !== trustReceiptSha256
        || trusted.releaseRoot !== this.paths.canonicalRoot
        || trusted.releaseTree?.sha256 !== newCanonical.releaseTreeSha256) {
        throw new Error("installed trust receipt identity mismatch");
      }
      const helper = this.validateHelperIdentity();
      const completedAt = this.now().toISOString();
      const success = {
        operationId,
        timestamp: completedAt,
        oldCanonical,
        newCanonical,
        candidate,
        trustReceiptSha256,
        helperReceiptSha256: helper.receiptSha256,
      };
      const completed = {
        ...exchanged,
        state: "PROMOTION_COMPLETED",
        updatedAt: completedAt,
        newCanonical,
        trustReceiptSha256,
        helperReceiptSha256: helper.receiptSha256,
        success,
      };
      this.fault("before_completed_publish");
      writePromotionRecord(this.paths.statePath, completed, this.uid, this.gid);
      assertPromotionStateAllowsProduction({
        ...this.paths,
        expectedUid: this.uid,
        expectedGid: this.gid,
        validateMainTrust: this.validateMainTrust,
        validateHelper: this.validateHelper,
      });
      return Object.freeze(completed);
    } catch (error) {
      const failureStage = exchangeInvoked ? "exchange_or_post_exchange" : "pre_exchange";
      const unknown = {
        ...started,
        state: "PROMOTION_UNKNOWN",
        updatedAt: this.now().toISOString(),
        failureStage,
      };
      try {
        writePromotionRecord(this.paths.statePath, unknown, this.uid, this.gid);
      } catch {
        // An untrusted or unwriteable record remains globally fail-closed.
      }
      throw error;
    }
  }

  terminalizeUnknown(operationId) {
    if (!this.testMode) assertTrustedPromotionMutationContext();
    if (!UUID.test(operationId ?? "")) throw new Error("promotion operation ID is invalid");
    assertSecureDirectory(this.paths.stateRoot, this.uid, this.gid, 0o700);
    const current = readPromotionRecord(this.paths.statePath, this.uid, this.gid);
    if (current.operationId !== operationId
      || !["PROMOTION_STARTED", "PROMOTION_EXCHANGED"].includes(current.state)) {
      throw new Error("promotion record cannot be terminalized");
    }
    const unknown = {
      ...current,
      state: "PROMOTION_UNKNOWN",
      updatedAt: this.now().toISOString(),
      failureStage: "manual_terminalization",
    };
    writePromotionRecord(this.paths.statePath, unknown, this.uid, this.gid);
    return unknown;
  }

  captureCandidate(expected) {
    const receipt = readTrustedReleaseCandidateReceipt(expected.revision, {
      candidatesRoot: this.paths.candidatesRoot,
      expectedUid: this.uid,
      expectedGid: this.gid,
      skipParentChain: this.testMode,
    });
    const paths = releaseCandidatePaths(expected.revision, {
      candidatesRoot: this.paths.candidatesRoot,
    });
    const manifestFile = secureFile(paths.manifest, this.uid, this.gid, 0o444, 64 * 1024);
    let manifest;
    try {
      manifest = validateReleaseManifest(JSON.parse(manifestFile.bytes.toString("utf8")));
    } finally {
      closeSync(manifestFile.fd);
      manifestFile.bytes.fill(0);
    }
    const actual = {
      revision: receipt.revision,
      sourceSha256: receipt.sourceArchive.sha256,
      treeSha256: receipt.candidateTree.sha256,
      manifestSha256: manifestFile.sha256,
      images: manifest.images,
      receiptSha256: receipt.receiptSha256,
    };
    if (canonical(actualWithoutReceipt(actual)) !== canonical(expectedWithoutOperation(expected))) {
      throw new Error("candidate promotion identity mismatch");
    }
    return Object.freeze(actual);
  }

  prepareStaging(path, candidate, oldCanonical) {
    if (existsNoFollow(path)) throw new Error("promotion staging already exists");
    const candidatePaths = releaseCandidatePaths(candidate.revision, {
      candidatesRoot: this.paths.candidatesRoot,
    });
    cpSync(candidatePaths.codeRoot, path, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    chmodSync(path, 0o700);
    const manifestTarget = join(path, "deploy/release-manifest.json");
    rmSync(manifestTarget, { force: true });
    cpSync(candidatePaths.manifest, manifestTarget, { force: false, errorOnExist: true });
    chmodSync(manifestTarget, 0o444);
    const oldEnvironment = secureFile(
      join(this.paths.canonicalRoot, ".env.production"),
      this.uid,
      this.gid,
      0o600,
      16 * 1024 * 1024,
    );
    try {
      const environmentTarget = join(path, ".env.production");
      const candidateEnvironment = bindPromotionEnvironment(
        oldEnvironment.bytes,
        oldCanonical.revision,
        candidate.revision,
      );
      try {
        writeImmutableBytes(environmentTarget, candidateEnvironment, this.uid, this.gid, 0o600);
        const stagedEnvironment = secureFile(
          environmentTarget, this.uid, this.gid, 0o600, 16 * 1024 * 1024,
        );
        try {
          if (!stagedEnvironment.bytes.equals(candidateEnvironment)
            || parseRevisionEnv(stagedEnvironment.bytes.toString("utf8")) !== candidate.revision) {
            throw new Error("promotion environment identity changed while staging");
          }
        } finally {
          closeSync(stagedEnvironment.fd);
          stagedEnvironment.bytes.fill(0);
        }
      } finally {
        candidateEnvironment.fill(0);
      }
    } finally {
      closeSync(oldEnvironment.fd);
      oldEnvironment.bytes.fill(0);
    }
    fsyncTree(path);
    const identity = captureStagingIdentity(path, this.uid, this.gid);
    if (identity.manifestSha256 !== candidate.manifestSha256
      || identity.environmentSha256 === oldCanonical.environmentSha256) {
      throw new Error("promotion staging identity is invalid");
    }
    return Object.freeze(identity);
  }

  assertUnchangedBeforeExchange(candidate, oldCanonical, staging) {
    const recapturedCandidate = this.captureCandidate({ ...candidate });
    if (canonical(recapturedCandidate) !== canonical(candidate)) {
      throw new Error("candidate identity changed before exchange");
    }
    const currentCanonical = captureCanonicalIdentity(this.paths, this.uid, this.gid);
    if (canonical(currentCanonical) !== canonical(oldCanonical)) {
      throw new Error("canonical identity changed before exchange");
    }
    const currentStaging = captureStagingIdentity(staging.path, this.uid, this.gid);
    if (canonical(currentStaging) !== canonical(staging)) {
      throw new Error("promotion staging identity changed before exchange");
    }
  }

  validateHelperIdentity() {
    const helper = this.validateHelper();
    try {
      if (!SHA256.test(helper.receiptSha256 ?? "")) {
        throw new Error("promotion helper receipt identity is invalid");
      }
      return { receiptSha256: helper.receiptSha256 };
    } finally {
      if (helper.opened?.fd !== undefined) closeSync(helper.opened.fd);
    }
  }

  installTrustedOperations() {
    const result = spawnSync("/usr/bin/node", [
      join(this.paths.canonicalRoot, "scripts/install-trusted-operations.mjs"),
      "install",
    ], { cwd: this.paths.canonicalRoot, env: fixedEnvironment(), encoding: "utf8" });
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error("trusted operations installation failed after exchange");
    }
    const parsed = JSON.parse(result.stdout);
    if (parsed?.ok !== true || !SHA256.test(parsed.receiptSha256 ?? "")) {
      throw new Error("trusted operations installation receipt is invalid");
    }
    return parsed.receiptSha256;
  }
}

export function assertPromotionStateAllowsProduction(options = {}) {
  const statePath = resolve(options.statePath ?? PROMOTION_RECORD);
  if (!existsNoFollow(statePath)) return Object.freeze({ state: "IDLE" });
  const uid = options.expectedUid ?? 0;
  const gid = options.expectedGid ?? 0;
  const record = readPromotionRecord(statePath, uid, gid);
  if (record.state !== "PROMOTION_COMPLETED") {
    throw new Error("production trusted operations are blocked by promotion state");
  }
  const paths = {
    canonicalRoot: resolve(options.canonicalRoot ?? CANONICAL_ROOT),
    trustReceipt: resolve(options.trustReceipt ?? TRUST_RECEIPT),
    lifecyclePointer: resolve(options.lifecyclePointer ?? LIFECYCLE_POINTER),
    helperPath: resolve(options.helperPath ?? PROMOTION_HELPER),
    helperReceipt: resolve(options.helperReceipt ?? PROMOTION_HELPER_RECEIPT),
  };
  const current = captureCanonicalIdentity(paths, uid, gid);
  const trusted = options.validateMainTrust?.() ?? readValidatedProductionTrustReceipt();
  const helper = options.validateHelper?.() ?? readValidatedPromotionHelperReceipt({
    helperPath: paths.helperPath,
    receiptPath: paths.helperReceipt,
    testMode: uid !== 0 || gid !== 0,
  });
  try {
  if (canonical(record.newCanonical) !== canonical(current)
    || record.trustReceiptSha256 !== trusted.receiptSha256
    || record.helperReceiptSha256 !== helper.receiptSha256
    || trusted.releaseRoot !== paths.canonicalRoot
    || trusted.releaseTree?.sha256 !== current.releaseTreeSha256
    || canonical(record.success) !== canonical({
      operationId: record.operationId,
      timestamp: record.updatedAt,
      oldCanonical: record.oldCanonical,
      newCanonical: record.newCanonical,
      candidate: record.candidate,
      trustReceiptSha256: record.trustReceiptSha256,
      helperReceiptSha256: record.helperReceiptSha256,
    })) {
    throw new Error("completed promotion identity is invalid");
  }
  return Object.freeze(record);
  } finally {
    if (helper.opened?.fd !== undefined) closeSync(helper.opened.fd);
  }
}

export function readPromotionRecord(path = PROMOTION_RECORD, uid = 0, gid = 0) {
  const opened = secureJson(path, uid, gid, 0o400, 1024 * 1024);
  validatePromotionRecord(opened.value);
  return Object.freeze(opened.value);
}

export function validateTrustedPromotionArguments(args, source = process.env) {
  const keys = Object.keys(source).sort();
  if (keys.join(",") !== "HOME,LANG,LC_ALL,PATH,TZ"
    || source.HOME !== "/root" || source.PATH !== "/usr/sbin:/usr/bin:/sbin:/bin"
    || source.LANG !== "C.UTF-8" || source.LC_ALL !== "C.UTF-8" || source.TZ !== "UTC") {
    throw new Error("trusted promotion environment is invalid");
  }
  if (args.length !== 2) throw new Error("trusted promotion arguments are invalid");
  if (args[0] === "--terminalize-unknown") {
    if (!UUID.test(args[1])) throw new Error("trusted promotion terminalization input is invalid");
    return Object.freeze({ command: "terminalize-unknown", operationId: args[1] });
  }
  if (args[0] !== "--promotion-json"
    || !/^[A-Za-z0-9_-]{100,8192}$/u.test(args[1])) {
    throw new Error("trusted promotion payload is invalid");
  }
  let value;
  try {
    const decoded = Buffer.from(args[1], "base64url");
    if (decoded.toString("base64url") !== args[1]) throw new Error("non-canonical base64url");
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("trusted promotion payload is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "images", "manifestSha256", "operationId", "revision", "sourceSha256", "treeSha256",
    ].sort().join(",") || !UUID.test(value.operationId ?? "")) {
    throw new Error("trusted promotion payload schema is invalid");
  }
  validateExpectedCandidate(value);
  return Object.freeze({ command: "promote", value: Object.freeze(value) });
}

function assertTrustedPromotionMutationContext() {
  if (inheritedOperationLocks("promotion") === null
    || process.env.XINGHENG_TRUSTED_OPERATION_ENTRY !== "release-promote.sh") {
    throw new Error("release promotion trusted wrapper context is invalid");
  }
  const candidateRevision = basename(dirname(resolve(SCRIPT_DIRECTORY, "..")));
  if (!REVISION.test(candidateRevision)
    || process.env.XINGHENG_RELEASE_CANDIDATE_REVISION !== candidateRevision) {
    throw new Error("release promotion candidate context is invalid");
  }
  assertInheritedTrustedEntry(PROMOTION_WRAPPER, 6, "wrapper");
  assertInheritedTrustedEntry(TRUSTED_OPERATION_LAUNCHER, 7, "launcher");
}

function assertInheritedTrustedEntry(path, fd, label) {
  const current = lstatSync(path);
  const inherited = fstatSync(fd);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
    || current.uid !== 0 || current.gid !== 0 || current.size < 1
    || (current.mode & 0o022) !== 0 || (current.mode & 0o111) === 0
    || inherited.dev !== current.dev || inherited.ino !== current.ino
    || inherited.size !== current.size || inherited.uid !== 0 || inherited.gid !== 0
    || inherited.nlink !== 1 || (inherited.mode & 0o777) !== (current.mode & 0o777)) {
    throw new Error(`release promotion trusted ${label} descriptor is invalid`);
  }
}

function captureCanonicalIdentity(paths, uid, gid) {
  const manifest = secureJson(
    join(paths.canonicalRoot, "deploy/release-manifest.json"), uid, gid, 0o444, 64 * 1024,
  );
  const parsed = validateReleaseManifest(manifest.value);
  const environment = secureFile(
    join(paths.canonicalRoot, ".env.production"), uid, gid, 0o600, 16 * 1024 * 1024,
  );
  const lifecycle = secureFile(paths.lifecyclePointer, uid, gid, 0o600, 1024 * 1024);
  try {
    const releaseTree = capturePromotionReleaseTree(paths.canonicalRoot, uid, gid);
    const root = directoryIdentity(paths.canonicalRoot, uid, gid);
    return Object.freeze({
      revision: parsed.revision,
      images: parsed.images,
      manifestSha256: manifest.sha256,
      releaseTreeSha256: releaseTree.sha256,
      environmentSha256: environment.sha256,
      lifecyclePointerSha256: lifecycle.sha256,
      rootDev: root.dev,
      rootIno: root.ino,
    });
  } finally {
    closeSync(environment.fd);
    environment.bytes.fill(0);
    closeSync(lifecycle.fd);
    lifecycle.bytes.fill(0);
  }
}

function assertNewCanonical(candidate, current, oldCanonical, staging) {
  if (current.revision !== candidate.revision
    || canonical(current.images) !== canonical(candidate.images)
    || current.manifestSha256 !== candidate.manifestSha256
    || current.environmentSha256 !== staging.environmentSha256
    || current.lifecyclePointerSha256 !== oldCanonical.lifecyclePointerSha256
    || current.rootDev === oldCanonical.rootDev
    && current.rootIno === oldCanonical.rootIno) {
    throw new Error("new canonical identity verification failed");
  }
}

function bindPromotionEnvironment(bytes, oldRevision, candidateRevision) {
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)
    || parseRevisionEnv(source) !== oldRevision) {
    throw new Error("canonical promotion environment identity is invalid");
  }
  const bound = source.replace(
    /^XINGHENG_REVISION=[^\r\n]*(?=\r?$)/mu,
    `XINGHENG_REVISION=${candidateRevision}`,
  );
  if (bound === source || parseRevisionEnv(bound) !== candidateRevision) {
    throw new Error("candidate promotion environment binding failed");
  }
  return Buffer.from(bound, "utf8");
}

function validateExpectedCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !REVISION.test(value.revision ?? "")
    || !SHA256.test(value.sourceSha256 ?? "")
    || !SHA256.test(value.treeSha256 ?? "")
    || !SHA256.test(value.manifestSha256 ?? "")
    || !value.images || Object.keys(value.images).sort().join(",") !== "api,strategyTools,web"
    || !Object.values(value.images).every((item) => IMAGE.test(item))) {
    throw new Error("expected candidate identity is invalid");
  }
  if (value.operationId !== undefined && !UUID.test(value.operationId)) {
    throw new Error("promotion operation ID is invalid");
  }
}

function validatePromotionRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "candidate", "failureStage", "newCanonical", "oldCanonical", "operationId",
      "schemaVersion", "staging", "startedAt", "state", "success",
      "trustReceiptSha256", "helperReceiptSha256", "updatedAt",
    ].sort().join(",")
    || value.schemaVersion !== 1 || !PROMOTION_STATES.includes(value.state)
    || !UUID.test(value.operationId ?? "") || !validUtc(value.startedAt) || !validUtc(value.updatedAt)) {
    throw new Error("promotion record schema is invalid");
  }
  validateExpectedCandidate(value.candidate);
  validateCanonicalIdentity(value.oldCanonical);
  if (!value.staging || typeof value.staging.path !== "string"
    || !Number.isSafeInteger(value.staging.dev) || !Number.isSafeInteger(value.staging.ino)
    || !SHA256.test(value.staging.environmentSha256 ?? "")
    || !SHA256.test(value.staging.manifestSha256 ?? "")
    || !SHA256.test(value.staging.releaseTreeSha256 ?? "")
    || Object.keys(value.staging).sort().join(",") !== [
      "dev", "environmentSha256", "ino", "manifestSha256", "path", "releaseTreeSha256",
    ].sort().join(",")) {
    throw new Error("promotion staging record is invalid");
  }
  if (value.state === "PROMOTION_COMPLETED") {
    validateCanonicalIdentity(value.newCanonical);
    if (!SHA256.test(value.trustReceiptSha256 ?? "")
      || !SHA256.test(value.helperReceiptSha256 ?? "") || !value.success) {
      throw new Error("completed promotion record is invalid");
    }
  } else if (value.newCanonical !== null || value.trustReceiptSha256 !== null
    || value.helperReceiptSha256 !== null || value.success !== null) {
    throw new Error("non-completed promotion record contains success state");
  }
  if (value.state === "PROMOTION_UNKNOWN") {
    if (!["pre_exchange", "exchange_or_post_exchange", "manual_terminalization"]
      .includes(value.failureStage)) throw new Error("unknown promotion failure stage is invalid");
  } else if (value.failureStage !== null) throw new Error("promotion failure stage is invalid");
}

function validateCanonicalIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "environmentSha256", "images", "lifecyclePointerSha256", "manifestSha256",
      "releaseTreeSha256", "revision", "rootDev", "rootIno",
    ].sort().join(",")
    || !REVISION.test(value.revision ?? "")
    || !value.images || !Object.values(value.images).every((item) => IMAGE.test(item))
    || ![value.environmentSha256, value.lifecyclePointerSha256, value.manifestSha256,
      value.releaseTreeSha256].every((item) => SHA256.test(item ?? ""))
    || !Number.isSafeInteger(value.rootDev) || !Number.isSafeInteger(value.rootIno)) {
    throw new Error("canonical promotion identity is invalid");
  }
}

function writePromotionRecord(path, value, uid, gid, exclusive = false) {
  validatePromotionRecord(value);
  const bytes = Buffer.from(`${canonical(value)}\n`, "utf8");
  const pending = `${path}.pending-${process.pid}`;
  const fd = openSync(pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== uid
      || metadata.gid !== gid || (metadata.mode & 0o777) !== 0o400) {
      throw new Error("promotion record staging boundary is invalid");
    }
  } finally {
    closeSync(fd);
  }
  if (exclusive) {
    try {
      linkSync(pending, path);
      unlinkSync(pending);
      fsyncDirectory(dirname(path));
      const published = lstatSync(path);
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1
        || published.uid !== uid || published.gid !== gid
        || (published.mode & 0o777) !== 0o400) {
        throw new Error("promotion record publication boundary is invalid");
      }
      return;
    } catch (error) {
      rmSync(pending, { force: true });
      if (error?.code === "EEXIST") throw new Error("promotion record already exists");
      throw error;
    }
  }
  renameSync(pending, path);
  fsyncDirectory(dirname(path));
}

function writeImmutableBytes(path, bytes, uid, gid, mode) {
  const fd = openSync(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    fchmodSync(fd, mode);
    const metadata = fstatSync(fd);
    if (metadata.uid !== uid || metadata.gid !== gid || metadata.nlink !== 1) {
      throw new Error("promotion staged file boundary is invalid");
    }
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function secureJson(path, uid, gid, mode, maximum) {
  const file = secureFile(path, uid, gid, mode, maximum);
  try {
    return { value: JSON.parse(file.bytes.toString("utf8")), sha256: file.sha256 };
  } finally {
    closeSync(file.fd);
    file.bytes.fill(0);
  }
}

function secureFile(path, uid, gid, mode, maximum) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== uid || before.gid !== gid || (before.mode & 0o777) !== mode
    || before.size < 1 || before.size > maximum) throw new Error("promotion file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
    || opened.uid !== uid || opened.gid !== gid || opened.nlink !== 1
    || (opened.mode & 0o777) !== mode) {
    closeSync(fd);
    throw new Error("promotion file changed while opening");
  }
  const bytes = readFileSync(fd);
  const after = fstatSync(fd);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
    || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
    closeSync(fd); bytes.fill(0); throw new Error("promotion file changed while reading");
  }
  return { fd, bytes, sha256, size: opened.size };
}

function directoryIdentity(path, uid, gid) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o022) !== 0) {
    throw new Error("promotion directory boundary is invalid");
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function captureStagingIdentity(path, uid, gid) {
  const directory = directoryIdentity(path, uid, gid);
  const manifest = secureFile(join(path, "deploy/release-manifest.json"), uid, gid, 0o444, 64 * 1024);
  const environment = secureFile(join(path, ".env.production"), uid, gid, 0o600, 16 * 1024 * 1024);
  try {
    const releaseTree = capturePromotionReleaseTree(path, uid, gid);
    return Object.freeze({
      path,
      dev: directory.dev,
      ino: directory.ino,
      manifestSha256: manifest.sha256,
      releaseTreeSha256: releaseTree.sha256,
      environmentSha256: environment.sha256,
    });
  } finally {
    closeSync(manifest.fd); manifest.bytes.fill(0);
    closeSync(environment.fd); environment.bytes.fill(0);
  }
}

function ensureSecureDirectory(path, uid, gid, mode) {
  try { mkdirSync(path, { mode, recursive: false }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o777) !== mode) {
    throw new Error("promotion state directory boundary is invalid");
  }
  fsyncDirectory(path);
}

function assertSecureDirectory(path, uid, gid, mode) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o777) !== mode) {
    throw new Error("promotion state directory boundary is invalid");
  }
}

function fsyncTree(path) {
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    const metadata = lstatSync(current);
    if (metadata.isDirectory()) {
      for (const name of readFileNames(current)) stack.push(join(current, name));
      fsyncDirectory(current);
    } else if (metadata.isFile()) {
      const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } else throw new Error("promotion staging contains unsupported objects");
  }
  fsyncDirectory(dirname(path));
}

function readFileNames(path) {
  return readdirSync(path).sort();
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function actualWithoutReceipt(value) {
  const { receiptSha256: _receipt, ...identity } = value;
  return identity;
}

function expectedWithoutOperation(value) {
  const { operationId: _operation, receiptSha256: _receipt, ...identity } = value;
  return identity;
}

function capturePromotionReleaseTree(root, uid, gid) {
  if (uid === 0 && gid === 0) {
    return captureTrustedReleaseTree(root, { expectedUid: uid, expectedGid: gid });
  }
  const manifest = secureFile(join(root, "deploy/release-manifest.json"), uid, gid, 0o444, 64 * 1024);
  try {
    return Object.freeze({ sha256: manifest.sha256 });
  } finally {
    closeSync(manifest.fd);
    manifest.bytes.fill(0);
  }
}

function fixedEnvironment() {
  return { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8", TZ: "UTC", XINGHENG_OPERATION_LOCK_CONTEXT: "promotion" };
}

function validUtc(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.endsWith("Z");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function existsNoFollow(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "promote" && process.argv.length === 4) {
    const validated = validateTrustedPromotionArguments(
      ["--promotion-json", process.argv[3]],
      { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8", TZ: "UTC" },
    );
    const result = new ReleasePromotionTransaction().promote(validated.value);
    console.log(JSON.stringify({ ok: true, state: result.state, operationId: result.operationId }));
    return;
  }
  if (command === "terminalize-unknown" && process.argv.length === 4) {
    const validated = validateTrustedPromotionArguments(
      ["--terminalize-unknown", process.argv[3]],
      { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8", TZ: "UTC" },
    );
    const result = new ReleasePromotionTransaction().terminalizeUnknown(validated.operationId);
    console.log(JSON.stringify({ ok: true, state: result.state, operationId: result.operationId }));
    return;
  }
  throw new Error("usage: releasePromotionTransaction.mjs promote BASE64URL_JSON | terminalize-unknown OPERATION_ID");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "release promotion failed");
    process.exitCode = 1;
  });
}
