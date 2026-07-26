#!/usr/bin/env node
import {
  openTrustedDockerRuntime,
  trustedDockerReceipt,
  trustedExecutableInvocation,
  verifyTrustedDockerRuntime,
} from "./trustedDockerRuntime.mjs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: trusted-docker.mjs DOCKER_ARGS...");
  process.exit(2);
}

try {
  if (
    process.env.NODE_ENV !== "test"
    && (
      process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "production"
      || process.env.XINGHENG_TRUSTED_DOCKER_PURPOSE !== "release-build"
    )
  ) {
    throw new Error("trusted Docker command is internal to the locked release build");
  }
  validateReleaseBuildArguments(args);
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

function validateReleaseBuildArguments(values) {
  if (
    values[0] === "build"
    && values.length === 10
    && values[1] === "--build-arg"
    && /^XINGHENG_REVISION=[a-f0-9]{40}$/u.test(values[2])
    && values[3] === "--target"
    && ["api", "web", "strategy-tools"].includes(values[4])
    && values[5] === "--platform"
    && values[6] === "linux/amd64"
    && values[7] === "--tag"
    && new RegExp(`^xingheng-${values[4]}:[a-f0-9]{40}$`, "u").test(values[8])
    && values[9].startsWith("/tmp/xingheng-release.")
  ) return;
  if (
    values.length === 5
    && values[0] === "image"
    && values[1] === "inspect"
    && values[2] === "--format"
    && ["{{.Id}}", "{{.Os}}/{{.Architecture}}"].includes(values[3])
    && /^xingheng-(?:api|web|strategy-tools):[a-f0-9]{40}$/u.test(values[4])
  ) return;
  throw new Error("trusted Docker release-build arguments are not allowlisted");
}
