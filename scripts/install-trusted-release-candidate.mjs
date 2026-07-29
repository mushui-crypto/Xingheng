#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  captureTrustedCandidateTree,
  readTrustedReleaseCandidateReceipt,
  releaseCandidatePaths,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";
import {
  normalizeInstalledRealTestCompose,
} from "./realTestComposeInstallBoundary.mjs";

const BINARIES = Object.freeze({
  node: "/usr/bin/node",
  sh: "/usr/bin/dash",
  flock: "/usr/bin/flock",
  findmnt: "/usr/bin/findmnt",
  git: "/usr/bin/git",
  tar: "/usr/bin/tar",
  sha256sum: "/usr/bin/sha256sum",
  docker: "/usr/bin/docker",
  compose: "/usr/libexec/docker/cli-plugins/docker-compose",
});
const SOCKET = "/var/run/docker.sock";
const FORBIDDEN_ENVIRONMENT = /^(?:DOCKER_|COMPOSE_|NODE_OPTIONS$|NODE_PATH$|NODE_ENV$|NODE_TEST_CONTEXT$|XINGHENG_|LD_|DYLD_|BASH_ENV$|ENV$|XDG_)/u;
const SHA256 = /^[a-f0-9]{64}$/u;

try {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("trusted release candidate installation requires controlled root on Linux");
  }
  const polluted = Object.keys(process.env).find((name) => FORBIDDEN_ENVIRONMENT.test(name));
  if (polluted) throw new Error("trusted release candidate installation environment is polluted");
  process.umask(0o077);
  if (
    process.argv.length !== 6
    || process.argv[2] !== "install"
    || !["production", "real-test"].includes(process.argv[3])
    || !/^[a-f0-9]{40}$/u.test(process.argv[4])
    || !SHA256.test(process.argv[5])
  ) {
    throw new Error(
      "usage: install-trusted-release-candidate.mjs install production|real-test FULL_REVISION ARCHIVE_SHA256",
    );
  }
  const deploymentEnvironment = process.argv[3];
  const revision = process.argv[4];
  const expectedArchiveSha256 = process.argv[5];
  const paths = releaseCandidatePaths(revision, deploymentEnvironment);
  ensureSecureDirectory(paths.candidatesRoot, 0o700);
  if (exists(paths.candidateRoot)) {
    throw new Error("trusted release candidate already exists");
  }
  const incoming = secureArtifactReceipt(paths.incomingArchive, 0o400);
  if (incoming.sha256 !== expectedArchiveSha256) {
    throw new Error("trusted release candidate archive digest mismatch");
  }
  const commit = spawnVerifiedArchive(
    BINARIES.git,
    ["get-tar-commit-id"],
    paths.incomingArchive,
    incoming,
    1024 * 1024,
  );
  if (
    commit.status !== 0
    || commit.signal
    || commit.error
    || commit.stdout.trim() !== revision
  ) {
    throw new Error("trusted release candidate archive revision mismatch");
  }
  const listing = spawnVerifiedArchive(
    BINARIES.tar,
    ["-tf", "-"],
    paths.incomingArchive,
    incoming,
    16 * 1024 * 1024,
  );
  if (listing.status !== 0 || listing.signal || listing.error) {
    throw new Error("trusted release candidate archive listing failed");
  }
  const members = listing.stdout.split("\n").filter(Boolean);
  if (
    members.length < 20
    || members.some((name) =>
      name.startsWith("/")
      || name.includes("\0")
      || name.split("/").some((part) => part === ".."))
  ) {
    throw new Error("trusted release candidate archive paths are invalid");
  }

  const stagingRoot = mkdtempSync(join(paths.candidatesRoot, `.staging-${revision}-`));
  let published = false;
  let installed = false;
  try {
    chmodSync(stagingRoot, 0o700);
    const stagingCode = join(stagingRoot, "code");
    mkdirSync(stagingCode, { mode: 0o700 });
    chmodSync(stagingCode, 0o700);
    const stagingArchive = join(stagingRoot, "code.tar");
    renameSync(paths.incomingArchive, stagingArchive);
    chmodSync(stagingArchive, 0o400);
    const extraction = spawnVerifiedArchive(BINARIES.tar, [
      "--extract",
      "--file",
      "-",
      "--directory",
      stagingCode,
      "--no-same-owner",
      "--no-same-permissions",
    ], stagingArchive, incoming, 16 * 1024 * 1024);
    if (extraction.status !== 0 || extraction.signal || extraction.error) {
      throw new Error("trusted release candidate archive extraction failed");
    }
    chmodSync(stagingCode, 0o700);
    normalizeInstalledRealTestCompose(deploymentEnvironment, stagingCode);
    assertSecureExtractedTree(stagingCode);
    const candidateTree = captureTrustedCandidateTree(stagingCode);
    const sourceArchive = secureArtifactReceipt(stagingArchive, 0o400);
    if (sourceArchive.sha256 !== expectedArchiveSha256) {
      throw new Error("trusted release candidate archive changed during installation");
    }
    const binaries = captureBinaries();
    const daemon = captureDaemon(binaries.docker.path);
    const receipt = {
      schemaVersion: 1,
      revision,
      candidateRoot: paths.candidateRoot,
      codeRoot: paths.codeRoot,
      sourceArchive,
      candidateTree,
      socket: SOCKET,
      binaries,
      daemon,
    };
    writeImmutableJson(join(stagingRoot, "candidate-build-receipt.json"), receipt, 0o400);
    fsyncDirectory(stagingCode);
    fsyncDirectory(stagingRoot);
    renameSync(stagingRoot, paths.candidateRoot);
    published = true;
    fsyncDirectory(paths.candidatesRoot);
    const verified = readTrustedReleaseCandidateReceipt(revision, deploymentEnvironment);
    installed = true;
    console.log(JSON.stringify({
      ok: true,
      revision,
      candidateRoot: paths.candidateRoot,
      sourceArchiveSha256: verified.sourceArchive.sha256,
      candidateTreeSha256: verified.candidateTree.sha256,
      receiptSha256: verified.receiptSha256,
      daemonIdSha256: sha256Text(verified.daemon.id),
      dockerSha256: verified.binaries.docker.sha256,
    }));
  } finally {
    if (!installed) {
      rmSync(published ? paths.candidateRoot : stagingRoot, {
        recursive: true,
        force: true,
      });
      fsyncDirectory(paths.candidatesRoot);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "trusted release candidate installation failed");
  process.exit(1);
}

function ensureSecureDirectory(path, mode) {
  let created = false;
  try {
    mkdirSync(path, { recursive: false, mode });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o777) !== mode
  ) {
    throw new Error("trusted release candidate directory boundary is invalid");
  }
  if (created) chmodSync(path, mode);
  assertSecureParentChain(dirname(path));
  fsyncDirectory(path);
}

function assertSecureParentChain(path) {
  let current = path;
  while (true) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("trusted release candidate parent directory boundary is invalid");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function spawnVerifiedArchive(binary, args, path, expected, maxBuffer) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.size !== expected.size
      || opened.uid !== expected.uid
      || opened.gid !== expected.gid
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== expected.mode
      || sha256Descriptor(fd, opened.size) !== expected.sha256
    ) {
      throw new Error("trusted release candidate archive object identity mismatch");
    }
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      env: fixedEnvironment(),
      stdio: [fd, "pipe", "pipe"],
      maxBuffer,
    });
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || sha256Descriptor(fd, after.size) !== expected.sha256
    ) {
      throw new Error("trusted release candidate archive changed while being consumed");
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

function assertSecureExtractedTree(root) {
  const result = spawnSync(BINARIES.tar, [
    "-cf",
    "/dev/null",
    "--no-recursion",
    "-C",
    root,
    ".",
  ], {
    encoding: "utf8",
    env: fixedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error("trusted release candidate extracted tree is invalid");
  }
}

function captureBinaries() {
  const result = {};
  for (const [name, path] of Object.entries(BINARIES)) {
    assertSecureParentChain(dirname(path));
    const metadata = lstatSync(path);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o022) !== 0
      || (metadata.mode & 0o111) === 0
    ) {
      throw new Error(`trusted candidate ${name} binary boundary is invalid`);
    }
    result[name] = { path, sha256: sha256File(path) };
  }
  return result;
}

function captureDaemon(dockerPath) {
  const socket = lstatSync(SOCKET);
  if (
    !socket.isSocket()
    || socket.isSymbolicLink()
    || socket.nlink !== 1
    || socket.uid !== 0
    || (socket.mode & 0o777) !== 0o660
  ) {
    throw new Error("trusted candidate Docker socket boundary is invalid");
  }
  const output = spawnSync(dockerPath, ["info", "--format", "{{json .}}"], {
    encoding: "utf8",
    env: { ...fixedEnvironment(), DOCKER_HOST: `unix://${SOCKET}` },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (output.status !== 0 || output.signal || output.error) {
    throw new Error("trusted candidate Docker daemon identity is unavailable");
  }
  const info = JSON.parse(output.stdout);
  return {
    id: info.ID,
    rootDir: info.DockerRootDir,
    serverVersion: info.ServerVersion,
    storageDriver: info.Driver,
  };
}

function writeImmutableJson(path, value, mode) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fixedEnvironment() {
  return {
    HOME: "/root",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256Descriptor(fd, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  try {
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) throw new Error("trusted release candidate archive was truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
