import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { validateDualEnvironmentTopology } from "./dualEnvironmentTopology.mjs";
import {
  validateRealTestRuntimeMounts,
  validateRealTestVolumeMountCounts,
} from "./releaseVolumeBoundaries.mjs";

const REVISION = "a".repeat(40);
const API = `sha256:${"1".repeat(64)}`;
const WEB = `sha256:${"2".repeat(64)}`;
const STRATEGY = `sha256:${"3".repeat(64)}`;
const VOLUMES = [
  "sqlite_data",
  "strategy_data",
  "sqlite_backups",
  "rwa_automation_data",
  "rwa_automation_backups",
  "rwa_automation_lock",
  "caddy_data",
  "caddy_config",
];
const DOCKER_FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "xingheng-compose-socket-"));
const DOCKER_FIXTURE_SOCKET = join(DOCKER_FIXTURE_DIRECTORY, "docker.sock");
const dockerFixtureServer = createServer();
await new Promise((resolvePromise, reject) => {
  dockerFixtureServer.once("error", reject);
  dockerFixtureServer.listen(DOCKER_FIXTURE_SOCKET, resolvePromise);
});
chmodSync(DOCKER_FIXTURE_SOCKET, 0o660);
const DOCKER_FIXTURE_EXECUTABLE = join(DOCKER_FIXTURE_DIRECTORY, "docker-compose");
copyFileSync(realpathSync(findComposePluginForTest()), DOCKER_FIXTURE_EXECUTABLE);
chmodSync(DOCKER_FIXTURE_EXECUTABLE, 0o555);
const TRUSTED_DOCKER_FIXTURE_ENVIRONMENT = Object.freeze({
  NODE_ENV: "test",
  XINGHENG_TEST_DOCKER_CLI_PATH: DOCKER_FIXTURE_EXECUTABLE,
  XINGHENG_TEST_DOCKER_CLI_SHA256: sha256(readFileSync(DOCKER_FIXTURE_EXECUTABLE)),
  XINGHENG_TEST_COMPOSE_PLUGIN_PATH: DOCKER_FIXTURE_EXECUTABLE,
  XINGHENG_TEST_COMPOSE_PLUGIN_SHA256: sha256(readFileSync(DOCKER_FIXTURE_EXECUTABLE)),
  XINGHENG_TEST_DOCKER_SOCKET_PATH: DOCKER_FIXTURE_SOCKET,
});
after(async () => {
  await new Promise((resolvePromise) => dockerFixtureServer.close(resolvePromise));
  rmSync(DOCKER_FIXTURE_DIRECTORY, { recursive: true, force: true });
});

const manifest = {
  schemaVersion: 1,
  revision: REVISION,
  images: { api: API, web: WEB, strategyTools: STRATEGY },
};

function fixture() {
  return {
    production: compose("xingheng", "production", "app.example.com", "test.example.com"),
    realTest: compose("xingheng-real-test", "real-test", "test.example.com", "test.example.com"),
  };
}

function compose(project, environment, domain, realTestDomain) {
  const service = (image, extra = {}) => ({
    image,
    pull_policy: "never",
    environment: {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_DEPLOYMENT_ENVIRONMENT: environment,
      XINGHENG_COMPOSE_PROJECT: project,
      ...extra,
    },
  });
  const wif = environment === "production"
    ? "/run/xingheng/gcp-wif"
    : "/run/xingheng-real-test/gcp-wif";
  const api = service(API, {
    DOMAIN: domain,
    REAL_TEST_DOMAIN: realTestDomain,
    XINGHENG_WIF_HOST_PATH: wif,
    RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
    RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS: environment === "production"
      ? "binance:1111111111111111"
      : "binance:2222222222222222",
    RWA_GCP_KMS_KEY_NAME: environment === "production"
      ? "projects/xingheng-production/locations/asia/keyRings/production/cryptoKeys/credentials"
      : "projects/xingheng-real-test/locations/asia/keyRings/real-test/cryptoKeys/credentials",
    RWA_GCP_WIF_AUDIENCE: environment === "production"
      ? "//iam.googleapis.com/projects/111111/locations/global/workloadIdentityPools/production/providers/vultr"
      : "//iam.googleapis.com/projects/222222/locations/global/workloadIdentityPools/real-test/providers/vultr",
  });
  api.volumes = mounts([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "sqlite_backups", "/backups", false],
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", wif, "/run/secrets/gcp-wif", true],
  ]);
  api.healthcheck = {
    test: [
      "CMD", "node", "-e",
      `cache-control ${environment} ${project} XINGHENG_EXPECTED_REVISION`,
    ],
    interval: "15s",
    timeout: "5s",
    start_period: "30s",
    retries: 5,
  };
  const web = service(WEB, {
    DOMAIN: domain,
    REAL_TEST_DOMAIN: realTestDomain,
  });
  web.volumes = mounts([
    ["volume", "caddy_data", "/data", false],
    ["volume", "caddy_config", "/config", false],
  ]);
  web.networks = {
    default: {},
    public_ingress: {
      aliases: [environment === "production" ? "production-web" : "real-test-web"],
    },
  };
  web.healthcheck = {
    test: ["CMD-SHELL", `127.0.0.1/api/health ${environment}`],
    interval: "15s",
    timeout: "5s",
    start_period: "30s",
    retries: 5,
  };
  if (environment === "production") {
    web.ports = [
      { target: 80, published: "80", protocol: "tcp" },
      { target: 443, published: "443", protocol: "tcp" },
      { target: 443, published: "443", protocol: "udp" },
    ];
  }

  const strategy = service(STRATEGY);
  strategy.volumes = mounts([
    ["volume", "strategy_data", "/app/strategy-data", false],
  ]);
  const rwaBackup = service(API);
  rwaBackup.volumes = mounts([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", true],
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", false],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", wif, "/run/secrets/gcp-wif", true],
  ]);
  const rwaRestore = service(API);
  rwaRestore.volumes = mounts([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", true],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", wif, "/run/secrets/gcp-wif", true],
  ]);
  const sqliteBackup = service(API);
  sqliteBackup.volumes = mounts([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "sqlite_backups", "/backups", false],
  ]);
  const sqliteRestore = service(API);
  sqliteRestore.volumes = mounts([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "sqlite_backups", "/backups", true],
  ]);
  const sqliteVerify = service(API);
  sqliteVerify.volumes = mounts([
    ["volume", "sqlite_backups", "/backups", true],
  ]);
  const strategyBackup = service(API);
  strategyBackup.volumes = mounts([
    ["volume", "strategy_data", "/app/strategy-data", true],
    ["volume", "sqlite_backups", "/backups", false],
  ]);
  const strategyRestore = service(API);
  strategyRestore.volumes = mounts([
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "sqlite_backups", "/backups", true],
  ]);
  const strategyVerify = service(API);
  strategyVerify.volumes = mounts([
    ["volume", "sqlite_backups", "/backups", true],
  ]);
  const volumeInitialize = service(API);
  volumeInitialize.volumes = mounts([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
  ]);
  const rwaVerify = service(API);
  rwaVerify.volumes = mounts([
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", true],
    ["bind", wif, "/run/secrets/gcp-wif", true],
  ]);
  const providerIdentityPreflight = service(API);
  providerIdentityPreflight.environment = {
    ...providerIdentityPreflight.environment,
    RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
    RWA_GCP_KMS_KEY_NAME: api.environment.RWA_GCP_KMS_KEY_NAME,
    RWA_GCP_WIF_AUDIENCE: api.environment.RWA_GCP_WIF_AUDIENCE,
  };
  providerIdentityPreflight.volumes = mounts([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", true],
    ["bind", wif, "/run/secrets/gcp-wif", true],
  ]);
  providerIdentityPreflight.command = [
    "node",
    "dist-server/operations/rwa-provider-identity-preflight.js",
  ];
  providerIdentityPreflight.read_only = true;
  providerIdentityPreflight.cap_drop = ["ALL"];
  providerIdentityPreflight.security_opt = ["no-new-privileges:true"];
  return {
    name: project,
    services: {
      api,
      web,
      "strategy-history": strategy,
      "sqlite-restore": sqliteRestore,
      "provider-identity-preflight": providerIdentityPreflight,
      ...(environment === "real-test" ? {
        "sqlite-backup": sqliteBackup,
        "sqlite-verify": sqliteVerify,
        "strategy-backup": strategyBackup,
        "strategy-restore": strategyRestore,
        "strategy-verify": strategyVerify,
        "volume-initialize": volumeInitialize,
        "rwa-automation-verify": rwaVerify,
      } : {}),
      "rwa-automation-backup": rwaBackup,
      "rwa-automation-restore": rwaRestore,
    },
    volumes: Object.fromEntries(VOLUMES.map((name) => [
      name,
      { name: `${project}_${name}` },
    ])),
    networks: {
      default: { name: `${project}_default` },
      public_ingress: { name: "xingheng-public-ingress" },
    },
  };
}

function mounts(values) {
  return values.map(([type, source, target, readOnly]) => ({
    type,
    source,
    target,
    ...(readOnly ? { read_only: true } : {}),
    ...(type === "bind" ? { bind: { create_host_path: false } } : { volume: {} }),
  }));
}

test("accepts the fixed simultaneous production and real-test topology", () => {
  const value = fixture();
  assert.equal(
    validateDualEnvironmentTopology(manifest, value.production, value.realTest),
    true,
  );
});

test("rejects domain, WIF, volume, network, identity, and provider fingerprint crossings", () => {
  const mutations = [
    (value) => {
      value.realTest.services.web.environment.REAL_TEST_DOMAIN = "app.example.com";
      value.realTest.services.api.environment.DOMAIN = "app.example.com";
      value.realTest.services.api.environment.REAL_TEST_DOMAIN = "app.example.com";
    },
    (value) => {
      value.realTest.services.api.volumes[0].source = "/run/xingheng/gcp-wif";
      value.realTest.services.api.environment.XINGHENG_WIF_HOST_PATH = "/run/xingheng/gcp-wif";
    },
    (value) => {
      value.realTest.volumes.sqlite_data.name = "xingheng_sqlite_data";
    },
    (value) => {
      value.realTest.services.web.networks.public_ingress.aliases = ["production-web"];
    },
    (value) => {
      value.realTest.services.api.environment.XINGHENG_DEPLOYMENT_ENVIRONMENT = "production";
    },
    (value) => {
      value.realTest.services.api.environment.RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS =
        "binance:1111111111111111";
    },
    (value) => {
      value.realTest.services.web.ports = [{ target: 443, published: "8443" }];
    },
    (value) => {
      value.realTest.services.api.environment.RWA_AUTOMATION_SERVER_KILL_SWITCH = "false";
    },
    (value) => {
      value.realTest.services.api.environment.RWA_GCP_KMS_KEY_NAME =
        value.production.services.api.environment.RWA_GCP_KMS_KEY_NAME;
    },
    (value) => {
      value.realTest.services.api.environment.RWA_GCP_WIF_AUDIENCE =
        value.production.services.api.environment.RWA_GCP_WIF_AUDIENCE;
    },
    (value) => {
      value.production.services.web.healthcheck.test = ["CMD-SHELL", "true production"];
    },
    (value) => {
      value.production.services.web.ports = [{ target: 443, published: "443" }];
    },
    (value) => {
      value.realTest.services["provider-identity-preflight"].environment.RWA_GCP_KMS_KEY_NAME =
        value.production.services.api.environment.RWA_GCP_KMS_KEY_NAME;
    },
    (value) => {
      value.realTest.services["provider-identity-preflight"].command =
        ["node", "dist-server/index.js"];
    },
    (value) => {
      value.realTest.services["provider-identity-preflight"].read_only = false;
    },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validateDualEnvironmentTopology(manifest, value.production, value.realTest),
    );
  }
});

test("real-test live mount names and counts are fixed independently from production", () => {
  assert.equal(validateRealTestVolumeMountCounts("runtime", {
    "xingheng-real-test_sqlite_data": 1,
    "xingheng-real-test_strategy_data": 1,
    "xingheng-real-test_sqlite_backups": 1,
    "xingheng-real-test_rwa_automation_data": 1,
    "xingheng-real-test_rwa_automation_backups": 0,
    "xingheng-real-test_rwa_automation_lock": 1,
    "xingheng-real-test_caddy_data": 1,
    "xingheng-real-test_caddy_config": 1,
  }), true);
  assert.equal(validateRealTestRuntimeMounts({
    api: [
      runtimeVolume("xingheng-real-test_sqlite_data", "/app/data"),
      runtimeVolume("xingheng-real-test_strategy_data", "/app/strategy-data"),
      runtimeVolume("xingheng-real-test_sqlite_backups", "/backups"),
      runtimeVolume("xingheng-real-test_rwa_automation_data", "/app/rwa-automation-data"),
      runtimeVolume("xingheng-real-test_rwa_automation_lock", "/app/rwa-automation-lock"),
      {
        type: "bind",
        name: "",
        source: "/run/xingheng-real-test/gcp-wif",
        destination: "/run/secrets/gcp-wif",
        rw: false,
      },
    ],
    web: [
      runtimeVolume("xingheng-real-test_caddy_data", "/data"),
      runtimeVolume("xingheng-real-test_caddy_config", "/config"),
    ],
  }), true);
  assert.throws(
    () => validateRealTestVolumeMountCounts("runtime", {
      "xingheng_sqlite_data": 1,
    }),
    /schema is invalid/u,
  );
});

test("Compose wrappers reject env overrides and never resolve a caller-cwd env file", () => {
  const production = new URL("./production-compose.sh", import.meta.url).pathname;
  const realTest = new URL("./real-test-compose.sh", import.meta.url).pathname;
  for (const wrapper of [production, realTest]) {
    const cliOverride = spawnSync("sh", [wrapper, "--env-file", "/tmp/crossed.env", "config"], {
      encoding: "utf8",
      env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
    });
    assert.equal(cliOverride.status, 78);
    assert.match(cliOverride.stderr, /env file override is not allowed/u);

    const ambient = spawnSync("sh", [wrapper, "config"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT,
        COMPOSE_ENV_FILE: "/tmp/crossed.env",
      },
    });
    assert.equal(ambient.status, 78);
    assert.match(ambient.stderr, /control environment is not allowed/u);

    for (const key of [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
      "DOCKER_API_VERSION",
    ]) {
      const dockerOverride = spawnSync("sh", [wrapper, "config"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT,
          [key]: "/tmp/caller-controlled",
        },
      });
      assert.notEqual(dockerOverride.status, 0);
      assert.match(dockerOverride.stderr, /Docker (?:and Compose )?control environment is not allowed/u);
    }

    for (const [key, value] of [
      ["NODE_OPTIONS", "--require=/tmp/caller-loader.cjs"],
      ["NODE_PATH", "/tmp/caller-node-path"],
      ["LD_PRELOAD", "/tmp/caller-preload.so"],
      ["BASH_ENV", "/tmp/caller-bash-env"],
      ["ENV", "/tmp/caller-sh-env"],
      ["XDG_CONFIG_HOME", "/tmp/caller-xdg"],
    ]) {
      const loaderOverride = spawnSync("sh", [wrapper, "config"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT,
          [key]: value,
        },
      });
      assert.notEqual(loaderOverride.status, 0, key);
      assert.match(loaderOverride.stderr, /control environment is not allowed/u);
    }
  }

  const directory = mkdtempSync(join(tmpdir(), "xingheng-crossed-compose-cwd-"));
  try {
    writeFileSync(join(directory, ".env.real-test"), `${"XINGHENG_REVISION="}${REVISION}\n`, {
      mode: 0o600,
    });
    const fromCallerCwd = spawnSync("sh", [realTest, "config"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
    });
    assert.notEqual(fromCallerCwd.status, 0);
    assert.match(fromCallerCwd.stderr, /Compose environment file|ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Compose wrappers reject every caller-expanded lifecycle or write operation", () => {
  const production = new URL("./production-compose.sh", import.meta.url).pathname;
  const realTest = new URL("./real-test-compose.sh", import.meta.url).pathname;
  const cases = [
    [production, ["run", "-v", "xingheng_sqlite_data:/x", "api"]],
    [production, ["run", "--network", "xingheng-real-test_default", "api"]],
    [production, ["run", "--env", "SECRET=x", "api"]],
    [production, ["run", "--user", "0", "--privileged", "api"]],
    [production, ["exec", "api", "sh", "-c", "touch /app/data/x"]],
    [production, ["down", "-v"]],
    [production, ["up", "-d", "--scale", "api=2", "api"]],
    [production, ["up", "-d", "--build", "api"]],
    [production, ["up", "-d", "--pull", "always", "api"]],
    [realTest, ["down", "-v"]],
    [realTest, ["run", "--entrypoint", "sh", "api"]],
    [realTest, ["exec", "api", "rm", "-rf", "/app/data"]],
  ];
  for (const [wrapper, args] of cases) {
    const result = spawnSync("sh", [wrapper, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
    });
    assert.notEqual(result.status, 0, `${wrapper} ${args.join(" ")}`);
    assert.match(result.stderr, /operation is not allowed|topology override is not allowed/u);
  }
});

test("real Docker Compose config keeps fixed production and real-test env files crossed out", (t) => {
  const available = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("Docker Compose is unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "xingheng-real-compose-config-"));
  const scripts = join(directory, "scripts");
  try {
    mkdirSync(scripts);
    for (const file of [
      "production-compose.sh",
      "real-test-compose.sh",
      "operationLocks.mjs",
      "trustedDockerRuntime.mjs",
      "trustedReleaseCandidate.mjs",
      "trustedReleaseTree.mjs",
      "verify-compose-environment-file.mjs",
    ]) {
      copyFileSync(new URL(file, import.meta.url), join(scripts, file));
    }
    copyFileSync(new URL("../compose.yaml", import.meta.url), join(directory, "compose.yaml"));
    copyFileSync(new URL("../compose.real-test.yaml", import.meta.url), join(directory, "compose.real-test.yaml"));
    const common = [
      `XINGHENG_REVISION=${REVISION}`,
      `XINGHENG_API_IMAGE=${API}`,
      `XINGHENG_WEB_IMAGE=${WEB}`,
      `XINGHENG_STRATEGY_TOOLS_IMAGE=${STRATEGY}`,
      "RWA_AUTOMATION_BACKUP_RETENTION_DAYS=30",
      "RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES=1073741824",
      "RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES=104857600",
      "RWA_GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v",
    ];
    writeFileSync(join(directory, ".env.production"), [
      ...common,
      "DOMAIN=production.fixture.invalid",
      "REAL_TEST_DOMAIN=real-test.fixture.invalid",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(directory, ".env.real-test"), [
      ...common,
      "REAL_TEST_DOMAIN=real-test.fixture.invalid",
      "RWA_GCP_KMS_KEY_NAME=projects/test/locations/global/keyRings/test/cryptoKeys/test",
    ].join("\n"), { mode: 0o600 });

    const callerCwd = mkdtempSync(join(tmpdir(), "xingheng-compose-caller-"));
    try {
      const production = spawnSync("sh", [
        join(scripts, "production-compose.sh"), "config", "--format", "json",
      ], {
        cwd: callerCwd,
        encoding: "utf8",
        env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
      });
      const realTest = spawnSync("sh", [
        join(scripts, "real-test-compose.sh"), "config", "--format", "json",
      ], {
        cwd: callerCwd,
        encoding: "utf8",
        env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
      });
      assert.equal(production.status, 0, production.stderr);
      assert.equal(realTest.status, 0, realTest.stderr);
      const productionConfig = JSON.parse(production.stdout);
      const realTestConfig = JSON.parse(realTest.stdout);
      assert.equal(productionConfig.name, "xingheng");
      assert.equal(realTestConfig.name, "xingheng-real-test");
      assert.equal(productionConfig.services.api.environment.DOMAIN, "production.fixture.invalid");
      assert.equal(realTestConfig.services.api.environment.DOMAIN, "real-test.fixture.invalid");
      assert.equal(
        productionConfig.services.api.environment.RWA_GCP_WIF_AUDIENCE,
        "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v",
      );
      assert.equal(
        realTestConfig.services.api.environment.RWA_GCP_KMS_KEY_NAME,
        "projects/test/locations/global/keyRings/test/cryptoKeys/test",
      );
      assertComposeEnvironmentReceipt(production.stderr, "production");
      assertComposeEnvironmentReceipt(realTest.stderr, "real-test");
      assert.notEqual(
        productionConfig.services.api.environment.DOMAIN,
        realTestConfig.services.api.environment.DOMAIN,
      );

      const productionPath = join(directory, ".env.production");
      const realTestBytes = readFileSync(join(directory, ".env.real-test"));
      const productionBytes = readFileSync(productionPath);
      writeFileSync(productionPath, realTestBytes, { mode: 0o600 });
      const crossed = spawnSync("sh", [
        join(scripts, "production-compose.sh"), "config", "--format", "json",
      ], {
        cwd: callerCwd,
        encoding: "utf8",
        env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
      });
      assert.notEqual(crossed.status, 0);
      assert.match(crossed.stderr, /Production Compose environment file is missing DOMAIN/u);

      const alternateBytes = Buffer.from(
        productionBytes.toString("utf8").replace(
          "DOMAIN=production.fixture.invalid",
          "DOMAIN=production-replaced.fixture.invalid",
        ),
      );
      writeFileSync(productionPath, productionBytes, { mode: 0o600 });
      const expectedDomains = new Map([
        [sha256(productionBytes), "production.fixture.invalid"],
        [sha256(alternateBytes), "production-replaced.fixture.invalid"],
      ]);
      const swapper = spawn(process.execPath, [
        "-e",
        [
          "const fs=require('node:fs');",
          "const [target,a,b]=process.argv.slice(1);",
          "let turn=0;",
          "const replace=()=>{",
          " const temp=`${target}.${process.pid}`;",
          " fs.writeFileSync(temp,Buffer.from(turn++%2?a:b,'base64'),{mode:0o600});",
          " fs.renameSync(temp,target);",
          " setTimeout(replace,50);",
          "};",
          "replace();",
        ].join(""),
        productionPath,
        productionBytes.toString("base64"),
        alternateBytes.toString("base64"),
      ], { stdio: "ignore" });
      let successfulRaces = 0;
      let firstRaceFailure = "";
      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const raced = spawnSync("sh", [
            join(scripts, "production-compose.sh"), "config", "--format", "json",
          ], {
            cwd: callerCwd,
            encoding: "utf8",
            env: { ...process.env, ...TRUSTED_DOCKER_FIXTURE_ENVIRONMENT },
          });
          if (raced.status !== 0) {
            if (firstRaceFailure === "") firstRaceFailure = raced.stderr;
            assert.match(
              raced.stderr,
              /boundary is invalid|do not identify the same file object|changed while/u,
            );
            continue;
          }
          successfulRaces += 1;
          const receipt = assertComposeEnvironmentReceipt(raced.stderr, "production");
          const config = JSON.parse(raced.stdout);
          assert.equal(
            config.services.api.environment.DOMAIN,
            expectedDomains.get(receipt.sha256),
            "Compose output must come from the exact inode bytes named by its receipt",
          );
        }
      } finally {
        swapper.kill("SIGKILL");
      }
      assert.ok(
        successfulRaces > 0,
        `at least one atomic-replacement race must reach Compose\n${firstRaceFailure}`,
      );

      const closedDescriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
      const closedDescriptor = spawnSync(DOCKER_FIXTURE_EXECUTABLE, [
        "--env-file", `${closedDescriptorRoot}/3`,
        "-f", join(directory, "compose.yaml"),
        "-p", "xingheng",
        "config",
      ], {
        encoding: "utf8",
        env: {
          XINGHENG_COMPOSE_ENV_FD: `${closedDescriptorRoot}/4`,
        },
      });
      assert.notEqual(closedDescriptor.status, 0);
    } finally {
      rmSync(callerCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runtimeVolume(name, destination) {
  return { type: "volume", name, source: "", destination, rw: true };
}

function assertComposeEnvironmentReceipt(stderr, environment) {
  const pattern = new RegExp(
    `compose-env-receipt phase=(validated|consumed) environment=${environment}`
    + " interpolationFd=3 serviceFd=4"
    + " dev=([0-9]+) ino=([0-9]+) size=([0-9]+) sha256=([0-9a-f]{64})",
    "gu",
  );
  const receipts = [...stderr.matchAll(pattern)].map((match) => ({
    phase: match[1],
    dev: match[2],
    ino: match[3],
    size: match[4],
    sha256: match[5],
  }));
  assert.equal(receipts.length, 2, stderr);
  assert.deepEqual(
    receipts.map(({ phase: _phase, ...receipt }) => receipt),
    [receipts[0], receipts[0]].map(({ phase: _phase, ...receipt }) => receipt),
  );
  assert.deepEqual(receipts.map((receipt) => receipt.phase), ["validated", "consumed"]);
  return receipts[0];
}

function findComposePluginForTest() {
  for (const candidate of [
    "/usr/local/lib/docker/cli-plugins/docker-compose",
    "/usr/local/libexec/docker/cli-plugins/docker-compose",
    "/usr/lib/docker/cli-plugins/docker-compose",
    "/usr/libexec/docker/cli-plugins/docker-compose",
    "/usr/local/bin/docker-compose",
    "/usr/bin/docker-compose",
    "/opt/homebrew/bin/docker-compose",
  ]) {
    const probe = spawnSync(candidate, ["docker-cli-plugin-metadata"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Docker Compose plugin disappeared during the fixture");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
