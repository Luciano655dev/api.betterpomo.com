// Best-effort transactional email via Resend's REST API.
//
// We hit the HTTP API directly with fetch so there's no extra npm dependency.
// Like notify() in lib/notify.ts, every send is fire-and-forget: it must never
// throw or block the request that triggered it. If RESEND_API_KEY is unset
// (e.g. local dev) it's a no-op so nothing breaks.

import { createHmac } from "crypto";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.WISHLIST_NOTIFY_EMAIL ?? "lucianomenezes655@gmail.com";
const FROM_EMAIL = process.env.WISHLIST_FROM_EMAIL ?? "onboarding@resend.dev";

/** Public origin of this API — used to build unsubscribe links in emails. */
export const API_PUBLIC_URL = (process.env.API_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

export const emailConfigured = () => !!RESEND_API_KEY;

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

/** Generic sender. Returns true when Resend accepted the message. Never throws. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  unsubscribe?: string; // unsubscribe URL → List-Unsubscribe header
}): Promise<boolean> {
  if (!RESEND_API_KEY) return false; // email not configured — skip silently

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `BetterPomo <${FROM_EMAIL}>`,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        ...(opts.unsubscribe
          ? { headers: { "List-Unsubscribe": `<${opts.unsubscribe}>` } }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Email to ${opts.to} failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Email send error:", err);
    return false;
  }
}

/** Notify the owner that someone joined the wishlist. Never throws. */
export async function sendWishlistNotification(email: string): Promise<void> {
  await sendEmail({
    to: NOTIFY_EMAIL,
    subject: "New BetterPomo wishlist signup",
    text: `${email} just joined the BetterPomo wishlist.\n\nCreate their account when you're ready.`,
  });
}
