import { Router } from "express";
import { adminDb, createAnonClient } from "../lib/supabase";
import { serverError } from "../lib/http";
import { escapeLike } from "../lib/utils";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

/** Where password-reset emails land. The Supabase link goes through the webapp's
 *  OAuth callback (which exchanges the code for a session) and then on to the
 *  reset form. Must be listed in Supabase's allowed redirect URLs. */
const WEB_URL = (process.env.WEB_URL ?? "https://app.betterpomo.com").replace(/\/$/, "");

/**
 * POST /api/auth/register — PUBLIC (no authenticate middleware).
 * Body: { email, password, username }
 *
 * Creates the account through the anon client so Supabase applies its normal
 * signup policy (email confirmation, etc.). The username is pre-checked against
 * `profiles` for a friendlier error than the DB unique-violation, and stored in
 * user_metadata so the `handle_new_user` trigger picks it up.
 *
 * Returns { user, session }. `session` is null when email confirmation is
 * required — clients should tell the user to check their inbox.
 */
router.post("/register", async (req, res) => {
  const body = req.body ?? {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";

  if (!email || !password || !username) {
    res.status(400).json({ error: "Email, password and username are required" });
    return;
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (password.length > 72) {
    // bcrypt (Supabase's hasher) silently truncates beyond 72 bytes.
    res.status(400).json({ error: "Password must be 72 characters or less" });
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: "Username must be 3-24 characters: lowercase letters, numbers, underscores" });
    return;
  }

  const { data: taken, error: lookupError } = await adminDb
    .from("profiles")
    .select("id")
    .ilike("username", escapeLike(username))
    .limit(1)
    .maybeSingle();
  if (lookupError) { serverError(res, lookupError); return; }
  if (taken) { res.status(400).json({ error: "That username is already taken" }); return; }

  const anon = createAnonClient();
  const { data, error } = await anon.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.json({
    data: {
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
      session: data.session
        ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
        : null,
    },
  });
});

/**
 * POST /api/auth/forgot-password — PUBLIC.
 * Body: { email }
 *
 * Sends a Supabase recovery email linking to the webapp's reset form. Always
 * responds ok so the endpoint can't be used to probe which emails have accounts.
 */
router.post("/forgot-password", async (req, res) => {
  const rawEmail = req.body?.email;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }

  const anon = createAnonClient();
  const { error } = await anon.auth.resetPasswordForEmail(email, {
    redirectTo: `${WEB_URL}/auth/callback?next=/reset-password`,
  });
  // Log real failures (misconfigured SMTP, bad redirect URL) but never expose
  // whether the address has an account.
  if (error) console.error("forgot-password:", error.message);

  res.json({ data: { ok: true } });
});

export default router;
