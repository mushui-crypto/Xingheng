import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
} from "node:fs";
import { join } from "node:path";

const COMPOSE_NAME = "compose.real-test.yaml";
const COMPOSE_MODE = 0o444;
const MAX_COMPOSE_BYTES = 1024 * 1024;
const O_CLOEXEC = process.platform === "linux" ? 0o2000000 : 0x1000000;

export function normalizeInstalledRealTestCompose(
  deploymentEnvironment,
  stagingCode,
  options = {},
) {
  const operations = testOperations(options);
  if (deploymentEnvironment === "production") return false;
  if (deploymentEnvironment !== "real-test") {
    throw new Error("trusted release candidate deployment environment is invalid");
  }

  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const path = join(stagingCode, COMPOSE_NAME);
  const before = lstatSync(path);
  if (!validCompose(before, expectedUid, expectedGid)) {
    throw new Error("trusted real-test Compose install boundary is invalid");
  }

  operations.beforeOpen?.(path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC,
  );
  let normalized;
  try {
    const opened = fstatSync(fd);
    if (!sameComposeIdentity(before, opened, expectedUid, expectedGid)) {
      throw new Error("trusted real-test Compose changed while opening");
    }
    operations.fchmod(fd, COMPOSE_MODE);
    operations.fsync(fd);
    normalized = fstatSync(fd);
    if (
      !sameComposeIdentity(before, normalized, expectedUid, expectedGid)
      || (normalized.mode & 0o777) !== COMPOSE_MODE
    ) {
      throw new Error("trusted real-test Compose normalization failed");
    }
  } finally {
    closeSync(fd);
  }

  operations.afterClose?.(path);
  const after = lstatSync(path);
  if (
    !sameComposeIdentity(normalized, after, expectedUid, expectedGid)
    || (after.mode & 0o777) !== COMPOSE_MODE
  ) {
    throw new Error("trusted real-test Compose changed after normalization");
  }
  return true;
}

function validCompose(value, expectedUid, expectedGid) {
  return value.isFile()
    && !value.isSymbolicLink()
    && value.uid === expectedUid
    && value.gid === expectedGid
    && value.nlink === 1
    && (value.mode & 0o022) === 0
    && value.size >= 2
    && value.size <= MAX_COMPOSE_BYTES;
}

function sameComposeIdentity(expected, actual, expectedUid, expectedGid) {
  return validCompose(actual, expectedUid, expectedGid)
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.uid === expected.uid
    && actual.gid === expected.gid
    && actual.nlink === expected.nlink;
}

function testOperations(options) {
  const keys = Object.keys(options);
  if (keys.length === 0) {
    return { fchmod: fchmodSync, fsync: fsyncSync };
  }
  if (
    process.env.NODE_TEST_CONTEXT !== "child-v8"
    || keys.some((key) => ![
      "afterClose",
      "beforeOpen",
      "expectedGid",
      "expectedUid",
      "fchmod",
      "fsync",
    ].includes(key))
  ) {
    throw new Error("trusted real-test Compose normalization options are test-only");
  }
  return {
    beforeOpen: options.beforeOpen,
    afterClose: options.afterClose,
    fchmod: options.fchmod ?? fchmodSync,
    fsync: options.fsync ?? fsyncSync,
  };
}
