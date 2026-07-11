import { Router } from "express";
import { adminDb } from "../lib/supabase";
import { serverError } from "../lib/http";
import { sendWishlistNotification } from "../lib/email";

const router = Router();

// Basic email shape check — not RFC-perfect, just enough to reject junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/wishlist — PUBLIC (no authenticate middleware).
 *
 * Visitors have no token, so this route deliberately skips auth and uses the
 * service-role client directly. Registration is closed; people leave their email
 * here and the owner creates accounts manually. Write-only — there is no GET, so
 * nothing to cache.
 */
router.post("/", async (req, res) => {
  const rawEmail = req.body?.email;
  if (typeof rawEmail !== "string") {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const email = rawEmail.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Please enter a valid email" });
    return;
  }

  // Dedupe silently on the unique email so re-submits don't error.
  const { error } = await adminDb
    .from("wishlist")
    .upsert({ email }, { onConflict: "email", ignoreDuplicates: true });

  if (error) {
    serverError(res, error);
    return;
  }

  // Fire-and-forget — never blocks or fails the signup.
  void sendWishlistNotification(email);

  res.json({ data: { ok: true } });
});

export default router;
