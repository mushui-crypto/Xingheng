import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HistoricalDataQuality } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";

const execFileAsync = promisify(execFile);
const startMonth = process.argv[2] ?? "2021-01";
const endMonth = process.argv[3] ?? "2021-12";
const study = process.argv[4] ?? "v2";
const worker = path.resolve("scripts/research-ict-combination.ts");
const tsx = path.resolve("node_modules/.bin/tsx");
const output = path.resolve(`research-ict-grid-${study}-${startMonth}-${endMonth}.json`);

const parameterGrid = buildParameterGrid(study);

const checkpoint = await readFile(output, "utf8")
  .then((value) => JSON.parse(value) as ResearchReport)
  .catch(() => null);
const rows: ResearchRow[] = checkpoint?.study === study ? checkpoint.rows : [];
let quality: HistoricalDataQuality | null = checkpoint?.study === study ? checkpoint.quality : null;
const completed = new Set(rows.map((row) => JSON.stringify(row.parameters)));
for (let index = 0; index < parameterGrid.length; index += 1) {
  const parameters = parameterGrid[index];
  if (completed.has(JSON.stringify(parameters))) continue;
  process.stderr.write(`ICT research ${startMonth}..${endMonth}: combination ${index + 1}/${parameterGrid.length}\n`);
  const { stdout } = await execFileAsync(tsx, [worker, startMonth, endMonth, JSON.stringify(parameters)], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" },
  });
  const result = JSON.parse(stdout) as WorkerResult;
  quality ??= result.quality;
  assertConsistentQuality(quality, result.quality);
  rows.push(result.row);
  completed.add(JSON.stringify(parameters));
  await saveReport(false);
}

rows.sort((left, right) => researchScore(right) - researchScore(left));
await saveReport(true);
console.log(JSON.stringify({ output, combinations: rows.length, top: rows.slice(0, 10).map((row) => ({ parameters: row.parameters, metrics: row.metrics })) }, null, 2));

async function saveReport(complete: boolean) {
  await writeFile(output, `${JSON.stringify({
    study,
    datasetRole: "development_only",
    warning: "Do not select parameters using validation or final holdout data.",
    complete,
    quality,
    rows,
  }, null, 2)}\n`, "utf8");
}

function researchScore(row: typeof rows[number]) {
  if (row.metrics.tradeCount < 30) return -1_000_000 + row.metrics.tradeCount;
  const profitFactor = row.metrics.profitFactor ?? 10;
  return row.metrics.averageR * 100 + profitFactor * 10 - row.metrics.maxDrawdownFraction * 100;
}

function assertConsistentQuality(expected: HistoricalDataQuality, actual: HistoricalDataQuality) {
  if (
    expected.candleCount !== actual.candleCount ||
    expected.firstCandleTime !== actual.firstCandleTime ||
    expected.lastCandleTime !== actual.lastCandleTime ||
    actual.missingBarCount > 0 ||
    !actual.checksumVerified
  ) {
    throw new Error("Research workers did not use the same verified candle dataset.");
  }
}

type ResearchRow = {
  parameters: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  metrics: {
    tradeCount: number;
    profitFactor: number | null;
    averageR: number;
    maxDrawdownFraction: number;
  };
  regimeMetrics: Record<string, unknown>;
};

type WorkerResult = { quality: HistoricalDataQuality; row: ResearchRow };
type ResearchReport = {
  study: string;
  complete?: boolean;
  quality: HistoricalDataQuality;
  rows: ResearchRow[];
};

function buildParameterGrid(study: string) {
  const parameterGrid = [];
  if (study === "v1") {
    for (const biasMode of ["structure_and_ema", "ema_only"] as const) {
      for (const displacementBodyAtr of [0.5, 0.8]) {
        for (const sweepLookbackBars of [3, 6]) {
          for (const rewardRisk of [2, 3]) {
            parameterGrid.push({
              biasMode,
              displacementBodyAtr,
              sweepLookbackBars,
              setupExpiryBars: 4,
              rewardRisk,
              stopBufferAtr: 0.25,
              maxStopAtr: 2,
              allowWeekends: true,
              volatilityFilter: "all" as const,
              sessionStartMinute: 8 * 60 + 30,
              sessionEndMinute: 11 * 60,
              minNetRewardRisk: 1.25,
            });
          }
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v2") {
    for (const displacementBodyAtr of [0.5, 0.8]) {
      for (const sweepLookbackBars of [6, 12]) {
        for (const setupExpiryBars of [4, 12]) {
          parameterGrid.push({
            biasMode: "ema_only" as const,
            displacementBodyAtr,
            sweepLookbackBars,
            setupExpiryBars,
            rewardRisk: 3,
            stopBufferAtr: 0.25,
            maxStopAtr: 2,
            allowWeekends: true,
            volatilityFilter: "all" as const,
            sessionStartMinute: 8 * 60 + 30,
            sessionEndMinute: 11 * 60,
            minNetRewardRisk: 1.25,
          });
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v3") {
    for (const displacementBodyAtr of [0.5, 0.8]) {
      for (const sweepLookbackBars of [6, 12]) {
        for (const setupExpiryBars of [4, 12]) {
          for (const stopExecutionMode of ["hard", "session_close_only"] as const) {
            parameterGrid.push({
              biasMode: "ema_only" as const,
              displacementBodyAtr,
              sweepLookbackBars,
              setupExpiryBars,
              rewardRisk: 3,
              stopBufferAtr: 0.25,
              maxStopAtr: 2,
              allowWeekends: true,
              volatilityFilter: "all" as const,
              sessionStartMinute: 8 * 60 + 30,
              sessionEndMinute: 11 * 60,
              minNetRewardRisk: 1.25,
              stopExecutionMode,
            });
          }
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v4") {
    for (const stopBufferAtr of [0.25, 0.5, 1]) {
      for (const rewardRisk of [1.5, 2, 3]) {
        parameterGrid.push({
          biasMode: "ema_only" as const,
          displacementBodyAtr: 0.5,
          sweepLookbackBars: 12,
          setupExpiryBars: 12,
          rewardRisk,
          stopBufferAtr,
          maxStopAtr: 3,
          allowWeekends: true,
          volatilityFilter: "all" as const,
          sessionStartMinute: 8 * 60 + 30,
          sessionEndMinute: 11 * 60,
          minNetRewardRisk: 1.2,
          stopExecutionMode: "hard" as const,
        });
      }
    }
    return parameterGrid;
  }
  if (study === "v5") {
    for (const allowWeekends of [true, false]) {
      for (const volatilityFilter of ["all", "exclude_low", "high_only"] as const) {
        parameterGrid.push({
          biasMode: "ema_only" as const,
          displacementBodyAtr: 0.5,
          sweepLookbackBars: 12,
          setupExpiryBars: 12,
          rewardRisk: 3,
          stopBufferAtr: 0.25,
          maxStopAtr: 3,
          allowWeekends,
          volatilityFilter,
          sessionStartMinute: 8 * 60 + 30,
          sessionEndMinute: 11 * 60,
          minNetRewardRisk: 1.2,
          stopExecutionMode: "hard" as const,
        });
      }
    }
    return parameterGrid;
  }
  if (study === "v6") {
    for (const [sessionStartMinute, sessionEndMinute] of [
      [8 * 60 + 30, 11 * 60],
      [8 * 60 + 30, 12 * 60],
      [7 * 60, 12 * 60],
    ]) {
      for (const displacementBodyAtr of [0.3, 0.5]) {
        for (const sweepLookbackBars of [12, 24]) {
          parameterGrid.push({
            biasMode: "ema_only" as const,
            displacementBodyAtr,
            sweepLookbackBars,
            setupExpiryBars: 12,
            rewardRisk: 3,
            stopBufferAtr: 0.25,
            maxStopAtr: 3,
            allowWeekends: false,
            volatilityFilter: "high_only" as const,
            sessionStartMinute,
            sessionEndMinute,
            minNetRewardRisk: 1.2,
            stopExecutionMode: "hard" as const,
          });
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v7") {
    for (const displacementBodyAtr of [0.3, 0.5]) {
      for (const sweepLookbackBars of [12, 24]) {
        for (const volatilityFilter of ["all", "exclude_low", "high_only"] as const) {
          parameterGrid.push({
            biasMode: "ema_only" as const,
            displacementBodyAtr,
            sweepLookbackBars,
            setupExpiryBars: 12,
            rewardRisk: 3,
            stopBufferAtr: 0.25,
            maxStopAtr: 3,
            allowWeekends: false,
            volatilityFilter,
            sessionTimeZone: "Asia/Shanghai",
            sessionStartMinute: 18 * 60,
            sessionEndMinute: 8 * 60,
            minNetRewardRisk: 1.2,
            stopExecutionMode: "hard" as const,
          });
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v8") {
    for (const minimumVolatilityRatio of [1.05, 1.15, 1.25]) {
      for (const fvgRetraceFraction of [0.25, 0.5]) {
        for (const setupExpiryBars of [12, 24]) {
          for (const rewardRisk of [2.5, 3]) {
            parameterGrid.push({
              biasMode: "ema_only" as const,
              displacementBodyAtr: 0.3,
              sweepLookbackBars: 24,
              setupExpiryBars,
              rewardRisk,
              stopBufferAtr: 0.25,
              maxStopAtr: 3,
              allowWeekends: false,
              volatilityFilter: "all" as const,
              minimumVolatilityRatio,
              fvgRetraceFraction,
              sessionTimeZone: "Asia/Shanghai",
              sessionStartMinute: 18 * 60,
              sessionEndMinute: 8 * 60,
              minNetRewardRisk: 1.2,
              maxTradesPerDay: 3,
              stopExecutionMode: "hard" as const,
            });
          }
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v9") {
    for (const entryMode of ["fvg_limit", "next_bar_market"] as const) {
      for (const displacementBodyAtr of [0.3, 0.5]) {
        for (const rewardRisk of [2, 2.5, 3]) {
          parameterGrid.push({
            biasMode: "ema_only" as const,
            displacementBodyAtr,
            sweepLookbackBars: 24,
            setupExpiryBars: 24,
            rewardRisk,
            stopBufferAtr: 0.25,
            maxStopAtr: 3,
            allowWeekends: false,
            volatilityFilter: "all" as const,
            minimumVolatilityRatio: 1.25,
            fvgRetraceFraction: 0.5,
            entryMode,
            sessionTimeZone: "Asia/Shanghai",
            sessionStartMinute: 18 * 60,
            sessionEndMinute: 8 * 60,
            minNetRewardRisk: 1.2,
            maxTradesPerDay: 3,
            stopExecutionMode: "hard" as const,
          });
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v10") {
    for (const maxStopAtr of [3, 4, 5, 8]) {
      for (const displacementBodyAtr of [0.3, 0.5]) {
        for (const rewardRisk of [2.5, 3]) {
          parameterGrid.push({
            biasMode: "ema_only" as const,
            displacementBodyAtr,
            sweepLookbackBars: 24,
            setupExpiryBars: 12,
            rewardRisk,
            stopBufferAtr: 0.25,
            maxStopAtr,
            allowWeekends: false,
            volatilityFilter: "all" as const,
            minimumVolatilityRatio: 1.25,
            fvgRetraceFraction: 0.5,
            entryMode: "next_bar_market" as const,
            sessionTimeZone: "Asia/Shanghai",
            sessionStartMinute: 18 * 60,
            sessionEndMinute: 8 * 60,
            minNetRewardRisk: 1.2,
            maxTradesPerDay: 3,
            stopExecutionMode: "hard" as const,
          });
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v11") {
    for (const maxStopAtr of [4, 4.25, 4.5, 4.75]) {
      parameterGrid.push({
        biasMode: "ema_only" as const,
        displacementBodyAtr: 0.3,
        sweepLookbackBars: 24,
        setupExpiryBars: 12,
        rewardRisk: 2.5,
        stopBufferAtr: 0.25,
        maxStopAtr,
        allowWeekends: false,
        volatilityFilter: "all" as const,
        minimumVolatilityRatio: 1.25,
        fvgRetraceFraction: 0.5,
        entryMode: "next_bar_market" as const,
        sessionTimeZone: "Asia/Shanghai",
        sessionStartMinute: 18 * 60,
        sessionEndMinute: 8 * 60,
        minNetRewardRisk: 1.2,
        maxTradesPerDay: 3,
        stopExecutionMode: "hard" as const,
      });
    }
    return parameterGrid;
  }
  if (study === "v12") {
    for (const minimumVolatilityRatio of [1.18, 1.2, 1.22, 1.25]) {
      for (const maxStopAtr of [4, 4.25]) {
        for (const displacementBodyAtr of [0.3, 0.5]) {
          parameterGrid.push({
            biasMode: "ema_only" as const,
            displacementBodyAtr,
            sweepLookbackBars: 24,
            setupExpiryBars: 12,
            rewardRisk: 2.5,
            stopBufferAtr: 0.25,
            maxStopAtr,
            allowWeekends: false,
            volatilityFilter: "all" as const,
            minimumVolatilityRatio,
            fvgRetraceFraction: 0.5,
            entryMode: "next_bar_market" as const,
            sessionTimeZone: "Asia/Shanghai",
            sessionStartMinute: 18 * 60,
            sessionEndMinute: 8 * 60,
            minNetRewardRisk: 1.2,
            maxTradesPerDay: 3,
            stopExecutionMode: "hard" as const,
          });
        }
      }
    }
    return parameterGrid;
  }
  if (study === "v13") {
    for (const displacementBodyAtr of [0.5, 0.8]) {
      for (const minimumVolatilityRatio of [1, 1.1, 1.18]) {
        for (const maxStopAtr of [2, 3]) {
          for (const rewardRisk of [2, 2.5]) {
            parameterGrid.push({
              biasMode: "ema_only" as const,
              setupMode: "mss_continuation" as const,
              displacementBodyAtr,
              sweepLookbackBars: 24,
              setupExpiryBars: 12,
              rewardRisk,
              stopBufferAtr: 0.25,
              maxStopAtr,
              allowWeekends: false,
              volatilityFilter: "all" as const,
              minimumVolatilityRatio,
              fvgRetraceFraction: 0.5,
              entryMode: "next_bar_market" as const,
              sessionTimeZone: "Asia/Shanghai",
              sessionStartMinute: 18 * 60,
              sessionEndMinute: 8 * 60,
              minNetRewardRisk: 1.2,
              maxTradesPerDay: 3,
              stopExecutionMode: "hard" as const,
            });
          }
        }
      }
    }
    return parameterGrid;
  }
  throw new Error(`Unknown research study ${study}.`);
}
