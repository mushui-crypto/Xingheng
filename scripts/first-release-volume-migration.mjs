#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { verifyLegacyBridgeFiles } from "./legacyReleaseBridge.mjs";

const IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROJECT = "xingheng";
const RELEASE_UID = 20001;
const RELEASE_GID = 20001;
const LEGACY_VOLUMES = Object.freeze([
  Object.freeze({ name: "xingheng_sqlite_data", target: "/app/data" }),
  Object.freeze({ name: "xingheng_strategy_data", target: "/app/strategy-data" }),
  Object.freeze({ name: "xingheng_sqlite_backups", target: "/backups" }),
]);
const NEW_VOLUMES = Object.freeze([
  "xingheng_rwa_automation_data",
  "xingheng_rwa_automation_backups",
  "xingheng_rwa_automation_lock",
]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function docker(args, options) {
  return run("docker", args, options);
}

function requireControlledRoot() {
  if (process.env.NODE_ENV !== "test" && process.getuid?.() !== 0) {
    throw new Error("first release volume migration requires the controlled root operator");
  }
}

function assertImage(image) {
  if (!IMAGE_PATTERN.test(image)) throw new Error("release API image identity is invalid");
  const inspected = JSON.parse(docker(["image", "inspect", image]))[0];
  if (inspected?.Id !== image) throw new Error("release API image is unavailable");
}

function assertApiStopped() {
  const ids = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
    "--filter",
    "label=com.docker.compose.service=api",
    "--format",
    "{{.ID}}",
  ]).split(/\s+/u).filter(Boolean);
  if (ids.length !== 0) throw new Error("API must be stopped before volume ownership migration");
}

function createNewVolumes() {
  for (const name of NEW_VOLUMES) {
    docker(["volume", "create", "--driver", "local", name]);
    const inspected = JSON.parse(docker(["volume", "inspect", name]))[0];
    if (
      inspected?.Name !== name
      || inspected?.Driver !== "local"
      || inspected?.Scope !== "local"
      || Object.keys(inspected?.Options ?? {}).length !== 0
    ) {
      throw new Error("release automation volume boundary is invalid");
    }
  }
}

function initializeNewVolumes(image) {
  requireControlledRoot();
  assertImage(image);
  createNewVolumes();
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0:0",
    "--mount",
    "type=volume,source=xingheng_rwa_automation_data,target=/app/rwa-automation-data",
    "--mount",
    "type=volume,source=xingheng_rwa_automation_backups,target=/app/rwa-automation-backups",
    "--mount",
    "type=volume,source=xingheng_rwa_automation_lock,target=/app/rwa-automation-lock",
    "--entrypoint",
    "sh",
    image,
    "-euc",
    `
reject_links() {
  root="$1"
  [ -z "$(find "$root" -xdev -type l -print -quit)" ]
  [ -z "$(find "$root" -xdev -type f -links +1 -print -quit)" ]
}
reject_links /app/rwa-automation-data
reject_links /app/rwa-automation-backups
reject_links /app/rwa-automation-lock

[ -f /app/rwa-automation-data/current.json ]
[ ! -L /app/rwa-automation-data/current.json ]
[ -d /app/rwa-automation-data/generation-initial ]
[ "$(find /app/rwa-automation-data -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ]
[ "$(find /app/rwa-automation-backups -mindepth 1 -maxdepth 1 | wc -l)" -eq 0 ]
[ -f /app/rwa-automation-lock/operation.lock ]
[ ! -L /app/rwa-automation-lock/operation.lock ]
[ "$(find /app/rwa-automation-lock -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]

chown -R 20001:20001 /app/rwa-automation-data /app/rwa-automation-backups
chmod 0700 /app/rwa-automation-data /app/rwa-automation-data/generation-initial \
  /app/rwa-automation-backups
chmod 0600 /app/rwa-automation-data/current.json
chown 20001:20001 /app/rwa-automation-lock/operation.lock
chmod 0600 /app/rwa-automation-lock/operation.lock
chown 0:0 /app/rwa-automation-lock
chmod 0555 /app/rwa-automation-lock
sync
`,
  ]);
  console.log("first release automation volumes initialized");
}

function legacyOwnerMap(bridgeDirectory) {
  const manifest = verifyLegacyBridgeFiles(bridgeDirectory);
  const byName = new Map(manifest.volumes.map((volume) => [volume.name, volume]));
  return LEGACY_VOLUMES.map(({ name, target }) => {
    const volume = byName.get(name);
    if (
      volume?.service !== "api"
      || volume?.target !== target
      || !Number.isSafeInteger(volume.ownerUid)
      || !Number.isSafeInteger(volume.ownerGid)
    ) {
      throw new Error("legacy volume owner evidence is invalid");
    }
    return Object.freeze({
      name,
      oldUid: volume.ownerUid,
      oldGid: volume.ownerGid,
    });
  });
}

function migrationMounts(owners) {
  return owners.flatMap(({ name }, index) => [
    "--mount",
    `type=volume,source=${name},target=/migration/v${index}`,
  ]);
}

function migrateLegacyOwners(bridgeDirectory, image) {
  requireControlledRoot();
  assertImage(image);
  assertApiStopped();
  const owners = legacyOwnerMap(bridgeDirectory);
  const ownerArguments = owners.flatMap(({ oldUid, oldGid }) => [String(oldUid), String(oldGid)]);
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0:0",
    ...migrationMounts(owners),
    "--entrypoint",
    "sh",
    image,
    "-euc",
    `
for root in /migration/v0 /migration/v1 /migration/v2; do
  old_uid="$1"
  old_gid="$2"
  shift 2
  [ -z "$(find "$root" -xdev -type l -print -quit)" ]
  [ -z "$(find "$root" -xdev -type f -links +1 -print -quit)" ]
  [ -z "$(find "$root" -xdev \\( ! -uid "$old_uid" -o ! -gid "$old_gid" \\) -print -quit)" ]
done
chown -R 20001:20001 /migration/v0 /migration/v1 /migration/v2
sync
`,
    "migration",
    ...ownerArguments,
  ]);
  console.log("legacy runtime volume ownership migrated");
}

function restoreLegacyOwners(bridgeDirectory, image) {
  requireControlledRoot();
  assertImage(image);
  assertApiStopped();
  const owners = legacyOwnerMap(bridgeDirectory);
  const ownerArguments = owners.flatMap(({ oldUid, oldGid }) => [String(oldUid), String(oldGid)]);
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0:0",
    ...migrationMounts(owners),
    "--entrypoint",
    "sh",
    image,
    "-euc",
    `
for root in /migration/v0 /migration/v1 /migration/v2; do
  old_uid="$1"
  old_gid="$2"
  shift 2
  [ -z "$(find "$root" -xdev -type l -print -quit)" ]
  [ -z "$(find "$root" -xdev -type f -links +1 -print -quit)" ]
  chown -R "$old_uid:$old_gid" "$root"
done
sync
`,
    "restore",
    ...ownerArguments,
  ]);
  console.log("legacy runtime volume ownership restored");
}

function usage() {
  throw new Error(
    "usage: first-release-volume-migration.mjs initialize RELEASE_API_IMAGE | migrate BRIDGE_DIR RELEASE_API_IMAGE | restore BRIDGE_DIR RELEASE_API_IMAGE",
  );
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "initialize" && args.length === 1) {
    initializeNewVolumes(args[0]);
  } else if (command === "migrate" && args.length === 2) {
    migrateLegacyOwners(args[0], args[1]);
  } else if (command === "restore" && args.length === 2) {
    restoreLegacyOwners(args[0], args[1]);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "first release volume migration failed");
  process.exit(1);
}
