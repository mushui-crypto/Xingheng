import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REVISION = "a".repeat(40);
const PARENT = "b".repeat(40);
const SOURCE_SHA = "c".repeat(64);
const TREE_SHA = "d".repeat(64);
const MANIFEST_SHA = "e".repeat(64);
const CANDIDATE_ROOT = `/opt/xingheng-release/candidates/${REVISION}`;
const CANDIDATE_MANIFEST = `${CANDIDATE_ROOT}/release-manifest.json`;
const CANONICAL_MANIFEST = "/opt/xingheng-release/code/deploy/release-manifest.json";

test("archive promotion keeps candidate and canonical manifest phases distinct", () => {
  withFixture(({ root, env }) => {
    const result = promote(root, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /production gate PASS/u);
  });
});

test("archive promotion fails closed on candidate identity drift", () => {
  withFixture(({ root, env }) => {
    for (const [index, value] of [[5, "f".repeat(64)], [6, "f".repeat(64)], [7, "f".repeat(64)]]) {
      const args = promotionArguments();
      args[index] = value;
      const result = run(root, env, args);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /production gate PASS/u);
    }
  });
});

test("archive promotion passes the canonical manifest to runtime verification", () => {
  withFixture(({ root, env }) => {
    const result = promote(root, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /canonical runtime PASS/u);
  });
});

test("release verify rejects a candidate manifest used as the canonical manifest", () => {
  const result = spawnSync("sh", [
    new URL("./release-verify.sh", import.meta.url).pathname,
    "--archive",
    CANDIDATE_ROOT,
    CANDIDATE_MANIFEST,
    REVISION,
    PARENT,
    SOURCE_SHA,
    TREE_SHA,
    MANIFEST_SHA,
    CANDIDATE_MANIFEST,
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate manifest cannot be used as canonical manifest/u);
});

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "release-workflow-archive-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    cpSync(new URL("./release-promote.sh", import.meta.url), join(root, "scripts/release-promote.sh"));
    writeExecutable(join(root, "scripts/release-verify.sh"), `#!/bin/sh
set -eu
[ "$1" = --archive ]
[ "$2" = "${CANDIDATE_ROOT}" ]
[ "$3" = "${CANDIDATE_MANIFEST}" ]
[ "$4" = "${REVISION}" ]
[ "$5" = "${PARENT}" ]
[ "$6" = "${SOURCE_SHA}" ]
[ "$7" = "${TREE_SHA}" ]
[ "$8" = "${MANIFEST_SHA}" ]
[ "$9" = --deployment ]
[ "\${10}" = --health-url ]
[ "\${12}" = "${CANONICAL_MANIFEST}" ]
printf 'canonical runtime PASS\n'
`);
    writeExecutable(join(root, "bin/node"), `#!/bin/sh
case "$2:$3:$4" in
  manifest-revision:${CANONICAL_MANIFEST}:) printf '${REVISION}\n' ;;
  manifest-image:${CANONICAL_MANIFEST}:api) printf 'sha256:%064d\n' 1 ;;
  manifest-image:${CANONICAL_MANIFEST}:web) printf 'sha256:%064d\n' 2 ;;
  manifest-image:${CANONICAL_MANIFEST}:strategyTools) printf 'sha256:%064d\n' 3 ;;
  *) exit 1 ;;
esac
`);
    callback({
      root,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function promote(root, env) {
  return run(root, env, promotionArguments());
}

function run(root, env, args) {
  return spawnSync("sh", ["scripts/release-promote.sh", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function promotionArguments() {
  return [
    "--archive",
    CANDIDATE_ROOT,
    CANDIDATE_MANIFEST,
    REVISION,
    PARENT,
    SOURCE_SHA,
    TREE_SHA,
    MANIFEST_SHA,
    "capital-test",
    CANONICAL_MANIFEST,
    "production",
    "PASS",
    "PASS",
    "PASS",
    "rollback-point",
    "https://example.invalid",
  ];
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}
