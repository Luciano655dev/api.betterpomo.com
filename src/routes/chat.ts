import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverError } from "../lib/http";
import { authenticate } from "../middleware/auth";
import { perUserLimiter } from "../middleware/rateLimit";
import { cache, TTL, CHAT_TTL_SECONDS } from "../lib/cache";
import { notify } from "../lib/notify";
import { clampInt } from "../lib/utils";
import { getUserEntitlements, upgradeRequired } from "../lib/plans";

const router = Router();
router.use(authenticate);

// Per-user DM spam cap — mirrors the session-chat limiter (20 msgs / 10s).
const dmMessageLimiter = perUserLimiter({
  windowMs: 10_000,
  limit: 20,
  message: "You're sending messages too fast. Slow down a moment.",
  name: "dm-msg",
});

/** Resolve a username to its profile id (or null). */
async function resolveUserId(supabase: SupabaseClient, username: string) {
  const { data } = await supabase.from("profiles").select("id").eq("username", username).limit(1);
  return data?.[0]?.id ?? null;
}

/** Fetch the actor's username/emoji to snapshot into notification metadata. */
async function actorSnapshot(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from("profiles").select("username, emoji").eq("id", userId).single();
  return { username: data?.username ?? "Someone", emoji: data?.emoji ?? "🍅" };
}

/** Invalidate the conversation-list cache for every member of a conversation. */
async function invalidateConversation(supabase: SupabaseClient, conversationId: string) {
  const { data } = await supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId);
  for (const m of data ?? []) cache.del(`conversations:${m.user_id}`);
}

// ── Conversation list + creation ───────────────────────────────────────────────

/** GET /api/chat/conversations — list my conversations (+ unread + last message) */
router.get("/conversations", async (req, res) => {
  const { user, supabase } = req;
  const cacheKey = `conversations:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const { data, error } = await supabase.rpc("list_conversations", { p_user_id: user.id });
  if (error) { serverError(res, error); return; }
  cache.set(cacheKey, data ?? [], TTL.CONVERSATIONS);
  res.json({ data: data ?? [] });
});

/** POST /api/chat/conversations/direct — open (or reuse) a 1:1 chat. Body: { username } */
router.post("/conversations/direct", async (req, res) => {
  const { user, supabase } = req;
  const body = req.body;
  if (!body || typeof body.username !== "string" || !body.username.trim()) {
    res.status(400).json({ error: "username is required" }); return;
  }
  const friendId = await resolveUserId(supabase, body.username.trim());
  if (!friendId) { res.status(404).json({ error: "User not found" }); return; }

  const { data, error } = await supabase.rpc("get_or_create_direct_conversation", {
    p_actor: user.id,
    p_friend: friendId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  cache.del(`conversations:${user.id}`);
  cache.del(`conversations:${friendId}`);
  res.status(201).json({ data: { id: data as string } });
});

/** POST /api/chat/conversations/group — create a group. Body: { title?, usernames: string[] } */
router.post("/conversations/group", async (req, res) => {
  const { user, supabase } = req;
  const body = req.body;
  if (!body || !Array.isArray(body.usernames) || body.usernames.length === 0) {
    res.status(400).json({ error: "usernames is required" }); return;
  }

  const ids: string[] = [];
  for (const uname of body.usernames) {
    if (typeof uname !== "string") continue;
    const id = await resolveUserId(supabase, uname.trim());
    if (!id) { res.status(404).json({ error: `User not found: ${uname}` }); return; }
    ids.push(id);
  }

  // Group size is gated on the creator's plan (members + the creator).
  const ent = await getUserEntitlements(user.id);
  if (ids.length + 1 > ent.maxGroupMembers) { upgradeRequired(res, "group_chat_size"); return; }

  const { data, error } = await supabase.rpc("create_group_conversation", {
    p_actor: user.id,
    p_title: typeof body.title === "string" ? body.title : null,
    p_member_ids: ids,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  cache.del(`conversations:${user.id}`);
  for (const id of ids) cache.del(`conversations:${id}`);
  res.status(201).json({ data: { id: data as string } });
});

/** POST /api/chat/conversations/:id/members — add a friend to a group. Body: { username } */
router.post("/conversations/:id/members", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!body || typeof body.username !== "string" || !body.username.trim()) {
    res.status(400).json({ error: "username is required" }); return;
  }
  const friendId = await resolveUserId(supabase, body.username.trim());
  if (!friendId) { res.status(404).json({ error: "User not found" }); return; }

  // Cap on the acting inviter's plan — simple and abuse-resistant enough.
  const { count: memberCount } = await supabase
    .from("conversation_members")
    .select("user_id", { count: "exact", head: true })
    .eq("conversation_id", id);
  const ent = await getUserEntitlements(user.id);
  if ((memberCount ?? 0) + 1 > ent.maxGroupMembers) { upgradeRequired(res, "group_chat_size"); return; }

  const { error } = await supabase.rpc("add_conversation_member", {
    p_actor: user.id,
    p_conversation_id: id,
    p_friend: friendId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  await invalidateConversation(supabase, id);
  cache.del(`conversations:${friendId}`);

  const { data: convo } = await supabase
    .from("conversations").select("title").eq("id", id).single();
  const actor = await actorSnapshot(supabase, user.id);
  await notify(friendId, {
    actorId: user.id,
    type: "group_add",
    entityId: id,
    metadata: { ...actor, title: convo?.title ?? null },
  });

  res.status(201).json({ data: null });
});

/** DELETE /api/chat/conversations/:id/members/me — leave a conversation */
router.delete("/conversations/:id/members/me", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;

  await invalidateConversation(supabase, id); // capture members before leaving
  const { error } = await supabase.rpc("leave_conversation", {
    p_actor: user.id,
    p_conversation_id: id,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  cache.del(`conversations:${user.id}`);
  res.json({ data: null });
});

// ── Messages ────────────────────────────────────────────────────────────────────

/** GET /api/chat/conversations/:id/messages?before&limit */
router.get("/conversations/:id/messages", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 50 });
  const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;

  const { data, error } = await supabase.rpc("get_dm_messages", {
    p_actor: user.id,
    p_conversation_id: id,
    p_limit: limit,
    p_before: before,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json({ data: data ?? [] });
});

/** POST /api/chat/conversations/:id/messages — send a text message. Body: { content } */
router.post<{ id: string }>("/conversations/:id/messages", dmMessageLimiter, async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    res.status(400).json({ error: "content is required" }); return;
  }

  const { data, error } = await supabase.rpc("post_dm_message", {
    p_actor: user.id,
    p_conversation_id: id,
    p_kind: "text",
    p_content: body.content.trim(),
    p_metadata: {},
    p_ttl_seconds: CHAT_TTL_SECONDS,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  await invalidateConversation(supabase, id);
  res.status(201).json({ data });
});

/** POST /api/chat/conversations/:id/read — mark conversation as read */
router.post("/conversations/:id/read", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const { error } = await supabase.rpc("mark_conversation_read", {
    p_actor: user.id,
    p_conversation_id: id,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }
  cache.del(`conversations:${user.id}`);
  res.json({ data: null });
});

/** POST /api/chat/conversations/:id/invite — invite all other members to a session.
 *  Body: { session_id } */
router.post("/conversations/:id/invite", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!body || typeof body.session_id !== "string") {
    res.status(400).json({ error: "session_id is required" }); return;
  }

  const { data: session, error: sessErr } = await supabase
    .from("pomodoro_sessions")
    .select("id, code, name, session_type, status")
    .eq("id", body.session_id)
    .single();
  if (sessErr || !session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.status === "ended") { res.status(410).json({ error: "Session has ended" }); return; }

  // Every other member of the conversation gets a grant.
  const { data: members } = await supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", id);
  const others = (members ?? []).map((m) => m.user_id).filter((uid) => uid !== user.id);
  if (others.length === 0) { res.status(400).json({ error: "No one to invite" }); return; }

  const actor = await actorSnapshot(supabase, user.id);
  for (const invitee of others) {
    const { error } = await supabase.rpc("create_session_invite", {
      p_actor: user.id,
      p_session_id: session.id,
      p_invitee: invitee,
      p_ttl_seconds: CHAT_TTL_SECONDS,
    });
    if (error) { res.status(400).json({ error: error.message }); return; }
    await notify(invitee, {
      actorId: user.id,
      type: "session_invite",
      entityId: session.id,
      metadata: { ...actor, name: session.name, code: session.code, session_type: session.session_type ?? "pomodoro", conversation_id: id },
    });
  }

  const { data: msg, error: msgErr } = await supabase.rpc("post_dm_message", {
    p_actor: user.id,
    p_conversation_id: id,
    p_kind: "session_invite",
    p_content: `Invited you to "${session.name}"`,
    p_metadata: {
      session_id: session.id,
      code: session.code,
      name: session.name,
      session_type: session.session_type ?? "pomodoro",
    },
    p_ttl_seconds: CHAT_TTL_SECONDS,
  });
  if (msgErr) { res.status(400).json({ error: msgErr.message }); return; }

  await invalidateConversation(supabase, id);
  res.status(201).json({ data: msg });
});

export default router;
