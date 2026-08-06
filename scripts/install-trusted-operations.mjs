#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { captureTrustedReleaseTree } from "./trustedReleaseTree.mjs";
import { initializeCapitalTestWindowStateRoot } from "./capitalTestWindowController.mjs";

const RECEIPT = "/etc/xingheng/trusted-operations.json";
const RELEASE_ROOT = "/opt/xingheng-release/code";
const SOCKET = "/var/run/docker.sock";
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
const FORBIDDEN_ENVIRONMENT = /^(?:DOCKER_|COMPOSE_|NODE_OPTIONS$|NODE_PATH$|NODE_ENV$|NODE_TEST_CONTEXT$|XINGHENG_TEST_|LD_|DYLD_|BASH_ENV$|ENV$|XDG_)/u;

try {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("trusted operations installation requires controlled root on Linux");
  }
  const polluted = Object.keys(process.env).find((name) => FORBIDDEN_ENVIRONMENT.test(name));
  if (polluted) throw new Error("trusted operations installation environment is polluted");
  if (process.argv.length !== 3 || process.argv[2] !== "install") {
    throw new Error("usage: install-trusted-operations.mjs install");
  }
  assertSecureDirectoryChain(RELEASE_ROOT);
  const socket = lstatSync(SOCKET);
  if (
    !socket.isSocket()
    || socket.isSymbolicLink()
    || socket.nlink !== 1
    || socket.uid !== 0
    || (socket.mode & 0o777) !== 0o660
  ) {
    throw new Error("trusted Docker socket boundary is invalid");
  }
  const binaries = {};
  for (const [name, path] of Object.entries(BINARIES)) {
    const metadata = lstatSync(path);
    assertSecureDirectoryChain(dirname(path));
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o022) !== 0
      || (metadata.mode & 0o111) === 0
    ) {
      throw new Error(`trusted ${name} binary boundary is invalid`);
    }
    binaries[name] = { path, sha256: sha256File(path) };
  }
  const daemonRaw = execFileSync(
    BINARIES.docker,
    ["info", "--format", "{{json .}}"],
    {
      encoding: "utf8",
      env: {
        HOME: "/root",
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        DOCKER_HOST: `unix://${SOCKET}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    },
  );
  const info = JSON.parse(daemonRaw);
  initializeCapitalTestWindowStateRoot();
  const value = {
    schemaVersion: 1,
    releaseRoot: RELEASE_ROOT,
    releaseTree: captureTrustedReleaseTree(RELEASE_ROOT),
    socket: SOCKET,
    binaries,
    daemon: {
      id: info.ID,
      rootDir: info.DockerRootDir,
      serverVersion: info.ServerVersion,
      storageDriver: info.Driver,
    },
  };
  const directory = dirname(RECEIPT);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const directoryMetadata = lstatSync(directory);
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || directoryMetadata.uid !== 0
    || directoryMetadata.gid !== 0
    || (directoryMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("trusted operations receipt directory is invalid");
  }
  const pending = `${RECEIPT}.pending-${process.pid}`;
  rmSync(pending, { force: true });
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error("trusted operations receipt staging boundary is invalid");
    }
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally {
    closeQuietly(fd);
  }
  renameSync(pending, RECEIPT);
  fsyncDirectory(directory);
  const installed = lstatSync(RECEIPT);
  if (
    !installed.isFile()
    || installed.isSymbolicLink()
    || installed.nlink !== 1
    || installed.uid !== 0
    || installed.gid !== 0
    || (installed.mode & 0o777) !== 0o400
  ) {
    throw new Error("trusted operations receipt installation failed");
  }
  console.log(JSON.stringify({
    ok: true,
    receiptSha256: sha256File(RECEIPT),
    daemonIdSha256: sha256Text(value.daemon.id),
    dockerSha256: value.binaries.docker.sha256,
    composeSha256: value.binaries.compose.sha256,
    releaseTreeSha256: value.releaseTree.sha256,
    releaseTreeFileCount: value.releaseTree.fileCount,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "trusted operations installation failed");
  process.exit(1);
}

function assertSecureDirectoryChain(path) {
  let current = path;
  while (true) {
    const metadata = statSync(current);
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error("trusted operations directory chain is invalid");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeQuietly(fd);
  }
}

function closeQuietly(fd) {
  try {
    closeSync(fd);
  } catch {
    // The error path still rejects the installation.
  }
}
