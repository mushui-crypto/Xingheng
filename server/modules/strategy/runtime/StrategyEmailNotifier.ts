import type { EmailService } from "../../email/EmailService";
import type { ForwardReportResponse } from "./ForwardReportService";
import type { ForwardPaperWorkerHealth, ForwardPaperWorkerStatus } from "./ForwardPaperWorker";

export type StrategyEmailNotifierOptions = {
  enabled?: boolean;
  to?: string;
  cooldownMs?: number;
  now?: () => number;
  email?: Pick<EmailService, "sendStrategyAlertMail">;
};

export type StrategyNotificationInput = {
  health: ForwardPaperWorkerHealth;
  report: ForwardReportResponse | null;
};

type AlertKey = "consecutive_failures" | "no_first_success" | "closed_candle_stale" | "report_unreadable";

export class StrategyEmailNotifier {
  private readonly enabled: boolean;
  private readonly to: string;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly email?: Pick<EmailService, "sendStrategyAlertMail">;
  private readonly lastSentAt = new Map<string, number>();
  private activeAlerts = new Set<AlertKey>();

  constructor(options: StrategyEmailNotifierOptions = {}) {
    this.enabled = options.enabled ?? process.env.STRATEGY_EMAIL_ALERTS_ENABLED === "true";
    this.to = options.to ?? process.env.STRATEGY_ALERT_EMAIL_TO?.trim() ?? "";
    this.cooldownMs = clampCooldown(options.cooldownMs ?? Number(process.env.STRATEGY_ALERT_COOLDOWN_MS ?? 15 * 60 * 1000));
    this.now = options.now ?? (() => Date.now());
    this.email = options.email;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      configured: Boolean(this.enabled && this.to && this.email),
      channel: "email" as const,
      cooldownMs: this.cooldownMs,
      activeAlerts: [...this.activeAlerts],
    };
  }

  async evaluate(input: StrategyNotificationInput) {
    const nextAlerts = new Set(input.health.alerts.map((alert) => alert.code));
    for (const alert of input.health.alerts) {
      await this.sendWithCooldown(`alert:${alert.code}`, `星衡策略告警：${alert.title}`, [
        alert.title,
        alert.message,
        `状态：${input.health.freshness.status}`,
        `连续失败：${input.health.status.consecutiveFailures}`,
        `最近尝试：${input.health.status.lastAttemptAt ?? "-"}`,
        `最近成功：${input.health.status.lastSuccessAt ?? "-"}`,
        `最近完成K线：${input.health.status.lastCompletedCandleAt ?? "-"}`,
        "自动下单：关闭（automaticOrdersEnabled=false）",
      ]);
    }
    for (const previous of this.activeAlerts) {
      if (!nextAlerts.has(previous)) {
        await this.sendWithCooldown(`recovery:${previous}`, "星衡策略告警恢复", [
          `策略告警已恢复：${previous}`,
          `状态：${input.health.freshness.status}`,
          `最近成功：${input.health.status.lastSuccessAt ?? "-"}`,
          "自动下单：关闭（automaticOrdersEnabled=false）",
        ]);
      }
    }
    this.activeAlerts = nextAlerts;
  }

  async sendDailySummary(input: StrategyNotificationInput) {
    const report = input.report;
    await this.sendWithCooldown("daily-summary", "星衡策略每日运行摘要", [
      "星衡策略每日运行摘要",
      `状态：${input.health.freshness.status}`,
      `最近完成K线：${input.health.status.lastCompletedCandleAt ?? "-"}`,
      `连续失败：${input.health.status.consecutiveFailures}`,
      `缺口数量：${report?.dataQuality.missingBarCount ?? "-"}`,
      `已完成交易：${report?.metrics.tradeCount ?? "-"}`,
      `当前Paper仓位：${report?.openPosition ? "有" : "无"}`,
      `观察门槛：${report?.observationGate.reached ? "已达到" : "未达到"}`,
      "自动下单：关闭（automaticOrdersEnabled=false）",
    ]);
  }

  private async sendWithCooldown(key: string, subject: string, bodyLines: string[]) {
    const event = {
      event: "strategy_alert_notification",
      channel: "email",
      enabled: this.enabled,
      configured: Boolean(this.to && this.email),
      key,
    };
    if (!this.enabled || !this.to || !this.email) {
      console.info(JSON.stringify({ ...event, skipped: true }));
      return;
    }
    const now = this.now();
    const lastSentAt = this.lastSentAt.get(key);
    if (lastSentAt && now - lastSentAt < this.cooldownMs) {
      console.info(JSON.stringify({ ...event, skipped: true, reason: "cooldown" }));
      return;
    }
    try {
      await this.email.sendStrategyAlertMail({
        to: this.to,
        subject,
        title: subject,
        bodyLines,
      });
      this.lastSentAt.set(key, now);
      console.info(JSON.stringify({ ...event, sent: true }));
    } catch (error) {
      console.warn(JSON.stringify({
        ...event,
        sent: false,
        error: sanitizeNotificationError(error, this.sensitiveValues()),
      }));
    }
  }

  private sensitiveValues() {
    return [
      { value: this.to, replacement: "[email]" },
      { value: process.env.STRATEGY_ALERT_EMAIL_TO, replacement: "[email]" },
      { value: process.env.SMTP_FROM, replacement: "[secret]" },
      { value: process.env.SMTP_HOST, replacement: "[secret]" },
      { value: process.env.SMTP_USER, replacement: "[secret]" },
      { value: process.env.SMTP_PASSWORD, replacement: "[secret]" },
    ];
  }
}

function clampCooldown(value: number) {
  if (!Number.isFinite(value)) return 15 * 60 * 1000;
  return Math.max(60_000, Math.min(value, 24 * 60 * 60 * 1000));
}

function sanitizeNotificationError(error: unknown, sensitiveValues: Array<{ value: unknown; replacement: string }>) {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const { value, replacement } of sensitiveValues) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) sanitized = replaceLiteral(sanitized, text, replacement);
  }
  return sanitized
    .replace(/file:\/\/[^\s'")\]}<>]+/g, "[path]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(['"])(?:[A-Za-z]:\\|\/|\.{1,2}\/|~\/)[^'"]+\1/g, "$1[path]$1")
    .replace(/(^|[\s([{,:>])([A-Za-z]:\\[^\s'")\]}<>]+)/g, "$1[path]")
    .replace(/(^|[\s([{,:>])((?:\/|\.{1,2}\/|~\/)[^\s'")\]}<>]+)/g, "$1[path]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(pass(?:word)?|token|secret|api[_-]?key|credential)=([^\s'")\]}<>]+)/gi, "$1=[secret]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[secret]")
    .slice(0, 200);
}

function replaceLiteral(input: string, literal: string, replacement: string) {
  return input.split(literal).join(replacement);
}
