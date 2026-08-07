import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTrustedDockerRuntime } from "./trustedDockerRuntime.mjs";

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
