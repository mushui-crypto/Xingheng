#!/usr/bin/env node
import {
  openTrustedDockerRuntime,
  trustedDockerReceipt,
  trustedExecutableInvocation,
  validateTrustedReleaseBuildDockerArguments,
  verifyTrustedDockerRuntime,
} from "./trustedDockerRuntime.mjs";
import { spawnSync } from "node:child_process";
import { inheritedOperationLocks } from "./operationLocks.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: trusted-docker.mjs DOCKER_ARGS...");
  process.exit(2);
}

try {
  const testInvocation = process.getuid?.() !== 0
    && process.env.NODE_ENV === "test"
    && process.env.NODE_TEST_CONTEXT === "child-v8";
  if (
    !testInvocation
    && (
      process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "release-build"
      || process.env.XINGHENG_TRUSTED_DOCKER_PURPOSE !== "release-build"
    )
  ) {
    throw new Error("trusted Docker command is internal to the locked release build");
  }
  if (!testInvocation) inheritedOperationLocks("release-build");
  validateTrustedReleaseBuildDockerArguments(args, process.env);
  const runtime = openTrustedDockerRuntime("docker", process.env);
  try {
    console.error(trustedDockerReceipt(runtime, "docker", "validated"));
    const result = spawnSync(trustedExecutableInvocation(runtime, 3), args, {
      env: runtime.environment,
      stdio: ["inherit", "inherit", "inherit", runtime.fd],
    });
    verifyTrustedDockerRuntime(runtime);
    console.error(trustedDockerReceipt(runtime, "docker", "consumed"));
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    runtime.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "trusted Docker command failed");
  process.exit(1);
}
