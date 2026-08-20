import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { FormalExecutionRuntimeRegistry, formalExecutionRuntime } from "../server/modules/arbitrage-execution/FormalExecutionRuntimeRegistry";
import type { ExecutionQuantityInput } from "../server/modules/cex/ExecutionQuantityPlanner";
import type { ExecutionVenue } from "../server/modules/cex/ExecutionIntent";
import { SqliteExecutionOrderReferenceStore } from "../server/modules/cex/ExecutionOrderReferenceStore";
import { SqliteExecutionRecordStore } from "../server/modules/cex/ExecutionRecordStore";
import {
  UnifiedRealTradingTestCommand,
  UnifiedRealTradingTestMutationSafetyGuard,
  unifiedRealTradingTestExecutionId,
  type UnifiedRealTradingTestRequest,
  type UnifiedRealTradingTestResult,
} from "../server/modules/cex/UnifiedRealTradingTestCommand";
import { GcpKmsCredentialKeyProvider } from "../server/modules/credentials/GcpKmsCredentialKeyProvider";
import { UserExchangeCredentialStore } from "../server/modules/credentials/UserExchangeCredentialStore";
import { OkxFormalArbitrageExecutionRuntime } from "../server/modules/okx/OkxFormalArbitrageExecutionRuntime";
import { PersistentOkxExecutionOrderReferenceStore } from "../server/modules/okx/OkxExecutionOrderReferenceStore";
import { createOkxInstrumentQuantityRulesSource } from "../server/modules/okx/OkxInstrumentQuantityRulesSource";
import { OkxIntentExecutionRuntime } from "../server/modules/okx/OkxIntentExecutionRuntime";
import { OkxIntentExecutionServiceRegistry } from "../server/modules/okx/OkxIntentExecutionServiceRegistry";
import { createOkxTickerSource } from "../server/modules/okx/OkxMarketData";
import { OkxRealTradingTestVenuePreparation } from "../server/modules/okx/OkxRealTradingTestVenuePreparation";
import { createOkxSpotInstrumentQuantityRulesSource } from "../server/modules/okx/OkxSpotInstrumentQuantityRulesSource";
import { BinanceFormalArbitrageExecutionRuntime } from "../server/modules/arbitrage-execution/BinanceFormalArbitrageExecutionRuntime";
import { BinanceIntentExecutionRuntime } from "../server/modules/binance/BinanceIntentExecutionRuntime";
import { BinancePersonalTradingServiceRegistry } from "../server/modules/binance/BinancePersonalTradingServiceRegistry";
import { BinanceRealTradingTestVenuePreparation } from "../server/modules/binance/BinanceRealTradingTestVenuePreparation";
import { loadBinanceTradingConfig } from "../server/modules/binance/BinanceTradingConfig";
import { BybitFormalArbitrageExecutionRuntime } from "../server/modules/bybit/BybitFormalArbitrageExecutionRuntime";
import { PersistentBybitExecutionOrderReferenceStore } from "../server/modules/bybit/BybitExecutionOrderReferenceStore";
import { createBybitInstrumentQuantityRulesSource } from "../server/modules/bybit/BybitInstrumentQuantityRulesSource";
import { BybitIntentExecutionRuntime } from "../server/modules/bybit/BybitIntentExecutionRuntime";
import { BybitIntentExecutionServiceRegistry } from "../server/modules/bybit/BybitIntentExecutionServiceRegistry";
import { createBybitExecutionTickerSource } from "../server/modules/bybit/BybitExecutionMarketData";
import { BybitRealTradingTestVenuePreparation } from "../server/modules/bybit/BybitRealTradingTestVenuePreparation";

export type UnifiedRealTradingTestInvocation = UnifiedRealTradingTestRequest;

export function parseUnifiedRealTradingTestArguments(args: readonly string[]): UnifiedRealTradingTestInvocation {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--request-id",
    "--user-id",
    "--venue",
    "--instrument",
    "--side",
    "--quantity",
    "--max-notional-usdt",
    "--mode",
  ]);
  const flagOptions = new Set(["--reduce-only", "--execute-live"]);

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (valueOptions.has(option)) {
      if (values.has(option) || flags.has(option)) throw new Error(`Duplicate argument: ${option}.`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
      values.set(option, value);
      index += 1;
      continue;
    }
    if (flagOptions.has(option)) {
      if (flags.has(option) || values.has(option)) throw new Error(`Duplicate argument: ${option}.`);
      flags.add(option);
      continue;
    }
    throw new Error(`Unsupported argument: ${option}.`);
  }

  const quantity = values.get("--quantity");
  const maxNotional = values.get("--max-notional-usdt");
  if ((quantity === undefined) === (maxNotional === undefined)) {
    throw new Error("Provide exactly one of --quantity or --max-notional-usdt.");
  }
  const quantityInput: ExecutionQuantityInput = quantity === undefined
    ? Object.freeze({ mode: "NOTIONAL_USDT", amountUsdt: decimal(maxNotional, "--max-notional-usdt") })
    : Object.freeze({ mode: "ASSET_QUANTITY", quantity: decimal(quantity, "--quantity") });

  return Object.freeze({
    requestId: required(values, "--request-id"),
    userId: required(values, "--user-id"),
    venue: venue(required(values, "--venue")),
    instrumentId: canonicalInstrument(required(values, "--instrument")),
    side: side(required(values, "--side")),
    quantityInput,
    reduceOnly: flags.has("--reduce-only"),
    executionMode: executionMode(values.get("--mode") ?? "EXECUTION_PRIORITY"),
    executeLive: flags.has("--execute-live"),
  });
}

export async function runUnifiedRealTradingTest(
  invocation: UnifiedRealTradingTestInvocation,
) {
  const credentialStore = new UserExchangeCredentialStore({ keyProvider: new GcpKmsCredentialKeyProvider() });
  const recordStore = new SqliteExecutionRecordStore({ dbPath: process.env.TRADING_DB_PATH });
  const orderReferenceStore = new SqliteExecutionOrderReferenceStore({ dbPath: process.env.TRADING_DB_PATH });
  try {
    const mutationSafetyGuard = new UnifiedRealTradingTestMutationSafetyGuard();
    const okxTickerSource = createOkxTickerSource();
    const binanceTradingConfig = loadBinanceTradingConfig();
    const binanceServices = new BinancePersonalTradingServiceRegistry(credentialStore);
    const binanceExecutionRuntime = new BinanceIntentExecutionRuntime(
      binanceServices,
      { maxSlippageBps: binanceTradingConfig.maxSlippageBps },
      recordStore,
      { createExecutionId: unifiedRealTradingTestExecutionId },
    );
    const okxExecutionRuntime = new OkxIntentExecutionRuntime(
      new OkxIntentExecutionServiceRegistry(credentialStore),
      recordStore,
      new PersistentOkxExecutionOrderReferenceStore(orderReferenceStore),
      {
        createExecutionId: unifiedRealTradingTestExecutionId,
        mutationSafetyGuard,
        quantityRulesSource: createOkxInstrumentQuantityRulesSource(),
        spotQuantityRulesSource: createOkxSpotInstrumentQuantityRulesSource(),
        limitPriceResolver: async (intent, instrument) => {
          const snapshot = await okxTickerSource(instrument.venueInstrument.instId);
          if (snapshot.ticker.instId !== instrument.venueInstrument.instId) {
            throw new Error("OKX limit price ticker identity does not match the execution instrument.");
          }
          return intent.side === "buy" ? snapshot.ticker.askPx : snapshot.ticker.bidPx;
        },
      },
    );
    const bybitTickerSource = createBybitExecutionTickerSource();
    const bybitExecutionRuntime = new BybitIntentExecutionRuntime(
      new BybitIntentExecutionServiceRegistry(credentialStore),
      recordStore,
      new PersistentBybitExecutionOrderReferenceStore(orderReferenceStore),
      {
        createExecutionId: unifiedRealTradingTestExecutionId,
        mutationSafetyGuard,
        quantityRulesSource: createBybitInstrumentQuantityRulesSource(),
        limitPriceResolver: async (intent, instrument) => {
          const ticker = await bybitTickerSource(instrument.venueInstrument.category, instrument.venueInstrument.symbol);
          return intent.side === "buy" ? ticker.ask : ticker.bid;
        },
      },
    );
    const runtimes = new FormalExecutionRuntimeRegistry()
      .register(formalExecutionRuntime("binance", new BinanceFormalArbitrageExecutionRuntime(binanceExecutionRuntime)))
      .register(formalExecutionRuntime("okx", new OkxFormalArbitrageExecutionRuntime(okxExecutionRuntime)))
      .register(formalExecutionRuntime("bybit", new BybitFormalArbitrageExecutionRuntime(bybitExecutionRuntime)));
    const command = new UnifiedRealTradingTestCommand(
      runtimes,
      recordStore,
      [
        new BinanceRealTradingTestVenuePreparation(credentialStore),
        new OkxRealTradingTestVenuePreparation(credentialStore, { tickerSource: okxTickerSource }),
        new BybitRealTradingTestVenuePreparation(credentialStore, { tickerSource: bybitTickerSource }),
      ],
      { mutationSafetyRejections: mutationSafetyGuard },
    );
    const result = await command.run(invocation);
    return Object.freeze({
      safety: mutationSafetyGuard.status(invocation.venue),
      result,
    });
  } finally {
    orderReferenceStore.close();
    recordStore.close();
    credentialStore.close();
  }
}

async function main() {
  dotenv.config();
  try {
    const invocation = parseUnifiedRealTradingTestArguments(process.argv.slice(2));
    const output = await runUnifiedRealTradingTest(invocation);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = unifiedRealTradingTestExitCode(output.result);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      category: "unified_real_trading_test_error",
      message: error instanceof Error ? error.message : "Unified real trading test failed.",
    })}\n`);
    process.exitCode = 1;
  }
}

export function unifiedRealTradingTestExitCode(
  result: Pick<UnifiedRealTradingTestResult, "action">,
) {
  return result.action === "PREVIEW" || result.action === "EXECUTED" || result.action === "RECONCILED"
    ? 0
    : 1;
}

function required(values: ReadonlyMap<string, string>, option: string) {
  const value = values.get(option)?.trim();
  if (!value) throw new Error(`${option} is required.`);
  return value;
}

function venue(value: string): ExecutionVenue {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("--venue must be binance, okx, bybit, or bitget.");
  }
  return value;
}

function canonicalInstrument(value: string) {
  if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(value)) {
    throw new Error("--instrument must be a canonical instrument id.");
  }
  return value;
}

function side(value: string) {
  if (value !== "buy" && value !== "sell") throw new Error("--side must be buy or sell.");
  return value;
}

function executionMode(value: string) {
  if (value !== "PRICE_PRIORITY" && value !== "EXECUTION_PRIORITY") {
    throw new Error("--mode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }
  return value;
}

function decimal(value: string | undefined, option: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || Number(value) <= 0) {
    throw new Error(`${option} must be a positive decimal string.`);
  }
  return value;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
