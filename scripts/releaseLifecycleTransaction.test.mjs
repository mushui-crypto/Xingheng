import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReleaseLifecycleTransactionStore,
  validateRollbackRuntimeEvidence,
} from "./releaseLifecycleTransaction.mjs";

const FIRST_REVISION = "1".repeat(40);
const SECOND_REVISION = "2".repeat(40);
const THIRD_REVISION = "3".repeat(40);
const DAEMON = Object.freeze({
  id: "fixture-daemon-id",
  rootDir: "/var/lib/docker",
  serverVersion: "29.0.0",
  storageDriver: "overlayfs",
});

test("first verified release establishes one immutable lifecycle pointer", () => {
  withFixture(({ store, first }) => {
    const pointer = store.establish(first.manifest, first.environment, DAEMON);
    assert.equal(pointer.revision, FIRST_REVISION);
    assert.throws(
      () => store.establish(first.manifest, first.environment, DAEMON),
      /already established/u,
    );
  });
});

test("upgrade intent binds previous release, candidate files, environment and daemon", () => {
  withFixture(({ store, first, second }) => {
    store.establish(first.manifest, first.environment, DAEMON);
    const intent = store.prepare(second.manifest, second.environment, DAEMON);
    assert.equal(intent.previous.revision, FIRST_REVISION);
    assert.equal(intent.candidate.revision, SECOND_REVISION);
    assert.equal(intent.daemon.id, DAEMON.id);
    const active = store.complete(
      intent.operationId,
      second.manifest,
      second.environment,
      DAEMON,
    );
    assert.equal(active.revision, SECOND_REVISION);
    assert.equal(store.readOperation(intent.operationId).journal.phase, "active");
    assert.equal(store.readCurrent().revision, SECOND_REVISION);
  });
});

test("failed upgrade remains stopped until the same operation rolls back", () => {
  withFixture(({ store, first, second }) => {
    store.establish(first.manifest, first.environment, DAEMON);
    const intent = store.prepare(second.manifest, second.environment, DAEMON);
    store.markIncident(intent.operationId, "runtime_verification_failed");
    const rollback = store.rollbackValues(intent.operationId);
    assert.equal(rollback.revision, FIRST_REVISION);
    assert.equal(rollback.images.api, image("1"));
    store.restoreEnvironment(intent.operationId, second.environment);
    assert.equal(
      readFileSync(second.environment, "utf8"),
      readFileSync(first.environment, "utf8"),
    );
    assert.throws(
      () => store.prepare(second.manifest, second.environment, DAEMON),
      /unresolved operation/u,
    );
    const restored = store.markRolledBack(intent.operationId, DAEMON);
    assert.equal(restored.revision, FIRST_REVISION);
    assert.equal(store.readOperation(intent.operationId).journal.phase, "rolled_back");
  });
});

test("candidate inode, content, mode, link and daemon drift all fail closed", () => {
  for (const mutation of [
    ({ second }) => {
      chmodSync(second.manifest, 0o644);
      writeManifest(second.manifest, THIRD_REVISION);
    },
    ({ second }) => {
      const replacement = `${second.manifest}.replacement`;
      writeManifest(replacement, SECOND_REVISION);
      renameSync(replacement, second.manifest);
    },
    ({ second }) => chmodSync(second.environment, 0o640),
    ({ second }) => linkSync(second.manifest, `${second.manifest}.hardlink`),
  ]) {
    withFixture(({ store, first, second }) => {
      store.establish(first.manifest, first.environment, DAEMON);
      const intent = store.prepare(second.manifest, second.environment, DAEMON);
      mutation({ second });
      assert.throws(
        () => store.complete(
          intent.operationId,
          second.manifest,
          second.environment,
          DAEMON,
        ),
        /identity changed|boundary is invalid/u,
      );
    });
  }

  withFixture(({ store, first, second }) => {
    store.establish(first.manifest, first.environment, DAEMON);
    assert.throws(
      () => store.prepare(second.manifest, second.environment, {
        ...DAEMON,
        id: "different-daemon-id",
      }),
      /daemon identity changed/u,
    );
  });
});

test("symlinked manifest and non-canonical journal transitions are rejected", () => {
  withFixture(({ store, first, second, root }) => {
    store.establish(first.manifest, first.environment, DAEMON);
    const linked = join(root, "linked-manifest.json");
    symlinkSync(second.manifest, linked);
    assert.throws(
      () => store.prepare(linked, second.environment, DAEMON),
      /boundary is invalid/u,
    );
    const intent = store.prepare(second.manifest, second.environment, DAEMON);
    assert.throws(
      () => store.markRolledBack(intent.operationId, DAEMON),
      /phase is invalid/u,
    );
    assert.throws(
      () => store.markIncident(intent.operationId, "INVALID"),
      /category is invalid/u,
    );
  });
});

test("rollback runtime requires one healthy exact-revision API and Web", () => {
  const expected = {
    revision: FIRST_REVISION,
    images: {
      api: image("1"),
      web: image("1"),
      strategyTools: image("1"),
    },
  };
  const evidence = {
    api: runtimeItem(image("1")),
    web: runtimeItem(image("1")),
  };
  assert.equal(validateRollbackRuntimeEvidence(expected, evidence), true);
  for (const mutation of [
    (copy) => { copy.api.imageDigest = image("2"); },
    (copy) => { copy.web.runtimeRevision = SECOND_REVISION; },
    (copy) => { copy.api.healthy = false; },
    (copy) => { copy.web.restartCount = -1; },
  ]) {
    const copy = structuredClone(evidence);
    mutation(copy);
    assert.throws(
      () => validateRollbackRuntimeEvidence(expected, copy),
      /identity mismatch/u,
    );
  }
});

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-release-lifecycle-"));
  try {
    chmodSync(root, 0o700);
    const data = join(root, "data");
    mkdirSync(data, { mode: 0o700 });
    const store = new ReleaseLifecycleTransactionStore(join(root, "state"), {
      testMode: true,
    });
    const first = writeRelease(data, "first", FIRST_REVISION);
    const second = writeRelease(data, "second", SECOND_REVISION);
    callback({ root, store, first, second });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeRelease(root, name, revision) {
  const manifest = join(root, `${name}-manifest.json`);
  const environment = join(root, `${name}.env`);
  writeManifest(manifest, revision);
  writeFileSync(environment, `DOMAIN=${name}.example.test\n`, { mode: 0o600 });
  chmodSync(environment, 0o600);
  return { manifest, environment };
}

function writeManifest(path, revision) {
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    revision,
    images: {
      api: image(revision[0]),
      web: image(revision[0] === "f" ? "e" : revision[0]),
      strategyTools: image(revision[0] === "f" ? "d" : revision[0]),
    },
  })}\n`, { mode: 0o444 });
  chmodSync(path, 0o444);
}

function image(character) {
  return `sha256:${character.repeat(64)}`;
}

function runtimeItem(imageDigest) {
  return {
    containerId: "a".repeat(64),
    imageDigest,
    builtRevision: FIRST_REVISION,
    runtimeRevision: FIRST_REVISION,
    healthy: true,
    restartCount: 0,
  };
}
