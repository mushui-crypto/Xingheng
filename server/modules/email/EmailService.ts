import nodemailer from "nodemailer";
import type { RuntimeConfig } from "../../config/runtimeConfig";

type VerificationPurpose = "register" | "password_reset";

type VerificationMailInput = {
  to: string;
  code: string;
  purpose: VerificationPurpose;
  resetLink?: string;
};

type StrategyAlertMailInput = {
  to: string;
  subject: string;
  title: string;
  bodyLines: string[];
};

export class EmailService {
  private transporter: nodemailer.Transporter | null;

  constructor(private config: RuntimeConfig, transporter?: nodemailer.Transporter | null) {
    this.transporter = transporter !== undefined ? transporter : config.smtp.configured
      ? nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          auth: {
            user: config.smtp.user,
            pass: config.smtp.password,
          },
        })
      : null;
  }

  get isConfigured() {
    return Boolean(this.transporter);
  }

  async sendVerificationMail(input: VerificationMailInput) {
    if (!this.transporter) {
      if (this.config.isProduction) {
        throw new Error("邮件服务尚未配置，请联系管理员。");
      }
      console.info(
        `[email:dev] ${input.purpose} to=${input.to} code=${input.code}${
          input.resetLink ? ` resetLink=${input.resetLink}` : ""
        }`,
      );
      return;
    }

    const mail = renderVerificationMail(input);

    await this.transporter.sendMail({
      from: this.config.smtp.from,
      to: input.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }

  async sendStrategyAlertMail(input: StrategyAlertMailInput) {
    if (!this.transporter) {
      if (this.config.isProduction) {
        throw new Error("邮件服务尚未配置，请联系管理员。");
      }
      console.info(`[email:dev] strategy-alert to=${input.to} subject=${input.subject}`);
      return;
    }
    const mail = createMailContent({
      subject: input.subject,
      title: input.title,
      lead: input.bodyLines[0] ?? input.title,
      bodyLines: input.bodyLines.slice(1),
    });
    await this.transporter.sendMail({
      from: this.config.smtp.from,
      to: input.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }
}

function renderVerificationMail(input: VerificationMailInput) {
  if (input.purpose === "register") {
    return createMailContent({
      subject: "Stella X 注册验证码",
      title: "Stella X 注册验证码",
      lead: `你的 Stella X 注册验证码是：${input.code}`,
      code: input.code,
      bodyLines: ["验证码 10 分钟内有效，请勿转发给他人。", "如果这不是你本人操作，可以忽略这封邮件。"],
    });
  }

  const passwordResetLines = [
    "验证码 10 分钟内有效，使用后将失效。重置成功后，旧登录状态会自动失效。",
    "如果这不是你本人操作，请忽略这封邮件并尽快检查账户安全。",
  ];

  if (!input.resetLink) {
    return createMailContent({
      subject: "Stella X 找回密码验证码",
      title: "Stella X 找回密码验证码",
      lead: `你的 Stella X 找回密码验证码是：${input.code}`,
      code: input.code,
      bodyLines: passwordResetLines,
    });
  }

  return createMailContent({
    subject: "Stella X 找回密码验证码与重置密码链接",
    title: "Stella X 找回密码",
    lead: `你的 Stella X 找回密码验证码是：${input.code}`,
    code: input.code,
    bodyLines: [
      ...passwordResetLines,
      "你也可以点击以下链接完成重置，链接 10 分钟内有效，且只能使用一次：",
      input.resetLink,
    ],
    actionLabel: "打开重置密码链接",
    actionUrl: input.resetLink,
  });
}

function createMailContent(input: {
  subject: string;
  title: string;
  lead: string;
  code?: string;
  bodyLines: string[];
  actionLabel?: string;
  actionUrl?: string;
}) {
  const text = [
    input.title,
    "",
    input.lead,
    "",
    ...input.bodyLines.flatMap((line) => [line, ""]),
    input.actionUrl ? `重置链接：${input.actionUrl}` : "",
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .trim();

  const bodyHtml = input.bodyLines
    .map((line) =>
      isLikelyUrl(line)
        ? `<p><a href="${escapeHtml(line)}">${escapeHtml(line)}</a></p>`
        : `<p>${escapeHtml(line)}</p>`,
    )
    .join("");
  const actionHtml =
    input.actionLabel && input.actionUrl
      ? `<p><a href="${escapeHtml(input.actionUrl)}" style="color:#0f766e;font-weight:600;">${escapeHtml(input.actionLabel)}</a></p>`
      : "";

  return {
    subject: input.subject,
    text,
    html: [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.6;color:#111827;">',
      `<h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(input.title)}</h1>`,
      `<p>${escapeHtml(input.lead)}</p>`,
      input.code
        ? `<p style="font-size:24px;font-weight:700;letter-spacing:0.18em;margin:20px 0;">${escapeHtml(input.code)}</p>`
        : "",
      bodyHtml,
      actionHtml,
      "</div>",
    ].join(""),
  };
}

function isLikelyUrl(value: string) {
  return /^https?:\/\//.test(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
