import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";

const ENABLED = process.platform === "linux"
  && process.getuid?.() === 0
  && process.env.XINGHENG_LINUX_TRUST_FIXTURE === "1";
const ROOT = "/opt/xingheng-release/code";
const PRODUCTION_WRAPPER = `${ROOT}/scripts/production-compose.sh`;
const PRODUCTION_ENV = `${ROOT}/.env.production`;
const COMPOSE_PLUGIN = "/usr/libexec/docker/cli-plugins/docker-compose";
const FROZEN_LOADER = `${ROOT}/scripts/load-release-manifest.sh`;
const PERMIT_INSTALLER = `${ROOT}/scripts/productionSelfTestPermitInstall.mjs`;
const PERMIT_RECOVERY = `${ROOT}/scripts/productionSelfTestPermitRecovery.mjs`;
const REVISION = "03bdbb354f225ae0a0999a355df1e70784d7d163";
const FIXED_ENVIRONMENT = Object.freeze({
  HOME: "/root",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  XINGHENG_REVISION: REVISION,
  XINGHENG_API_IMAGE: `sha256:${"1".repeat(64)}`,
  XINGHENG_WEB_IMAGE: `sha256:${"2".repeat(64)}`,
  XINGHENG_STRATEGY_TOOLS_IMAGE: `sha256:${"3".repeat(64)}`,
});

test("trusted Linux root launcher consumes Compose and environment descriptors", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
  timeout: 30_000,
}, () => {
  for (const wrapper of [PRODUCTION_WRAPPER]) {
    const result = invoke(wrapper);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /trusted-docker-receipt phase=validated/u);
    assert.match(result.stderr, /compose-env-receipt phase=validated/u);
    assert.match(result.stderr, /compose-env-receipt phase=consumed/u);
    assert.match(result.stderr, /interpolationFd=3 serviceFd=4/u);
    assert.match(result.stderr, /kind=compose/u);
  }
});

test("trusted Linux root launcher rejects polluted process controls before Compose", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
}, () => {
  for (const [key, value] of [
    ["HOME", "/tmp/caller-home"],
    ["PATH", "/tmp/caller-path"],
    ["NODE_ENV", "test"],
    ["NODE_OPTIONS", "--require=/tmp/caller.cjs"],
    ["NODE_PATH", "/tmp/caller-node-path"],
    ["LD_PRELOAD", "/tmp/caller.so"],
    ["DYLD_INSERT_LIBRARIES", "/tmp/caller.dylib"],
    ["BASH_ENV", "/tmp/caller-bash-env"],
    ["ENV", "/tmp/caller-env"],
    ["XDG_CONFIG_HOME", "/tmp/caller-xdg"],
    ["DOCKER_HOST", "tcp://127.0.0.1:2375"],
    ["DOCKER_CONTEXT", "caller-context"],
    ["DOCKER_CONFIG", "/tmp/caller-docker"],
    ["DOCKER_TLS_VERIFY", "1"],
    ["DOCKER_CERT_PATH", "/tmp/caller-certs"],
    ["COMPOSE_FILE", "/tmp/caller-compose.yaml"],
    ["COMPOSE_PROJECT_NAME", "caller-project"],
    ["XINGHENG_TEST_DOCKER_CLI_PATH", "/tmp/caller-docker"],
  ]) {
    const result = invoke(PRODUCTION_WRAPPER, { [key]: value });
    assert.notEqual(result.status, 0, key);
    assert.doesNotMatch(result.stderr, /compose-env-receipt phase=validated/u, key);
  }
});

test("actual Linux Compose output stays bound to the environment inode receipt under replacement", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
  timeout: 60_000,
}, async () => {
  const original = readFileSync(PRODUCTION_ENV);
  const originalText = original.toString("utf8");
  const domainMatch = /^DOMAIN=(.+)$/mu.exec(originalText);
  assert.ok(domainMatch);
  const alternateDomain = "descriptor-replacement.fixture.invalid";
  const alternate = Buffer.from(
    originalText.replace(/^DOMAIN=.+$/mu, `DOMAIN=${alternateDomain}`),
  );
  const expected = new Map([
    [sha256(original), domainMatch[1]],
    [sha256(alternate), alternateDomain],
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
      " setTimeout(replace,5);",
      "};replace();",
    ].join(""),
    PRODUCTION_ENV,
    original.toString("base64"),
    alternate.toString("base64"),
  ], { stdio: "ignore" });
  let successes = 0;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = invoke(PRODUCTION_WRAPPER);
      if (result.status !== 0) {
        assert.match(
          result.stderr,
          /boundary is invalid|same file object|changed while/u,
        );
        continue;
      }
      successes += 1;
      const receipt = /compose-env-receipt phase=validated[^\n]+sha256=([a-f0-9]{64})/u
        .exec(result.stderr);
      assert.ok(receipt);
      const config = JSON.parse(result.stdout);
      assert.equal(config.services.api.environment.DOMAIN, expected.get(receipt[1]));
    }
  } finally {
    swapper.kill("SIGKILL");
    const pending = `${PRODUCTION_ENV}.${process.pid}`;
    writeFileSync(pending, original, { mode: 0o600 });
    renameSync(pending, PRODUCTION_ENV);
    chmodSync(PRODUCTION_ENV, 0o600);
  }
  assert.ok(successes > 0);
});

test("trusted Linux Compose plugin rejects mutable, linked, and digest-drifted objects", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
  timeout: 30_000,
}, () => {
  const original = readFileSync(COMPOSE_PLUGIN);
  const parked = `${COMPOSE_PLUGIN}.fixture-original`;
  try {
    chmodSync(COMPOSE_PLUGIN, 0o775);
    assertRejectedBeforeEnvironmentReceipt();
    chmodSync(COMPOSE_PLUGIN, 0o555);

    renameSync(COMPOSE_PLUGIN, parked);
    symlinkSync(parked, COMPOSE_PLUGIN);
    assertRejectedBeforeEnvironmentReceipt();
    unlinkSync(COMPOSE_PLUGIN);
    renameSync(parked, COMPOSE_PLUGIN);

    linkSync(COMPOSE_PLUGIN, parked);
    assertRejectedBeforeEnvironmentReceipt();
    unlinkSync(parked);

    renameSync(COMPOSE_PLUGIN, parked);
    writeFileSync(COMPOSE_PLUGIN, Buffer.from("#!/bin/sh\nexit 1\n"), { mode: 0o555 });
    assertRejectedBeforeEnvironmentReceipt();
    unlinkSync(COMPOSE_PLUGIN);
    renameSync(parked, COMPOSE_PLUGIN);
  } finally {
    unlinkIfExists(COMPOSE_PLUGIN);
    unlinkIfExists(parked);
    writeFileSync(COMPOSE_PLUGIN, original, { mode: 0o555 });
    chmodSync(COMPOSE_PLUGIN, 0o555);
  }
});

test("trusted release tree rejects sourced script drift before the environment handoff", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
  timeout: 30_000,
}, () => {
  const original = readFileSync(FROZEN_LOADER);
  try {
    writeFileSync(
      FROZEN_LOADER,
      Buffer.concat([original, Buffer.from("\n# fixture drift\n")]),
    );
    const result = invoke(PRODUCTION_WRAPPER);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /trusted release tree identity mismatch/u);
    assert.doesNotMatch(result.stderr, /compose-env-receipt phase=validated/u);
  } finally {
    writeFileSync(FROZEN_LOADER, original);
    chmodSync(FROZEN_LOADER, 0o755);
    reinstallTrustReceipt();
  }
});

test("Permit mutating Node entry rejects direct and forged wrapper contexts", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
}, () => {
  const operationId = "a".repeat(32);
  const direct = spawnSync("/usr/bin/node", [PERMIT_INSTALLER, "prepare", operationId], {
    cwd: ROOT,
    input: "{}",
    encoding: "utf8",
    env: FIXED_ENVIRONMENT,
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /trusted wrapper context/u);

  const forged = spawnSync("/usr/bin/node", [PERMIT_INSTALLER, "prepare", operationId], {
    cwd: ROOT,
    input: "{}",
    encoding: "utf8",
    env: {
      ...FIXED_ENVIRONMENT,
      XINGHENG_OPERATION_LOCK_CONTEXT: "production",
      XINGHENG_TRUSTED_OPERATION_ENTRY: "install-production-self-test-permit.sh",
      XINGHENG_PERMIT_INSTALL_OPERATION_ID: operationId,
    },
  });
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /operation lock|wrapper descriptor|EBADF|bad file descriptor/iu);
});

test("Permit recovery entry rejects direct and forged wrapper contexts", {
  skip: !ENABLED && "requires the explicit isolated Linux trust fixture",
}, () => {
  const operationId = "b".repeat(32);
  const sourceSha256 = "c".repeat(64);
  const direct = spawnSync("/usr/bin/node", [
    PERMIT_RECOVERY, "run", operationId, sourceSha256,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: FIXED_ENVIRONMENT,
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /controlled Linux root|trusted wrapper context/u);

  const forged = spawnSync("/usr/bin/node", [
    PERMIT_RECOVERY, "run", operationId, sourceSha256,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...FIXED_ENVIRONMENT,
      XINGHENG_OPERATION_LOCK_CONTEXT: "production",
      XINGHENG_TRUSTED_OPERATION_ENTRY: "recover-production-self-test-permit.sh",
      XINGHENG_PERMIT_RECOVERY_OPERATION_ID: operationId,
    },
  });
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /operation lock|trusted descriptor|EBADF|bad file descriptor/iu);
});

function invoke(wrapper, additions = {}) {
  return spawnSync(wrapper, ["config", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...FIXED_ENVIRONMENT, ...additions },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRejectedBeforeEnvironmentReceipt() {
  const result = invoke(PRODUCTION_WRAPPER);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /compose-env-receipt phase=validated/u);
}

function reinstallTrustReceipt() {
  const result = spawnSync(
    "/usr/bin/node",
    [`${ROOT}/scripts/install-trusted-operations.mjs`, "install"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        HOME: "/root",
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function unlinkIfExists(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
