import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  REQUIRED_IMAGE_COMPONENTS,
  assertFullRevision,
  assertImageDigest,
  parseRevisionEnv,
  validateProductionComposeConfig,
  validateRealTestComposeConfig,
  validateReleaseManifest,
  verifyRevisionEvidence,
} from "./deploymentRevision.mjs";

const REVISION = "78c277c0605712c3644ee5136d3ffe7d93c68d4c";
const OTHER_REVISION = "a".repeat(40);
const API_DIGEST = `sha256:${"1".repeat(64)}`;
const WEB_DIGEST = `sha256:${"2".repeat(64)}`;
const STRATEGY_DIGEST = `sha256:${"3".repeat(64)}`;

const COMPONENT_DIGESTS = Object.freeze({
  api: API_DIGEST,
  web: WEB_DIGEST,
  "strategy-tools": STRATEGY_DIGEST,
  "rwa-automation-backup": API_DIGEST,
  "rwa-automation-restore": API_DIGEST,
});
const VERIFIER = new URL("./verify-deployment-revision.mjs", import.meta.url).pathname;
const REPO_ROOT = new URL("../", import.meta.url).pathname;
const PRODUCTION_COMPOSE = new URL("./production-compose.sh", import.meta.url).pathname;
const DOCKER_FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "xingheng-docker-socket-"));
const DOCKER_FIXTURE_SOCKET = join(DOCKER_FIXTURE_DIRECTORY, "docker.sock");
const dockerFixtureServer = createServer();
await new Promise((resolvePromise, reject) => {
  dockerFixtureServer.once("error", reject);
  dockerFixtureServer.listen(DOCKER_FIXTURE_SOCKET, resolvePromise);
});
chmodSync(DOCKER_FIXTURE_SOCKET, 0o660);
after(async () => {
  await new Promise((resolvePromise) => dockerFixtureServer.close(resolvePromise));
  rmSync(DOCKER_FIXTURE_DIRECTORY, { recursive: true, force: true });
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

function composeConfig(overrides = {}, options = {}) {
  const project = options.project ?? "xingheng";
  const environment = options.environment ?? "production";
  const service = (image) => ({
    image,
    pull_policy: "never",
    environment: {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_DEPLOYMENT_ENVIRONMENT: environment,
      XINGHENG_COMPOSE_PROJECT: project,
    },
  });
  return {
    name: project,
    services: {
      api: service(API_DIGEST),
      web: service(WEB_DIGEST),
      "strategy-history": service(STRATEGY_DIGEST),
      "sqlite-restore": service(API_DIGEST),
      "provider-identity-preflight": service(API_DIGEST),
      ...(environment === "real-test" ? {
        "sqlite-backup": service(API_DIGEST),
        "sqlite-verify": service(API_DIGEST),
        "strategy-backup": service(API_DIGEST),
        "strategy-restore": service(API_DIGEST),
        "strategy-verify": service(API_DIGEST),
        "volume-initialize": service(API_DIGEST),
      } : {}),
      "rwa-automation-backup": service(API_DIGEST),
      "rwa-automation-restore": service(API_DIGEST),
      ...(environment === "real-test" ? { "rwa-automation-verify": service(API_DIGEST) } : {}),
      ...overrides,
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

function writeManifest(directory) {
  const manifestPath = join(directory, "release.json");
  const result = spawnSync(
    process.execPath,
    [
      VERIFIER,
      "write-manifest",
      manifestPath,
      REVISION,
      API_DIGEST,
      WEB_DIGEST,
      STRATEGY_DIGEST,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  return manifestPath;
}

function writeFakeDocker(directory) {
  const path = join(directory, "docker");
  const source = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const revision = ${JSON.stringify(REVISION)};
const api = ${JSON.stringify(API_DIGEST)};
const web = ${JSON.stringify(WEB_DIGEST)};
const strategy = ${JSON.stringify(STRATEGY_DIGEST)};
const label = ${JSON.stringify("org.opencontainers.image.revision")};
const log = (value) => {
  if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, value + "\\n");
};
const service = (image) => ({
  image,
  pull_policy: "never",
  environment: {
    XINGHENG_EXPECTED_REVISION: revision,
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
    XINGHENG_COMPOSE_PROJECT: "xingheng",
  },
});
if (args[0] === "docker-cli-plugin-metadata") {
  process.stdout.write(JSON.stringify({
    SchemaVersion: "0.1.0",
    Vendor: "Xingheng test fixture",
    Version: "v0.0.0",
    ShortDescription: "Docker Compose",
  }));
} else if (args[0] === "compose" || process.argv[1].endsWith("docker-compose")) {
  const command = args.find((arg) =>
    ["config", "up", "stop", "run", "exec", "ps", "logs", "down"].includes(arg));
  log("compose:" + command);
  if (command === "config") {
    process.stdout.write(JSON.stringify({
      name: "xingheng",
      services: {
        api: service(process.env.FAKE_COMPOSE_API_IMAGE || api),
        web: service(web),
        "strategy-history": service(strategy),
        "sqlite-restore": service(api),
        "provider-identity-preflight": service(api),
        "rwa-automation-backup": service(api),
        "rwa-automation-restore": service(api),
      },
    }));
  }
} else if (args[0] === "image" && args[1] === "inspect") {
  log("image:inspect");
  const requested = args[2];
  const actual = requested === api && process.env.FAKE_API_DIGEST
    ? process.env.FAKE_API_DIGEST
    : requested;
  process.stdout.write(JSON.stringify([{
    Id: actual,
    Config: { Labels: { [label]: revision } },
  }]));
} else if (args[0] === "run") {
  log("image:run");
  process.stdout.write(revision + "\\n");
} else if (args[0] === "ps") {
  log("container:ps");
  const project = args.find((arg) => arg.startsWith("label=com.docker.compose.project="))
    ?.split("=")
    .at(-1);
  if (process.env.FAKE_EXPECT_PROJECT && project !== process.env.FAKE_EXPECT_PROJECT) {
    process.stderr.write("unexpected project filter\\n");
    process.exit(2);
  }
  const service = args.find((arg) => arg.startsWith("label=com.docker.compose.service="))
    ?.split("=")
    .at(-1);
  process.stdout.write(service === "api" ? "api-id\\n" : service === "web" ? "web-id\\n" : "");
} else if (args[0] === "container" && args[1] === "inspect") {
  log("container:inspect");
  const isApi = args[2] === "api-id";
  process.stdout.write(JSON.stringify([{
    Image: isApi ? api : web,
    State: { Running: true },
    Config: {
      Labels: { [label]: revision },
      Env: ["XINGHENG_EXPECTED_REVISION=" + (process.env.FAKE_RUNTIME_REVISION || revision)],
    },
  }]));
} else if (args[0] === "exec") {
  log("container:exec");
  process.stdout.write(revision + "\\n");
} else {
  process.stderr.write("unexpected fake docker command\\n");
  process.exit(2);
}
`;
  writeFileSync(path, source, { mode: 0o755 });
  const pluginDirectory = join(directory, ".docker", "cli-plugins");
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(join(pluginDirectory, "docker-compose"), source, { mode: 0o755 });
  return path;
}

function trustedDockerFixtureEnvironment(directory) {
  const dockerCliPath = join(directory, "docker");
  const composePluginPath = join(directory, ".docker", "cli-plugins", "docker-compose");
  return {
    NODE_ENV: "test",
    XINGHENG_TEST_DOCKER_CLI_PATH: dockerCliPath,
    XINGHENG_TEST_DOCKER_CLI_SHA256: sha256File(dockerCliPath),
    XINGHENG_TEST_COMPOSE_PLUGIN_PATH: composePluginPath,
    XINGHENG_TEST_COMPOSE_PLUGIN_SHA256: sha256File(composePluginPath),
    XINGHENG_TEST_DOCKER_SOCKET_PATH: DOCKER_FIXTURE_SOCKET,
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("accepts one exact full revision across every component", () => {
  assert.equal(
    verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence(),
      requireRuntimeEvidence: true,
    }),
    REVISION,
  );
});

test("rejects missing, short, and illegal revisions", () => {
  for (const revision of [undefined, "", REVISION.slice(0, 12), `${REVISION.slice(0, 39)}G`]) {
    assert.throws(() => assertFullRevision(revision), /full lowercase Git commit/u);
  }
});

test("accepts only immutable image digests", () => {
  assert.equal(assertImageDigest(API_DIGEST), API_DIGEST);
  for (const digest of [undefined, "", "xingheng-api:latest", "sha256:abc", `sha256:${"G".repeat(64)}`]) {
    assert.throws(() => assertImageDigest(digest), /immutable sha256 digest/u);
  }
});

test("accepts only the exact release manifest schema", () => {
  const manifest = validateReleaseManifest(manifestValue());
  assert.equal(manifest.revision, REVISION);
  assert.equal(manifest.images.api, API_DIGEST);

  assert.throws(
    () => validateReleaseManifest({
      schemaVersion: 1,
      revision: REVISION,
      images: {
        api: API_DIGEST,
        web: WEB_DIGEST,
        strategyTools: STRATEGY_DIGEST,
        extra: API_DIGEST,
      },
    }),
    /manifest schema is invalid/u,
  );
  assert.throws(
    () => validateReleaseManifest({
      schemaVersion: 2,
      revision: REVISION,
      images: {
        api: API_DIGEST,
        web: WEB_DIGEST,
        strategyTools: STRATEGY_DIGEST,
      },
    }),
    /manifest schema is invalid/u,
  );
});

test("production Compose accepts only the exact manifest service mapping", () => {
  assert.equal(
    validateProductionComposeConfig(manifestValue(), composeConfig()),
    REVISION,
  );
  assert.throws(
    () => validateProductionComposeConfig(
      manifestValue(),
      composeConfig({ api: { ...composeConfig().services.api, build: { context: "." } } }),
    ),
    /release mapping is invalid/u,
  );
  assert.throws(
    () => validateProductionComposeConfig(
      manifestValue(),
      composeConfig({ web: { ...composeConfig().services.web, image: API_DIGEST } }),
    ),
    /release mapping is invalid/u,
  );
  assert.throws(
    () => validateProductionComposeConfig(
      manifestValue(),
      { ...composeConfig(), services: { ...composeConfig().services, extra: {} } },
    ),
    /topology is invalid/u,
  );
});

test("real-test Compose accepts only its fixed project and manifest mapping", () => {
  const config = composeConfig({}, {
    project: "xingheng-real-test",
    environment: "real-test",
  });
  assert.equal(validateRealTestComposeConfig(manifestValue(), config), REVISION);
  assert.throws(
    () => validateRealTestComposeConfig(manifestValue(), {
      ...config,
      name: "caller-controlled",
    }),
    /topology is invalid/u,
  );
  assert.throws(
    () => validateRealTestComposeConfig(manifestValue(), {
      ...config,
      services: {
        ...config.services,
        api: {
          ...config.services.api,
          environment: {
            ...config.services.api.environment,
            XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
          },
        },
      },
    }),
    /release mapping is invalid/u,
  );
});

test("rejects missing image labels and built-in evidence", () => {
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ api: { imageRevision: undefined } }),
    }),
    /image revision must be/u,
  );
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ web: { builtRevision: undefined } }),
    }),
    /built revision must be/u,
  );
});

test("rejects missing, malformed, and mismatched image digests", () => {
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ api: { manifestDigest: undefined } }),
    }),
    /manifest image digest must be/u,
  );
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ web: { actualDigest: "xingheng-web:latest" } }),
    }),
    /actual image digest must be/u,
  );
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ "strategy-tools": { actualDigest: API_DIGEST } }),
    }),
    /image digest mismatch/u,
  );
});

test("rejects an image or built-in revision that differs from expected", () => {
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ api: { imageRevision: OTHER_REVISION } }),
    }),
    /revision mismatch/u,
  );
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ web: { builtRevision: OTHER_REVISION } }),
    }),
    /revision mismatch/u,
  );
});

test("rejects missing and inconsistent release components", () => {
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence().filter(({ name }) => name !== "rwa-automation-restore"),
    }),
    /component is missing/u,
  );
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ "strategy-tools": { imageRevision: OTHER_REVISION } }),
    }),
    /revision mismatch/u,
  );
});

test("rejects a tampered runtime environment revision", () => {
  assert.throws(
    () => verifyRevisionEvidence({
      expectedRevision: REVISION,
      components: evidence({ api: { runtimeRevision: OTHER_REVISION } }),
      requireRuntimeEvidence: true,
    }),
    /runtime revision mismatch/u,
  );
});

test("requires one strict revision in the deployment environment", () => {
  assert.equal(parseRevisionEnv(`DOMAIN=example.test\nXINGHENG_REVISION=${REVISION}\n`), REVISION);
  assert.throws(() => parseRevisionEnv("DOMAIN=example.test\n"), /must contain one/u);
  assert.throws(
    () => parseRevisionEnv(`XINGHENG_REVISION=${REVISION}\nXINGHENG_REVISION=${REVISION}\n`),
    /must contain one/u,
  );
  assert.throws(
    () => parseRevisionEnv(`XINGHENG_REVISION=${REVISION.slice(0, 12)}\n`),
    /full lowercase Git commit/u,
  );
});

test("verification does not depend on a .git directory", () => {
  const original = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "xingheng-revision-no-git-"));
  try {
    process.chdir(directory);
    assert.equal(
      verifyRevisionEvidence({
        expectedRevision: REVISION,
        components: evidence(),
        requireRuntimeEvidence: true,
      }),
      REVISION,
    );
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the verifier CLI accepts an exact revision outside a Git checkout", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-revision-cli-no-git-"));
  try {
    const result = spawnSync(
      process.execPath,
      [VERIFIER, "validate", REVISION],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "deployment revision format valid");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the verifier writes and reads one strict read-only release manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-release-manifest-"));
  const manifestPath = join(directory, "release.json");
  try {
    const write = spawnSync(
      process.execPath,
      [
        VERIFIER,
        "write-manifest",
        manifestPath,
        REVISION,
        API_DIGEST,
        WEB_DIGEST,
        STRATEGY_DIGEST,
      ],
      { encoding: "utf8" },
    );
    assert.equal(write.status, 0);
    assert.equal(write.stdout.trim(), REVISION);
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), {
      schemaVersion: 1,
      revision: REVISION,
      images: {
        api: API_DIGEST,
        web: WEB_DIGEST,
        strategyTools: STRATEGY_DIGEST,
      },
    });

    const read = spawnSync(
      process.execPath,
      [VERIFIER, "manifest-image", manifestPath, "web"],
      { encoding: "utf8" },
    );
    assert.equal(read.status, 0);
    assert.equal(read.stdout.trim(), WEB_DIGEST);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the verifier rejects writable and symlinked release manifests", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-release-manifest-boundary-"));
  const manifestPath = join(directory, "release.json");
  const symlinkPath = join(directory, "release-link.json");
  try {
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      revision: REVISION,
      images: {
        api: API_DIGEST,
        web: WEB_DIGEST,
        strategyTools: STRATEGY_DIGEST,
      },
    })}\n`, { mode: 0o444 });
    symlinkSync(manifestPath, symlinkPath);

    const linked = spawnSync(
      process.execPath,
      [VERIFIER, "manifest-revision", symlinkPath],
      { encoding: "utf8" },
    );
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /manifest file boundary is invalid/u);

    chmodSync(manifestPath, 0o644);
    const writable = spawnSync(
      process.execPath,
      [VERIFIER, "manifest-revision", manifestPath],
      { encoding: "utf8" },
    );
    assert.notEqual(writable.status, 0);
    assert.match(writable.stderr, /manifest file boundary is invalid/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("image verification binds the manifest to the actual immutable image IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-release-images-"));
  try {
    const manifestPath = writeManifest(directory);
    writeFakeDocker(directory);
    const env = {
      ...process.env,
      ...trustedDockerFixtureEnvironment(directory),
      PATH: `${directory}:${process.env.PATH}`,
    };

    const accepted = spawnSync(
      process.execPath,
      [VERIFIER, "images", manifestPath],
      { encoding: "utf8", env },
    );
    assert.equal(accepted.status, 0);

    const rejected = spawnSync(
      process.execPath,
      [VERIFIER, "images", manifestPath],
      {
        encoding: "utf8",
        env: { ...env, FAKE_API_DIGEST: `sha256:${"4".repeat(64)}` },
      },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /image digest mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("container verification rejects a tampered runtime revision", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-release-containers-"));
  try {
    const manifestPath = writeManifest(directory);
    writeFakeDocker(directory);
    const result = spawnSync(
      process.execPath,
      [VERIFIER, "containers", manifestPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...trustedDockerFixtureEnvironment(directory),
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_RUNTIME_REVISION: OTHER_REVISION,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime revision mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real-test container verification uses only the fixed real-test project", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-real-test-containers-"));
  try {
    const manifestPath = writeManifest(directory);
    writeFakeDocker(directory);
    const result = spawnSync(
      process.execPath,
      [VERIFIER, "containers-real-test", manifestPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...trustedDockerFixtureEnvironment(directory),
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_EXPECT_PROJECT: "xingheng-real-test",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("COMPOSE_FILE overrides fail before activation or restore reaches Docker", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-compose-override-"));
  try {
    const manifestPath = writeManifest(directory);
    const envPath = join(directory, "production.env");
    const logPath = join(directory, "docker.log");
    writeFileSync(envPath, `XINGHENG_REVISION=${REVISION}\n`, { mode: 0o600 });
    writeFakeDocker(directory);
    const env = {
      ...process.env,
      ...trustedDockerFixtureEnvironment(directory),
      PATH: `${directory}:${process.env.PATH}`,
      COMPOSE_ENV_FILE: envPath,
      COMPOSE_FILE: "compose.yaml:compose.build.yaml",
      RELEASE_MANIFEST_FILE: manifestPath,
      FAKE_DOCKER_LOG: logPath,
    };

    for (const [script, args] of [
      ["scripts/activate-release.sh", [manifestPath]],
      ["scripts/backup.sh", []],
      ["scripts/restore.sh", ["trading-20260724T120000Z.sqlite"]],
    ]) {
      const result = spawnSync("sh", [script, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Compose control environment is not allowed/u);
    }
    assert.throws(() => readFileSync(logPath, "utf8"), /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compact global overrides are rejected while logs follow remains available", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-compose-global-options-"));
  try {
    const logPath = join(directory, "docker.log");
    writeFakeDocker(directory);
    const env = {
      ...process.env,
      ...trustedDockerFixtureEnvironment(directory),
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
    };

    for (const argument of ["-fcompose.build.yaml", "-pxother"]) {
      const rejected = spawnSync("sh", [PRODUCTION_COMPOSE, argument, "config"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env,
      });
      assert.equal(rejected.status, 78);
      assert.match(rejected.stderr, /topology override is not allowed/u);
    }
    assert.throws(() => readFileSync(logPath, "utf8"), /ENOENT/u);

    const fixedEnv = join(REPO_ROOT, ".env.production");
    assert.equal(existsSync(fixedEnv), false);
    writeFileSync(
      fixedEnv,
      `XINGHENG_REVISION=${REVISION}\nDOMAIN=production.fixture.invalid\n`
        + "REAL_TEST_DOMAIN=real-test.fixture.invalid\n",
      { mode: 0o600, flag: "wx" },
    );
    try {
      const accepted = spawnSync("sh", [PRODUCTION_COMPOSE, "logs", "-f", "api"], {
        cwd: directory,
        encoding: "utf8",
        env,
      });
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(readFileSync(logPath, "utf8").trim(), "compose:logs");
    } finally {
      rmSync(fixedEnv, { force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed Compose environment rejects symlink, hardlink, and permissive mode before Docker", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-compose-env-boundary-"));
  const fixedEnv = join(REPO_ROOT, ".env.production");
  const source = join(directory, "source.env");
  const logPath = join(directory, "docker.log");
  try {
    assert.equal(existsSync(fixedEnv), false);
    writeFileSync(source, `XINGHENG_REVISION=${REVISION}\n`, { mode: 0o600 });
    writeFakeDocker(directory);
    const invoke = () => spawnSync("sh", [PRODUCTION_COMPOSE, "config"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        ...trustedDockerFixtureEnvironment(directory),
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: logPath,
      },
    });

    symlinkSync(source, fixedEnv);
    assert.match(invoke().stderr, /boundary is invalid/u);
    rmSync(fixedEnv);

    linkSync(source, fixedEnv);
    assert.match(invoke().stderr, /boundary is invalid/u);
    rmSync(fixedEnv);
    rmSync(source);

    writeFileSync(fixedEnv, `XINGHENG_REVISION=${REVISION}\n`, { mode: 0o644, flag: "wx" });
    assert.match(invoke().stderr, /boundary is invalid/u);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(fixedEnv, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a post-start runtime mismatch stops the unverified release", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-compose-runtime-"));
  try {
    const manifestPath = writeManifest(directory);
    const envPath = join(REPO_ROOT, ".env.production");
    const logPath = join(directory, "docker.log");
    assert.equal(existsSync(envPath), false);
    writeFileSync(
      envPath,
      `XINGHENG_REVISION=${REVISION}\nDOMAIN=production.fixture.invalid\n`
        + "REAL_TEST_DOMAIN=real-test.fixture.invalid\n",
      { mode: 0o600, flag: "wx" },
    );
    writeFakeDocker(directory);
    const result = spawnSync("sh", ["scripts/activate-release.sh", manifestPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ...trustedDockerFixtureEnvironment(directory),
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: logPath,
        FAKE_RUNTIME_REVISION: OTHER_REVISION,
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(logPath), true, result.stderr);
    const events = readFileSync(logPath, "utf8").trim().split("\n");
    assert.ok(events.includes("compose:up"), `${result.stderr}\n${events.join(",")}`);
    assert.equal(events.at(-1), "compose:stop");
  } finally {
    rmSync(join(REPO_ROOT, ".env.production"), { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
