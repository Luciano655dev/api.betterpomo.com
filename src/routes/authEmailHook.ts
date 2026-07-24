import type { Request, Response } from "express";
import { Webhook } from "standardwebhooks";
import {
  renderBrandedEmail,
  sendEmailDetailed,
  type EmailSendOptions,
} from "../lib/email";

type AuthEmailUser = {
  email?: string;
  new_email?: string;
};

type AuthEmailData = {
  token?: string;
  token_hash?: string;
  token_new?: string;
  token_hash_new?: string;
  redirect_to?: string;
  site_url?: string;
  email_action_type?: string;
};

type AuthEmailPayload = {
  user: AuthEmailUser;
  email_data: AuthEmailData;
};

type PendingAuthEmail = {
  action: string;
  code?: string;
  idempotencyToken?: string;
  message: EmailSendOptions;
};

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const AUTH_FROM_EMAIL =
  process.env.AUTH_FROM_EMAIL
  ?? process.env.RESEND_FROM_EMAIL
  ?? "no-reply@auth.betterpomo.com";

function authCodeLoggingEnabled(): boolean {
  if (process.env.LOG_AUTH_CODES === "true") return true;
  if (process.env.LOG_AUTH_CODES === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function normalizeHookSecret(secret: string): string {
  return secret.trim().replace(/^v1,whsec_/, "");
}

function verificationUrl(
  tokenHash: string,
  type: string,
  redirectTo?: string,
): string {
  const url = new URL(`${SUPABASE_URL}/auth/v1/verify`);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", type);
  if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
  return url.toString();
}

function codeEmail(opts: {
  to: string;
  action: string;
  code: string;
  tokenHash?: string;
  subject: string;
  eyebrow: string;
  heading: string;
  introduction: string;
}): PendingAuthEmail {
  return {
    action: opts.action,
    code: opts.code,
    idempotencyToken: opts.tokenHash,
    message: {
      to: opts.to,
      from: AUTH_FROM_EMAIL,
      subject: opts.subject,
      text: [
        opts.introduction,
        "",
        opts.code,
        "",
        "This code expires shortly and can only be used once.",
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
      html: renderBrandedEmail({
        preview: opts.subject,
        eyebrow: opts.eyebrow,
        heading: opts.heading,
        paragraphs: [opts.introduction],
        code: opts.code,
        notice: "This code expires shortly and can only be used once. Never share it with anyone.",
      }),
    },
  };
}

function actionEmail(opts: {
  to: string;
  action: string;
  code?: string;
  tokenHash: string;
  verificationType: string;
  redirectTo?: string;
  subject: string;
  eyebrow: string;
  heading: string;
  introduction: string;
  buttonLabel: string;
}): PendingAuthEmail {
  const actionUrl = verificationUrl(
    opts.tokenHash,
    opts.verificationType,
    opts.redirectTo,
  );
  return {
    action: opts.action,
    code: opts.code,
    idempotencyToken: opts.tokenHash,
    message: {
      to: opts.to,
      from: AUTH_FROM_EMAIL,
      subject: opts.subject,
      text: [
        opts.introduction,
        "",
        actionUrl,
        "",
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
      html: renderBrandedEmail({
        preview: opts.subject,
        eyebrow: opts.eyebrow,
        heading: opts.heading,
        paragraphs: [opts.introduction],
        action: { label: opts.buttonLabel, url: actionUrl },
        notice: "If you did not request this, you can safely ignore this email.",
      }),
    },
  };
}

function buildAuthEmails(payload: AuthEmailPayload): PendingAuthEmail[] {
  const { user, email_data: data } = payload;
  const email = user.email?.trim().toLowerCase();
  const newEmail = user.new_email?.trim().toLowerCase();
  const action = data.email_action_type ?? "unknown";
  const redirectTo = data.redirect_to || data.site_url;

  if (!email) throw new Error("Supabase email hook payload did not include a recipient");

  if (action === "signup") {
    if (!data.token) throw new Error("Supabase signup email did not include an OTP");
    return [codeEmail({
      to: email,
      action,
      code: data.token,
      tokenHash: data.token_hash,
      subject: `${data.token} is your BetterPomo confirmation code`,
      eyebrow: "Welcome to BetterPomo",
      heading: "Confirm your email",
      introduction:
        "Enter this six-digit code in BetterPomo to confirm your email and finish creating your account:",
    })];
  }

  if (action === "reauthentication") {
    if (!data.token) throw new Error("Supabase reauthentication email did not include an OTP");
    return [codeEmail({
      to: email,
      action,
      code: data.token,
      tokenHash: data.token_hash,
      subject: `${data.token} is your BetterPomo verification code`,
      eyebrow: "Security check",
      heading: "Verify it’s you",
      introduction: "Enter this one-time code in BetterPomo to continue:",
    })];
  }

  if (action === "recovery") {
    if (!data.token_hash) throw new Error("Supabase recovery email did not include a token");
    return [actionEmail({
      to: email,
      action,
      code: data.token,
      tokenHash: data.token_hash,
      verificationType: "recovery",
      redirectTo,
      subject: "Reset your BetterPomo password",
      eyebrow: "Password recovery",
      heading: "Reset your password",
      introduction: "We received a request to reset the password for your BetterPomo account.",
      buttonLabel: "Choose a new password",
    })];
  }

  if (action === "magiclink") {
    if (!data.token_hash) throw new Error("Supabase magic-link email did not include a token");
    return [actionEmail({
      to: email,
      action,
      code: data.token,
      tokenHash: data.token_hash,
      verificationType: "magiclink",
      redirectTo,
      subject: "Your BetterPomo sign-in link",
      eyebrow: "Secure sign-in",
      heading: "Your sign-in link is ready",
      introduction: "Use this secure, one-time link to sign in to BetterPomo.",
      buttonLabel: "Sign in to BetterPomo",
    })];
  }

  if (action === "invite") {
    if (!data.token_hash) throw new Error("Supabase invite email did not include a token");
    return [actionEmail({
      to: email,
      action,
      code: data.token,
      tokenHash: data.token_hash,
      verificationType: "invite",
      redirectTo,
      subject: "You’ve been invited to BetterPomo",
      eyebrow: "You’re invited",
      heading: "Let’s focus together",
      introduction: "You’ve been invited to create a BetterPomo account.",
      buttonLabel: "Accept invitation",
    })];
  }

  if (action === "email_change") {
    const messages: PendingAuthEmail[] = [];

    // Supabase's secure-email-change token/hash names are intentionally
    // counterintuitive. The current address gets token + token_hash_new,
    // while the new address gets token_new + token_hash.
    if (data.token && data.token_hash_new) {
      messages.push(actionEmail({
        to: email,
        action: "email_change_current",
        code: data.token,
        tokenHash: data.token_hash_new,
        verificationType: "email_change",
        redirectTo,
        subject: "Confirm your BetterPomo email change",
        eyebrow: "Account email",
        heading: "Confirm your email change",
        introduction: "Confirm that you requested a new email address for your BetterPomo account.",
        buttonLabel: "Confirm email change",
      }));
    }
    if (newEmail && data.token_new && data.token_hash) {
      messages.push(actionEmail({
        to: newEmail,
        action: "email_change_new",
        code: data.token_new,
        tokenHash: data.token_hash,
        verificationType: "email_change",
        redirectTo,
        subject: "Confirm your new BetterPomo email",
        eyebrow: "Account email",
        heading: "Confirm your new email",
        introduction: "Confirm that you want to use this email address for your BetterPomo account.",
        buttonLabel: "Confirm new email",
      }));
    }
    if (!messages.length && newEmail && data.token_hash) {
      messages.push(actionEmail({
        to: newEmail,
        action,
        code: data.token || data.token_new,
        tokenHash: data.token_hash,
        verificationType: "email_change",
        redirectTo,
        subject: "Confirm your new BetterPomo email",
        eyebrow: "Account email",
        heading: "Confirm your new email",
        introduction: "Confirm that you want to use this email address for your BetterPomo account.",
        buttonLabel: "Confirm new email",
      }));
    }
    if (!messages.length) {
      throw new Error("Supabase email-change payload did not include a usable token");
    }
    return messages;
  }

  throw new Error(`Unsupported Supabase auth email action: ${action}`);
}

function errorResponse(res: Response, status: number, message: string) {
  res.status(status).json({
    error: {
      http_code: status,
      message,
    },
  });
}

/** Signed HTTP hook used by Supabase Auth for every authentication email. */
export async function authEmailHookHandler(req: Request, res: Response) {
  const configuredSecret = process.env.SEND_EMAIL_HOOK_SECRET;
  if (!configuredSecret) {
    console.error("[auth-email] SEND_EMAIL_HOOK_SECRET is not configured");
    errorResponse(res, 503, "Authentication email hook is not configured");
    return;
  }
  if (!SUPABASE_URL) {
    console.error("[auth-email] SUPABASE_URL is not configured");
    errorResponse(res, 503, "Authentication email hook is not configured");
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
  let payload: AuthEmailPayload;
  try {
    const webhook = new Webhook(normalizeHookSecret(configuredSecret));
    payload = webhook.verify(rawBody, req.headers as Record<string, string>) as AuthEmailPayload;
  } catch (error) {
    console.error(
      "[auth-email] rejected invalid webhook signature:",
      error instanceof Error ? error.message : error,
    );
    errorResponse(res, 401, "Invalid authentication email hook signature");
    return;
  }

  let messages: PendingAuthEmail[];
  try {
    messages = buildAuthEmails(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid authentication email payload";
    console.error(`[auth-email] ${message}`);
    errorResponse(res, 400, message);
    return;
  }

  for (const pending of messages) {
    if (pending.code && authCodeLoggingEnabled()) {
      console.log(
        `[auth-code] action=${pending.action} email=${pending.message.to} code=${pending.code}`,
      );
    }

    const result = await sendEmailDetailed({
      ...pending.message,
      idempotencyKey: pending.idempotencyToken
        ? `betterpomo-auth-${pending.action}-${pending.idempotencyToken}`
        : undefined,
      tags: [
        { name: "category", value: "auth_hook" },
        { name: "action", value: pending.action },
      ],
    });

    if (!result.ok) {
      // Local development can still complete the flow with the code printed
      // above when no provider key is configured. Deployed environments fail
      // closed so Supabase never reports a message as sent when it was not.
      if (
        process.env.NODE_ENV !== "production"
        && result.error === "RESEND_API_KEY is not configured"
      ) {
        console.warn(
          `[auth-email] Resend is disabled; use the logged ${pending.action} code for ${pending.message.to}`,
        );
        continue;
      }

      console.error(
        `[auth-email] delivery failed action=${pending.action} email=${pending.message.to}`
        + ` status=${result.status ?? "network"} error=${result.error}`,
      );
      const responseStatus =
        result.status && result.status >= 400 && result.status <= 599
          ? result.status
          : 502;
      errorResponse(res, responseStatus, `Authentication email delivery failed: ${result.error}`);
      return;
    }

    console.log(
      `[auth-email] accepted action=${pending.action} email=${pending.message.to}`
      + ` resend_id=${result.id ?? "unknown"}`,
    );
  }

  res.status(200).json({});
}
