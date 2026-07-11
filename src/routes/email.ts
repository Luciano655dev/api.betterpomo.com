import { Router } from "express";
import { adminDb } from "../lib/supabase";
import { unsubscribeToken } from "../lib/email";

const router = Router();

/**
 * GET /api/email/unsubscribe?email=...&token=... — PUBLIC (linked from emails).
 * The HMAC token proves the link came from an email we sent, so no login is
 * needed. Opts the address out of the waitlist drip and, if it belongs to a
 * registered user we've emailed, flips their marketing_emails off too.
 */
router.get("/unsubscribe", async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  const token = typeof req.query.token === "string" ? req.query.token : "";

  if (!email || !token || token !== unsubscribeToken(email)) {
    res.status(400).send("Invalid unsubscribe link.");
    return;
  }

  await adminDb.from("wishlist").update({ unsubscribed: true }).eq("email", email);

  // email_sends remembers which user_id this address belonged to.
  const { data: sends } = await adminDb
    .from("email_sends")
    .select("user_id")
    .eq("recipient", email)
    .not("user_id", "is", null)
    .limit(1);
  const userId = sends?.[0]?.user_id;
  if (userId) {
    await adminDb.from("profiles").update({ marketing_emails: false }).eq("id", userId);
  }

  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed — BetterPomo</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f7f7f7;color:#333">
<div style="text-align:center;max-width:26rem;padding:2rem">
<h1 style="font-size:1.4rem">You're unsubscribed</h1>
<p style="color:#666;line-height:1.5">${email} won't receive any more emails from BetterPomo. If you have an account, you can turn emails back on in Settings.</p>
</div></body></html>`,
    );
});

export default router;
