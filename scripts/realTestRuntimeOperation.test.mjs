import assert from "node:assert/strict";
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
      inspectImage: () => { image += 1; },
      inspectApi: () => { api += 1; },
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
        inspectImage: () => { throw new Error("identity failure"); },
        compose: (args) => calls.push([...args]),
      }),
      /identity failure/u,
    );
    assert.deepEqual(calls, []);
    runRealTestRuntimeOperation("stop", "/candidate/code", {
      readContext: () => context(),
      inspectImage: () => {},
      compose: (args) => calls.push([...args]),
    });
    assert.deepEqual(calls, [["stop", "api"]]);
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
