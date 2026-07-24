#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_VOLUME_BOUNDARIES,
  validateReleaseComposeMounts,
  validateReleaseRuntimeMounts,
  validateReleaseVolumeMetadata,
  validateReleaseVolumeMountCounts,
} from "./releaseVolumeBoundaries.mjs";

const mode = process.argv[2] ?? "preflight";
if (!["preflight", "migration", "runtime"].includes(mode)) {
  console.error("usage: verify-release-volume-boundaries.mjs preflight|migration|runtime");
  process.exit(2);
}

function run(command, args) {
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
      container?.Config?.Labels?.["com.docker.compose.project"] === "xingheng"
      && container?.Config?.Labels?.["com.docker.compose.service"] === service
      && container?.State?.Running === true);
    if (matching.length !== 1) throw new Error("release runtime component count mismatch");
    byService[service] = (matching[0].Mounts ?? []).map(normalizeRuntimeMount);
  }
  return byService;
}

function volumeMountCounts(containers) {
  const counts = Object.fromEntries(Object.keys(RELEASE_VOLUME_BOUNDARIES).map((name) => [name, 0]));
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
  const environmentFile = process.env.COMPOSE_ENV_FILE;
  if (typeof environmentFile !== "string" || !environmentFile.startsWith("/")) {
    throw new Error("release Compose environment path is unavailable");
  }
  return JSON.parse(run("scripts/production-compose.sh", [
    "--env-file",
    environmentFile,
    "--profile",
    "strategy-tools",
    "--profile",
    "rwa-automation-ops",
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
  validateReleaseComposeMounts(compose);
  const containers = inspectRunningContainers();
  const mountCounts = volumeMountCounts(containers);
  validateReleaseVolumeMountCounts(mode, mountCounts);
  const dockerRoot = JSON.parse(docker(["info", "--format", "{{json .DockerRootDir}}"]));
  if (typeof dockerRoot !== "string" || !dockerRoot.startsWith("/")) {
    throw new Error("Docker root boundary is invalid");
  }
  const dockerRootMetadata = lstatSync(dockerRoot);
  if (!dockerRootMetadata.isDirectory() || dockerRootMetadata.isSymbolicLink()) {
    throw new Error("Docker root boundary is invalid");
  }
  const dockerFilesystem = filesystemEvidence(dockerRoot);

  for (const name of Object.keys(RELEASE_VOLUME_BOUNDARIES)) {
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
    if (name === "xingheng_rwa_automation_lock") {
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
    validateReleaseVolumeMetadata(name, root, lock);
  }

  if (mode === "runtime") {
    validateReleaseRuntimeMounts(releaseRuntimeMounts(containers));
  }
  console.log(`release volume boundaries verified (${mode})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "release volume verification failed");
  process.exit(1);
}
