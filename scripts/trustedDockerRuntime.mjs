import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertTrustedReleaseTree,
  validateTrustedReleaseTreeReceipt,
} from "./trustedReleaseTree.mjs";
import {
  assertTrustedReleaseCandidateRoot,
  readTrustedReleaseCandidateReceipt,
} from "./trustedReleaseCandidate.mjs";
import {
  closeRealTestRuntimeContext,
  readRealTestRuntimeContext,
} from "./realTestRuntimeReceipt.mjs";

const PRODUCTION_DOCKER_CLI = "/usr/bin/docker";
const PRODUCTION_COMPOSE_PLUGIN = "/usr/libexec/docker/cli-plugins/docker-compose";
const PRODUCTION_DOCKER_SOCKET = "/var/run/docker.sock";
const PRODUCTION_TRUST_RECEIPT = "/etc/xingheng/trusted-operations.json";
const PRODUCTION_RELEASE_ROOT = "/opt/xingheng-release/code";
const MAX_CLIENT_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SAFE_CHILD_KEYS = Object.freeze([
  "XINGHENG_REVISION",
  "XINGHENG_API_IMAGE",
  "XINGHENG_WEB_IMAGE",
  "XINGHENG_STRATEGY_TOOLS_IMAGE",
  "XINGHENG_COMPOSE_ENV_FD",
  "XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT",
]);
const REQUIRED_TOOLS = Object.freeze({
  node: "/usr/bin/node",
  sh: "/usr/bin/dash",
  flock: "/usr/bin/flock",
  findmnt: "/usr/bin/findmnt",
  git: "/usr/bin/git",
  tar: "/usr/bin/tar",
  sha256sum: "/usr/bin/sha256sum",
  docker: PRODUCTION_DOCKER_CLI,
  compose: PRODUCTION_COMPOSE_PLUGIN,
});

export function assertNoDockerControlEnvironment(source = process.env) {
  const key = Object.keys(source).find((name) =>
    name.startsWith("DOCKER_") || name.startsWith("COMPOSE_"));
  if (key !== undefined) {
    throw new Error("Docker and Compose control environment is not allowed");
  }
}

export function trustedReleaseRoot(source = process.env) {
  const fixture = testFixture(source);
  if (fixture !== null) {
    const value = source.XINGHENG_TEST_RELEASE_ROOT;
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error("trusted test release root is invalid");
    }
    return realpathSync(value);
  }
  return activeTrustReceipt(source).releaseRoot;
}

export function assertTrustedReleaseRoot(currentRoot, source = process.env) {
  if (process.getuid?.() !== 0) return realpathSync(currentRoot);
  if ([
    "release-build",
    "real-test-runtime",
    "real-test-runtime-install",
  ].includes(source.XINGHENG_OPERATION_LOCK_CONTEXT)) {
    return assertTrustedReleaseCandidateRoot(
      currentRoot,
      source.XINGHENG_RELEASE_CANDIDATE_REVISION,
      source.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT,
    ).root;
  }
  const expected = trustedReleaseRoot(source);
  const actual = realpathSync(currentRoot);
  if (actual !== expected) throw new Error("operational release root identity mismatch");
  validateDirectoryChain(actual, false);
  if (testFixture(source) === null) {
    assertTrustedReleaseTree(actual, readProductionTrustReceipt().releaseTree);
  }
  return actual;
}

export function openTrustedDockerRuntime(kind, source = process.env) {
  if (!["docker", "compose"].includes(kind)) {
    throw new Error("trusted Docker runtime kind is invalid");
  }
  assertNoDockerControlEnvironment(source);
  const fixture = testFixture(source);
  const trustReceipt = fixture === null ? activeTrustReceipt(source) : null;
  if (fixture === null && process.getuid?.() !== 0) {
    throw new Error("trusted Docker runtime requires the controlled root operator");
  }
  const executablePath = fixture === null
    ? (kind === "docker" ? PRODUCTION_DOCKER_CLI : PRODUCTION_COMPOSE_PLUGIN)
    : (kind === "docker" ? fixture.dockerCliPath : fixture.composePluginPath);
  const expectedSha256 = fixture === null
    ? trustReceipt.binaries[kind].sha256
    : (kind === "docker" ? fixture.dockerCliSha256 : fixture.composePluginSha256);
  const executable = openTrustedExecutable(executablePath, expectedSha256, fixture !== null);
  try {
    const socketPath = fixture?.dockerSocketPath ?? PRODUCTION_DOCKER_SOCKET;
    const socket = validateDockerSocket(socketPath, fixture !== null);
    const runtime = {
      ...executable,
      socketPath,
      socket,
      expectedDaemon: trustReceipt?.daemon ?? null,
      environment: trustedDockerEnvironment(source, socketPath, fixture !== null),
      close() {
        closeSync(executable.fd);
      },
    };
    runtime.daemon = fixture === null
      ? inspectDaemonIdentity(trustReceipt, runtime.environment)
      : null;
    return runtime;
  } catch (error) {
    closeSync(executable.fd);
    throw error;
  }
}

export function openTrustedHostTool(name, source = process.env) {
  assertNoDockerControlEnvironment(source);
  if (!Object.hasOwn(REQUIRED_TOOLS, name) || ["docker", "compose"].includes(name)) {
    throw new Error("trusted host tool name is invalid");
  }
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0 || testFixture(source) !== null) {
    throw new Error("trusted host tool requires the controlled root operator");
  }
  const receipt = activeTrustReceipt(source);
  const opened = openTrustedExecutable(
    receipt.binaries[name].path,
    receipt.binaries[name].sha256,
    false,
  );
  return {
    ...opened,
    name,
    close() {
      closeSync(opened.fd);
    },
  };
}

export function verifyTrustedHostTool(tool) {
  const current = fstatSync(tool.fd);
  if (
    current.dev !== tool.dev
    || current.ino !== tool.ino
    || current.size !== tool.size
    || current.uid !== tool.uid
    || current.gid !== tool.gid
    || current.mtimeMs !== tool.mtimeMs
    || (current.mode & 0o777) !== tool.mode
    || sha256Descriptor(tool.fd, tool.size) !== tool.sha256
  ) {
    throw new Error("trusted host tool changed while in use");
  }
}

export function verifyTrustedDockerRuntime(runtime) {
  const current = fstatSync(runtime.fd);
  if (
    current.dev !== runtime.dev
    || current.ino !== runtime.ino
    || current.size !== runtime.size
    || current.uid !== runtime.uid
    || current.gid !== runtime.gid
    || current.mtimeMs !== runtime.mtimeMs
    || (current.mode & 0o777) !== runtime.mode
    || sha256Descriptor(runtime.fd, runtime.size) !== runtime.sha256
  ) {
    throw new Error("trusted Docker executable changed while in use");
  }
  const socket = validateDockerSocket(runtime.socketPath, runtime.testFixture);
  if (
    socket.dev !== runtime.socket.dev
    || socket.ino !== runtime.socket.ino
    || socket.uid !== runtime.socket.uid
    || socket.gid !== runtime.socket.gid
    || socket.mode !== runtime.socket.mode
  ) {
    throw new Error("trusted local Docker socket identity changed while in use");
  }
  if (runtime.expectedDaemon !== null) {
    const receipt = activeTrustReceipt(process.env);
    const current = inspectDaemonIdentity(receipt, runtime.environment);
    if (canonicalJson(current) !== canonicalJson(runtime.daemon)) {
      throw new Error("trusted local Docker daemon identity changed while in use");
    }
  }
}

export function trustedDockerReceipt(runtime, kind, phase) {
  if (!["docker", "compose"].includes(kind) || !["validated", "consumed"].includes(phase)) {
    throw new Error("trusted Docker receipt input is invalid");
  }
  return `trusted-docker-receipt phase=${phase} kind=${kind}`
    + ` executableDev=${runtime.dev} executableIno=${runtime.ino}`
    + ` executableSize=${runtime.size} executableSha256=${runtime.sha256}`
    + ` socketDev=${runtime.socket.dev} socketIno=${runtime.socket.ino}`
    + ` socketUid=${runtime.socket.uid} socketGid=${runtime.socket.gid}`
    + ` socketMode=${runtime.socket.mode.toString(8)}`
    + (runtime.daemon
      ? ` daemonId=${runtime.daemon.id} daemonRootSha256=${sha256Text(runtime.daemon.rootDir)}`
        + ` daemonVersion=${runtime.daemon.serverVersion}`
        + ` daemonDriver=${runtime.daemon.storageDriver}`
      : "");
}

export function execTrustedDockerSync(args, options = {}) {
  if (process.env.XINGHENG_OPERATION_LOCK_CONTEXT === "release-build") {
    validateTrustedReleaseBuildDockerArguments(args);
  } else if ([
    "real-test-runtime",
    "real-test-runtime-install",
  ].includes(process.env.XINGHENG_OPERATION_LOCK_CONTEXT)) {
    validateRealTestRuntimeDockerArguments(args);
  }
  const runtime = openTrustedDockerRuntime("docker", process.env);
  try {
    process.stderr.write(`${trustedDockerReceipt(runtime, "docker", "validated")}\n`);
    const baseStdio = options.stdio ?? ["inherit", "inherit", "inherit"];
    if (!Array.isArray(baseStdio) || baseStdio.length !== 3) {
      throw new Error("trusted Docker stdio boundary is invalid");
    }
    const output = execFileSync(trustedExecutableInvocation(runtime, 3), args, {
      ...options,
      env: runtime.environment,
      stdio: [...baseStdio, runtime.fd],
    });
    verifyTrustedDockerRuntime(runtime);
    process.stderr.write(`${trustedDockerReceipt(runtime, "docker", "consumed")}\n`);
    return output;
  } finally {
    runtime.close();
  }
}

export function validateRealTestRuntimeDockerArguments(values) {
  if (
    values.length === 5
    && values[0] === "image"
    && values[1] === "inspect"
    && values[2] === "--format"
    && values[3] === "{{json .}}"
    && /^sha256:[a-f0-9]{64}$/u.test(values[4] ?? "")
  ) return;
  if (
    values.length === 5
    && values[0] === "ps"
    && values[1] === "--filter"
    && values[2] === "label=com.docker.compose.project=xingheng-real-test"
    && values[3] === "--format"
    && values[4] === "{{.ID}} {{.Label \"com.docker.compose.service\"}}"
  ) return;
  if (
    values.length === 3
    && values[0] === "container"
    && values[1] === "inspect"
    && /^[a-f0-9]{12,64}$/u.test(values[2] ?? "")
  ) return;
  if (
    values.length === 4
    && values[0] === "exec"
    && /^[a-f0-9]{12,64}$/u.test(values[1] ?? "")
    && values[2] === "cat"
    && values[3] === "/app/.build-revision"
  ) return;
  throw new Error("real-test runtime Docker arguments are not allowlisted");
}

export function validateTrustedReleaseBuildDockerArguments(values, source = process.env) {
  const expectedRevision = source.XINGHENG_OPERATION_LOCK_CONTEXT === "release-build"
    ? source.XINGHENG_RELEASE_CANDIDATE_REVISION
    : null;
  if (expectedRevision !== null && !/^[a-f0-9]{40}$/u.test(expectedRevision ?? "")) {
    throw new Error("trusted Docker release-build candidate revision is invalid");
  }
  if (
    expectedRevision !== null
    && !["production", "real-test"].includes(
      source.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT,
    )
  ) {
    throw new Error("trusted Docker release-build deployment environment is invalid");
  }
  const buildRevision = /^XINGHENG_REVISION=([a-f0-9]{40})$/u.exec(values[2] ?? "")?.[1];
  const tag = /^xingheng-(api|web|strategy-tools):([a-f0-9]{40})$/u
    .exec(values[8] ?? "");
  if (
    values[0] === "build"
    && values.length === 10
    && values[1] === "--build-arg"
    && buildRevision !== undefined
    && values[3] === "--target"
    && ["api", "web", "strategy-tools"].includes(values[4])
    && values[5] === "--platform"
    && values[6] === "linux/amd64"
    && values[7] === "--tag"
    && tag?.[1] === values[4]
    && tag?.[2] === buildRevision
    && (expectedRevision === null || buildRevision === expectedRevision)
    && /^\/tmp\/xingheng-release\.[A-Za-z0-9]{6}$/u.test(values[9] ?? "")
    && resolve(values[9]) === values[9]
  ) return;
  if (
    values.length === 5
    && values[0] === "image"
    && values[1] === "inspect"
    && values[2] === "--format"
    && ["{{.Id}}", "{{.Os}}/{{.Architecture}}", "{{json .}}"].includes(values[3])
  ) {
    const imageTag = /^xingheng-(?:api|web|strategy-tools):([a-f0-9]{40})$/u
      .exec(values[4] ?? "");
    const digest = /^sha256:[a-f0-9]{64}$/u.test(values[4] ?? "");
    if (
      (
        imageTag !== null
        && values[3] !== "{{json .}}"
        && (expectedRevision === null || imageTag[1] === expectedRevision)
      )
      || (digest && values[3] === "{{json .}}")
    ) return;
  }
  throw new Error("trusted Docker release-build arguments are not allowlisted");
}

export function executableDescriptorPath(fdNumber) {
  if (!Number.isSafeInteger(fdNumber) || fdNumber < 3 || fdNumber > 9) {
    throw new Error("trusted Docker executable descriptor is invalid");
  }
  return `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fdNumber}`;
}

export function trustedExecutableInvocation(runtime, fdNumber) {
  if (process.platform === "linux") return executableDescriptorPath(fdNumber);
  if (runtime.testFixture === true) return runtime.executablePath;
  throw new Error("trusted Docker descriptor execution requires Linux");
}

function openTrustedExecutable(path, expectedSha256, testMode) {
  const resolved = realpathSync(path);
  if (!testMode && resolved !== path) {
    throw new Error("trusted Docker executable path must not be a symlink");
  }
  validateDirectoryChain(dirname(resolved), testMode);
  const before = lstatSync(resolved);
  const expectedUid = testMode ? (process.getuid?.() ?? -1) : 0;
  const expectedGid = testMode ? (process.getgid?.() ?? -1) : 0;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || before.gid !== expectedGid
    || before.size < 1
    || before.size > MAX_CLIENT_BYTES
    || (before.mode & 0o022) !== 0
    || (before.mode & 0o111) === 0
  ) {
    throw new Error("trusted Docker executable boundary is invalid");
  }
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== before.uid
      || opened.gid !== before.gid
      || opened.mtimeMs !== before.mtimeMs
      || (opened.mode & 0o777) !== (before.mode & 0o777)
    ) {
      throw new Error("trusted Docker executable boundary is invalid");
    }
    const sha256 = sha256Descriptor(fd, opened.size);
    if (expectedSha256 !== null && sha256 !== expectedSha256) {
      throw new Error("trusted Docker test executable digest mismatch");
    }
    return {
      executablePath: resolved,
      fd,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      uid: opened.uid,
      gid: opened.gid,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      sha256,
      testFixture: testMode,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function validateDirectoryChain(start, testMode) {
  const expectedUid = testMode ? (process.getuid?.() ?? -1) : 0;
  let current = start;
  while (true) {
    const metadata = statSync(current);
    if (
      !metadata.isDirectory()
      || (metadata.uid !== 0 && metadata.uid !== expectedUid)
      || (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("trusted Docker executable directory boundary is invalid");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validateDockerSocket(path, testMode) {
  const metadata = lstatSync(path);
  const expectedUid = testMode ? (process.getuid?.() ?? -1) : 0;
  if (
    !metadata.isSocket()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== expectedUid
    || (metadata.mode & 0o777) !== 0o660
  ) {
    throw new Error("trusted local Docker socket boundary is invalid");
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
  };
}

function trustedDockerEnvironment(source, socketPath, testMode) {
  const environment = {
    HOME: testMode ? "/tmp/xingheng-test-home" : "/root",
    PATH: testMode
      ? `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`
      : "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    DOCKER_HOST: `unix://${socketPath}`,
  };
  for (const key of SAFE_CHILD_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  if (testMode) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("FAKE_") && value !== undefined) environment[key] = value;
    }
  }
  return environment;
}

function testFixture(source) {
  const names = [
    "XINGHENG_TEST_DOCKER_CLI_PATH",
    "XINGHENG_TEST_DOCKER_CLI_SHA256",
    "XINGHENG_TEST_COMPOSE_PLUGIN_PATH",
    "XINGHENG_TEST_COMPOSE_PLUGIN_SHA256",
    "XINGHENG_TEST_DOCKER_SOCKET_PATH",
  ];
  const present = names.filter((name) => source[name] !== undefined);
  if (present.length === 0) return null;
  if (
    process.getuid?.() === 0
    ||
    source.NODE_ENV !== "test"
    || source.NODE_TEST_CONTEXT !== "child-v8"
    || present.length !== names.length
  ) {
    throw new Error("trusted Docker test fixture is not allowed");
  }
  const fixture = {
    dockerCliPath: source.XINGHENG_TEST_DOCKER_CLI_PATH,
    dockerCliSha256: source.XINGHENG_TEST_DOCKER_CLI_SHA256,
    composePluginPath: source.XINGHENG_TEST_COMPOSE_PLUGIN_PATH,
    composePluginSha256: source.XINGHENG_TEST_COMPOSE_PLUGIN_SHA256,
    dockerSocketPath: source.XINGHENG_TEST_DOCKER_SOCKET_PATH,
  };
  if (
    !fixture.dockerCliPath.startsWith("/")
    || !fixture.composePluginPath.startsWith("/")
    || !fixture.dockerSocketPath.startsWith("/")
    || !/^[a-f0-9]{64}$/u.test(fixture.dockerCliSha256)
    || !/^[a-f0-9]{64}$/u.test(fixture.composePluginSha256)
  ) {
    throw new Error("trusted Docker test fixture is invalid");
  }
  return fixture;
}

function readProductionTrustReceipt() {
  validateDirectoryChain(dirname(PRODUCTION_TRUST_RECEIPT), false);
  const before = lstatSync(PRODUCTION_TRUST_RECEIPT);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== 0
    || before.gid !== 0
    || (before.mode & 0o777) !== 0o400
    || before.size < 2
    || before.size > MAX_RECEIPT_BYTES
  ) {
    throw new Error("trusted operations receipt boundary is invalid");
  }
  const fd = openSync(PRODUCTION_TRUST_RECEIPT, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== 0
      || opened.gid !== 0
      || (opened.mode & 0o777) !== 0o400
    ) {
      throw new Error("trusted operations receipt boundary is invalid");
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
      throw new Error("trusted operations receipt changed while being read");
    }
    return validateTrustReceipt(JSON.parse(bytes.toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

function activeTrustReceipt(source) {
  if (source.XINGHENG_OPERATION_LOCK_CONTEXT === "real-test-runtime") {
    const controlRoot = new URL("../", import.meta.url).pathname;
    const context = readRealTestRuntimeContext(controlRoot);
    try {
      validateCommonTrustReceipt(
        readTrustedReleaseCandidateReceipt(
          context.selector.revision,
          "real-test",
        ),
      );
      return {
        ...context.selector,
        releaseRoot: context.selector.codeRoot,
      };
    } finally {
      closeRealTestRuntimeContext(context);
    }
  }
  if ([
    "release-build",
    "real-test-runtime-install",
  ].includes(source.XINGHENG_OPERATION_LOCK_CONTEXT)) {
    const receipt = readTrustedReleaseCandidateReceipt(
      source.XINGHENG_RELEASE_CANDIDATE_REVISION,
      source.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT,
    );
    validateCommonTrustReceipt(receipt);
    return {
      ...receipt,
      releaseRoot: receipt.codeRoot,
    };
  }
  return readProductionTrustReceipt();
}

function validateTrustReceipt(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "binaries,daemon,releaseRoot,releaseTree,schemaVersion,socket"
    || value.schemaVersion !== 1
    || value.socket !== PRODUCTION_DOCKER_SOCKET
    || value.releaseRoot !== PRODUCTION_RELEASE_ROOT
  ) {
    throw new Error("trusted operations receipt schema is invalid");
  }
  validateTrustedReleaseTreeReceipt(value.releaseTree);
  assertTrustedReleaseTree(value.releaseRoot, value.releaseTree);
  return validateCommonTrustReceipt(value);
}

function validateCommonTrustReceipt(value) {
  const binaryKeys = Object.keys(REQUIRED_TOOLS).sort();
  if (
    !value.binaries
    || typeof value.binaries !== "object"
    || Array.isArray(value.binaries)
    || Object.keys(value.binaries).sort().join(",") !== binaryKeys.join(",")
  ) {
    throw new Error("trusted operations binary receipt set is invalid");
  }
  for (const [name, path] of Object.entries(REQUIRED_TOOLS)) {
    const item = value.binaries[name];
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "path,sha256"
      || item.path !== path
      || !/^[a-f0-9]{64}$/u.test(item.sha256 ?? "")
    ) {
      throw new Error("trusted operations binary receipt is invalid");
    }
    const opened = openTrustedExecutable(path, item.sha256, false);
    closeSync(opened.fd);
  }
  const daemon = value.daemon;
  if (
    !daemon
    || typeof daemon !== "object"
    || Array.isArray(daemon)
    || Object.keys(daemon).sort().join(",") !== "id,rootDir,serverVersion,storageDriver"
    || !/^[A-Za-z0-9:+._-]{8,128}$/u.test(daemon.id ?? "")
    || typeof daemon.rootDir !== "string"
    || !daemon.rootDir.startsWith("/")
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]*)?$/u.test(daemon.serverVersion ?? "")
    || !/^[A-Za-z0-9._-]{2,64}$/u.test(daemon.storageDriver ?? "")
  ) {
    throw new Error("trusted Docker daemon receipt is invalid");
  }
  return value;
}

function inspectDaemonIdentity(receipt, environment) {
  const docker = openTrustedExecutable(
    receipt.binaries.docker.path,
    receipt.binaries.docker.sha256,
    false,
  );
  try {
    const result = spawnSync(
      trustedExecutableInvocation(docker, 3),
      ["info", "--format", "{{json .}}"],
      {
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe", docker.fd],
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error("trusted local Docker daemon identity is unavailable");
    }
    const info = JSON.parse(result.stdout);
    const identity = {
      id: info.ID,
      rootDir: info.DockerRootDir,
      serverVersion: info.ServerVersion,
      storageDriver: info.Driver,
    };
    if (canonicalJson(identity) !== canonicalJson(receipt.daemon)) {
      throw new Error("trusted local Docker daemon identity mismatch");
    }
    return identity;
  } finally {
    closeSync(docker.fd);
  }
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Descriptor(fd, size) {
  const bytes = Buffer.allocUnsafe(size);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("trusted Docker executable was truncated");
      offset += count;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}
