import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import {
  openTrustedHostTool,
  trustedExecutableInvocation,
  verifyTrustedHostTool,
} from "./trustedDockerRuntime.mjs";

export const OPERATION_LOCK_ORDER = Object.freeze([
  "release-global.lock",
  "production.lock",
  "real-test.lock",
  "release-build.lock",
]);

const PRODUCTION_LOCK_ROOT = "/run/lock/xingheng";

export function acquireOperationLocks(environment, options = {}) {
  if (!["production", "real-test", "release-build"].includes(environment)) {
    throw new Error("operation lock environment is invalid");
  }
  const testMode = options.testMode === true;
  if (!testMode && (process.getuid?.() !== 0 || process.getgid?.() !== 0)) {
    throw new Error("operation locks require the controlled root operator");
  }
  const root = options.lockRoot ?? PRODUCTION_LOCK_ROOT;
  secureLockRoot(root, testMode);
  const names = [
    OPERATION_LOCK_ORDER[0],
    environment === "production"
      ? OPERATION_LOCK_ORDER[1]
      : environment === "real-test"
        ? OPERATION_LOCK_ORDER[2]
        : OPERATION_LOCK_ORDER[3],
  ];
  const held = [];
  try {
    for (const name of names) held.push(acquireOne(join(root, name), testMode, options));
    return {
      environment,
      receipts: held.map(({ fd: _fd, ...receipt }) => Object.freeze(receipt)),
      descriptors: held.map((item) => item.fd),
      close() {
        while (held.length > 0) closeSync(held.pop().fd);
      },
    };
  } catch (error) {
    while (held.length > 0) closeSync(held.pop().fd);
    throw error;
  }
}

export function inheritedOperationLocks(environment, source = process.env) {
  if (source.XINGHENG_OPERATION_LOCK_CONTEXT === undefined) return null;
  if (source.XINGHENG_OPERATION_LOCK_CONTEXT !== environment) {
    throw new Error("inherited operation lock environment mismatch");
  }
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("inherited operation locks require root");
  }
  const names = [
    OPERATION_LOCK_ORDER[0],
    environment === "production"
      ? OPERATION_LOCK_ORDER[1]
      : environment === "real-test"
        ? OPERATION_LOCK_ORDER[2]
        : OPERATION_LOCK_ORDER[3],
  ];
  const receipts = names.map((name, index) => {
    const fd = 3 + index;
    const path = join(PRODUCTION_LOCK_ROOT, name);
    const descriptor = fstatSync(fd);
    const pathMetadata = lstatSync(path);
    if (
      !descriptor.isFile()
      || descriptor.nlink !== 1
      || descriptor.uid !== 0
      || descriptor.gid !== 0
      || (descriptor.mode & 0o777) !== 0o600
      || pathMetadata.dev !== descriptor.dev
      || pathMetadata.ino !== descriptor.ino
      || pathMetadata.nlink !== 1
      || pathMetadata.uid !== 0
      || pathMetadata.gid !== 0
      || (pathMetadata.mode & 0o777) !== 0o600
    ) throw new Error("inherited operation lock descriptor is invalid");
    return {
      path,
      dev: descriptor.dev,
      ino: descriptor.ino,
      uid: descriptor.uid,
      gid: descriptor.gid,
      mode: descriptor.mode & 0o777,
    };
  });
  return {
    environment,
    receipts,
    descriptors: [3, 4],
    close() {},
  };
}

export function acquireOrUseOperationLocks(environment, source = process.env) {
  return inheritedOperationLocks(environment, source) ?? acquireOperationLocks(environment);
}

function secureLockRoot(path, testMode) {
  try {
    mkdirSync(path, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  const expectedUid = testMode ? (process.getuid?.() ?? -1) : 0;
  const expectedGid = testMode ? (process.getgid?.() ?? -1) : 0;
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== expectedUid
    || metadata.gid !== expectedGid
    || (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("operation lock root boundary is invalid");
  }
  const parentFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

function acquireOne(path, testMode, options) {
  const existed = existsNoFollow(path);
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!existed) fchmodSync(fd, 0o600);
    const before = fstatSync(fd);
    const expectedUid = testMode ? (process.getuid?.() ?? -1) : 0;
    const expectedGid = testMode ? (process.getgid?.() ?? -1) : 0;
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== expectedUid
      || before.gid !== expectedGid
      || (before.mode & 0o777) !== 0o600
    ) {
      throw new Error("operation lock file boundary is invalid");
    }
    const tool = testMode
      ? null
      : openTrustedHostTool("flock", process.env);
    try {
      const executable = tool
        ? trustedExecutableInvocation(tool, 3)
        : (options.flockPath ?? "/usr/bin/flock");
      const lockFdNumber = tool ? 4 : 3;
      const result = spawnSync(executable, ["-n", "-x", String(lockFdNumber)], {
        encoding: "utf8",
        env: {
          HOME: testMode ? "/tmp" : "/root",
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TZ: "UTC",
        },
        stdio: tool
          ? ["ignore", "pipe", "pipe", tool.fd, fd]
          : ["ignore", "pipe", "pipe", fd],
      });
      if (result.status !== 0 || result.signal || result.error) {
        throw new Error("operation lock is already held");
      }
      if (tool) verifyTrustedHostTool(tool);
    } finally {
      tool?.close();
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1
      || after.uid !== before.uid
      || after.gid !== before.gid
      || (after.mode & 0o777) !== 0o600
    ) {
      throw new Error("operation lock file changed while acquiring");
    }
    return {
      fd,
      path,
      dev: after.dev,
      ino: after.ino,
      uid: after.uid,
      gid: after.gid,
      mode: after.mode & 0o777,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
