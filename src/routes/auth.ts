import { Router } from "express";
import { adminDb, createAnonClient } from "../lib/supabase";
import { serverError } from "../lib/http";
import { escapeLike } from "../lib/utils";
import { rejectObjectionableText } from "../lib/moderation";
import { sendConfirmationCode, sendPasswordRecovery } from "../lib/authEmail";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const EMAIL_CODE_RE = /^\d{6}$/;

function publicSession(session: { access_token: string; refresh_token: string } | null) {
  return session
    ? { access_token: session.access_token, refresh_token: session.refresh_token }
    : null;
}

/** Where password-reset emails land. The Supabase link goes through the webapp's
 *  OAuth callback (which exchanges the code for a session) and then on to the
 *  reset form. Must be listed in Supabase's allowed redirect URLs. */
const WEB_URL = (process.env.WEB_URL ?? "https://app.betterpomo.com").replace(/\/$/, "");

async function resolveLoginEmail(identifier: string): Promise<string | null> {
  const normalized = identifier.trim().toLowerCase();
  if (EMAIL_RE.test(normalized) && normalized.length <= 254) return normalized;
  if (!USERNAME_RE.test(normalized)) return null;

  const { data: profile, error: profileError } = await adminDb
    .from("profiles")
    .select("id")
    .ilike("username", escapeLike(normalized))
    .limit(1)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return null;

  const { data, error } = await adminDb.auth.admin.getUserById(profile.id);
  if (error) throw error;
  return data.user?.email?.trim().toLowerCase() ?? null;
}

function isEmailNotConfirmed(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "email_not_confirmed"
    || error?.message?.toLowerCase().includes("email not confirmed") === true;
}

function deliveryFailure(
  res: Parameters<typeof serverError>[0],
  error: string,
) {
  res.status(502).json({
    error: `We couldn't send the confirmation email. ${error}`,
    code: "email_delivery_failed",
  });
}

/**
 * POST /api/auth/register — PUBLIC (no authenticate middleware).
 * Body: { email, password, username }
 *
 * Creates the account through Supabase Admin's link generator, which returns an
 * OTP without invoking SMTP. The API sends that OTP through Resend. The username
 * is pre-checked against `profiles` for a friendlier error than the DB
 * unique-violation, and stored in user_metadata for `handle_new_user`.
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
  if (rejectObjectionableText(res, [username])) return;

  const { data: taken, error: lookupError } = await adminDb
    .from("profiles")
    .select("id")
    .ilike("username", escapeLike(username))
    .limit(1)
    .maybeSingle();
  if (lookupError) { serverError(res, lookupError); return; }
  if (taken) { res.status(400).json({ error: "That username is already taken" }); return; }

  // Generate the signup OTP without asking Supabase SMTP to send it. The API
  // logs and delivers the code through Resend below, so provider failures are
  // visible and cannot leave the client on a false-success confirmation screen.
  const { data, error } = await adminDb.auth.admin.generateLink({
    type: "signup",
    email,
    password,
    options: { data: { username } },
  });
  if (error) {
    if (
      error.message.toLowerCase().includes("already")
      || error.message.toLowerCase().includes("registered")
    ) {
      res.status(409).json({
        error: "An account already exists for this email. Sign in instead.",
        code: "account_exists",
      });
      return;
    }
    console.error("auth.register signup generation failed:", error.message);
    res.status(400).json({ error: error.message });
    return;
  }

  if (!data.user || !data.properties?.email_otp || !data.properties.hashed_token) {
    res.status(500).json({ error: "Account created, but a confirmation code could not be generated" });
    return;
  }

  const delivery = await sendConfirmationCode({
    email,
    code: data.properties.email_otp,
    tokenHash: data.properties.hashed_token,
    action: "signup",
  });
  if (!delivery.ok) {
    deliveryFailure(res, delivery.error);
    return;
  }

  res.json({
    data: {
      user: { id: data.user.id, email: data.user.email },
      session: null,
    },
  });
});

/**
 * POST /api/auth/login — PUBLIC.
 * Body: { identifier, password }
 *
 * Accepts either an email address or a BetterPomo username. Username-to-email
 * resolution stays on the trusted server because auth.users is never exposed
 * through the public profiles API. If the password is correct but the email is
 * unconfirmed, a fresh code is requested and clients can switch directly to
 * their confirmation screen.
 */
router.post("/login", async (req, res) => {
  const identifier = typeof req.body?.identifier === "string"
    ? req.body.identifier.trim().toLowerCase()
    : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!identifier || !password) {
    res.status(400).json({ error: "Username/email and password are required" });
    return;
  }

  let email: string | null;
  try {
    email = await resolveLoginEmail(identifier);
  } catch (lookupError) {
    serverError(res, lookupError, "auth.login lookup");
    return;
  }
  if (!email) {
    res.status(400).json({ error: "Invalid username/email or password", code: "invalid_credentials" });
    return;
  }

  const anon = createAnonClient();
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) {
    if (isEmailNotConfirmed(error)) {
      const generated = await adminDb.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo: WEB_URL },
      });
      if (
        generated.error
        || !generated.data.properties?.email_otp
        || !generated.data.properties.hashed_token
      ) {
        console.error(
          "auth.login confirmation generation failed:",
          generated.error?.message ?? "missing OTP",
        );
        deliveryFailure(res, "Please try again.");
        return;
      }
      const delivery = await sendConfirmationCode({
        email,
        code: generated.data.properties.email_otp,
        tokenHash: generated.data.properties.hashed_token,
        action: "unconfirmed_login",
      });
      if (!delivery.ok) {
        deliveryFailure(res, delivery.error);
        return;
      }
      res.status(403).json({
        error: "Confirm your email to sign in.",
        code: "email_not_confirmed",
        verification_sent: true,
      });
      return;
    }
    res.status(400).json({ error: "Invalid username/email or password", code: "invalid_credentials" });
    return;
  }

  res.json({
    data: {
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
      session: publicSession(data.session),
    },
  });
});

/**
 * POST /api/auth/verify-email — PUBLIC.
 * Body: { email, token }
 *
 * Confirms a newly-created account with the six-digit code from Supabase and
 * returns the resulting session so web and mobile can sign the user in without
 * asking for their password again.
 */
router.post("/verify-email", async (req, res) => {
  const rawIdentifier = req.body?.identifier ?? req.body?.email;
  const rawToken = req.body?.token;
  const identifier = typeof rawIdentifier === "string" ? rawIdentifier.trim().toLowerCase() : "";
  const token = typeof rawToken === "string" ? rawToken.trim() : "";

  if (!identifier) {
    res.status(400).json({ error: "Enter a valid email address or username" });
    return;
  }
  if (!EMAIL_CODE_RE.test(token)) {
    res.status(400).json({ error: "Enter the 6-digit code from your email" });
    return;
  }

  let email: string | null;
  try {
    email = await resolveLoginEmail(identifier);
  } catch (lookupError) {
    serverError(res, lookupError, "auth.verify-email lookup");
    return;
  }
  if (!email) {
    res.status(400).json({ error: "That code is invalid or has expired. Request a new code and try again." });
    return;
  }

  const anon = createAnonClient();
  let { data, error } = await anon.auth.verifyOtp({ email, token, type: "email" });
  if (error) {
    // Resends and unconfirmed-login codes are generated as recovery OTPs so
    // Supabase can generate them for an existing account without sending SMTP.
    const recovery = await anon.auth.verifyOtp({ email, token, type: "recovery" });
    data = recovery.data;
    error = recovery.error;
  }
  if (error) {
    res.status(400).json({ error: "That code is invalid or has expired. Request a new code and try again." });
    return;
  }
  if (!data.session) {
    res.status(400).json({ error: "Email confirmed, but a session could not be created. Please sign in." });
    return;
  }

  res.json({
    data: {
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
      session: publicSession(data.session),
    },
  });
});

/**
 * POST /api/auth/resend-verification — PUBLIC.
 * Body: { email }
 *
 * Generates a fresh recovery OTP for an existing account and delivers it as a
 * confirmation code. The API's per-IP email rate limit prevents abuse.
 */
router.post("/resend-verification", async (req, res) => {
  const rawIdentifier = req.body?.identifier ?? req.body?.email;
  const identifier = typeof rawIdentifier === "string" ? rawIdentifier.trim().toLowerCase() : "";
  if (!identifier) {
    res.status(400).json({ error: "Enter a valid email address or username" });
    return;
  }

  let email: string | null;
  try {
    email = await resolveLoginEmail(identifier);
  } catch (lookupError) {
    serverError(res, lookupError, "auth.resend-verification lookup");
    return;
  }
  // Keep the public response non-enumerating. Unknown identifiers receive the
  // same success shape, but no provider request is made.
  if (!email) { res.json({ data: { ok: true } }); return; }

  const generated = await adminDb.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: WEB_URL },
  });
  if (generated.error) {
    // Keep unknown-address behavior non-enumerating.
    console.error("auth.resend-verification generation failed:", generated.error.message);
    res.json({ data: { ok: true } });
    return;
  }
  if (!generated.data.properties?.email_otp || !generated.data.properties.hashed_token) {
    deliveryFailure(res, "Please try again.");
    return;
  }

  const delivery = await sendConfirmationCode({
    email,
    code: generated.data.properties.email_otp,
    tokenHash: generated.data.properties.hashed_token,
    action: "resend",
  });
  if (!delivery.ok) {
    deliveryFailure(res, delivery.error);
    return;
  }

  res.json({ data: { ok: true } });
});

/**
 * POST /api/auth/forgot-password — PUBLIC.
 * Body: { email }
 *
 * Generates a Supabase recovery link without SMTP, then sends it through Resend.
 * Always responds ok so the endpoint can't probe which emails have accounts.
 */
router.post("/forgot-password", async (req, res) => {
  const rawEmail = req.body?.email;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }

  const { data, error } = await adminDb.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${WEB_URL}/auth/callback?next=/reset-password` },
  });
  if (error) {
    // Keep the public response non-enumerating.
    console.error("forgot-password generation:", error.message);
    res.json({ data: { ok: true } });
    return;
  }
  if (
    data.properties?.email_otp
    && data.properties.hashed_token
    && data.properties.action_link
  ) {
    await sendPasswordRecovery({
      email,
      code: data.properties.email_otp,
      tokenHash: data.properties.hashed_token,
      actionLink: data.properties.action_link,
    });
  }

  res.json({ data: { ok: true } });
});

export default router;
