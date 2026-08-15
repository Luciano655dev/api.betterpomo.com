import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import { authenticate } from "../middleware/auth";
import { perUserLimiter } from "../middleware/rateLimit";
import { renderBrandedEmail, sendEmailDetailed } from "../lib/email";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { adminDb, createAnonClient } from "../lib/supabase";
import { BILLING_ENABLED, getEntitlements, PLAN_COLUMNS, type PlanRow } from "../lib/plans";
import { rejectObjectionableText } from "../lib/moderation";

const router = Router();

// Emailing a deletion code is expensive and irreversible-adjacent; a handful
// per hour is far above any real use.
const deletionLimiter = perUserLimiter({
  windowMs: 60 * 60_000,
  limit: 5,
  message: "Too many deletion requests. Try again later.",
  name: "account-deletion",
});

// Billing columns ride along on the profile so clients gate UI (paywalls,
// locked tabs, trial countdown) from the one profile fetch they already do.
// With billing disabled they're skipped entirely — the columns may not exist
// in a DB that hasn't run migration_billing.sql yet.
const BASE_PROFILE_COLUMNS =
  "id, username, display_name, emoji, bio, is_private, onboarding_completed, marketing_emails, focus_category, focus_style, focus_peak, created_at";
const PROFILE_COLUMNS = BILLING_ENABLED
  ? `${BASE_PROFILE_COLUMNS}, ${PLAN_COLUMNS}`
  : BASE_PROFILE_COLUMNS;

/** Attach computed entitlements to a profile row before caching/returning. */
function withEntitlements<T extends Partial<PlanRow>>(row: T): T & { entitlements: ReturnType<typeof getEntitlements> } {
  return { ...row, entitlements: getEntitlements(row) };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Same rule the registration route enforces — usernames appear in URLs and @mentions.
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const PERSONALIZATION_CACHE_PREFIX = "personalization:";
const FOCUS_CATEGORIES = ["study", "work", "build", "read", "other"] as const;
const FOCUS_GOALS = ["finish", "deadline", "habit", "progress", "structure"] as const;
const FOCUS_STYLES = ["solo", "friends", "team"] as const;
const FOCUS_PEAKS = ["morning", "afternoon", "evening", "night", "varies"] as const;
const FOCUS_OBSTACLES = ["procrastination", "distractions", "consistency", "burnout", "overwhelm"] as const;
const MOTIVATION_STYLES = ["progress", "streaks", "accountability", "gentle", "challenge"] as const;
const WEEKLY_TARGETS = [2, 3, 4, 5, 7] as const;
const FOCUS_MINUTES = [15, 25, 35, 45, 55] as const;

function oneOf<T extends readonly unknown[]>(value: unknown, values: T): value is T[number] {
  return values.includes(value as never);
}

function usernameBase(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): string {
  const meta = user.user_metadata ?? {};
  const source = [meta.username, meta.full_name, meta.name, user.email?.split("@")[0]]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const sanitized = (source ?? "user")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return sanitized.length >= 3 ? sanitized : `user_${user.id.replace(/-/g, "").slice(0, 8)}`;
}

function normalizedDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || Array.from(normalized).length > 50 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function invalidateIdentity(userId: string) {
  cache.del(`profile:${userId}`);
  cache.delByPrefix("user:");
  cache.delByPrefix("search:");
  cache.delByPrefix("user-hist:");
  cache.delByPrefix("user-friends:");
  cache.delByPrefix("friends:");
  cache.delByPrefix("friend-reqs:");
  cache.delByPrefix("conversations:");
  cache.delByPrefix("feedback:");
}

function usernameCandidate(base: string, attempt: number, userId: string): string {
  if (attempt === 0) return base;
  if (attempt <= 50) {
    const suffix = String(attempt);
    return `${base.slice(0, 24 - suffix.length)}${suffix}`;
  }
  return `user_${userId.replace(/-/g, "").slice(0, 12)}`;
}

/** Confirms `password` is the account's current password by attempting a sign-in
 *  with a throwaway anon client. Returns true on success. The session it creates
 *  is never persisted (persistSession: false). */
async function verifyPassword(email: string, password: string): Promise<boolean> {
  const anon = createAnonClient();
  const { error } = await anon.auth.signInWithPassword({ email, password });
  return !error;
}

/** Whether the account already has an email/password credential. OAuth-only
 *  users (e.g. signed up with Google) have no "email" identity until they set
 *  a password, so this distinguishes "set a password" from "change password". */
function hasPasswordIdentity(user: { identities?: { provider: string }[] }): boolean {
  return (user.identities ?? []).some((i) => i.provider === "email");
}

/** Private onboarding answers used by the mobile app and future personalization. */
router.get("/personalization", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const cacheKey = `${PERSONALIZATION_CACHE_PREFIX}${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const { data, error } = await supabase
    .from("user_personalization")
    .select("survey_version, focus_category, focus_goal, focus_style, focus_peak, weekly_target_days, preferred_focus_minutes, focus_obstacle, motivation_style, created_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) { serverError(res, error); return; }
  if (data) cache.set(cacheKey, data, TTL.PROFILE);
  res.json({ data: data ?? null });
});

/** Idempotently persist one complete onboarding survey. */
router.put("/personalization", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const body = req.body ?? {};
  if (
    !oneOf(body.focus_category, FOCUS_CATEGORIES)
    || !oneOf(body.focus_goal, FOCUS_GOALS)
    || !oneOf(body.focus_style, FOCUS_STYLES)
    || !oneOf(body.focus_peak, FOCUS_PEAKS)
    || !oneOf(body.weekly_target_days, WEEKLY_TARGETS)
    || !oneOf(body.preferred_focus_minutes, FOCUS_MINUTES)
    || !oneOf(body.focus_obstacle, FOCUS_OBSTACLES)
    || !oneOf(body.motivation_style, MOTIVATION_STYLES)
  ) {
    res.status(400).json({ error: "A complete, valid personalization survey is required" });
    return;
  }

  const now = new Date().toISOString();
  const payload = {
    user_id: user.id,
    survey_version: 3,
    focus_category: body.focus_category,
    focus_goal: body.focus_goal,
    focus_style: body.focus_style,
    focus_peak: body.focus_peak,
    weekly_target_days: body.weekly_target_days,
    preferred_focus_minutes: body.preferred_focus_minutes,
    focus_obstacle: body.focus_obstacle,
    motivation_style: body.motivation_style,
    updated_at: now,
  };
  const { data, error } = await supabase
    .from("user_personalization")
    .upsert(payload, { onConflict: "user_id" })
    .select("survey_version, focus_category, focus_goal, focus_style, focus_peak, weekly_target_days, preferred_focus_minutes, focus_obstacle, motivation_style, created_at, updated_at")
    .single();
  if (error) { serverError(res, error); return; }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      focus_category: body.focus_category,
      focus_style: body.focus_style,
      focus_peak: body.focus_peak,
    })
    .eq("id", user.id);
  if (profileError) { serverError(res, profileError); return; }

  cache.del(`${PERSONALIZATION_CACHE_PREFIX}${user.id}`);
  invalidateIdentity(user.id);
  cache.set(`${PERSONALIZATION_CACHE_PREFIX}${user.id}`, data, TTL.PROFILE);
  res.json({ data });
});

/** GET /api/profile — returns the authenticated user's profile */
router.get("/", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const cacheKey = `profile:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", user.id)
    .maybeSingle();
  if (error) { serverError(res, error); return; }

  // Self-heal a missing profile row. The `handle_new_user` trigger normally
  // creates this on signup, but accounts that predate the trigger — or where it
  // didn't fire (some OAuth flows) — would otherwise 500 here forever, leaving
  // the user stuck in an app shell with no profile. Mirror the trigger's logic.
  if (!data) {
    const base = usernameBase(user);
    for (let attempt = 0; attempt <= 51; attempt += 1) {
      const result = await supabase
        .from("profiles")
        .insert({
          id: user.id,
          username: usernameCandidate(base, attempt, user.id),
          display_name: usernameCandidate(base, attempt, user.id),
          emoji: "🍅",
        })
        .select(PROFILE_COLUMNS)
        .single();
      if (!result.error) {
        const enrichedCreated = withEntitlements(result.data as Partial<PlanRow>);
        cache.set(cacheKey, enrichedCreated, TTL.PROFILE);
        res.json({ data: enrichedCreated });
        return;
      }
      if (result.error.code !== "23505") { serverError(res, result.error); return; }

      // A concurrent request may have inserted this user's row first. Return it
      // instead of continuing to generate usernames for an existing profile.
      const concurrent = await supabase
        .from("profiles")
        .select(PROFILE_COLUMNS)
        .eq("id", user.id)
        .maybeSingle();
      if (concurrent.error) { serverError(res, concurrent.error); return; }
      if (concurrent.data) {
        const enrichedCreated = withEntitlements(concurrent.data as Partial<PlanRow>);
        cache.set(cacheKey, enrichedCreated, TTL.PROFILE);
        res.json({ data: enrichedCreated });
        return;
      }
    }
    serverError(res, new Error("Could not allocate a unique username"));
    return;
  }

  const enriched = withEntitlements(data as Partial<PlanRow>);
  cache.set(cacheKey, enriched, TTL.PROFILE);
  res.json({ data: enriched });
});

/** PATCH /api/profile
 *  Body: { username?, display_name?, emoji?, bio?, is_private?, onboarding_completed? } */
router.patch("/", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const body = req.body;
  if (!body) { res.status(400).json({ error: "Request body required" }); return; }

  if (typeof body.bio === "string" && body.bio.length > 300) {
    res.status(400).json({ error: "Bio must be 300 characters or less" }); return;
  }
  if (body.username !== undefined && !USERNAME_RE.test(String(body.username).trim().toLowerCase())) {
    res.status(400).json({ error: "Username must be 3-24 characters: lowercase letters, numbers, underscores" }); return;
  }
  if (body.display_name !== undefined && normalizedDisplayName(body.display_name) === null) {
    res.status(400).json({ error: "Display name must be 1-50 characters" }); return;
  }
  if (rejectObjectionableText(res, [body.username, body.display_name, body.bio])) return;
  const patch: Record<string, unknown> = {};
  if (typeof body.username === "string" && body.username.trim()) patch.username = body.username.trim().toLowerCase();
  if (body.display_name !== undefined) patch.display_name = normalizedDisplayName(body.display_name);
  if (typeof body.emoji === "string" && body.emoji.trim()) patch.emoji = body.emoji.trim();
  if (body.bio === null || typeof body.bio === "string") patch.bio = body.bio ?? null;
  if (typeof body.is_private === "boolean") patch.is_private = body.is_private;
  if (typeof body.onboarding_completed === "boolean") patch.onboarding_completed = body.onboarding_completed;
  if (typeof body.marketing_emails === "boolean") patch.marketing_emails = body.marketing_emails;
  if (typeof body.focus_category === "string" && FOCUS_CATEGORIES.includes(body.focus_category)) patch.focus_category = body.focus_category;
  if (typeof body.focus_style === "string" && FOCUS_STYLES.includes(body.focus_style)) patch.focus_style = body.focus_style;
  if (typeof body.focus_peak === "string" && FOCUS_PEAKS.includes(body.focus_peak)) patch.focus_peak = body.focus_peak;
  if (!Object.keys(patch).length) { res.status(400).json({ error: "Nothing to update" }); return; }

  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", user.id)
    .select(PROFILE_COLUMNS)
    .single();

  if (error?.code === "23505") {
    res.status(409).json({ error: "That username is already taken" });
    return;
  }
  if (error) { serverError(res, error); return; }

  // Invalidate own profile, all public user lookups, and search results. A
  // privacy (is_private) toggle also flips whether this user's public history
  // and friends list are visible, so drop those gated caches too. Then
  // immediately re-populate the profile cache with the fresh value.
  invalidateIdentity(user.id);
  const enriched = withEntitlements(data as Partial<PlanRow>);
  cache.set(`profile:${user.id}`, enriched, TTL.PROFILE);

  res.json({ data: enriched });
});

/** POST /api/profile/initialize-oauth-identity
 * Native Apple returns the person's name outside its ID token. During first-run
 * onboarding, allocate that provider name as both the handle and display name. */
router.post("/initialize-oauth-identity", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const providerName = normalizedDisplayName(req.body?.provider_name);
  if (!providerName) { res.status(400).json({ error: "A valid provider_name is required" }); return; }
  if (rejectObjectionableText(res, [providerName])) return;
  if (!(user.identities ?? []).some((identity) => identity.provider === "apple" || identity.provider === "google")) {
    res.status(403).json({ error: "OAuth identity required" }); return;
  }

  const { data: current, error: currentError } = await supabase
    .from("profiles")
    .select("id, onboarding_completed")
    .eq("id", user.id)
    .single();
  if (currentError) { serverError(res, currentError); return; }
  if (current.onboarding_completed) {
    res.status(409).json({ error: "Identity is already initialized" }); return;
  }

  const base = usernameBase({ id: user.id, user_metadata: { name: providerName } });
  for (let attempt = 0; attempt <= 51; attempt += 1) {
    const candidate = usernameCandidate(base, attempt, user.id);
    const result = await supabase
      .from("profiles")
      .update({ username: candidate, display_name: candidate })
      .eq("id", user.id)
      .select(PROFILE_COLUMNS)
      .single();
    if (!result.error) {
      invalidateIdentity(user.id);
      const enriched = withEntitlements(result.data as Partial<PlanRow>);
      cache.set(`profile:${user.id}`, enriched, TTL.PROFILE);
      res.json({ data: enriched });
      return;
    }
    if (result.error.code !== "23505") { serverError(res, result.error); return; }
  }
  serverError(res, new Error("Could not allocate a unique username"));
});

/** POST /api/profile/password — change the account password.
 *  Body: { currentPassword, newPassword }. Gated on the current password. */
router.post("/password", authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body ?? {};
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current and new password are required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: "New password must be different from the current one" });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: "This account has no email/password login" });
    return;
  }

  if (!(await verifyPassword(user.email, currentPassword))) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }

  const { error } = await adminDb.auth.admin.updateUserById(user.id, { password: newPassword });
  if (error) { serverError(res, error); return; }

  res.json({ data: { success: true } });
});

/** POST /api/profile/password/set — set an initial password for an account that
 *  has none (e.g. created via Google). No current password to verify; the caller
 *  is already authenticated via their existing (OAuth) session. Once set, the
 *  user can also sign in with email + password. */
router.post("/password/set", authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body ?? {};
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!newPassword) {
    res.status(400).json({ error: "A new password is required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: "This account has no email to attach a password to" });
    return;
  }
  // If a password already exists, force the verified change flow instead — this
  // is what stops a hijacked session from silently overwriting a known password.
  if (hasPasswordIdentity(user)) {
    res.status(400).json({ error: "This account already has a password. Use change password instead." });
    return;
  }

  const { error } = await adminDb.auth.admin.updateUserById(user.id, {
    password: newPassword,
    email_confirm: true,
  });
  if (error) { serverError(res, error); return; }

  res.json({ data: { success: true } });
});

/** POST /api/profile/email — change the account email.
 *  Body: { newEmail, currentPassword }. Gated on the current password. */
router.post("/email", authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body ?? {};
  const newEmail = typeof body.newEmail === "string" ? body.newEmail.trim().toLowerCase() : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

  if (!newEmail || !currentPassword) {
    res.status(400).json({ error: "New email and current password are required" });
    return;
  }
  if (!EMAIL_RE.test(newEmail)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: "This account has no email/password login" });
    return;
  }
  if (newEmail === user.email.toLowerCase()) {
    res.status(400).json({ error: "That is already your email" });
    return;
  }

  if (!(await verifyPassword(user.email, currentPassword))) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }

  // Set + confirm the new email directly with the service-role admin client.
  const { data, error } = await adminDb.auth.admin.updateUserById(user.id, {
    email: newEmail,
    email_confirm: true,
  });
  if (error) {
    // Most commonly a duplicate-email conflict.
    res.status(400).json({ error: error.message });
    return;
  }

  res.json({ data: { email: data.user?.email ?? newEmail } });
});

/** DELETE /api/profile — permanently delete the authenticated user's account.
 *  Required for App Store / Play compliance (in-app account deletion). The client
 *  is responsible for confirming intent; this endpoint executes it.
 *
 *  Order matters: hand off any sessions the user still owns *before* removing the
 *  auth user, otherwise the ON DELETE CASCADE on session_participants would orphan
 *  a live session with no owner. Then delete the auth user, which cascades to the
 *  profile and all user-owned rows. */
// ── Account deletion ─────────────────────────────────────────────────────────

/** How long an emailed deletion code stays valid. */
const DELETION_CODE_TTL_MS = 15 * 60_000;
/** Wrong guesses allowed before the code is burned and must be re-requested. */
const DELETION_CODE_MAX_ATTEMPTS = 5;
/** Grace period before purge_deleted_accounts() removes the data for good. */
const DELETION_GRACE_DAYS = 30;

/** POST /api/profile/delete/request — email a confirmation code.
 *  Deleting an account is irreversible after the grace period, so it takes
 *  possession of the account's inbox, not just a logged-in session. */
router.post("/delete/request", authenticate, deletionLimiter, async (req, res) => {
  const { user } = req;
  if (!user.email) {
    res.status(400).json({ error: "This account has no email address to confirm with." });
    return;
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + DELETION_CODE_TTL_MS);
  const { error: storeError } = await adminDb.from("account_deletion_requests").upsert({
    user_id: user.id,
    code_hash: await bcrypt.hash(code, 10),
    attempts: 0,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (storeError) { serverError(res, storeError, "delete-request"); return; }

  const sent = await sendEmailDetailed({
    to: user.email,
    subject: "Confirm deleting your BetterPomo account",
    text:
      `Your BetterPomo account deletion code is ${code}. It expires in 15 minutes.\n\n`
      + `If you did not request this, ignore this email and change your password — `
      + `your account stays exactly as it is.`,
    html: renderBrandedEmail({
      preview: "Confirm deleting your BetterPomo account",
      eyebrow: "ACCOUNT DELETION",
      heading: "Confirm you want to delete your account",
      code,
      paragraphs: [
        "Enter this code in the app to confirm. It expires in 15 minutes.",
        `Your account and history are recoverable for ${DELETION_GRACE_DAYS} days after deletion — contact support within that window and we can restore it.`,
      ],
      notice: "Didn't request this? Ignore this email and change your password. Nothing has been deleted.",
    }),
    tags: [{ name: "type", value: "account-deletion" }],
  });

  if (!sent.ok) {
    console.error("[delete] confirmation email failed", { userId: user.id, error: sent.error });
    res.status(502).json({ error: "Could not send the confirmation email. Please try again." });
    return;
  }

  console.info("[delete] confirmation code sent", { userId: user.id });
  res.json({ data: { sent: true, expires_at: expiresAt.toISOString() } });
});

/** Verify (and consume an attempt of) the emailed deletion code. */
async function deletionCodeValid(userId: string, supplied: unknown): Promise<
  { ok: true } | { ok: false; status: number; error: string }
> {
  if (typeof supplied !== "string" || !supplied.trim()) {
    return { ok: false, status: 400, error: "Enter the confirmation code from your email." };
  }
  const { data: request } = await adminDb
    .from("account_deletion_requests")
    .select("code_hash, attempts, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (!request) {
    return { ok: false, status: 400, error: "Request a confirmation code first." };
  }
  const row = request as { code_hash: string; attempts: number; expires_at: string };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await adminDb.from("account_deletion_requests").delete().eq("user_id", userId);
    return { ok: false, status: 400, error: "That code has expired. Request a new one." };
  }
  if (row.attempts >= DELETION_CODE_MAX_ATTEMPTS) {
    await adminDb.from("account_deletion_requests").delete().eq("user_id", userId);
    return { ok: false, status: 429, error: "Too many incorrect codes. Request a new one." };
  }
  if (!(await bcrypt.compare(supplied.trim(), row.code_hash))) {
    await adminDb
      .from("account_deletion_requests")
      .update({ attempts: row.attempts + 1 })
      .eq("user_id", userId);
    return { ok: false, status: 400, error: "That code is not correct." };
  }
  return { ok: true };
}

/** DELETE /api/profile — soft-delete the account. Body: { code }
 *  The row is marked and hidden, then hard-deleted by the scheduled purge
 *  DELETION_GRACE_DAYS later (migration_soft_delete_accounts.sql), so an
 *  accidental deletion can still be undone with restore_deleted_account(). */
router.delete("/", authenticate, async (req, res) => {
  const { user } = req;

  const codeCheck = await deletionCodeValid(user.id, (req.body ?? {}).code);
  if (!codeCheck.ok) {
    console.warn("[delete] rejected", { userId: user.id, reason: codeCheck.error });
    res.status(codeCheck.status).json({ error: codeCheck.error });
    return;
  }

  // 1. Reassign or tear down active sessions this user owns.
  const { data: ownedActive } = await adminDb
    .from("session_participants")
    .select("session_id, pomodoro_sessions!inner(status)")
    .eq("user_id", user.id)
    .eq("role", "owner")
    .is("left_at", null)
    .in("pomodoro_sessions.status", ["waiting", "active"]);

  for (const row of (ownedActive ?? []) as { session_id: string }[]) {
    const sid = row.session_id;
    const { data: others } = await adminDb
      .from("session_participants")
      .select("id, user_id, role, joined_at")
      .eq("session_id", sid)
      .is("left_at", null)
      .neq("user_id", user.id)
      .order("joined_at", { ascending: true });

    if (!others?.length) {
      // Sole remaining member — delete the session outright.
      await adminDb.from("pomodoro_sessions").delete().eq("id", sid);
    } else {
      // Transfer ownership: prefer an existing admin, else the earliest joiner.
      // Reassign BOTH the participant role and pomodoro_sessions.owner_id — the
      // latter also cascades on profile delete, so leaving it pointed at this
      // user would destroy the session the moment the account is removed.
      const next = (others.find((o) => o.role === "admin") ?? others[0]) as { id: string; user_id: string };
      await adminDb.from("session_participants").update({ role: "owner" }).eq("id", next.id);
      await adminDb.from("pomodoro_sessions").update({ owner_id: next.user_id }).eq("id", sid);
    }
  }

  // 2. Transfer governed groups as well. A group's creator FK cascades on
  // profile deletion, so ownership must move before the auth row disappears.
  const { data: ownedGroups, error: ownedGroupsError } = await adminDb
    .from("conversations")
    .select("id")
    .eq("created_by", user.id)
    .eq("is_group", true);
  if (ownedGroupsError) { serverError(res, ownedGroupsError); return; }

  for (const group of (ownedGroups ?? []) as { id: string }[]) {
    const { data: others, error: membersError } = await adminDb
      .from("conversation_members")
      .select("user_id, role, joined_at")
      .eq("conversation_id", group.id)
      .neq("user_id", user.id)
      .order("joined_at", { ascending: true });
    if (membersError) { serverError(res, membersError); return; }

    if (!others?.length) {
      const { error: deleteGroupError } = await adminDb.from("conversations").delete().eq("id", group.id);
      if (deleteGroupError) { serverError(res, deleteGroupError); return; }
      continue;
    }

    const next = (others.find((member) => member.role === "admin") ?? others[0]) as { user_id: string };
    const { error: transferError } = await adminDb.rpc("transfer_group_ownership", {
      p_actor: user.id,
      p_conversation_id: group.id,
      p_new_owner: next.user_id,
    });
    if (transferError) { serverError(res, transferError); return; }
  }

  // 3. Mark the account deleted rather than destroying it. Reads filter on
  //    deleted_at, and purge_deleted_accounts() removes it for good after the
  //    grace period — until then restore_deleted_account() can undo this.
  const deletedAt = new Date().toISOString();
  const { error } = await adminDb
    .from("profiles")
    .update({ deleted_at: deletedAt })
    .eq("id", user.id);
  if (error) {
    console.error("[delete] soft delete failed", { userId: user.id, error });
    res.status(500).json({ error: "Could not delete account" });
    return;
  }

  // Ban the auth user so the account cannot be signed into during the grace
  // period. restore_deleted_account() lifts this again.
  const { error: banError } = await adminDb.auth.admin.updateUserById(user.id, {
    ban_duration: `${DELETION_GRACE_DAYS * 24}h`,
  });
  if (banError) console.error("[delete] could not ban signed-out account", { userId: user.id, error: banError });

  await adminDb.from("account_deletion_requests").delete().eq("user_id", user.id);
  const purgeAt = new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000).toISOString();
  console.info("[delete] account soft-deleted", { userId: user.id, deletedAt, purgeAt });

  // 4. Drop every cache entry that referenced this user.
  cache.del(`profile:${user.id}`);
  cache.del(`plan:${user.id}`);
  cache.del(`billing:${user.id}`);
  cache.del(`templates:${user.id}`);
  cache.delByPrefix(`history:${user.id}:`);
  cache.del(`history-analytics:${user.id}`);
  cache.delByPrefix(`friends:${user.id}:`);
  cache.del(`friend-count:${user.id}`);
  cache.del(`friend-reqs:${user.id}`);
  cache.del(`conversations:${user.id}`);
  cache.del(`notif:${user.id}`);
  cache.delByPrefix("user:");
  cache.delByPrefix("search:");
  cache.delByPrefix("user-hist:");
  cache.delByPrefix("user-friends:");

  res.json({ data: { deleted: true, restorable_until: purgeAt } });
});

export default router;
