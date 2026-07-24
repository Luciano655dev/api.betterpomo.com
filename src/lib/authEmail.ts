import {
  renderBrandedEmail,
  sendEmailDetailed,
  type EmailSendResult,
} from "./email";

const AUTH_FROM_EMAIL =
  process.env.AUTH_FROM_EMAIL
  ?? process.env.RESEND_FROM_EMAIL
  ?? "no-reply@auth.betterpomo.com";

function authCodeLoggingEnabled(): boolean {
  if (process.env.LOG_AUTH_CODES === "true") return true;
  if (process.env.LOG_AUTH_CODES === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function logAuthCode(action: string, email: string, code: string) {
  if (!authCodeLoggingEnabled()) return;
  console.log(`[auth-code] action=${action} email=${email} code=${code}`);
}

export async function sendConfirmationCode(opts: {
  email: string;
  code: string;
  tokenHash: string;
  action: "signup" | "resend" | "unconfirmed_login";
}): Promise<EmailSendResult> {
  logAuthCode(opts.action, opts.email, opts.code);

  const result = await sendEmailDetailed({
    to: opts.email,
    from: AUTH_FROM_EMAIL,
    subject: `${opts.code} is your BetterPomo confirmation code`,
    text: [
      "Enter this six-digit code in BetterPomo to confirm your email:",
      "",
      opts.code,
      "",
      "This code expires shortly and can only be used once.",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: renderBrandedEmail({
      preview: "Your six-digit BetterPomo confirmation code.",
      eyebrow: "Welcome to BetterPomo",
      heading: "Confirm your email",
      paragraphs: [
        "Enter this six-digit code in BetterPomo to confirm your email and continue:",
      ],
      code: opts.code,
      notice: "This code expires shortly and can only be used once. Never share it with anyone.",
    }),
    idempotencyKey: `betterpomo-auth-${opts.action}-${opts.tokenHash}`,
    tags: [
      { name: "category", value: "auth_confirmation" },
      { name: "action", value: opts.action },
    ],
  });

  if (result.ok) {
    console.log(
      `[auth-email] accepted action=${opts.action} email=${opts.email}`
      + ` resend_id=${result.id ?? "unknown"}`,
    );
  } else {
    console.error(
      `[auth-email] delivery failed action=${opts.action} email=${opts.email}`
      + ` status=${result.status ?? "network"} error=${result.error}`,
    );
  }

  return result;
}

export async function sendPasswordRecovery(opts: {
  email: string;
  code: string;
  tokenHash: string;
  actionLink: string;
}): Promise<EmailSendResult> {
  logAuthCode("recovery", opts.email, opts.code);

  const result = await sendEmailDetailed({
    to: opts.email,
    from: AUTH_FROM_EMAIL,
    subject: "Reset your BetterPomo password",
    text: [
      "We received a request to reset the password for your BetterPomo account.",
      "",
      opts.actionLink,
      "",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: renderBrandedEmail({
      preview: "Use this secure link to choose a new password.",
      eyebrow: "Password recovery",
      heading: "Reset your password",
      paragraphs: [
        "We received a request to reset the password for your BetterPomo account.",
      ],
      action: { label: "Choose a new password", url: opts.actionLink },
      notice: "If you did not request this, you can safely ignore this email.",
    }),
    idempotencyKey: `betterpomo-auth-recovery-${opts.tokenHash}`,
    tags: [
      { name: "category", value: "auth_recovery" },
      { name: "action", value: "recovery" },
    ],
  });

  if (!result.ok) {
    console.error(
      `[auth-email] delivery failed action=recovery email=${opts.email}`
      + ` status=${result.status ?? "network"} error=${result.error}`,
    );
  }
  return result;
}
