import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REQUIRED_IMAGE_COMPONENTS,
  assertFullRevision,
  assertImageDigest,
  parseRevisionEnv,
  validateProductionComposeConfig,
  validateReleaseManifest,
  verifyRevisionEvidence,
} from "./deploymentRevision.mjs";

const REVISION = "78c277c0605712c3644ee5136d3ffe7d93c68d4c";
const OTHER_REVISION = "a".repeat(40);
const API_DIGEST = `sha256:${"1".repeat(64)}`;
const WEB_DIGEST = `sha256:${"2".repeat(64)}`;
const STRATEGY_DIGEST = `sha256:${"3".repeat(64)}`;
const VERIFIER = new URL("./verify-deployment-revision.mjs", import.meta.url).pathname;

const COMPONENT_DIGESTS = Object.freeze({
  api: API_DIGEST,
  web: WEB_DIGEST,
  "strategy-tools": STRATEGY_DIGEST,
  "rwa-automation-backup": API_DIGEST,
  "rwa-automation-restore": API_DIGEST,
  "rwa-automation-verify": API_DIGEST,
});

test("accepts one exact full revision across every release component", () => {
  assert.equal(
    verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence(),
      requireRuntimeEvidence: true,
    }),
    REVISION,
  );
});

test("rejects missing, short and illegal revisions", () => {
  for (const revision of [
    undefined,
    "",
    REVISION.slice(0, 12),
    `${REVISION.slice(0, 39)}G`,
  ]) {
    assert.throws(() => assertFullRevision(revision), /full lowercase Git commit/u);
  }
});

test("accepts only immutable image digests", () => {
  assert.equal(assertImageDigest(API_DIGEST), API_DIGEST);
  for (const digest of [
    undefined,
    "",
    "xingheng-api:latest",
    "sha256:abc",
    `sha256:${"G".repeat(64)}`,
  ]) {
    assert.throws(() => assertImageDigest(digest), /immutable sha256 digest/u);
  }
});

test("accepts only the exact release manifest schema", () => {
  assert.deepEqual(validateReleaseManifest(manifestValue()), manifestValue());
  for (const invalid of [
    { ...manifestValue(), extra: true },
    { ...manifestValue(), schemaVersion: 2 },
    { ...manifestValue(), revision: OTHER_REVISION.slice(0, 12) },
    {
      ...manifestValue(),
      images: { ...manifestValue().images, api: "xingheng-api:latest" },
    },
    {
      ...manifestValue(),
      images: { ...manifestValue().images, extra: API_DIGEST },
    },
  ]) {
    assert.throws(() => validateReleaseManifest(invalid));
  }
});

test("production Compose accepts only the fixed project and manifest service mapping", () => {
  assert.equal(
    validateProductionComposeConfig(manifestValue(), composeConfig()),
    REVISION,
  );
  const mutations = [
    (config) => { config.name = "other-project"; },
    (config) => { config.services.api.build = { context: "." }; },
    (config) => { config.services.api.pull_policy = "always"; },
    (config) => { config.services.web.image = API_DIGEST; },
    (config) => { config.services.web.environment.XINGHENG_EXPECTED_REVISION = OTHER_REVISION; },
    (config) => { config.services.api.environment.XINGHENG_DEPLOYMENT_ENVIRONMENT = "staging"; },
    (config) => { config.services.api.environment.XINGHENG_COMPOSE_PROJECT = "other-project"; },
    (config) => { config.services.extra = {}; },
  ];
  for (const mutate of mutations) {
    const config = composeConfig();
    mutate(config);
    assert.throws(() => validateProductionComposeConfig(manifestValue(), config));
  }
});

test("revision evidence rejects missing, mismatched and mutable components", () => {
  assert.throws(() => verifyRevisionEvidence({
    expectedRevision: REVISION,
    components: evidence().filter((entry) => entry.name !== "api"),
  }), /component is missing/u);
  assert.throws(() => verifyRevisionEvidence({
    expectedRevision: REVISION,
    components: evidence({ api: { imageRevision: OTHER_REVISION } }),
  }), /revision mismatch/u);
  assert.throws(() => verifyRevisionEvidence({
    expectedRevision: REVISION,
    components: evidence({ web: { actualDigest: API_DIGEST } }),
  }), /image digest mismatch/u);
  assert.throws(() => verifyRevisionEvidence({
    expectedRevision: REVISION,
    components: evidence({ web: { runtimeRevision: OTHER_REVISION } }),
    requireRuntimeEvidence: true,
  }), /runtime revision mismatch/u);
});

test("deployment environment requires one strict revision", () => {
  assert.equal(parseRevisionEnv(`DOMAIN=app.example.com\nXINGHENG_REVISION=${REVISION}\n`), REVISION);
  for (const source of [
    "",
    "XINGHENG_REVISION=main\n",
    `XINGHENG_REVISION=${REVISION}\nXINGHENG_REVISION=${REVISION}\n`,
  ]) {
    assert.throws(() => parseRevisionEnv(source));
  }
});

test("verifier CLI validates revisions outside a Git checkout", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-revision-cli-"));
  try {
    const valid = spawnSync(process.execPath, [VERIFIER, "validate", REVISION], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(valid.status, 0, valid.stderr);
    const invalid = spawnSync(process.execPath, [VERIFIER, "validate", "main"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifier writes and reads one strict read-only manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-manifest-"));
  try {
    const manifestPath = join(directory, "release-manifest.json");
    const write = spawnSync(process.execPath, [
      VERIFIER,
      "write-manifest",
      manifestPath,
      REVISION,
      API_DIGEST,
      WEB_DIGEST,
      STRATEGY_DIGEST,
    ], { encoding: "utf8" });
    assert.equal(write.status, 0, write.stderr);
    assert.equal(lstatSync(manifestPath).mode & 0o777, 0o444);
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), manifestValue());

    const read = spawnSync(
      process.execPath,
      [VERIFIER, "manifest-revision", manifestPath],
      { encoding: "utf8" },
    );
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout.trim(), REVISION);

    chmodSync(manifestPath, 0o644);
    const writable = spawnSync(
      process.execPath,
      [VERIFIER, "manifest-revision", manifestPath],
      { encoding: "utf8" },
    );
    assert.notEqual(writable.status, 0);

    const symlinkPath = join(directory, "manifest-link.json");
    symlinkSync(manifestPath, symlinkPath);
    const symlinked = spawnSync(
      process.execPath,
      [VERIFIER, "manifest-revision", symlinkPath],
      { encoding: "utf8" },
    );
    assert.notEqual(symlinked.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function manifestValue() {
  return {
    schemaVersion: 1,
    revision: REVISION,
    images: {
      api: API_DIGEST,
      web: WEB_DIGEST,
      strategyTools: STRATEGY_DIGEST,
    },
  };
}

function composeConfig() {
  const service = (image) => ({
    image,
    pull_policy: "never",
    environment: {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
    },
  });
  return {
    name: "xingheng",
    services: {
      api: service(API_DIGEST),
      web: service(WEB_DIGEST),
      "strategy-history": service(STRATEGY_DIGEST),
      "sqlite-restore": service(API_DIGEST),
      "provider-identity-preflight": service(API_DIGEST),
      "rwa-automation-verify": service(API_DIGEST),
      "rwa-automation-backup": service(API_DIGEST),
      "rwa-automation-restore": service(API_DIGEST),
    },
  };
}

function evidence(overrides = {}) {
  return REQUIRED_IMAGE_COMPONENTS.map((name) => ({
    name,
    imageRevision: REVISION,
    builtRevision: REVISION,
    runtimeRevision: REVISION,
    manifestDigest: COMPONENT_DIGESTS[name],
    actualDigest: COMPONENT_DIGESTS[name],
    ...overrides[name],
  }));
}
