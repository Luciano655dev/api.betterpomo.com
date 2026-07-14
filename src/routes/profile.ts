import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { adminDb, createAnonClient } from "../lib/supabase";
import { BILLING_ENABLED, getEntitlements, PLAN_COLUMNS, type PlanRow } from "../lib/plans";

const router = Router();

// Billing columns ride along on the profile so clients gate UI (paywalls,
// locked tabs, trial countdown) from the one profile fetch they already do.
// With billing disabled they're skipped entirely — the columns may not exist
// in a DB that hasn't run migration_billing.sql yet.
const BASE_PROFILE_COLUMNS =
  "id, username, emoji, bio, is_private, onboarding_completed, marketing_emails, focus_category, focus_style, focus_peak, created_at";
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

function usernameBase(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): string {
  const meta = user.user_metadata ?? {};
  const source = [meta.username, meta.full_name, meta.name, user.email?.split("@")[0]]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const sanitized = (source ?? "user").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return sanitized.length >= 3 ? sanitized : `user_${user.id.replace(/-/g, "").slice(0, 8)}`;
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
        .insert({ id: user.id, username: usernameCandidate(base, attempt, user.id), emoji: "🍅" })
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
 *  Body: { username?, emoji?, bio?, is_private?, onboarding_completed? } */
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
  const patch: Record<string, unknown> = {};
  if (typeof body.username === "string" && body.username.trim()) patch.username = body.username.trim().toLowerCase();
  if (typeof body.emoji === "string" && body.emoji.trim()) patch.emoji = body.emoji.trim();
  if (body.bio === null || typeof body.bio === "string") patch.bio = body.bio ?? null;
  if (typeof body.is_private === "boolean") patch.is_private = body.is_private;
  if (typeof body.onboarding_completed === "boolean") patch.onboarding_completed = body.onboarding_completed;
  if (typeof body.marketing_emails === "boolean") patch.marketing_emails = body.marketing_emails;
  const FOCUS_CATEGORIES = ["study", "work", "build", "read", "other"];
  const FOCUS_STYLES = ["solo", "friends", "team"];
  if (typeof body.focus_category === "string" && FOCUS_CATEGORIES.includes(body.focus_category)) patch.focus_category = body.focus_category;
  if (typeof body.focus_style === "string" && FOCUS_STYLES.includes(body.focus_style)) patch.focus_style = body.focus_style;
  const FOCUS_PEAKS = ["morning", "afternoon", "evening", "night"];
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
  cache.del(`profile:${user.id}`);
  cache.delByPrefix("user:");
  cache.delByPrefix("search:");
  cache.delByPrefix("user-hist:");
  cache.delByPrefix("user-friends:");
  const enriched = withEntitlements(data as Partial<PlanRow>);
  cache.set(`profile:${user.id}`, enriched, TTL.PROFILE);

  res.json({ data: enriched });
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
router.delete("/", authenticate, async (req, res) => {
  const { user } = req;

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

  // 2. Delete the auth user (cascades to profile + dependent rows via FK).
  const { error } = await adminDb.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("Account deletion failed:", error);
    res.status(500).json({ error: "Could not delete account" });
    return;
  }

  // 3. Drop every cache entry that referenced this user.
  cache.del(`profile:${user.id}`);
  cache.del(`plan:${user.id}`);
  cache.del(`billing:${user.id}`);
  cache.del(`templates:${user.id}`);
  cache.delByPrefix(`history:${user.id}:`);
  cache.delByPrefix(`friends:${user.id}:`);
  cache.del(`friend-count:${user.id}`);
  cache.del(`friend-reqs:${user.id}`);
  cache.del(`conversations:${user.id}`);
  cache.del(`notif:${user.id}`);
  cache.delByPrefix("user:");
  cache.delByPrefix("search:");
  cache.delByPrefix("user-hist:");
  cache.delByPrefix("user-friends:");

  res.json({ data: { deleted: true } });
});

export default router;
