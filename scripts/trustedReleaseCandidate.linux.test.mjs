import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertTrustedReleaseCandidateRoot,
  releaseCandidatePaths,
} from "./trustedReleaseCandidate.mjs";
import {
  trustedContainerSnapshotDigest,
} from "./trustedContainerSnapshot.mjs";

const REVISION = process.env.XINGHENG_LINUX_CANDIDATE_REVISION ?? "";
const CANONICAL_ROOT = "/opt/xingheng-release/code";
const CANONICAL_RECEIPT = "/etc/xingheng/trusted-operations.json";
const ENABLED = process.platform === "linux"
  && process.getuid?.() === 0
  && process.env.XINGHENG_LINUX_CANDIDATE_FIXTURE === "1"
  && /^[a-f0-9]{40}$/u.test(REVISION);

test("real Linux trusted candidate reaches the final release build entry only", {
  skip: !ENABLED && "requires an installed root-owned Linux release candidate",
  timeout: 30 * 60_000,
}, () => {
  const paths = releaseCandidatePaths(REVISION, "production");
  const trusted = assertTrustedReleaseCandidateRoot(paths.codeRoot, REVISION, "production");
  assert.equal(trusted.receipt.revision, REVISION);

  const randomRoot = mkdtempSync(join(tmpdir(), "xingheng-random-release-root-"));
  try {
    const randomCode = join(randomRoot, "code");
    cpSync(paths.codeRoot, randomCode, { recursive: true });
    const random = spawnSync(
      "/usr/bin/node",
      [
        `${randomCode}/scripts/trusted-operation-launcher.mjs`,
        "release-build",
        "production",
        "scripts/build-release-images.sh",
        REVISION,
        join(randomRoot, "release-manifest.json"),
      ],
      {
        cwd: randomCode,
        encoding: "utf8",
        env: fixedEnvironment(),
      },
    );
    assert.notEqual(random.status, 0);
    assert.match(random.stderr, /candidate revision|candidate release root/u);
  } finally {
    rmSync(randomRoot, { recursive: true, force: true });
  }

  const wrongRevision = `${REVISION.slice(0, 39)}${REVISION.endsWith("0") ? "1" : "0"}`;
  const rejected = invoke(paths, wrongRevision);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /candidate revision mismatch/u);
  assert.equal(exists(paths.manifest), false);
  assert.equal(exists(paths.checksums), false);

  const before = immutableHostSnapshot(trusted.receipt);
  const result = invoke(paths, REVISION);
  const after = immutableHostSnapshot(trusted.receipt);
  assert.deepEqual(after, before, "candidate build changed canonical, container, or volume state");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`built for ${REVISION}`, "u"));
  assert.match(result.stderr, /trusted-docker-receipt phase=validated kind=docker/u);
  for (const path of [paths.manifest, paths.checksums]) {
    const metadata = lstatSync(path);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.uid, 0);
    assert.equal(metadata.gid, 0);
    assert.equal(metadata.mode & 0o777, 0o444);
  }
  const checksums = readFileSync(paths.checksums, "utf8");
  assert.match(checksums, /code\.tar/u);
  assert.match(checksums, /candidate-build-receipt\.json/u);
  assert.match(checksums, /release-manifest\.json/u);
  assertTrustedReleaseCandidateRoot(paths.codeRoot, REVISION, "production");
});

test("root cannot enable the trusted Docker test seam through ambient NODE_ENV", {
  skip: !ENABLED && "requires an installed root-owned Linux release candidate",
}, () => {
  const paths = releaseCandidatePaths(REVISION, "production");
  const result = spawnSync("/usr/bin/node", [
    `${paths.codeRoot}/scripts/trusted-docker.mjs`,
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    `xingheng-api:${REVISION}`,
  ], {
    cwd: paths.codeRoot,
    encoding: "utf8",
    env: {
      ...fixedEnvironment(),
      NODE_ENV: "test",
      NODE_TEST_CONTEXT: "child-v8",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /internal to the locked release build/u);
  assert.doesNotMatch(result.stderr, /trusted-docker-receipt phase=validated/u);
});

function invoke(paths, revision) {
  return spawnSync(
    `${paths.codeRoot}/scripts/build-release-images.sh`,
    [revision, paths.manifest],
    {
      cwd: paths.codeRoot,
      encoding: "utf8",
      env: fixedEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function fixedEnvironment() {
  return {
    HOME: "/root",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
}

function immutableHostSnapshot(receipt) {
  assert.equal(sha256File(receipt.binaries.docker.path), receipt.binaries.docker.sha256);
  const daemon = JSON.parse(docker(receipt, ["info", "--format", "{{json .}}"]));
  assert.deepEqual({
    id: daemon.ID,
    rootDir: daemon.DockerRootDir,
    serverVersion: daemon.ServerVersion,
    storageDriver: daemon.Driver,
  }, receipt.daemon);

  const containerIds = docker(receipt, [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=xingheng",
    "--format",
    "{{.ID}}",
  ]).split(/\s+/u).filter(Boolean).sort();
  const containers = containerIds.length === 0
    ? []
    : JSON.parse(docker(receipt, ["container", "inspect", ...containerIds]));
  const volumeNames = docker(receipt, [
    "volume",
    "ls",
    "--filter",
    "label=com.docker.compose.project=xingheng",
    "--format",
    "{{.Name}}",
  ]).split(/\s+/u).filter(Boolean).sort();
  const volumes = volumeNames.length === 0
    ? []
    : JSON.parse(docker(receipt, ["volume", "inspect", ...volumeNames]))
      .map((item) => ({
        createdAt: item.CreatedAt,
        driver: item.Driver,
        labels: item.Labels ?? {},
        mountpoint: item.Mountpoint,
        name: item.Name,
        options: item.Options ?? {},
        scope: item.Scope,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  return {
    canonicalRoot: snapshotTree(CANONICAL_ROOT),
    canonicalReceipt: snapshotTree(CANONICAL_RECEIPT),
    containers: trustedContainerSnapshotDigest(containers),
    volumes: sha256Json(volumes),
  };
}

function docker(receipt, args) {
  const result = spawnSync(receipt.binaries.docker.path, args, {
    encoding: "utf8",
    env: {
      ...fixedEnvironment(),
      DOCKER_HOST: `unix://${receipt.socket}`,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function snapshotTree(root) {
  if (!exists(root)) return Object.freeze({ exists: false });
  const entries = [];
  walk(root, ".", entries);
  return Object.freeze({
    exists: true,
    sha256: sha256Json(entries),
    entryCount: entries.length,
  });
}

function walk(root, relativePath, entries) {
  const path = relativePath === "." ? root : join(root, relativePath);
  const metadata = lstatSync(path);
  const entry = {
    path: relativePath,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o777,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
  if (metadata.isDirectory()) {
    entries.push({ ...entry, type: "directory" });
    for (const name of readdirSync(path).sort()) {
      walk(root, relativePath === "." ? name : join(relativePath, name), entries);
    }
  } else if (metadata.isFile()) {
    entries.push({ ...entry, type: "file", sha256: sha256File(path) });
  } else if (metadata.isSymbolicLink()) {
    entries.push({ ...entry, type: "symlink", target: readlinkSync(path) });
  } else {
    entries.push({ ...entry, type: "other" });
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(`${stableJson(value)}\n`).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
