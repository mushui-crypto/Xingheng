#!/usr/bin/env node
import { copyWifBundle, readExpectedAudience, validateWifBundle } from "./gcpWifBundle.mjs";

function usage() {
  throw new Error(
    "usage: verify-gcp-wif-bundle.mjs source SOURCE_DIR AUDIENCE_FILE | installed ROOT AUDIENCE_FILE | copy SOURCE_DIR DESTINATION_ROOT AUDIENCE_FILE",
  );
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "source" && args.length === 2) {
    const audience = readExpectedAudience(args[1]);
    validateWifBundle(args[0], audience);
    console.log("WIF source bundle verified");
  } else if (command === "installed" && args.length === 2) {
    const audience = readExpectedAudience(args[1]);
    validateWifBundle(args[0], audience, { expectedUid: 20001, expectedGid: 20001 });
    console.log("WIF installed bundle verified");
  } else if (command === "copy" && args.length === 3) {
    const audience = readExpectedAudience(args[2]);
    copyWifBundle(args[0], args[1], audience);
    console.log("WIF bundle installed into isolated tmpfs");
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "WIF bundle verification failed");
  process.exit(1);
}
