import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  openRealTestRuntimeComposeCapability,
  runRealTestRuntimeOperation,
} from "./realTestRuntimeOperation.mjs";
import {
  normalizeInstalledRealTestCompose,
} from "./realTestComposeInstallBoundary.mjs";
import { validateRealTestRuntimeDockerArguments } from "./trustedDockerRuntime.mjs";

const REVISION = "a".repeat(40);
const CAPABILITY_ROOT = mkdtempSync(join(tmpdir(), "xingheng-runtime-capability-"));
const CAPABILITY_SOCKET = join(CAPABILITY_ROOT, "docker.sock");
const CAPABILITY_EXECUTABLE = join(CAPABILITY_ROOT, "docker-compose");
const CAPABILITY_LOG = join(CAPABILITY_ROOT, "compose.log");
const capabilityServer = createServer();
await new Promise((resolvePromise, reject) => {
  capabilityServer.once("error", reject);
  capabilityServer.listen(CAPABILITY_SOCKET, resolvePromise);
});
chmodSync(CAPABILITY_SOCKET, 0o660);
writeFileSync(
  CAPABILITY_EXECUTABLE,
  `#!/bin/sh\nprintf '%s\\n' "$*" >> "${CAPABILITY_LOG}"\n`
    + "case \"$*\" in *\" up -d api\") "
    + "if [ -n \"$FAKE_REPLACE_PATH\" ]; then "
    + "mv \"$FAKE_REPLACEMENT_PATH\" \"$FAKE_REPLACE_PATH\"; fi;; "
    + "*\" stop api\") if [ \"$FAKE_MUTATE_STOP_FD\" = \"true\" ]; then "
    + "chmod 600 /dev/fd/3; chmod 400 /dev/fd/3; fi;; esac\n",
  { mode: 0o555 },
);
after(async () => {
  await new Promise((resolvePromise) => capabilityServer.close(resolvePromise));
  rmSync(CAPABILITY_ROOT, { recursive: true, force: true });
});

test("KMS PASS runs exactly once before one API up and no retry", () => {
  withRuntimeContext(() => {
    const calls = [];
    let image = 0;
    let api = 0;
    runRealTestRuntimeOperation("activate", "/candidate/code", {
      readContext: () => context(),
      assertContext: () => {},
      inspectImage: () => { image += 1; },
      inspectApi: () => { api += 1; return "healthy"; },
      compose: (args) => calls.push([...args]),
    });
    assert.equal(image, 1);
    assert.equal(api, 1);
    assert.deepEqual(calls, [
      ["--profile", "kms-health-preflight", "run", "--rm", "--no-deps", "kms-health-preflight"],
      ["up", "-d", "api"],
    ]);
  });
});

test("KMS failure starts no API and stops only exact project API", () => {
  withRuntimeContext(() => {
    const calls = [];
    assert.throws(
      () => runRealTestRuntimeOperation("activate", "/candidate/code", {
        readContext: () => context(),
        assertContext: () => {},
        inspectImage: () => {},
        inspectApi: () => assert.fail("API inspection is forbidden"),
        compose: (args) => {
          calls.push([...args]);
          if (args[0] === "--profile") throw new Error("kms fail");
        },
      }),
      /kms fail/u,
    );
    assert.deepEqual(calls, [
      ["--profile", "kms-health-preflight", "run", "--rm", "--no-deps", "kms-health-preflight"],
      ["stop", "api"],
    ]);
  });
});

test("unknown API is stopped with no repeated KMS/up", () => {
  withRuntimeContext(() => {
    const calls = [];
    assert.throws(
      () => runRealTestRuntimeOperation("activate", "/candidate/code", {
        readContext: () => context(),
        assertContext: () => {},
        inspectImage: () => {},
        inspectApi: () => { throw new Error("unknown API"); },
        compose: (args) => calls.push([...args]),
      }),
      /unknown API/u,
    );
    assert.deepEqual(calls, [
      ["--profile", "kms-health-preflight", "run", "--rm", "--no-deps", "kms-health-preflight"],
      ["up", "-d", "api"],
      ["stop", "api"],
    ]);
  });
});

test("a failed risk-reducing stop is not retried or exposed over the original failure", () => {
  withRuntimeContext(() => {
    const calls = [];
    assert.throws(
      () => runRealTestRuntimeOperation("activate", "/candidate/code", {
        readContext: () => context(),
        assertContext: () => {},
        inspectImage: () => {},
        inspectApi: () => { throw new Error("stable manual category"); },
        compose: (args) => {
          calls.push([...args]);
          if (args[0] === "stop") throw new Error("stop transport detail");
        },
      }),
      /stable manual category/u,
    );
    assert.deepEqual(calls.map((args) => args[0]), ["--profile", "up", "stop"]);
  });
});

test("identity failure performs zero Compose and stop never deletes state", () => {
  withRuntimeContext(() => {
    const calls = [];
    assert.throws(
      () => runRealTestRuntimeOperation("activate", "/candidate/code", {
        readContext: () => context(),
        assertContext: () => {},
        inspectImage: () => { throw new Error("identity failure"); },
        compose: (args) => calls.push([...args]),
      }),
      /identity failure/u,
    );
    assert.deepEqual(calls, []);
    runRealTestRuntimeOperation("stop", "/candidate/code", {
      readContext: () => context(),
      assertContext: () => {},
      inspectImage: () => {},
      compose: (args) => calls.push([...args]),
    });
    assert.deepEqual(calls, [["stop", "api"]]);
  });
});

test("starting becomes healthy with one KMS, one up and no stop", () => {
  withRuntimeContext(() => {
    const calls = [];
    const health = ["starting", "starting", "healthy"];
    let waits = 0;
    runRealTestRuntimeOperation("activate", "/candidate/code", {
      readContext: () => context(),
      assertContext: () => {},
      inspectImage: () => {},
      inspectApi: () => health.shift(),
      compose: (args) => calls.push([...args]),
      healthAttempts: 3,
      healthPollIntervalMs: 1,
      wait: () => { waits += 1; },
    });
    assert.equal(waits, 2);
    assert.deepEqual(calls.map((args) => args[0]), ["--profile", "up"]);
  });
});

test("starting timeout and unhealthy each stop once without mutation retry", () => {
  withRuntimeContext(() => {
    for (const statuses of [
      ["starting", "starting", "starting"],
      ["starting", "unhealthy"],
    ]) {
      const calls = [];
      assert.throws(
        () => runRealTestRuntimeOperation("activate", "/candidate/code", {
          readContext: () => context(),
          assertContext: () => {},
          inspectImage: () => {},
          inspectApi: () => statuses.shift(),
          compose: (args) => calls.push([...args]),
          healthAttempts: 3,
          healthPollIntervalMs: 1,
          wait: () => {},
        }),
        /starting timeout|health status is invalid/u,
      );
      assert.deepEqual(calls.map((args) => args[0]), ["--profile", "up", "stop"]);
    }
  });
});

test("identity mismatch and query error stop immediately without further polling", () => {
  withRuntimeContext(() => {
    for (const message of ["identity mismatch", "query error"]) {
      const calls = [];
      let inspections = 0;
      let waits = 0;
      assert.throws(
        () => runRealTestRuntimeOperation("activate", "/candidate/code", {
          readContext: () => context(),
          assertContext: () => {},
          inspectImage: () => {},
          inspectApi: () => {
            inspections += 1;
            throw new Error(message);
          },
          compose: (args) => calls.push([...args]),
          wait: () => { waits += 1; },
        }),
        new RegExp(message, "u"),
      );
      assert.equal(inspections, 1);
      assert.equal(waits, 0);
      assert.deepEqual(calls.map((args) => args[0]), ["--profile", "up", "stop"]);
    }
  });
});

test("canonical context drift fails at mutation boundaries without retry", () => {
  withRuntimeContext(() => {
    for (const driftAt of ["before-kms", "after-kms", "after-up", "before-success"]) {
      const fixture = fileBackedContext();
      const calls = [];
      const target = ["before-kms", "after-up"].includes(driftAt) ? "selector" : "env";
      const replace = () => replaceCanonical(
        target === "selector" ? fixture.selectorFile : fixture.environmentFile,
      );
      try {
        assert.throws(
          () => runRealTestRuntimeOperation("activate", "/candidate/code", {
            readContext: () => fixture,
            closeContext: () => {},
            inspectImage: () => {
              if (driftAt === "before-kms") replace();
            },
            inspectApi: () => {
              if (driftAt === "before-success") replace();
              return "healthy";
            },
            compose: (args) => {
              calls.push([...args]);
              if (driftAt === "after-kms" && args[0] === "--profile") replace();
              if (driftAt === "after-up" && args[0] === "up") replace();
            },
          }),
          /runtime file changed/u,
        );
        const operations = calls.map((args) => args[0]);
        if (driftAt === "before-kms") assert.deepEqual(operations, []);
        if (driftAt === "after-kms") assert.deepEqual(operations, ["--profile"]);
        if (["after-up", "before-success"].includes(driftAt)) {
          assert.deepEqual(operations, ["--profile", "up", "stop"]);
        }
      } finally {
        closeSync(fixture.selectorFile.fd);
        closeSync(fixture.environmentFile.fd);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });
});

test("captured capability performs one actual stop after selector or env replacement", () => {
  withRuntimeContext(() => {
    for (const target of ["selector", "env"]) {
      const fixture = fileBackedContext(true);
      writeFileSync(CAPABILITY_LOG, "");
      const receipt = target === "selector"
        ? fixture.selectorFile
        : fixture.environmentFile;
      const replacement = `${receipt.path}.replacement`;
      writeFileSync(replacement, receipt.source, { mode: 0o400 });
      setTrustedDockerFixture();
      process.env.FAKE_REPLACE_PATH = receipt.path;
      process.env.FAKE_REPLACEMENT_PATH = replacement;
      try {
        assert.throws(
          () => runRealTestRuntimeOperation("activate", "/candidate/code", {
            readContext: () => fixture,
            closeContext: () => {},
            inspectImage: () => {},
            inspectApi: () => "healthy",
            composeCapabilityOptions: {
              expectedUid: process.getuid(),
              expectedGid: process.getgid(),
            },
          }),
          /runtime file changed/u,
        );
        const calls = readFileSync(CAPABILITY_LOG, "utf8").trim().split("\n");
        assert.equal(calls.length, 3, JSON.stringify(calls));
        assert.equal(
          calls.filter((line) => line.includes(" --profile kms-health-preflight ")).length,
          1,
          JSON.stringify(calls),
        );
        assert.equal(
          calls.filter((line) => line.includes(" up -d api")).length,
          1,
          JSON.stringify(calls),
        );
        assert.equal(
          calls.filter((line) => line.includes(" stop api")).length,
          1,
          JSON.stringify(calls),
        );
      } finally {
        closeSync(fixture.selectorFile.fd);
        closeSync(fixture.environmentFile.fd);
        rmSync(fixture.root, { recursive: true, force: true });
        clearTrustedDockerFixture();
      }
    }
  });
});

test("explicit stop uses captured capability after canonical replacement", () => {
  withRuntimeContext(() => {
    const fixture = fileBackedContext(true);
    writeFileSync(CAPABILITY_LOG, "");
    setTrustedDockerFixture();
    try {
      assert.throws(
        () => runRealTestRuntimeOperation("stop", "/candidate/code", {
          readContext: () => fixture,
          closeContext: () => {},
          inspectImage: () => replaceCanonical(fixture.selectorFile),
          composeCapabilityOptions: {
            expectedUid: process.getuid(),
            expectedGid: process.getgid(),
          },
        }),
        /runtime file changed/u,
      );
      const calls = readFileSync(CAPABILITY_LOG, "utf8").trim().split("\n");
      assert.equal(calls.length, 1);
      assert.match(calls[0], / stop api/u, JSON.stringify(calls));
    } finally {
      closeSync(fixture.selectorFile.fd);
      closeSync(fixture.environmentFile.fd);
      rmSync(fixture.root, { recursive: true, force: true });
      clearTrustedDockerFixture();
    }
  });
});

test("critical-window replacement blocks KMS or up before actual spawn", () => {
  withRuntimeContext(() => {
    for (const blocked of ["kms", "up"]) {
      const fixture = fileBackedContext(true);
      writeFileSync(CAPABILITY_LOG, "");
      setTrustedDockerFixture();
      let replaced = false;
      try {
        assert.throws(
          () => runRealTestRuntimeOperation("activate", "/candidate/code", {
            readContext: () => fixture,
            closeContext: () => {},
            inspectImage: () => {},
            inspectApi: () => "healthy",
            composeCapabilityOptions: {
              expectedUid: process.getuid(),
              expectedGid: process.getgid(),
              beforeLinkedSpawn: (operation) => {
                if (!replaced && operation === blocked) {
                  replaced = true;
                  replaceCanonical(fixture.selectorFile);
                }
              },
            },
          }),
          /runtime file changed/u,
        );
        const calls = readFileSync(CAPABILITY_LOG, "utf8").trim().split("\n");
        assert.equal(
          calls.some((line) => line.includes(" up -d api")),
          false,
        );
        assert.equal(
          calls.filter((line) => line.includes(" --profile ")).length,
          blocked === "up" ? 1 : 0,
        );
        assert.equal(calls.filter((line) => line.includes(" stop api")).length, 1);
      } finally {
        closeSync(fixture.selectorFile.fd);
        closeSync(fixture.environmentFile.fd);
        rmSync(fixture.root, { recursive: true, force: true });
        clearTrustedDockerFixture();
      }
    }
  });
});

test("risk stop detects post-spawn ctime drift and never retries", () => {
  withRuntimeContext(() => {
    const fixture = fileBackedContext(true);
    writeFileSync(CAPABILITY_LOG, "");
    setTrustedDockerFixture();
    process.env.FAKE_MUTATE_STOP_FD = "true";
    try {
      assert.throws(
        () => runRealTestRuntimeOperation("stop", "/candidate/code", {
          readContext: () => fixture,
          closeContext: () => {},
          inspectImage: () => replaceCanonical(fixture.selectorFile),
          composeCapabilityOptions: {
            expectedUid: process.getuid(),
            expectedGid: process.getgid(),
          },
        }),
        /runtime file changed/u,
      );
      const calls = readFileSync(CAPABILITY_LOG, "utf8").trim().split("\n");
      assert.equal(calls.filter((line) => line.includes(" stop api")).length, 1);
    } finally {
      closeSync(fixture.selectorFile.fd);
      closeSync(fixture.environmentFile.fd);
      rmSync(fixture.root, { recursive: true, force: true });
      clearTrustedDockerFixture();
    }
  });
});

test("captured capability exposes no args API and rejects risk-stop reuse or use after close", () => {
  withRuntimeContext(() => {
    const fixture = fileBackedContext(true);
    writeFileSync(CAPABILITY_LOG, "");
    setTrustedDockerFixture();
    const capability = openRealTestRuntimeComposeCapability(fixture, {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    });
    try {
      assert.equal(capability.execute, undefined);
      replaceCanonical(fixture.selectorFile);
      assert.throws(
        () => capability.stopApi(),
        /runtime file changed/u,
      );
      capability.riskReducingStop();
      assert.throws(
        () => capability.riskReducingStop(),
        /already used/u,
      );
      capability.close();
      capability.close();
      assert.throws(
        () => capability.runKms(),
        /capability is unavailable/u,
      );
      const calls = readFileSync(CAPABILITY_LOG, "utf8").trim().split("\n");
      assert.equal(calls.filter((line) => line.includes(" stop api")).length, 1);
    } finally {
      capability.close();
      closeSync(fixture.selectorFile.fd);
      closeSync(fixture.environmentFile.fd);
      rmSync(fixture.root, { recursive: true, force: true });
      clearTrustedDockerFixture();
    }
  });
});

test("installer-normalized Compose opens a capability without running KMS or API", () => {
  withRuntimeContext(() => {
    const fixture = fileBackedContext("installer");
    writeFileSync(CAPABILITY_LOG, "");
    setTrustedDockerFixture();
    const capability = openRealTestRuntimeComposeCapability(fixture, {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    });
    try {
      assert.equal(readFileSync(CAPABILITY_LOG, "utf8"), "");
      assert.equal(fixture.composeBefore.mode & 0o777, 0o600);
      assert.equal(fixture.composeAfter.mode & 0o777, 0o444);
      assert.equal(fixture.composeAfter.dev, fixture.composeBefore.dev);
      assert.equal(fixture.composeAfter.ino, fixture.composeBefore.ino);
    } finally {
      capability.close();
      closeSync(fixture.selectorFile.fd);
      closeSync(fixture.environmentFile.fd);
      rmSync(fixture.root, { recursive: true, force: true });
      clearTrustedDockerFixture();
    }
  });
});

test("activation still rejects writable modes and symlink Compose paths", () => {
  withRuntimeContext(() => {
    setTrustedDockerFixture();
    try {
      for (const mode of [0o600, 0o644]) {
        const fixture = fileBackedContext(true);
        chmodSync(join(fixture.paths.codeRoot, "compose.real-test.yaml"), mode);
        try {
          assert.throws(
            () => openRealTestRuntimeComposeCapability(fixture, {
              expectedUid: process.getuid(),
              expectedGid: process.getgid(),
            }),
            /Compose file boundary is invalid/u,
          );
        } finally {
          closeSync(fixture.selectorFile.fd);
          closeSync(fixture.environmentFile.fd);
          rmSync(fixture.root, { recursive: true, force: true });
        }
      }

      const fixture = fileBackedContext(false);
      mkdirSync(fixture.paths.codeRoot);
      symlinkSync(
        join(fixture.root, "runtime.env"),
        join(fixture.paths.codeRoot, "compose.real-test.yaml"),
      );
      try {
        assert.throws(
          () => openRealTestRuntimeComposeCapability(fixture, {
            expectedUid: process.getuid(),
            expectedGid: process.getgid(),
          }),
          /Compose file boundary is invalid/u,
        );
      } finally {
        closeSync(fixture.selectorFile.fd);
        closeSync(fixture.environmentFile.fd);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    } finally {
      clearTrustedDockerFixture();
    }
  });
});

test("captured capability rejects a reentrant concurrent call", () => {
  withRuntimeContext(() => {
    const fixture = fileBackedContext(true);
    writeFileSync(CAPABILITY_LOG, "");
    setTrustedDockerFixture();
    let capability;
    capability = openRealTestRuntimeComposeCapability(fixture, {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      beforeLinkedSpawn: () => {
        assert.throws(
          () => capability.upApi(),
          /capability is unavailable/u,
        );
      },
    });
    try {
      capability.runKms();
      const calls = readFileSync(CAPABILITY_LOG, "utf8").trim().split("\n");
      assert.equal(calls.filter((line) => line.includes(" --profile ")).length, 1);
      assert.equal(calls.some((line) => line.includes(" up -d api")), false);
    } finally {
      capability.close();
      closeSync(fixture.selectorFile.fd);
      closeSync(fixture.environmentFile.fd);
      rmSync(fixture.root, { recursive: true, force: true });
      clearTrustedDockerFixture();
    }
  });
});

test("capability options require the exact Node test identity tuple", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestContext = process.env.NODE_TEST_CONTEXT;
  try {
    for (const [nodeEnv, testContext] of [
      [undefined, undefined],
      ["", ""],
      ["production", "production-pollution"],
      ["test", undefined],
      [undefined, "child-v8"],
      ["production", "child-v8"],
      ["test", "worker"],
      ["test", "arbitrary"],
    ]) {
      setOptionalEnvironment("NODE_ENV", nodeEnv);
      setOptionalEnvironment("NODE_TEST_CONTEXT", testContext);
      assert.throws(
        () => openRealTestRuntimeComposeCapability({}, {
          expectedUid: process.getuid(),
          expectedGid: process.getgid(),
          beforeLinkedSpawn: () => {},
        }),
        /capability options are test-only/u,
      );
    }

    process.env.NODE_ENV = "test";
    process.env.NODE_TEST_CONTEXT = "child-v8";
    const fixture = fileBackedContext(true);
    writeFileSync(CAPABILITY_LOG, "");
    setTrustedDockerFixture();
    const capability = openRealTestRuntimeComposeCapability(fixture, {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      beforeLinkedSpawn: () => {},
    });
    try {
      assert.equal(typeof capability.runKms, "function");
    } finally {
      capability.close();
      closeSync(fixture.selectorFile.fd);
      closeSync(fixture.environmentFile.fd);
      rmSync(fixture.root, { recursive: true, force: true });
      clearTrustedDockerFixture();
    }
  } finally {
    setOptionalEnvironment("NODE_ENV", originalNodeEnv);
    setOptionalEnvironment("NODE_TEST_CONTEXT", originalTestContext);
  }
});

test("Docker runtime allowlist excludes Web, volumes, prune and mutation", () => {
  const digest = `sha256:${"1".repeat(64)}`;
  for (const args of [
    ["image", "inspect", "--format", "{{json .}}", digest],
    [
      "ps",
      "--filter", "label=com.docker.compose.project=xingheng-real-test",
      "--format", "{{.ID}} {{.Label \"com.docker.compose.service\"}}",
    ],
    ["container", "inspect", "a".repeat(12)],
    ["exec", "a".repeat(12), "cat", "/app/.build-revision"],
  ]) assert.doesNotThrow(() => validateRealTestRuntimeDockerArguments(args));
  for (const args of [
    ["container", "stop", "a".repeat(12)],
    ["volume", "rm", "sqlite_data"],
    ["system", "prune"],
    ["ps", "--filter", "label=com.docker.compose.service=web"],
    ["image", "rm", digest],
  ]) {
    assert.throws(
      () => validateRealTestRuntimeDockerArguments(args),
      /not allowlisted/u,
    );
  }
});

function context() {
  return {
    selector: {
      revision: REVISION,
      images: {
        api: `sha256:${"1".repeat(64)}`,
        web: `sha256:${"2".repeat(64)}`,
        strategyTools: `sha256:${"3".repeat(64)}`,
      },
    },
    environment: { XINGHENG_REVISION: REVISION },
  };
}

function fileBackedContext(withCompose = false) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-runtime-operation-drift-"));
  const codeRoot = join(root, "code");
  let composeBefore;
  let composeAfter;
  if (withCompose) {
    mkdirSync(codeRoot);
    writeFileSync(
      join(codeRoot, "compose.real-test.yaml"),
      "services:\n  api:\n    image: fixed\n",
      { mode: withCompose === "installer" ? 0o600 : 0o444 },
    );
    if (withCompose === "installer") {
      composeBefore = lstatSync(join(codeRoot, "compose.real-test.yaml"));
      normalizeInstalledRealTestCompose("real-test", codeRoot, {
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
      });
      composeAfter = lstatSync(join(codeRoot, "compose.real-test.yaml"));
    }
  }
  const selectorFile = openReceipt(join(root, "runtime-release.json"), "{}\n");
  const environmentFile = openReceipt(join(root, "runtime.env"), "X=1\n");
  return {
    ...context(),
    root,
    composeBefore,
    composeAfter,
    selectorFile,
    environmentFile,
    paths: { codeRoot },
  };
}

function setTrustedDockerFixture() {
  process.env.NODE_ENV = "test";
  process.env.XINGHENG_TEST_DOCKER_CLI_PATH = CAPABILITY_EXECUTABLE;
  process.env.XINGHENG_TEST_DOCKER_CLI_SHA256 =
    createHash("sha256").update(readFileSync(CAPABILITY_EXECUTABLE)).digest("hex");
  process.env.XINGHENG_TEST_COMPOSE_PLUGIN_PATH = CAPABILITY_EXECUTABLE;
  process.env.XINGHENG_TEST_COMPOSE_PLUGIN_SHA256 =
    process.env.XINGHENG_TEST_DOCKER_CLI_SHA256;
  process.env.XINGHENG_TEST_DOCKER_SOCKET_PATH = CAPABILITY_SOCKET;
}

function clearTrustedDockerFixture() {
  for (const key of [
    "XINGHENG_TEST_DOCKER_CLI_PATH",
    "XINGHENG_TEST_DOCKER_CLI_SHA256",
    "XINGHENG_TEST_COMPOSE_PLUGIN_PATH",
    "XINGHENG_TEST_COMPOSE_PLUGIN_SHA256",
    "XINGHENG_TEST_DOCKER_SOCKET_PATH",
    "FAKE_REPLACE_PATH",
    "FAKE_REPLACEMENT_PATH",
    "FAKE_MUTATE_STOP_FD",
  ]) delete process.env[key];
}

function setOptionalEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function openReceipt(path, source) {
  writeFileSync(path, source, { mode: 0o400 });
  const fd = openSync(path, "r");
  const value = fstatSync(fd);
  return {
    path,
    fd,
    size: value.size,
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode & 0o777,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    sha256: createHash("sha256").update(source).digest("hex"),
    source,
  };
}

function replaceCanonical(receipt) {
  const replacement = `${receipt.path}.replacement`;
  writeFileSync(replacement, receipt.source, { mode: 0o400 });
  renameSync(replacement, receipt.path);
}

function withRuntimeContext(callback) {
  const original = { ...process.env };
  try {
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT = "real-test-runtime";
    process.env.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT = "real-test";
    process.env.XINGHENG_RELEASE_CANDIDATE_REVISION = REVISION;
    callback();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}
