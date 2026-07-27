#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  REVISION_LABEL,
  assertFullRevision,
  parseRevisionEnv,
  validateProductionComposeConfig,
  validateRealTestComposeConfig,
  validateReleaseManifest,
  verifyRevisionEvidence,
} from "./deploymentRevision.mjs";
import {
  validateDualEnvironmentTopology,
  validateStandaloneRealTestTopology,
} from "./dualEnvironmentTopology.mjs";
import { execTrustedDockerSync } from "./trustedDockerRuntime.mjs";
import { assertTrustedReleaseRoot } from "./trustedDockerRuntime.mjs";

const IMAGE_COMPONENTS = Object.freeze([
  ["api", "api"],
  ["web", "web"],
  ["strategy-tools", "strategyTools"],
  ["rwa-automation-backup", "api"],
  ["rwa-automation-restore", "api"],
  ["sqlite-restore", "api"],
  ["sqlite-verify", "api"],
  ["provider-identity-preflight", "api"],
  ["rwa-automation-verify", "api"],
]);

const RUNNING_COMPONENTS = Object.freeze([
  ["api", "api"],
  ["web", "web"],
]);
const MANIFEST_MAX_BYTES = 16 * 1024;
const SAFE_MANIFEST_MODE = 0o444;
const PRODUCTION_COMPOSE = new URL("./production-compose.sh", import.meta.url).pathname;
const REAL_TEST_COMPOSE = new URL("./real-test-compose.sh", import.meta.url).pathname;
const REAL_TEST_STANDALONE_COMPOSE =
  new URL("./real-test-standalone-compose.sh", import.meta.url).pathname;
const FIXED_PRODUCTION_ENV = new URL("../.env.production", import.meta.url).pathname;
const FIXED_REAL_TEST_ENV = new URL("../.env.real-test", import.meta.url).pathname;

function run(command, args) {
  if (command === "docker") {
    return execTrustedDockerSync(args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  const inheritedLocks = process.getuid?.() === 0
    && ["production", "real-test"].includes(process.env.XINGHENG_OPERATION_LOCK_CONTEXT)
    ? [3, 4]
    : [];
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe", ...inheritedLocks],
  }).trim();
}

function readReleaseManifest(path) {
  if (process.getuid?.() === 0) {
    const root = assertTrustedReleaseRoot(new URL("../", import.meta.url).pathname);
    const expectedPath = process.env.XINGHENG_OPERATION_LOCK_CONTEXT === "release-build"
      ? resolve(dirname(root), "release-manifest.json")
      : resolve(root, "deploy/release-manifest.json");
    if (resolve(path) !== expectedPath) {
      throw new Error("release manifest path is not canonical");
    }
  }
  const before = lstatSync(path);
  const expectedUid = process.getuid?.() === 0 ? 0 : before.uid;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || (before.mode & 0o777) !== SAFE_MANIFEST_MODE
    || before.size < 2
    || before.size > MANIFEST_MAX_BYTES
  ) {
    throw new Error("release manifest file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || (opened.mode & 0o777) !== SAFE_MANIFEST_MODE
    ) {
      throw new Error("release manifest file boundary is invalid");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("release manifest changed while being read");
    }
    return validateReleaseManifest(JSON.parse(bytes.toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

function writeReleaseManifest(path, revision, apiDigest, webDigest, strategyDigest) {
  const manifest = validateReleaseManifest({
    schemaVersion: 1,
    revision,
    images: {
      api: apiDigest,
      web: webDigest,
      strategyTools: strategyDigest,
    },
  });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: SAFE_MANIFEST_MODE,
  });
  chmodSync(path, SAFE_MANIFEST_MODE);
  return readReleaseManifest(path);
}

function inspectImage(digest, expectedRevision) {
  const inspected = JSON.parse(run("docker", ["image", "inspect", digest]))[0];
  const actualDigest = inspected?.Id;
  const imageRevision = inspected?.Config?.Labels?.[REVISION_LABEL];
  const builtRevision = run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    "cat",
    digest,
    "/app/.build-revision",
  ]);
  return { actualDigest, imageRevision, builtRevision };
}

function inspectRunningService(service, manifestDigest, project) {
  const ids = run("docker", [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    "{{.ID}}",
  ]).split(/\s+/u).filter(Boolean);
  if (ids.length !== 1) {
    throw new Error("deployment runtime component count mismatch");
  }
  const inspected = JSON.parse(run("docker", ["container", "inspect", ids[0]]))[0];
  if (inspected?.State?.Running !== true) {
    throw new Error("deployment runtime component is not running");
  }
  const actualDigest = inspected?.Image;
  if (actualDigest !== manifestDigest) {
    throw new Error("deployment runtime image digest mismatch");
  }
  const imageRevision = inspected?.Config?.Labels?.[REVISION_LABEL];
  const runtimeEntry = inspected?.Config?.Env?.find((entry) =>
    entry.startsWith("XINGHENG_EXPECTED_REVISION="));
  const runtimeRevision = runtimeEntry?.slice("XINGHENG_EXPECTED_REVISION=".length);
  const builtRevision = run("docker", ["exec", ids[0], "cat", "/app/.build-revision"]);
  return {
    actualDigest,
    imageRevision,
    builtRevision,
    runtimeRevision,
    healthStatus: inspected?.State?.Health?.Status,
    labels: inspected?.Config?.Labels,
    portBindings: inspected?.HostConfig?.PortBindings,
    networks: inspected?.NetworkSettings?.Networks,
  };
}

function inspectReleaseImages(manifest) {
  const byDigest = new Map();
  return IMAGE_COMPONENTS.map(([name, manifestKey]) => {
    const manifestDigest = manifest.images[manifestKey];
    if (!byDigest.has(manifestDigest)) {
      byDigest.set(manifestDigest, inspectImage(manifestDigest, manifest.revision));
    }
    return {
      name,
      manifestDigest,
      ...byDigest.get(manifestDigest),
    };
  });
}

function verifyImages(manifest) {
  verifyRevisionEvidence({
    expectedRevision: manifest.revision,
    components: inspectReleaseImages(manifest),
  });
}

function verifyCandidateImages(manifest) {
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "release-build"
    || process.env.XINGHENG_RELEASE_CANDIDATE_REVISION !== manifest.revision
  ) {
    throw new Error("candidate image verification is outside the trusted release build");
  }
  for (const digest of Object.values(manifest.images)) {
    const inspected = JSON.parse(run("docker", [
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      digest,
    ]));
    if (
      inspected?.Id !== digest
      || inspected?.Os !== "linux"
      || inspected?.Architecture !== "amd64"
      || inspected?.Config?.Labels?.[REVISION_LABEL] !== manifest.revision
    ) {
      throw new Error("candidate image revision, digest or platform mismatch");
    }
  }
}

function verifyContainers(manifest, project = "xingheng", realTestMode = null) {
  const running = new Map(
    RUNNING_COMPONENTS.map(([name, manifestKey]) => [
      name,
      inspectRunningService(name, manifest.images[manifestKey], project),
    ]),
  );
  const components = inspectReleaseImages(manifest).map((component) => ({
    ...component,
    runtimeRevision: running.get(component.name)?.runtimeRevision ?? manifest.revision,
  }));
  for (const [name] of RUNNING_COMPONENTS) {
    const runtime = running.get(name);
    if (
      runtime.imageRevision !== manifest.revision
      || runtime.builtRevision !== manifest.revision
      || runtime.runtimeRevision !== manifest.revision
    ) {
      throw new Error("deployment runtime revision mismatch");
    }
  }
  if (realTestMode !== null) {
    verifyRealTestRuntime(running, realTestMode);
  }
  verifyRevisionEvidence({
    expectedRevision: manifest.revision,
    components,
    requireRuntimeEvidence: true,
  });
}

function verifyRealTestRuntime(running, mode) {
  if (!["shared", "standalone"].includes(mode)) {
    throw new Error("real-test runtime topology mode is invalid");
  }
  for (const name of ["api", "web"]) {
    const status = running.get(name)?.healthStatus;
    if (status !== "healthy") {
      throw new Error(`real-test ${name} container health status is ${status ?? "missing"}`);
    }
  }
  const api = running.get("api");
  if (
    Object.keys(api.networks ?? {}).join("\n") !== "xingheng-real-test_default"
    || Object.keys(api.portBindings ?? {}).length !== 0
  ) {
    throw new Error("real-test API runtime topology mismatch");
  }
  const web = running.get("web");
  if (web.labels?.["com.xingheng.real-test.topology"] !== mode) {
    throw new Error("real-test runtime topology label mismatch");
  }
  const networkNames = Object.keys(web.networks ?? {}).sort();
  const expectedNetworks = mode === "shared"
    ? ["xingheng-public-ingress", "xingheng-real-test_default"]
    : ["xingheng-real-test_default"];
  if (networkNames.join("\n") !== expectedNetworks.sort().join("\n")) {
    throw new Error("real-test runtime network topology mismatch");
  }
  const bindings = web.portBindings ?? {};
  if (mode === "shared") {
    if (Object.keys(bindings).length !== 0) {
      throw new Error("shared real-test runtime must not publish host ports");
    }
    return;
  }
  const expectedPorts = Object.freeze({
    "80/tcp": "80",
    "443/tcp": "443",
    "443/udp": "443",
  });
  if (Object.keys(bindings).sort().join("\n") !== Object.keys(expectedPorts).sort().join("\n")) {
    throw new Error("standalone real-test runtime port set mismatch");
  }
  for (const [containerPort, hostPort] of Object.entries(expectedPorts)) {
    const entries = bindings[containerPort];
    if (
      !Array.isArray(entries)
      || entries.length < 1
      || entries.some((entry) =>
        entry?.HostPort !== hostPort
        || !["", "0.0.0.0", "::"].includes(entry?.HostIp ?? ""))
    ) {
      throw new Error("standalone real-test runtime port binding mismatch");
    }
  }
}

function verifyRealTestContainers(manifest, mode) {
  const testMode = process.env.NODE_ENV === "test";
  const attempts = testMode ? 3 : 19;
  const delayMs = testMode ? 1 : 5_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      verifyContainers(manifest, "xingheng-real-test", mode);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.endsWith("health status is starting") || attempt === attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

function verifyProductionCompose(manifest, envFile) {
  if (resolve(envFile) !== FIXED_PRODUCTION_ENV) {
    throw new Error("production Compose environment path is not fixed");
  }
  if (readSecureEnvironmentRevision(envFile) !== manifest.revision) {
    throw new Error("deployment environment revision mismatch");
  }
  const source = run(PRODUCTION_COMPOSE, [
    "--profile",
    "strategy-tools",
    "--profile",
    "sqlite-ops",
    "--profile",
    "rwa-automation-ops",
    "--profile",
    "provider-identity-preflight",
    "config",
    "--format",
    "json",
  ]);
  validateProductionComposeConfig(manifest, JSON.parse(source));
}

function verifyRealTestCompose(manifest, envFile) {
  if (resolve(envFile) !== FIXED_REAL_TEST_ENV) {
    throw new Error("real-test Compose environment path is not fixed");
  }
  if (readSecureEnvironmentRevision(envFile) !== manifest.revision) {
    throw new Error("deployment environment revision mismatch");
  }
  const source = run(REAL_TEST_COMPOSE, [
    "--profile",
    "strategy-tools",
    "--profile",
    "real-test-cleanup",
    "--profile",
    "rwa-automation-ops",
    "--profile",
    "provider-identity-preflight",
    "config",
    "--format",
    "json",
  ]);
  validateRealTestComposeConfig(manifest, JSON.parse(source));
}

function verifyStandaloneRealTestCompose(manifest, envFile) {
  if (resolve(envFile) !== FIXED_REAL_TEST_ENV) {
    throw new Error("real-test Compose environment path is not fixed");
  }
  if (readSecureEnvironmentRevision(envFile) !== manifest.revision) {
    throw new Error("deployment environment revision mismatch");
  }
  const source = resolvedCompose(REAL_TEST_STANDALONE_COMPOSE, [
    "strategy-tools",
    "real-test-cleanup",
    "rwa-automation-ops",
    "provider-identity-preflight",
  ]);
  validateStandaloneRealTestTopology(manifest, source);
}

function resolvedCompose(command, profiles) {
  return JSON.parse(run(command, [
    ...profiles.flatMap((profile) => ["--profile", profile]),
    "config",
    "--format",
    "json",
  ]));
}

function verifyDualCompose(manifest, productionEnvFile, realTestEnvFile) {
  if (
    resolve(productionEnvFile) !== FIXED_PRODUCTION_ENV
    || resolve(realTestEnvFile) !== FIXED_REAL_TEST_ENV
  ) {
    throw new Error("dual-environment Compose paths are not fixed");
  }
  if (
    readSecureEnvironmentRevision(productionEnvFile) !== manifest.revision
    || readSecureEnvironmentRevision(realTestEnvFile) !== manifest.revision
  ) {
    throw new Error("dual-environment revision mismatch");
  }
  const production = resolvedCompose(PRODUCTION_COMPOSE, [
    "strategy-tools",
    "sqlite-ops",
    "rwa-automation-ops",
    "provider-identity-preflight",
  ]);
  const realTest = resolvedCompose(REAL_TEST_COMPOSE, [
    "strategy-tools",
    "real-test-cleanup",
    "rwa-automation-ops",
    "provider-identity-preflight",
  ]);
  validateDualEnvironmentTopology(manifest, production, realTest);
}

function readSecureEnvironmentRevision(path) {
  const before = lstatSync(path);
  const expectedUid = process.getuid?.() === 0 ? 0 : before.uid;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || (before.mode & 0o777) !== 0o600
    || before.size < 1
    || before.size > 1024 * 1024
  ) {
    throw new Error("deployment environment file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== before.uid
      || opened.gid !== before.gid
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error("deployment environment file changed while opening");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("deployment environment file changed while being read");
    }
    return parseRevisionEnv(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function usage() {
  throw new Error(
    "usage: verify-deployment-revision.mjs validate REVISION | read-env ENV_FILE | write-manifest PATH REVISION API_DIGEST WEB_DIGEST STRATEGY_DIGEST | manifest-values PATH ENV_FILE | manifest-revision PATH | manifest-image PATH api|web|strategyTools | env MANIFEST ENV_FILE | compose MANIFEST ENV_FILE | compose-real-test MANIFEST ENV_FILE | compose-real-test-standalone MANIFEST ENV_FILE | dual-compose MANIFEST PRODUCTION_ENV REAL_TEST_ENV | images MANIFEST | candidate-images MANIFEST | containers MANIFEST | containers-real-test MANIFEST shared|standalone",
  );
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate" && args.length === 1) {
    assertFullRevision(args[0]);
    console.log("deployment revision format valid");
  } else if (command === "read-env" && args.length === 1) {
    console.log(parseRevisionEnv(readFileSync(args[0], "utf8")));
  } else if (command === "write-manifest" && args.length === 5) {
    const manifest = writeReleaseManifest(args[0], args[1], args[2], args[3], args[4]);
    console.log(manifest.revision);
  } else if (command === "manifest-values" && args.length === 2) {
    const manifest = readReleaseManifest(args[0]);
    if (readSecureEnvironmentRevision(args[1]) !== manifest.revision) {
      throw new Error("deployment environment revision mismatch");
    }
    console.log([
      manifest.revision,
      manifest.images.api,
      manifest.images.web,
      manifest.images.strategyTools,
    ].join("\n"));
  } else if (command === "manifest-revision" && args.length === 1) {
    console.log(readReleaseManifest(args[0]).revision);
  } else if (command === "manifest-image" && args.length === 2) {
    const manifest = readReleaseManifest(args[0]);
    if (!["api", "web", "strategyTools"].includes(args[1])) usage();
    console.log(manifest.images[args[1]]);
  } else if (command === "env" && args.length === 2) {
    const manifest = readReleaseManifest(args[0]);
    if (parseRevisionEnv(readFileSync(args[1], "utf8")) !== manifest.revision) {
      throw new Error("deployment environment revision mismatch");
    }
    console.log(manifest.revision);
  } else if (command === "compose" && args.length === 2) {
    const manifest = readReleaseManifest(args[0]);
    verifyProductionCompose(manifest, args[1]);
    console.log("production Compose release mapping verified");
  } else if (command === "compose-real-test" && args.length === 2) {
    const manifest = readReleaseManifest(args[0]);
    verifyRealTestCompose(manifest, args[1]);
    console.log("real-test Compose release mapping verified");
  } else if (command === "compose-real-test-standalone" && args.length === 2) {
    const manifest = readReleaseManifest(args[0]);
    verifyStandaloneRealTestCompose(manifest, args[1]);
    console.log("standalone real-test Compose release mapping verified");
  } else if (command === "dual-compose" && args.length === 3) {
    const manifest = readReleaseManifest(args[0]);
    verifyDualCompose(manifest, args[1], args[2]);
    console.log("dual-environment Compose topology verified");
  } else if (command === "images" && args.length === 1) {
    const manifest = readReleaseManifest(args[0]);
    verifyImages(manifest);
    console.log("deployment image revisions and digests verified");
  } else if (command === "candidate-images" && args.length === 1) {
    const manifest = readReleaseManifest(args[0]);
    verifyCandidateImages(manifest);
    console.log("candidate image revisions, digests and platforms verified");
  } else if (command === "containers" && args.length === 1) {
    const manifest = readReleaseManifest(args[0]);
    verifyContainers(manifest);
    console.log("deployment container revisions and digests verified");
  } else if (
    command === "containers-real-test"
    && args.length === 2
    && ["shared", "standalone"].includes(args[1])
  ) {
    const manifest = readReleaseManifest(args[0]);
    verifyRealTestContainers(manifest, args[1]);
    console.log("real-test container revisions and digests verified");
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "deployment revision verification failed");
  process.exit(1);
}
