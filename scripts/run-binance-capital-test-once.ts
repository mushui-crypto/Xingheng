import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FundingArbitrageExecutionIntent } from "../server/modules/cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { BinanceCapitalTestRuntimeResult } from "../server/modules/binance/BinanceCapitalTestRuntime";
import { executeBinanceCapitalTest } from "../server/modules/binance/BinanceCapitalTestRuntime";
import {
  preflightBinanceCapitalTest,
  type BinanceCapitalTestExecutionContext,
} from "../server/modules/binance/BinanceCapitalTestPreflight";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "../server/modules/binance/BinanceInstrumentCatalog";
import { BinancePersonalTradingServiceRegistry } from "../server/modules/binance/BinancePersonalTradingServiceRegistry";
import { loadBinanceTradingConfig } from "../server/modules/binance/BinanceTradingConfig";
import type { BinancePreflightSnapshot } from "../server/modules/binance/BinanceTypes";
import { GcpKmsCredentialKeyProvider } from "../server/modules/credentials/GcpKmsCredentialKeyProvider";
import { UserExchangeCredentialStore } from "../server/modules/credentials/UserExchangeCredentialStore";

export const CAPITAL_TEST_USER_ID = "USR-MRDQ6DT1";
export const CAPITAL_TEST_QUANTITY_XAUT = "0.002";
const CAPITAL_TEST_MAX_RESIDUAL_XAUT = "0";
const CAPITAL_TEST_MAX_LEG_START_SKEW_MS = 500;
const CAPITAL_TEST_INTENT_TTL_MS = 60_000;
const CAPITAL_TEST_API_HEALTH_URL = "http://api:8787/api/health";

type CapitalTestResult =
  | "CLAIMED"
  | "PREFLIGHT_FAILED"
  | "PASS"
  | "FAILED_CLOSED"
  | "PENDING_RECONCILIATION"
  | "FAILED";

export type CapitalTestReceipt = Readonly<{
  executionId: string;
  timestamp: number;
  userId: typeof CAPITAL_TEST_USER_ID;
  revision: string;
  result: CapitalTestResult;
  preflight?: BinanceCapitalTestRuntimeResult["preflight"];
  attempts?: BinanceCapitalTestRuntimeResult["attempts"];
  legs?: BinanceCapitalTestRuntimeResult["executionState"] extends infer State
    ? State extends { legs: infer Legs } ? Legs : never
    : never;
  aggregateStatus?: BinanceCapitalTestRuntimeResult["executionState"] extends infer State
    ? State extends { status: infer Status } ? Status : never
    : never;
  residualQuantity?: string | null;
  exitStatus?: string | null;
  finalAccount?: Readonly<{
    spotQuantityXaut: number;
    perpetualQuantityXaut: number;
    openOrderCount: number;
    flatOrDust: boolean;
  }>;
  message?: string;
}>;

type RegistryPort = Pick<BinancePersonalTradingServiceRegistry, "run">;

export type CapitalTestHarnessDependencies = Readonly<{
  now: () => number;
  assertApiStopped: () => Promise<void>;
  claimReceipt: (receipt: CapitalTestReceipt) => void;
  appendReceipt: (receipt: CapitalTestReceipt) => void;
  createRegistry: () => Readonly<{ registry: RegistryPort; close: () => void }>;
  executeCapitalTest: typeof executeBinanceCapitalTest;
}>;

export async function runBinanceCapitalTestOnce(
  source: NodeJS.ProcessEnv,
  dependencies: CapitalTestHarnessDependencies,
) {
  const startup = validateStartup(source);
  await dependencies.assertApiStopped();

  const executionId = stableExecutionId(startup.revision);
  const claimedAt = dependencies.now();
  assertTimestamp(claimedAt);
  dependencies.claimReceipt(baseReceipt(executionId, startup.revision, claimedAt, "CLAIMED"));

  let handle: ReturnType<CapitalTestHarnessDependencies["createRegistry"]> | null = null;
  try {
    handle = dependencies.createRegistry();
    const snapshot = await readBoundSnapshot(handle.registry);
    const context: BinanceCapitalTestExecutionContext = {
      userId: CAPITAL_TEST_USER_ID,
      accountId: snapshot.accountId,
      venue: "binance",
    };
    const intent = fixedIntent(executionId, claimedAt);
    assertFixedIntent(intent);

    const localPreflight = preflightBinanceCapitalTest(
      context,
      intent,
      snapshot,
      claimedAt,
      startup.maxSlippageBps,
    );
    if (localPreflight.status === "FAIL") {
      const receipt: CapitalTestReceipt = {
        ...baseReceipt(executionId, startup.revision, dependencies.now(), "PREFLIGHT_FAILED"),
        preflight: localPreflight,
        message: "Capital test stopped before mutation because the local preflight failed.",
      };
      dependencies.appendReceipt(receipt);
      return receipt;
    }

    const runtime = await dependencies.executeCapitalTest(
      handle.registry,
      CAPITAL_TEST_USER_ID,
      context,
      intent,
      { maxSlippageBps: startup.maxSlippageBps, clock: dependencies.now },
    );
    const finalSnapshot = await readBoundSnapshot(handle.registry);
    const receipt = completedReceipt(
      executionId,
      startup.revision,
      dependencies.now(),
      runtime,
      finalSnapshot,
    );
    dependencies.appendReceipt(receipt);
    return receipt;
  } catch {
    const receipt: CapitalTestReceipt = {
      ...baseReceipt(executionId, startup.revision, dependencies.now(), "FAILED"),
      message: "Capital test harness stopped without a confirmed closed result.",
    };
    dependencies.appendReceipt(receipt);
    throw new Error(receipt.message);
  } finally {
    handle?.close();
  }
}

function validateStartup(source: NodeJS.ProcessEnv) {
  if (source.NODE_ENV !== "production") throw new Error("Capital test harness requires NODE_ENV=production.");
  if (source.CAPITAL_TEST_USER_ID !== CAPITAL_TEST_USER_ID) {
    throw new Error("Capital test harness is restricted to the approved user.");
  }
  if (source.CAPITAL_TEST_QUANTITY_XAUT !== CAPITAL_TEST_QUANTITY_XAUT) {
    throw new Error("Capital test harness is restricted to the approved quantity.");
  }
  const revision = source.GIT_COMMIT?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/u.test(revision)
    || source.CAPITAL_TEST_APPROVED_REVISION?.trim() !== revision) {
    throw new Error("Capital test revision is not the explicitly approved production revision.");
  }
  if (source.LIVE_TRADING_ENABLED !== "true" || source.BINANCE_KILL_SWITCH !== "false") {
    throw new Error("Capital test harness requires process-local live=true and kill=false.");
  }
  for (const name of ["USER_EXCHANGE_CREDENTIAL_DB_PATH", "BINANCE_USER_ORDER_DB_DIR"] as const) {
    const value = source[name]?.trim() ?? "";
    if (!value || !isAbsolute(value)) throw new Error(`${name} must be an explicit absolute production path.`);
  }
  const receiptPath = source.BINANCE_CAPITAL_TEST_RECEIPT_PATH?.trim() ?? "";
  const orderStoreRoot = resolve(source.BINANCE_USER_ORDER_DB_DIR!);
  const receiptRelativePath = receiptPath && isAbsolute(receiptPath)
    ? relative(orderStoreRoot, resolve(receiptPath))
    : "";
  if (!receiptRelativePath
    || receiptRelativePath === ".."
    || receiptRelativePath.startsWith("../")
    || isAbsolute(receiptRelativePath)) {
    throw new Error("Capital test receipt must be an explicit file inside the persistent Binance order directory.");
  }
  if (!source.GCP_KMS_CREDENTIAL_KEY_NAME?.trim() || !source.BINANCE_ALLOWED_EGRESS_IPS?.trim()) {
    throw new Error("Capital test production KMS and fixed egress configuration are required.");
  }
  const config = loadBinanceTradingConfig(source);
  if (config.maxOrderUsd > 25 || config.maxPositionUsd > 100) {
    throw new Error("Capital test harness refuses expanded Binance risk limits.");
  }
  return { revision, maxSlippageBps: config.maxSlippageBps };
}

function fixedIntent(executionId: string, createdAt: number): FundingArbitrageExecutionIntent {
  return {
    intentId: executionId,
    sourcePlanId: `${executionId}:approved-plan`,
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt,
    expiresAt: createdAt + CAPITAL_TEST_INTENT_TTL_MS,
    constraints: {
      maxResidualBaseQuantity: CAPITAL_TEST_MAX_RESIDUAL_XAUT,
      maxLegStartSkewMs: CAPITAL_TEST_MAX_LEG_START_SKEW_MS,
    },
    legs: [
      {
        legId: `${executionId}:spot-long`,
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        targetDeltaBaseQuantity: CAPITAL_TEST_QUANTITY_XAUT,
      },
      {
        legId: `${executionId}:perpetual-short`,
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        targetDeltaBaseQuantity: CAPITAL_TEST_QUANTITY_XAUT,
      },
    ],
  };
}

function assertFixedIntent(intent: FundingArbitrageExecutionIntent) {
  const [spot, perpetual] = intent.legs;
  if (intent.strategyType !== "SPOT_PERPETUAL"
    || intent.objective !== "ESTABLISH_HEDGE"
    || spot.role !== "long"
    || spot.venue !== "binance"
    || spot.instrumentId !== BINANCE_SPOT_INSTRUMENT_ID
    || spot.marketType !== "spot"
    || spot.targetDeltaBaseQuantity !== CAPITAL_TEST_QUANTITY_XAUT
    || perpetual.role !== "short"
    || perpetual.venue !== "binance"
    || perpetual.instrumentId !== BINANCE_PERPETUAL_INSTRUMENT_ID
    || perpetual.marketType !== "perpetual"
    || perpetual.targetDeltaBaseQuantity !== CAPITAL_TEST_QUANTITY_XAUT
    || intent.constraints.maxResidualBaseQuantity !== CAPITAL_TEST_MAX_RESIDUAL_XAUT
    || intent.constraints.maxLegStartSkewMs !== CAPITAL_TEST_MAX_LEG_START_SKEW_MS) {
    throw new Error("Capital test intent does not match the fixed approved scope.");
  }
}

function completedReceipt(
  executionId: string,
  revision: string,
  timestamp: number,
  runtime: BinanceCapitalTestRuntimeResult,
  finalSnapshot: BinancePreflightSnapshot,
): CapitalTestReceipt {
  assertTimestamp(timestamp);
  const flatOrDust = isFlatOrDust(finalSnapshot);
  const state = runtime.executionState;
  const exitStatus = runtime.residualExit?.status ?? null;
  const result: CapitalTestResult = state?.status === "PENDING_RECONCILIATION"
    ? "PENDING_RECONCILIATION"
    : state?.status === "HEDGED" && exitStatus === "EXITED" && flatOrDust
      ? "PASS"
      : exitStatus === "EXITED" && flatOrDust
        ? "FAILED_CLOSED"
        : "FAILED";
  return {
    ...baseReceipt(executionId, revision, timestamp, result),
    preflight: runtime.preflight,
    attempts: runtime.attempts,
    ...(state ? {
      legs: state.legs,
      aggregateStatus: state.status,
      residualQuantity: state.residualExposure.residualQuantity,
    } : { residualQuantity: null }),
    exitStatus,
    finalAccount: {
      spotQuantityXaut: finalSnapshot.existingSpotQuantityXaut,
      perpetualQuantityXaut: finalSnapshot.existingPerpetualQuantityXaut,
      openOrderCount: finalSnapshot.openSpotOrderCount + finalSnapshot.openPerpetualOrderCount,
      flatOrDust,
    },
  };
}

function isFlatOrDust(snapshot: BinancePreflightSnapshot) {
  const noPerpetual = snapshot.existingPerpetualQuantityXaut <= 1e-9;
  const noOrders = snapshot.openSpotOrderCount === 0 && snapshot.openPerpetualOrderCount === 0;
  const spotQuantity = snapshot.existingSpotQuantityXaut;
  const spotDust = spotQuantity <= 1e-9
    || (spotQuantity < snapshot.spot.minOrderQty
      && Number.isFinite(snapshot.spot.bid)
      && snapshot.spot.bid > 0
      && spotQuantity * snapshot.spot.bid < snapshot.spot.minNotionalUsd);
  return noPerpetual && noOrders && spotDust;
}

async function readBoundSnapshot(registry: RegistryPort) {
  return registry.run(CAPITAL_TEST_USER_ID, (service) => service.account());
}

function stableExecutionId(revision: string) {
  const digest = createHash("sha256")
    .update(`${revision}\u0000${CAPITAL_TEST_USER_ID}\u0000binance-xaut-capital-test-once`)
    .digest("hex");
  return `binance-capital-test-once:${digest}`;
}

function baseReceipt(
  executionId: string,
  revision: string,
  timestamp: number,
  result: CapitalTestResult,
): CapitalTestReceipt {
  assertTimestamp(timestamp);
  return { executionId, timestamp, userId: CAPITAL_TEST_USER_ID, revision, result };
}

function assertTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Capital test timestamp is invalid.");
}

export function createFileReceiptStore(path: string) {
  if (!isAbsolute(path)) throw new Error("Capital test receipt path must be absolute.");
  return {
    claimReceipt(receipt: CapitalTestReceipt) {
      if (existsSync(path)) throw new Error("Capital test has already been claimed and cannot run again.");
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(receipt)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    appendReceipt(receipt: CapitalTestReceipt) {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(receipt)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    readReceipts() {
      return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as CapitalTestReceipt);
    },
  };
}

async function assertProductionApiStopped() {
  try {
    await fetch(CAPITAL_TEST_API_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  throw new Error("Capital test harness refuses to run while the normal API process is reachable.");
}

function productionDependencies(source: NodeJS.ProcessEnv): CapitalTestHarnessDependencies {
  const receiptPath = source.BINANCE_CAPITAL_TEST_RECEIPT_PATH?.trim() ?? "";
  if (!receiptPath) throw new Error("BINANCE_CAPITAL_TEST_RECEIPT_PATH is required.");
  const receipts = createFileReceiptStore(receiptPath);
  return {
    now: Date.now,
    assertApiStopped: assertProductionApiStopped,
    claimReceipt: receipts.claimReceipt,
    appendReceipt: receipts.appendReceipt,
    createRegistry() {
      const credentials = new UserExchangeCredentialStore({
        keyProvider: new GcpKmsCredentialKeyProvider(),
      });
      return {
        registry: new BinancePersonalTradingServiceRegistry(credentials),
        close: () => credentials.close(),
      };
    },
    executeCapitalTest: executeBinanceCapitalTest,
  };
}

async function main() {
  try {
    const receipt = await runBinanceCapitalTestOnce(process.env, productionDependencies(process.env));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.result !== "PASS") process.exitCode = 1;
  } catch {
    process.stderr.write("Capital test harness failed closed.\n");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) void main();
