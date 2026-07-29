import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import {
  assertRiskReducingRuntimeFile,
  assertRuntimeFileDescriptorUnchanged,
  assertRuntimeFileUnchanged,
  captureRiskReducingRuntimeFile,
  closeRealTestRuntimeContext,
  readRealTestRuntimeContext,
} from "./realTestRuntimeReceipt.mjs";
import {
  execTrustedDockerSync,
  openTrustedDockerRuntime,
  trustedExecutableInvocation,
  verifyCapturedTrustedDockerRuntime,
} from "./trustedDockerRuntime.mjs";

const PROJECT = "xingheng-real-test";
const KMS = Object.freeze([
  "--profile", "kms-health-preflight",
  "run", "--rm", "--no-deps", "kms-health-preflight",
]);
const UP = Object.freeze(["up", "-d", "api"]);
const STOP = Object.freeze(["stop", "api"]);
const API_HEALTH_ATTEMPTS = 19;
const API_HEALTH_POLL_INTERVAL_MS = 5_000;

export function runRealTestRuntimeOperation(operation, controlRoot, dependencies = {}) {
  if (!["activate", "stop"].includes(operation)) {
    throw new Error("real-test runtime operation is invalid");
  }
  const revision = process.env.XINGHENG_RELEASE_CANDIDATE_REVISION;
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== "real-test-runtime"
    || process.env.XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT !== "real-test"
    || !/^[a-f0-9]{40}$/u.test(revision ?? "")
  ) throw new Error("real-test runtime operation context is invalid");
  const readContext = dependencies.readContext ?? readRealTestRuntimeContext;
  const context = readContext(controlRoot, dependencies.contextOptions);
  const inspectImage = dependencies.inspectImage ?? (() => verifyApiImage(context));
  const inspectApi = dependencies.inspectApi ?? (() => verifyRunningApi(context));
  const assertContext = dependencies.assertContext ?? (() => {
    assertRuntimeFileUnchanged(context.selectorFile);
    assertRuntimeFileUnchanged(context.environmentFile);
  });
  const wait = dependencies.wait ?? waitForHealthPoll;
  let composeCapability;
  try {
    if (
      context.selector.revision !== revision
      || context.environment.XINGHENG_REVISION !== revision
    ) throw new Error("real-test runtime revision identity mismatch");
    assertContext();
    composeCapability = dependencies.openComposeCapability
      ? dependencies.openComposeCapability(context)
      : dependencies.compose
        ? mockComposeCapability(dependencies.compose)
        : openRealTestRuntimeComposeCapability(
          context,
          dependencies.composeCapabilityOptions,
        );
    assertContext();
    inspectImage();
    if (operation === "stop") {
      try {
        assertContext();
      } catch (error) {
        attemptRiskReducingStop(composeCapability);
        throw error;
      }
      composeCapability.stopApi();
      try {
        assertContext();
      } catch (error) {
        throw error;
      }
      return context.selector;
    }
    assertContext();
    try {
      composeCapability.runKms();
    } catch (error) {
      attemptRiskReducingStop(composeCapability);
      throw error;
    }
    assertContext();
    let upAttempted = false;
    try {
      assertContext();
      upAttempted = true;
      composeCapability.upApi();
      assertContext();
      verifyApiHealthUntilReady(inspectApi, assertContext, wait, dependencies);
      assertContext();
    } catch (error) {
      if (upAttempted) attemptRiskReducingStop(composeCapability);
      throw error;
    }
    return context.selector;
  } finally {
    try {
      composeCapability?.close();
    } finally {
      if (dependencies.closeContext) dependencies.closeContext(context);
      else if (!dependencies.readContext) closeRealTestRuntimeContext(context);
    }
  }
}

function attemptRiskReducingStop(composeCapability) {
  try {
    composeCapability.riskReducingStop();
  } catch {
    // Preserve the original stable failure.
  }
}

function verifyApiHealthUntilReady(inspectApi, assertContext, wait, dependencies) {
  const attempts = dependencies.healthAttempts ?? API_HEALTH_ATTEMPTS;
  const intervalMs = dependencies.healthPollIntervalMs ?? API_HEALTH_POLL_INTERVAL_MS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertContext();
    const status = inspectApi();
    assertContext();
    if (status === "healthy") return;
    if (status !== "starting") {
      throw new Error("real-test runtime API health status is invalid");
    }
    if (attempt === attempts) {
      throw new Error("real-test runtime API health starting timeout");
    }
    wait(intervalMs);
  }
}

function waitForHealthPoll(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function openRealTestRuntimeComposeCapability(context, options = {}) {
  if (
    Object.keys(options).length > 0
    && process.env.NODE_TEST_CONTEXT === undefined
  ) throw new Error("real-test runtime capability options are test-only");
  let composeFile;
  let runtime;
  try {
    assertRuntimeFileDescriptorUnchanged(context.selectorFile);
    assertRuntimeFileDescriptorUnchanged(context.environmentFile);
    composeFile = openComposeFile(
      `${context.paths.codeRoot}/compose.real-test.yaml`,
      options,
    );
    runtime = openTrustedDockerRuntime("compose", process.env);
    verifyCapturedTrustedDockerRuntime(runtime);
    let closed = false;
    let busy = false;
    let riskStopUsed = false;
    const invoke = (callback) => {
      if (closed || busy) {
        throw new Error("real-test runtime Compose capability is unavailable");
      }
      busy = true;
      try {
        return callback();
      } finally {
        busy = false;
      }
    };
    return {
      runKms() {
        return invoke(() => runLinkedCompose(
          context, composeFile, runtime, KMS, "kms", options,
        ));
      },
      upApi() {
        return invoke(() => runLinkedCompose(
          context, composeFile, runtime, UP, "up", options,
        ));
      },
      stopApi() {
        return invoke(() => runLinkedCompose(
          context, composeFile, runtime, STOP, "stop", options,
        ));
      },
      riskReducingStop() {
        return invoke(() => {
          if (riskStopUsed) {
            throw new Error("real-test runtime risk-reducing stop was already used");
          }
          riskStopUsed = true;
          return runRiskReducingStop(context, composeFile, runtime);
        });
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          runtime.close();
        } finally {
          closeSync(composeFile.fd);
        }
      },
    };
  } catch (error) {
    runtime?.close();
    if (composeFile !== undefined) closeSync(composeFile.fd);
    throw error;
  }
}

function runLinkedCompose(context, composeFile, runtime, args, operation, options) {
  options.beforeLinkedSpawn?.(operation);
  assertRuntimeFileUnchanged(context.selectorFile);
  assertRuntimeFileUnchanged(context.environmentFile);
  assertComposeUnchanged(composeFile);
  verifyCapturedTrustedDockerRuntime(runtime);
  const result = spawnCapturedCompose(context, composeFile, runtime, args);
  assertRuntimeFileUnchanged(context.selectorFile);
  assertRuntimeFileUnchanged(context.environmentFile);
  assertComposeUnchanged(composeFile);
  verifyCapturedTrustedDockerRuntime(runtime);
  assertComposeResult(result);
}

function runRiskReducingStop(context, composeFile, runtime) {
  assertComposeUnchanged(composeFile);
  verifyCapturedTrustedDockerRuntime(runtime);
  const selectorBaseline = captureRiskReducingRuntimeFile(context.selectorFile);
  const environmentBaseline =
    captureRiskReducingRuntimeFile(context.environmentFile);
  assertRiskReducingRuntimeFile(context.selectorFile, selectorBaseline);
  assertRiskReducingRuntimeFile(context.environmentFile, environmentBaseline);
  const result = spawnCapturedCompose(context, composeFile, runtime, STOP);
  assertRiskReducingRuntimeFile(context.selectorFile, selectorBaseline);
  assertRiskReducingRuntimeFile(context.environmentFile, environmentBaseline);
  assertComposeUnchanged(composeFile);
  verifyCapturedTrustedDockerRuntime(runtime);
  assertComposeResult(result);
}

function spawnCapturedCompose(context, composeFile, runtime, args) {
  return spawnSync(
    trustedExecutableInvocation(runtime, 5),
    [
      "--env-file", "/proc/self/fd/3",
      "-f", "/proc/self/fd/6",
      "-p", PROJECT,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...runtime.environment,
        ...context.environment,
        XINGHENG_REVISION: context.selector.revision,
        XINGHENG_API_IMAGE: context.selector.images.api,
        XINGHENG_WEB_IMAGE: context.selector.images.web,
        XINGHENG_STRATEGY_TOOLS_IMAGE: context.selector.images.strategyTools,
        XINGHENG_COMPOSE_ENV_FD: "/proc/self/fd/3",
      },
      stdio: [
        "ignore", "pipe", "pipe",
        context.environmentFile.fd,
        "ignore",
        runtime.fd,
        composeFile.fd,
      ],
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function assertComposeResult(result) {
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error("real-test runtime Compose operation failed");
  }
}

function mockComposeCapability(compose) {
  let riskStopUsed = false;
  return {
    runKms() {
      return compose(KMS);
    },
    upApi() {
      return compose(UP);
    },
    stopApi() {
      return compose(STOP);
    },
    riskReducingStop() {
      if (riskStopUsed) throw new Error("risk-reducing stop was already used");
      riskStopUsed = true;
      return compose(STOP);
    },
    close() {},
  };
}

function verifyApiImage(context) {
  const value = JSON.parse(execTrustedDockerSync([
    "image", "inspect", "--format", "{{json .}}", context.selector.images.api,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }));
  if (
    value?.Id !== context.selector.images.api
    || value?.Os !== "linux"
    || value?.Architecture !== "amd64"
    || value?.Config?.Labels?.["org.opencontainers.image.revision"]
      !== context.selector.revision
  ) throw new Error("real-test runtime API image identity mismatch");
}

function verifyRunningApi(context) {
  const ids = execTrustedDockerSync([
    "ps",
    "--filter", `label=com.docker.compose.project=${PROJECT}`,
    "--format", "{{.ID}} {{.Label \"com.docker.compose.service\"}}",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }).trim().split(/\r?\n/u).filter(Boolean);
  const match = /^([a-f0-9]{12,64}) api$/u.exec(ids[0] ?? "");
  if (ids.length !== 1 || match === null) {
    throw new Error("real-test runtime API container count mismatch");
  }
  const value = JSON.parse(execTrustedDockerSync([
    "container", "inspect", match[1],
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }))[0];
  const builtRevision = execTrustedDockerSync([
    "exec", match[1], "cat", "/app/.build-revision",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }).trim();
  const environment = new Set(value?.Config?.Env ?? []);
  if (
    value?.State?.Running !== true
    || value?.Image !== context.selector.images.api
    || value?.Config?.Labels?.["org.opencontainers.image.revision"]
      !== context.selector.revision
    || builtRevision !== context.selector.revision
    || value?.Config?.Labels?.["com.docker.compose.project"] !== PROJECT
    || value?.Config?.Labels?.["com.docker.compose.service"] !== "api"
    || !environment.has(`XINGHENG_EXPECTED_REVISION=${context.selector.revision}`)
    || !environment.has("XINGHENG_DEPLOYMENT_ENVIRONMENT=real-test")
    || !environment.has(`XINGHENG_COMPOSE_PROJECT=${PROJECT}`)
    || !environment.has("RWA_AUTOMATION_SERVER_KILL_SWITCH=true")
    || !JSON.stringify(value?.Config?.Healthcheck?.Test ?? []).includes("cache-control")
    || !JSON.stringify(value?.Config?.Healthcheck?.Test ?? []).includes("no-store")
    || Object.keys(value?.HostConfig?.PortBindings ?? {}).length !== 0
  ) throw new Error("real-test runtime API identity, health or no-store check failed");
  const health = value?.State?.Health?.Status;
  if (!["healthy", "starting"].includes(health)) {
    throw new Error("real-test runtime API health status is invalid");
  }
  return health;
}

function openComposeFile(path, options = {}) {
  const before = lstatSync(path);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || before.gid !== expectedGid
    || (before.mode & 0o777) !== 0o444
    || before.size < 2
    || before.size > 1024 * 1024
  ) throw new Error("real-test runtime Compose file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const value = fstatSync(fd);
  if (
    value.dev !== before.dev
    || value.ino !== before.ino
    || value.size !== before.size
    || value.uid !== expectedUid
    || value.gid !== expectedGid
    || value.nlink !== 1
    || (value.mode & 0o777) !== 0o444
  ) {
    closeSync(fd);
    throw new Error("real-test runtime Compose file boundary is invalid");
  }
  return {
    fd,
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode & 0o777,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function assertComposeUnchanged(receipt) {
  const value = fstatSync(receipt.fd);
  if (
    value.dev !== receipt.dev
    || value.ino !== receipt.ino
    || value.size !== receipt.size
    || value.uid !== receipt.uid
    || value.gid !== receipt.gid
    || value.nlink !== 1
    || value.mtimeMs !== receipt.mtimeMs
    || value.ctimeMs !== receipt.ctimeMs
    || (value.mode & 0o777) !== receipt.mode
  ) throw new Error("real-test runtime Compose file changed");
}
