import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeInstalledRealTestCompose,
} from "./realTestComposeInstallBoundary.mjs";
import { captureTrustedCandidateTree } from "./trustedReleaseCandidate.mjs";

const COMPOSE_NAME = "compose.real-test.yaml";
const SOURCE = "services:\n  api:\n    image: fixed\n";
const OWNER = {
  expectedUid: process.getuid(),
  expectedGid: process.getgid(),
};

test("installer extraction normalizes the real-test Compose inode before tree capture", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-compose-install-"));
  try {
    const archive = join(root, "source.tar");
    const code = join(root, "code");
    mkdirSync(code, { mode: 0o700 });
    const archived = spawnSync(
      "/usr/bin/git",
      ["archive", "--format=tar", "--output", archive, "HEAD"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.equal(archived.status, 0, archived.stderr);
    const extracted = spawnSync(
      "/bin/sh",
      [
        "-c",
        "umask 077; exec /usr/bin/tar --extract --file \"$1\" --directory \"$2\" --no-same-owner --no-same-permissions",
        "task001-test",
        archive,
        code,
      ],
      { encoding: "utf8" },
    );
    assert.equal(extracted.status, 0, extracted.stderr);

    const path = join(code, COMPOSE_NAME);
    const before = lstatSync(path);
    assert.equal(before.mode & 0o777, 0o600);
    assert.equal(
      normalizeInstalledRealTestCompose("real-test", code, OWNER),
      true,
    );
    const after = lstatSync(path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.mode & 0o777, 0o444);

    const normalizedTree = captureTrustedCandidateTree(code, {
      ...OWNER,
      skipParentChain: true,
    });
    chmodSync(path, 0o600);
    const driftedTree = captureTrustedCandidateTree(code, {
      ...OWNER,
      skipParentChain: true,
    });
    assert.notEqual(driftedTree.sha256, normalizedTree.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production install does not inspect or normalize the real-test Compose path", () => {
  withCode((code) => {
    const path = join(code, COMPOSE_NAME);
    writeFileSync(path, SOURCE, { mode: 0o600 });
    assert.equal(normalizeInstalledRealTestCompose("production", code), false);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  });
});

test("real-test install normalizes both secure extracted source modes", () => {
  for (const mode of [0o600, 0o644]) {
    withCode((code) => {
      const path = join(code, COMPOSE_NAME);
      writeFileSync(path, SOURCE, { mode });
      const before = lstatSync(path);
      assert.equal(
        normalizeInstalledRealTestCompose("real-test", code, OWNER),
        true,
      );
      const after = lstatSync(path);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode & 0o777, 0o444);
    });
  }
});

test("missing or nonregular fixed Compose objects fail closed", () => {
  withCode((code) => {
    assert.throws(
      () => normalizeInstalledRealTestCompose("real-test", code, OWNER),
      /ENOENT/u,
    );
  });
  for (const create of [
    (path) => mkdirSync(path),
    (path) => symlinkSync("missing-target", path),
    (path) => {
      const result = spawnSync("/usr/bin/mkfifo", [path], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    },
  ]) {
    withCode((code) => {
      create(join(code, COMPOSE_NAME));
      assert.throws(
        () => normalizeInstalledRealTestCompose("real-test", code, OWNER),
        /install boundary is invalid/u,
      );
    });
  }
});

test("hardlinks, wrong ownership boundary and oversized content fail closed", () => {
  withCode((code) => {
    const path = createCompose(code);
    linkSync(path, join(code, "hardlink"));
    assert.throws(
      () => normalizeInstalledRealTestCompose("real-test", code, OWNER),
      /install boundary is invalid/u,
    );
  });
  withCode((code) => {
    createCompose(code);
    assert.throws(
      () => normalizeInstalledRealTestCompose("real-test", code, {
        expectedUid: process.getuid() + 1,
        expectedGid: process.getgid(),
      }),
      /install boundary is invalid/u,
    );
  });
  withCode((code) => {
    writeFileSync(join(code, COMPOSE_NAME), Buffer.alloc(1024 * 1024 + 1), {
      mode: 0o600,
    });
    assert.throws(
      () => normalizeInstalledRealTestCompose("real-test", code, OWNER),
      /install boundary is invalid/u,
    );
  });
});

test("pre-open and post-normalization path replacement fail closed", () => {
  withCode((code) => {
    const path = createCompose(code);
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, SOURCE, { mode: 0o600 });
    assert.throws(
      () => normalizeInstalledRealTestCompose("real-test", code, {
        ...OWNER,
        beforeOpen: () => renameSync(replacement, path),
      }),
      /changed while opening/u,
    );
  });
  withCode((code) => {
    const path = createCompose(code);
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, SOURCE, { mode: 0o444 });
    assert.throws(
      () => normalizeInstalledRealTestCompose("real-test", code, {
        ...OWNER,
        afterClose: () => renameSync(replacement, path),
      }),
      /changed after normalization/u,
    );
  });
});

test("fchmod and fsync failures close the descriptor and fail closed", () => {
  for (const [operation, expected] of [
    ["fchmod", /fchmod fixture failure/u],
    ["fsync", /fsync fixture failure/u],
  ]) {
    withCode((code) => {
      const path = createCompose(code);
      let fd;
      const options = {
        ...OWNER,
        fchmod(value, mode) {
          fd = value;
          if (operation === "fchmod") throw new Error("fchmod fixture failure");
          fchmodSync(value, mode);
        },
        fsync(value) {
          fd = value;
          if (operation === "fsync") throw new Error("fsync fixture failure");
          fsyncSync(value);
        },
      };
      assert.throws(
        () => normalizeInstalledRealTestCompose("real-test", code, options),
        expected,
      );
      assert.throws(() => fsyncSync(fd), /bad file descriptor|EBADF/u);
      assert.equal(lstatSync(path).ino > 0, true);
    });
  }
});

test("normalization test seams are unavailable outside the exact Node test identity", () => {
  const original = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    withCode((code) => {
      createCompose(code);
      assert.throws(
        () => normalizeInstalledRealTestCompose("real-test", code, OWNER),
        /options are test-only/u,
      );
    });
  } finally {
    if (original === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = original;
  }
});

function withCode(callback) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-compose-boundary-"));
  try {
    const code = join(root, "code");
    mkdirSync(code, { mode: 0o700 });
    callback(code);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createCompose(code) {
  const path = join(code, COMPOSE_NAME);
  writeFileSync(path, SOURCE, { mode: 0o600 });
  return path;
}
