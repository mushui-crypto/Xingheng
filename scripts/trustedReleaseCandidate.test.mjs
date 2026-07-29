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
  PRODUCTION_RELEASE_CANDIDATES_ROOT,
  REAL_TEST_RELEASE_CANDIDATES_ROOT,
  assertTrustedReleaseCandidateRoot,
  captureTrustedCandidateTree,
  readTrustedReleaseCandidateReceipt,
  releaseCandidatePaths,
  secureArtifactReceipt,
} from "./trustedReleaseCandidate.mjs";
import { validateTrustedReleaseBuildDockerArguments } from "./trustedDockerRuntime.mjs";

const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);

test("deployment identity selects only the two canonical candidate roots", () => {
  assert.equal(
    releaseCandidatePaths(REVISION, "production").candidatesRoot,
    PRODUCTION_RELEASE_CANDIDATES_ROOT,
  );
  assert.equal(
    releaseCandidatePaths(REVISION, "real-test").candidatesRoot,
    REAL_TEST_RELEASE_CANDIDATES_ROOT,
  );
  assert.equal(
    releaseCandidatePaths(REVISION, "real-test").incomingArchive,
    `${REAL_TEST_RELEASE_CANDIDATES_ROOT}/.incoming-${REVISION}.tar`,
  );
  for (const environment of [undefined, "", "test", "PRODUCTION"]) {
    assert.throws(
      () => releaseCandidatePaths(REVISION, environment),
      /deployment environment is invalid/u,
    );
  }
  assert.throws(
    () => releaseCandidatePaths(REVISION, "real-test", {
      candidatesRoot: "/tmp/arbitrary",
    }),
    /root override is not allowed/u,
  );
  assert.throws(
    () => releaseCandidatePaths("a".repeat(7), "real-test"),
    /full lowercase Git commit/u,
  );
  const production = releaseCandidatePaths(REVISION, "production");
  const realTest = releaseCandidatePaths(REVISION, "real-test");
  assert.throws(
    () => assertTrustedReleaseCandidateRoot(
      production.codeRoot,
      REVISION,
      "real-test",
    ),
    /root identity mismatch/u,
  );
  assert.throws(
    () => assertTrustedReleaseCandidateRoot(
      realTest.codeRoot,
      REVISION,
      "production",
    ),
    /root identity mismatch/u,
  );
});

test("candidate receipt binds one fixed revision root, archive and exact source tree", () => {
  for (const deploymentEnvironment of ["production", "real-test"]) {
    withCandidate(({ paths, options }) => {
      const result = assertTrustedReleaseCandidateRoot(
        paths.codeRoot,
        REVISION,
        deploymentEnvironment,
        options,
      );
      assert.equal(result.receipt.revision, REVISION);
      assert.equal(result.receipt.candidateRoot, paths.candidateRoot);
      assert.equal(result.receipt.codeRoot, paths.codeRoot);
      assert.equal(result.paths.manifest, join(paths.candidateRoot, "release-manifest.json"));
      assert.equal(result.paths.checksums, join(paths.candidateRoot, "RELEASE_SHA256SUMS"));
      assert.equal(result.receipt.candidateTree.fileCount, 24);
    }, deploymentEnvironment);
  }
});

test("random roots and revision/path substitutions are rejected", () => {
  withCandidate(({ root, paths, options }) => {
    const random = join(root, "random", "code");
    mkdirSync(random, { recursive: true, mode: 0o700 });
    assert.throws(
      () => assertTrustedReleaseCandidateRoot(random, REVISION, "production", options),
      /root identity mismatch/u,
    );
    assert.throws(
      () => assertTrustedReleaseCandidateRoot(
        paths.codeRoot,
        OTHER_REVISION,
        "production",
        options,
      ),
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
      const source = JSON.parse(readFileSync(paths.receipt, "utf8"));
      source.candidateRoot = `${paths.candidateRoot}-mixed`;
      chmodSync(paths.receipt, 0o600);
      writeFileSync(paths.receipt, `${JSON.stringify(source)}\n`, { mode: 0o400 });
      chmodSync(paths.receipt, 0o400);
    },
    ({ paths }) => {
      const source = JSON.parse(readFileSync(paths.receipt, "utf8"));
      source.codeRoot = `${paths.codeRoot}-mixed`;
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
    ({ paths }) => chmodSync(join(paths.codeRoot, "compose.real-test.yaml"), 0o600),
  ]) {
    withCandidate(({ paths, options }) => {
      mutate({ paths });
      assert.throws(
        () => readTrustedReleaseCandidateReceipt(REVISION, "production", options),
        /identity mismatch|boundary is invalid|receipt schema is invalid/u,
      );
    });
  }
});

test("release-build Docker allowlist excludes containers, volumes and runtime mutation", () => {
  const source = {
    XINGHENG_OPERATION_LOCK_CONTEXT: "release-build",
    XINGHENG_RELEASE_CANDIDATE_REVISION: REVISION,
    XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT: "production",
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
  for (const deploymentEnvironment of [undefined, "", "staging", "Production"]) {
    assert.throws(
      () => validateTrustedReleaseBuildDockerArguments([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        `xingheng-api:${REVISION}`,
      ], {
        ...source,
        XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT: deploymentEnvironment,
      }),
      /deployment environment is invalid/u,
    );
  }
});

function withCandidate(callback, deploymentEnvironment = "production") {
  const root = mkdtempSync(join(tmpdir(), "xingheng-candidate-"));
  try {
    chmodSync(root, 0o700);
    const candidatesRoot = join(root, "candidates");
    const options = {
      candidatesRoot,
      testOnlyCandidatesRoot: true,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      skipParentChain: true,
    };
    const paths = releaseCandidatePaths(REVISION, deploymentEnvironment, options);
    mkdirSync(paths.codeRoot, { recursive: true, mode: 0o700 });
    chmodSync(paths.candidatesRoot, 0o700);
    chmodSync(paths.candidateRoot, 0o700);
    chmodSync(paths.codeRoot, 0o700);
    writeFileSync(
      join(paths.codeRoot, "compose.real-test.yaml"),
      "services:\n  api:\n    image: fixed\n",
      { mode: 0o444 },
    );
    for (let index = 0; index < 23; index += 1) {
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
