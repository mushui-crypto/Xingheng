#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  LEGACY_BRIDGE_KIND,
  LEGACY_BRIDGE_SCHEMA_VERSION,
  LEGACY_PROJECT_NAME,
  LEGACY_SERVICES,
  LEGACY_VOLUME_TARGETS,
  assertImageId,
  collectLegacyEnvironmentFileEvidence,
  createRecoveryCompose,
  manifestFileName,
  readLegacyBridge,
  sha256File,
  validateResolvedRecoveryCompose,
  verifyLegacyBridgeFiles,
} from "./legacyReleaseBridge.mjs";

const VERIFIED_RELEASE_MARKER = "/var/lib/xingheng/verified-release-established";

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function docker(args, options) {
  return run("docker", args, options);
}

function runningContainer(service) {
  const ids = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${LEGACY_PROJECT_NAME}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    "{{.ID}}",
  ]).split(/\s+/u).filter(Boolean);
  if (ids.length !== 1) throw new Error("legacy runtime component count mismatch");
  const inspected = JSON.parse(docker(["container", "inspect", ids[0]]))[0];
  if (
    inspected?.State?.Running !== true
    || inspected?.Config?.Labels?.["com.docker.compose.project"] !== LEGACY_PROJECT_NAME
    || inspected?.Config?.Labels?.["com.docker.compose.service"] !== service
  ) {
    throw new Error("legacy runtime component boundary mismatch");
  }
  if (service === "api" && inspected?.State?.Health?.Status !== "healthy") {
    throw new Error("legacy API is not healthy");
  }
  return { id: ids[0], inspected };
}

function inspectLegacyRuntime() {
  const services = Object.fromEntries(LEGACY_SERVICES.map((service) => [service, runningContainer(service)]));
  const all = docker([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${LEGACY_PROJECT_NAME}`,
    "--format",
    "{{.ID}}",
  ]).split(/\s+/u).filter(Boolean);
  if (all.length !== LEGACY_SERVICES.length) throw new Error("legacy runtime topology mismatch");
  const volumes = [];
  for (const service of LEGACY_SERVICES) {
    const expected = new Map(Object.entries(LEGACY_VOLUME_TARGETS[service]));
    for (const mount of services[service].inspected.Mounts ?? []) {
      if (mount.Type !== "volume" || expected.get(mount.Destination) !== mount.Name || mount.RW !== true) {
        throw new Error("legacy runtime mount mapping mismatch");
      }
      const [uid, gid, mode] = docker([
        "exec",
        services[service].id,
        "stat",
        "-c",
        "%u %g %a",
        mount.Destination,
      ]).split(/\s+/u);
      volumes.push({
        service,
        name: mount.Name,
        target: mount.Destination,
        ownerUid: Number(uid),
        ownerGid: Number(gid),
        mode,
        preservedInPlace: true,
      });
      expected.delete(mount.Destination);
    }
    if (expected.size !== 0) throw new Error("legacy runtime volume evidence is incomplete");
  }
  return {
    services,
    volumes: volumes.sort((left, right) =>
      `${left.service}:${left.target}`.localeCompare(`${right.service}:${right.target}`)),
  };
}

function artifact(path, mode) {
  chmodSync(path, mode);
  const metadata = statSync(path);
  return {
    file: basename(path),
    mode,
    sha256: sha256File(path),
    sizeBytes: metadata.size,
  };
}

function capture(bundleDirectory, environmentFile) {
  if (
    !bundleDirectory.startsWith("/")
    || !environmentFile.startsWith("/")
    || resolve(bundleDirectory) !== bundleDirectory
    || resolve(environmentFile) !== environmentFile
  ) {
    usage();
  }
  if (lstatExists(bundleDirectory)) throw new Error("legacy bridge output already exists");
  const environmentEvidence = collectLegacyEnvironmentFileEvidence(environmentFile);
  const parent = dirname(bundleDirectory);
  const parentMetadata = lstatSync(parent);
  if (
    !parentMetadata.isDirectory()
    || parentMetadata.isSymbolicLink()
    || parentMetadata.uid !== process.getuid?.()
    || parentMetadata.gid !== process.getgid?.()
    || (parentMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("legacy bridge parent boundary is invalid");
  }
  const temporary = `${bundleDirectory}.partial-${process.pid}`;
  mkdirSync(temporary, { mode: 0o700 });
  let backupName = null;
  try {
    const runtime = inspectLegacyRuntime();
    const images = Object.fromEntries(LEGACY_SERVICES.map((service) => [
      service,
      assertImageId(runtime.services[service].inspected.Image, `legacy ${service} image`),
    ]));
    const apiArchivePath = join(temporary, "legacy-api.image.tar");
    const webArchivePath = join(temporary, "legacy-web.image.tar");
    docker(["image", "save", "--output", apiArchivePath, images.api]);
    docker(["image", "save", "--output", webArchivePath, images.web]);

    const composePath = join(temporary, "legacy-recovery.compose.json");
    writeFileSync(
      composePath,
      `${JSON.stringify(createRecoveryCompose({
        apiImage: images.api,
        webImage: images.web,
        environmentFile: environmentEvidence.path,
      }), null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );

    backupName = `trading-${new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/u, "Z")}.sqlite`;
    const backupPath = `/backups/${backupName}`;
    docker([
      "exec",
      runtime.services.api.id,
      "sqlite3",
      "/app/data/trading.sqlite",
      ".timeout 10000",
      `.backup '${backupPath}'`,
    ]);
    if (docker(["exec", runtime.services.api.id, "sqlite3", backupPath, "PRAGMA integrity_check;"]) !== "ok") {
      throw new Error("legacy SQLite backup integrity failed");
    }
    const sqliteHash = docker(["exec", runtime.services.api.id, "sha256sum", backupPath])
      .split(/\s+/u)[0];
    const sqliteSize = Number(docker(["exec", runtime.services.api.id, "stat", "-c", "%s", backupPath]));

    const manifest = {
      schemaVersion: LEGACY_BRIDGE_SCHEMA_VERSION,
      bridgeKind: LEGACY_BRIDGE_KIND,
      createdAt: new Date().toISOString(),
      projectName: LEGACY_PROJECT_NAME,
      environmentFile: environmentEvidence,
      images,
      archives: {
        api: artifact(apiArchivePath, 0o400),
        web: artifact(webArchivePath, 0o400),
      },
      compose: artifact(composePath, 0o444),
      sqlite: {
        backupName,
        sha256: sqliteHash,
        sizeBytes: sqliteSize,
        integrity: "ok",
        volume: "xingheng_sqlite_backups",
      },
      volumes: runtime.volumes,
    };
    const manifestPath = join(temporary, manifestFileName());
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o444,
    });
    chmodSync(manifestPath, 0o444);
    verifyLegacyBridgeFiles(temporary);
    renameSync(temporary, bundleDirectory);
    console.log("legacy bridge capture verified");
  } catch (error) {
    if (backupName) {
      try {
        const runtime = inspectLegacyRuntime();
        docker(["exec", runtime.services.api.id, "rm", "-f", `/backups/${backupName}`]);
      } catch {
        // Preserve the original controlled failure category.
      }
    }
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function verifyRuntime(bundleDirectory) {
  const manifest = verifyLegacyBridgeFiles(bundleDirectory);
  const runtime = inspectLegacyRuntime();
  for (const service of LEGACY_SERVICES) {
    if (runtime.services[service].inspected.Image !== manifest.images[service]) {
      throw new Error("legacy runtime image identity mismatch");
    }
    const image = JSON.parse(docker(["image", "inspect", manifest.images[service]]))[0];
    if (image?.Id !== manifest.images[service]) throw new Error("legacy recovery image is unavailable");
  }
  if (JSON.stringify(runtime.volumes) !== JSON.stringify(manifest.volumes)) {
    throw new Error("legacy runtime volume evidence mismatch");
  }
  const backupPath = `/backups/${manifest.sqlite.backupName}`;
  if (docker(["exec", runtime.services.api.id, "sqlite3", backupPath, "PRAGMA integrity_check;"]) !== "ok") {
    throw new Error("legacy SQLite recovery point failed");
  }
  const hash = docker(["exec", runtime.services.api.id, "sha256sum", backupPath]).split(/\s+/u)[0];
  if (hash !== manifest.sqlite.sha256) throw new Error("legacy SQLite recovery point mismatch");
  const size = Number(docker(["exec", runtime.services.api.id, "stat", "-c", "%s", backupPath]));
  if (size !== manifest.sqlite.sizeBytes) throw new Error("legacy SQLite recovery point mismatch");
  console.log("legacy runtime and recovery evidence verified");
}

function verifyOfflineSqliteRecoveryPoint(manifest) {
  const backupPath = `/backups/${manifest.sqlite.backupName}`;
  const immutableBackupUri = `file:${backupPath}?immutable=1`;
  const common = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    "type=volume,source=xingheng_sqlite_backups,target=/backups,readonly",
    "--entrypoint",
  ];
  const integrity = docker([
    ...common,
    "sqlite3",
    manifest.images.api,
    immutableBackupUri,
    "PRAGMA integrity_check;",
  ]);
  const hash = docker([
    ...common,
    "sha256sum",
    manifest.images.api,
    backupPath,
  ]).split(/\s+/u)[0];
  const size = Number(docker([
    ...common,
    "stat",
    manifest.images.api,
    "-c",
    "%s",
    backupPath,
  ]));
  if (
    integrity !== "ok"
    || hash !== manifest.sqlite.sha256
    || size !== manifest.sqlite.sizeBytes
  ) {
    throw new Error("legacy SQLite recovery point mismatch");
  }
}

function restore(bundleDirectory) {
  const manifest = verifyLegacyBridgeFiles(bundleDirectory);
  for (const service of LEGACY_SERVICES) {
    let available = false;
    try {
      const image = JSON.parse(docker(["image", "inspect", manifest.images[service]]))[0];
      available = image?.Id === manifest.images[service];
    } catch {
      available = false;
    }
    if (!available) {
      docker(["image", "load", "--input", join(bundleDirectory, manifest.archives[service].file)]);
      const loaded = JSON.parse(docker(["image", "inspect", manifest.images[service]]))[0];
      if (loaded?.Id !== manifest.images[service]) throw new Error("legacy image restore mismatch");
    }
  }
  verifyOfflineSqliteRecoveryPoint(manifest);
  const composeArguments = [
    "compose",
    "-f",
    join(bundleDirectory, manifest.compose.file),
    "-p",
    LEGACY_PROJECT_NAME,
    "--env-file",
    manifest.environmentFile.path,
  ];
  const resolved = JSON.parse(docker([
    ...composeArguments,
    "config",
    "--format",
    "json",
  ]));
  validateResolvedRecoveryCompose(resolved, manifest);
  docker([
    ...composeArguments,
    "up",
    "-d",
    "--force-recreate",
    "--no-build",
    "--pull",
    "never",
    "api",
    "web",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  verifyRuntime(bundleDirectory);
  console.log("legacy runtime restored");
}

function verifyReleaseEnvironment(bundleDirectory, releaseEnvironmentFile) {
  const manifest = verifyLegacyBridgeFiles(bundleDirectory);
  const releaseEnvironment = collectLegacyEnvironmentFileEvidence(releaseEnvironmentFile);
  if (
    releaseEnvironment.path === manifest.environmentFile.path
    || (
      releaseEnvironment.dev === manifest.environmentFile.dev
      && releaseEnvironment.ino === manifest.environmentFile.ino
    )
  ) {
    throw new Error("verified release must use an independent environment file");
  }
  console.log("independent verified release environment boundary confirmed");
}

function markEstablished(path, revision) {
  if (
    !path.startsWith("/")
    || !/^[0-9a-f]{40}$/u.test(revision)
    || (
      process.env.NODE_ENV !== "test"
      && path !== VERIFIED_RELEASE_MARKER
    )
    || lstatExists(path)
  ) {
    throw new Error("verified release marker boundary is invalid");
  }
  const parent = dirname(path);
  const parentMetadata = lstatSync(parent);
  if (
    !parentMetadata.isDirectory()
    || parentMetadata.isSymbolicLink()
    || parentMetadata.uid !== process.getuid?.()
    || parentMetadata.gid !== process.getgid?.()
    || (parentMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("verified release marker parent is invalid");
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o444,
  );
  const created = fstatSync(descriptor);
  let completed = false;
  try {
    if (
      process.env.NODE_ENV === "test"
      && process.env.LEGACY_BRIDGE_TEST_FAIL_MARKER_WRITE === "true"
    ) {
      throw new Error("injected marker write failure");
    }
    writeFileSync(descriptor, `${revision}\n`);
    if (
      process.env.NODE_ENV === "test"
      && process.env.LEGACY_BRIDGE_TEST_FAIL_MARKER_WRITE === "after-write"
    ) {
      throw new Error("injected marker fsync failure");
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o444);
    completed = true;
  } finally {
    closeSync(descriptor);
    if (!completed) {
      try {
        const current = lstatSync(path);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.nlink === 1
          && current.dev === created.dev
          && current.ino === created.ino
        ) {
          unlinkSync(path);
        }
      } catch {
        // Preserve the original controlled marker failure.
      }
    }
  }
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function usage() {
  throw new Error(
    "usage: legacy-release-bridge.mjs capture BUNDLE_DIR ENV_FILE | verify BUNDLE_DIR | verify-runtime BUNDLE_DIR | verify-release-environment BUNDLE_DIR RELEASE_ENV_FILE | restore BUNDLE_DIR | mark-established STATE_FILE REVISION",
  );
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "capture" && args.length === 2) {
    capture(args[0], args[1]);
  } else if (command === "verify" && args.length === 1) {
    verifyLegacyBridgeFiles(args[0]);
    console.log("legacy bridge artifacts verified");
  } else if (command === "verify-runtime" && args.length === 1) {
    verifyRuntime(args[0]);
  } else if (command === "restore" && args.length === 1) {
    restore(args[0]);
  } else if (command === "verify-release-environment" && args.length === 2) {
    verifyReleaseEnvironment(args[0], args[1]);
  } else if (command === "mark-established" && args.length === 2) {
    markEstablished(args[0], args[1]);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "legacy release bridge failed");
  process.exit(1);
}
