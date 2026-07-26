#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  RELEASE_VOLUME_BOUNDARIES,
  REAL_TEST_VOLUME_BOUNDARIES,
  validateReleaseComposeMounts,
  validateReleaseRuntimeMounts,
  validateReleaseVolumeMetadata,
  validateReleaseVolumeMountCounts,
  validateRealTestRuntimeMounts,
  validateRealTestVolumeMetadata,
  validateRealTestVolumeMountCounts,
} from "./releaseVolumeBoundaries.mjs";
import { execTrustedDockerSync } from "./trustedDockerRuntime.mjs";

const first = process.argv[2] ?? "preflight";
const environment = first === "real-test" ? "real-test" : "production";
const mode = environment === "real-test" ? process.argv[3] ?? "" : first;
if (
  !["preflight", "migration", "runtime"].includes(mode)
  || (environment === "real-test" && mode === "migration")
) {
  console.error("usage: verify-release-volume-boundaries.mjs preflight|migration|runtime | real-test preflight|runtime");
  process.exit(2);
}
const boundaries = environment === "production"
  ? RELEASE_VOLUME_BOUNDARIES
  : REAL_TEST_VOLUME_BOUNDARIES;
const project = environment === "production" ? "xingheng" : "xingheng-real-test";

function run(command, args) {
  if (command === "docker") {
    return execTrustedDockerSync(args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function docker(args) {
  return run("docker", args);
}

function inspectRunningContainers() {
  const ids = docker(["ps", "--format", "{{.ID}}"]).split(/\s+/u).filter(Boolean);
  if (ids.length === 0) return [];
  const inspected = JSON.parse(docker(["container", "inspect", ...ids]));
  return Array.isArray(inspected) ? inspected : [];
}

function normalizeRuntimeMount(mount) {
  return {
    type: mount.Type,
    name: mount.Type === "volume" ? mount.Name ?? "" : "",
    source: mount.Type === "bind" ? mount.Source ?? "" : "",
    destination: mount.Destination,
    rw: mount.RW,
  };
}

function releaseRuntimeMounts(containers) {
  const byService = {};
  for (const service of ["api", "web"]) {
    const matching = containers.filter((container) =>
      container?.Config?.Labels?.["com.docker.compose.project"] === project
      && container?.Config?.Labels?.["com.docker.compose.service"] === service
      && container?.State?.Running === true);
    if (matching.length !== 1) throw new Error("release runtime component count mismatch");
    byService[service] = (matching[0].Mounts ?? []).map(normalizeRuntimeMount);
  }
  return byService;
}

function volumeMountCounts(containers) {
  const counts = Object.fromEntries(Object.keys(boundaries).map((name) => [name, 0]));
  for (const container of containers) {
    for (const mount of container.Mounts ?? []) {
      if (mount.Type === "volume" && Object.hasOwn(counts, mount.Name)) {
        counts[mount.Name] += 1;
      }
    }
  }
  return counts;
}

function resolvedCompose() {
  const wrapper = environment === "production"
    ? "scripts/production-compose.sh"
    : "scripts/real-test-compose.sh";
  return JSON.parse(run(wrapper, [
    "--profile",
    "strategy-tools",
    "--profile",
    "rwa-automation-ops",
    ...(environment === "real-test" ? ["--profile", "real-test-cleanup"] : []),
    "config",
    "--format",
    "json",
  ]));
}

function filesystemEvidence(mountpoint) {
  const result = JSON.parse(run("findmnt", [
    "--json",
    "--target",
    mountpoint,
    "--output",
    "TARGET,SOURCE,FSTYPE,OPTIONS",
  ]));
  if (!Array.isArray(result.filesystems) || result.filesystems.length !== 1) {
    throw new Error("release volume filesystem evidence is invalid");
  }
  const filesystem = result.filesystems[0];
  return {
    filesystemTarget: filesystem.target,
    filesystemSource: filesystem.source,
    filesystemType: filesystem.fstype,
    filesystemOptions: filesystem.options,
  };
}

try {
  const compose = resolvedCompose();
  if (environment === "production") validateReleaseComposeMounts(compose);
  const containers = inspectRunningContainers();
  const mountCounts = volumeMountCounts(containers);
  if (environment === "production") {
    validateReleaseVolumeMountCounts(mode, mountCounts);
  } else {
    validateRealTestVolumeMountCounts(mode, mountCounts);
  }
  const dockerRoot = JSON.parse(docker(["info", "--format", "{{json .DockerRootDir}}"]));
  if (typeof dockerRoot !== "string" || !dockerRoot.startsWith("/")) {
    throw new Error("Docker root boundary is invalid");
  }
  const dockerRootMetadata = lstatSync(dockerRoot);
  if (!dockerRootMetadata.isDirectory() || dockerRootMetadata.isSymbolicLink()) {
    throw new Error("Docker root boundary is invalid");
  }
  const dockerFilesystem = filesystemEvidence(dockerRoot);

  for (const name of Object.keys(boundaries)) {
    const inspected = JSON.parse(docker(["volume", "inspect", name]))[0];
    if (
      inspected?.Name !== name
      || typeof inspected?.Mountpoint !== "string"
      || !inspected.Mountpoint.startsWith("/")
    ) {
      throw new Error("release volume is unavailable");
    }
    const metadata = lstatSync(inspected.Mountpoint);
    const root = {
      type: metadata.isDirectory() ? "directory" : "other",
      symlink: metadata.isSymbolicLink(),
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      driver: inspected.Driver,
      scope: inspected.Scope,
      options: inspected.Options ?? {},
      mountpoint: inspected.Mountpoint,
      dockerRoot,
      dockerFilesystemTarget: dockerFilesystem.filesystemTarget,
      dockerFilesystemSource: dockerFilesystem.filesystemSource,
      dockerFilesystemType: dockerFilesystem.filesystemType,
      mountCount: mountCounts[name],
      ...filesystemEvidence(inspected.Mountpoint),
    };
    let lock = null;
    if (name.endsWith("_rwa_automation_lock")) {
      const entry = lstatSync(join(inspected.Mountpoint, "operation.lock"));
      lock = {
        type: entry.isFile() ? "file" : "other",
        symlink: entry.isSymbolicLink(),
        nlink: entry.nlink,
        uid: entry.uid,
        gid: entry.gid,
        mode: entry.mode,
      };
    }
    if (environment === "production") {
      validateReleaseVolumeMetadata(name, root, lock);
    } else {
      validateRealTestVolumeMetadata(name, root, lock);
      verifyRealTestVolumeIdentity(name, inspected.Mountpoint);
    }
  }

  if (mode === "runtime") {
    if (environment === "production") {
      validateReleaseRuntimeMounts(releaseRuntimeMounts(containers));
    } else {
      validateRealTestRuntimeMounts(releaseRuntimeMounts(containers));
    }
  }
  console.log(`release volume boundaries verified (${environment}:${mode})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "release volume verification failed");
  process.exit(1);
}

function verifyRealTestVolumeIdentity(name, mountpoint) {
  const match = /^xingheng-real-test_(sqlite_data|strategy_data|rwa_automation_data)$/u.exec(name);
  if (!match) return;
  const path = join(mountpoint, ".xingheng-volume-identity.json");
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== 0
    || before.gid !== 0
    || (before.mode & 0o777) !== 0o400
    || before.size < 40
    || before.size > 256
  ) {
    throw new Error("real-test volume identity boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || opened.uid !== 0
      || opened.gid !== 0
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o400
    ) {
      throw new Error("real-test volume identity changed while opening");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("real-test volume identity changed while reading");
    }
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "environment,schemaVersion,volume"
      || value.environment !== "real-test"
      || value.schemaVersion !== 1
      || value.volume !== match[1]
    ) {
      throw new Error("real-test volume identity is invalid");
    }
  } finally {
    closeSync(fd);
  }
}
