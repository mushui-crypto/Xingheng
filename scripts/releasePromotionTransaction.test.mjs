import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReleasePromotionTransaction,
  assertPromotionStateAllowsProduction,
  assertPromotionStateAllowsProductionWithTransition,
  validateTrustedPromotionArguments,
} from "./releasePromotionTransaction.mjs";
import { ReleaseLifecycleTransactionStore } from "./releaseLifecycleTransaction.mjs";
import {
  captureTrustedCandidateTree,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";
import { readValidatedPromotionHelperReceipt } from "./trustedDockerRuntime.mjs";
import { assertCapitalTestWindowLaunchIdentity } from "./capitalTestWindowLaunchIdentity.mjs";
import { productionSelfTestPermitDigest } from "./productionSelfTestPermitInstall.mjs";

const OLD_REVISION = "1".repeat(40);
const NEW_REVISION = "2".repeat(40);
const NEXT_REVISION = "3".repeat(40);
const OPERATION_ID = "12345678-1234-4123-8123-123456789abc";
const NEXT_OPERATION_ID = "87654321-4321-4321-8321-cba987654321";
const RETRY_OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("promotion publishes one completed record with embedded success receipt", () => {
  withFixture((fixture) => {
    const result = fixture.transaction.promote(fixture.expected);
    assert.equal(result.state, "PROMOTION_COMPLETED");
    assert.equal(result.success.operationId, OPERATION_ID);
    assert.equal(result.success.newCanonical.revision, NEW_REVISION);
    assert.equal(readManifest(fixture.canonicalRoot).revision, NEW_REVISION);
    assert.equal(readManifest(fixture.stagingPath).revision, OLD_REVISION);
    assert.equal(
      readFileSync(join(fixture.canonicalRoot, ".env.production"), "utf8"),
      `A=1\nXINGHENG_REVISION=${NEW_REVISION}\nB=2\n`,
    );
    assert.equal(
      readFileSync(join(fixture.stagingPath, ".env.production"), "utf8"),
      `A=1\nXINGHENG_REVISION=${OLD_REVISION}\nB=2\n`,
    );
    assert.equal(
      result.newCanonical.environmentSha256,
      sha256(readFileSync(join(fixture.canonicalRoot, ".env.production"))),
    );
    assert.equal(result.newCanonical.environmentSha256, result.staging.environmentSha256);
    assert.notEqual(result.newCanonical.environmentSha256, result.oldCanonical.environmentSha256);
    assert.equal(readFileSync(fixture.lifecyclePointer, "utf8"), fixture.lifecycleBytes);
    assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).state, "PROMOTION_COMPLETED");
    assert.throws(() => fixture.transaction.promote(fixture.expected), /already completed/u);
  });
});

test("completed promotion accepts only its verified prepared-to-active lifecycle transition", () => {
  withFixture((fixture) => {
    activateFixtureLifecycle(fixture);
    assert.equal(
      assertPromotionStateAllowsProduction(fixture.guardOptions).state,
      "PROMOTION_COMPLETED",
    );
  });
});

test("stable promotion identity does not consult an alternate transition validator", () => {
  withFixture((fixture) => {
    fixture.transaction.promote(fixture.expected);
    assert.equal(assertPromotionStateAllowsProductionWithTransition(
      () => { throw new Error("alternate transition validator must not run"); },
      fixture.guardOptions,
    ).state, "PROMOTION_COMPLETED");
  });
});

test("completed promotion delegates only an otherwise-invalid identity transition", () => {
  withFixture((fixture) => {
    const completed = fixture.transaction.promote(fixture.expected);
    const environment = Buffer.from("PERMIT_TRANSITION=true\n", "utf8");
    replaceFixtureFile(join(fixture.canonicalRoot, ".env.production"), environment, 0o600);
    let observed;
    assert.equal(assertPromotionStateAllowsProductionWithTransition((transition) => {
      observed = transition;
      return true;
    }, fixture.guardOptions).state, "PROMOTION_COMPLETED");
    assert.equal(observed.promoted.environmentSha256, completed.newCanonical.environmentSha256);
    assert.equal(observed.current.environmentSha256, sha256(environment));
  });
});

test("Capital Test Window accepts active lifecycle plus Permit environment transition", () => {
  withFixture((fixture) => {
    activateFixtureLifecycle(fixture);
    const completed = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    const environment = Buffer.from("PERMIT_TRANSITION=true\n", "utf8");
    replaceFixtureFile(join(fixture.canonicalRoot, ".env.production"), environment, 0o600);
    assert.equal(assertCapitalTestWindowLaunchIdentity({
      promotionOptions: fixture.guardOptions,
      readReceipt: () => permitTransitionReceipt(completed.newCanonical, sha256(environment)),
    }).state, "PROMOTION_COMPLETED");
  });
});

test("Capital Test Window rejects Permit transition with invalid lifecycle continuity", () => {
  withFixture((fixture) => {
    const lifecycle = activateFixtureLifecycle(fixture);
    const completed = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    const environment = Buffer.from("PERMIT_TRANSITION=true\n", "utf8");
    replaceFixtureFile(join(fixture.canonicalRoot, ".env.production"), environment, 0o600);
    mutateCanonicalJson(lifecycle.pointerPath, 0o600, (value) => {
      value.daemon.id = "invalid-lifecycle-daemon";
    });
    assert.throws(() => assertCapitalTestWindowLaunchIdentity({
      promotionOptions: fixture.guardOptions,
      readReceipt: () => permitTransitionReceipt(completed.newCanonical, sha256(environment)),
    }), /lifecycle identity|lifecycle continuity/u);
  });
});

test("activated lifecycle compatibility rejects every broken continuity relation", () => {
  const mutations = [
    ({ pointerPath }) => mutateCanonicalJson(pointerPath, 0o600, (value) => {
      value.environmentSha256 = "d".repeat(64);
    }),
    ({ intentPath }) => mutateCanonicalJson(intentPath, 0o400, (value) => {
      value.previous.establishedAt = "2026-08-03T00:00:00.000Z";
    }),
    ({ intentPath }) => mutateCanonicalJson(intentPath, 0o400, (value) => {
      value.candidate.images.api = image("d");
    }),
    ({ intentPath }) => mutateCanonicalJson(intentPath, 0o400, (value) => {
      value.candidate.manifest.path = "/tmp/release-manifest.json";
    }),
    ({ pointerPath }) => mutateCanonicalJson(pointerPath, 0o600, (value) => {
      value.daemon.id = "drifted-daemon";
    }),
    ({ journalPath }) => mutateCanonicalJson(journalPath, 0o600, (value) => {
      value.phase = "prepared";
      value.sequence = 0;
    }),
    ({ journalPath }) => mutateCanonicalJson(journalPath, 0o600, (value) => {
      value.sequence = 2;
    }),
    ({ snapshotPath }) => replaceFixtureFile(snapshotPath, "changed\n", 0o400),
  ];
  for (const mutate of mutations) {
    withFixture((fixture) => {
      const lifecycle = activateFixtureLifecycle(fixture);
      mutate(lifecycle);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
    });
  }
});

test("validated COMPLETED is archived immutably before the next promotion", () => {
  withFixture((fixture) => {
    const first = fixture.transaction.promote(fixture.expected);
    const firstBytes = readFileSync(fixture.statePath);
    const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
    const second = fixture.transaction.promote(next);
    const historyPath = join(fixture.completedHistoryRoot, `${first.operationId}.json`);
    const history = lstatSync(historyPath);
    const historyRoot = lstatSync(fixture.completedHistoryRoot);

    assert.equal(second.state, "PROMOTION_COMPLETED");
    assert.equal(second.operationId, NEXT_OPERATION_ID);
    assert.equal(second.oldCanonical.revision, NEW_REVISION);
    assert.equal(second.newCanonical.revision, NEXT_REVISION);
    assert.deepEqual(readFileSync(historyPath), firstBytes);
    assert.equal(historyRoot.mode & 0o777, 0o700);
    assert.equal(history.mode & 0o777, 0o400);
    assert.equal(history.nlink, 1);
    assert.equal(
      JSON.parse(readFileSync(fixture.statePath, "utf8")).operationId,
      NEXT_OPERATION_ID,
    );
    assert.equal(
      assertPromotionStateAllowsProduction(fixture.guardOptions).operationId,
      NEXT_OPERATION_ID,
    );
  });
});

test("completed archival preserves current on interruption and is safely retryable", () => {
  withFixture((fixture) => {
    const first = fixture.transaction.promote(fixture.expected);
    const firstBytes = readFileSync(fixture.statePath);
    const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
    fixture.transaction.fault = (stage) => {
      if (stage === "before_started_publish") throw new Error("stop after archival");
    };
    assert.throws(() => fixture.transaction.promote(next), /stop after archival/u);
    const historyPath = join(fixture.completedHistoryRoot, `${first.operationId}.json`);
    assert.deepEqual(readFileSync(historyPath), firstBytes);
    assert.deepEqual(readFileSync(fixture.statePath), firstBytes);
    assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).operationId, OPERATION_ID);

    fixture.transaction.fault = () => {};
    assert.equal(
      fixture.transaction.promote({ ...next, operationId: RETRY_OPERATION_ID }).operationId,
      RETRY_OPERATION_ID,
    );
    assert.deepEqual(readFileSync(historyPath), firstBytes);
  });
});

test("completed archival never overwrites history with a different identity", () => {
  withFixture((fixture) => {
    const first = fixture.transaction.promote(fixture.expected);
    const firstBytes = readFileSync(fixture.statePath);
    const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
    mkdirSync(fixture.completedHistoryRoot, { mode: 0o700 });
    const historyPath = join(fixture.completedHistoryRoot, `${first.operationId}.json`);
    replaceFixtureFile(historyPath, "{}\n", 0o400);
    assert.throws(
      () => fixture.transaction.promote(next),
      /different identity/u,
    );
    assert.deepEqual(readFileSync(fixture.statePath), firstBytes);
  });
});

test("verified legacy COMPLETED environment can bind the next candidate before exchange", () => {
  withFixture((fixture) => {
    const first = fixture.transaction.promote(fixture.expected);
    const legacyBytes = convertCompletedToLegacyEnvironment(fixture, OLD_REVISION);
    assert.equal(
      assertPromotionStateAllowsProduction(fixture.guardOptions).operationId,
      first.operationId,
    );

    const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
    const second = fixture.transaction.promote(next);
    const historyPath = join(fixture.completedHistoryRoot, `${first.operationId}.json`);

    assert.equal(second.state, "PROMOTION_COMPLETED");
    assert.equal(second.oldCanonical.revision, NEW_REVISION);
    assert.equal(second.newCanonical.revision, NEXT_REVISION);
    assert.equal(
      readFileSync(join(fixture.canonicalRoot, ".env.production"), "utf8"),
      `A=1\nXINGHENG_REVISION=${NEXT_REVISION}\nB=2\n`,
    );
    assert.deepEqual(readFileSync(historyPath), legacyBytes);
    assert.equal(
      assertPromotionStateAllowsProduction(fixture.guardOptions).operationId,
      NEXT_OPERATION_ID,
    );
  });
});

test("legacy environment compatibility requires a fully validated COMPLETED record", () => {
  withFixture((fixture) => {
    fixture.transaction.promote(fixture.expected);
    const currentBytes = convertCompletedToLegacyEnvironment(fixture, OLD_REVISION);
    replaceFixtureFile(fixture.trustReceipt, "{}\n", 0o400);
    const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
    let exchanged = false;
    fixture.transaction.exchange = () => { exchanged = true; };

    assert.throws(() => fixture.transaction.promote(next), /trust receipt|completed promotion/u);
    assert.equal(exchanged, false);
    assert.deepEqual(readFileSync(fixture.statePath), currentBytes);
    assert.equal(
      exists(join(fixture.completedHistoryRoot, `${OPERATION_ID}.json`)),
      false,
    );
  });
});

test("legacy environment compatibility rejects a revision not bound by completed history", () => {
  withFixture((fixture) => {
    fixture.transaction.promote(fixture.expected);
    const unboundRevision = "4".repeat(40);
    const currentBytes = convertCompletedToLegacyEnvironment(fixture, unboundRevision);
    assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).state,
      "PROMOTION_COMPLETED");
    const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
    let exchanged = false;
    fixture.transaction.exchange = () => { exchanged = true; };

    assert.throws(() => fixture.transaction.promote(next), /environment identity/u);
    assert.equal(exchanged, false);
    assert.deepEqual(readFileSync(fixture.statePath), currentBytes);
    assert.equal(readManifest(fixture.canonicalRoot).revision, NEW_REVISION);
  });
});

test("legacy environment compatibility rejects inconsistent completed identity relations", () => {
  for (const mutate of [
    (value) => {
      value.candidate.revision = "4".repeat(40);
      value.success.candidate.revision = value.candidate.revision;
    },
    (value) => {
      value.staging.releaseTreeSha256 = "4".repeat(64);
    },
  ]) {
    withFixture((fixture) => {
      fixture.transaction.promote(fixture.expected);
      convertCompletedToLegacyEnvironment(fixture, OLD_REVISION);
      mutateJson(fixture.statePath, mutate);
      const currentBytes = readFileSync(fixture.statePath);
      assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).state,
        "PROMOTION_COMPLETED");
      const next = fixture.installCandidate(NEXT_REVISION, NEXT_OPERATION_ID);
      let exchanged = false;
      fixture.transaction.exchange = () => { exchanged = true; };

      assert.throws(() => fixture.transaction.promote(next), /internal identity/u);
      assert.equal(exchanged, false);
      assert.deepEqual(readFileSync(fixture.statePath), currentBytes);
      assert.equal(readManifest(fixture.canonicalRoot).revision, NEW_REVISION);
    });
  }
});

test("every candidate identity mismatch becomes UNKNOWN without exchange", () => {
  for (const mutate of [
    (value) => { value.revision = "3".repeat(40); },
    (value) => { value.sourceSha256 = "3".repeat(64); },
    (value) => { value.treeSha256 = "3".repeat(64); },
    (value) => { value.manifestSha256 = "3".repeat(64); },
    (value) => { value.images.api = image("3"); },
    (value) => { value.images.web = image("3"); },
    (value) => { value.images.strategyTools = image("3"); },
  ]) {
    withFixture((fixture) => {
      const expected = structuredClone(fixture.expected);
      mutate(expected);
      assert.throws(() => fixture.transaction.promote(expected));
      assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
      if (exists(fixture.statePath)) {
        assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).state, "PROMOTION_UNKNOWN");
      }
    });
  }
});

test("canonical drift after STARTED and post-exchange trust failure become UNKNOWN", () => {
  for (const stage of ["before-exchange", "after-exchange"]) {
    withFixture((fixture) => {
      if (stage === "before-exchange") {
        fixture.transaction.exchange = () => { throw new Error("exchange unavailable"); };
      } else {
        fixture.transaction.installTrust = () => { throw new Error("trust failed"); };
      }
      assert.throws(() => fixture.transaction.promote(fixture.expected));
      const record = JSON.parse(readFileSync(fixture.statePath, "utf8"));
      assert.equal(record.state, "PROMOTION_UNKNOWN");
      assert.equal(record.success, null);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions), /blocked/u);
    });
  }
});

test("all nonterminal and malformed states block production; absent state preserves IDLE", () => {
  withFixture((fixture) => {
    replaceFixtureFile(fixture.helperReceipt, "malformed\n", 0o400);
    assert.equal(assertPromotionStateAllowsProduction(fixture.guardOptions).state, "IDLE");
    fixture.transaction.exchange = () => { throw new Error("stop after STARTED"); };
    assert.throws(() => fixture.transaction.promote(fixture.expected));
    const unknown = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    for (const state of ["PROMOTION_STARTED", "PROMOTION_EXCHANGED", "PROMOTION_UNKNOWN"]) {
      const value = { ...unknown, state, failureStage: state === "PROMOTION_UNKNOWN"
        ? "manual_terminalization" : null };
      replaceFixtureFile(fixture.statePath, `${canonical(value)}\n`, 0o400);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
    }
    replaceFixtureFile(fixture.statePath, "{}\n", 0o400);
    assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
  });
});

test("COMPLETED requires exact record, canonical and trust identity", () => {
  withFixture((fixture) => {
    fixture.transaction.promote(fixture.expected);
    for (const mutation of [
      () => writeManifest(join(fixture.canonicalRoot, "deploy/release-manifest.json"), "4".repeat(40)),
      () => replaceFixtureFile(fixture.trustReceipt, "{}\n", 0o400),
      () => replaceFixtureFile(fixture.lifecyclePointer, "changed\n", 0o600),
      () => replaceFixtureFile(
        join(fixture.canonicalRoot, ".env.production"),
        `A=changed\nXINGHENG_REVISION=${NEW_REVISION}\nB=2\n`,
        0o600,
      ),
      () => replaceFixtureFile(fixture.helperReceipt, "{}\n", 0o400),
      () => replaceFixtureFile(fixture.helperPath, "changed\n", 0o500),
      () => mutateJson(fixture.trustReceipt, (value) => { value.socket = "wrong"; }),
      () => mutateJson(fixture.trustReceipt, (value) => { value.daemon.id = "wrong"; }),
      () => mutateJson(fixture.trustReceipt, (value) => { value.extra = true; }),
      () => mutateJson(fixture.trustReceipt, (value) => { delete value.binaries; }),
    ]) {
      const restore = snapshot(fixture);
      mutation();
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
      restore();
    }
  });
});

test("independent helper receipt reopens the exact descriptor and rejects tampering", () => {
  withFixture((fixture) => {
    const opened = readValidatedPromotionHelperReceipt({ testMode: true,
      helperPath: fixture.helperPath, receiptPath: fixture.helperReceipt });
    closeSync(opened.opened.fd);
    const receiptBytes = readFileSync(fixture.helperReceipt);
    mutateJson(fixture.helperReceipt, (value) => { value.helper.sha256 = "0".repeat(64); });
    assert.throws(() => readValidatedPromotionHelperReceipt({ testMode: true,
      helperPath: fixture.helperPath, receiptPath: fixture.helperReceipt }));
    replaceFixtureFile(fixture.helperReceipt, receiptBytes, 0o400);
    chmodSync(fixture.helperPath, 0o700);
    assert.throws(() => readValidatedPromotionHelperReceipt({ testMode: true,
      helperPath: fixture.helperPath, receiptPath: fixture.helperReceipt }));
  });
});

test("STARTED binds staging content, not only the directory inode", () => {
  withFixture((fixture) => {
    fixture.transaction.fault = (stage) => {
      if (stage === "after_started_publish") {
        writeManifest(join(fixture.stagingPath, "deploy/release-manifest.json"), "3".repeat(40));
      }
    };
    assert.throws(() => fixture.transaction.promote(fixture.expected), /staging identity changed/u);
    assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).state, "PROMOTION_UNKNOWN");
  });
});

test("promotion rejects an unbound or ambiguous canonical environment before exchange", () => {
  for (const environment of [
    "A=1\n",
    `XINGHENG_REVISION=${OLD_REVISION}\nXINGHENG_REVISION=${OLD_REVISION}\n`,
    "XINGHENG_REVISION=not-a-revision\n",
    `XINGHENG_REVISION=${"3".repeat(40)}\n`,
  ]) {
    withFixture((fixture) => {
      replaceFixtureFile(join(fixture.canonicalRoot, ".env.production"), environment, 0o600);
      let exchanged = false;
      fixture.transaction.exchange = () => { exchanged = true; };
      assert.throws(() => fixture.transaction.promote(fixture.expected), /environment/u);
      assert.equal(exchanged, false);
      assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
      assert.equal(exists(fixture.statePath), false);
    });
  }
});

test("STARTED environment digest rejects staging environment drift before exchange", () => {
  withFixture((fixture) => {
    fixture.transaction.fault = (stage) => {
      if (stage === "after_started_publish") {
        replaceFixtureFile(
          join(fixture.stagingPath, ".env.production"),
          `A=changed\nXINGHENG_REVISION=${NEW_REVISION}\nB=2\n`,
          0o600,
        );
      }
    };
    assert.throws(() => fixture.transaction.promote(fixture.expected), /staging identity changed/u);
    assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).state, "PROMOTION_UNKNOWN");
  });
});

test("trusted promotion arguments are a strict command, payload and environment closure", () => {
  const environment = { HOME: "/root", PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" };
  const value = { revision: NEW_REVISION, sourceSha256: "a".repeat(64),
    treeSha256: "b".repeat(64), manifestSha256: "c".repeat(64),
    images: manifest(NEW_REVISION).images, operationId: OPERATION_ID };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.equal(validateTrustedPromotionArguments(["--promotion-json", payload], environment).command,
    "promote");
  assert.equal(validateTrustedPromotionArguments(["--terminalize-unknown", OPERATION_ID], environment)
    .command, "terminalize-unknown");
  for (const args of [
    ["--generate", payload], ["--promotion-json", payload, "extra"],
    ["--promotion-json", "../payload"], ["scripts/other.sh", payload],
  ]) assert.throws(() => validateTrustedPromotionArguments(args, environment));
  assert.throws(() => validateTrustedPromotionArguments(["--promotion-json", payload],
    { ...environment, NODE_OPTIONS: "--require=/tmp/caller.cjs" }));
});

test("promotion wrapper process rejects trusted direct, legacy and polluted callers", () => {
  const wrapper = new URL("./release-promote.sh", import.meta.url).pathname;
  const payload = "A".repeat(120);
  const environment = { HOME: tmpdir(), PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" };
  const root = mkdtempSync(join(tmpdir(), "promotion-wrapper-process-"));
  try {
    const candidateScripts = join(root, "opt/xingheng-release/candidates", NEW_REVISION,
      "code/scripts");
    mkdirSync(candidateScripts, { recursive: true });
    const candidateWrapper = join(candidateScripts, "release-promote.sh");
    cpSync(wrapper, candidateWrapper);
    chmodSync(candidateWrapper, 0o755);
    const trustedEnvironment = { ...environment,
      XINGHENG_OPERATION_LOCK_CONTEXT: "promotion" };
    for (const invocation of [
      { command: "/bin/sh", args: ["release-promote.sh", "--generate", "legacy"],
        cwd: candidateScripts, env: trustedEnvironment },
      { command: "release-promote.sh", args: ["--generate", "legacy"], cwd: candidateScripts,
        env: { ...trustedEnvironment, PATH: `${candidateScripts}:${environment.PATH}` } },
      { command: "/bin/sh", args: [candidateWrapper, "--promotion-json", payload, "extra"],
        cwd: candidateScripts, env: trustedEnvironment },
      { command: "/bin/sh", args: [candidateWrapper, "--promotion-json", payload],
        cwd: candidateScripts, env: environment },
      { command: "/bin/sh", args: [candidateWrapper, "--promotion-json", payload],
        cwd: candidateScripts, env: { ...trustedEnvironment, NODE_OPTIONS: "--no-warnings" } },
    ]) {
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /production gate PASS|PROMOTION_COMPLETED/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion wrapper removes only the OLDPWD created by its own cd", () => {
  withPromotionWrapperFixture(({ candidateRoot, candidateScripts, candidateWrapper, environment,
    resultPath }) => {
    for (const cwd of [candidateRoot, candidateScripts]) {
      rmSync(resultPath, { force: true });
      const result = spawnSync("/bin/sh", [candidateWrapper, "--promotion-json", "A".repeat(120)], {
        cwd,
        env: environment,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(readFileSync(resultPath, "utf8"));
      assert.equal(observed.oldpwd, null);
      assert.deepEqual(observed.args, ["promote", "A".repeat(120)]);
    }
  });
});

test("promotion wrapper still rejects non-allowlisted business environment", () => {
  withPromotionWrapperFixture(({ candidateScripts, candidateWrapper, environment, resultPath }) => {
    const result = spawnSync("/bin/sh", [candidateWrapper, "--promotion-json", "A".repeat(120)], {
      cwd: candidateScripts,
      env: { ...environment, NODE_OPTIONS: "--no-warnings" },
      encoding: "utf8",
    });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /trusted promotion environment is invalid/u);
    assert.equal(exists(resultPath), false);
  });
});

test("manual terminalization can only move matching STARTED or EXCHANGED to UNKNOWN", () => {
  withFixture((fixture) => {
    fixture.transaction.exchange = () => { throw new Error("exchange stopped"); };
    assert.throws(() => fixture.transaction.promote(fixture.expected));
    const value = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    value.state = "PROMOTION_STARTED";
    value.failureStage = null;
    replaceFixtureFile(fixture.statePath, `${canonical(value)}\n`, 0o400);
    assert.equal(fixture.transaction.terminalizeUnknown(OPERATION_ID).state, "PROMOTION_UNKNOWN");
    assert.throws(() => fixture.transaction.terminalizeUnknown(OPERATION_ID));
  });
});

function withPromotionWrapperFixture(callback) {
  const wrapper = new URL("./release-promote.sh", import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), "promotion-wrapper-positive-"));
  try {
    const canonicalRoot = realpathSync(root);
    const candidateRoot = join(canonicalRoot, "opt/xingheng-release/candidates", NEW_REVISION, "code");
    const candidateScripts = join(candidateRoot, "scripts");
    const candidateWrapper = join(candidateScripts, "release-promote.sh");
    const resultPath = join(candidateScripts, "wrapper-executed.json");
    mkdirSync(candidateScripts, { recursive: true });
    const fixtureCandidatePrefix = `${join(canonicalRoot, "opt/xingheng-release/candidates")}/`;
    writeFileSync(candidateWrapper, readFileSync(wrapper, "utf8")
      .replaceAll("/opt/xingheng-release/candidates/", fixtureCandidatePrefix)
      .replaceAll("/usr/bin/node", process.execPath), { mode: 0o755 });
    writeFileSync(join(candidateScripts, "releasePromotionTransaction.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./wrapper-executed.json", import.meta.url),',
      '  JSON.stringify({ oldpwd: process.env.OLDPWD ?? null, args: process.argv.slice(2) }));',
      "",
    ].join("\n"), { mode: 0o644 });
    callback({
      candidateRoot,
      candidateScripts,
      candidateWrapper,
      resultPath,
      environment: {
        HOME: tmpdir(),
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        XINGHENG_OPERATION_LOCK_CONTEXT: "promotion",
        XINGHENG_RELEASE_CANDIDATE_REVISION: NEW_REVISION,
        XINGHENG_TRUSTED_OPERATION_ENTRY: "release-promote.sh",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("fault injection never publishes partial success", () => {
  for (const stage of [
    "staging_prepared",
    "before_started_publish",
    "after_exchange",
    "after_exchanged_publish",
    "after_trust_install",
    "before_completed_publish",
  ]) {
    withFixture((fixture) => {
      fixture.transaction.fault = (point) => {
        if (point === stage) throw new Error(`injected ${stage}`);
      };
      assert.throws(() => fixture.transaction.promote(fixture.expected));
      if (!exists(fixture.statePath)) {
        assert.equal(readManifest(fixture.canonicalRoot).revision, OLD_REVISION);
        return;
      }
      const record = JSON.parse(readFileSync(fixture.statePath, "utf8"));
      assert.equal(record.state, "PROMOTION_UNKNOWN");
      assert.equal(record.success, null);
      assert.throws(() => assertPromotionStateAllowsProduction(fixture.guardOptions));
      assert.ok([OLD_REVISION, NEW_REVISION].includes(readManifest(fixture.canonicalRoot).revision));
    });
  }
});

function activateFixtureLifecycle(fixture) {
  const lifecycleRoot = join(fixture.root, "release-lifecycle");
  mkdirSync(join(lifecycleRoot, "operations"), { recursive: true, mode: 0o700 });
  mkdirSync(join(lifecycleRoot, "environment-snapshots"), { mode: 0o700 });
  const store = new ReleaseLifecycleTransactionStore(lifecycleRoot, { testMode: true });
  const daemon = {
    id: "fixture-daemon",
    rootDir: "/var/lib/docker",
    serverVersion: "1.2.3",
    storageDriver: "overlay2",
  };
  store.establish(
    join(fixture.canonicalRoot, "deploy/release-manifest.json"),
    join(fixture.canonicalRoot, ".env.production"),
    daemon,
    new Date("2026-08-04T00:00:00.000Z"),
  );
  const pointerPath = join(lifecycleRoot, "current.json");
  fixture.useLifecyclePointer(pointerPath);
  fixture.transaction.promote(fixture.expected);
  const intent = store.prepare(
    join(fixture.canonicalRoot, "deploy/release-manifest.json"),
    join(fixture.canonicalRoot, ".env.production"),
    daemon,
    new Date("2026-08-05T00:01:00.000Z"),
  );
  store.complete(
    intent.operationId,
    join(fixture.canonicalRoot, "deploy/release-manifest.json"),
    join(fixture.canonicalRoot, ".env.production"),
    daemon,
    new Date("2026-08-05T00:02:00.000Z"),
  );
  const operationRoot = join(lifecycleRoot, "operations", `operation-${intent.operationId}`);
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  return {
    pointerPath,
    intentPath: join(operationRoot, "intent.json"),
    journalPath: join(operationRoot, "journal.json"),
    snapshotPath: join(
      lifecycleRoot,
      "environment-snapshots",
      pointer.environmentArtifact.fileName,
    ),
  };
}

function permitTransitionReceipt(promoted, envAfterSha256) {
  const permit = {
    permitId: "4".repeat(32),
    ownerUserId: "USR-TEST",
    accountBindingSha256: "5".repeat(64),
    actionScope: ["READ", "TRADE"],
    executionMode: "single_connectivity_smoke",
    authorizationDigest: "6".repeat(64),
    approvedCapitalUsd: 40,
    expiresAt: "2026-08-07T12:00:00.000Z",
    revision: promoted.revision,
  };
  permit.digest = productionSelfTestPermitDigest(permit);
  const web = permitRuntimeComponent("7", promoted.images.web, promoted.revision);
  return {
    status: "success",
    envBeforeSha256: promoted.environmentSha256,
    envAfterSha256,
    releaseIdentity: {
      releaseRevision: promoted.revision,
      releaseTreeSha256: promoted.releaseTreeSha256,
      releaseManifestSha256: promoted.manifestSha256,
      apiImageDigest: promoted.images.api,
      webImageDigest: promoted.images.web,
    },
    permit,
    runtimeBefore: {
      capturedAt: "2026-08-07T10:00:00.000Z",
      api: permitRuntimeComponent("8", promoted.images.api, promoted.revision),
      web,
    },
    runtimeAfter: {
      capturedAt: "2026-08-07T10:01:00.000Z",
      api: permitRuntimeComponent("9", promoted.images.api, promoted.revision),
      web: structuredClone(web),
    },
  };
}

function permitRuntimeComponent(containerCharacter, imageDigest, revision) {
  return {
    containerId: containerCharacter.repeat(64),
    imageDigest,
    revision,
    startedAt: "2026-08-07T09:00:00.000Z",
    running: true,
    health: "healthy",
  };
}

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-promotion-"));
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const releaseParent = join(root, "release");
    const canonicalRoot = join(releaseParent, "code");
    const candidatesRoot = join(releaseParent, "candidates");
    const stateRoot = join(root, "state");
    const statePath = join(stateRoot, "current.json");
    const completedHistoryRoot = join(stateRoot, "completed");
    const trustReceipt = join(root, "trusted-operations.json");
    const helperPath = join(root, "helper");
    const helperReceipt = join(root, "helper-receipt.json");
    const lifecyclePointer = join(root, "lifecycle.json");
    const stagingPath = join(releaseParent, `.promotion-staging-${OPERATION_ID}`);
    for (const path of [releaseParent, canonicalRoot, candidatesRoot]) {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    makeCodeTree(canonicalRoot, OLD_REVISION);
    writeFileSync(
      join(canonicalRoot, ".env.production"),
      `A=1\nXINGHENG_REVISION=${OLD_REVISION}\nB=2\n`,
      { mode: 0o600 },
    );
    chmodSync(join(canonicalRoot, ".env.production"), 0o600);
    const lifecycleBytes = `${JSON.stringify({ revision: OLD_REVISION })}\n`;
    writeFileSync(lifecyclePointer, lifecycleBytes, { mode: 0o600 });
    chmodSync(lifecyclePointer, 0o600);
    writeFileSync(helperPath, "fixture-helper\n", { mode: 0o500 });
    chmodSync(helperPath, 0o500);
    writeHelperReceipt(helperReceipt, helperPath);
    const installCandidate = (revision, operationId) => installCandidateFixture({
      candidatesRoot, revision, operationId, uid, gid,
    });
    const expected = installCandidate(NEW_REVISION, OPERATION_ID);
    const paths = { releaseParent, canonicalRoot, candidatesRoot, stateRoot, statePath,
      completedHistoryRoot, trustReceipt, lifecyclePointer, helperPath, helperReceipt };
    const exchange = ({ operationId }) => {
      const activeStagingPath = join(releaseParent, `.promotion-staging-${operationId}`);
      const parked = join(releaseParent, ".unit-exchange");
      renameSync(canonicalRoot, parked);
      renameSync(activeStagingPath, canonicalRoot);
      renameSync(parked, activeStagingPath);
    };
    const installTrust = () => {
      const releaseTreeSha256 = sha256(readFileSync(join(canonicalRoot, "deploy/release-manifest.json")));
      const value = { schemaVersion: 1, releaseRoot: canonicalRoot,
        releaseTree: { sha256: releaseTreeSha256 }, socket: "fixture-socket",
        binaries: { node: { path: "/usr/bin/node", sha256: "a".repeat(64) } },
        daemon: { id: "fixture-daemon", rootDir: "/var/lib/docker",
          serverVersion: "1.2.3", storageDriver: "overlay2" } };
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      replaceFixtureFile(trustReceipt, bytes, 0o400);
      return sha256(bytes);
    };
    const validateMainTrust = () => validateMainTrustFixture(trustReceipt, canonicalRoot);
    const validateHelper = () => validateHelperFixture(helperReceipt, helperPath);
    const transaction = new ReleasePromotionTransaction({ ...paths, testMode: true, exchange,
      installTrust, validateMainTrust, validateHelper,
      now: () => new Date("2026-08-05T00:00:00.000Z") });
    const fixture = { root, ...paths, transaction, expected, stagingPath, lifecycleBytes,
      installCandidate,
      guardOptions: { ...paths, expectedUid: uid, expectedGid: gid,
        validateMainTrust, validateHelper } };
    fixture.useLifecyclePointer = (path) => {
      transaction.paths = Object.freeze({ ...transaction.paths, lifecyclePointer: path });
      fixture.lifecyclePointer = path;
      fixture.guardOptions.lifecyclePointer = path;
    };
    callback(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function installCandidateFixture({ candidatesRoot, revision, operationId, uid, gid }) {
  const candidateRoot = join(candidatesRoot, revision);
  const candidateCode = join(candidateRoot, "code");
  mkdirSync(candidateRoot, { mode: 0o700 });
  mkdirSync(candidateCode, { mode: 0o700 });
  makeCodeTree(candidateCode, revision, false);
  const archive = join(candidateRoot, "code.tar");
  writeFileSync(archive, `archive-${revision}\n`, { mode: 0o400 });
  chmodSync(archive, 0o400);
  const candidateManifest = join(candidateRoot, "release-manifest.json");
  writeManifest(candidateManifest, revision);
  const tree = captureTrustedCandidateTree(candidateCode, { expectedUid: uid, expectedGid: gid });
  const sourceArchive = secureArtifactReceipt(
    archive, 0o400, { expectedUid: uid, expectedGid: gid },
  );
  const receipt = {
    schemaVersion: 1,
    revision,
    candidateRoot,
    codeRoot: candidateCode,
    sourceArchive,
    candidateTree: tree,
    socket: "/var/run/docker.sock",
    binaries: Object.fromEntries([
      "compose", "docker", "findmnt", "flock", "git", "node", "sh", "sha256sum", "tar",
    ].map((name) => [name, { path: `/usr/bin/${name}`, sha256: "a".repeat(64) }])),
    daemon: { id: "fixture-daemon", rootDir: "/var/lib/docker", serverVersion: "1.2.3",
      storageDriver: "overlay2" },
  };
  writeFileSync(join(candidateRoot, "candidate-build-receipt.json"),
    `${JSON.stringify(receipt)}\n`, { mode: 0o400 });
  chmodSync(join(candidateRoot, "candidate-build-receipt.json"), 0o400);
  return {
    revision,
    sourceSha256: sourceArchive.sha256,
    treeSha256: tree.sha256,
    manifestSha256: sha256(readFileSync(candidateManifest)),
    images: manifest(revision).images,
    operationId,
  };
}

function makeCodeTree(root, revision, includeManifest = true) {
  mkdirSync(join(root, "deploy"), { mode: 0o700 });
  mkdirSync(join(root, "scripts"), { mode: 0o700 });
  if (includeManifest) writeManifest(join(root, "deploy/release-manifest.json"), revision);
  for (let index = 0; index < 22; index += 1) {
    writeFileSync(join(root, "scripts", `fixture-${index}.mjs`), `export default ${index};\n`, { mode: 0o500 });
  }
}

function writeManifest(path, revision) {
  replaceFixtureFile(path, `${JSON.stringify(manifest(revision), null, 2)}\n`, 0o444);
}

function manifest(revision) {
  return { schemaVersion: 1, revision, images: {
    api: image("a"), web: image("b"), strategyTools: image("c"),
  } };
}

function image(character) { return `sha256:${character.repeat(64)}`; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readManifest(root) { return JSON.parse(readFileSync(join(root, "deploy/release-manifest.json"), "utf8")); }
function exists(path) { try { readFileSync(path); return true; } catch { return false; } }

function snapshot(fixture) {
  const files = [
    [join(fixture.canonicalRoot, "deploy/release-manifest.json"), 0o444],
    [join(fixture.canonicalRoot, ".env.production"), 0o600],
    [fixture.trustReceipt, 0o400],
    [fixture.lifecyclePointer, 0o600],
    [fixture.helperReceipt, 0o400],
    [fixture.helperPath, 0o500],
  ].map(([path, mode]) => [path, readFileSync(path), mode]);
  return () => {
    for (const [path, bytes, mode] of files) {
      replaceFixtureFile(path, bytes, mode);
    }
  };
}

function convertCompletedToLegacyEnvironment(fixture, environmentRevision) {
  const environment = Buffer.from(
    `A=1\nXINGHENG_REVISION=${environmentRevision}\nB=2\n`,
    "utf8",
  );
  replaceFixtureFile(join(fixture.canonicalRoot, ".env.production"), environment, 0o600);
  const environmentSha256 = sha256(environment);
  const completed = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  completed.newCanonical.environmentSha256 = environmentSha256;
  completed.staging.environmentSha256 = environmentSha256;
  completed.success.newCanonical.environmentSha256 = environmentSha256;
  const bytes = Buffer.from(`${canonical(completed)}\n`, "utf8");
  replaceFixtureFile(fixture.statePath, bytes, 0o400);
  return bytes;
}

function writeHelperReceipt(path, helperPath) {
  const metadata = lstatSync(helperPath);
  const value = { schemaVersion: 1, helper: { path: helperPath,
    sha256: sha256(readFileSync(helperPath)), dev: metadata.dev, ino: metadata.ino,
    size: metadata.size, uid: metadata.uid, gid: metadata.gid, nlink: metadata.nlink,
    mode: metadata.mode & 0o777 } };
  replaceFixtureFile(path, `${JSON.stringify(value)}\n`, 0o400);
}

function validateHelperFixture(receiptPath, helperPath) {
  const value = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (Object.keys(value).sort().join(",") !== "helper,schemaVersion"
    || value.schemaVersion !== 1 || value.helper.path !== helperPath
    || value.helper.sha256 !== sha256(readFileSync(helperPath))) {
    throw new Error("fixture helper receipt invalid");
  }
  return { receiptSha256: sha256(readFileSync(receiptPath)) };
}

function validateMainTrustFixture(path, canonicalRoot) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (Object.keys(value).sort().join(",") !== [
    "binaries", "daemon", "releaseRoot", "releaseTree", "schemaVersion", "socket",
  ].sort().join(",") || value.schemaVersion !== 1 || value.releaseRoot !== canonicalRoot
    || value.socket !== "fixture-socket"
    || Object.keys(value.binaries).join(",") !== "node"
    || value.daemon.id !== "fixture-daemon") throw new Error("fixture main trust receipt invalid");
  return { ...value, receiptSha256: sha256(readFileSync(path)) };
}

function replaceFixtureFile(path, bytes, mode) {
  try { chmodSync(path, 0o600); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function mutateJson(path, mutation) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutation(value);
  replaceFixtureFile(path, `${JSON.stringify(value)}\n`, 0o400);
}

function mutateCanonicalJson(path, mode, mutation) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutation(value);
  replaceFixtureFile(path, `${canonical(value)}\n`, mode);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
