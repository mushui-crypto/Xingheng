import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertTrustedReleaseCandidateRoot,
  readTrustedReleaseCandidateReceipt,
  releaseCandidatePaths,
} from "./trustedReleaseCandidate.mjs";

export const REAL_TEST_RUNTIME_PARENT = "/etc/xingheng-real-test";
export const REAL_TEST_RUNTIME_SELECTOR =
  "/etc/xingheng-real-test/runtime-release.json";
export const REAL_TEST_RUNTIME_ENV = "/etc/xingheng-real-test/runtime.env";

const FULL_REVISION = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 1024 * 1024;
const EXACT_RECEIPT_KEYS = Object.freeze([
  "binaries",
  "candidateReceiptSha256",
  "candidateRoot",
  "candidateTreeSha256",
  "checksumsPath",
  "checksumsSha256",
  "codeRoot",
  "daemon",
  "environment",
  "envPath",
  "images",
  "manifestPath",
  "manifestSha256",
  "revision",
  "schemaVersion",
  "socket",
  "sourceArchiveSha256",
]);
const BINARY_KEYS = Object.freeze([
  "compose", "docker", "findmnt", "flock", "git", "node", "sh", "sha256sum", "tar",
]);
export const REAL_TEST_RUNTIME_ENV_KEYS = Object.freeze(
  "XINGHENG_REVISION,REAL_TEST_DOMAIN,APP_PUBLIC_URL,CORS_ALLOWED_ORIGINS,ADMIN_EMAIL,ADMIN_PASSWORD,USER_SESSION_TTL_HOURS,ADMIN_SESSION_TTL_HOURS,AUTH_RATE_LIMIT_MAX,SMTP_HOST,SMTP_PORT,SMTP_SECURE,SMTP_USER,SMTP_PASSWORD,SMTP_FROM,HYPERLIQUID_REST_BASE_URL,HYPERLIQUID_STREAM_URL,REAL_TRADING_EXCHANGE_RATE_LIMIT_MAX,REAL_TRADING_RISK_MAX_SNAPSHOT_AGE_MS,REAL_TRADING_AUDIT_RETENTION_DAYS,REAL_TRADING_REALTIME_TOKEN_TTL_MS,REAL_TRADING_REALTIME_MAX_ADDRESSES,REAL_TRADING_RECONCILIATION_INTERVAL_MS,REAL_TRADING_RECONCILIATION_BATCH_SIZE,RWA_CREDENTIAL_KEY_PROVIDER,RWA_GCP_KMS_AUTH_MODE,RWA_GCP_KMS_KEY_NAME,RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL,RWA_AUTOMATION_DATA_DIR,RWA_AUTOMATION_INSTANCE_COUNT,WEB_CONCURRENCY,RWA_AUTOMATION_EXECUTION_MODE,RWA_AUTOMATION_LOCK_DIR,RWA_AUTOMATION_LOCK_PATH,RWA_AUTOMATION_SERVER_KILL_SWITCH,RWA_AUTOMATION_BACKUP_DIR,RWA_AUTOMATION_BACKUP_RETENTION_DAYS,RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES,RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES,RWA_AUTOMATION_CREDENTIAL_RATE_MAX,RWA_AUTOMATION_CREDENTIAL_RATE_WINDOW_SECONDS,RWA_AUTOMATION_RISK_CONTROL_RATE_MAX,RWA_AUTOMATION_RISK_CONTROL_RATE_WINDOW_SECONDS,RWA_AUTOMATION_PREFLIGHT_BURST_MAX,RWA_AUTOMATION_PREFLIGHT_BURST_WINDOW_SECONDS,RWA_AUTOMATION_PREFLIGHT_SUSTAINED_MAX,RWA_AUTOMATION_PREFLIGHT_SUSTAINED_WINDOW_SECONDS,RWA_AUTOMATION_EXECUTE_BURST_MAX,RWA_AUTOMATION_EXECUTE_BURST_WINDOW_SECONDS,RWA_AUTOMATION_EXECUTE_SUSTAINED_MAX,RWA_AUTOMATION_EXECUTE_SUSTAINED_WINDOW_SECONDS,RWA_AUTOMATION_EXECUTE_CONCURRENCY,RWA_AUTOMATION_EXIT_OPERATION_MAX,RWA_AUTOMATION_EXIT_OPERATION_WINDOW_SECONDS,RWA_AUTOMATION_EXIT_SHARED_MAX,RWA_AUTOMATION_EXIT_SHARED_WINDOW_SECONDS,RWA_AUTOMATION_EXIT_RESERVE_MAX,RWA_AUTOMATION_EXIT_RESERVE_WINDOW_SECONDS,RWA_AUTOMATION_EXIT_CONCURRENCY,RWA_AUTOMATION_MAX_IN_FLIGHT,RWA_AUTOMATION_MAX_IN_FLIGHT_PER_USER,RWA_AUTOMATION_PRIVATE_READ_MAX,RWA_AUTOMATION_PRIVATE_READ_WINDOW_SECONDS,RWA_AUTOMATION_MAX_RATE_BUCKETS,RWA_AUTOMATION_MAX_RATE_BUCKETS_PER_USER,RWA_AUTOMATION_MAX_GOVERNANCE_AUDIT,RWA_AUTOMATION_MAX_GOVERNANCE_AUDIT_PER_USER,RWA_AUTOMATION_CHALLENGE_TTL_SECONDS,RWA_AUTOMATION_MAX_CHALLENGES,RWA_AUTOMATION_MAX_CHALLENGES_PER_USER,RWA_AUTOMATION_MAX_USER_REGISTRIES,RWA_AUTOMATION_REGISTRY_IDLE_TTL_SECONDS,RWA_AUTOMATION_MAX_STEP_UP_AUTHORIZATIONS,RWA_AUTOMATION_MAX_STEP_UP_AUTHORIZATIONS_PER_USER,RWA_AUTOMATION_MAX_STEP_UP_ATTEMPTS,RWA_AUTOMATION_MAX_STEP_UP_ATTEMPTS_PER_USER,RWA_AUTOMATION_MAX_STEP_UP_STORES,RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS,RWA_AUTOMATION_MAX_COMPLETED_EXECUTIONS,RWA_AUTOMATION_MAX_COMPLETED_EXECUTIONS_HARD,RWA_AUTOMATION_MAX_ACTIVE_EXECUTIONS,RWA_AUTOMATION_MAX_PNL_POINTS,RWA_AUTOMATION_MAX_CREDENTIAL_AUDIT,RWA_AUTOMATION_STATE_MAX_BYTES,RWA_AUTOMATION_STATE_MAX_BYTES_HARD,RWA_BINANCE_ALLOWED_EGRESS_IPS,RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS,RWA_PROVIDER_PREFLIGHT_USER_ID,STRATEGY_FORWARD_REPORT_PATH,STRATEGY_HISTORY_REPORT_PATH,STRATEGY_FORWARD_WORKER_ENABLED,STRATEGY_FORWARD_WORKER_POLL_MS,MARTINGALE_GRID_PAPER_REPORT_PATH,MARTINGALE_GRID_PAPER_WORKER_ENABLED,MARTINGALE_GRID_PAPER_WORKER_POLL_MS,FIXED_GRID_PAPER_REPORT_PATH,FIXED_GRID_ARCHIVE_CACHE_PATH,FIXED_GRID_PAPER_WORKER_ENABLED,FIXED_GRID_PAPER_WORKER_POLL_MS,STRATEGY_EMAIL_ALERTS_ENABLED,STRATEGY_ALERT_EMAIL_TO,STRATEGY_ALERT_COOLDOWN_MS,BSC_TESTNET_CHAIN_ID,BSC_TESTNET_RPC_URL,BSC_TESTNET_TOKEN_ADDRESS,BSC_TESTNET_TOKEN_DECIMALS,BSC_TESTNET_CONFIRMATIONS,BSC_TESTNET_SCAN_START_BLOCK,BSC_TESTNET_SCAN_BATCH_SIZE,BSC_TESTNET_DERIVATION_PATH,BACKUP_RETENTION_DAYS"
    .split(",").sort(),
);
const FORBIDDEN_KEY = /^(?:COMPOSE_|DOCKER_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE$|GOOGLE_IMPERSONATE_SERVICE_ACCOUNT$|RWA_GCP_WIF_|XINGHENG_WIF_|.*(?:BINANCE|BYBIT).*_(?:API_KEY|API_SECRET|SECRET_KEY)$|RWA_.*(?:LOCAL_MASTER|MASTER_KEY|PROVIDER_WRITES|EXECUTION_ENABLED)|BSC_TESTNET_(?:PRIVATE_KEY|DEPOSIT_MNEMONIC)$)/u;

export function deriveRealTestRuntimeReceipt(revision, controlRoot, options = {}) {
  assertRevision(revision);
  const candidateOptions = options.candidateOptions ?? {};
  const trusted = assertTrustedReleaseCandidateRoot(
    controlRoot,
    revision,
    "real-test",
    candidateOptions,
  );
  const paths = releaseCandidatePaths(revision, "real-test", candidateOptions);
  const manifestFile = readSecureFile(paths.manifest, 0o444, options);
  let checksumsFile;
  try {
    checksumsFile = readSecureFile(paths.checksums, 0o444, options);
    const manifest = validateRealTestRuntimeManifest(
      JSON.parse(manifestFile.bytes.toString("utf8")),
    );
    validateRealTestRuntimeChecksums(
      checksumsFile.bytes.toString("utf8"),
      trusted.receipt,
      manifestFile.sha256,
    );
    if (manifest.revision !== revision) {
      throw new Error("real-test runtime manifest revision mismatch");
    }
    return validateRealTestRuntimeReceipt({
      schemaVersion: 1,
      environment: "real-test",
      revision,
      candidateRoot: paths.candidateRoot,
      codeRoot: paths.codeRoot,
      candidateReceiptSha256: trusted.receipt.receiptSha256,
      sourceArchiveSha256: trusted.receipt.sourceArchive.sha256,
      candidateTreeSha256: trusted.receipt.candidateTree.sha256,
      manifestPath: paths.manifest,
      manifestSha256: manifestFile.sha256,
      checksumsPath: paths.checksums,
      checksumsSha256: checksumsFile.sha256,
      images: manifest.images,
      socket: trusted.receipt.socket,
      binaries: trusted.receipt.binaries,
      daemon: trusted.receipt.daemon,
      envPath: REAL_TEST_RUNTIME_ENV,
    });
  } finally {
    closeSync(manifestFile.fd);
    if (checksumsFile) closeSync(checksumsFile.fd);
  }
}

export function readRealTestRuntimeContext(controlRoot, options = {}) {
  const selectorPath = fixedPath(options.selectorPath, REAL_TEST_RUNTIME_SELECTOR, options);
  const envPath = fixedPath(options.envPath, REAL_TEST_RUNTIME_ENV, options);
  const selectorFile = readSecureFile(selectorPath, 0o400, options);
  let environmentFile;
  try {
    const selector = validateRealTestRuntimeReceipt(
      JSON.parse(selectorFile.bytes.toString("utf8")),
    );
    if (selector.envPath !== REAL_TEST_RUNTIME_ENV) {
      throw new Error("real-test runtime env path mismatch");
    }
    const derived = deriveRealTestRuntimeReceipt(
      selector.revision,
      controlRoot,
      options,
    );
    if (canonicalJson(derived) !== canonicalJson(selector)) {
      throw new Error("real-test runtime selector identity mismatch");
    }
    environmentFile = readSecureFile(envPath, 0o400, options);
    const environment = parseRealTestRuntimeEnvironment(
      environmentFile.bytes.toString("utf8"),
      selector.revision,
    );
    return Object.freeze({
      selector,
      environment,
      selectorFile,
      environmentFile,
      paths: releaseCandidatePaths(
        selector.revision,
        "real-test",
        options.candidateOptions ?? {},
      ),
    });
  } catch (error) {
    closeSync(selectorFile.fd);
    if (environmentFile) closeSync(environmentFile.fd);
    throw error;
  }
}

export function validateRealTestRuntimeReceipt(value) {
  if (
    !hasExactKeys(value, EXACT_RECEIPT_KEYS)
    || value.schemaVersion !== 1
    || value.environment !== "real-test"
    || !FULL_REVISION.test(value.revision ?? "")
    || value.candidateRoot
      !== `/opt/xingheng-real-test-release/candidates/${value.revision}`
    || value.codeRoot !== `${value.candidateRoot}/code`
    || value.manifestPath !== `${value.candidateRoot}/release-manifest.json`
    || value.checksumsPath !== `${value.candidateRoot}/RELEASE_SHA256SUMS`
    || value.envPath !== REAL_TEST_RUNTIME_ENV
    || ![
      value.candidateReceiptSha256,
      value.sourceArchiveSha256,
      value.candidateTreeSha256,
      value.manifestSha256,
      value.checksumsSha256,
    ].every((item) => SHA256.test(item ?? ""))
    || value.socket !== "/var/run/docker.sock"
    || !hasExactKeys(value.images, ["api", "strategyTools", "web"])
    || !Object.values(value.images).every((item) => IMAGE_DIGEST.test(item ?? ""))
  ) {
    throw new Error("real-test runtime receipt schema is invalid");
  }
  validateHostIdentity(value);
  return deepFreeze({
    ...value,
    images: { ...value.images },
    binaries: Object.fromEntries(
      Object.entries(value.binaries).map(([key, item]) => [key, { ...item }]),
    ),
    daemon: { ...value.daemon },
  });
}

export function parseRealTestRuntimeEnvironment(source, revision) {
  if (typeof source !== "string" || !FULL_REVISION.test(revision ?? "")) {
    throw new Error("real-test runtime environment input is invalid");
  }
  const entries = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || entries.has(match[1])) {
      throw new Error("real-test runtime environment schema is invalid");
    }
    if (FORBIDDEN_KEY.test(match[1])) {
      throw new Error("real-test runtime environment contains a forbidden key");
    }
    entries.set(match[1], parseValue(match[2]));
  }
  if (
    [...entries.keys()].sort().join("\n") !== REAL_TEST_RUNTIME_ENV_KEYS.join("\n")
    || entries.get("XINGHENG_REVISION") !== revision
    || entries.get("RWA_CREDENTIAL_KEY_PROVIDER") !== "gcp-kms"
    || entries.get("RWA_GCP_KMS_AUTH_MODE") !== "gce_attached_service_account"
    || entries.get("RWA_AUTOMATION_SERVER_KILL_SWITCH") !== "true"
    || entries.get("RWA_AUTOMATION_EXECUTION_MODE") !== "single-host"
    || entries.get("RWA_AUTOMATION_INSTANCE_COUNT") !== "1"
    || entries.get("WEB_CONCURRENCY") !== "1"
    || !/^projects\/xingheng-real-test\/locations\/asia-southeast1\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/u
      .test(entries.get("RWA_GCP_KMS_KEY_NAME") ?? "")
    || !/^[A-Za-z0-9._%+-]+@xingheng-real-test\.iam\.gserviceaccount\.com$/u
      .test(entries.get("RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL") ?? "")
  ) {
    throw new Error("real-test runtime environment identity is invalid");
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function assertRuntimeFileUnchanged(receipt) {
  const current = assertRuntimeFileDescriptorUnchanged(receipt);
  let canonical;
  try {
    canonical = lstatSync(receipt.path);
  } catch {
    throw new Error("real-test runtime canonical file changed while in use");
  }
  if (
    !canonical.isFile()
    || canonical.isSymbolicLink()
    || canonical.dev !== current.dev
    || canonical.ino !== current.ino
    || canonical.size !== current.size
    || canonical.uid !== current.uid
    || canonical.gid !== current.gid
    || canonical.nlink !== 1
    || canonical.mtimeMs !== current.mtimeMs
    || canonical.ctimeMs !== current.ctimeMs
    || (canonical.mode & 0o777) !== (current.mode & 0o777)
  ) throw new Error("real-test runtime file changed while in use");
}

export function assertRuntimeFileDescriptorUnchanged(receipt) {
  const current = fstatSync(receipt.fd);
  if (
    current.dev !== receipt.dev
    || current.ino !== receipt.ino
    || current.size !== receipt.size
    || current.uid !== receipt.uid
    || current.gid !== receipt.gid
    || current.nlink !== 1
    || current.mtimeMs !== receipt.mtimeMs
    || current.ctimeMs !== receipt.ctimeMs
    || (current.mode & 0o777) !== receipt.mode
    || sha256Fd(receipt.fd, receipt.size) !== receipt.sha256
  ) throw new Error("real-test runtime file changed while in use");
  return current;
}

export function captureRiskReducingRuntimeFile(receipt) {
  const current = fstatSync(receipt.fd);
  assertRiskReducingDescriptorFacts(receipt, current);
  if (current.nlink === 1) {
    assertRuntimeFileUnchanged(receipt);
    return Object.freeze({ ctimeMs: receipt.ctimeMs, linked: true });
  }
  if (current.nlink !== 0 || canonicalPathStillNamesReceipt(receipt)) {
    throw new Error("risk-reducing runtime file unlink boundary is invalid");
  }
  return Object.freeze({ ctimeMs: current.ctimeMs, linked: false });
}

export function assertRiskReducingRuntimeFile(receipt, baseline) {
  const current = fstatSync(receipt.fd);
  assertRiskReducingDescriptorFacts(receipt, current);
  if (
    current.ctimeMs !== baseline.ctimeMs
    || (baseline.linked
      ? current.nlink !== 1
        || canonicalPathStillNamesReceipt(receipt) !== true
      : current.nlink !== 0
        || canonicalPathStillNamesReceipt(receipt) !== false)
  ) throw new Error("risk-reducing runtime file changed");
}

function assertRiskReducingDescriptorFacts(receipt, current) {
  if (
    current.dev !== receipt.dev
    || current.ino !== receipt.ino
    || current.size !== receipt.size
    || current.uid !== receipt.uid
    || current.gid !== receipt.gid
    || ![0, 1].includes(current.nlink)
    || current.mtimeMs !== receipt.mtimeMs
    || (current.mode & 0o777) !== receipt.mode
    || sha256Fd(receipt.fd, receipt.size) !== receipt.sha256
  ) throw new Error("risk-reducing runtime file descriptor changed");
}

function canonicalPathStillNamesReceipt(receipt) {
  try {
    const canonical = lstatSync(receipt.path);
    return canonical.isFile()
      && !canonical.isSymbolicLink()
      && canonical.dev === receipt.dev
      && canonical.ino === receipt.ino;
  } catch {
    return false;
  }
}

export function closeRealTestRuntimeContext(context) {
  closeSync(context.selectorFile.fd);
  closeSync(context.environmentFile.fd);
}

export function assertRuntimeParent(options = {}) {
  const parent = fixedPath(options.parentPath, REAL_TEST_RUNTIME_PARENT, options);
  validateDirectoryChain(parent, options);
  const value = lstatSync(parent);
  const uid = options.expectedUid ?? 0;
  const gid = options.expectedGid ?? 0;
  if (
    !value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== uid
    || value.gid !== gid
    || (value.mode & 0o777) !== 0o700
  ) throw new Error("real-test runtime parent boundary is invalid");
  return parent;
}

function readSecureFile(path, mode, options) {
  const before = lstatSync(path);
  const uid = options.expectedUid ?? 0;
  const gid = options.expectedGid ?? 0;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== uid
    || before.gid !== gid
    || (before.mode & 0o777) !== mode
    || before.size < 2
    || before.size > MAX_FILE_BYTES
  ) throw new Error("real-test runtime file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== uid
      || opened.gid !== gid
      || (opened.mode & 0o777) !== mode
    ) throw new Error("real-test runtime file boundary is invalid");
    const bytes = readFileSync(fd);
    const result = {
      path,
      fd,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      uid: opened.uid,
      gid: opened.gid,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
    assertRuntimeFileUnchanged(result);
    return result;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function validateRealTestRuntimeManifest(value) {
  if (
    !hasExactKeys(value, ["images", "revision", "schemaVersion"])
    || value.schemaVersion !== 1
    || !FULL_REVISION.test(value.revision ?? "")
    || !hasExactKeys(value.images, ["api", "strategyTools", "web"])
    || !Object.values(value.images).every((item) => IMAGE_DIGEST.test(item ?? ""))
  ) throw new Error("real-test runtime manifest schema is invalid");
  return deepFreeze({
    schemaVersion: 1,
    revision: value.revision,
    images: { ...value.images },
  });
}

export function validateRealTestRuntimeChecksums(source, receipt, manifestSha256) {
  const values = new Map();
  for (const line of source.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (code\.tar|candidate-build-receipt\.json|release-manifest\.json)$/u
      .exec(line);
    if (!match || values.has(match[2])) {
      throw new Error("real-test runtime checksums schema is invalid");
    }
    values.set(match[2], match[1]);
  }
  if (
    values.size !== 3
    || values.get("code.tar") !== receipt.sourceArchive.sha256
    || values.get("candidate-build-receipt.json") !== receipt.receiptSha256
    || values.get("release-manifest.json") !== manifestSha256
  ) throw new Error("real-test runtime checksums identity mismatch");
}

function validateHostIdentity(value) {
  if (!hasExactKeys(value.binaries, BINARY_KEYS)) {
    throw new Error("real-test runtime binaries schema is invalid");
  }
  for (const item of Object.values(value.binaries)) {
    if (
      !hasExactKeys(item, ["path", "sha256"])
      || typeof item.path !== "string"
      || !item.path.startsWith("/")
      || !SHA256.test(item.sha256 ?? "")
    ) throw new Error("real-test runtime binary identity is invalid");
  }
  if (
    !hasExactKeys(value.daemon, ["id", "rootDir", "serverVersion", "storageDriver"])
    || !/^[A-Za-z0-9:+._-]{8,128}$/u.test(value.daemon.id ?? "")
    || typeof value.daemon.rootDir !== "string"
    || !value.daemon.rootDir.startsWith("/")
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]*)?$/u
      .test(value.daemon.serverVersion ?? "")
    || !/^[A-Za-z0-9._-]{2,64}$/u.test(value.daemon.storageDriver ?? "")
  ) throw new Error("real-test runtime daemon identity is invalid");
}

function fixedPath(value, expected, options) {
  if (value === undefined) return expected;
  if (value === expected) return expected;
  if (
    process.env.NODE_TEST_CONTEXT === undefined
    || options.testOnlyPaths !== true
    || typeof value !== "string"
    || !value.startsWith("/")
  ) throw new Error("real-test runtime path override is not allowed");
  return value;
}

function validateDirectoryChain(start, options) {
  if (options.testOnlyPaths === true) return;
  let current = resolve(start);
  while (true) {
    const value = statSync(current);
    if (!value.isDirectory() || value.uid !== 0 || (value.mode & 0o022) !== 0) {
      throw new Error("real-test runtime parent chain is invalid");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function parseValue(value) {
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new Error("real-test runtime environment quoting is invalid");
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw new Error("real-test runtime environment quoting is invalid");
    }
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\r", "\r");
  }
  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function assertRevision(value) {
  if (!FULL_REVISION.test(value ?? "")) {
    throw new Error("real-test runtime revision must be a full Git commit");
  }
}

function hasExactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function sha256Fd(fd, size) {
  const bytes = Buffer.allocUnsafe(size);
  try {
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count === 0) throw new Error("real-test runtime file was truncated");
      offset += count;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}
