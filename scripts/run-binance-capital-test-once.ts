import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutionQueryObservation } from "../server/modules/cex/ExecutionQueryCapability";
import type { ExecutionIntent } from "../server/modules/cex/ExecutionIntent";
import type { ExecutionRecord } from "../server/modules/cex/ExecutionRecord";
import {
  SqliteExecutionRecordStore,
  type ExecutionRecordStore,
} from "../server/modules/cex/ExecutionRecordStore";
import type { ExecutionState } from "../server/modules/cex/ExecutionState";
import type { FundingArbitrageExecutionIntent } from "../server/modules/cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import {
  createFundingArbitrageExecutionState,
  type FundingArbitrageExecutionState,
} from "../server/modules/cex/funding-arbitrage/FundingArbitrageExecutionState";
import {
  FundingLegExecutionLinkStore,
  type FundingLegExecutionLinkStorePort,
} from "../server/modules/cex/funding-arbitrage/FundingLegExecutionLinkStore";
import {
  assertNoUnexpectedExposure,
  BinanceCapitalTestRuntime,
  type BinanceCapitalTestRuntimeOptions,
  type BinanceCapitalTestStateSyncResult,
  type BinanceCapitalTestSubmitResult,
} from "../server/modules/binance/BinanceCapitalTestRuntime";
import {
  preflightBinanceCapitalTest,
  type BinanceCapitalTestExecutionContext,
  type BinanceCapitalTestPreflightResult,
} from "../server/modules/binance/BinanceCapitalTestPreflight";
import {
  BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY,
  type BinanceUserExecutionMode,
} from "../server/modules/binance/BinanceExecutionPolicy";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "../server/modules/binance/BinanceInstrumentCatalog";
import type {
  BinanceIntentExecutionRuntimeRegistry,
} from "../server/modules/binance/BinanceIntentExecutionRuntime";
import { BinancePersonalTradingServiceRegistry } from "../server/modules/binance/BinancePersonalTradingServiceRegistry";
import { loadBinanceTradingConfig } from "../server/modules/binance/BinanceTradingConfig";
import type { BinancePreflightSnapshot } from "../server/modules/binance/BinanceTypes";
import { GcpKmsCredentialKeyProvider } from "../server/modules/credentials/GcpKmsCredentialKeyProvider";
import { UserExchangeCredentialStore } from "../server/modules/credentials/UserExchangeCredentialStore";

export const CAPITAL_TEST_USER_ID = "USR-MRDQ6DT1";
export const CAPITAL_TEST_QUANTITY_XAUT = "0.002";
export const CAPITAL_TEST_MAX_RESIDUAL_XAUT = String(BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY);
export const CAPITAL_TEST_CANONICAL_SPOT = "XAUT-USDT-SPOT";
export const CAPITAL_TEST_CANONICAL_PERPETUAL = "XAUT-USDT-PERP";
const CAPITAL_TEST_INTENT_TTL_MS = 60_000;
const CAPITAL_TEST_API_HEALTH_URL = "http://api:8787/api/health";

type CapitalTestVenue = "binance" | "okx" | "bybit" | "bitget";
type CapitalTestLeg = "spot-long" | "perpetual-short";

export type CapitalTestInvocation = Readonly<{
  count: number;
  venue: CapitalTestVenue;
  instrumentId: string;
  dryRun: boolean;
  confirmed: true;
  receiptPath: string;
  executionMode: BinanceUserExecutionMode;
}>;

type CapitalTestStartup = Readonly<{
  revision: string;
  maxSlippageBps: number;
  invocation: CapitalTestInvocation;
}>;

type CapitalTestResult =
  | "CLAIMED"
  | "PREFLIGHT_FAILED"
  | "DRY_RUN"
  | "HEDGED"
  | "CONFIRMED"
  | "PENDING_CONFIRMATION"
  | "PENDING_RECONCILIATION"
  | "FAILED";

export type CapitalTestReconciliationReceipt = Readonly<{
  attempted: boolean;
  observation: ExecutionQueryObservation | null;
  terminalShortCircuit: boolean;
}>;

export type CapitalTestLegReceipt = Readonly<{
  role: CapitalTestLeg;
  instrumentId: string;
  legId: string;
  executionIntentId: string;
  plannedExecutionRecordId: string;
  preflight: BinanceCapitalTestPreflightResult | null;
  executionRecordId: string | null;
  executionRecord: ExecutionRecord | null;
  executionState: ExecutionState | null;
  fundingLegState: FundingArbitrageExecutionState["legs"][number] | null;
  observation: ExecutionQueryObservation | null;
  reconciliationResult: CapitalTestReconciliationReceipt | null;
}>;

export type CapitalTestReceipt = Readonly<{
  runIndex: number;
  count: number;
  timestamp: number;
  revision: string;
  dryRun: boolean;
  result: CapitalTestResult;
  venue: CapitalTestVenue;
  instrumentId: string;
  fundingExecutionId: string;
  fundingIntentId: string;
  executionMode: BinanceUserExecutionMode;
  preflight?: BinanceCapitalTestPreflightResult;
  legs: readonly [CapitalTestLegReceipt, CapitalTestLegReceipt];
  fundingState?: FundingArbitrageExecutionState;
  residualResult: FundingArbitrageExecutionState["residualExposure"] | null;
  message?: string;
}>;

type RegistryPort = BinanceIntentExecutionRuntimeRegistry;
type RuntimePort = Pick<BinanceCapitalTestRuntime, "submitLeg" | "queryLeg" | "reconcileLeg">;

export type CapitalTestHarnessDependencies = Readonly<{
  now: () => number;
  assertApiStopped: () => Promise<void>;
  claimReceipts: (receipts: readonly CapitalTestReceipt[]) => void;
  appendReceipt: (receipt: CapitalTestReceipt) => void;
  createRegistry: () => Readonly<{ registry: RegistryPort; close: () => void }>;
  createLinkStore: () => Readonly<{ store: FundingLegExecutionLinkStorePort; close: () => void }>;
  createRecordStore: () => Readonly<{ store: ExecutionRecordStore; close: () => void }>;
  createRuntime: (
    registry: RegistryPort,
    recordStore: ExecutionRecordStore,
    options: BinanceCapitalTestRuntimeOptions,
  ) => RuntimePort;
}>;

export async function executeCapitalTestHarness(
  source: NodeJS.ProcessEnv,
  dependencies: CapitalTestHarnessDependencies,
  invocationInput: CapitalTestInvocation,
) {
  const startup = validateStartup(source, invocationInput);
  await dependencies.assertApiStopped();
  const planned = Array.from({ length: startup.invocation.count }, (_, index) => {
    const identities = identitiesFor(startup, index);
    return { identities, claimed: baseReceipt(startup, identities, dependencies.now(), "CLAIMED") };
  });
  dependencies.claimReceipts(planned.map((item) => item.claimed));

  let registryHandle: ReturnType<CapitalTestHarnessDependencies["createRegistry"]> | null = null;
  let linkHandle: ReturnType<CapitalTestHarnessDependencies["createLinkStore"]> | null = null;
  let recordHandle: ReturnType<CapitalTestHarnessDependencies["createRecordStore"]> | null = null;
  const completed: CapitalTestReceipt[] = [];
  try {
    registryHandle = dependencies.createRegistry();
    linkHandle = dependencies.createLinkStore();
    recordHandle = dependencies.createRecordStore();
    for (const item of planned) {
      const receipt = await executeFundingCycle(
        startup,
        item.identities,
        registryHandle.registry,
        recordHandle.store,
        linkHandle.store,
        dependencies,
      );
      dependencies.appendReceipt(receipt);
      completed.push(receipt);
      if (!startup.invocation.dryRun && receipt.result !== "HEDGED") break;
    }
    return Object.freeze(completed);
  } catch {
    const failedPlan = planned[completed.length];
    if (failedPlan) {
      dependencies.appendReceipt({
        ...baseReceipt(startup, failedPlan.identities, dependencies.now(), "FAILED"),
        message: "Capital test harness stopped without a complete execution audit receipt.",
      });
    }
    throw new Error("Capital test harness failed closed.");
  } finally {
    recordHandle?.close();
    linkHandle?.close();
    registryHandle?.close();
  }
}

async function executeFundingCycle(
  startup: CapitalTestStartup,
  identities: CapitalTestIdentities,
  registry: RegistryPort,
  recordStore: ExecutionRecordStore,
  linkStore: FundingLegExecutionLinkStorePort,
  dependencies: CapitalTestHarnessDependencies,
): Promise<CapitalTestReceipt> {
  const gate = await readBoundGate(registry);
  const context: BinanceCapitalTestExecutionContext = {
    userId: CAPITAL_TEST_USER_ID,
    accountId: gate.snapshot.accountId,
    venue: "binance",
  };
  const fundingIntent = fixedIntent(identities, dependencies.now());
  let fundingState = createFundingArbitrageExecutionState(fundingIntent, fundingIntent.createdAt);
  const managedExposure = managedExposureFor(startup, identities, context);
  try {
    assertNoUnexpectedExposure(context, gate.snapshot, managedExposure);
  } catch {
    return {
      ...baseReceipt(startup, identities, dependencies.now(), "PREFLIGHT_FAILED"),
      fundingState,
      residualResult: fundingState.residualExposure,
      message: "Capital test account contains exposure not owned by this funding execution.",
    };
  }
  const localPreflight = capitalTestPreflight(
    startup,
    context,
    fundingIntent,
    { ...gate, snapshot: exposureNeutralSnapshot(gate.snapshot) },
    dependencies.now(),
  );
  if (localPreflight.status === "FAIL") {
    return {
      ...baseReceipt(startup, identities, dependencies.now(), "PREFLIGHT_FAILED"),
      preflight: localPreflight,
      fundingState,
      residualResult: fundingState.residualExposure,
      message: "Capital test stopped before provider mutation because preflight failed.",
    };
  }

  const legA = await executeCycleLeg(
    startup,
    identities.legs[0],
    context,
    fundingIntent,
    fundingState,
    managedExposure,
    registry,
    recordStore,
    linkStore,
    dependencies,
  );
  fundingState = legA.executionState;
  if (!startup.invocation.dryRun && !legConfirmedInFull(legA)) {
    return completedCycleReceipt(
      startup,
      identities,
      localPreflight,
      fundingState,
      legA,
      null,
      dependencies.now(),
    );
  }
  const legB = await executeCycleLeg(
    startup,
    identities.legs[1],
    context,
    fundingIntent,
    fundingState,
    managedExposure,
    registry,
    recordStore,
    linkStore,
    dependencies,
  );
  fundingState = legB.executionState;
  return completedCycleReceipt(
    startup,
    identities,
    localPreflight,
    fundingState,
    legA,
    legB,
    dependencies.now(),
  );
}

async function executeCycleLeg(
  startup: CapitalTestStartup,
  identity: CapitalTestLegIdentity,
  context: BinanceCapitalTestExecutionContext,
  fundingIntent: FundingArbitrageExecutionIntent,
  fundingState: FundingArbitrageExecutionState,
  managedExposure: NonNullable<BinanceCapitalTestRuntimeOptions["managedExposure"]>,
  registry: RegistryPort,
  recordStore: ExecutionRecordStore,
  linkStore: FundingLegExecutionLinkStorePort,
  dependencies: CapitalTestHarnessDependencies,
): Promise<ExecutedCycleLeg> {
  const claimed = await linkStore.claimForUser(
    CAPITAL_TEST_USER_ID,
    fundingIntent.intentId,
    identity.legId,
    identity.executionIntentId,
  );
  if (!claimed) throw new Error("Capital test funding leg already has an execution claim.");
  const runtime = dependencies.createRuntime(registry, recordStore, {
    maxSlippageBps: startup.maxSlippageBps,
    clock: dependencies.now,
    createExecutionId: () => identity.executionRecordId,
    managedExposure,
    ...(startup.invocation.dryRun ? { createCapability: dryRunCapability } : {}),
  });
  const submitted = await runtime.submitLeg(CAPITAL_TEST_USER_ID, context, fundingIntent, fundingState, {
    confirmed: true,
    legId: identity.legId,
    executionIntentId: identity.executionIntentId,
    quantityAsset: { symbol: "XAUT", type: "RWA_ASSET" },
    orderConstraints: { reduceOnly: false },
    executionMode: startup.invocation.executionMode,
    expiresAt: fundingIntent.expiresAt,
  });
  if (!submitted.executionRecord || !submitted.link || !submitted.observation) {
    return { identity, submitted, queried: null, reconciled: null, executionState: fundingState };
  }
  await linkStore.linkForUser(CAPITAL_TEST_USER_ID, fundingIntent.intentId, identity.legId, submitted.link);
  const queried = await runtime.queryLeg(
    CAPITAL_TEST_USER_ID,
    submitted.executionState,
    identity.legId,
    submitted.link,
  );
  const reconciled = queried.observation?.state === "UNKNOWN"
    ? await runtime.reconcileLeg(
      CAPITAL_TEST_USER_ID,
      queried.executionState,
      identity.legId,
      submitted.link,
    )
    : null;
  return {
    identity,
    submitted,
    queried,
    reconciled,
    executionState: (reconciled ?? queried).executionState,
  };
}

function capitalTestPreflight(
  startup: CapitalTestStartup,
  context: BinanceCapitalTestExecutionContext,
  intent: FundingArbitrageExecutionIntent,
  gate: Readonly<{ snapshot: BinancePreflightSnapshot; processingOrderCount: number }>,
  now: number,
) {
  const preflight = preflightBinanceCapitalTest(
    context,
    intent,
    gate.snapshot,
    now,
    startup.maxSlippageBps,
  );
  return preflight.status === "PASS" && gate.processingOrderCount > 0
    ? {
      status: "FAIL" as const,
      reason: "OPEN_ORDERS" as const,
      message: "Existing processing Binance orders must be reconciled before the capital test.",
    }
    : preflight;
}

function completedCycleReceipt(
  startup: CapitalTestStartup,
  identities: CapitalTestIdentities,
  preflight: BinanceCapitalTestPreflightResult,
  fundingState: FundingArbitrageExecutionState,
  legA: ExecutedCycleLeg,
  legB: ExecutedCycleLeg | null,
  timestamp: number,
): CapitalTestReceipt {
  return {
    ...baseReceipt(startup, identities, timestamp, cycleResult(startup.invocation.dryRun, fundingState, legA, legB)),
    preflight,
    legs: [legReceipt(legA, fundingState), legB ? legReceipt(legB, fundingState) : emptyLegReceipt(identities.legs[1])],
    fundingState,
    residualResult: fundingState.residualExposure,
  };
}

function cycleResult(
  dryRun: boolean,
  fundingState: FundingArbitrageExecutionState,
  legA: ExecutedCycleLeg,
  legB: ExecutedCycleLeg | null,
): CapitalTestResult {
  if (dryRun) return "DRY_RUN";
  if (legA.submitted.preflight.status === "FAIL" || legB?.submitted.preflight.status === "FAIL") {
    return "PREFLIGHT_FAILED";
  }
  if (fundingState.status === "HEDGED" && legB && legConfirmedInFull(legB)) return "HEDGED";
  const records = [finalRecord(legA), legB ? finalRecord(legB) : null].filter(Boolean) as ExecutionRecord[];
  if (records.some((record) => record.status === "FAILED")) return "FAILED";
  if (records.some((record) => record.status === "UNKNOWN")) return "PENDING_RECONCILIATION";
  return "PENDING_CONFIRMATION";
}

function legConfirmedInFull(leg: ExecutedCycleLeg) {
  const record = finalRecord(leg);
  const observation = (leg.reconciled ?? leg.queried)?.observation;
  return record?.status === "CONFIRMED"
    && observation?.filledBaseQuantity === CAPITAL_TEST_QUANTITY_XAUT;
}

function finalRecord(leg: ExecutedCycleLeg) {
  return (leg.reconciled ?? leg.queried)?.executionRecord ?? leg.submitted.executionRecord;
}

function legReceipt(
  leg: ExecutedCycleLeg,
  fundingState: FundingArbitrageExecutionState,
): CapitalTestLegReceipt {
  const final = leg.reconciled ?? leg.queried;
  const record = final?.executionRecord ?? leg.submitted.executionRecord;
  return {
    ...emptyLegReceipt(leg.identity),
    preflight: leg.submitted.preflight,
    executionRecordId: record?.executionId ?? null,
    executionRecord: record,
    executionState: record ? executionStateFor(record) : null,
    fundingLegState: fundingState.legs.find((candidate) => candidate.legId === leg.identity.legId) ?? null,
    observation: leg.queried?.observation ?? leg.submitted.observation,
    reconciliationResult: {
      attempted: leg.reconciled !== null,
      observation: leg.reconciled?.observation ?? null,
      terminalShortCircuit: leg.reconciled !== null && leg.reconciled.observation === null,
    },
  };
}

function executionStateFor(record: ExecutionRecord): ExecutionState {
  return Object.freeze({
    intentId: record.intentId,
    userId: record.userId,
    venue: record.venue,
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function dryRunCapability() {
  return {
    async execute(intent: ExecutionIntent) {
      return Object.freeze({ executionAttemptId: intent.intentId, state: "PENDING_CONFIRMATION" as const });
    },
  };
}

export function parseCapitalTestArguments(args: readonly string[]): CapitalTestInvocation {
  let count = 1;
  let venue: CapitalTestVenue | null = null;
  let instrumentId: string | null = null;
  let receiptPath: string | null = null;
  let executionMode: BinanceUserExecutionMode = "PRICE_PRIORITY";
  let dryRun = false;
  let confirmed = false;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name?.startsWith("--") || seen.has(name)) {
      throw new Error(`Unknown or duplicate Capital Test argument: ${name ?? "<missing>"}.`);
    }
    seen.add(name);
    if (name === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (name === "--confirm") {
      confirmed = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Capital test argument ${name} requires a value.`);
    index += 1;
    if (name === "--count") count = parseCount(value);
    else if (name === "--venue") venue = parseVenue(value);
    else if (name === "--instrument") instrumentId = identifier(value, "instrument");
    else if (name === "--receipt") receiptPath = absolutePath(value, "receipt");
    else if (name === "--mode") executionMode = parseExecutionMode(value);
    else throw new Error(`Unknown or duplicate Capital Test argument: ${name}.`);
  }
  if (!confirmed) throw new Error("Capital test requires explicit --confirm.");
  if (!venue || !instrumentId || !receiptPath) {
    throw new Error("Capital test requires --venue, --instrument, --confirm, and --receipt.");
  }
  return Object.freeze({
    count,
    venue,
    instrumentId,
    dryRun,
    confirmed: true,
    receiptPath,
    executionMode,
  });
}

function validateStartup(source: NodeJS.ProcessEnv, invocation: CapitalTestInvocation): CapitalTestStartup {
  if (source.NODE_ENV !== "production") throw new Error("Capital test harness requires NODE_ENV=production.");
  if (source.CAPITAL_TEST_USER_ID !== CAPITAL_TEST_USER_ID
    || source.CAPITAL_TEST_QUANTITY_XAUT !== CAPITAL_TEST_QUANTITY_XAUT) {
    throw new Error("Capital test harness scope does not match the approved user and quantity.");
  }
  if (!invocation.confirmed) throw new Error("Capital test requires explicit human confirmation.");
  if (invocation.venue !== "binance") {
    throw new Error(`Capital test venue is not implemented: ${invocation.venue}.`);
  }
  if (invocation.instrumentId !== CAPITAL_TEST_CANONICAL_SPOT
    && invocation.instrumentId !== CAPITAL_TEST_CANONICAL_PERPETUAL) {
    throw new Error("Capital test canonical instrument is not supported by the funding harness.");
  }
  const revision = source.GIT_COMMIT?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/u.test(revision)
    || source.CAPITAL_TEST_APPROVED_REVISION?.trim() !== revision) {
    throw new Error("Capital test revision is not the explicitly approved production revision.");
  }
  if (!invocation.dryRun
    && (source.LIVE_TRADING_ENABLED !== "true" || source.BINANCE_KILL_SWITCH !== "false")) {
    throw new Error("Live capital test requires process-local live=true and kill=false.");
  }
  for (const name of [
    "USER_EXCHANGE_CREDENTIAL_DB_PATH",
    "BINANCE_USER_ORDER_DB_DIR",
    "TRADING_DB_PATH",
  ] as const) {
    absolutePath(source[name], name);
  }
  const receiptRelative = relative(resolve(source.BINANCE_USER_ORDER_DB_DIR!), invocation.receiptPath);
  if (!receiptRelative
    || receiptRelative === ".."
    || receiptRelative.startsWith("../")
    || isAbsolute(receiptRelative)) {
    throw new Error("Capital test receipt must remain inside BINANCE_USER_ORDER_DB_DIR.");
  }
  if (!source.GCP_KMS_CREDENTIAL_KEY_NAME?.trim() || !source.BINANCE_ALLOWED_EGRESS_IPS?.trim()) {
    throw new Error("Capital test production KMS and fixed egress configuration are required.");
  }
  const config = loadBinanceTradingConfig(source);
  if (config.maxOrderUsd > 25 || config.maxPositionUsd > 100) {
    throw new Error("Capital test harness refuses expanded Binance risk limits.");
  }
  return Object.freeze({ revision, maxSlippageBps: config.maxSlippageBps, invocation });
}

type CapitalTestIdentities = Readonly<{
  fundingExecutionId: string;
  runIndex: number;
  fundingIntentId: string;
  legs: readonly [CapitalTestLegIdentity, CapitalTestLegIdentity];
}>;

type CapitalTestLegIdentity = Readonly<{
  role: CapitalTestLeg;
  instrumentId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string;
}>;

type ExecutedCycleLeg = Readonly<{
  identity: CapitalTestLegIdentity;
  submitted: BinanceCapitalTestSubmitResult;
  queried: BinanceCapitalTestStateSyncResult | null;
  reconciled: BinanceCapitalTestStateSyncResult | null;
  executionState: FundingArbitrageExecutionState;
}>;

function identitiesFor(startup: CapitalTestStartup, runIndex: number): CapitalTestIdentities {
  const input = startup.invocation;
  const digest = createHash("sha256").update([
    startup.revision,
    CAPITAL_TEST_USER_ID,
    input.venue,
    input.instrumentId,
    input.executionMode,
    input.receiptPath,
    String(runIndex),
  ].join("\u0000")).digest("hex");
  const fundingExecutionId = `capital-test:${digest}`;
  const fundingIntentId = `${fundingExecutionId}:funding`;
  const legIdentity = (role: CapitalTestLeg, instrumentId: string): CapitalTestLegIdentity => ({
    role,
    instrumentId,
    legId: `${fundingIntentId}:${role}`,
    executionIntentId: `${fundingExecutionId}:${role}:intent`,
    executionRecordId: `${fundingExecutionId}:${role}:record`,
  });
  return Object.freeze({
    fundingExecutionId,
    runIndex,
    fundingIntentId,
    legs: [
      legIdentity("spot-long", CAPITAL_TEST_CANONICAL_SPOT),
      legIdentity("perpetual-short", CAPITAL_TEST_CANONICAL_PERPETUAL),
    ] as const,
  });
}

function fixedIntent(
  identities: CapitalTestIdentities,
  createdAt: number,
): FundingArbitrageExecutionIntent {
  assertTimestamp(createdAt);
  return {
    intentId: identities.fundingIntentId,
    sourcePlanId: `${identities.fundingExecutionId}:plan:${identities.runIndex}`,
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt,
    expiresAt: createdAt + CAPITAL_TEST_INTENT_TTL_MS,
    constraints: { maxResidualBaseQuantity: CAPITAL_TEST_MAX_RESIDUAL_XAUT },
    legs: [
      {
        legId: identities.legs[0].legId,
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        targetDeltaBaseQuantity: CAPITAL_TEST_QUANTITY_XAUT,
      },
      {
        legId: identities.legs[1].legId,
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        targetDeltaBaseQuantity: CAPITAL_TEST_QUANTITY_XAUT,
      },
    ],
  };
}

function baseReceipt(
  startup: CapitalTestStartup,
  identities: CapitalTestIdentities,
  timestamp: number,
  result: CapitalTestResult,
): CapitalTestReceipt {
  assertTimestamp(timestamp);
  return Object.freeze({
    runIndex: identities.runIndex,
    count: startup.invocation.count,
    timestamp,
    revision: startup.revision,
    dryRun: startup.invocation.dryRun,
    result,
    venue: startup.invocation.venue,
    instrumentId: startup.invocation.instrumentId,
    fundingExecutionId: identities.fundingExecutionId,
    fundingIntentId: identities.fundingIntentId,
    executionMode: startup.invocation.executionMode,
    legs: [emptyLegReceipt(identities.legs[0]), emptyLegReceipt(identities.legs[1])] as const,
    residualResult: null,
  });
}

function emptyLegReceipt(identity: CapitalTestLegIdentity): CapitalTestLegReceipt {
  return {
    role: identity.role,
    instrumentId: identity.instrumentId,
    legId: identity.legId,
    executionIntentId: identity.executionIntentId,
    plannedExecutionRecordId: identity.executionRecordId,
    preflight: null,
    executionRecordId: null,
    executionRecord: null,
    executionState: null,
    fundingLegState: null,
    observation: null,
    reconciliationResult: null,
  };
}

function managedExposureFor(
  startup: CapitalTestStartup,
  identities: CapitalTestIdentities,
  context: BinanceCapitalTestExecutionContext,
): NonNullable<BinanceCapitalTestRuntimeOptions["managedExposure"]> {
  return {
    fundingExecutionId: identities.fundingExecutionId,
    exposureOwnerFundingExecutionId: identities.fundingExecutionId,
    userId: context.userId,
    accountId: context.accountId,
    venue: context.venue,
    instrumentIds: [CAPITAL_TEST_CANONICAL_SPOT, CAPITAL_TEST_CANONICAL_PERPETUAL],
    spotBaseQuantity: "0",
    perpetualBaseQuantity: "0",
  };
}

function exposureNeutralSnapshot(snapshot: BinancePreflightSnapshot): BinancePreflightSnapshot {
  return {
    ...snapshot,
    existingSpotQuantityXaut: 0,
    existingPerpetualQuantityXaut: 0,
    perpetualPositionSide: "flat",
  };
}

export function createFileReceiptStore(path: string) {
  const receiptPath = absolutePath(path, "receipt");
  return {
    claimReceipts(receipts: readonly CapitalTestReceipt[]) {
      if (!receipts.length) throw new Error("Capital test receipt claim cannot be empty.");
      if (existsSync(receiptPath)) throw new Error("Capital test receipt already exists.");
      const fd = openSync(receiptPath, "wx", 0o600);
      try {
        writeSync(fd, receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    appendReceipt(receipt: CapitalTestReceipt) {
      const fd = openSync(receiptPath, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(receipt)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    readReceipts() {
      return readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as CapitalTestReceipt);
    },
  };
}

async function readBoundGate(registry: RegistryPort) {
  return registry.run(CAPITAL_TEST_USER_ID, async (service) => {
    const snapshot = await service.account();
    const processingOrderCount = service.ordersState().orders
      .filter((order) => order.status === "processing").length;
    return { snapshot, processingOrderCount };
  });
}

async function assertProductionApiStopped() {
  try {
    await fetch(CAPITAL_TEST_API_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  throw new Error("Capital test harness refuses to run while the normal API process is reachable.");
}

function productionDependencies(
  source: NodeJS.ProcessEnv,
  invocation: CapitalTestInvocation,
): CapitalTestHarnessDependencies {
  const receipts = createFileReceiptStore(invocation.receiptPath);
  return {
    now: Date.now,
    assertApiStopped: assertProductionApiStopped,
    claimReceipts: receipts.claimReceipts,
    appendReceipt: receipts.appendReceipt,
    createRegistry() {
      const credentials = new UserExchangeCredentialStore({ keyProvider: new GcpKmsCredentialKeyProvider() });
      return {
        registry: new BinancePersonalTradingServiceRegistry(credentials),
        close: () => credentials.close(),
      };
    },
    createLinkStore() {
      const store = new FundingLegExecutionLinkStore({ dbPath: source.TRADING_DB_PATH! });
      return { store, close: () => store.close() };
    },
    createRecordStore() {
      const store = new SqliteExecutionRecordStore({ dbPath: source.TRADING_DB_PATH! });
      return { store, close: () => store.close() };
    },
    createRuntime(registry, recordStore, options) {
      return new BinanceCapitalTestRuntime(registry, recordStore, options);
    },
  };
}

function parseCount(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d?$/u.test(value)) {
    throw new Error("Capital test --count must be an integer from 1 to 20.");
  }
  const count = Number(value);
  if (count > 20) throw new Error("Capital test --count must be an integer from 1 to 20.");
  return count;
}

function parseVenue(value: unknown): CapitalTestVenue {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("Capital test venue must be binance, okx, bybit, or bitget.");
  }
  return value;
}

function parseExecutionMode(value: unknown): BinanceUserExecutionMode {
  if (value !== "PRICE_PRIORITY" && value !== "EXECUTION_PRIORITY") {
    throw new Error("Capital test mode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }
  return value;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`Capital test ${name} is invalid.`);
  }
  return value.trim();
}

function absolutePath(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) {
    throw new Error(`Capital test ${name} must be an absolute path.`);
  }
  return resolve(value);
}

function assertTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Capital test timestamp is invalid.");
}

async function main() {
  try {
    const invocation = parseCapitalTestArguments(process.argv.slice(2));
    const receipts = await executeCapitalTestHarness(
      process.env,
      productionDependencies(process.env, invocation),
      invocation,
    );
    process.stdout.write(`${JSON.stringify(receipts)}\n`);
    if (receipts.some((receipt) => receipt.result !== "HEDGED" && receipt.result !== "DRY_RUN")) {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write("Capital test harness failed closed.\n");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) void main();
