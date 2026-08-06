import { resolve } from "node:path";

export const RELEASE_VOLUME_BOUNDARIES = Object.freeze({
  xingheng_sqlite_data: Object.freeze({ owner: "runtime", private: false }),
  xingheng_strategy_data: Object.freeze({ owner: "runtime", private: false }),
  xingheng_sqlite_backups: Object.freeze({ owner: "runtime", private: false }),
  xingheng_rwa_automation_data: Object.freeze({ owner: "runtime", private: true }),
  xingheng_rwa_automation_backups: Object.freeze({ owner: "runtime", private: true }),
  xingheng_rwa_automation_lock: Object.freeze({ owner: "root", private: false }),
  xingheng_caddy_data: Object.freeze({ owner: "preserved", private: false }),
  xingheng_caddy_config: Object.freeze({ owner: "preserved", private: false }),
});
const RELEASE_COMPOSE_MOUNTS = Object.freeze({
  api: Object.freeze([
    volumeMount("sqlite_data", "/app/data"),
    volumeMount("strategy_data", "/app/strategy-data"),
    volumeMount("sqlite_backups", "/backups"),
    volumeMount("rwa_automation_data", "/app/rwa-automation-data"),
    volumeMount("rwa_automation_lock", "/app/rwa-automation-lock"),
    bindMount("/run/xingheng/gcp-wif", "/run/secrets/gcp-wif"),
    bindMount(
      "/var/lib/xingheng/capital-test-window",
      "/run/xingheng/capital-test-window",
    ),
  ]),
  web: Object.freeze([
    volumeMount("caddy_data", "/data"),
    volumeMount("caddy_config", "/config"),
  ]),
  "strategy-history": Object.freeze([
    volumeMount("strategy_data", "/app/strategy-data"),
  ]),
  "rwa-automation-backup": Object.freeze([
    volumeMount("rwa_automation_data", "/app/rwa-automation-data", true),
    volumeMount("rwa_automation_backups", "/app/rwa-automation-backups"),
    volumeMount("rwa_automation_lock", "/app/rwa-automation-lock"),
    bindMount("/run/xingheng/gcp-wif", "/run/secrets/gcp-wif"),
  ]),
  "rwa-automation-restore": Object.freeze([
    volumeMount("rwa_automation_data", "/app/rwa-automation-data"),
    volumeMount("rwa_automation_backups", "/app/rwa-automation-backups", true),
    volumeMount("rwa_automation_lock", "/app/rwa-automation-lock"),
    bindMount("/run/xingheng/gcp-wif", "/run/secrets/gcp-wif"),
  ]),
});

const RELEASE_RUNTIME_MOUNTS = Object.freeze({
  api: Object.freeze([
    runtimeVolume("xingheng_sqlite_data", "/app/data"),
    runtimeVolume("xingheng_strategy_data", "/app/strategy-data"),
    runtimeVolume("xingheng_sqlite_backups", "/backups"),
    runtimeVolume("xingheng_rwa_automation_data", "/app/rwa-automation-data"),
    runtimeVolume("xingheng_rwa_automation_lock", "/app/rwa-automation-lock"),
    runtimeBind("/run/xingheng/gcp-wif", "/run/secrets/gcp-wif"),
    runtimeBind(
      "/var/lib/xingheng/capital-test-window",
      "/run/xingheng/capital-test-window",
    ),
  ]),
  web: Object.freeze([
    runtimeVolume("xingheng_caddy_data", "/data"),
    runtimeVolume("xingheng_caddy_config", "/config"),
  ]),
});
const LOCAL_FILESYSTEM_TYPES = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs"]);
const NETWORK_FILESYSTEM = /^(?:nfs|nfs4|cifs|smb3|fuse\.sshfs|9p|ceph|glusterfs)$/u;
const EXPECTED_MOUNT_COUNTS = Object.freeze({
  preflight: Object.freeze({
    xingheng_sqlite_data: 1,
    xingheng_strategy_data: 1,
    xingheng_sqlite_backups: 1,
    xingheng_rwa_automation_data: 0,
    xingheng_rwa_automation_backups: 0,
    xingheng_rwa_automation_lock: 0,
    xingheng_caddy_data: 1,
    xingheng_caddy_config: 1,
  }),
  runtime: Object.freeze({
    xingheng_sqlite_data: 1,
    xingheng_strategy_data: 1,
    xingheng_sqlite_backups: 1,
    xingheng_rwa_automation_data: 1,
    xingheng_rwa_automation_backups: 0,
    xingheng_rwa_automation_lock: 1,
    xingheng_caddy_data: 1,
    xingheng_caddy_config: 1,
  }),
  migration: Object.freeze({
    xingheng_sqlite_data: 0,
    xingheng_strategy_data: 0,
    xingheng_sqlite_backups: 0,
    xingheng_rwa_automation_data: 0,
    xingheng_rwa_automation_backups: 0,
    xingheng_rwa_automation_lock: 0,
    xingheng_caddy_data: 1,
    xingheng_caddy_config: 1,
  }),
});
export function validateReleaseVolumeMetadata(name, metadata, lockFileMetadata) {
  return validateVolumeMetadata(
    RELEASE_VOLUME_BOUNDARIES,
    name,
    metadata,
    lockFileMetadata,
  );
}

function validateVolumeMetadata(boundaries, name, metadata, lockFileMetadata) {
  const contract = boundaries[name];
  if (!contract) throw new Error("release volume is not allowlisted");
  const value = exactObject(metadata, [
    "dockerRoot",
    "dockerFilesystemSource",
    "dockerFilesystemTarget",
    "dockerFilesystemType",
    "driver",
    "filesystemOptions",
    "filesystemSource",
    "filesystemTarget",
    "filesystemType",
    "gid",
    "mode",
    "mountCount",
    "mountpoint",
    "options",
    "scope",
    "symlink",
    "type",
    "uid",
  ], "release volume metadata");
  if (
    value.type !== "directory"
    || value.symlink === true
    || value.driver !== "local"
    || value.scope !== "local"
    || !Number.isSafeInteger(value.mountCount)
    || value.mountCount < 0
    || !isEmptyObject(value.options)
  ) {
    throw new Error("release volume boundary is invalid");
  }
  const expectedMountpoint = resolve(value.dockerRoot, "volumes", name, "_data");
  if (
    !isAbsolutePath(value.dockerRoot)
    || !isAbsolutePath(value.mountpoint)
    || resolve(value.mountpoint) !== expectedMountpoint
    || !isAbsolutePath(value.filesystemTarget)
    || !isPathInside(value.mountpoint, value.filesystemTarget)
    || value.filesystemTarget === value.mountpoint
    || typeof value.filesystemSource !== "string"
    || value.filesystemSource.length < 1
    || typeof value.filesystemType !== "string"
    || NETWORK_FILESYSTEM.test(value.filesystemType)
    || !LOCAL_FILESYSTEM_TYPES.has(value.filesystemType)
    || /^(?:\/\/|[^/]+:\/)/u.test(value.filesystemSource)
    || typeof value.filesystemOptions !== "string"
    || !value.filesystemOptions.split(",").includes("rw")
    || value.filesystemOptions.split(",").includes("bind")
    || value.filesystemTarget !== value.dockerFilesystemTarget
    || value.filesystemSource !== value.dockerFilesystemSource
    || value.filesystemType !== value.dockerFilesystemType
  ) {
    throw new Error("release volume storage backend is invalid");
  }

  const mode = value.mode & 0o777;
  if ((mode & 0o022) !== 0) throw new Error("release volume permissions are too broad");
  if (
    contract.owner === "runtime"
    && (value.uid !== 20001 || value.gid !== 20001)
  ) {
    throw new Error("release volume runtime ownership is invalid");
  }
  if (contract.owner === "root" && (value.uid !== 0 || value.gid !== 0 || mode !== 0o555)) {
    throw new Error("release lock volume ownership is invalid");
  }
  if (contract.private && mode !== 0o700) {
    throw new Error("release private volume mode is invalid");
  }
  if (name.endsWith("_rwa_automation_lock")) {
    const lock = exactObject(lockFileMetadata, [
      "gid",
      "mode",
      "nlink",
      "symlink",
      "type",
      "uid",
    ], "release operation lock metadata");
    if (
      lock.type !== "file"
      || lock.symlink === true
      || lock.nlink !== 1
      || lock.uid !== 20001
      || lock.gid !== 20001
      || (lock.mode & 0o777) !== 0o600
    ) {
      throw new Error("release operation lock boundary is invalid");
    }
  } else if (lockFileMetadata !== null && lockFileMetadata !== undefined) {
    throw new Error("release volume lock metadata is unexpected");
  }
  return true;
}

export function validateReleaseComposeMounts(config) {
  const root = record(config, "release Compose");
  const services = exactObject(
    root.services,
    Object.keys(RELEASE_COMPOSE_MOUNTS),
    "release Compose services",
  );
  for (const [service, expected] of Object.entries(RELEASE_COMPOSE_MOUNTS)) {
    const entry = record(services[service], `release Compose ${service}`);
    if (!Array.isArray(entry.volumes) || entry.volumes.length !== expected.length) {
      throw new Error("release Compose mount mapping is invalid");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = entry.volumes[index];
      const keys = expected[index].type === "bind"
        ? ["bind", "read_only", "source", "target", "type"]
        : expected[index].read_only
          ? ["read_only", "source", "target", "type", "volume"]
          : ["source", "target", "type", "volume"];
      const mount = exactObject(actual, keys, "release Compose mount");
      if (canonicalJson(mount) !== canonicalJson(expected[index])) {
        throw new Error("release Compose mount mapping is invalid");
      }
    }
  }
  return true;
}

export function validateReleaseRuntimeMounts(value) {
  return validateRuntimeMounts(RELEASE_RUNTIME_MOUNTS, value);
}

function validateRuntimeMounts(expectedByService, value) {
  const byService = exactObject(value, Object.keys(expectedByService), "release runtime services");
  for (const [service, expected] of Object.entries(expectedByService)) {
    if (!Array.isArray(byService[service]) || byService[service].length !== expected.length) {
      throw new Error("release runtime mount mapping is invalid");
    }
    const actualMounts = [...byService[service]].sort(compareRuntimeMounts);
    const expectedMounts = [...expected].sort(compareRuntimeMounts);
    for (let index = 0; index < expectedMounts.length; index += 1) {
      const mount = exactObject(
        actualMounts[index],
        ["destination", "name", "rw", "source", "type"],
        "release runtime mount",
      );
      if (canonicalJson(mount) !== canonicalJson(expectedMounts[index])) {
        throw new Error("release runtime mount mapping is invalid");
      }
    }
  }
  return true;
}

function compareRuntimeMounts(left, right) {
  return String(left?.destination ?? "").localeCompare(String(right?.destination ?? ""));
}

export function validateReleaseVolumeMountCounts(mode, value) {
  return validateVolumeMountCounts(EXPECTED_MOUNT_COUNTS, mode, value);
}

function validateVolumeMountCounts(expectedByMode, mode, value) {
  const expected = expectedByMode[mode];
  if (!expected) throw new Error("release volume verification mode is invalid");
  const counts = exactObject(value, Object.keys(expected), "release volume mount counts");
  for (const [name, count] of Object.entries(expected)) {
    if (!Number.isSafeInteger(counts[name]) || counts[name] !== count) {
      throw new Error("release volume mount count is invalid");
    }
  }
  return true;
}

function volumeMount(source, target, readOnly = false) {
  return Object.freeze({
    type: "volume",
    source,
    target,
    ...(readOnly ? { read_only: true } : {}),
    volume: {},
  });
}

function bindMount(source, target) {
  return Object.freeze({
    type: "bind",
    source,
    target,
    read_only: true,
    bind: { create_host_path: false },
  });
}

function runtimeVolume(name, destination) {
  return Object.freeze({
    type: "volume",
    name,
    source: "",
    destination,
    rw: true,
  });
}

function runtimeBind(source, destination) {
  return Object.freeze({
    type: "bind",
    name: "",
    source,
    destination,
    rw: false,
  });
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && resolve(value) === value;
}

function isPathInside(path, parent) {
  return path === parent || path.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function isEmptyObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObject(value, keys, label) {
  const entry = record(value, label);
  const actual = Object.keys(entry).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} schema is invalid`);
  }
  return { ...entry };
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
