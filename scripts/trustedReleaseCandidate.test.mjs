import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertTrustedReleaseCandidateRoot,
  captureTrustedCandidateTree,
  readTrustedReleaseCandidateReceipt,
  releaseCandidatePaths,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";
import { validateTrustedReleaseBuildDockerArguments } from "./trustedDockerRuntime.mjs";

const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);

test("candidate receipt binds one fixed revision root, archive and exact source tree", () => {
  withCandidate(({ paths, options }) => {
    const result = assertTrustedReleaseCandidateRoot(paths.codeRoot, REVISION, options);
    assert.equal(result.receipt.revision, REVISION);
    assert.equal(result.paths.manifest, join(paths.candidateRoot, "release-manifest.json"));
    assert.equal(result.paths.checksums, join(paths.candidateRoot, "RELEASE_SHA256SUMS"));
    assert.equal(result.receipt.candidateTree.fileCount, 24);
  });
});

test("random roots and revision/path substitutions are rejected", () => {
  withCandidate(({ root, paths, options }) => {
    const random = join(root, "random", "code");
    mkdirSync(random, { recursive: true, mode: 0o700 });
    assert.throws(
      () => assertTrustedReleaseCandidateRoot(random, REVISION, options),
      /root identity mismatch/u,
    );
    assert.throws(
      () => assertTrustedReleaseCandidateRoot(paths.codeRoot, OTHER_REVISION, options),
      /root identity mismatch|ENOENT/u,
    );
  });
});

test("candidate content, inode and receipt hash replacement fail closed", () => {
  for (const mutate of [
    ({ paths }) => writeFileSync(join(paths.codeRoot, "source-00.txt"), "changed\n"),
    ({ paths }) => {
      const target = join(paths.codeRoot, "source-01.txt");
      const pending = `${target}.replacement`;
      writeFileSync(pending, "source-01\n", { mode: 0o600 });
      renameSync(pending, target);
    },
    ({ paths }) => {
      const source = JSON.parse(
        readFileSync(paths.receipt, "utf8"),
      );
      source.candidateTree.sha256 = "f".repeat(64);
      chmodSync(paths.receipt, 0o600);
      writeFileSync(paths.receipt, `${JSON.stringify(source)}\n`, { mode: 0o400 });
      chmodSync(paths.receipt, 0o400);
    },
    ({ paths }) => {
      chmodSync(paths.archive, 0o600);
      writeFileSync(paths.archive, "changed-archive\n");
      chmodSync(paths.archive, 0o400);
    },
    ({ paths }) => {
      const pending = `${paths.archive}.replacement`;
      writeFileSync(pending, readFileSync(paths.archive), { mode: 0o400 });
      chmodSync(pending, 0o400);
      renameSync(pending, paths.archive);
    },
  ]) {
    withCandidate(({ paths, options }) => {
      mutate({ paths });
      assert.throws(
        () => readTrustedReleaseCandidateReceipt(REVISION, options),
        /identity mismatch|boundary is invalid/u,
      );
    });
  }
});

test("release-build Docker allowlist excludes containers, volumes and runtime mutation", () => {
  const source = {
    XINGHENG_OPERATION_LOCK_CONTEXT: "release-build",
    XINGHENG_RELEASE_CANDIDATE_REVISION: REVISION,
  };
  assert.doesNotThrow(() => validateTrustedReleaseBuildDockerArguments([
    "build",
    "--build-arg",
    `XINGHENG_REVISION=${REVISION}`,
    "--target",
    "api",
    "--platform",
    "linux/amd64",
    "--tag",
    `xingheng-api:${REVISION}`,
    "/tmp/xingheng-release.Ab12c3",
  ], source));
  assert.doesNotThrow(() => validateTrustedReleaseBuildDockerArguments([
    "image",
    "inspect",
    "--format",
    "{{json .}}",
    `sha256:${"1".repeat(64)}`,
  ], source));
  for (const format of ["{{.Id}}", "{{.Os}}/{{.Architecture}}"]) {
    assert.doesNotThrow(() => validateTrustedReleaseBuildDockerArguments([
      "image",
      "inspect",
      "--format",
      format,
      `xingheng-api:${REVISION}`,
    ], source));
  }
  for (const args of [
    ["ps"],
    ["run", "--rm", `xingheng-api:${REVISION}`],
    ["container", "inspect", "production-api"],
    ["volume", "ls"],
    ["image", "rm", `xingheng-api:${REVISION}`],
    ["compose", "up"],
    [
      "build",
      "--build-arg",
      `XINGHENG_REVISION=${REVISION}`,
      "--target",
      "api",
      "--platform",
      "linux/amd64",
      "--tag",
      `xingheng-api:${REVISION}`,
      "/tmp/xingheng-release.Ab12c3/../../etc",
    ],
    [
      "build",
      "--build-arg",
      `XINGHENG_REVISION=${REVISION}`,
      "--target",
      "api",
      "--platform",
      "linux/amd64",
      "--tag",
      `xingheng-api:${OTHER_REVISION}`,
      "/tmp/xingheng-release.Ab12c3",
    ],
    ["image", "inspect", "--format", "{{.Id}}", `xingheng-api:${OTHER_REVISION}`],
    ["image", "inspect", "--format", "{{json .}}", `xingheng-api:${REVISION}`],
  ]) {
    assert.throws(
      () => validateTrustedReleaseBuildDockerArguments(args, source),
      /not allowlisted/u,
    );
  }
});

function withCandidate(callback) {
  const root = mkdtempSync(join(tmpdir(), "xingheng-candidate-"));
  try {
    chmodSync(root, 0o700);
    const candidatesRoot = join(root, "candidates");
    const options = {
      candidatesRoot,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      skipParentChain: true,
    };
    const paths = releaseCandidatePaths(REVISION, options);
    mkdirSync(paths.codeRoot, { recursive: true, mode: 0o700 });
    chmodSync(paths.candidatesRoot, 0o700);
    chmodSync(paths.candidateRoot, 0o700);
    chmodSync(paths.codeRoot, 0o700);
    for (let index = 0; index < 24; index += 1) {
      writeFileSync(
        join(paths.codeRoot, `source-${String(index).padStart(2, "0")}.txt`),
        `source-${String(index).padStart(2, "0")}\n`,
        { mode: 0o600 },
      );
    }
    writeFileSync(paths.archive, "git-archive-fixture\n", { mode: 0o400 });
    chmodSync(paths.archive, 0o400);
    const receipt = {
      schemaVersion: 1,
      revision: REVISION,
      candidateRoot: paths.candidateRoot,
      codeRoot: paths.codeRoot,
      sourceArchive: secureArtifactReceipt(paths.archive, 0o400, options),
      candidateTree: captureTrustedCandidateTree(paths.codeRoot, options),
      socket: "/var/run/docker.sock",
      binaries: Object.fromEntries(
        [
          ["node", "/usr/bin/node"],
          ["sh", "/usr/bin/dash"],
          ["flock", "/usr/bin/flock"],
          ["findmnt", "/usr/bin/findmnt"],
          ["git", "/usr/bin/git"],
          ["tar", "/usr/bin/tar"],
          ["sha256sum", "/usr/bin/sha256sum"],
          ["docker", "/usr/bin/docker"],
          ["compose", "/usr/libexec/docker/cli-plugins/docker-compose"],
        ].map(([name, path]) => [name, { path, sha256: "1".repeat(64) }]),
      ),
      daemon: {
        id: "fixture-daemon-id",
        rootDir: "/var/lib/docker",
        serverVersion: "29.0.0",
        storageDriver: "overlay2",
      },
    };
    writeFileSync(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o400 });
    chmodSync(paths.receipt, 0o400);
    callback({ root, paths, options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
