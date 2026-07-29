import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRealTestRuntimeOperation } from "./realTestRuntimeOperation.mjs";
import { validateRealTestRuntimeDockerArguments } from "./trustedDockerRuntime.mjs";

const REVISION = "a".repeat(40);

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

function fileBackedContext() {
  const root = mkdtempSync(join(tmpdir(), "xingheng-runtime-operation-drift-"));
  const selectorFile = openReceipt(join(root, "runtime-release.json"), "{}\n");
  const environmentFile = openReceipt(join(root, "runtime.env"), "X=1\n");
  return {
    ...context(),
    root,
    selectorFile,
    environmentFile,
  };
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
