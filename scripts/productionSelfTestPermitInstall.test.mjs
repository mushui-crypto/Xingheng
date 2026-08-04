import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertPermitEnvironmentAuthorized,
  captureRuntimeBefore,
  finalizePermitInstallation,
  preparePermitInstallation,
  readCanonicalAuthorizationIdentity,
  readInstallReceipt,
  verifyAndRecordRuntimeAfter,
} from "./productionSelfTestPermitInstall.mjs";

const REVISION = "6efe18eb943b8a57750eeeb06700f101bd676414";
const OWNER = "USR-CAPITALTEST";
const ACTIVATED_AT = new Date("2026-08-04T08:00:00.000Z");

test("authorization identity preflight reads only the canonical owner, Permit ID and SHA", () => {
  withFixture((fixture) => {
    const identity = readCanonicalAuthorizationIdentity(
      fixture.authorizationManifest,
      fixture.options(),
    );
    assert.deepEqual(identity, {
      ownerUserId: OWNER,
      permitId: fixture.request.permitId,
      sha256: fixture.request.authorizationManifestSha256,
    });
    assert.throws(() => readInstallReceipt(fixture.receipt, fixture.options()), /ENOENT/u);
    assert.throws(() => lstatSync(fixture.attemptsRoot), /ENOENT/u);
    assert.equal(environmentEntries(fixture.environment).has("RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED"), false);
  });
});

test("first install succeeds and every later install is rejected", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    assert.equal(receipt.status, "prepared");
    assert.equal(receipt.activatedAt, ACTIVATED_AT.toISOString());
    assert.equal(receipt.expiresAt, "2026-08-04T09:00:00.000Z");
    assert.equal(environmentEntries(fixture.environment).get("RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED"), "true");

    completeRuntime(fixture, receipt);
    const terminal = finalizePermitInstallation("success", receipt.operationId, fixture.options());
    assert.equal(terminal.status, "success");
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
    assert.throws(
      () => preparePermitInstallation(fixture.options({ request: { ...fixture.request, permitId: "b".repeat(32) } })),
      /already been attempted/u,
    );
  });
});

test("invalid request fails before any installation state or environment mutation", () => {
  withFixture((fixture) => {
    const before = readFileSync(fixture.environment);
    assert.throws(
      () => preparePermitInstallation(fixture.options({ request: { ...fixture.request, approvedCapitalUsd: 41 } })),
      /request is invalid/u,
    );
    assert.deepEqual(readFileSync(fixture.environment), before);
    assert.throws(() => readInstallReceipt(fixture.receipt, fixture.options()), /ENOENT/u);
  });
});

test("failed restart restores the prior environment but permanently closes installation", () => {
  withFixture((fixture) => {
    const before = readFileSync(fixture.environment);
    const receipt = preparePermitInstallation(fixture.options());
    const terminal = finalizePermitInstallation("failed", receipt.operationId, fixture.options());
    assert.equal(terminal.status, "failed");
    assert.deepEqual(readFileSync(fixture.environment), before);
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
  });
});

test("uncertain environment identity becomes UNKNOWN and cannot authorize or retry", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    writeSecure(fixture.environment, Buffer.from("NODE_ENV=production\nUNEXPECTED=drift\n"), 0o600);
    assert.throws(
      () => finalizePermitInstallation("success", receipt.operationId, fixture.options()),
      /outcome is UNKNOWN/u,
    );
    assert.equal(readInstallReceipt(fixture.receipt, fixture.options()).status, "unknown");
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
  });
});

test("prepared receipt authorizes only the API restart after the side-effect-free state check", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    const entries = environmentEntries(fixture.environment);
    const common = {
      entries,
      environmentSha256: sha256(readFileSync(fixture.environment)),
      operationEntry: "install-production-self-test-permit.sh",
      operationId: receipt.operationId,
      receiptPath: fixture.receipt,
      options: fixture.options(),
    };
    assert.doesNotThrow(() => assertPermitEnvironmentAuthorized({
      ...common,
      composeArgs: ["up", "-d", "api"],
    }));
    assert.throws(() => assertPermitEnvironmentAuthorized({
      ...common,
      composeArgs: ["exec", "-T", "api", "node", "/app/scripts/verify-production-self-test-permit-state.mjs", OWNER],
    }), /receipt is not active/u);
    assert.throws(() => assertPermitEnvironmentAuthorized({
      ...common,
      composeArgs: ["up", "-d", "api", "web"],
    }), /receipt is not active/u);
    assert.throws(() => assertPermitEnvironmentAuthorized({
      ...common,
      composeArgs: ["exec", "-T", "api", "sh"],
    }), /receipt is not active/u);
  });
});

test("receipt tampering and partial Permit environment fail closed", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    const tampered = { ...receipt, expiresAt: "2026-08-04T09:00:00Z" };
    chmodSync(fixture.receipt, 0o600);
    writeSecure(fixture.receipt, Buffer.from(`${JSON.stringify(tampered)}\n`), 0o400);
    assert.throws(() => readInstallReceipt(fixture.receipt, fixture.options()), /receipt is invalid/u);

    const entries = new Map([["RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED", "true"]]);
    assert.throws(() => assertPermitEnvironmentAuthorized({
      entries,
      environmentSha256: "0".repeat(64),
      composeArgs: ["up", "-d", "api"],
      receiptPath: fixture.receipt,
      options: fixture.options(),
    }), /environment is incomplete/u);
  });
});

test("authorization file identity cannot hide semantic mismatch", () => {
  withFixture((fixture) => {
    const authorization = JSON.parse(readFileSync(fixture.authorizationManifest, "utf8"));
    authorization.permitId = "d".repeat(32);
    const bytes = Buffer.from(`${JSON.stringify(authorization)}\n`);
    chmodSync(fixture.authorizationManifest, 0o600);
    writeSecure(fixture.authorizationManifest, bytes, 0o400);
    assert.throws(() => preparePermitInstallation(fixture.options({
      request: { ...fixture.request, authorizationManifestSha256: sha256(bytes) },
    })), /semantics do not match/u);
    assert.equal(environmentEntries(fixture.environment).has("RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED"), false);
  });
});

test("environment inode replacement before rename becomes permanent UNKNOWN", () => {
  withFixture((fixture) => {
    let replaced = false;
    assert.throws(() => preparePermitInstallation(fixture.options({
      hooks: {
        beforeTargetRevalidate({ path }) {
          if (path !== fixture.environment || replaced) return;
          replaced = true;
          const alternate = `${path}.replacement`;
          writeSecure(alternate, Buffer.from("NODE_ENV=production\nUNEXPECTED=replacement\n"), 0o600);
          renameSync(alternate, path);
        },
      },
    })), /target changed before replacement/u);
    assert.equal(readInstallReceipt(fixture.receipt, fixture.options()).status, "unknown");
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
  });
});

for (const [name, replaceTarget] of [
  ["symlink", (path) => {
    const alternate = `${path}.alternate`;
    writeSecure(alternate, Buffer.from("NODE_ENV=production\n"), 0o600);
    unlinkSync(path);
    symlinkSync(alternate, path);
  }],
  ["hard link", (path) => {
    const alternate = `${path}.alternate`;
    writeSecure(alternate, Buffer.from("NODE_ENV=production\n"), 0o600);
    unlinkSync(path);
    linkSync(alternate, path);
  }],
  ["mode", (path) => chmodSync(path, 0o644)],
]) {
  test(`${name} replacement before environment rename becomes permanent UNKNOWN`, () => {
    withFixture((fixture) => {
      let replaced = false;
      assert.throws(() => preparePermitInstallation(fixture.options({
        hooks: {
          beforeTargetRevalidate({ path }) {
            if (path !== fixture.environment || replaced) return;
            replaced = true;
            replaceTarget(path);
          },
        },
      })), /target changed before replacement/u);
      assert.equal(readInstallReceipt(fixture.receipt, fixture.options()).status, "unknown");
      assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
    });
  });
}

test("restore target race becomes permanent UNKNOWN and cannot rearm", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    let replaced = false;
    const options = fixture.options({
      hooks: {
        beforeTargetRevalidate({ path }) {
          if (path !== fixture.environment || replaced) return;
          replaced = true;
          const alternate = `${path}.restore-race`;
          writeSecure(alternate, Buffer.from("NODE_ENV=production\nUNEXPECTED=restore-race\n"), 0o600);
          renameSync(alternate, path);
        },
      },
    });
    assert.throws(
      () => finalizePermitInstallation("failed", receipt.operationId, options),
      /outcome is UNKNOWN/u,
    );
    assert.equal(readInstallReceipt(fixture.receipt, fixture.options()).status, "unknown");
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
  });
});

test("rename failure cannot leave a usable or retryable Permit", () => {
  withFixture((fixture) => {
    let renameCount = 0;
    assert.throws(() => preparePermitInstallation(fixture.options({
      operations: {
        rename(operation) {
          renameCount += 1;
          if (renameCount === 1) throw new Error("injected rename failure");
          return operation();
        },
      },
    })), /injected rename failure/u);
    assert.equal(readInstallReceipt(fixture.receipt, fixture.options()).status, "unknown");
    assert.equal(environmentEntries(fixture.environment).has("RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED"), false);
  });
});

test("receipt fsync failure leaves no usable Permit and cannot be retried", () => {
  withFixture((fixture) => {
    let fsyncCount = 0;
    assert.throws(() => preparePermitInstallation(fixture.options({
      operations: {
        fileFsync(operation) {
          fsyncCount += 1;
          if (fsyncCount === 3) throw new Error("injected receipt fsync failure");
          return operation();
        },
      },
    })), /injected receipt fsync failure/u);
    assert.equal(environmentEntries(fixture.environment).has("RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED"), false);
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
  });
});

test("runtime verification rejects any Web identity change", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    captureRuntimeBefore(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, false) }));
    assert.throws(() => verifyAndRecordRuntimeAfter(receipt.operationId, fixture.options({
      docker: runtimeDocker(receipt, true, { changedWeb: true }),
    })), /Web container identity changed/u);
    assert.equal(readInstallReceipt(fixture.receipt, fixture.options()).runtimeAfter, null);
  });
});

test("runtime verification rejects a host-correct but API-loaded wrong Permit", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    captureRuntimeBefore(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, false) }));
    assert.throws(() => verifyAndRecordRuntimeAfter(receipt.operationId, fixture.options({
      docker: runtimeDocker(receipt, true, { wrongPermit: true }),
    })), /API container Permit identity mismatch/u);
  });
});

test("API health timeout is fail-closed without accepting or changing Web identity", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    captureRuntimeBefore(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, false) }));
    let snapshots = 0;
    const docker = runtimeDocker(receipt, true, { apiHealth: "starting", onApiInspect: () => { snapshots += 1; } });
    assert.throws(() => verifyAndRecordRuntimeAfter(receipt.operationId, fixture.options({
      docker,
      runtimeHealthAttempts: 2,
      runtimeHealthWaitMilliseconds: 0,
    })), /still starting/u);
    assert.equal(snapshots, 2);
    const current = readInstallReceipt(fixture.receipt, fixture.options());
    assert.equal(current.runtimeAfter, null);
    assert.deepEqual(current.runtimeBefore.web, runtimeDockerSnapshot(receipt, false).web);
  });
});

test("non-health runtime identity failures are rejected immediately", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    captureRuntimeBefore(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, false) }));
    let snapshots = 0;
    const docker = runtimeDocker(receipt, true, { changedWeb: true, onApiInspect: () => { snapshots += 1; } });
    assert.throws(() => verifyAndRecordRuntimeAfter(receipt.operationId, fixture.options({
      docker,
      runtimeHealthAttempts: 3,
      runtimeHealthWaitMilliseconds: 0,
    })), /Web container identity changed/u);
    assert.equal(snapshots, 1);
  });
});

test("immutable attempt receipt must match every bound installation field", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    const attemptPath = resolve(fixture.attemptsRoot, receipt.operationId, "attempt-receipt.json");
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    attempt.releaseIdentity.gitTreeSha = "9".repeat(40);
    const attemptBytes = Buffer.from(`${JSON.stringify(attempt)}\n`);
    chmodSync(attemptPath, 0o600);
    writeSecure(attemptPath, attemptBytes, 0o400);
    const main = { ...receipt, attemptReceiptSha256: sha256(attemptBytes) };
    chmodSync(fixture.receipt, 0o600);
    writeSecure(fixture.receipt, Buffer.from(`${JSON.stringify(main)}\n`), 0o400);
    assert.throws(
      () => readInstallReceipt(fixture.receipt, fixture.options()),
      /does not match the installation receipt/u,
    );
  });
});

test("success receipt rejects either missing runtime snapshot", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    completeRuntime(fixture, receipt);
    const success = finalizePermitInstallation("success", receipt.operationId, fixture.options());
    for (const field of ["runtimeBefore", "runtimeAfter"]) {
      const invalid = clone(success);
      invalid[field] = null;
      rewriteReceipt(fixture, invalid);
      assert.throws(
        () => readInstallReceipt(fixture.receipt, fixture.options()),
        /runtime snapshot state is invalid/u,
      );
    }
  });
});

test("receipt snapshots reject release revision or image digest mismatch", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    completeRuntime(fixture, receipt);
    const prepared = readInstallReceipt(fixture.receipt, fixture.options());
    for (const mutate of [
      (value) => { value.runtimeBefore.api.revision = "7".repeat(40); },
      (value) => { value.runtimeAfter.web.imageDigest = `sha256:${"8".repeat(64)}`; },
    ]) {
      const invalid = clone(prepared);
      mutate(invalid);
      rewriteReceipt(fixture, invalid);
      assert.throws(
        () => readInstallReceipt(fixture.receipt, fixture.options()),
        /does not match the release identity/u,
      );
    }
  });
});

test("receipt snapshots reject changed Web identity or unchanged API container", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    completeRuntime(fixture, receipt);
    const prepared = readInstallReceipt(fixture.receipt, fixture.options());
    const cases = [
      [(value) => { value.runtimeAfter.web.containerId = "9".repeat(64); }, /Web runtime identity changed/u],
      [(value) => { value.runtimeAfter.web.startedAt = "2026-08-04T07:31:00.000Z"; }, /Web runtime identity changed/u],
      [(value) => { value.runtimeAfter.api.containerId = value.runtimeBefore.api.containerId; }, /API container identity did not change/u],
    ];
    for (const [mutate, expected] of cases) {
      const invalid = clone(prepared);
      mutate(invalid);
      rewriteReceipt(fixture, invalid);
      assert.throws(() => readInstallReceipt(fixture.receipt, fixture.options()), expected);
    }
  });
});

test("non-success receipt states reject snapshot combinations outside the write flow", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    completeRuntime(fixture, receipt);
    const prepared = readInstallReceipt(fixture.receipt, fixture.options());
    const cases = [
      { status: "prepared", runtimeBefore: null, runtimeAfter: prepared.runtimeAfter },
      { status: "failed", runtimeBefore: prepared.runtimeBefore, runtimeAfter: prepared.runtimeAfter },
      { status: "unknown", runtimeBefore: null, runtimeAfter: prepared.runtimeAfter },
    ];
    for (const invalid of cases) {
      rewriteReceipt(fixture, { ...prepared, ...invalid });
      assert.throws(
        () => readInstallReceipt(fixture.receipt, fixture.options()),
        /runtime snapshot state is invalid/u,
      );
    }
  });
});

test("failed receipt accepts the runtime-before-only signal boundary", () => {
  withFixture((fixture) => {
    const receipt = preparePermitInstallation(fixture.options());
    captureRuntimeBefore(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, false) }));
    const failed = finalizePermitInstallation("failed", receipt.operationId, fixture.options());
    assert.equal(failed.status, "failed");
    assert.notEqual(failed.runtimeBefore, null);
    assert.equal(failed.runtimeAfter, null);
    assert.doesNotThrow(() => readInstallReceipt(fixture.receipt, fixture.options()));
  });
});

for (const scope of ["state root", "attempts root", "attempt directory"]) {
  for (const defect of ["symlink", "mode"]) {
    test(`${scope} ${defect} is rejected without directory or environment mutation`, () => {
      withFixture((fixture) => {
        const operationId = "f".repeat(32);
        const target = prepareDirectoryDefect(fixture, scope, defect, operationId);
        const environmentBefore = readFileSync(fixture.environment);
        const metadataBefore = lstatSync(target);
        assert.throws(
          () => preparePermitInstallation(fixture.options({ operationId })),
          /directory boundary is invalid|already been attempted/u,
        );
        const metadataAfter = lstatSync(target);
        assert.equal(metadataAfter.mode, metadataBefore.mode);
        assert.equal(metadataAfter.ino, metadataBefore.ino);
        assert.deepEqual(readFileSync(fixture.environment), environmentBefore);
      });
    });
  }
}

test("missing state root is rejected under an unsafe parent without mutation", () => {
  withFixture((fixture) => {
    chmodSync(fixture.root, 0o777);
    const environmentBefore = readFileSync(fixture.environment);
    assert.throws(
      () => preparePermitInstallation(fixture.options()),
      /parent directory boundary is invalid/u,
    );
    assert.throws(() => lstatSync(fixture.stateRoot), /ENOENT/u);
    assert.deepEqual(readFileSync(fixture.environment), environmentBefore);
  });
});

for (const scope of ["state root", "attempts root", "attempt directory"]) {
  for (const defect of ["owner", "group"]) {
    test(`${scope} ${defect} defect is a zero-mutation rejection`, {
      skip: process.platform !== "linux" || process.getuid?.() !== 0
        ? "requires real Linux root ownership semantics"
        : false,
    }, () => {
      withFixture((fixture) => {
        const operationId = "e".repeat(32);
        const target = prepareDirectoryDefect(fixture, scope, "mode", operationId);
        chmodSync(target, 0o700);
        chownSync(target, defect === "owner" ? 1 : 0, defect === "group" ? 1 : 0);
        const environmentBefore = readFileSync(fixture.environment);
        assert.throws(
          () => preparePermitInstallation(fixture.options({ operationId })),
          /directory boundary is invalid|already been attempted/u,
        );
        const metadata = lstatSync(target);
        assert.equal(metadata.uid, defect === "owner" ? 1 : 0);
        assert.equal(metadata.gid, defect === "group" ? 1 : 0);
        assert.deepEqual(readFileSync(fixture.environment), environmentBefore);
      });
    });
  }
}

test("directory fsync failure permanently closes installation without enabling Permit", () => {
  withFixture((fixture) => {
    let fsyncCount = 0;
    assert.throws(() => preparePermitInstallation(fixture.options({
      operations: {
        directoryFsync(operation) {
          fsyncCount += 1;
          if (fsyncCount === 3) throw new Error("injected directory fsync failure");
          return operation();
        },
      },
    })), /injected directory fsync failure/u);
    assert.equal(environmentEntries(fixture.environment).has("RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED"), false);
    assert.throws(() => preparePermitInstallation(fixture.options()), /already been attempted/u);
  });
});

test("direct Node mutation entry is rejected before reading stdin or touching files", () => {
  const result = spawnSync(process.execPath, [
    new URL("./productionSelfTestPermitInstall.mjs", import.meta.url).pathname,
    "prepare",
    "a".repeat(32),
  ], { input: "{}", encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /controlled Linux root|trusted wrapper context/u);
});

function withFixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), "xingheng-permit-install-"));
  try {
    const releaseManifest = resolve(root, "release-manifest.json");
    const authorizationManifest = resolve(root, "authorization.json");
    const environment = resolve(root, ".env.production");
    const receipt = resolve(root, "state", "install.json");
    const attemptsRoot = resolve(root, "state", "attempts");
    const apiImageDigest = `sha256:${"1".repeat(64)}`;
    const webImageDigest = `sha256:${"2".repeat(64)}`;
    const releaseManifestBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      revision: REVISION,
      images: { api: apiImageDigest, web: webImageDigest, strategyTools: `sha256:${"3".repeat(64)}` },
    })}\n`);
    writeSecure(releaseManifest, releaseManifestBytes, 0o444);
    writeSecure(environment, Buffer.from(`NODE_ENV=production\nXINGHENG_EXPECTED_REVISION=${REVISION}\n`), 0o600);
    const authorization = {
      schemaVersion: 1,
      permitId: "a".repeat(32),
      ownerUserId: OWNER,
      accountBindingSha256: "c".repeat(64),
      actionScope: ["READ", "TRADE"],
      approvedCapitalUsd: 40,
      leverage: 1,
      executionMode: "single_funding_rate_arbitrage_round",
      maximumDurationMinutes: 60,
      maximumExecutionDurationMinutes: 30,
      releaseRevision: REVISION,
      gitTreeSha: "4".repeat(40),
      releaseTreeSha256: "5".repeat(64),
      releaseManifestSha256: sha256(releaseManifestBytes),
      apiImageDigest,
      webImageDigest,
    };
    const authorizationBytes = Buffer.from(`${JSON.stringify(authorization)}\n`);
    writeSecure(authorizationManifest, authorizationBytes, 0o400);
    const request = {
      ...authorization,
      authorizationManifestSha256: sha256(authorizationBytes),
    };
    const releaseIdentity = {
      releaseRevision: REVISION,
      gitTreeSha: request.gitTreeSha,
      releaseTreeSha256: request.releaseTreeSha256,
      releaseManifestSha256: request.releaseManifestSha256,
      apiImageDigest,
      webImageDigest,
      lifecycleEstablishedAt: "2026-08-04T07:00:00.000Z",
      lifecycleOperationId: "12345678-1234-4123-8123-123456789abc",
    };
    const fixture = {
      root,
      stateRoot: resolve(root, "state"),
      authorizationManifest,
      environment,
      receipt,
      releaseManifest,
      attemptsRoot,
      request,
      options(overrides = {}) {
        return {
          authorizationManifestPath: authorizationManifest,
          environmentPath: environment,
          receiptPath: receipt,
          attemptsRoot,
          releaseManifestPath: releaseManifest,
          request,
          now: ACTIVATED_AT,
          releaseIdentity,
          testMode: true,
          ...overrides,
        };
      },
    };
    run(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function completeRuntime(fixture, receipt) {
  captureRuntimeBefore(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, false) }));
  verifyAndRecordRuntimeAfter(receipt.operationId, fixture.options({ docker: runtimeDocker(receipt, true) }));
}

function runtimeDocker(receipt, after, changes = {}) {
  const web = runtimeContainer(
    (changes.changedWeb ? "d" : "a").repeat(64),
    receipt.releaseIdentity.webImageDigest,
    receipt.releaseIdentity.releaseRevision,
  );
  const api = runtimeContainer(
    (after ? "c" : "b").repeat(64),
    receipt.releaseIdentity.apiImageDigest,
    receipt.releaseIdentity.releaseRevision,
    after ? receipt : null,
  );
  if (changes.apiHealth) api.State.Health.Status = changes.apiHealth;
  if (changes.wrongPermit) {
    api.Config.Env = api.Config.Env.map((entry) => entry.startsWith("RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID=")
      ? `RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID=${"e".repeat(32)}`
      : entry);
  }
  return (args) => {
    if (args[0] === "ps") return args.includes("label=com.docker.compose.service=api") ? `${api.Id}\n` : `${web.Id}\n`;
    if (args[0] === "container" && args[1] === "inspect") {
      if (args[2] === api.Id) changes.onApiInspect?.();
      return JSON.stringify([args[2] === api.Id ? api : web]);
    }
    if (args[0] === "exec") return "permit-runtime-safe\n";
    throw new Error(`unexpected Docker fixture command: ${args.join(" ")}`);
  };
}

function runtimeDockerSnapshot(receipt, after) {
  const web = runtimeContainer(
    "a".repeat(64),
    receipt.releaseIdentity.webImageDigest,
    receipt.releaseIdentity.releaseRevision,
  );
  const api = runtimeContainer(
    (after ? "c" : "b").repeat(64),
    receipt.releaseIdentity.apiImageDigest,
    receipt.releaseIdentity.releaseRevision,
    after ? receipt : null,
  );
  return {
    capturedAt: ACTIVATED_AT.toISOString(),
    api: runtimeComponent(api),
    web: runtimeComponent(web),
  };
}

function runtimeComponent(container) {
  return {
    containerId: container.Id,
    imageDigest: container.Image,
    revision: container.Config.Labels["org.opencontainers.image.revision"],
    startedAt: "2026-08-04T07:30:00.000Z",
    running: container.State.Running,
    health: container.State.Health.Status,
  };
}

function runtimeContainer(id, image, revision, receipt = null) {
  const environment = receipt === null ? [] : [
    "RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED=true",
    `RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID=${receipt.permit.permitId}`,
    `RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID=${receipt.permit.ownerUserId}`,
    `RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256=${receipt.permit.accountBindingSha256}`,
    'RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE=["READ","TRADE"]',
    `RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST=${receipt.permit.authorizationDigest}`,
    `RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD=${receipt.permit.approvedCapitalUsd}`,
    `RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT=${receipt.permit.expiresAt}`,
  ];
  return {
    Id: id,
    Image: image,
    Config: { Labels: { "org.opencontainers.image.revision": revision }, Env: environment },
    State: { Running: true, StartedAt: "2026-08-04T07:30:00.000000000Z", Health: { Status: "healthy" } },
  };
}

function writeSecure(path, bytes, mode) {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function rewriteReceipt(fixture, receipt) {
  chmodSync(fixture.receipt, 0o600);
  writeSecure(fixture.receipt, Buffer.from(`${JSON.stringify(receipt)}\n`), 0o400);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function prepareDirectoryDefect(fixture, scope, defect, operationId) {
  const attemptsRoot = fixture.attemptsRoot;
  const attemptDir = resolve(attemptsRoot, operationId);
  const target = scope === "state root"
    ? fixture.stateRoot
    : scope === "attempts root" ? attemptsRoot : attemptDir;
  if (scope !== "state root") mkdirSync(fixture.stateRoot, { mode: 0o700 });
  if (scope === "attempt directory") mkdirSync(attemptsRoot, { mode: 0o700 });
  if (defect === "symlink") {
    const alternate = `${target}.alternate`;
    mkdirSync(alternate, { mode: 0o700 });
    symlinkSync(alternate, target);
  } else {
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return target;
}

function environmentEntries(path) {
  return new Map(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const offset = line.indexOf("=");
    return [line.slice(0, offset), line.slice(offset + 1)];
  }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
