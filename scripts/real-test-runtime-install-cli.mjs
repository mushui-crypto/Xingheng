#!/usr/bin/env node
import {
  installRealTestRuntime,
  readBoundedRuntimeEnvironment,
} from "./installRealTestRuntime.mjs";

let bytes;
try {
  if (process.argv.length !== 2) {
    throw new Error("real-test runtime install does not accept arguments");
  }
  const root = new URL("../", import.meta.url).pathname;
  const revision = process.env.XINGHENG_RELEASE_CANDIDATE_REVISION;
  bytes = readBoundedRuntimeEnvironment(0);
  const receipt = installRealTestRuntime(revision, root, bytes);
  console.log(`real-test runtime installed revision=${receipt.revision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "real-test runtime install failed");
  process.exitCode = 1;
} finally {
  bytes?.fill(0);
}
