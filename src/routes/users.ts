import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { clampInt, escapeLike } from "../lib/utils";
import { BILLING_ENABLED, getEntitlements, getUserEntitlements, type PlanRow } from "../lib/plans";

const router = Router();
router.use(authenticate);

// The activity calendar + stats on a profile read the whole history client-side,
// so this isn't page-by-page — but it must still be bounded so a pathological
// account can't dump an unbounded result set. A generous ceiling covers any real
// user (years of daily sessions) while capping the worst case.
const PUBLIC_HISTORY_MAX = 1000;

/** Resolve a public username without ever sending an authenticated user to
 * another profile that happens to have the same legacy username. New database
 * constraints prevent duplicates, but this owner-first lookup also repairs the
 * experience for accounts created before that migration is applied. */
async function resolveProfileByUsername(
  supabase: SupabaseClient,
  username: string,
  viewerId: string,
  columns: string,
) {
  const own = await supabase
    .from("profiles")
    .select(columns)
    .eq("username", username)
    .eq("id", viewerId)
    .maybeSingle();
  if (own.error) return { profile: null, error: own.error };
  if (own.data) return { profile: own.data as unknown as Record<string, unknown>, error: null };

  const fallback = await supabase
    .from("profiles")
    .select(columns)
    .eq("username", username)
    .order("created_at", { ascending: true })
    .limit(1);
  return {
    profile: (fallback.data?.[0] as unknown as Record<string, unknown> | undefined) ?? null,
    error: fallback.error,
  };
}

// GET /api/users/search?q=&page=1&limit=18
router.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  const page = clampInt(req.query.page, { min: 1, max: 100_000, fallback: 1 });
  const limit = clampInt(req.query.limit, { min: 1, max: 50, fallback: 18 });
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const cacheKey = `search:${q}:${page}:${limit}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  let query = req.supabase
    .from("profiles")
    .select("id, username, display_name, emoji, bio, is_private", { count: "exact" })
    .order("display_name")
    .range(from, to);

  if (q) {
    // PostgREST's raw `.or()` filter treats commas/parentheses as syntax.
    const escaped = escapeLike(q).replace(/[(),]/g, "");
    query = query.or(`username.ilike.%${escaped}%,display_name.ilike.%${escaped}%`);
  }

  const { data, count, error } = await query;

  if (error) { serverError(res, error); return; }

  const total = count ?? 0;
  const payload = { results: data ?? [], total, page, totalPages: Math.ceil(total / limit) };
  cache.set(cacheKey, payload, TTL.SEARCH);
  res.json({ data: payload });
});

// GET /api/users/:username
router.get("/:username", async (req, res) => {
  const username = String(req.params.username);

  // Typed as plain string so supabase-js doesn't literal-parse the union.
  const publicColumns: string = BILLING_ENABLED
    ? "id, username, display_name, emoji, bio, is_private, plan, plan_status, plan_period_end"
    : "id, username, display_name, emoji, bio, is_private";
  const { profile, error } = await resolveProfileByUsername(
    req.supabase,
    username,
    req.user.id,
    publicColumns,
  );

  if (error) { serverError(res, error); return; }
  if (!profile) { res.status(404).json({ error: "User not found" }); return; }

  // Cache by immutable profile id, not by a potentially duplicated legacy
  // username. Otherwise one viewer could prime another account's response.
  const cacheKey = `user:${String(profile.id)}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  // Expose a computed badge, never raw billing columns.
  const row = profile;
  const { plan: _p, plan_status: _ps, plan_period_end: _pe, ...publicProfile } = row;
  void _p; void _ps; void _pe;
  const payload = { ...publicProfile, badge: getEntitlements(row as Partial<PlanRow>).badge };

  cache.set(cacheKey, payload, TTL.USER);
  res.json({ data: payload });
});

// GET /api/users/:username/history
router.get("/:username/history", async (req, res) => {
  const username = String(req.params.username);

  const { profile: resolved, error: profileError } = await resolveProfileByUsername(
    req.supabase,
    username,
    req.user.id,
    "id, is_private",
  );
  if (profileError) { serverError(res, profileError); return; }
  const profile = resolved as { id: string; is_private: boolean } | null;
  if (!profile) { res.status(404).json({ error: "User not found" }); return; }

  // The gated result differs by viewer (owner sees full history, others see []
  // for a private account), so the cache key carries an own/pub discriminator —
  // same pattern as /:username/friends.
  const isOwner = profile.id === req.user.id;
  const cacheKey = `user-hist:${profile.id}:${isOwner ? "own" : "pub"}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  // Private accounts return empty history to non-owners
  if (profile.is_private && !isOwner) {
    cache.set(cacheKey, [], TTL.USER_HISTORY);
    res.json({ data: [] });
    return;
  }

  let query = req.supabase
    .from("pomodoro_history")
    .select("id, session_name, timers_used, participants, duration_seconds, focus_seconds, completed_at, tasks")
    .eq("user_id", profile.id)
    .order("completed_at", { ascending: false })
    .range(0, PUBLIC_HISTORY_MAX - 1);

  // Per-session privacy: sessions that were private when saved are visible only
  // to the owner, even on an otherwise-public profile. The owner sees everything.
  if (!isOwner) query = query.eq("was_private", false);

  // The history window follows the PROFILE OWNER's plan: a free account shows
  // only its last 30 days, to the owner and visitors alike.
  const ownerEnt = await getUserEntitlements(profile.id);
  if (ownerEnt.historyDays !== null) {
    const cutoff = new Date(Date.now() - ownerEnt.historyDays * 24 * 60 * 60_000).toISOString();
    query = query.gte("completed_at", cutoff);
  }

  const { data, error } = await query;

  if (error) { serverError(res, error); return; }
  cache.set(cacheKey, data ?? [], TTL.USER_HISTORY);
  res.json({ data: data ?? [] });
});

// GET /api/users/:username/friends
// Friend count is public; the list is gated like history (owner always; others
// only if the account is not private).
router.get("/:username/friends", async (req, res) => {
  const username = String(req.params.username);

  const { profile: resolved, error: profileError } = await resolveProfileByUsername(
    req.supabase,
    username,
    req.user.id,
    "id, is_private",
  );
  if (profileError) { serverError(res, profileError); return; }
  const profile = resolved as { id: string; is_private: boolean } | null;
  if (!profile) { res.status(404).json({ error: "User not found" }); return; }

  const cacheKey = `user-friends:${profile.id}:${req.user.id === profile.id ? "own" : "pub"}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const { data: count, error: countErr } = await req.supabase
    .rpc("count_friends", { p_user_id: profile.id });
  if (countErr) { serverError(res, countErr); return; }

  const gated = profile.is_private && profile.id !== req.user.id;
  let friends: unknown[] = [];
  if (!gated) {
    const { data, error } = await req.supabase
      .rpc("get_friends", { p_user_id: profile.id, p_limit: 100, p_offset: 0 });
    if (error) { serverError(res, error); return; }
    friends = data ?? [];
  }

  const payload = { count: count ?? 0, friends };
  cache.set(cacheKey, payload, TTL.FRIENDS);
  res.json({ data: payload });
});

// GET /api/users/:username/active-session
router.get("/:username/active-session", async (req, res) => {
  const username = String(req.params.username);

  const { profile: resolved, error: profileError } = await resolveProfileByUsername(
    req.supabase,
    username,
    req.user.id,
    "id, is_private",
  );
  if (profileError) { serverError(res, profileError); return; }
  const profile = resolved as { id: string; is_private: boolean } | null;
  if (!profile) { res.status(404).json({ error: "User not found" }); return; }

  if (profile.is_private && profile.id !== req.user.id) {
    res.json({ data: null });
    return;
  }

  const { data, error } = await req.supabase
    .rpc("get_user_active_session", { p_user_id: profile.id });

  if (error) { serverError(res, error); return; }
  const sessionName = data?.[0]?.session_name ?? null;
  res.json({ data: sessionName ? { session_name: sessionName } : null });
});

export default router;
