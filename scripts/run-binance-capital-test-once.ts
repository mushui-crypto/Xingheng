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
  BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY,
  type BinanceExecutionPriceMode,
  type BinanceUserExecutionMode,
  toBinanceExecutionPriceMode,
} from "../server/modules/binance/BinanceExecutionPolicy";
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
export const CAPITAL_TEST_SYMBOL = "XAUTUSDT";
export const CAPITAL_TEST_QUANTITY_XAUT = "0.002";
export const CAPITAL_TEST_MAX_RESIDUAL_XAUT = String(
  BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY,
);
export const CAPITAL_TEST_MODE_CONFIG = {
  PRICE_PRIORITY: {
    executionPriceMode: "IOC_LIMIT",
  },
  EXECUTION_PRIORITY: {
    executionPriceMode: "MARKET",
  },
} as const satisfies Record<BinanceUserExecutionMode, Readonly<{
  executionPriceMode: BinanceExecutionPriceMode;
}>>;
const CAPITAL_TEST_INTENT_TTL_MS = 60_000;
const CAPITAL_TEST_API_HEALTH_URL = "http://api:8787/api/health";
const CAPITAL_TEST_RECEIPT_ROOT = "/app/data/binance-users";

type CapitalTestModeConfig = typeof CAPITAL_TEST_MODE_CONFIG[BinanceUserExecutionMode];
export type CapitalTestInvocation = Readonly<{
  executionMode: BinanceUserExecutionMode;
  runId: string;
}>;
type CapitalTestStartup = Readonly<{
  revision: string;
  maxSlippageBps: number;
  executionMode: BinanceUserExecutionMode;
  runId: string;
  modeConfig: CapitalTestModeConfig;
}>;

type CapitalTestResult =
  | "CLAIMED"
  | "PREFLIGHT_FAILED"
  | "PASS"
  | "FAILED_CLOSED"
  | "PENDING_RECONCILIATION"
  | "FAILED";

export type CapitalTestReceipt = Readonly<{
  executionId: string;
  runId: string;
  timestamp: number;
  userId: typeof CAPITAL_TEST_USER_ID;
  symbol: typeof CAPITAL_TEST_SYMBOL;
  quantityXaut: typeof CAPITAL_TEST_QUANTITY_XAUT;
  executionMode: BinanceUserExecutionMode;
  executionPriceMode: BinanceExecutionPriceMode;
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
  invocation: CapitalTestInvocation,
) {
  const startup = validateStartup(source, invocation);
  await dependencies.assertApiStopped();

  const executionId = stableExecutionId(startup);
  const claimedAt = dependencies.now();
  assertTimestamp(claimedAt);
  dependencies.claimReceipt(baseReceipt(executionId, startup, claimedAt, "CLAIMED"));

  let handle: ReturnType<CapitalTestHarnessDependencies["createRegistry"]> | null = null;
  try {
    handle = dependencies.createRegistry();
    const initialGate = await readBoundGate(handle.registry);
    const snapshot = initialGate.snapshot;
    const context: BinanceCapitalTestExecutionContext = {
      userId: CAPITAL_TEST_USER_ID,
      accountId: snapshot.accountId,
      venue: "binance",
    };
    const intent = fixedIntent(executionId, claimedAt);
    assertFixedIntent(intent, startup);

    const accountPreflight = preflightBinanceCapitalTest(
      context,
      intent,
      snapshot,
      claimedAt,
      startup.maxSlippageBps,
    );
    const localPreflight = accountPreflight.status === "PASS" && initialGate.processingOrderCount > 0
      ? {
        status: "FAIL" as const,
        reason: "OPEN_ORDERS" as const,
        message: "Existing processing Binance orders must be reconciled before the capital test.",
      }
      : accountPreflight;
    if (localPreflight.status === "FAIL") {
      const receipt: CapitalTestReceipt = {
        ...baseReceipt(executionId, startup, dependencies.now(), "PREFLIGHT_FAILED"),
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
      {
        maxSlippageBps: startup.maxSlippageBps,
        clock: dependencies.now,
        executionPriceMode: startup.modeConfig.executionPriceMode,
      },
    );
    const finalGate = await readBoundGate(handle.registry);
    const receipt = completedReceipt(
      executionId,
      startup,
      dependencies.now(),
      runtime,
      finalGate.snapshot,
      finalGate.processingOrderCount,
    );
    dependencies.appendReceipt(receipt);
    return receipt;
  } catch {
    const receipt: CapitalTestReceipt = {
      ...baseReceipt(executionId, startup, dependencies.now(), "FAILED"),
      message: "Capital test harness stopped without a confirmed closed result.",
    };
    dependencies.appendReceipt(receipt);
    throw new Error(receipt.message);
  } finally {
    handle?.close();
  }
}

function validateStartup(source: NodeJS.ProcessEnv, invocation: CapitalTestInvocation) {
  if (source.NODE_ENV !== "production") throw new Error("Capital test harness requires NODE_ENV=production.");
  if (source.CAPITAL_TEST_USER_ID !== CAPITAL_TEST_USER_ID) {
    throw new Error("Capital test harness is restricted to the approved user.");
  }
  if (source.CAPITAL_TEST_QUANTITY_XAUT !== CAPITAL_TEST_QUANTITY_XAUT) {
    throw new Error("Capital test harness is restricted to the approved quantity.");
  }
  const executionMode = parseHarnessExecutionMode(invocation.executionMode);
  const runId = parseRunId(invocation.runId);
  const modeConfig = CAPITAL_TEST_MODE_CONFIG[executionMode];
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
  const orderStoreRoot = resolve(source.BINANCE_USER_ORDER_DB_DIR!);
  const expectedReceiptPath = capitalTestReceiptPath(runId);
  const receiptRelativePath = relative(orderStoreRoot, expectedReceiptPath);
  if (!receiptRelativePath
    || receiptRelativePath === ".."
    || receiptRelativePath.startsWith("../")
    || isAbsolute(receiptRelativePath)) {
    throw new Error(
      "Capital test receipt path must remain inside BINANCE_USER_ORDER_DB_DIR.",
    );
  }
  if (!source.GCP_KMS_CREDENTIAL_KEY_NAME?.trim() || !source.BINANCE_ALLOWED_EGRESS_IPS?.trim()) {
    throw new Error("Capital test production KMS and fixed egress configuration are required.");
  }
  const config = loadBinanceTradingConfig(source);
  if (config.maxOrderUsd > 25 || config.maxPositionUsd > 100) {
    throw new Error("Capital test harness refuses expanded Binance risk limits.");
  }
  return {
    revision,
    maxSlippageBps: config.maxSlippageBps,
    executionMode,
    runId,
    modeConfig,
  };
}

export function parseCapitalTestArguments(args: readonly string[]): CapitalTestInvocation {
  let executionMode: BinanceUserExecutionMode | null = null;
  let runId: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Capital test argument ${name ?? "<missing>"} requires a value.`);
    }
    if (name === "--mode" && executionMode === null) {
      executionMode = parseHarnessExecutionMode(value);
    } else if (name === "--run-id" && runId === null) {
      runId = parseRunId(value);
    } else {
      throw new Error(`Unknown or duplicate Capital Test argument: ${name ?? "<missing>"}.`);
    }
  }
  if (executionMode === null || runId === null) {
    throw new Error("Capital test requires --mode and --run-id exactly once.");
  }
  return { executionMode, runId };
}

function parseHarnessExecutionMode(value: unknown): BinanceUserExecutionMode {
  if (value !== "PRICE_PRIORITY" && value !== "EXECUTION_PRIORITY") {
    throw new Error("Capital test --mode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }
  return value;
}

function parseRunId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error("Capital test run-id must be 1-64 safe identifier characters.");
  }
  return value;
}

export function capitalTestReceiptPath(runId: string) {
  const safeRunId = parseRunId(runId);
  return resolve(CAPITAL_TEST_RECEIPT_ROOT, `xaut-capital-test-once-${safeRunId}.jsonl`);
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

function assertFixedIntent(intent: FundingArbitrageExecutionIntent, startup: CapitalTestStartup) {
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
    || toBinanceExecutionPriceMode(startup.executionMode) !== startup.modeConfig.executionPriceMode) {
    throw new Error("Capital test intent does not match the fixed approved scope.");
  }
}

function completedReceipt(
  executionId: string,
  startup: CapitalTestStartup,
  timestamp: number,
  runtime: BinanceCapitalTestRuntimeResult,
  finalSnapshot: BinancePreflightSnapshot,
  finalProcessingOrderCount: number,
): CapitalTestReceipt {
  assertTimestamp(timestamp);
  const flatOrDust = isFlatOrDust(finalSnapshot, finalProcessingOrderCount);
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
    ...baseReceipt(executionId, startup, timestamp, result),
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
      openOrderCount: finalSnapshot.openSpotOrderCount
        + finalSnapshot.openPerpetualOrderCount
        + finalProcessingOrderCount,
      flatOrDust,
    },
  };
}

function isFlatOrDust(snapshot: BinancePreflightSnapshot, processingOrderCount = 0) {
  const noPerpetual = snapshot.existingPerpetualQuantityXaut <= 1e-9;
  const noOrders = snapshot.openSpotOrderCount === 0
    && snapshot.openPerpetualOrderCount === 0
    && processingOrderCount === 0;
  const spotQuantity = snapshot.existingSpotQuantityXaut;
  const spotDust = spotQuantity <= 1e-9
    || (spotQuantity < snapshot.spot.minOrderQty
      && Number.isFinite(snapshot.spot.bid)
      && snapshot.spot.bid > 0
      && spotQuantity * snapshot.spot.bid < snapshot.spot.minNotionalUsd);
  return noPerpetual && noOrders && spotDust;
}

async function readBoundGate(registry: RegistryPort) {
  return registry.run(CAPITAL_TEST_USER_ID, async (service) => {
    const snapshot = await service.account();
    const processingOrderCount = service.ordersState().orders
      .filter((order) => order.status === "processing").length;
    return { snapshot, processingOrderCount };
  });
}

function stableExecutionId(startup: CapitalTestStartup) {
  const digest = createHash("sha256")
    .update(
      `${startup.revision}\u0000${CAPITAL_TEST_USER_ID}\u0000${CAPITAL_TEST_SYMBOL}`
      + `\u0000${CAPITAL_TEST_QUANTITY_XAUT}\u0000${startup.executionMode}`
      + `\u0000${startup.runId}\u0000binance-xaut-capital-test-once`,
    )
    .digest("hex");
  return `binance-capital-test-once:${digest}`;
}

function baseReceipt(
  executionId: string,
  startup: CapitalTestStartup,
  timestamp: number,
  result: CapitalTestResult,
): CapitalTestReceipt {
  assertTimestamp(timestamp);
  return {
    executionId,
    runId: startup.runId,
    timestamp,
    userId: CAPITAL_TEST_USER_ID,
    symbol: CAPITAL_TEST_SYMBOL,
    quantityXaut: CAPITAL_TEST_QUANTITY_XAUT,
    executionMode: startup.executionMode,
    executionPriceMode: startup.modeConfig.executionPriceMode,
    revision: startup.revision,
    result,
  };
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

function productionDependencies(source: NodeJS.ProcessEnv, runId: string): CapitalTestHarnessDependencies {
  const receiptPath = capitalTestReceiptPath(runId);
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
    const invocation = parseCapitalTestArguments(process.argv.slice(2));
    const receipt = await runBinanceCapitalTestOnce(
      process.env,
      productionDependencies(process.env, invocation.runId),
      invocation,
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.result !== "PASS") process.exitCode = 1;
  } catch {
    process.stderr.write("Capital test harness failed closed.\n");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) void main();
