import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { clampInt } from "../lib/utils";
import { getUserEntitlements, TIMERS_HARD_CAP, upgradeRequired } from "../lib/plans";
import { getSessionTimeMetrics } from "../lib/sessionTime";

const router = Router();

// A saved history row is a snapshot, not live data — these bound what one row
// can hold so a crafted client cannot store megabytes per session.
const MAX_TIMER_SECONDS = 24 * 60 * 60;
const MAX_HISTORY_PARTICIPANTS = 50;

/** Free-plan cutoff: entries older than this many days are hidden (kept in the
 *  DB — they unlock instantly on upgrade). Null historyDays = no cutoff. */
function historyCutoffISO(historyDays: number | null): string | null {
  if (historyDays === null) return null;
  return new Date(Date.now() - historyDays * 24 * 60 * 60_000).toISOString();
}

/** GET /api/history — user's session history.
 *  Free plan sees the last 30 days (Pro: unlimited + optional ?from/?to range).
 *  Response stays a bare array for mobile back-compat; the locked-entry count
 *  lives in GET /api/history/summary. */
router.get("/", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 50 });
  const offset = clampInt(req.query.offset, { min: 0, max: 1_000_000, fallback: 0 });
  const ent = await getUserEntitlements(user.id);

  // Custom date ranges are part of advanced analytics (Pro).
  const from = typeof req.query.from === "string" ? req.query.from : null;
  const to = typeof req.query.to === "string" ? req.query.to : null;
  if ((from || to) && !ent.analytics) { upgradeRequired(res, "analytics"); return; }

  const cutoff = historyCutoffISO(ent.historyDays);
  const cacheKey = `history:${user.id}:${limit}:${offset}`;
  const cacheable = !from && !to; // ranged queries are ad-hoc — don't cache
  if (cacheable) {
    const hit = cache.get(cacheKey);
    if (hit) { res.json({ data: hit }); return; }
  }

  let query = supabase
    .from("pomodoro_history")
    .select("id, session_id, session_name, timers_used, participants, duration_seconds, focus_seconds, completed_at, tasks")
    .eq("user_id", user.id);
  if (cutoff) query = query.gte("completed_at", cutoff);
  if (from && !Number.isNaN(Date.parse(from))) query = query.gte("completed_at", new Date(Date.parse(from)).toISOString());
  if (to && !Number.isNaN(Date.parse(to))) query = query.lte("completed_at", new Date(Date.parse(to)).toISOString());
  const { data, error } = await query
    .order("completed_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { serverError(res, error); return; }
  if (cacheable) cache.set(cacheKey, data, TTL.HISTORY);
  res.json({ data });
});

/** GET /api/history/summary — visible vs. locked entry counts for the caller.
 *  Free users use locked_count to render the "N older sessions locked" block. */
router.get("/summary", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const cacheKey = `history-summary:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const ent = await getUserEntitlements(user.id);
  const cutoff = historyCutoffISO(ent.historyDays);

  const { count: total, error } = await supabase
    .from("pomodoro_history")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (error) { serverError(res, error); return; }

  let locked = 0;
  if (cutoff) {
    const { count, error: lockedError } = await supabase
      .from("pomodoro_history")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .lt("completed_at", cutoff);
    if (lockedError) { serverError(res, lockedError); return; }
    locked = count ?? 0;
  }

  const data = {
    total_count: total ?? 0,
    visible_count: (total ?? 0) - locked,
    locked_count: locked,
    window_days: ent.historyDays,
  };
  cache.set(cacheKey, data, TTL.HISTORY);
  res.json({ data });
});

/** GET /api/history/analytics — the lightweight history dataset used by the
 * dashboard's week/month/year circles. The regular history endpoint is paged
 * for the timeline; analytics must not silently stop at its first 50 rows. */
router.get("/analytics", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const cacheKey = `history-analytics:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const ent = await getUserEntitlements(user.id);
  const cutoff = historyCutoffISO(ent.historyDays);
  const pageSize = 1_000;
  const maxRows = 10_000;
  const rows: unknown[] = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    let query = supabase
      .from("pomodoro_history")
      .select("session_name, timers_used, duration_seconds, focus_seconds, completed_at")
      .eq("user_id", user.id);
    if (cutoff) query = query.gte("completed_at", cutoff);

    const { data, error } = await query
      .order("completed_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) { serverError(res, error); return; }

    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) break;
  }

  cache.set(cacheKey, rows, TTL.HISTORY);
  res.json({ data: rows });
});

/** GET /api/history/session/:sessionId — the caller's archived copy of a
 * session. source_session_id survives the session row's ON DELETE SET NULL and
 * lets clients recover the server-created recap after inactivity expiry. */
router.get("/session/:sessionId", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { sessionId } = req.params;
  const { data, error } = await supabase
    .from("pomodoro_history")
    .select("id, session_id, session_name, timers_used, participants, duration_seconds, focus_seconds, completed_at, tasks")
    .eq("user_id", user.id)
    .eq("source_session_id", sessionId)
    .maybeSingle();
  if (error) { serverError(res, error); return; }
  if (!data) { res.status(404).json({ error: "Archived session not found" }); return; }
  cache.delByPrefix(`history:${user.id}:`);
  cache.del(`history-summary:${user.id}`);
  res.json({ data });
});

/** GET /api/history/export — full history as CSV (Pro: advanced analytics). */
router.get("/export", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const ent = await getUserEntitlements(user.id);
  if (!ent.analytics) { upgradeRequired(res, "analytics"); return; }

  const { data, error } = await supabase
    .from("pomodoro_history")
    .select("session_name, duration_seconds, focus_seconds, participants, timers_used, completed_at")
    .eq("user_id", user.id)
    .order("completed_at", { ascending: false })
    .limit(10_000);
  if (error) { serverError(res, error); return; }

  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = (data ?? []) as {
    session_name: string; duration_seconds: number; focus_seconds: number | null;
    participants: unknown[]; timers_used: unknown[]; completed_at: string;
  }[];
  const csv = [
    "completed_at,session_name,duration_seconds,focus_seconds,participants,timers_used",
    ...rows.map((r) => [
      esc(r.completed_at),
      esc(r.session_name),
      r.duration_seconds,
      r.focus_seconds ?? "",
      esc(JSON.stringify(r.participants ?? [])),
      esc(JSON.stringify(r.timers_used ?? [])),
    ].join(",")),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="betterpomo-history.csv"');
  res.send(csv);
});

/** POST /api/history
 *  Save a completed session to history.
 *  Body: { session_id?, session_name, timers_used, participants, duration_seconds } */
router.post("/", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const body = req.body;
  if (!body) { res.status(400).json({ error: "Request body required" }); return; }
  if (typeof body.session_name !== "string" || !body.session_name.trim()) {
    res.status(400).json({ error: "session_name is required" }); return;
  }
  if (typeof body.duration_seconds !== "number" || body.duration_seconds < 0) {
    res.status(400).json({ error: "duration_seconds must be a non-negative number" }); return;
  }

  // Offline sessions sync after the fact — honor the client's completion time
  // instead of stamping upload time. Clamp future values to now (clock skew)
  // rather than rejecting; omitted keeps the column default of now().
  let completedAt: string | undefined;
  if (body.completed_at !== undefined) {
    const t = Date.parse(body.completed_at);
    if (Number.isNaN(t)) {
      res.status(400).json({ error: "completed_at must be a valid ISO timestamp" }); return;
    }
    completedAt = new Date(Math.min(t, Date.now())).toISOString();
  }

  let durationSeconds = Math.floor(body.duration_seconds);

  // Offline sessions have no server timer state, so measured client focus time
  // is accepted. Online sessions override both values below with the database's
  // authoritative participant/timer accounting.
  let focusSeconds: number | undefined;
  if (body.focus_seconds !== undefined) {
    if (typeof body.focus_seconds !== "number" || body.focus_seconds < 0) {
      res.status(400).json({ error: "focus_seconds must be a non-negative number" }); return;
    }
    focusSeconds = Math.min(Math.floor(body.focus_seconds), Math.floor(body.duration_seconds));
  }

  // Personal session todos, snapshotted at leave time. Sanitize hard: bounded
  // count (per plan — clamped silently, a history save must never fail) + text
  // length, and only the two expected fields survive.
  const ent = await getUserEntitlements(user.id);

  // timers_used / participants are client-supplied snapshots that used to be
  // written through verbatim — an unbounded array of unbounded strings on every
  // save. Clamp both to the same shape the app actually renders.
  const timersUsed = Array.isArray(body.timers_used)
    ? (body.timers_used as unknown[])
        .filter((t): t is { name: string; duration: unknown } =>
          !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
        .slice(0, TIMERS_HARD_CAP)
        .map((t) => ({
          name: t.name.trim().slice(0, 80),
          duration: Math.min(Math.max(Math.floor(Number(t.duration) || 0), 0), MAX_TIMER_SECONDS),
        }))
    : [];

  const participantNames = Array.isArray(body.participants)
    ? (body.participants as unknown[])
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .slice(0, MAX_HISTORY_PARTICIPANTS)
        .map((v) => v.trim().slice(0, 50))
    : [];

  const tasks = Array.isArray(body.tasks)
    ? (body.tasks as unknown[])
        .filter((t): t is { text: string; done?: boolean } =>
          !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string" && !!(t as { text: string }).text.trim())
        .slice(0, ent.maxTasks)
        .map((t) => ({ text: t.text.trim().slice(0, 200), done: t.done === true }))
    : [];

  // Snapshot session privacy at save time (the session may be deleted later).
  // Trust an explicit body flag, else look it up from the session.
  let wasPrivate = body.was_private === true;
  if (body.was_private === undefined && body.session_id) {
    const { data: sess } = await supabase
      .from("pomodoro_sessions")
      .select("is_private")
      .eq("id", body.session_id)
      .maybeSingle();
    wasPrivate = sess?.is_private ?? false;
  }

  // Idempotency key from the offline upload queue. A dropped response can make
  // the client retry an upload that actually succeeded; deduping on client_id
  // makes retries safe regardless of whether the recent-history probe ran.
  const clientId = typeof body.client_id === "string" && body.client_id ? body.client_id : null;
  if (clientId) {
    const { data: dupe } = await supabase
      .from("pomodoro_history")
      .select()
      .eq("user_id", user.id)
      .eq("client_id", clientId)
      .maybeSingle();
    if (dupe) { res.json({ data: dupe }); return; }
  }

  // Session history is also idempotent across automatic inactivity expiry.
  // The source id remains available after the live session FK is nulled.
  const sourceSessionId = typeof body.session_id === "string" && body.session_id
    ? body.session_id
    : null;
  let hasAuthoritativeMetrics = false;
  if (sourceSessionId) {
    try {
      const metrics = await getSessionTimeMetrics(supabase, sourceSessionId, user.id);
      if (metrics) {
        hasAuthoritativeMetrics = true;
        durationSeconds = metrics.totalSeconds;
        focusSeconds = metrics.focusSeconds;
      }
    } catch (metricsError) {
      serverError(res, metricsError);
      return;
    }
  }

  if (sourceSessionId) {
    const { data: existingSession, error: existingSessionError } = await supabase
      .from("pomodoro_history")
      .select()
      .eq("user_id", user.id)
      .eq("source_session_id", sourceSessionId)
      .maybeSingle();
    if (existingSessionError) { serverError(res, existingSessionError); return; }
    if (existingSession) {
      // If inactivity cleanup already archived and deleted the live session,
      // the RPC has no participant row left. Keep those authoritative values
      // instead of replacing them with a stale client-side approximation.
      if (!hasAuthoritativeMetrics) {
        durationSeconds = existingSession.duration_seconds ?? durationSeconds;
        focusSeconds = existingSession.focus_seconds ?? focusSeconds;
      }
      const { data: updatedExisting, error: updateExistingError } = await supabase
        .from("pomodoro_history")
        .update({
          session_name: body.session_name.trim(),
          timers_used: timersUsed,
          participants: participantNames,
          duration_seconds: durationSeconds,
          ...(focusSeconds !== undefined ? { focus_seconds: focusSeconds } : {}),
          tasks,
          completed_at: completedAt ?? new Date().toISOString(),
        })
        .eq("id", existingSession.id)
        .eq("user_id", user.id)
        .select()
        .single();
      if (updateExistingError) { serverError(res, updateExistingError); return; }
      cache.delByPrefix(`history:${user.id}:`);
      cache.del(`history-summary:${user.id}`);
      cache.del(`history-analytics:${user.id}`);
      cache.delByPrefix("user-hist:");
      res.json({ data: updatedExisting });
      return;
    }
  }

  const row = {
    user_id: user.id,
    session_id: body.session_id ?? null,
    source_session_id: sourceSessionId,
    session_name: body.session_name.trim(),
    was_private: wasPrivate,
    timers_used: timersUsed,
    participants: participantNames,
    duration_seconds: durationSeconds,
    ...(focusSeconds !== undefined ? { focus_seconds: focusSeconds } : {}),
    tasks,
    ...(completedAt ? { completed_at: completedAt } : {}),
    ...(clientId ? { client_id: clientId } : {}),
  };

  let { data, error } = await supabase.from("pomodoro_history").insert(row).select().single();

  // Backward-compatible if the client_id column hasn't been migrated yet
  // (42703 = undefined_column): retry the insert without it.
  if (error?.code === "42703" && clientId) {
    const { client_id: _omit, ...rowWithoutClientId } = row as typeof row & { client_id?: string };
    void _omit;
    ({ data, error } = await supabase.from("pomodoro_history").insert(rowWithoutClientId).select().single());
  }

  // Deferred uploads (offline clients) can conflict with what happened since:
  // - 23505: the leave/expiry safety-net already saved this source session —
  //   idempotent success, return the existing row instead of erroring.
  // - 23503: the session row was deleted meanwhile — keep the entry, unlinked.
  if (error?.code === "23505" && body.session_id) {
    const { data: existing } = await supabase
      .from("pomodoro_history")
      .select()
      .eq("source_session_id", body.session_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing) { res.json({ data: existing }); return; }
  }
  if (error?.code === "23503") {
    ({ data, error } = await supabase
      .from("pomodoro_history")
      .insert({ ...row, session_id: null })
      .select()
      .single());
    if (error?.code === "23505" && sourceSessionId) {
      const { data: existing } = await supabase
        .from("pomodoro_history")
        .select()
        .eq("source_session_id", sourceSessionId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (existing) { res.json({ data: existing }); return; }
    }
  }

  if (error) { serverError(res, error); return; }

  cache.delByPrefix(`history:${user.id}:`);
  cache.del(`history-summary:${user.id}`);
  cache.del(`history-analytics:${user.id}`);
  cache.delByPrefix("user-hist:");

  res.status(201).json({ data });
});

/** PATCH /api/history/:id
 *  Body: { session_name?: string, duration_seconds?: number } */
router.patch("/:id", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!body) { res.status(400).json({ error: "Request body required" }); return; }

  const patch: Record<string, unknown> = {};
  if (typeof body.session_name === "string" && body.session_name.trim()) patch.session_name = body.session_name.trim();
  if (typeof body.duration_seconds === "number" && body.duration_seconds >= 0) {
    const nextDuration = Math.floor(body.duration_seconds);
    patch.duration_seconds = nextDuration;
    const { data: existing, error: existingError } = await supabase
      .from("pomodoro_history")
      .select("focus_seconds")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (existingError) { serverError(res, existingError); return; }
    if (existing?.focus_seconds != null) {
      patch.focus_seconds = Math.min(existing.focus_seconds, nextDuration);
    }
  }
  if (!Object.keys(patch).length) { res.status(400).json({ error: "Nothing to update" }); return; }

  const { data, error } = await supabase
    .from("pomodoro_history")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") { res.status(404).json({ error: "Not found" }); return; }
    serverError(res, error); return;
  }

  cache.delByPrefix(`history:${user.id}:`);
  cache.del(`history-summary:${user.id}`);
  cache.del(`history-analytics:${user.id}`);
  cache.delByPrefix("user-hist:");

  res.json({ data });
});

/** DELETE /api/history/:id */
router.delete("/:id", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;

  const { error } = await supabase
    .from("pomodoro_history")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) { serverError(res, error); return; }

  cache.delByPrefix(`history:${user.id}:`);
  cache.del(`history-summary:${user.id}`);
  cache.del(`history-analytics:${user.id}`);
  cache.delByPrefix("user-hist:");

  res.json({ data: null });
});

export default router;
