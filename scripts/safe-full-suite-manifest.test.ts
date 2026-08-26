import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  discoverSafeTestFiles,
  forbiddenExecutablePaths,
  formalTestFile,
  repositoryRoot,
} from "./run-full-test-suite.mjs";

test("npm test discovers only formal tests and permanently excludes Provider mutation CLIs", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const discovered = discoverSafeTestFiles(repositoryRoot);

  assert.equal(packageJson.scripts?.test, "node scripts/run-full-test-suite.mjs");
  assert.ok(discovered.includes("scripts/safe-full-suite-manifest.test.ts"));
  assert.equal(discovered.every((path) => formalTestFile.test(path)), true);
  for (const unsafePath of forbiddenExecutablePaths) assert.equal(discovered.includes(unsafePath), false);
  assert.equal(discovered.some((path) => path.endsWith("run-real-trading-test.ts")), false);
});
