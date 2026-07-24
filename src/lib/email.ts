// Best-effort transactional email via Resend's REST API.
//
// We hit the HTTP API directly with fetch so there's no extra npm dependency.
// Like notify() in lib/notify.ts, every send is fire-and-forget: it must never
// throw or block the request that triggered it. If RESEND_API_KEY is unset
// (e.g. local dev) it's a no-op so nothing breaks.

import { createHmac } from "crypto";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.WISHLIST_NOTIFY_EMAIL?.trim();
const CONTACT_EMAIL = process.env.CONTACT_NOTIFY_EMAIL?.trim() || NOTIFY_EMAIL;
const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL
  ?? process.env.WISHLIST_FROM_EMAIL
  ?? "no-reply@auth.betterpomo.com";
const APP_URL = "https://app.betterpomo.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BrandedEmailAction = {
  label: string;
  url: string;
};

export type BrandedEmailOptions = {
  preview: string;
  eyebrow?: string;
  heading: string;
  code?: string;
  paragraphs?: string[];
  bullets?: string[];
  notice?: string;
  action?: BrandedEmailAction;
  secondaryAction?: BrandedEmailAction;
  details?: { label: string; value: string }[];
  signoff?: string;
  unsubscribe?: string;
};

/** Public origin of this API — used to build unsubscribe links in emails. */
export const API_PUBLIC_URL = (process.env.API_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

export const emailConfigured = () => !!RESEND_API_KEY;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function withLineBreaks(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br />");
}

/** Email-client-safe branded HTML. All dynamic values are escaped here so
 * templates can safely include profile names and contact-form submissions. */
export function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const code = opts.code
    ? `<div class="bp-code" style="margin:20px 0 24px;padding:18px;border:1px solid #d4d4d8;border-radius:14px;background:#fafafa;color:#18181b;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:800;letter-spacing:.22em;text-align:center;">${escapeHtml(opts.code)}</div>`
    : "";
  const paragraphs = (opts.paragraphs ?? [])
    .map((paragraph) => `
      <p class="bp-copy" style="margin:0 0 18px;color:#3f3f46;font-size:16px;line-height:1.7;">${withLineBreaks(paragraph)}</p>`)
    .join("");
  const bullets = opts.bullets?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;">${opts.bullets
        .map((bullet) => `
          <tr>
            <td class="bp-bullet" width="28" valign="top" style="padding:7px 0;color:#18181b;font-size:18px;line-height:1.45;">●</td>
            <td class="bp-copy" style="padding:7px 0;color:#3f3f46;font-size:15px;line-height:1.6;">${withLineBreaks(bullet)}</td>
          </tr>`)
        .join("")}</table>`
    : "";
  const details = opts.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bp-subtle" style="margin:4px 0 22px;border:1px solid #e4e4e7;border-radius:14px;background:#fafafa;">${opts.details
        .map((row, index) => `
          <tr>
            <td width="110" valign="top" style="padding:12px 14px;color:#71717a;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;${index ? "border-top:1px solid #e4e4e7;" : ""}">${escapeHtml(row.label)}</td>
            <td valign="top" class="bp-strong" style="padding:12px 14px;color:#18181b;font-size:14px;line-height:1.55;${index ? "border-top:1px solid #e4e4e7;" : ""}">${withLineBreaks(row.value)}</td>
          </tr>`)
        .join("")}</table>`
    : "";
  const notice = opts.notice
    ? `<div class="bp-notice" style="margin:4px 0 22px;padding:15px 17px;border-left:4px solid #18181b;border-radius:10px;background:#f4f4f5;color:#27272a;font-size:14px;line-height:1.6;">${withLineBreaks(opts.notice)}</div>`
    : "";
  const action = opts.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 22px;"><tr><td style="border-radius:999px;background:#18181b;"><a href="${escapeHtml(opts.action.url)}" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:999px;">${escapeHtml(opts.action.label)}&nbsp;&nbsp;→</a></td></tr></table>`
    : "";
  const secondaryAction = opts.secondaryAction
    ? `<p style="margin:0 0 22px;color:#71717a;font-size:14px;line-height:1.6;"><a class="bp-secondary-link" href="${escapeHtml(opts.secondaryAction.url)}" style="color:#18181b;font-weight:700;text-decoration:underline;">${escapeHtml(opts.secondaryAction.label)}</a></p>`
    : "";
  const signoff = opts.signoff
    ? `<p class="bp-copy" style="margin:26px 0 0;color:#3f3f46;font-size:15px;line-height:1.65;">${withLineBreaks(opts.signoff)}</p>`
    : "";
  const unsubscribe = opts.unsubscribe
    ? `<p style="margin:12px 0 0;color:#a1a1aa;font-size:11px;line-height:1.6;">You’re receiving this because you joined BetterPomo or opted into product emails. <a href="${escapeHtml(opts.unsubscribe)}" style="color:#71717a;text-decoration:underline;">Unsubscribe</a></p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(opts.heading)}</title>
    <style>
      @media only screen and (max-width:620px) {
        .bp-shell { padding: 18px 10px !important; }
        .bp-card { padding: 28px 22px !important; border-radius: 18px !important; }
        .bp-heading { font-size: 30px !important; }
      }
      @media (prefers-color-scheme: dark) {
        .bp-page, .bp-shell { background:#111113 !important; }
        .bp-card { background:#1c1c1f !important; border-color:#303036 !important; }
        .bp-heading, .bp-brand, .bp-strong { color:#fafafa !important; }
        .bp-copy { color:#d4d4d8 !important; }
        .bp-subtle, .bp-code { background:#252529 !important; border-color:#3f3f46 !important; }
        .bp-code { color:#fafafa !important; }
        .bp-brand-dot { background:#fafafa !important; }
        .bp-eyebrow { color:#a1a1aa !important; }
        .bp-bullet, .bp-secondary-link { color:#fafafa !important; }
        .bp-notice { background:#252529 !important; border-color:#fafafa !important; color:#e4e4e7 !important; }
      }
    </style>
  </head>
  <body class="bp-page" style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preview)}&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bp-shell" style="padding:36px 14px;background:#f4f4f5;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
          <tr>
            <td style="padding:0 8px 16px;">
              <a href="${APP_URL}" class="bp-brand" style="color:#18181b;text-decoration:none;font-size:18px;font-weight:800;letter-spacing:-.02em;"><span class="bp-brand-dot" style="display:inline-block;margin-right:8px;width:12px;height:12px;border-radius:50%;background:#18181b;"></span>BetterPomo</a>
            </td>
          </tr>
          <tr><td class="bp-card" style="padding:42px 44px;border:1px solid #e4e4e7;border-radius:24px;background:#ffffff;box-shadow:0 12px 35px rgba(24,24,27,.06);">
            ${opts.eyebrow ? `<p class="bp-eyebrow" style="margin:0 0 12px;color:#52525b;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.16em;">${escapeHtml(opts.eyebrow)}</p>` : ""}
            <h1 class="bp-heading" style="margin:0 0 22px;color:#18181b;font-size:36px;line-height:1.12;letter-spacing:-.035em;">${escapeHtml(opts.heading)}</h1>
            ${paragraphs}${code}${details}${bullets}${notice}${action}${secondaryAction}${signoff}
          </td></tr>
          <tr><td style="padding:22px 12px 4px;text-align:center;">
            <p style="margin:0;color:#71717a;font-size:12px;line-height:1.6;">BetterPomo · Focus is better, together.<br /><a href="https://betterpomo.com" style="color:#52525b;text-decoration:none;">betterpomo.com</a></p>
            ${unsubscribe}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** HMAC token proving an unsubscribe link was minted by us for this address.
 *  Uses a dedicated secret — never the service-role key — so one purpose can't
 *  compromise the other. Set UNSUBSCRIBE_SECRET in every deployed environment. */
export function unsubscribeToken(email: string): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  return createHmac("sha256", secret).update(email.toLowerCase()).digest("hex");
}

export function unsubscribeUrl(email: string): string {
  return `${API_PUBLIC_URL}/api/email/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}

export type EmailSendOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  unsubscribe?: string; // unsubscribe URL → List-Unsubscribe header
  idempotencyKey?: string;
  tags?: { name: string; value: string }[];
};

export type EmailSendResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number | null; error: string };

function formatSender(from: string): string {
  return from.includes("<") ? from : `BetterPomo <${from}>`;
}

function normalizeRecipient(to: string): string | null {
  const recipient = to.trim().toLowerCase();
  return recipient.length <= 254 && EMAIL_RE.test(recipient) ? recipient : null;
}

/** Generic sender with provider details for delivery-critical flows. Never throws. */
export async function sendEmailDetailed(opts: EmailSendOptions): Promise<EmailSendResult> {
  if (!RESEND_API_KEY) {
    return { ok: false, status: null, error: "RESEND_API_KEY is not configured" };
  }
  const recipient = normalizeRecipient(opts.to);
  if (!recipient) {
    return { ok: false, status: 400, error: "A valid recipient email is required" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: formatSender(opts.from ?? FROM_EMAIL),
        // Never substitute an admin, sender, or preview address here. The
        // normalized address supplied by the feature that initiated the send is
        // the only recipient Resend receives.
        to: [recipient],
        subject: opts.subject,
        text: opts.text,
        html: opts.html ?? renderBrandedEmail({
          preview: opts.subject,
          heading: opts.subject,
          paragraphs: [opts.text],
          unsubscribe: opts.unsubscribe,
        }),
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
        ...(opts.unsubscribe
          ? { headers: { "List-Unsubscribe": `<${opts.unsubscribe}>` } }
          : {}),
        ...(opts.tags?.length ? { tags: opts.tags } : {}),
      }),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`Email to ${recipient} failed (${res.status}): ${body}`);
      let error = body || `Resend rejected the email with status ${res.status}`;
      try {
        const parsed = JSON.parse(body) as { message?: string; name?: string };
        error = parsed.message ?? parsed.name ?? error;
      } catch {
        // Resend normally returns JSON, but keep its raw body if it does not.
      }
      return { ok: false, status: res.status, error };
    }
    let id: string | null = null;
    try {
      const parsed = JSON.parse(body) as { id?: string };
      id = parsed.id ?? null;
    } catch {
      // A successful response without JSON is still accepted by the provider.
    }
    return { ok: true, id };
  } catch (err) {
    console.error("Email send error:", err);
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "Unknown Resend request error",
    };
  }
}

/** Best-effort sender used by non-critical notifications. */
export async function sendEmail(opts: EmailSendOptions): Promise<boolean> {
  return (await sendEmailDetailed(opts)).ok;
}

/** Notify the owner that someone joined the wishlist. Never throws. */
export async function sendWishlistNotification(email: string): Promise<void> {
  if (!NOTIFY_EMAIL) {
    console.warn("Wishlist email skipped: WISHLIST_NOTIFY_EMAIL is not configured");
    return;
  }
  await sendEmail({
    to: NOTIFY_EMAIL,
    subject: "New BetterPomo wishlist signup",
    text: `${email} just joined the BetterPomo wishlist.\n\nCreate their account when you're ready.`,
    html: renderBrandedEmail({
      preview: "A new person joined the BetterPomo wishlist.",
      eyebrow: "Wishlist",
      heading: "Someone new wants to focus with us",
      paragraphs: ["A new person just joined the BetterPomo wishlist."],
      details: [{ label: "Email", value: email }],
      action: { label: "Open BetterPomo", url: APP_URL },
    }),
  });
}

/** Deliver a landing-page contact submission to the owner. */
export async function sendContactNotification(opts: {
  name: string;
  email: string;
  topic: "feedback" | "question" | "bug" | "other";
  message: string;
}): Promise<boolean> {
  const topicLabels = {
    feedback: "Feedback",
    question: "Question",
    bug: "Bug report",
    other: "Other",
  } as const;

  if (!CONTACT_EMAIL) {
    console.warn("Contact email skipped: CONTACT_NOTIFY_EMAIL or WISHLIST_NOTIFY_EMAIL is not configured");
    return false;
  }

  return sendEmail({
    to: CONTACT_EMAIL,
    replyTo: opts.email,
    subject: `[BetterPomo contact] ${topicLabels[opts.topic]}`,
    text: [
      `Name: ${opts.name}`,
      `Email: ${opts.email}`,
      `Topic: ${topicLabels[opts.topic]}`,
      "",
      opts.message,
    ].join("\n"),
    html: renderBrandedEmail({
      preview: `${opts.name} sent a ${topicLabels[opts.topic].toLowerCase()}.`,
      eyebrow: "Contact form",
      heading: topicLabels[opts.topic],
      paragraphs: [opts.message],
      details: [
        { label: "From", value: opts.name },
        { label: "Email", value: opts.email },
        { label: "Topic", value: topicLabels[opts.topic] },
      ],
      action: { label: `Reply to ${opts.name}`, url: `mailto:${opts.email}` },
    }),
  });
}
