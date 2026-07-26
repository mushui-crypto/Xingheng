#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixedTarget = resolve(realpathSync(repoRoot), ".env.production");

try {
  const [operation, source, target, receipt] = process.argv.slice(2);
  const requestedTarget = target
    ? resolve(realpathSync(dirname(resolve(target))), ".env.production")
    : "";
  if (requestedTarget !== fixedTarget || resolve(target ?? "") !== resolve(dirname(target ?? ""), ".env.production")) {
    throw new Error("production environment target is not fixed");
  }
  if (operation === "install" && source && !receipt) {
    const bytes = readSecureEnvironment(source);
    let fd;
    try {
      fd = openSync(
        fixedTarget,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const created = fstatSync(fd);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        fchmodSync(fd, 0o600);
        const metadata = fstatSync(fd);
        assertInstalledMetadata(metadata);
        const published = lstatSync(fixedTarget);
        if (published.dev !== metadata.dev || published.ino !== metadata.ino) {
          throw new Error("production environment target identity changed while installing");
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        process.stdout.write(`${metadata.dev}:${metadata.ino}:${sha256}\n`);
      } catch (error) {
        try {
          const current = lstatSync(fixedTarget);
          if (current.dev === created.dev && current.ino === created.ino) unlinkSync(fixedTarget);
        } catch {
          // Preserve the original failure.
        }
        throw error;
      }
    } finally {
      bytes.fill(0);
      if (fd !== undefined) closeSync(fd);
    }
  } else if (operation === "uninstall" && source === "-" && receipt) {
    const match = /^([0-9]+):([0-9]+):([a-f0-9]{64})$/u.exec(receipt);
    if (!match) throw new Error("production environment receipt is invalid");
    const bytes = readSecureEnvironment(fixedTarget);
    try {
      const metadata = lstatSync(fixedTarget);
      if (
        metadata.dev !== Number(match[1])
        || metadata.ino !== Number(match[2])
        || createHash("sha256").update(bytes).digest("hex") !== match[3]
      ) {
        throw new Error("production environment identity changed before rollback");
      }
      unlinkSync(fixedTarget);
    } finally {
      bytes.fill(0);
    }
  } else {
    throw new Error(
      "usage: install-production-environment.mjs install SOURCE FIXED_TARGET | uninstall - FIXED_TARGET RECEIPT",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "production environment installation failed");
  process.exit(1);
}

function readSecureEnvironment(path) {
  const before = lstatSync(path);
  const currentUid = process.getuid?.() ?? -1;
  const currentGid = process.getgid?.() ?? -1;
  const ownerValid = (before.uid === 0 && before.gid === 0)
    || (before.uid === currentUid && before.gid === currentGid);
  if (
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600 || !ownerValid
    || before.size < 1 || before.size > 1024 * 1024
  ) throw new Error("production environment source boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs
      || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
    ) throw new Error("production environment source identity changed");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) {
      bytes.fill(0);
      throw new Error("production environment source changed while reading");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function assertInstalledMetadata(metadata) {
  const currentUid = process.getuid?.() ?? -1;
  const currentGid = process.getgid?.() ?? -1;
  const ownerValid = (metadata.uid === 0 && metadata.gid === 0)
    || (metadata.uid === currentUid && metadata.gid === currentGid);
  if (
    !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || !ownerValid
  ) throw new Error("production environment target boundary is invalid");
}
