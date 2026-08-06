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
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoDockerControlEnvironment,
  assertTrustedReleaseRoot,
  openTrustedDockerRuntime,
  trustedExecutableInvocation,
  trustedDockerReceipt,
  verifyTrustedDockerRuntime,
} from "./trustedDockerRuntime.mjs";
import { inheritedOperationLocks } from "./operationLocks.mjs";
import {
  assertPermitEnvironmentAuthorized,
  PERMIT_INSTALL_RECEIPT,
} from "./productionSelfTestPermitInstall.mjs";

const environment = process.argv[2];
const composeArgs = process.argv.slice(3);
if (environment !== "production" || composeArgs.length < 1) {
  console.error(
    "usage: verify-compose-environment-file.mjs production COMPOSE_ARGS...",
  );
  process.exit(2);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const targetEnvironment = "production";
const composeFile = resolve(repoRoot, "compose.yaml");
const project = "xingheng";
const expectedPath = resolve(repoRoot, ".env.production");

try {
  if (process.getuid?.() === 0) {
    if (inheritedOperationLocks(targetEnvironment, process.env) === null) {
      throw new Error("root Compose operation requires inherited transaction locks");
    }
  }
  assertTrustedReleaseRoot(repoRoot, process.env);
  const composeDescriptor = openSecureReleaseFile(composeFile);
  const frozenReleaseFiles = [
    secureReleaseFileReceipt(fileURLToPath(import.meta.url)),
    secureReleaseFileReceipt(resolve(repoRoot, "scripts/trustedDockerRuntime.mjs")),
    secureReleaseFileReceipt(resolve(repoRoot, "scripts/operationLocks.mjs")),
  ];
  try {
  validateComposeArguments(composeArgs, targetEnvironment);
  assertNoDockerControlEnvironment(process.env);
  if (process.env.XINGHENG_COMPOSE_ENV_FD !== undefined) {
    throw new Error(`${environment} Compose control environment is not allowed`);
  }
  const trustedCompose = openTrustedDockerRuntime("compose", process.env);
  try {
    const pluginProbe = spawnSync(
      trustedExecutableInvocation(trustedCompose, 3),
      ["docker-cli-plugin-metadata"],
      {
        encoding: "utf8",
        env: trustedCompose.environment,
        stdio: ["ignore", "pipe", "pipe", trustedCompose.fd],
      },
    );
    if (pluginProbe.status !== 0) {
      throw new Error("trusted Docker Compose plugin metadata is unavailable");
    }
    const pluginDescriptor = JSON.parse(pluginProbe.stdout);
    if (
      pluginDescriptor?.SchemaVersion !== "0.1.0"
      || pluginDescriptor?.ShortDescription !== "Docker Compose"
    ) {
      throw new Error("trusted Docker Compose plugin metadata is invalid");
    }
    verifyTrustedDockerRuntime(trustedCompose);
    console.error(trustedDockerReceipt(trustedCompose, "compose", "validated"));
  const before = lstatSync(expectedPath);
  const currentUid = process.getuid?.() ?? -1;
  const currentGid = process.getgid?.() ?? -1;
  const ownerValid = (before.uid === 0 && before.gid === 0)
    || (before.uid === currentUid && before.gid === currentGid);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > 1024 * 1024
    || (before.mode & 0o777) !== 0o600
    || !ownerValid
  ) {
    throw new Error("Compose environment file boundary is invalid");
  }
  const fd = openSync(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== before.uid
      || opened.gid !== before.gid
      || (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error("Compose environment file boundary is invalid");
    }
    const serviceFd = openSync(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const serviceOpened = fstatSync(serviceFd);
      if (
        !serviceOpened.isFile()
        || serviceOpened.nlink !== 1
        || serviceOpened.dev !== opened.dev
        || serviceOpened.ino !== opened.ino
        || serviceOpened.size !== opened.size
        || serviceOpened.uid !== opened.uid
        || serviceOpened.gid !== opened.gid
        || serviceOpened.mtimeMs !== opened.mtimeMs
        || serviceOpened.ctimeMs !== opened.ctimeMs
        || (serviceOpened.mode & 0o777) !== 0o600
      ) {
        throw new Error("Compose environment descriptors do not identify the same file object");
      }
      const bytes = Buffer.allocUnsafe(opened.size);
      let environmentEntries;
      let sha256;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) throw new Error("Compose environment file was truncated");
          offset += count;
        }
        environmentEntries = parseEnvironmentEntries(bytes);
        validateEnvironmentIdentity(targetEnvironment, environmentEntries);
        sha256 = createHash("sha256").update(bytes).digest("hex");
        assertPermitEnvironmentAuthorized({
          entries: environmentEntries,
          environmentSha256: sha256,
          composeArgs,
          operationEntry: process.env.XINGHENG_TRUSTED_OPERATION_ENTRY,
          operationId: process.env.XINGHENG_PERMIT_INSTALL_OPERATION_ID,
          receiptPath: PERMIT_INSTALL_RECEIPT,
        });
        const after = fstatSync(fd);
        if (
          after.dev !== opened.dev
          || after.ino !== opened.ino
          || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs
          || after.ctimeMs !== opened.ctimeMs
        ) {
          throw new Error("Compose environment file changed while being verified");
        }
      } finally {
        bytes.fill(0);
      }
      const inheritedEnvironment = { ...trustedCompose.environment };
      for (const key of environmentEntries.keys()) delete inheritedEnvironment[key];
      if (process.platform !== "linux") {
        // /dev/fd duplicates share an offset. Compose can open its project env
        // more than once, so provide interpolation values parsed from these same
        // verified bytes; service env_file still consumes its independent FD.
        for (const [key, value] of environmentEntries) inheritedEnvironment[key] = value;
      }
      const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
      const interpolationFdPath = `${descriptorRoot}/3`;
      const serviceFdPath = `${descriptorRoot}/4`;
      const composeFdPath = `${descriptorRoot}/6`;
      inheritedEnvironment.XINGHENG_COMPOSE_ENV_FD = serviceFdPath;
      console.error(
        `compose-env-receipt phase=validated environment=${environment}`
        + " interpolationFd=3 serviceFd=4"
        + ` dev=${opened.dev} ino=${opened.ino} size=${opened.size} sha256=${sha256}`,
      );
      const result = spawnSync(
        trustedExecutableInvocation(trustedCompose, 5),
        [
          "--env-file", interpolationFdPath,
          "-f", composeFdPath,
          "-p", project,
          ...composeArgs,
        ],
        {
          env: inheritedEnvironment,
          stdio: [
            "inherit", "inherit", "inherit",
            fd, serviceFd, trustedCompose.fd, composeDescriptor.fd,
          ],
        },
      );
      assertOpenReleaseFileUnchanged(composeDescriptor);
      for (const receipt of frozenReleaseFiles) {
        assertReleaseFileReceiptUnchanged(receipt, secureReleaseFileReceipt(receipt.path));
      }
      verifyTrustedDockerRuntime(trustedCompose);
      console.error(trustedDockerReceipt(trustedCompose, "compose", "consumed"));
      const consumed = fstatSync(fd);
      const serviceConsumed = fstatSync(serviceFd);
      const consumedSha256 = sha256Descriptor(fd, opened.size);
      const serviceConsumedSha256 = sha256Descriptor(serviceFd, serviceOpened.size);
      if (
        consumed.dev !== opened.dev
        || consumed.ino !== opened.ino
        || consumed.size !== opened.size
        || consumed.mtimeMs !== opened.mtimeMs
        || consumed.uid !== opened.uid
        || consumed.gid !== opened.gid
        || (consumed.mode & 0o777) !== 0o600
        || serviceConsumed.dev !== serviceOpened.dev
        || serviceConsumed.ino !== serviceOpened.ino
        || serviceConsumed.size !== serviceOpened.size
        || serviceConsumed.mtimeMs !== serviceOpened.mtimeMs
        || serviceConsumed.uid !== serviceOpened.uid
        || serviceConsumed.gid !== serviceOpened.gid
        || (serviceConsumed.mode & 0o777) !== 0o600
        || consumedSha256 !== sha256
        || serviceConsumedSha256 !== sha256
      ) {
        throw new Error("Compose environment descriptor changed while Compose was running");
      }
      if (result.error) throw result.error;
      if (result.signal) {
        process.kill(process.pid, result.signal);
        throw new Error("Compose process terminated");
      }
      console.error(
        `compose-env-receipt phase=consumed environment=${environment}`
        + " interpolationFd=3 serviceFd=4"
        + ` dev=${opened.dev} ino=${opened.ino} size=${opened.size} sha256=${sha256}`,
      );
      process.exitCode = result.status ?? 1;
    } finally {
      closeSync(serviceFd);
    }
  } finally {
    closeSync(fd);
  }
  } finally {
    trustedCompose.close();
  }
  } finally {
    closeSync(composeDescriptor.fd);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Compose environment file verification failed");
  process.exit(1);
}

function openSecureReleaseFile(path) {
  const receipt = secureReleaseFileReceipt(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== receipt.dev
      || opened.ino !== receipt.ino
      || opened.size !== receipt.size
      || opened.uid !== receipt.uid
      || opened.gid !== receipt.gid
      || opened.mtimeMs !== receipt.mtimeMs
      || opened.ctimeMs !== receipt.ctimeMs
      || (opened.mode & 0o777) !== receipt.mode
    ) {
      throw new Error("operational release file changed while opening descriptor");
    }
    return { ...receipt, fd };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertOpenReleaseFileUnchanged(receipt) {
  const current = fstatSync(receipt.fd);
  if (
    current.dev !== receipt.dev
    || current.ino !== receipt.ino
    || current.size !== receipt.size
    || current.uid !== receipt.uid
    || current.gid !== receipt.gid
    || current.mtimeMs !== receipt.mtimeMs
    || current.ctimeMs !== receipt.ctimeMs
    || (current.mode & 0o777) !== receipt.mode
    || sha256Descriptor(receipt.fd, receipt.size) !== receipt.sha256
  ) throw new Error("operational release descriptor changed while Compose was running");
}

function secureReleaseFileReceipt(path) {
  const before = lstatSync(path);
  const expectedUid = process.getuid?.() ?? -1;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || ![0, expectedUid].includes(before.uid)
    || before.size < 1
    || before.size > 4 * 1024 * 1024
    || (before.mode & 0o022) !== 0
  ) {
    throw new Error("operational release file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== before.uid
      || opened.gid !== before.gid
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
      || (opened.mode & 0o777) !== (before.mode & 0o777)
    ) {
      throw new Error("operational release file changed while opening");
    }
    return {
      path,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      uid: opened.uid,
      gid: opened.gid,
      mode: opened.mode & 0o777,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: sha256Descriptor(fd, opened.size),
    };
  } finally {
    closeSync(fd);
  }
}

function assertReleaseFileReceiptUnchanged(before, after) {
  for (const key of [
    "path", "dev", "ino", "size", "uid", "gid", "mode", "mtimeMs", "ctimeMs", "sha256",
  ]) {
    if (before[key] !== after[key]) {
      throw new Error("operational release file changed while Compose was running");
    }
  }
}

function sha256Descriptor(fd, size) {
  const bytes = Buffer.allocUnsafe(size);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Compose environment descriptor was truncated");
      offset += count;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function validateEnvironmentIdentity(_targetEnvironment, entries) {
  if (!entries.has("DOMAIN")) {
    throw new Error("Production Compose environment file is missing DOMAIN");
  }
}

function parseEnvironmentEntries(bytes) {
  if (bytes.includes(0)) throw new Error("Compose environment file contains a NUL byte");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Compose environment file is not valid UTF-8");
  }
  const entries = new Map();
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/u.exec(line);
    if (!match) throw new Error("Compose environment file contains an invalid assignment");
    const key = match[1];
    if (seen.has(key)) throw new Error(`Compose environment file contains duplicate key ${key}`);
    if (
      key.startsWith("DOCKER_")
      || key.startsWith("COMPOSE_")
      || key === "XINGHENG_COMPOSE_ENV_FD"
    ) {
      throw new Error("Compose environment file contains Docker control input");
    }
    seen.add(key);
    entries.set(key, parseEnvironmentValue(match[2]));
  }
  if (entries.size === 0) throw new Error("Compose environment file has no assignments");
  return entries;
}

function parseEnvironmentValue(source) {
  const value = source.trim();
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new Error("Compose environment file contains an unterminated quoted value");
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw new Error("Compose environment file contains an unterminated quoted value");
    }
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\r", "\r");
  }
  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function validateComposeArguments(args, targetEnvironment) {
  const remaining = [];
  const profiles = [];
  let commandFound = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!commandFound && value === "--profile") {
      if (index + 1 >= args.length) throw new Error(`${targetEnvironment} Compose global option is incomplete`);
      profiles.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (!commandFound && value.startsWith("--profile=")) {
      profiles.push(value.slice("--profile=".length));
      continue;
    }
    if (!commandFound && (value === "--env-file" || value.startsWith("--env-file="))) {
      throw new Error(`${targetEnvironment} Compose env file override is not allowed`);
    }
    if (!commandFound && (
      value === "--file" || value.startsWith("--file=") || value.startsWith("-f")
      || value === "--project-name" || value.startsWith("--project-name=") || value.startsWith("-p")
      || value === "--project-directory" || value.startsWith("--project-directory=")
    )) {
      throw new Error(`${targetEnvironment} Compose topology override is not allowed`);
    }
    if (!commandFound) commandFound = true;
    remaining.push(value);
  }
  const allowedProfiles = new Set([
    "strategy-tools",
    "rwa-automation-ops",
    "sqlite-ops",
    "provider-identity-preflight",
    "rwa-automation-verify",
  ]);
  if (
    profiles.some((profile) => !allowedProfiles.has(profile))
    || new Set(profiles).size !== profiles.length
  ) {
    throw new Error(`${targetEnvironment} Compose profile set is not allowed`);
  }
  if (!isAllowedComposeOperation(remaining, new Set(profiles))) {
    throw new Error(`${targetEnvironment} Compose operation is not allowed`);
  }
}

function isAllowedComposeOperation(args, profiles) {
  if (sameArgs(args, ["config"]) || sameArgs(args, ["config", "--format", "json"])) return true;
  if (
    sameArgs(args, ["up", "-d", "api", "web"])
    || sameArgs(args, ["up", "-d", "api"])
    || sameArgs(args, ["up", "-d", "web"])
    || sameArgs(args, ["stop", "api"])
    || sameArgs(args, ["stop", "api", "web"])
    || sameArgs(args, ["ps"])
    || sameArgs(args, ["logs", "-f", "api"])
    || sameArgs(args, ["logs", "--tail=200", "api"])
    || sameArgs(args, ["logs", "--tail=200", "api", "web"])
  ) {
    return profiles.size === 0;
  }
  if (
    profiles.has("provider-identity-preflight")
    && profiles.size === 1
    && sameArgs(args, [
      "run", "--rm", "--no-deps", "provider-identity-preflight",
    ])
  ) return true;
  if (
    profiles.size === 0
    && sameArgs(args, [
      "exec", "-T", "api", "node",
      "/app/scripts/verify-production-self-test-permit-state.mjs", "window",
    ])
  ) return true;
  if (
    profiles.size === 0
    && args.length === 6
    && sameArgs(args.slice(0, 5), [
      "exec", "-T", "api", "node", "/app/scripts/verify-production-self-test-permit-state.mjs",
    ])
    && /^USR-[A-Z0-9]+$/u.test(args[5])
  ) return true;
  if (
    profiles.has("rwa-automation-verify")
    && profiles.size === 1
    && sameArgs(args, ["run", "--rm", "--no-deps", "rwa-automation-verify"])
  ) return true;
  if (
    profiles.has("sqlite-ops")
    && profiles.size === 1
    && isProductionSqliteRestoreOperation(args)
  ) return true;
  if (
    profiles.has("rwa-automation-ops")
    && profiles.size === 1
    && sameArgs(args, ["run", "--rm", "--no-deps", "rwa-automation-backup"])
  ) return true;
  if (
    profiles.size === 0
    && sameArgs(args, [
      "run", "--rm", "--no-deps", "--entrypoint", "node", "api",
      "dist-server/operations/rwa-activation-preflight.js",
    ])
  ) return true;
  if (
    profiles.size === 0
    && isProductionSmokeOperation(args)
  ) return true;
  if (
    profiles.size === 0
    && sameArgs(args, ["exec", "-T", "api", "/app/scripts/sqlite-backup.sh"])
  ) return true;
  if (
    profiles.has("strategy-tools")
    && profiles.size === 1
    && (
      sameArgs(args, ["run", "--rm", "strategy-history"])
      || sameArgs(args, [
        "run", "--rm", "strategy-history", "npm", "run", "strategy:history:check", "--",
        "/app/strategy-data/route-b-history.json",
      ])
    )
  ) return true;
  if (
    profiles.has("rwa-automation-ops")
    && profiles.size === 1
    && isProductionRwaRestoreOperation(args)
  ) return true;
  return false;
}

function isProductionSmokeOperation(args) {
  return args.length === 8
    && sameArgs(args.slice(0, 4), ["run", "--rm", "--no-deps", "-e"])
    && /^SMOKE_BASE_URL=https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(args[4])
    && !args[4].includes("..")
    && sameArgs(args.slice(5), [
      "api", "node", "/app/scripts/deployment-smoke.mjs",
    ]);
}

function isProductionSqliteRestoreOperation(args) {
  return args.length === 6
    && sameArgs(args.slice(0, 4), ["run", "--rm", "--no-deps", "-e"])
    && /^SQLITE_RESTORE_FILE=trading-[0-9]{8}T[0-9]{6}Z\.sqlite$/u.test(args[4])
    && args[5] === "sqlite-restore";
}

function isProductionRwaRestoreOperation(args) {
  if (sameArgs(args, [
    "run", "--rm", "--no-deps", "rwa-automation-restore",
    "flock", "-n", "-x", "/app/rwa-automation-lock/operation.lock",
    "node", "dist-server/operations/rwa-automation-backup.js", "rollback",
  ])) return true;
  if (args.length !== 6 || !sameArgs(args.slice(0, 4), ["run", "--rm", "--no-deps", "-e"])) {
    return false;
  }
  return /^RWA_AUTOMATION_RESTORE_FILE=rwa-automation-[0-9]{8}T[0-9]{6}Z\.rwa\.enc\.json$/u.test(args[4])
    && args[5] === "rwa-automation-restore";
}

function sameArgs(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}
