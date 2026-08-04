#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { productionSelfTestPermitDigest } from "./productionSelfTestPermitInstall.mjs";

try {
  const ownerUserId = process.argv[2] ?? "";
  const mode = process.argv[3] ?? "state";
  if (!/^USR-[A-Z0-9]+$/u.test(ownerUserId)) throw new Error("Permit owner is invalid");
  if (!new Set(["state", "runtime"]).has(mode)) throw new Error("Permit verification mode is invalid");
  if (process.env.NODE_ENV !== "production" || process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "true") {
    throw new Error("Server kill switch must remain enabled");
  }
  const root = resolve(process.env.RWA_AUTOMATION_DATA_DIR ?? "/app/rwa-automation-data");
  const pointer = readPrivateJson(resolve(root, "current.json"));
  if (pointer?.version !== 1 || !/^generation-(?:initial|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/u.test(pointer.generation)) {
    throw new Error("RWA automation generation pointer is invalid");
  }
  const domain = createHash("sha256").update(`rwa-user:${ownerUserId}`).digest("hex").slice(0, 16);
  const statePath = resolve(root, pointer.generation, `${domain}-binance-state.json`);
  const state = readPrivateJson(statePath);
  if (state?.version !== 1 || state.config?.killSwitchActive !== true
    || state.config?.globalExecutionEnabled !== false || state.config?.strategyEnabled !== false
    || state.config?.productionSelfTestPermitConfirmation !== null) {
    throw new Error("Persisted execution switches must remain fail-closed");
  }
  if (!Array.isArray(state.productionSelfTestPermitConsumptions)
    || state.productionSelfTestPermitConsumptions.length !== 0) {
    throw new Error("Production self-test Permit has already been consumed");
  }
  if (!Array.isArray(state.connectivitySmokes)
    || state.connectivitySmokes.some((smoke) => !["flat", "failed", "manual_intervention"].includes(smoke?.stage))) {
    throw new Error("An unfinished connectivity smoke blocks Permit installation");
  }
  if (mode === "runtime") verifyRuntimePermit(ownerUserId);
  process.stdout.write(mode === "runtime" ? "permit-runtime-safe\n" : "permit-state-safe\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Permit state verification failed");
  process.exitCode = 1;
}

function verifyRuntimePermit(ownerUserId) {
  const expectedDigest = process.argv[4] ?? "";
  const expectedRevision = process.argv[5] ?? "";
  const expectedAuthorization = process.argv[6] ?? "";
  const expectedExpiresAt = process.argv[7] ?? "";
  const permitId = process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID ?? "";
  const accountBindingSha256 = process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256 ?? "";
  const approvedCapitalUsd = Number(process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD);
  const actual = productionSelfTestPermitDigest({
    permitId,
    ownerUserId,
    accountBindingSha256,
    authorizationDigest: expectedAuthorization,
    approvedCapitalUsd,
    revision: expectedRevision,
    expiresAt: expectedExpiresAt,
  });
  if (
    !/^[a-f0-9]{64}$/u.test(expectedDigest)
    || process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED !== "true"
    || process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID !== ownerUserId
    || process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE !== '["READ","TRADE"]'
    || process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST !== expectedAuthorization
    || process.env.RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT !== expectedExpiresAt
    || process.env.XINGHENG_EXPECTED_REVISION !== expectedRevision
    || actual !== expectedDigest
  ) throw new Error("Runtime Permit identity mismatch");
}

function readPrivateJson(path) {
  const before = lstatSync(path);
  const currentUid = process.getuid?.() ?? before.uid;
  const currentGid = process.getgid?.() ?? before.gid;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== currentUid || before.gid !== currentGid
    || (before.mode & 0o777) !== 0o600 || before.size < 2 || before.size > 10 * 1024 * 1024) {
    throw new Error("Binance automation state boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error("Binance automation state changed while opening");
    }
    const text = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("Binance automation state changed while reading");
    }
    return JSON.parse(text);
  } finally {
    closeSync(fd);
  }
}
