import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTrustedPermitPreparedDockerContext,
  createTrustedPermitTerminalizationDockerContext,
  openTrustedDockerRuntime,
  openTrustedPermitPreparedDockerRuntime,
  openTrustedPermitTerminalizationDockerRuntime,
  restoreTrustedPermitPreparedDockerContext,
  serializeTrustedPermitPreparedDockerContext,
  validatePermitTerminalizationDockerArguments,
} from "./trustedDockerRuntime.mjs";

const REVISION = "a".repeat(40);

test("trusted Docker child receives the release manifest revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-trusted-docker-environment-"));
  const socket = join(root, "docker.sock");
  const executable = join(root, "docker-fixture");
  const server = createServer();
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(socket, resolvePromise);
    });
    chmodSync(socket, 0o660);
    const executableSha256 = createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex");
    const runtime = openTrustedDockerRuntime("docker", {
      NODE_ENV: "test",
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
      XINGHENG_OPERATION_LOCK_CONTEXT: "release-build",
      XINGHENG_TEST_DOCKER_CLI_PATH: executable,
      XINGHENG_TEST_DOCKER_CLI_SHA256: executableSha256,
      XINGHENG_TEST_COMPOSE_PLUGIN_PATH: executable,
      XINGHENG_TEST_COMPOSE_PLUGIN_SHA256: executableSha256,
      XINGHENG_TEST_DOCKER_SOCKET_PATH: socket,
      XINGHENG_RELEASE_MANIFEST_REVISION: REVISION,
      UNTRUSTED_ENVIRONMENT_MARKER: "must-not-propagate",
    });
    try {
      const child = spawnSync(process.execPath, [
        "-e",
        "process.stdout.write(JSON.stringify({ revision: process.env.XINGHENG_RELEASE_MANIFEST_REVISION, untrusted: process.env.UNTRUSTED_ENVIRONMENT_MARKER ?? null }))",
      ], {
        encoding: "utf8",
        env: runtime.environment,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), {
        revision: REVISION,
        untrusted: null,
      });
    } finally {
      runtime.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Permit prepared Docker context rejects objects not issued by the trusted validator", () => {
  const operationId = "b".repeat(32);
  assert.throws(() => openTrustedPermitPreparedDockerRuntime("compose", {
    XINGHENG_OPERATION_LOCK_CONTEXT: "production",
    XINGHENG_TRUSTED_OPERATION_ENTRY: "install-production-self-test-permit.sh",
    XINGHENG_PERMIT_INSTALL_OPERATION_ID: operationId,
  }, Object.freeze({ operationId })), /not issued by the trusted validator/u);
});

test("same-process and cross-process Permit transient capabilities remain descriptor-bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-permit-transient-descriptor-"));
  const socket = join(root, "docker.sock");
  const executable = join(root, "docker-fixture");
  const descriptor = join(root, "transient.json");
  const invalidDescriptor = join(root, "transient-invalid.json");
  const server = createServer();
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(socket, resolvePromise);
    });
    chmodSync(socket, 0o660);
    const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
    const source = permitFixtureSource(executable, executableSha256, socket);
    const context = createTrustedPermitPreparedDockerContext(permitContext(), source);
    const sameProcess = openTrustedPermitPreparedDockerRuntime("docker", source, context);
    sameProcess.close();

    const bytes = serializeTrustedPermitPreparedDockerContext(context, source);
    writeFileSync(descriptor, bytes, { mode: 0o400 });
    writeFileSync(invalidDescriptor, Buffer.from(bytes.toString("utf8").replace(
      `"receiptSha256":"${"a".repeat(64)}"`,
      `"receiptSha256":"${"f".repeat(64)}"`,
    )), { mode: 0o400 });
    const valid = invokeTransientChild(source, context, descriptor);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, "cross-process-transient=PASS\n");
    const invalid = invokeTransientChild(source, context, invalidDescriptor);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /descriptor identity mismatch/u);

    const normal = openTrustedDockerRuntime("docker", {
      ...source,
      XINGHENG_OPERATION_LOCK_CONTEXT: "release-build",
      XINGHENG_PERMIT_PREPARED_TRANSIENT_FD: "8",
    });
    normal.close();
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Permit terminalization Docker capability is same-process and argument allowlisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "xh-ptd-"));
  const socket = join(root, "docker.sock");
  const executable = join(root, "docker-fixture");
  const server = createServer();
  try {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(socket, resolvePromise);
    });
    chmodSync(socket, 0o660);
    const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
    const source = terminalizationFixtureSource(executable, executableSha256, socket);
    const context = createTrustedPermitTerminalizationDockerContext(
      terminalizationContext(),
      source,
    );
    const runtime = openTrustedPermitTerminalizationDockerRuntime("docker", source, context);
    runtime.close();
    validatePermitTerminalizationDockerArguments([
      "container", "inspect", context.apiContainerId,
    ], context);
    assert.throws(() => validatePermitTerminalizationDockerArguments([
      "container", "rm", context.apiContainerId,
    ], context), /not allowlisted/u);
    assert.throws(() => openTrustedPermitTerminalizationDockerRuntime(
      "docker",
      source,
      { ...context },
    ), /not issued/u);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(root, { recursive: true, force: true });
  }
});

function permitContext() {
  return Object.freeze({
    schemaVersion: 1,
    kind: "permit-prepared-transient",
    operationId: "b".repeat(32),
    operationLockContext: "production",
    receiptSha256: "a".repeat(64),
    attemptReceiptSha256: "b".repeat(64),
    environmentBeforeSha256: "c".repeat(64),
    environmentAfterSha256: "d".repeat(64),
    releaseIdentitySha256: "e".repeat(64),
    authorizationManifestSha256: "f".repeat(64),
    wrapperIdentity: { dev: 1, ino: 2, size: 3 },
    launcherIdentity: { dev: 4, ino: 5, size: 6 },
    operationLocks: [
      { path: "/run/lock/xingheng/release-global.lock", dev: 7, ino: 8, uid: 0, gid: 0, mode: 0o600 },
      { path: "/run/lock/xingheng/production.lock", dev: 9, ino: 10, uid: 0, gid: 0, mode: 0o600 },
    ],
  });
}

function permitFixtureSource(executable, executableSha256, socket) {
  return {
    NODE_ENV: "test",
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    XINGHENG_OPERATION_LOCK_CONTEXT: "production",
    XINGHENG_TRUSTED_OPERATION_ENTRY: "install-production-self-test-permit.sh",
    XINGHENG_PERMIT_INSTALL_OPERATION_ID: "b".repeat(32),
    XINGHENG_PERMIT_PREPARED_TRANSIENT_FD: "8",
    XINGHENG_TEST_DOCKER_CLI_PATH: executable,
    XINGHENG_TEST_DOCKER_CLI_SHA256: executableSha256,
    XINGHENG_TEST_COMPOSE_PLUGIN_PATH: executable,
    XINGHENG_TEST_COMPOSE_PLUGIN_SHA256: executableSha256,
    XINGHENG_TEST_DOCKER_SOCKET_PATH: socket,
  };
}

function terminalizationContext() {
  const fileIdentity = { dev: 1, ino: 2, size: 3, uid: 0, gid: 0, mode: 0o400 };
  return Object.freeze({
    schemaVersion: 1,
    kind: "permit-terminalization-transient",
    operationId: "c".repeat(32),
    sourceReceiptSha256: "d".repeat(64),
    sourceReceiptIdentity: fileIdentity,
    sourceAttemptIdentity: { ...fileIdentity, ino: 4, mode: 0o700 },
    apiContainerId: "e".repeat(64),
    ownerUserId: "USR-TERMINAL1",
    environmentBeforeSha256: "f".repeat(64),
    environmentAfterSha256: "a".repeat(64),
    wrapperIdentity: { ...fileIdentity, ino: 5, mode: 0o755 },
    launcherIdentity: { ...fileIdentity, ino: 6, mode: 0o755 },
    operationLocks: [
      { path: "/run/lock/xingheng/release-global.lock", dev: 7, ino: 8, uid: 0, gid: 0, mode: 0o600 },
      { path: "/run/lock/xingheng/production.lock", dev: 9, ino: 10, uid: 0, gid: 0, mode: 0o600 },
    ],
  });
}

function terminalizationFixtureSource(executable, executableSha256, socket) {
  return {
    NODE_ENV: "test",
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    XINGHENG_OPERATION_LOCK_CONTEXT: "production",
    XINGHENG_TRUSTED_OPERATION_ENTRY: "terminalize-production-self-test-permit.sh",
    XINGHENG_PERMIT_TERMINALIZATION_OPERATION_ID: "c".repeat(32),
    XINGHENG_PERMIT_TERMINALIZATION_SOURCE_SHA256: "d".repeat(64),
    XINGHENG_TEST_DOCKER_CLI_PATH: executable,
    XINGHENG_TEST_DOCKER_CLI_SHA256: executableSha256,
    XINGHENG_TEST_COMPOSE_PLUGIN_PATH: executable,
    XINGHENG_TEST_COMPOSE_PLUGIN_SHA256: executableSha256,
    XINGHENG_TEST_DOCKER_SOCKET_PATH: socket,
  };
}

function invokeTransientChild(source, context, descriptorPath) {
  const descriptorFd = openSync(descriptorPath, "r");
  try {
    unlinkSync(descriptorPath);
    return spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        "import {createTrustedPermitPreparedDockerContext,restoreTrustedPermitPreparedDockerContext,openTrustedPermitPreparedDockerRuntime} from './scripts/trustedDockerRuntime.mjs';",
        "const expected=createTrustedPermitPreparedDockerContext(Object.freeze(JSON.parse(Buffer.from(process.env.FAKE_CONTEXT_B64,'base64').toString('utf8'))),process.env);",
        "const restored=restoreTrustedPermitPreparedDockerContext(expected,process.env,8);",
        "const runtime=openTrustedPermitPreparedDockerRuntime('docker',process.env,restored);runtime.close();",
        "process.stdout.write('cross-process-transient=PASS\\n');",
      ].join(""),
    ], {
      cwd: new URL("../", import.meta.url).pathname,
      encoding: "utf8",
      env: {
        ...source,
        FAKE_CONTEXT_B64: Buffer.from(JSON.stringify(context)).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", descriptorFd],
    });
  } finally {
    closeSync(descriptorFd);
  }
}
