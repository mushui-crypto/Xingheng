import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const provider = new URL("./provider-gate1-preflight.sh", import.meta.url).pathname;
const backup = new URL("./rwa-automation-verify.sh", import.meta.url).pathname;

test("Gate 1 wrappers expose only fixed Compose invocations", () => {
  const providerSource = readFileSync(provider, "utf8");
  const backupSource = readFileSync(backup, "utf8");
  assert.match(providerSource, /--profile provider-identity-preflight run --rm --no-deps provider-identity-preflight/u);
  assert.match(backupSource, /--profile rwa-automation-verify run --rm --no-deps rwa-automation-verify/u);
  for (const source of [providerSource, backupSource]) {
    assert.doesNotMatch(source, /run[^\n]*\s-e\s|--entrypoint|--command|--env-file/u);
    assert.match(source, /verify_production_compose/u);
    assert.match(source, /verify-deployment-revision\.mjs images/u);
    assert.match(source, /verify_release_containers/u);
  }
});

test("provider Gate 1 wrapper rejects extra, lowercase, path and control arguments", () => {
  for (const args of [[], ["USR-OK", "EXTRA"], ["usr-LOWER"], ["USR-A/B"], ["USR-A\nB"]]) {
    const result = spawnSync(provider, args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  }
});

test("backup verify wrapper rejects extra arguments, paths, whitespace, controls and globs", () => {
  const valid = "rwa-automation-20260731T120000Z.rwa.enc.json";
  for (const args of [[], [valid, "EXTRA"], [`../${valid}`], [`${valid} `], [`${valid}\n`], ["*"]]) {
    const result = spawnSync(backup, args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  }
});
