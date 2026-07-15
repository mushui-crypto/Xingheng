import assert from "node:assert/strict";
import test from "node:test";
import { StrategyEmailNotifier } from "./StrategyEmailNotifier";
import type { ForwardPaperWorkerHealth } from "./ForwardPaperWorker";

test("strategy email notifier is disabled by default and does not send mail", async () => {
  const sent: unknown[] = [];
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (value?: unknown) => { logs.push(String(value)); };
  try {
    const notifier = new StrategyEmailNotifier({
      enabled: false,
      to: "ops@example.invalid",
      email: { sendStrategyAlertMail: async (input) => { sent.push(input); } },
    });
    await notifier.evaluate({ health: healthWithAlerts(["consecutive_failures"]), report: null });
    assert.equal(sent.length, 0);
    assert.equal(JSON.parse(logs[0]).skipped, true);
  } finally {
    console.info = originalInfo;
  }
});

test("strategy email notifier sends alert, deduplicates during cooldown, sends recovery and daily summary", async () => {
  const sent: Array<{ subject: string; bodyLines: string[] }> = [];
  let now = Date.parse("2026-07-15T00:00:00.000Z");
  const notifier = new StrategyEmailNotifier({
    enabled: true,
    to: "ops@example.invalid",
    now: () => now,
    cooldownMs: 60_000,
    email: {
      sendStrategyAlertMail: async (input) => {
        sent.push({ subject: input.subject, bodyLines: input.bodyLines });
      },
    },
  });
  await notifier.evaluate({ health: healthWithAlerts(["consecutive_failures"]), report: null });
  await notifier.evaluate({ health: healthWithAlerts(["consecutive_failures"]), report: null });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /告警/);
  now += 120_000;
  await notifier.evaluate({ health: healthWithAlerts([]), report: null });
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /恢复/);
  await notifier.sendDailySummary({ health: healthWithAlerts([]), report: fixtureReport() as any });
  assert.equal(sent.length, 3);
  assert.match(sent[2].subject, /每日运行摘要/);
  assert.match(sent[2].bodyLines.join("\n"), /automaticOrdersEnabled=false/);
});

test("strategy email notifier swallows and sanitizes email failures", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (value?: unknown) => { warnings.push(String(value)); };
  try {
    const notifier = new StrategyEmailNotifier({
      enabled: true,
      to: "ops@example.invalid",
      email: {
        sendStrategyAlertMail: async () => {
          throw new Error("SMTP failed token=abcdefghijklmnopqrstuvwxyz1234567890");
        },
      },
    });
    await notifier.evaluate({ health: healthWithAlerts(["consecutive_failures"]), report: null });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /abcdefghijklmnopqrstuvwxyz/);
  } finally {
    console.warn = originalWarn;
  }
});

test("strategy email notifier redacts email, short paths and known SMTP values from failures", async () => {
  const previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    SMTP_FROM: process.env.SMTP_FROM,
    STRATEGY_ALERT_EMAIL_TO: process.env.STRATEGY_ALERT_EMAIL_TO,
  };
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_USER = "u1";
  process.env.SMTP_PASSWORD = "p2";
  process.env.SMTP_FROM = "Stella X <alerts@example.test>";
  process.env.STRATEGY_ALERT_EMAIL_TO = "ops@example.test";
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (value?: unknown) => { warnings.push(String(value)); };
  try {
    const notifier = new StrategyEmailNotifier({
      enabled: true,
      to: "ops@example.test",
      email: {
        sendStrategyAlertMail: async () => {
          throw new Error(
            "ECONNREFUSED to ops@example.test via smtp.test user=u1 pass=p2 from Stella X <alerts@example.test> path /tmp/a and ./b and /dev/null file:///tmp/source?token=abc url=https://u1:p2@smtp.test/send?token=abc",
          );
        },
      },
    });
    await notifier.evaluate({ health: healthWithAlerts(["consecutive_failures"]), report: null });
    assert.equal(warnings.length, 1);
    const body = JSON.parse(warnings[0]);
    const error = body.error as string;
    assert.match(error, /ECONNREFUSED/);
    assert.match(error, /\[email\]/);
    assert.match(error, /\[path\]/);
    assert.match(error, /\[secret\]|\[url\]/);
    for (const raw of ["ops@example.test", "alerts@example.test", "smtp.test", "u1", "p2", "/tmp/a", "./b", "/dev/null", "file:///tmp/source", "token=abc"]) {
      assert.doesNotMatch(error, new RegExp(escapeRegExp(raw)));
    }
  } finally {
    console.warn = originalWarn;
    restoreEnv(previous);
  }
});

function healthWithAlerts(codes: Array<"consecutive_failures" | "no_first_success" | "closed_candle_stale" | "report_unreadable">): ForwardPaperWorkerHealth {
  return {
    status: {
      enabled: true,
      running: false,
      lastAttemptAt: "2026-07-15T00:00:00.000Z",
      lastSuccessAt: codes.length ? null : "2026-07-15T00:00:00.000Z",
      lastCompletedCandleAt: "2026-07-15T00:00:00.000Z",
      nextCheckAt: "2026-07-15T00:05:00.000Z",
      consecutiveFailures: codes.includes("consecutive_failures") ? 3 : 0,
      lastError: codes.length ? "fixture failure" : null,
    },
    freshness: {
      status: codes.length ? "failing" : "ok",
      closedCandleStaleSeconds: 0,
      reportReadable: !codes.includes("report_unreadable"),
    },
    alerts: codes.map((code) => ({
      code,
      title: `fixture ${code}`,
      message: `fixture message ${code}`,
    })),
  };
}

function fixtureReport() {
  return {
    dataQuality: { missingBarCount: 0 },
    metrics: { tradeCount: 1 },
    openPosition: null,
    observationGate: { reached: false },
    assumptions: { automaticOrdersEnabled: false },
  };
}

function restoreEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
