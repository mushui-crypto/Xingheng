#!/usr/bin/env node
import { copyWifBundle, readExpectedAudience, validateWifBundle } from "./gcpWifBundle.mjs";

function usage() {
  throw new Error(
    "usage: verify-gcp-wif-bundle.mjs source PROFILE SOURCE_DIR AUDIENCE_FILE | installed PROFILE ROOT AUDIENCE_FILE | copy PROFILE SOURCE_DIR DESTINATION_ROOT AUDIENCE_FILE",
  );
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "source" && args.length === 3) {
    const audience = readExpectedAudience(args[2]);
    validateWifBundle(args[1], audience, args[0]);
    console.log("WIF source bundle verified");
  } else if (command === "installed" && args.length === 3) {
    const audience = readExpectedAudience(args[2]);
    validateWifBundle(args[1], audience, args[0], { expectedUid: 20001, expectedGid: 20001 });
    console.log("WIF installed bundle verified");
  } else if (command === "copy" && args.length === 4) {
    const audience = readExpectedAudience(args[3]);
    copyWifBundle(args[1], args[2], audience, args[0]);
    console.log("WIF bundle installed into isolated tmpfs");
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "WIF bundle verification failed");
  process.exit(1);
}
