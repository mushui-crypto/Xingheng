#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  acquireOperationLocks,
} from "./operationLocks.mjs";
import {
  assertNoDockerControlEnvironment,
  assertTrustedReleaseRoot,
  openTrustedHostTool,
  trustedExecutableInvocation,
  verifyTrustedHostTool,
} from "./trustedDockerRuntime.mjs";
import { assertTrustedReleaseCandidateRoot } from "./trustedReleaseCandidate.mjs";

const operation = process.argv[2];
const entryArgument = process.argv[3];
const args = process.argv.slice(4);

try {
  if (!["production", "release-build", "candidate-verify"].includes(operation) || !entryArgument) usage();
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0 || process.platform !== "linux") {
    throw new Error("trusted operation launcher requires root on Linux");
  }
  assertNoDockerControlEnvironment(process.env);
  if (
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT !== undefined
    || process.env.XINGHENG_RELEASE_CANDIDATE_REVISION !== undefined
    || process.env.XINGHENG_TRUSTED_DOCKER_PURPOSE !== undefined
  ) {
    throw new Error("nested trusted operation launcher is not allowed");
  }
  const currentRoot = new URL("../", import.meta.url).pathname;
  const candidateRevision = ["release-build", "candidate-verify"].includes(operation)
    ? basename(dirname(resolve(currentRoot)))
    : null;
  const root = candidateRevision !== null
    ? assertTrustedReleaseCandidateRoot(currentRoot, candidateRevision).root
    : assertTrustedReleaseRoot(currentRoot);
  if (candidateRevision !== null) {
    process.env.XINGHENG_OPERATION_LOCK_CONTEXT = "release-build";
    process.env.XINGHENG_RELEASE_CANDIDATE_REVISION = candidateRevision;
  }
  const entry = realpathSync(resolve(root, entryArgument));
  const entryName = entry.slice(`${root}/scripts/`.length);
  const allowedEntries = operation !== "production"
    ? [operation === "release-build"
      ? "build-release-images.sh"
      : "candidate-rwa-automation-verify.sh"]
    : [
      "production-compose.sh",
      "activate-release.sh",
      "activate-first-verified-release.sh",
      "install-gcp-wif.sh",
      "legacy-release-bridge.sh",
      "backup.sh",
      "restore.sh",
      "rwa-automation-backup.sh",
      "rwa-automation-restore.sh",
      "rwa-automation-rollback.sh",
      "rwa-automation-verify.sh",
      "provider-gate1-preflight.sh",
      "rollback-release.sh",
      "install-production-self-test-permit.sh",
      "migrate-production-self-test-permit-legacy-state.sh",
      "smoke.sh",
    ];
  if (
    !entry.startsWith(`${root}/scripts/`)
    || !allowedEntries.includes(entryName)
  ) throw new Error("trusted operation entry is not allowlisted");
  if (
    operation === "candidate-verify"
    && (
      args.length !== 1
      || !/^rwa-automation-[0-9]{8}T[0-9]{6}Z\.rwa\.enc\.json$/u.test(args[0] ?? "")
    )
  ) throw new Error("candidate verify input is invalid");

  const openedEntry = openTrustedEntry(entry);
  const openedLauncher = openTrustedEntry(resolve(root, "scripts/trusted-operation-launcher.mjs"));
  try {
    const locks = acquireOperationLocks(operation);
    try {
      const shell = openTrustedHostTool("sh", process.env);
      try {
        const childEnvironment = {
          HOME: "/root",
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TZ: "UTC",
          XINGHENG_OPERATION_LOCK_CONTEXT: operation,
        };
        if (candidateRevision !== null) {
          childEnvironment.XINGHENG_RELEASE_CANDIDATE_REVISION = candidateRevision;
        } else {
          for (const key of [
            "XINGHENG_REVISION",
            "XINGHENG_API_IMAGE",
            "XINGHENG_WEB_IMAGE",
            "XINGHENG_STRATEGY_TOOLS_IMAGE",
            "RELEASE_MANIFEST_FILE",
          ]) {
            if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
          }
        }
        const result = spawnSync(
          trustedExecutableInvocation(shell, 5),
          ["-c", ". /proc/self/fd/6", entry, ...args],
          {
            cwd: root,
            env: childEnvironment,
            stdio: [
              "inherit", "inherit", "inherit",
              locks.descriptors[0], locks.descriptors[1], shell.fd, openedEntry.fd,
              openedLauncher.fd,
            ],
          },
        );
        verifyTrustedEntry(openedEntry);
        verifyTrustedEntry(openedLauncher);
        verifyTrustedHostTool(shell);
        if (candidateRevision !== null) {
          assertTrustedReleaseCandidateRoot(root, candidateRevision);
        } else {
          assertTrustedReleaseRoot(root, process.env);
        }
        if (result.error) throw result.error;
        if (result.signal) {
          process.kill(process.pid, result.signal);
          throw new Error("trusted operation terminated by signal");
        }
        process.exitCode = result.status ?? 1;
      } finally {
        shell.close();
      }
    } finally {
      locks.close();
    }
  } finally {
    closeSync(openedEntry.fd);
    closeSync(openedLauncher.fd);
  }
} catch (error) {
  console.error(operation === "candidate-verify"
    ? "candidate_identity_invalid"
    : (error instanceof Error ? error.message : "trusted operation launcher failed"));
  process.exitCode = 1;
}

function usage() {
  throw new Error(
    "usage: trusted-operation-launcher.mjs production|release-build|candidate-verify scripts/ENTRY ARGS...",
  );
}

function openTrustedEntry(path) {
  const before = lstatSync(path);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== 0
    || before.gid !== 0
    || before.size < 1
    || before.size > 1024 * 1024
    || (before.mode & 0o022) !== 0
    || (before.mode & 0o111) === 0
  ) throw new Error("trusted operation entry boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== 0
      || opened.gid !== 0
      || opened.nlink !== 1
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || (opened.mode & 0o777) !== (before.mode & 0o777)
    ) throw new Error("trusted operation entry changed while opening");
    return {
      fd,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: sha256Descriptor(fd, opened.size),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function verifyTrustedEntry(receipt) {
  const current = fstatSync(receipt.fd);
  if (
    current.dev !== receipt.dev
    || current.ino !== receipt.ino
    || current.size !== receipt.size
    || current.uid !== 0
    || current.gid !== 0
    || current.nlink !== 1
    || current.mtimeMs !== receipt.mtimeMs
    || current.ctimeMs !== receipt.ctimeMs
    || (current.mode & 0o777) !== receipt.mode
    || sha256Descriptor(receipt.fd, receipt.size) !== receipt.sha256
  ) throw new Error("trusted operation entry changed while running");
}

function sha256Descriptor(fd, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  try {
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) throw new Error("trusted operation entry was truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
  }
}
