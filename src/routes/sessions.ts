import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { serverError } from "../lib/http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticate } from "../middleware/auth";
import { perUserLimiter } from "../middleware/rateLimit";
import { clampInt, generateSessionCode, escapeLike } from "../lib/utils";
import { cache, TTL } from "../lib/cache";
import { createAuthClient } from "../lib/supabase";
import { getSessionTimeMetrics } from "../lib/sessionTime";
import { getMutuallyBlockedUserIds, usersHaveBlockedEachOther } from "../lib/blocks";
import { rejectObjectionableText } from "../lib/moderation";
import {
  BILLING_ENABLED,
  getEntitlements,
  getUserEntitlements,
  upgradeRequired,
  TIMERS_HARD_CAP,
  type PlanRow,
} from "../lib/plans";

const router = Router();

// Lap names render in a fixed-width column in both clients; keep them short
// enough that the table never has to fight the text.
const LAP_NAME_MAX = 40;

// `last_activity_at` was added after the session API started shipping. Keep
// mutations compatible with databases that have not applied the inactivity
// expiry migration yet: timer/privacy writes must not fail just because the
// optional bookkeeping column is absent. Once the migration is present, the
// database triggers own activity tracking and this explicit write is harmless.
let supportsLastActivityAt: boolean | null = null;

function isMissingLastActivityAt(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const dbError = error as { code?: string; message?: string };
  return dbError.code === "42703" &&
    (dbError.message ?? "").includes("last_activity_at");
}

// Cap chat spam per user (realtime fans each message out to every participant),
// well above a human's natural typing rate: 20 messages / 10s.
const messageLimiter = perUserLimiter({
  windowMs: 10_000,
  limit: 20,
  message: "You're sending messages too fast. Slow down a moment.",
  name: "session-msg",
});

/** The session the user is currently a member of (left_at null, not ended), if
 *  any. Sessions are background jobs a user stays in until they explicitly
 *  leave, so create/join/invite must enforce at most one at a time. */
async function getActiveSessionId(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("session_participants")
    .select("session_id, pomodoro_sessions!inner(status)")
    .eq("user_id", userId)
    .is("left_at", null)
    .in("pomodoro_sessions.status", ["waiting", "active"])
    .limit(1);
  return (data?.[0]?.session_id as string | undefined) ?? null;
}

const ALREADY_IN_SESSION =
  "You're already in a session. Leave it before starting or joining another.";

/** True when Postgres reports the function itself does not exist (42883). */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "42883"
    || error.code === "PGRST202"
    || (error.message ?? "").includes("Could not find the function");
}

/**
 * Refuse a join with a reason both the user and the logs can act on.
 *
 * `code` is the stable machine-readable reason the clients switch on; `message`
 * is what the user reads. Every refusal is logged with the session and user so
 * a support question ("why can't I join?") can be answered from the logs.
 */
function denyJoin(
  res: Response,
  status: number,
  code: string,
  message: string,
  context: Record<string, unknown>,
): void {
  console.warn(`[join] denied: ${code}`, context);
  res.status(status).json({ error: message, code });
}

type SessionSystemEvent =
  | "participant_joined"
  | "participant_left"
  | "participant_removed"
  | "participant_promoted"
  | "participant_demoted"
  | "ownership_transferred"
  | "session_renamed";

type SessionChatKind = "message" | SessionSystemEvent;

interface SessionChatMetadata {
  user_id?: string;
  username?: string;
  display_name?: string;
  actor_id?: string;
  role?: "owner" | "admin" | "member";
  previous_role?: "owner" | "admin" | "member";
  session_name?: string;
}

interface SessionChatRow {
  id: string;
  content: string;
  created_at: string;
  user_id: string;
  kind: SessionChatKind;
  metadata: SessionChatMetadata | null;
  profiles: { username: string; display_name: string; emoji: string } | null;
}

type SessionChatItem = Omit<SessionChatRow, "kind"> & {
  type?: SessionSystemEvent;
};

function serializeSessionChatRow(row: SessionChatRow): SessionChatItem {
  const { kind, ...message } = row;
  return kind === "message" ? message : { ...message, type: kind };
}

/** Realtime is the fast delivery path; the database row remains authoritative
 *  so reconnecting and newly joined clients can replay a bounded history. */
async function broadcastSessionChatItem(
  supabase: SupabaseClient,
  sessionId: string,
  item: SessionChatItem,
): Promise<void> {
  const channel = supabase.channel(`session:${sessionId}:chat`, { config: { private: true } });
  try {
    const delivery = await channel.httpSend(item.type ? "notice" : "message", item);
    if (!delivery.success) {
      console.error("session chat realtime delivery failed", { sessionId, itemId: item.id });
    }
  } catch (error) {
    // Persistence is the source of truth, so a transient realtime failure must
    // not undo a successful message or block a membership change.
    console.error("session chat realtime delivery failed", error);
  } finally {
    void supabase.removeChannel(channel);
  }
}

/** Persist and broadcast a server-authored session timeline event. Structured
 *  mention metadata keeps the profile link replayable without parsing content. */
async function publishSessionEvent(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
  kind: SessionSystemEvent,
  actorId = userId,
  customContent?: string,
  eventMetadata: Pick<SessionChatMetadata, "role" | "previous_role" | "session_name"> = {},
): Promise<void> {
  const [{ data: profile }, { data: session }] = await Promise.all([
    supabase
      .from("profiles")
      .select("username, display_name, emoji")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("pomodoro_sessions")
      .select("status")
      .eq("id", sessionId)
      .maybeSingle(),
  ]);
  if (!session || !["waiting", "active"].includes(session.status as string)) return;

  const username = profile?.username ?? "someone";
  const action: Record<SessionSystemEvent, string> = {
    participant_joined: "joined the session",
    participant_left: "left the session",
    participant_removed: "was removed from the session",
    participant_promoted: "is now an admin",
    participant_demoted: "is no longer an admin",
    ownership_transferred: "is now the session owner",
    session_renamed: "renamed the session",
  };
  const defaultContent = kind === "session_renamed" && eventMetadata.session_name
    ? `@${username} renamed the session to ${eventMetadata.session_name}`
    : `@${username} ${action[kind]}`;
  const content = customContent ?? defaultContent;
  const metadata: SessionChatMetadata = {
    user_id: userId,
    username,
    display_name: profile?.display_name ?? username,
    actor_id: actorId,
    ...eventMetadata,
  };

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({ session_id: sessionId, user_id: userId, content, kind, metadata })
    .select("id, content, created_at, user_id, kind, metadata, profiles(username, display_name, emoji)")
    .single();
  if (error || !data) {
    // Membership changes must remain available even if chat storage is
    // temporarily unavailable or the migration has not reached an environment.
    console.error("session timeline event could not be persisted", { sessionId, userId, kind, error });
    return;
  }

  await broadcastSessionChatItem(supabase, sessionId, serializeSessionChatRow(data as unknown as SessionChatRow));
}

// ── Authorization guards ────────────────────────────────────────────────────────
// req.supabase is the service-role client (RLS bypassed), so every session route
// must prove the caller belongs to the session it names. Without these checks any
// authenticated user could read or control any session by guessing its id.

/** The caller's active membership row (left_at null) for a session, or null. */
async function getMembership(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const { data } = await supabase
    .from("session_participants")
    .select("role")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  return data ? { role: data.role as string } : null;
}

type GuardRes = { status: (n: number) => { json: (b: unknown) => void } };

/** Require the caller to be an active participant of the session.
 *  On failure, writes a 404 (indistinguishable from a missing session, so ids
 *  can't be enumerated) and returns null — the handler must `return` then. */
async function requireParticipant(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
  res: GuardRes,
): Promise<{ role: string } | null> {
  const membership = await getMembership(supabase, sessionId, userId);
  if (!membership) { res.status(404).json({ error: "Session not found" }); return null; }
  return membership;
}

/** Require the caller to be the owner or an admin of the session. Non-members
 *  get a 404 (no enumeration); plain members get a 403. */
async function requireManager(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
  res: GuardRes,
): Promise<{ role: string } | null> {
  const membership = await getMembership(supabase, sessionId, userId);
  if (!membership) { res.status(404).json({ error: "Session not found" }); return null; }
  if (membership.role !== "owner" && membership.role !== "admin") {
    res.status(403).json({ error: "Only the host or an admin can do that" });
    return null;
  }
  return membership;
}

// A membership is swept after 24h with no heartbeat (see cleanup_inactive_
// participants in migration_scale_and_inactivity.sql). We refresh last_seen_at
// from the frequent client polls, but throttle the write so a 3–15s poll cadence
// doesn't turn into thousands of redundant writes/sec at scale — 5-minute
// granularity is plenty against a 24h window.
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;
function touchLastSeen(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
  currentLastSeen?: string | null,
): void {
  const fresh = currentLastSeen && Date.now() - new Date(currentLastSeen).getTime() < LAST_SEEN_THROTTLE_MS;
  if (fresh) return;
  // Fire-and-forget — a heartbeat must never delay or fail the read it rides on.
  void supabase
    .from("session_participants")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .then(undefined, () => {});
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** GET /api/sessions
 *  Returns all sessions the user participates in (active or waiting). */
router.get("/", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { data, error } = await supabase
    .from("session_participants")
    .select(`session_id, role, joined_at, pomodoro_sessions!inner(id, name, code, status, is_private, created_at)`)
    .eq("user_id", user.id)
    .in("pomodoro_sessions.status", ["waiting", "active"])
    .order("joined_at", { ascending: false });
  if (error) { serverError(res, error); return; }
  res.json({ data });
});

/** GET /api/sessions/mine/active
 *  The caller's currently-running session (participant row with left_at null),
 *  if any — drives the persistent "session running in background" banner.
 *  Real-time state, so never cached. Must stay above the generic /:id routes. */
router.get("/mine/active", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { data, error } = await supabase
    .from("session_participants")
    .select(`joined_at, last_seen_at, pomodoro_sessions!inner(id, name, code, status, session_type, timer_state, timer_started_at, paused_elapsed_seconds, current_timer_index)`)
    .eq("user_id", user.id)
    .is("left_at", null)
    .in("pomodoro_sessions.status", ["waiting", "active"])
    .order("joined_at", { ascending: false })
    .limit(1);
  if (error) { serverError(res, error); return; }
  // supabase-js types the !inner embed as an array even though it's one row.
  const row = data?.[0] as unknown as { joined_at: string; last_seen_at?: string | null; pomodoro_sessions: { id: string; current_timer_index: number } } | undefined;
  if (!row) { res.json({ data: null }); return; }

  // This poll fires whenever the app is open (drives the background-session
  // banner), so it doubles as the liveness heartbeat that keeps the membership
  // from being swept for inactivity.
  touchLastSeen(supabase, row.pomodoro_sessions.id, user.id, row.last_seen_at);

  // Include the current timer so the banner can render an accurate countdown.
  const { data: timers } = await supabase
    .from("timers")
    .select("name, duration")
    .eq("session_id", row.pomodoro_sessions.id)
    .order("order");
  const currentTimer = timers?.[row.pomodoro_sessions.current_timer_index] ?? null;

  res.json({ data: { joined_at: row.joined_at, session: row.pomodoro_sessions, current_timer: currentTimer } });
});

/** POST /api/sessions
 *  Create a new session.
 *  Body: { name: string, is_private?: boolean, password?: string,
 *    session_type?: 'pomodoro' | 'stopwatch',
 *    starter_focus_minutes?: 15 | 25 | 35 | 45 | 55 } */
router.post("/", authenticate, async (req, res) => {
  const { user, supabase, token } = req;
  const body = req.body;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if (body.name.trim().length > 100) {
    res.status(400).json({ error: "Session name must be 100 characters or less" }); return;
  }
  if (rejectObjectionableText(res, [body.name])) return;

  // One session at a time — leave the current one before creating another.
  if (await getActiveSessionId(supabase, user.id)) {
    res.status(409).json({ error: ALREADY_IN_SESSION }); return;
  }

  const ent = await getUserEntitlements(user.id);

  const isPrivate = body.is_private === true;
  if (isPrivate && !ent.privateSessions) { upgradeRequired(res, "private_sessions"); return; }
  const rawPassword: string | undefined = isPrivate && typeof body.password === "string" && body.password ? body.password : undefined;
  if (isPrivate && rawPassword && rawPassword.length > 72) {
    res.status(400).json({ error: "Password must be 72 characters or less" }); return;
  }
  const passwordHash = rawPassword ? await bcrypt.hash(rawPassword, 10) : null;

  const sessionType = body.session_type === "stopwatch" ? "stopwatch" : "pomodoro";
  const starterFocusMinutes = [15, 25, 35, 45, 55].includes(body.starter_focus_minutes)
    ? Number(body.starter_focus_minutes)
    : null;

  // Optional Pro feature: create from a saved template (replaces the default
  // timers with the template's set). Validate before creating the session so
  // a bad template id can't leave a half-configured session behind.
  interface SessionTemplate { session_type: string; timers: { name: string; duration: number }[] }
  let template: SessionTemplate | null = null;
  if (body.template_id !== undefined) {
    if (!ent.templates) { upgradeRequired(res, "templates"); return; }
    const { data: tpl } = await supabase
      .from("session_templates")
      .select("session_type, timers")
      .eq("id", body.template_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!tpl) { res.status(404).json({ error: "Template not found" }); return; }
    template = tpl as unknown as SessionTemplate;
  }

  const { data: profile } = await supabase
    .from("profiles").select("username").eq("id", user.id).single();

  const code = generateSessionCode();
  // Use a user-scoped client so auth.uid() resolves correctly inside the RPC
  const userClient = createAuthClient(token);
  const { data, error } = await userClient.rpc("create_pomo_session", {
    p_name: body.name.trim(),
    p_code: code,
    p_username: profile?.username ?? (user.email?.split("@")[0] ?? "User"),
    p_is_private: isPrivate,
  });

  if (error) { serverError(res, error); return; }

  // Apply session_type and password_hash if needed
  const updates: Record<string, unknown> = {};
  if (template?.session_type === "stopwatch" || sessionType === "stopwatch") updates.session_type = "stopwatch";
  if (passwordHash) updates.password_hash = passwordHash;
  if (Object.keys(updates).length) {
    await supabase.from("pomodoro_sessions").update(updates).eq("id", data);
  }

  // Swap the RPC's default timers for the template's set (Pro, validated above).
  if (template && Array.isArray(template.timers) && template.timers.length) {
    const timerRows = template.timers
      .filter((t) => t && typeof t.name === "string" && typeof t.duration === "number" && t.duration > 0)
      .slice(0, TIMERS_HARD_CAP)
      .map((t, i) => ({
        session_id: data,
        name: t.name.trim().slice(0, 80),
        duration: Math.min(Math.floor(t.duration), 86400),
        order: i,
      }));
    if (timerRows.length) {
      await supabase.from("timers").delete().eq("session_id", data);
      await supabase.from("timers").insert(timerRows);
      cache.del(`timers:${data}`);
    }
  } else if (sessionType === "pomodoro" && starterFocusMinutes !== null) {
    const { data: defaultTimers, error: timerError } = await supabase
      .from("timers")
      .select("id, name, order")
      .eq("session_id", data)
      .order("order");
    if (timerError) { serverError(res, timerError); return; }
    const firstWork = defaultTimers?.find((timer) => timer.name.toLowerCase() !== "break");
    const firstBreak = defaultTimers?.find((timer) => timer.name.toLowerCase() === "break");
    const breakMinutes = starterFocusMinutes <= 25 ? 5 : starterFocusMinutes <= 35 ? 10 : 15;
    await Promise.all([
      firstWork
        ? supabase.from("timers").update({ duration: starterFocusMinutes * 60 }).eq("id", firstWork.id)
        : Promise.resolve(),
      firstBreak
        ? supabase.from("timers").update({ duration: breakMinutes * 60 }).eq("id", firstBreak.id)
        : Promise.resolve(),
    ]);
    cache.del(`timers:${data}`);
  }

  await publishSessionEvent(supabase, String(data), user.id, "participant_joined");
  res.status(201).json({ data: { session_id: data, code } });
});

/** GET /api/sessions/by-code/:code
 *  Look up a session by its 6-character code.
 *  Queries the table directly (not the RPC) so all columns — including
 *  session_type and password_hash — are always returned. */
router.get("/by-code/:code", authenticate, async (req, res) => {
  const { supabase } = req;
  const code = String(req.params.code).toUpperCase();
  const { data, error } = await supabase
    .from("pomodoro_sessions").select("*").eq("code", code).single();
  if (error) {
    const status = error.code === "PGRST116" ? 404 : 500;
    res.status(status).json({ error: error.message }); return;
  }
  const { password_hash, ...safeSession } = data as Record<string, unknown> & { password_hash?: string | null };
  res.json({ data: { ...safeSession, is_password_protected: !!password_hash } });
});

/** POST /api/sessions/join
 *  Join a session by its 6-character code.
 *  Body: { code: string, password?: string } */
router.post("/join", authenticate, async (req, res) => {
  const { user, supabase, token } = req;
  const body = req.body;
  if (!body || typeof body.code !== "string" || !body.code.trim()) {
    res.status(400).json({ error: "code is required" }); return;
  }

  const code = body.code.trim().toUpperCase();
  // Direct table query — ensures session_type and password_hash are always returned
  const { data: sessionRow, error: lookupError } = await supabase
    .from("pomodoro_sessions").select("*").eq("code", code).single();
  if (lookupError) {
    if (lookupError.code === "PGRST116") {
      denyJoin(res, 404, "session_not_found", "No session exists with that code.", { code, userId: user.id });
      return;
    }
    serverError(res, lookupError, `join:lookup:${code}`);
    return;
  }

  const session = sessionRow as Record<string, unknown>;
  const joinLog = { code, sessionId: session.id as string, userId: user.id };

  if (typeof session.created_by === "string"
      && await usersHaveBlockedEachOther(supabase, user.id, session.created_by)) {
    denyJoin(res, 404, "session_not_found", "No session exists with that code.", joinLog);
    return;
  }

  if (session.status === "ended") {
    denyJoin(res, 410, "session_ended", "This session has already ended.", joinLog);
    return;
  }

  // One session at a time — re-entering the same session is always fine.
  const currentSessionId = await getActiveSessionId(supabase, user.id);
  if (currentSessionId && currentSessionId !== session.id) {
    denyJoin(res, 409, "already_in_session", ALREADY_IN_SESSION, joinLog);
    return;
  }

  // Check if this user is already a participant (existing participants bypass password)
  const { data: existingParticipant } = await supabase
    .from("session_participants")
    .select("role, left_at")
    .eq("session_id", session.id as string)
    .eq("user_id", user.id)
    .maybeSingle();

  // Password check — skip for existing participants (they already authenticated once)
  if (!existingParticipant) {
    const hash = (session.password_hash as string | null) ?? null;
    if (hash) {
      const supplied = typeof body.password === "string" ? body.password : "";
      // "Nothing supplied" and "wrong password" are different situations for
      // the UI: the first opens the password prompt, the second re-prompts with
      // an error. Collapsing them into one message is why a private session
      // used to fail with no explanation.
      if (!supplied) {
        denyJoin(res, 403, "password_required", "This session is private — it needs its password to join.", joinLog);
        return;
      }
      // A 401 here would make browser clients assume their login token expired
      // and redirect to /login; 403 correctly preserves the password gate.
      if (!(await bcrypt.compare(supplied, hash))) {
        denyJoin(res, 403, "incorrect_password", "That session password is not correct.", joinLog);
        return;
      }
    } else if (session.is_private === true) {
      // Private with no password set: code-only access, nothing more to check.
      // Recorded because it is the case that used to be rejected outright.
      console.info("[join] private session, no password set — allowing by code", joinLog);
    }
  }

  const { data: profile } = await supabase
    .from("profiles").select("username").eq("id", user.id).single();

  // The participant cap belongs to the session OWNER's plan (they host the
  // room), so a joiner hitting it gets 409 session_full — upgrading their own
  // account wouldn't help. The RPC re-checks the cap atomically. With billing
  // disabled the legacy 2-arg RPC (hardcoded cap of 10) may be all that exists,
  // so p_max_participants must not be passed.
  const ownerEnt = await getUserEntitlements(session.owner_id as string);

  const username = profile?.username ?? (user.email?.split("@")[0] ?? "User");
  const capArg = BILLING_ENABLED ? { p_max_participants: ownerEnt.maxParticipants } : {};

  // join_pomo_session_verified skips the RPC's blanket private-session refusal
  // (see migration_private_session_join.sql) — every check it would have made
  // has been made above, including the password. It is service-role only, so
  // `supabase` (adminDb) must be the caller and the user id has to be explicit.
  let { error: joinError } = await supabase.rpc("join_pomo_session_verified", {
    p_session_id: session.id as string,
    p_user_id: user.id,
    p_username: username,
    ...capArg,
  });

  // Fall back to the original RPC where the migration has not been applied yet,
  // so joining public sessions keeps working on an un-migrated database.
  if (joinError && isMissingFunction(joinError)) {
    console.warn("[join] join_pomo_session_verified missing — apply migration_private_session_join.sql", joinLog);
    const userClient = createAuthClient(token);
    ({ error: joinError } = await userClient.rpc("join_pomo_session", {
      p_session_id: session.id as string,
      p_username: username,
      ...capArg,
    }));
  }

  if (joinError) {
    if (joinError.message.includes("Session is full")) {
      console.warn("[join] denied: session_full", { ...joinLog, max: ownerEnt.maxParticipants });
      res.status(409).json({ error: "session_full", code: "session_full", max: ownerEnt.maxParticipants });
      return;
    }
    if (joinError.message.includes("This session is private")) {
      denyJoin(res, 403, "session_private", "This session is private — ask the host for an invite.", joinLog);
      return;
    }
    console.error("[join] rpc failed", { ...joinLog, error: joinError.message });
    res.status(400).json({ error: joinError.message, code: "join_failed" });
    return;
  }
  console.info("[join] joined", { ...joinLog, rejoin: !!existingParticipant });

  const shouldJoinAsMember =
    session.owner_id !== user.id && (!existingParticipant || existingParticipant.left_at !== null);

  // Clear any stale left_at and fetch the participant row (role + joined_at).
  // New/rejoining non-owners must enter as members; active admins keep their
  // role across reloads, and the owner remains owner.
  const nowIso = new Date().toISOString();
  const { data: participantRow } = await supabase
    .from("session_participants")
    .update(shouldJoinAsMember ? { left_at: null, role: "member", last_seen_at: nowIso } : { left_at: null, last_seen_at: nowIso })
    .eq("session_id", session.id as string)
    .eq("user_id", user.id)
    .select("role, joined_at")
    .single();

  // If the update didn't return the row, read it back — the RPC above already
  // guaranteed membership, and guessing "member" here would strip an owner or
  // admin of their host controls in the client.
  let participant = participantRow;
  if (!participant) {
    const { data: fetched } = await supabase
      .from("session_participants")
      .select("role, joined_at")
      .eq("session_id", session.id as string)
      .eq("user_id", user.id)
      .maybeSingle();
    participant = fetched ?? { role: "member", joined_at: new Date().toISOString() };
  }
  if (!existingParticipant || existingParticipant.left_at !== null) {
    await publishSessionEvent(
      supabase,
      session.id as string,
      user.id,
      "participant_joined",
    );
  }
  // Strip password_hash from session before returning
  const { password_hash: _ph, ...safeSession } = session as Record<string, unknown> & { password_hash?: unknown };
  void _ph;
  res.json({ data: { session: safeSession, participant } });
});

/** GET /api/sessions/active
 *  Returns all active/waiting sessions visible to the requester.
 *  Query: ?q=name_filter (optional)
 *  Never returns password_hash. */
router.get("/active", authenticate, async (req, res) => {
  const { supabase } = req;
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";

  // Same result for every viewer, polled on an interval by the search screen —
  // a short server-side cache collapses many concurrent polls into one query
  // pair. 10s staleness is well within the client's own refresh cadence.
  const cacheKey = `active-sessions:${q}`;
  const cached = cache.get(cacheKey);
  if (cached) { res.json({ data: cached }); return; }

  let query = supabase
    .from("pomodoro_sessions")
    .select("id, name, code, status, is_private, session_type, created_at, password_hash")
    .in("status", ["waiting", "active"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (q) query = query.ilike("name", `%${escapeLike(q)}%`);

  const { data, error } = await query;
  if (error) { serverError(res, error); return; }

  // Count active participants per session
  const sessionIds = (data ?? []).map((s) => s.id);
  const { data: participants } = sessionIds.length
    ? await supabase
        .from("session_participants")
        .select("session_id")
        .in("session_id", sessionIds)
        .is("left_at", null)
    : { data: [] };

  const countMap: Record<string, number> = {};
  for (const p of participants ?? []) {
    countMap[p.session_id] = (countMap[p.session_id] ?? 0) + 1;
  }

  const safe = (data ?? []).map(({ password_hash, ...s }) => ({
    ...s,
    is_password_protected: !!password_hash,
    participant_count: countMap[s.id] ?? 0,
  }));

  cache.set(cacheKey, safe, TTL.ACTIVE_SESSIONS);
  res.json({ data: safe });
});

/** GET /api/sessions/:id
 *  Returns the session with its timers and participants. */
router.get<{ id: string }>("/:id", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;

  if (!(await requireParticipant(supabase, String(id), user.id, res))) return;

  const [sessionResult, timersResult, participantsResult] = await Promise.all([
    supabase.from("pomodoro_sessions").select("*").eq("id", id).single(),
    supabase.from("timers").select("*").eq("session_id", id).order("order"),
    supabase
      .from("session_participants")
      .select("id, user_id, role, joined_at, left_at, last_seen_at, profiles(username, display_name, emoji)")
      .eq("session_id", id)
      .order("joined_at"),
  ]);

  if (sessionResult.error) {
    const status = sessionResult.error.code === "PGRST116" ? 404 : 500;
    res.status(status).json({ error: status === 404 ? "Session not found" : sessionResult.error.message }); return;
  }
  // Surface timer/participant query failures instead of returning empty arrays —
  // clients use the participants list to decide whether the caller is a member,
  // so a silently-empty list corrupts the join/rejoin flow downstream.
  if (timersResult.error || participantsResult.error) {
    serverError(res, timersResult.error ?? participantsResult.error); return;
  }

  // Heartbeat: the session screen polls this endpoint, so refresh the caller's
  // liveness if they're a participant (throttled inside touchLastSeen).
  const mine = (participantsResult.data ?? []).find((p) => p.user_id === user.id) as
    | { last_seen_at?: string | null }
    | undefined;
  if (mine) touchLastSeen(supabase, id, user.id, mine.last_seen_at);

  // Never expose the bcrypt password_hash to the client — replace it with the
  // boolean the frontend actually consumes.
  const { password_hash, ...session } = sessionResult.data as Record<string, unknown> & { password_hash?: string | null };

  res.json({
    data: {
      session: { ...session, is_password_protected: !!password_hash },
      timers: timersResult.data ?? [],
      participants: participantsResult.data ?? [],
    },
  });
});

/** PATCH /api/sessions/:id
 *  Update session state or metadata.
 *
 *  Timer actions (mutually exclusive with metadata):
 *    { action: "start", index?: number }   start timer at index (defaults to current)
 *    { action: "pause" }                   pause running timer
 *    { action: "resume" }                  resume paused timer
 *    { action: "reset" }                   restart current timer from 0
 *    { action: "stop", index?: number }    stop timer, optionally jump to index
 *    { action: "select", index: number }   jump to a specific timer index
 *    { action: "next" }                    skip to next timer (ends if last)
 *    { action: "end" }                     end the session immediately
 *
 *  Metadata fields:
 *    { name?: string, is_private?: boolean }
 */
router.patch("/:id", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!body) { res.status(400).json({ error: "Request body required" }); return; }

  // Timer control, session-type/metadata and password changes are all host/admin
  // actions in the UI — require that role here so the DB isn't the only gate.
  if (!(await requireManager(supabase, String(id), user.id, res))) return;

  const { data: session, error: fetchError } = await supabase
    .from("pomodoro_sessions").select("*").eq("id", id).single();

  if (fetchError) {
    const status = fetchError.code === "PGRST116" ? 404 : 500;
    res.status(status).json({ error: fetchError.message }); return;
  }
  if (session.status === "ended") { res.status(410).json({ error: "Session has ended" }); return; }

  const now = new Date();

  if (body.action) {
    switch (body.action) {
      case "start": {
        const requestedIndex = typeof body.index === "number" ? body.index : session.current_timer_index;
        // Treat a retried start as success instead of restarting an already
        // running timer. Clients can safely retry after a lost response.
        if (session.timer_state === "running" && requestedIndex === session.current_timer_index) break;
        const fields: Record<string, unknown> = {
          timer_state: "running",
          status: "active",
          timer_started_at: now.toISOString(),
          paused_elapsed_seconds: null,
        };
        if (typeof body.index === "number") fields.current_timer_index = body.index;
        const { error } = await supabase
          .from("pomodoro_sessions").update(fields).eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "pause": {
        if (session.timer_state === "paused") break;
        if (session.timer_state !== "running" || !session.timer_started_at) {
          res.status(409).json({ error: "Timer state changed before it could be paused" }); return;
        }
        const elapsed = (now.getTime() - new Date(session.timer_started_at).getTime()) / 1000;
        const { error } = await supabase
          .from("pomodoro_sessions")
          .update({ timer_state: "paused", paused_elapsed_seconds: elapsed })
          .eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "resume": {
        if (session.timer_state === "running") break;
        if (session.timer_state !== "paused" || session.paused_elapsed_seconds == null) {
          res.status(409).json({ error: "Timer state changed before it could be resumed" }); return;
        }
        const { error } = await supabase
          .from("pomodoro_sessions")
          .update({
            timer_state: "running",
            timer_started_at: new Date(now.getTime() - session.paused_elapsed_seconds * 1000).toISOString(),
            paused_elapsed_seconds: null,
          })
          .eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "reset": {
        const { error } = await supabase
          .from("pomodoro_sessions")
          .update({ timer_state: "running", timer_started_at: now.toISOString(), paused_elapsed_seconds: null })
          .eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "stop": {
        const fields: Record<string, unknown> = {
          timer_state: "idle",
          timer_started_at: null,
          paused_elapsed_seconds: null,
        };
        if (typeof body.index === "number") fields.current_timer_index = body.index;
        const { error } = await supabase
          .from("pomodoro_sessions").update(fields).eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "select": {
        if (typeof body.index !== "number") { res.status(400).json({ error: "index is required for select action" }); return; }
        const { error } = await supabase
          .from("pomodoro_sessions")
          .update({ current_timer_index: body.index, timer_state: "idle", timer_started_at: null, paused_elapsed_seconds: null })
          .eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "next": {
        const { data: timers } = await supabase.from("timers").select("id").eq("session_id", id).order("order");
        const isLast = session.current_timer_index >= (timers?.length ?? 1) - 1;
        const { error } = await supabase.from("pomodoro_sessions").update(
          isLast
            ? { status: "ended", timer_state: "idle", timer_started_at: null, paused_elapsed_seconds: null, ended_at: now.toISOString() }
            : { current_timer_index: session.current_timer_index + 1, timer_state: "idle", timer_started_at: null, paused_elapsed_seconds: null }
        ).eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "end": {
        const { error } = await supabase
          .from("pomodoro_sessions")
          .update({ status: "ended", timer_state: "idle", timer_started_at: null, paused_elapsed_seconds: null, ended_at: now.toISOString() })
          .eq("id", id);
        if (error) { serverError(res, error); return; }
        break;
      }

      case "sw_reset": {
        // Stopwatch-only: reset elapsed time without touching recorded laps.
        const { error: resetErr } = await supabase
          .from("pomodoro_sessions")
          .update({ timer_state: "idle", timer_started_at: null, paused_elapsed_seconds: 0 })
          .eq("id", id);
        if (resetErr) { serverError(res, resetErr); return; }
        break;
      }

      case "set_type": {
        if (!["pomodoro", "stopwatch"].includes(body.session_type)) {
          res.status(400).json({ error: "session_type must be 'pomodoro' or 'stopwatch'" }); return;
        }
        const typeUpdate: Record<string, unknown> = { session_type: body.session_type };
        if (session.timer_state === "running" && session.timer_started_at) {
          const elapsed = (now.getTime() - new Date(session.timer_started_at).getTime()) / 1000;
          typeUpdate.timer_state = "paused";
          typeUpdate.paused_elapsed_seconds = elapsed;
          typeUpdate.timer_started_at = null;
        }
        const { error: typeErr } = await supabase
          .from("pomodoro_sessions")
          .update(typeUpdate)
          .eq("id", id);
        if (typeErr) { serverError(res, typeErr); return; }
        break;
      }

      default:
        res.status(400).json({ error: `Unknown action: ${body.action}` }); return;
    }

    // Some actions (for example changing session type while idle) do not alter
    // the legacy timer columns watched by the DB trigger. Mark every successful
    // manager action explicitly so all of them reset the 24h expiry clock.
    if (supportsLastActivityAt !== false) {
      const { error: activityError } = await supabase
        .from("pomodoro_sessions")
        .update({ last_activity_at: now.toISOString() })
        .eq("id", id);
      if (activityError) {
        if (isMissingLastActivityAt(activityError)) supportsLastActivityAt = false;
        else { serverError(res, activityError); return; }
      } else {
        supportsLastActivityAt = true;
      }
    }

    const { data: updated, error: updatedError } = await supabase
      .from("pomodoro_sessions")
      .select("*")
      .eq("id", id)
      .single();
    if (updatedError) { serverError(res, updatedError); return; }
    res.json({ data: { session: updated } });
    return;
  }

  // Metadata update
  if (typeof body.name === "string" && body.name.trim().length > 100) {
    res.status(400).json({ error: "Session name must be 100 characters or less" }); return;
  }
  if (typeof body.name === "string" && rejectObjectionableText(res, [body.name])) return;
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.is_private === "boolean") patch.is_private = body.is_private;
  if (typeof body.password === "string") {
    patch.password_hash = body.password ? await bcrypt.hash(body.password, 10) : null;
  }
  if (!Object.keys(patch).length) { res.status(400).json({ error: "Nothing to update" }); return; }
  if (supportsLastActivityAt !== false) {
    patch.last_activity_at = new Date().toISOString();
  }

  // Turning privacy ON (or setting a password) is a Pro feature; turning it
  // off or clearing a password is always allowed.
  if (patch.is_private === true || (typeof body.password === "string" && body.password)) {
    const ent = await getUserEntitlements(user.id);
    if (!ent.privateSessions) { upgradeRequired(res, "private_sessions"); return; }
  }

  let { data: updated, error } = await supabase
    .from("pomodoro_sessions").update(patch).eq("id", id).select().single();
  if (error && isMissingLastActivityAt(error)) {
    // Retry the actual metadata change without the optional activity column.
    // The first query is rejected as a whole by PostgREST, so this cannot
    // double-apply the privacy/password update.
    supportsLastActivityAt = false;
    delete patch.last_activity_at;
    ({ data: updated, error } = await supabase
      .from("pomodoro_sessions").update(patch).eq("id", id).select().single());
  } else if (!error && "last_activity_at" in patch) {
    supportsLastActivityAt = true;
  }
  if (error) { serverError(res, error); return; }
  if (typeof patch.name === "string" && patch.name !== session.name) {
    await publishSessionEvent(
      supabase,
      String(id),
      user.id,
      "session_renamed",
      user.id,
      undefined,
      { session_name: patch.name },
    );
  }
  // Never expose password_hash
  const { password_hash: _ph2, ...safeUpdated } = (updated ?? {}) as Record<string, unknown> & { password_hash?: unknown };
  void _ph2;
  res.json({ data: { session: safeUpdated } });
});

// ── Timers ────────────────────────────────────────────────────────────────────

/** GET /api/sessions/:id/timers */
router.get("/:id/timers", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  if (!(await requireParticipant(supabase, String(id), user.id, res))) return;
  const cacheKey = `timers:${id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }
  const { data, error } = await supabase.from("timers").select("*").eq("session_id", id).order("order");
  if (error) { serverError(res, error); return; }
  cache.set(cacheKey, data, TTL.TIMERS);
  res.json({ data });
});

/** POST /api/sessions/:id/timers
 *  Body: { name: string, duration: number (seconds) } */
router.post("/:id/timers", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;

  if (!(await requireManager(supabase, String(id), user.id, res))) return;

  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if (body.name.trim().length > 80) {
    res.status(400).json({ error: "Timer name must be 80 characters or less" }); return;
  }
  if (rejectObjectionableText(res, [body.name])) return;
  if (typeof body.duration !== "number" || body.duration <= 0) {
    res.status(400).json({ error: "duration must be a positive number of seconds" }); return;
  }
  if (body.duration > 86400) {
    res.status(400).json({ error: "Timer duration must be 24 hours or less" }); return;
  }

  const { data: existing, count: timerCount } = await supabase
    .from("timers")
    .select("id, order", { count: "exact" })
    .eq("session_id", id)
    .order("order", { ascending: false })
    .limit(1);

  const current = timerCount ?? existing?.length ?? 0;
  if (current >= TIMERS_HARD_CAP) {
    res.status(400).json({ error: `Maximum ${TIMERS_HARD_CAP} timers per session` }); return;
  }
  const ent = await getUserEntitlements(user.id);
  if (current >= ent.maxTimers) { upgradeRequired(res, "custom_timers"); return; }

  const nextOrder = existing?.length ? (existing[0].order + 1) : 0;
  const { data, error } = await supabase
    .from("timers")
    .insert({ session_id: id, name: body.name.trim(), duration: Math.floor(body.duration), order: nextOrder })
    .select().single();

  if (error) { serverError(res, error); return; }
  cache.del(`timers:${id}`);
  res.status(201).json({ data });
});

/** PATCH /api/sessions/:id/timers/:timerId
 *  Body: { name?: string, duration?: number (seconds) } */
router.patch("/:id/timers/:timerId", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id, timerId } = req.params;
  const body = req.body;
  if (!body) { res.status(400).json({ error: "Request body required" }); return; }

  if (!(await requireManager(supabase, String(id), user.id, res))) return;

  if (typeof body.name === "string" && body.name.trim().length > 80) {
    res.status(400).json({ error: "Timer name must be 80 characters or less" }); return;
  }
  if (typeof body.name === "string" && rejectObjectionableText(res, [body.name])) return;
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.duration === "number" && body.duration > 0) patch.duration = Math.min(Math.floor(body.duration), 86400);
  if (!Object.keys(patch).length) { res.status(400).json({ error: "Nothing to update" }); return; }

  // Scope to this session so a manager can't edit another session's timer by id.
  const { data, error } = await supabase
    .from("timers").update(patch).eq("id", timerId).eq("session_id", id).select().single();
  if (error) {
    const status = error.code === "PGRST116" ? 404 : 500;
    res.status(status).json({ error: error.message }); return;
  }
  cache.del(`timers:${id}`);
  res.json({ data });
});

/** DELETE /api/sessions/:id/timers/:timerId */
router.delete("/:id/timers/:timerId", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id, timerId } = req.params;

  if (!(await requireManager(supabase, String(id), user.id, res))) return;

  const { data: all } = await supabase.from("timers").select("id").eq("session_id", id);
  if ((all?.length ?? 0) <= 1) {
    res.status(400).json({ error: "Cannot remove the last timer" }); return;
  }

  const { error } = await supabase.from("timers").delete().eq("id", timerId).eq("session_id", id);
  if (error) { serverError(res, error); return; }
  cache.del(`timers:${id}`);
  res.json({ data: null });
});

// ── Stopwatch laps ────────────────────────────────────────────────────────────

/** GET /api/sessions/:id/laps */
router.get("/:id/laps", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  if (!(await requireParticipant(supabase, String(id), user.id, res))) return;
  const { data, error } = await supabase
    .from("stopwatch_laps")
    .select("id, lap_number, name, duration_seconds, created_at")
    .eq("session_id", id)
    .order("lap_number", { ascending: true });
  if (error) { serverError(res, error); return; }
  res.json({ data: data ?? [] });
});

/** POST /api/sessions/:id/laps — save current elapsed as a new lap */
router.post("/:id/laps", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!(await requireManager(supabase, String(id), user.id, res))) return;
  if (typeof body?.duration_seconds !== "number" || body.duration_seconds < 0) {
    res.status(400).json({ error: "duration_seconds is required" }); return;
  }
  if (typeof body.name === "string" && body.name.trim().length > LAP_NAME_MAX) {
    res.status(400).json({ error: `Lap name must be ${LAP_NAME_MAX} characters or less` }); return;
  }
  if (typeof body.name === "string" && rejectObjectionableText(res, [body.name])) return;

  const { data: existing } = await supabase
    .from("stopwatch_laps").select("lap_number").eq("session_id", id).order("lap_number", { ascending: false }).limit(1);
  const lapNumber = (existing?.[0]?.lap_number ?? 0) + 1;

  const { data, error } = await supabase.from("stopwatch_laps").insert({
    session_id: id,
    lap_number: lapNumber,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : `Lap ${lapNumber}`,
    duration_seconds: body.duration_seconds,
  }).select().single();

  if (error) { serverError(res, error); return; }
  res.status(201).json({ data });
});

/** PATCH /api/sessions/:id/laps/:lapId — rename a lap */
router.patch("/:id/laps/:lapId", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id, lapId } = req.params;
  const body = req.body;
  if (!(await requireManager(supabase, String(id), user.id, res))) return;
  if (typeof body?.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if (body.name.trim().length > LAP_NAME_MAX) {
    res.status(400).json({ error: `Lap name must be ${LAP_NAME_MAX} characters or less` }); return;
  }
  if (rejectObjectionableText(res, [body.name])) return;
  const { data, error } = await supabase
    .from("stopwatch_laps").update({ name: body.name.trim() }).eq("id", lapId).eq("session_id", id).select().single();
  if (error) {
    const status = error.code === "PGRST116" ? 404 : 500;
    res.status(status).json({ error: error.message }); return;
  }
  res.json({ data });
});

/** DELETE /api/sessions/:id/laps — clear every recorded lap, leaving the stopwatch untouched. */
router.delete("/:id/laps", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  if (!(await requireManager(supabase, String(id), user.id, res))) return;
  const { error } = await supabase.from("stopwatch_laps").delete().eq("session_id", id);
  if (error) { serverError(res, error); return; }
  res.json({ data: null });
});

/** DELETE /api/sessions/:id/laps/:lapId */
router.delete("/:id/laps/:lapId", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id, lapId } = req.params;
  if (!(await requireManager(supabase, String(id), user.id, res))) return;
  const { error } = await supabase.from("stopwatch_laps").delete().eq("id", lapId).eq("session_id", id);
  if (error) { serverError(res, error); return; }
  res.json({ data: null });
});

// ── Participants ──────────────────────────────────────────────────────────────

/** GET /api/sessions/:id/participants */
router.get("/:id/participants", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  if (!(await requireParticipant(supabase, String(id), user.id, res))) return;
  const { data, error } = await supabase
    .from("session_participants")
    .select(
      BILLING_ENABLED
        ? "id, user_id, role, joined_at, left_at, profiles(username, display_name, emoji, plan, plan_status, plan_period_end)"
        : "id, user_id, role, joined_at, left_at, profiles(username, display_name, emoji)",
    )
    .eq("session_id", id)
    .order("joined_at");
  if (error) { serverError(res, error); return; }
  // Expose a computed badge, never raw billing columns.
  const withBadges = ((data ?? []) as Record<string, unknown>[]).map((p) => {
    const prof = p.profiles as (Partial<PlanRow> & { username?: string; display_name?: string; emoji?: string }) | null;
    return {
      ...p,
      profiles: prof
        ? { username: prof.username, display_name: prof.display_name, emoji: prof.emoji, badge: getEntitlements(prof).badge }
        : prof,
    };
  });
  res.json({ data: withBadges });
});

/** PATCH /api/sessions/:id/participants/me
 *  Update the current user's own presence (left_at).
 *  Body: { left_at: string | null, save_history?: boolean }
 *  On leave (left_at !== null): transfers ownership if this user is the owner,
 *  or ends the session if they are the last active participant. History is
 *  saved by default for backward compatibility; pass save_history: false to
 *  leave without adding the session to history. */
router.patch("/:id/participants/me", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const { left_at, save_history } = req.body ?? {};
  let savedHistory: Record<string, unknown> | null = null;

  if (left_at === undefined) {
    res.status(400).json({ error: "left_at is required" }); return;
  }
  if (save_history !== undefined && typeof save_history !== "boolean") {
    res.status(400).json({ error: "save_history must be a boolean" }); return;
  }
  if (left_at !== null && typeof left_at !== "string") {
    res.status(400).json({ error: "left_at must be an ISO timestamp or null" }); return;
  }

  // Capture role before leaving. A user may only change their own presence in a
  // session they actually belong to — no row means they were never a participant.
  const { data: me } = await supabase
    .from("session_participants")
    .select("role, left_at")
    .eq("session_id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!me) { res.status(404).json({ error: "Session not found" }); return; }

  // Clearing left_at is the client's "I'm here" assert (fired on mount and when
  // the app returns to the foreground) — refresh the inactivity heartbeat too.
  // Client clocks are not authoritative for analytics. The request's timestamp
  // is only an intent signal (null = active, non-null = leave); attendance and
  // focus segments always close on the API's clock.
  const membershipChangedAt = new Date();
  const membershipPatch: Record<string, unknown> = {
    left_at: left_at === null ? null : membershipChangedAt.toISOString(),
  };
  if (left_at === null) membershipPatch.last_seen_at = new Date().toISOString();

  const { error } = await supabase
    .from("session_participants")
    .update(membershipPatch)
    .eq("session_id", id)
    .eq("user_id", user.id);

  if (error) { serverError(res, error); return; }

  if (left_at === null && me.left_at !== null) {
    await publishSessionEvent(supabase, String(id), user.id, "participant_joined");
  } else if (left_at !== null && me.left_at === null) {
    await publishSessionEvent(supabase, String(id), user.id, "participant_left");
  }

  if (left_at !== null) {
    // Persist the leaving user's history on EVERY leave (idempotent), not just
    // when they're the last one. The client's doSaveHistory is best-effort and
    // its failures are swallowed, so relying on it silently drops sessions from
    // the user's stats whenever it doesn't land (e.g. leaving while others
    // remain). The (session_id, user_id) existence check dedupes against a
    // successful client save. A user can explicitly opt out via save_history.
    if (save_history !== false) {
      const [
        { data: sessionData },
        { data: myParticipant },
        { data: timersData },
        { data: allParticipants },
      ] = await Promise.all([
        supabase.from("pomodoro_sessions").select("name, is_private").eq("id", id).single(),
        supabase.from("session_participants").select("joined_at").eq("session_id", id).eq("user_id", user.id).single(),
        supabase.from("timers").select("name, duration").eq("session_id", id).order("order"),
        supabase.from("session_participants").select("user_id, profiles(username, display_name)").eq("session_id", id),
      ]);

      if (sessionData && myParticipant) {
        let metrics;
        try {
          metrics = await getSessionTimeMetrics(supabase, String(id), user.id);
        } catch (metricsError) {
          serverError(res, metricsError);
          return;
        }
        const durationSeconds = metrics?.totalSeconds ?? Math.floor(
          (membershipChangedAt.getTime() - new Date((myParticipant as { joined_at: string }).joined_at).getTime()) / 1000
        );
        const focusSeconds = metrics?.focusSeconds;
        const { data: existing } = await supabase
          .from("pomodoro_history")
          .select("id")
          .eq("session_id", id)
          .eq("user_id", user.id)
          .maybeSingle();

        const historySnapshot = {
          session_id: id,
          source_session_id: id,
          user_id: user.id,
          session_name: (sessionData as { name: string }).name,
          was_private: (sessionData as { is_private?: boolean }).is_private ?? false,
          timers_used: (timersData ?? []).map((t: { name: string; duration: number }) => ({
            name: t.name,
            duration: t.duration,
          })),
          participants: (allParticipants ?? []).map((p) => ({
            username: (p as unknown as { profiles: { username: string; display_name: string } | null }).profiles?.username ?? "Unknown",
            display_name: (p as unknown as { profiles: { username: string; display_name: string } | null }).profiles?.display_name
              ?? (p as unknown as { profiles: { username: string } | null }).profiles?.username
              ?? "Unknown",
          })),
          duration_seconds: durationSeconds,
          ...(focusSeconds !== undefined ? { focus_seconds: focusSeconds } : {}),
          completed_at: membershipChangedAt.toISOString(),
        };

        if (existing) {
          const { data: updatedHistory, error: updateHistoryError } = await supabase
            .from("pomodoro_history")
            .update(historySnapshot)
            .eq("id", existing.id)
            .eq("user_id", user.id)
            .select()
            .single();
          if (!updateHistoryError && updatedHistory) {
            savedHistory = updatedHistory as Record<string, unknown>;
          }
        } else {
          const { data: insertedHistory, error: insertHistoryError } = await supabase
            .from("pomodoro_history")
            .insert(historySnapshot)
            .select()
            .single();
          if (!insertHistoryError && insertedHistory) {
            savedHistory = insertedHistory as Record<string, unknown>;
          }
        }
        cache.delByPrefix(`history:${user.id}:`);
        cache.del(`history-summary:${user.id}`);
        cache.del(`history-analytics:${user.id}`);
        cache.delByPrefix("user-hist:");
      }
    }

    // Find remaining active participants (excluding the one who just left)
    const { data: remaining } = await supabase
      .from("session_participants")
      .select("id, user_id, role, joined_at")
      .eq("session_id", id)
      .is("left_at", null)
      .neq("user_id", user.id)
      .order("joined_at", { ascending: true });

    if (!remaining?.length) {
      // Last person — tear the session down.
      await supabase.from("pomodoro_sessions").delete().eq("id", id);
    } else if (me?.role === "owner") {
      // Transfer ownership: prefer admins, then earliest joiner
      const nextOwner = remaining.find((p) => p.role === "admin") ?? remaining[0];
      await supabase
        .from("session_participants")
        .update({ role: "owner" })
        .eq("id", nextOwner.id);
      // Demote the former owner to admin
      await supabase
        .from("session_participants")
        .update({ role: "admin" })
        .eq("session_id", id)
        .eq("user_id", user.id);
      await publishSessionEvent(
        supabase,
        String(id),
        nextOwner.user_id,
        "ownership_transferred",
        user.id,
        undefined,
        {
          role: "owner",
          previous_role: nextOwner.role as "admin" | "member",
        },
      );
    }
  }

  // Returning the final server-authored row lets the recap use the exact same
  // total/focus values that were persisted, rather than the client's pre-leave
  // approximation from a few moments earlier.
  res.json({ data: savedHistory });
});

/** PATCH /api/sessions/:id/participants/:participantId
 *  Update a participant's role or kick them (set left_at).
 *  Body: { role?: "admin" | "member" } | { left_at: string } */
router.patch("/:id/participants/:participantId", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id: sessionId, participantId } = req.params;
  const body = req.body ?? {};

  // Get current user's role in this session
  const { data: me } = await supabase
    .from("session_participants")
    .select("role")
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();

  const myRole = me?.role;
  const isOwner = myRole === "owner";

  // Get target participant
  const { data: target } = await supabase
    .from("session_participants")
    .select("role, user_id, left_at")
    .eq("id", participantId)
    .eq("session_id", sessionId)
    .single();

  if (!target) { res.status(404).json({ error: "Participant not found" }); return; }

  if (body.role !== undefined) {
    if (!isOwner) { res.status(403).json({ error: "Only the owner can change roles" }); return; }
    if (body.role !== "admin" && body.role !== "member") {
      res.status(400).json({ error: "role must be 'admin' or 'member'" }); return;
    }
    if (target.left_at !== null) {
      res.status(409).json({ error: "Cannot change the role of a participant who left" }); return;
    }
    if (target.role === "owner") { res.status(403).json({ error: "Cannot change the owner's role" }); return; }
    if (target.user_id === user.id) { res.status(400).json({ error: "Cannot change your own role" }); return; }
    if (target.role === body.role) {
      res.json({ data: { participantId } });
      return;
    }

    const { error } = await supabase.from("session_participants").update({ role: body.role }).eq("id", participantId);
    if (error) { serverError(res, error); return; }
    await publishSessionEvent(
      supabase,
      String(sessionId),
      target.user_id,
      body.role === "admin" ? "participant_promoted" : "participant_demoted",
      user.id,
      undefined,
      {
        role: body.role,
        previous_role: target.role as "admin" | "member",
      },
    );
    res.json({ data: { participantId } });
    return;
  }

  if (body.left_at !== undefined) {
    if (!isOwner) { res.status(403).json({ error: "Only the owner can remove participants" }); return; }
    if (target.role === "owner") { res.status(403).json({ error: "Cannot remove the owner" }); return; }
    if (target.user_id === user.id) { res.status(400).json({ error: "Cannot remove yourself" }); return; }

    const { error } = await supabase
      .from("session_participants")
      .update({ left_at: body.left_at })
      .eq("id", participantId);
    if (error) { serverError(res, error); return; }
    if (body.left_at !== null && target.left_at === null) {
      await publishSessionEvent(
        supabase,
        String(sessionId),
        target.user_id,
        "participant_removed",
        user.id,
      );
    }
    res.json({ data: { participantId } });
    return;
  }

  res.status(400).json({ error: "Nothing to update" });
});

/** POST /api/sessions/:id/participants/:userId/kick
 *  Soft-removes a participant by user_id. Only owners can kick; owner cannot be kicked. */
router.post("/:id/participants/:userId/kick", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id, userId } = req.params;

  if (userId === user.id) { res.status(400).json({ error: "You cannot kick yourself" }); return; }

  const { data: requester } = await supabase
    .from("session_participants")
    .select("role")
    .eq("session_id", id)
    .eq("user_id", user.id)
    .single();

  if (requester?.role !== "owner") { res.status(403).json({ error: "Only the owner can remove participants" }); return; }

  const { data: target } = await supabase
    .from("session_participants")
    .select("role, left_at")
    .eq("session_id", id)
    .eq("user_id", userId)
    .single();

  if (!target) { res.status(404).json({ error: "Participant not found" }); return; }
  if (target.role === "owner") { res.status(403).json({ error: "Cannot kick the session owner" }); return; }

  const { error } = await supabase
    .from("session_participants")
    .update({ left_at: new Date().toISOString() })
    .eq("session_id", id)
    .eq("user_id", userId);

  if (error) { serverError(res, error); return; }
  if (target.left_at === null) {
    await publishSessionEvent(
      supabase,
      String(id),
      String(userId),
      "participant_removed",
      user.id,
    );
  }
  res.json({ data: { kicked: userId } });
});

// ── Messages ─────────────────────────────────────────────────────────────────

/** GET /api/sessions/:id/messages
 *  Query params: limit (default 100, max 200), before (ISO timestamp).
 *  The bounded newest-first index scan avoids loading an entire busy session. */
router.get("/:id/messages", authenticate, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;

  if (!(await requireParticipant(supabase, String(id), user.id, res))) return;

  const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 100 });
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  if (before && Number.isNaN(Date.parse(before))) {
    res.status(400).json({ error: "before must be an ISO timestamp" }); return;
  }

  let query = supabase
    .from("chat_messages")
    .select("id, content, created_at, user_id, kind, metadata, profiles(username, display_name, emoji)")
    .eq("session_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) { serverError(res, error); return; }

  const blockedIds = await getMutuallyBlockedUserIds(supabase, user.id);
  const messages = ((data ?? []) as unknown as SessionChatRow[])
    .filter((message) => !message.user_id || !blockedIds.has(message.user_id))
    .reverse()
    .map(serializeSessionChatRow);
  res.json({ data: messages });
});

/** POST /api/sessions/:id/messages
 *  Persist for the lifetime of the session, then broadcast to active clients.
 *  Session deletion cascades to these rows; ended sessions are cleared by the
 *  database migration's status trigger. */
router.post<{ id: string }>("/:id/messages", authenticate, messageLimiter, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;

  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    res.status(400).json({ error: "content is required" }); return;
  }
  if (body.content.length > 500) {
    res.status(400).json({ error: "Message cannot exceed 500 characters" }); return;
  }
  if (rejectObjectionableText(res, [body.content])) return;

  // One query proves active membership in a still-running session and resolves
  // the authoritative sender profile. Identity is never accepted from clients.
  const { data: membership, error: membershipError } = await supabase
    .from("session_participants")
    .select("id, pomodoro_sessions!inner(status)")
    .eq("session_id", id)
    .eq("user_id", user.id)
    .is("left_at", null)
    .in("pomodoro_sessions.status", ["waiting", "active"])
    .maybeSingle();

  if (membershipError) { serverError(res, membershipError); return; }
  if (!membership) { res.status(404).json({ error: "Session not found" }); return; }

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      session_id: id,
      user_id: user.id,
      content: body.content.trim(),
      kind: "message" satisfies SessionChatKind,
    })
    .select("id, content, created_at, user_id, kind, metadata, profiles(username, display_name, emoji)")
    .single();
  if (error || !data) { serverError(res, error ?? new Error("Message was not saved")); return; }

  const message = serializeSessionChatRow(data as unknown as SessionChatRow);
  await broadcastSessionChatItem(supabase, String(id), message);
  res.status(201).json({ data: message });
});

/** POST /api/sessions/:id/accept-invite
 *  Accept a chat session-invite — joins the session bypassing privacy/password
 *  (a valid, unexpired grant from `create_session_invite` is required). */
router.post("/:id/accept-invite", authenticate, async (req, res) => {
  const { user, supabase, token } = req;
  const { id } = req.params;

  // One session at a time — accepting an invite to the current session is fine.
  const currentSessionId = await getActiveSessionId(supabase, user.id);
  if (currentSessionId && currentSessionId !== id) {
    res.status(409).json({ error: ALREADY_IN_SESSION }); return;
  }

  const { data: existingParticipant } = await supabase
    .from("session_participants")
    .select("role, left_at")
    .eq("session_id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: profile } = await supabase
    .from("profiles").select("username").eq("id", user.id).single();

  // Participant cap follows the session owner's plan (see POST /join).
  const { data: ownerRow } = await supabase
    .from("pomodoro_sessions").select("owner_id").eq("id", id).maybeSingle();
  const ownerEnt = await getUserEntitlements((ownerRow?.owner_id as string | undefined) ?? user.id);

  // User-scoped client so auth.uid() resolves inside accept_session_invite.
  // Same legacy-RPC caveat as POST /join: only pass the cap when billing is on.
  const userClient = createAuthClient(token);
  const { error: acceptError } = await userClient.rpc("accept_session_invite", {
    p_session_id: id,
    p_username: profile?.username ?? (user.email?.split("@")[0] ?? "User"),
    ...(BILLING_ENABLED ? { p_max_participants: ownerEnt.maxParticipants } : {}),
  });
  if (acceptError) {
    if (acceptError.message.includes("Session is full")) {
      res.status(409).json({ error: "session_full", max: ownerEnt.maxParticipants }); return;
    }
    res.status(400).json({ error: acceptError.message }); return;
  }

  const { data: sessionRow, error: sessErr } = await supabase
    .from("pomodoro_sessions").select("*").eq("id", id).single();
  if (sessErr) {
    const status = sessErr.code === "PGRST116" ? 404 : 500;
    res.status(status).json({ error: sessErr.message }); return;
  }

  const shouldJoinAsMember =
    sessionRow.owner_id !== user.id && (!existingParticipant || existingParticipant.left_at !== null);

  const nowIso = new Date().toISOString();
  const { data: participantRow } = await supabase
    .from("session_participants")
    .update(shouldJoinAsMember ? { left_at: null, role: "member", last_seen_at: nowIso } : { left_at: null, last_seen_at: nowIso })
    .eq("session_id", id)
    .eq("user_id", user.id)
    .select("role, joined_at")
    .single();

  // Same read-back as POST /join — never guess "member" for a known participant.
  let participant = participantRow;
  if (!participant) {
    const { data: fetched } = await supabase
      .from("session_participants")
      .select("role, joined_at")
      .eq("session_id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    participant = fetched ?? { role: "member", joined_at: new Date().toISOString() };
  }
  if (!existingParticipant || existingParticipant.left_at !== null) {
    await publishSessionEvent(supabase, String(id), user.id, "participant_joined");
  }
  const { password_hash: _ph, ...safeSession } = sessionRow as Record<string, unknown> & { password_hash?: unknown };
  void _ph;
  res.json({ data: { session: safeSession, participant } });
});

export default router;
