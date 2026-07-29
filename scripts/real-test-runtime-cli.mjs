#!/usr/bin/env node
import { runRealTestRuntimeOperation } from "./realTestRuntimeOperation.mjs";

try {
  const operation = process.argv[2];
  if (process.argv.length !== 3 || !["activate", "stop"].includes(operation)) {
    throw new Error("real-test runtime CLI operation is invalid");
  }
  const receipt = runRealTestRuntimeOperation(
    operation,
    new URL("../", import.meta.url).pathname,
  );
  console.log(
    `real-test API ${operation === "activate" ? "activated" : "stopped"}`
      + ` revision=${receipt.revision}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "real-test runtime operation failed");
  process.exitCode = 1;
}
