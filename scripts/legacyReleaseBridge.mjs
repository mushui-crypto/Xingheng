import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export const LEGACY_BRIDGE_SCHEMA_VERSION = 1;
export const LEGACY_BRIDGE_KIND = "xingheng-legacy-release-bridge";
export const LEGACY_PROJECT_NAME = "xingheng";
export const LEGACY_SERVICES = Object.freeze(["api", "web"]);
export const LEGACY_VOLUME_TARGETS = Object.freeze({
  api: Object.freeze({
    "/app/data": "xingheng_sqlite_data",
    "/app/strategy-data": "xingheng_strategy_data",
    "/backups": "xingheng_sqlite_backups",
  }),
  web: Object.freeze({
    "/data": "xingheng_caddy_data",
    "/config": "xingheng_caddy_config",
  }),
});

const BRIDGE_MANIFEST = "legacy-bridge-manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_COMPOSE_BYTES = 128 * 1024;
const MAX_IMAGE_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const BACKUP_PATTERN = /^trading-\d{8}T\d{6}Z\.sqlite$/u;
const FILE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const FORBIDDEN_TEXT = /(?:mnemonic|secret|password|private[_-]?key|api[_-]?key|token|wif|adc\.json|certificate)/iu;

export function validateLegacyBridgeManifest(value) {
  const manifest = exactObject(value, [
    "archives",
    "bridgeKind",
    "compose",
    "createdAt",
    "environmentFile",
    "images",
    "projectName",
    "schemaVersion",
    "sqlite",
    "volumes",
  ], "legacy bridge manifest");
  if (
    manifest.schemaVersion !== LEGACY_BRIDGE_SCHEMA_VERSION
    || manifest.bridgeKind !== LEGACY_BRIDGE_KIND
    || manifest.projectName !== LEGACY_PROJECT_NAME
    || !isIsoTimestamp(manifest.createdAt)
  ) {
    throw new Error("legacy bridge manifest identity is invalid");
  }
  const environmentFile = validateEnvironmentEvidence(manifest.environmentFile);

  const images = exactObject(manifest.images, LEGACY_SERVICES, "legacy images");
  for (const service of LEGACY_SERVICES) assertImageId(images[service], `legacy ${service} image`);

  const archives = exactObject(manifest.archives, LEGACY_SERVICES, "legacy archives");
  archives.api = validateArtifact(
    archives.api,
    "legacy api archive",
    0o400,
    "legacy-api.image.tar",
    MAX_IMAGE_ARCHIVE_BYTES,
  );
  archives.web = validateArtifact(
    archives.web,
    "legacy web archive",
    0o400,
    "legacy-web.image.tar",
    MAX_IMAGE_ARCHIVE_BYTES,
  );
  const compose = validateArtifact(
    manifest.compose,
    "legacy recovery Compose",
    0o444,
    "legacy-recovery.compose.json",
    MAX_COMPOSE_BYTES,
  );
  const sqlite = exactObject(manifest.sqlite, [
    "backupName",
    "integrity",
    "sha256",
    "sizeBytes",
    "volume",
  ], "legacy SQLite recovery point");
  if (
    typeof sqlite.backupName !== "string"
    || !BACKUP_PATTERN.test(sqlite.backupName)
    || sqlite.integrity !== "ok"
    || sqlite.volume !== "xingheng_sqlite_backups"
    || !HASH_PATTERN.test(sqlite.sha256)
    || !safePositiveInteger(sqlite.sizeBytes)
  ) {
    throw new Error("legacy SQLite recovery point is invalid");
  }

  if (!Array.isArray(manifest.volumes) || manifest.volumes.length !== 5) {
    throw new Error("legacy volume evidence is invalid");
  }
  const expectedVolumes = new Map(
    Object.entries(LEGACY_VOLUME_TARGETS).flatMap(([service, targets]) =>
      Object.entries(targets).map(([target, name]) => [`${service}:${target}`, name])),
  );
  const volumes = manifest.volumes.map((entry) => {
    const volume = exactObject(entry, [
      "mode",
      "name",
      "ownerGid",
      "ownerUid",
      "preservedInPlace",
      "service",
      "target",
    ], "legacy volume entry");
    const key = `${volume.service}:${volume.target}`;
    if (
      expectedVolumes.get(key) !== volume.name
      || volume.preservedInPlace !== true
      || !Number.isSafeInteger(volume.ownerUid)
      || volume.ownerUid < 0
      || !Number.isSafeInteger(volume.ownerGid)
      || volume.ownerGid < 0
      || typeof volume.mode !== "string"
      || !/^[0-7]{3,4}$/u.test(volume.mode)
    ) {
      throw new Error("legacy volume entry is invalid");
    }
    expectedVolumes.delete(key);
    return volume;
  });
  if (expectedVolumes.size !== 0) throw new Error("legacy volume evidence is incomplete");

  const normalized = {
    schemaVersion: LEGACY_BRIDGE_SCHEMA_VERSION,
    bridgeKind: LEGACY_BRIDGE_KIND,
    createdAt: manifest.createdAt,
    projectName: LEGACY_PROJECT_NAME,
    environmentFile,
    images,
    archives,
    compose,
    sqlite,
    volumes,
  };
  assertNoSensitiveText(normalized);
  return normalized;
}

export function readLegacyBridge(bundleDirectory) {
  const root = lstatSync(bundleDirectory);
  if (
    !root.isDirectory()
    || root.isSymbolicLink()
    || root.uid !== process.getuid?.()
    || root.gid !== process.getgid?.()
    || (root.mode & 0o777) !== 0o700
  ) {
    throw new Error("legacy bridge directory boundary is invalid");
  }
  const manifest = readStrictJson(join(bundleDirectory, BRIDGE_MANIFEST), 0o444, MAX_MANIFEST_BYTES);
  return validateLegacyBridgeManifest(manifest);
}

export function verifyLegacyBridgeFiles(bundleDirectory) {
  const manifest = readLegacyBridge(bundleDirectory);
  const expectedFiles = [
    manifestFileName(),
    manifest.archives.api.file,
    manifest.archives.web.file,
    manifest.compose.file,
  ].sort();
  const actualFiles = readdirSync(bundleDirectory).sort();
  if (
    actualFiles.length !== expectedFiles.length
    || actualFiles.some((name, index) => name !== expectedFiles[index])
  ) {
    throw new Error("legacy bridge directory contains unknown or missing files");
  }
  for (const artifact of [
    manifest.archives.api,
    manifest.archives.web,
    manifest.compose,
  ]) {
    const path = join(bundleDirectory, artifact.file);
    const metadata = strictFile(path, artifact.mode, artifact.sizeBytes);
    if (metadata.size !== artifact.sizeBytes || sha256File(path) !== artifact.sha256) {
      throw new Error("legacy bridge artifact integrity mismatch");
    }
  }
  verifyLegacyEnvironmentFile(manifest.environmentFile);
  const recovery = JSON.parse(readFileSync(join(bundleDirectory, manifest.compose.file), "utf8"));
  validateRecoveryCompose(recovery, manifest);
  return manifest;
}

export function validateRecoveryCompose(value, manifestValue) {
  const manifest = validateLegacyBridgeManifest(manifestValue);
  const compose = object(value, "legacy recovery Compose");
  const expected = createRecoveryCompose({
    apiImage: manifest.images.api,
    webImage: manifest.images.web,
    environmentFile: manifest.environmentFile.path,
  });
  if (JSON.stringify(compose) !== JSON.stringify(expected)) {
    throw new Error("legacy recovery Compose schema is invalid");
  }
  assertNoSensitiveText(compose);
  return compose;
}

export function validateResolvedRecoveryCompose(value, manifestValue) {
  const manifest = validateLegacyBridgeManifest(manifestValue);
  const compose = exactObject(value, ["name", "networks", "services", "volumes"], "resolved legacy Compose");
  if (compose.name !== LEGACY_PROJECT_NAME) throw new Error("resolved legacy Compose project is invalid");
  const services = exactObject(compose.services, LEGACY_SERVICES, "resolved legacy services");
  validateResolvedApi(services.api, manifest.images.api);
  validateResolvedWeb(services.web, manifest.images.web);
  const volumes = exactObject(compose.volumes, [
    "caddy_config",
    "caddy_data",
    "sqlite_backups",
    "sqlite_data",
    "strategy_data",
  ], "resolved legacy volumes");
  for (const [shortName, entry] of Object.entries(volumes)) {
    const normalized = exactObject(entry, ["external", "name"], "resolved legacy volume");
    if (normalized.external !== true || normalized.name !== `xingheng_${shortName}`) {
      throw new Error("resolved legacy volume mapping is invalid");
    }
  }
  const networks = exactObject(compose.networks, ["default"], "resolved legacy networks");
  const defaultNetwork = exactObject(
    networks.default,
    ["external", "ipam", "name"],
    "resolved legacy default network",
  );
  if (
    defaultNetwork.external !== true
    || defaultNetwork.name !== "xingheng_default"
    || JSON.stringify(defaultNetwork.ipam) !== "{}"
  ) {
    throw new Error("resolved legacy network mapping is invalid");
  }
  return compose;
}

export function createRecoveryCompose({ apiImage, webImage, environmentFile }) {
  assertImageId(apiImage, "legacy api image");
  assertImageId(webImage, "legacy web image");
  if (typeof environmentFile !== "string" || !environmentFile.startsWith("/")) {
    throw new Error("legacy environment path is invalid");
  }
  return {
    name: LEGACY_PROJECT_NAME,
    services: {
      api: {
        image: apiImage,
        pull_policy: "never",
        env_file: [environmentFile],
        environment: {
          NODE_ENV: "production",
          API_PORT: "8787",
          TRADING_DB_PATH: "/app/data/trading.sqlite",
          STRATEGY_FORWARD_REPORT_PATH: "/app/strategy-data/route-b-forward.json",
          STRATEGY_HISTORY_REPORT_PATH: "/app/strategy-data/route-b-history.json",
          STRATEGY_FORWARD_WORKER_POLL_MS: "300000",
          MARTINGALE_GRID_PAPER_REPORT_PATH: "/app/strategy-data/martingale-grid-paper.json",
          MARTINGALE_GRID_PAPER_WORKER_POLL_MS: "300000",
          FIXED_GRID_PAPER_REPORT_PATH: "/app/strategy-data/fixed-grid-paper.json",
          FIXED_GRID_ARCHIVE_CACHE_PATH: "/app/strategy-data/fixed-grid-archive-cache",
          FIXED_GRID_PAPER_WORKER_POLL_MS: "300000",
          TRUST_PROXY: "true",
          BSC_TESTNET_CHAIN_ID: "97",
        },
        init: true,
        restart: "unless-stopped",
        stop_grace_period: "20s",
        volumes: [
          "sqlite_data:/app/data",
          "strategy_data:/app/strategy-data",
          "sqlite_backups:/backups",
        ],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))",
          ],
          interval: "15s",
          timeout: "5s",
          start_period: "30s",
          retries: 5,
        },
      },
      web: {
        image: webImage,
        pull_policy: "never",
        environment: { DOMAIN: "${DOMAIN:?DOMAIN is required}" },
        entrypoint: ["/bin/sh", "-c"],
        command: [
          "test -n \"$DOMAIN\" || { echo \"DOMAIN is required\" >&2; exit 1; }; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
        ],
        depends_on: { api: { condition: "service_healthy" } },
        restart: "unless-stopped",
        ports: ["80:80", "443:443", "443:443/udp"],
        volumes: ["caddy_data:/data", "caddy_config:/config"],
      },
    },
    volumes: Object.fromEntries(
      ["sqlite_data", "strategy_data", "sqlite_backups", "caddy_data", "caddy_config"]
        .map((name) => [name, { external: true, name: `xingheng_${name}` }]),
    ),
    networks: { default: { external: true, name: "xingheng_default" } },
  };
}

export function collectLegacyEnvironmentFileEvidence(path) {
  if (
    typeof path !== "string"
    || !path.startsWith("/")
    || resolve(path) !== path
  ) {
    throw new Error("legacy production environment path is invalid");
  }
  const metadata = lstatSync(path, { bigint: true });
  assertEnvironmentMetadata(metadata);
  if (
    process.env.NODE_ENV !== "test"
    && (metadata.uid !== 0n || metadata.gid !== 0n)
  ) {
    throw new Error("legacy production environment owner is invalid");
  }
  const evidence = {
    path,
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    uid: Number(metadata.uid),
    gid: Number(metadata.gid),
    mode: Number(metadata.mode & 0o777n),
    nlink: Number(metadata.nlink),
    sizeBytes: Number(metadata.size),
    sha256: hashStrictEnvironmentFile(path, metadata),
  };
  return validateEnvironmentEvidence(evidence);
}

export function verifyLegacyEnvironmentFile(value) {
  const evidence = validateEnvironmentEvidence(value);
  const metadata = lstatSync(evidence.path, { bigint: true });
  assertEnvironmentMetadata(metadata);
  if (
    metadata.dev.toString() !== evidence.dev
    || metadata.ino.toString() !== evidence.ino
    || Number(metadata.uid) !== evidence.uid
    || Number(metadata.gid) !== evidence.gid
    || Number(metadata.mode & 0o777n) !== evidence.mode
    || Number(metadata.nlink) !== evidence.nlink
    || Number(metadata.size) !== evidence.sizeBytes
    || hashStrictEnvironmentFile(evidence.path, metadata) !== evidence.sha256
  ) {
    throw new Error("legacy production environment identity changed");
  }
  return evidence;
}

export function sha256File(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    chunk.fill(0);
    closeSync(fd);
  }
}

function validateEnvironmentEvidence(value) {
  const evidence = exactObject(value, [
    "dev",
    "gid",
    "ino",
    "mode",
    "nlink",
    "path",
    "sha256",
    "sizeBytes",
    "uid",
  ], "legacy environment evidence");
  if (
    typeof evidence.path !== "string"
    || !evidence.path.startsWith("/")
    || resolve(evidence.path) !== evidence.path
    || !/^[1-9][0-9]*$/u.test(evidence.dev)
    || !/^[1-9][0-9]*$/u.test(evidence.ino)
    || !Number.isSafeInteger(evidence.uid)
    || evidence.uid < 0
    || !Number.isSafeInteger(evidence.gid)
    || evidence.gid < 0
    || ![0o400, 0o600].includes(evidence.mode)
    || evidence.nlink !== 1
    || !safePositiveInteger(evidence.sizeBytes)
    || evidence.sizeBytes > MAX_ENVIRONMENT_BYTES
    || !HASH_PATTERN.test(evidence.sha256)
  ) {
    throw new Error("legacy environment evidence is invalid");
  }
  return evidence;
}

function assertEnvironmentMetadata(metadata) {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || ![0o400n, 0o600n].includes(metadata.mode & 0o777n)
    || metadata.size < 1n
    || metadata.size > BigInt(MAX_ENVIRONMENT_BYTES)
  ) {
    throw new Error("legacy production environment boundary is invalid");
  }
}

function hashStrictEnvironmentFile(path, expected) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.size !== expected.size
      || opened.nlink !== expected.nlink
      || opened.uid !== expected.uid
      || opened.gid !== expected.gid
      || (opened.mode & 0o777n) !== (expected.mode & 0o777n)
    ) {
      throw new Error("legacy production environment identity changed");
    }
    let bytesRead;
    do {
      bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    chunk.fill(0);
    closeSync(fd);
  }
}

function validateResolvedApi(value, image) {
  const api = exactObject(value, [
    "command",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "init",
    "networks",
    "pull_policy",
    "restart",
    "stop_grace_period",
    "volumes",
  ], "resolved legacy API");
  if (
    api.command !== null
    || api.entrypoint !== null
    || api.image !== image
    || api.init !== true
    || api.pull_policy !== "never"
    || api.restart !== "unless-stopped"
    || api.stop_grace_period !== "20s"
    || JSON.stringify(api.networks) !== JSON.stringify({ default: null })
  ) {
    throw new Error("resolved legacy API boundary is invalid");
  }
  const requiredEnvironment = {
    NODE_ENV: "production",
    API_PORT: "8787",
    TRADING_DB_PATH: "/app/data/trading.sqlite",
    STRATEGY_FORWARD_REPORT_PATH: "/app/strategy-data/route-b-forward.json",
    STRATEGY_HISTORY_REPORT_PATH: "/app/strategy-data/route-b-history.json",
    STRATEGY_FORWARD_WORKER_POLL_MS: "300000",
    MARTINGALE_GRID_PAPER_REPORT_PATH: "/app/strategy-data/martingale-grid-paper.json",
    MARTINGALE_GRID_PAPER_WORKER_POLL_MS: "300000",
    FIXED_GRID_PAPER_REPORT_PATH: "/app/strategy-data/fixed-grid-paper.json",
    FIXED_GRID_ARCHIVE_CACHE_PATH: "/app/strategy-data/fixed-grid-archive-cache",
    FIXED_GRID_PAPER_WORKER_POLL_MS: "300000",
    TRUST_PROXY: "true",
    BSC_TESTNET_CHAIN_ID: "97",
  };
  const environment = object(api.environment, "resolved legacy API environment");
  for (const [key, expected] of Object.entries(requiredEnvironment)) {
    if (environment[key] !== expected) {
      throw new Error("resolved legacy API environment is invalid");
    }
  }
  if (JSON.stringify(api.healthcheck) !== JSON.stringify({
    test: [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))",
    ],
    timeout: "5s",
    interval: "15s",
    retries: 5,
    start_period: "30s",
  })) {
    throw new Error("resolved legacy API healthcheck is invalid");
  }
  validateResolvedMounts(api.volumes, [
    ["sqlite_data", "/app/data"],
    ["strategy_data", "/app/strategy-data"],
    ["sqlite_backups", "/backups"],
  ]);
}

function validateResolvedWeb(value, image) {
  const web = exactObject(value, [
    "command",
    "depends_on",
    "entrypoint",
    "environment",
    "image",
    "networks",
    "ports",
    "pull_policy",
    "restart",
    "volumes",
  ], "resolved legacy Web");
  const environment = exactObject(web.environment, ["DOMAIN"], "resolved legacy Web environment");
  if (
    typeof environment.DOMAIN !== "string"
    || environment.DOMAIN.length < 1
    || web.image !== image
    || web.pull_policy !== "never"
    || web.restart !== "unless-stopped"
    || JSON.stringify(web.entrypoint) !== JSON.stringify(["/bin/sh", "-c"])
    || JSON.stringify(web.networks) !== JSON.stringify({ default: null })
    || JSON.stringify(web.depends_on) !== JSON.stringify({
      api: { condition: "service_healthy", required: true },
    })
    || JSON.stringify(web.command) !== JSON.stringify([
      `test -n "${environment.DOMAIN}" || { echo "DOMAIN is required" >&2; exit 1; }; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`,
    ])
    || JSON.stringify(web.ports) !== JSON.stringify([
      { mode: "ingress", target: 80, published: "80", protocol: "tcp" },
      { mode: "ingress", target: 443, published: "443", protocol: "tcp" },
      { mode: "ingress", target: 443, published: "443", protocol: "udp" },
    ])
  ) {
    throw new Error("resolved legacy Web boundary is invalid");
  }
  validateResolvedMounts(web.volumes, [
    ["caddy_data", "/data"],
    ["caddy_config", "/config"],
  ]);
}

function validateResolvedMounts(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("resolved legacy mount mapping is invalid");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const mount = exactObject(value[index], ["source", "target", "type", "volume"], "resolved legacy mount");
    if (
      mount.type !== "volume"
      || mount.source !== expected[index][0]
      || mount.target !== expected[index][1]
      || JSON.stringify(mount.volume) !== "{}"
    ) {
      throw new Error("resolved legacy mount mapping is invalid");
    }
  }
}

export function assertImageId(value, label = "image") {
  if (typeof value !== "string" || !IMAGE_PATTERN.test(value)) {
    throw new Error(`${label} must be an immutable image ID`);
  }
  return value;
}

export function manifestFileName() {
  return BRIDGE_MANIFEST;
}

function validateArtifact(value, label, mode, fileName, maxBytes) {
  const artifact = exactObject(value, ["file", "mode", "sha256", "sizeBytes"], label);
  if (
    artifact.file !== fileName
    || !FILE_PATTERN.test(artifact.file)
    || basename(artifact.file) !== artifact.file
    || artifact.mode !== mode
    || !HASH_PATTERN.test(artifact.sha256)
    || !safePositiveInteger(artifact.sizeBytes)
    || artifact.sizeBytes > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  return artifact;
}

function readStrictJson(path, mode, maxBytes) {
  const metadata = strictFile(path, mode);
  if (metadata.size < 2 || metadata.size > maxBytes) {
    throw new Error("legacy bridge manifest boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
      throw new Error("legacy bridge manifest boundary is invalid");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function strictFile(path, mode, expectedSize) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== process.getuid?.()
    || metadata.gid !== process.getgid?.()
    || (metadata.mode & 0o777) !== mode
    || (expectedSize !== undefined && metadata.size !== expectedSize)
  ) {
    throw new Error("legacy bridge artifact boundary is invalid");
  }
  return metadata;
}

function exactObject(value, keys, label) {
  const entry = object(value, label);
  const actual = Object.keys(entry).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} schema is invalid`);
  }
  return { ...entry };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function assertNoSensitiveText(value) {
  const serialized = JSON.stringify(value);
  if (FORBIDDEN_TEXT.test(serialized)) {
    throw new Error("legacy bridge evidence contains a forbidden sensitive field");
  }
}
