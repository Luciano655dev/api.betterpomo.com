import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverError } from "../lib/http";
import { authenticate } from "../middleware/auth";
import { cache, TTL } from "../lib/cache";
import { notify } from "../lib/notify";
import { clampInt } from "../lib/utils";

const router = Router();
router.use(authenticate);

/** Fetch the actor's identity to snapshot into notification metadata. */
async function actorSnapshot(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from("profiles").select("username, display_name, emoji").eq("id", userId).single();
  return {
    username: data?.username ?? "someone",
    display_name: data?.display_name ?? data?.username ?? "Someone",
    emoji: data?.emoji ?? "🍅",
  };
}

/** Invalidate every cache entry affected by a friendship change for one user. */
function invalidateForUser(userId: string) {
  cache.delByPrefix(`friends:${userId}:`);
  cache.del(`friend-count:${userId}`);
  cache.del(`friend-reqs:${userId}`);
  cache.delByPrefix("user-friends:");
}

/** A friendship mutation always changes both sides — invalidate both. */
function invalidatePair(a: string, b: string) {
  invalidateForUser(a);
  invalidateForUser(b);
}

/** Resolve a username to its profile id (or null). */
async function resolveUserId(supabase: import("@supabase/supabase-js").SupabaseClient, username: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("username", username)
    .limit(1);
  return data?.[0]?.id ?? null;
}

// ── Requests (specific routes first) ────────────────────────────────────────────

/** GET /api/friends/requests — incoming + outgoing pending requests */
router.get("/requests", async (req, res) => {
  const { user, supabase } = req;
  const cacheKey = `friend-reqs:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const { data, error } = await supabase.rpc("get_friend_requests", { p_user_id: user.id });
  if (error) { serverError(res, error); return; }

  const rows = (data ?? []) as { direction: "incoming" | "outgoing" }[];
  const payload = {
    incoming: rows.filter((r) => r.direction === "incoming"),
    outgoing: rows.filter((r) => r.direction === "outgoing"),
  };
  cache.set(cacheKey, payload, TTL.FRIEND_REQUESTS);
  res.json({ data: payload });
});

/** POST /api/friends/requests — send a request. Body: { username } */
router.post("/requests", async (req, res) => {
  const { user, supabase } = req;
  const body = req.body;
  if (!body || typeof body.username !== "string" || !body.username.trim()) {
    res.status(400).json({ error: "username is required" }); return;
  }

  const targetId = await resolveUserId(supabase, body.username.trim());
  if (!targetId) { res.status(404).json({ error: "User not found" }); return; }
  if (targetId === user.id) { res.status(400).json({ error: "Cannot send a friend request to yourself" }); return; }

  const { data, error } = await supabase.rpc("send_friend_request", {
    p_actor: user.id,
    p_target: targetId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  invalidatePair(user.id, targetId);

  const status = data as string;
  const actor = await actorSnapshot(supabase, user.id);
  if (status === "pending_outgoing") {
    await notify(targetId, { actorId: user.id, type: "friend_request", entityId: user.id, metadata: actor });
  } else if (status === "friends") {
    // mutual: sending back accepted their pending request
    await notify(targetId, { actorId: user.id, type: "friend_accept", entityId: user.id, metadata: actor });
  }

  res.status(201).json({ data: { status } });
});

/** POST /api/friends/requests/:userId/accept */
router.post("/requests/:userId/accept", async (req, res) => {
  const { user, supabase } = req;
  const requesterId = String(req.params.userId);

  const { error } = await supabase.rpc("respond_friend_request", {
    p_actor: user.id,
    p_requester: requesterId,
    p_accept: true,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  invalidatePair(user.id, requesterId);

  const actor = await actorSnapshot(supabase, user.id);
  await notify(requesterId, { actorId: user.id, type: "friend_accept", entityId: user.id, metadata: actor });

  res.json({ data: { status: "friends" } });
});

/** POST /api/friends/requests/:userId/decline */
router.post("/requests/:userId/decline", async (req, res) => {
  const { user, supabase } = req;
  const requesterId = String(req.params.userId);

  const { error } = await supabase.rpc("respond_friend_request", {
    p_actor: user.id,
    p_requester: requesterId,
    p_accept: false,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  invalidatePair(user.id, requesterId);
  res.json({ data: { status: "none" } });
});

/** DELETE /api/friends/requests/:userId — cancel an outgoing request */
router.delete("/requests/:userId", async (req, res) => {
  const { user, supabase } = req;
  const targetId = String(req.params.userId);

  const { error } = await supabase.rpc("cancel_friend_request", {
    p_actor: user.id,
    p_target: targetId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  invalidatePair(user.id, targetId);
  res.json({ data: { status: "none" } });
});

/** GET /api/friends/status/:username — friendship status vs a user (viewer-specific, uncached) */
router.get("/status/:username", async (req, res) => {
  const { user, supabase } = req;
  const username = String(req.params.username);

  const targetId = await resolveUserId(supabase, username);
  if (!targetId) { res.status(404).json({ error: "User not found" }); return; }

  const { data, error } = await supabase.rpc("get_friendship_status", {
    p_viewer: user.id,
    p_target: targetId,
  });
  if (error) { serverError(res, error); return; }

  res.json({ data: { status: data as string, target_id: targetId } });
});

// ── Friends list ────────────────────────────────────────────────────────────────

/** GET /api/friends?limit&offset — own friends list + count */
router.get("/", async (req, res) => {
  const { user, supabase } = req;
  const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 50 });
  const offset = clampInt(req.query.offset, { min: 0, max: 1_000_000, fallback: 0 });

  const listKey = `friends:${user.id}:${limit}:${offset}`;
  const countKey = `friend-count:${user.id}`;
  const cachedList = cache.get(listKey);
  const cachedCount = cache.get<number>(countKey);
  if (cachedList && cachedCount !== null) {
    res.json({ data: { friends: cachedList, count: cachedCount } });
    return;
  }

  const [{ data: friends, error: friendsErr }, { data: count, error: countErr }] = await Promise.all([
    supabase.rpc("get_friends", { p_user_id: user.id, p_limit: limit, p_offset: offset }),
    supabase.rpc("count_friends", { p_user_id: user.id }),
  ]);
  if (friendsErr) { serverError(res, friendsErr); return; }
  if (countErr) { serverError(res, countErr); return; }

  cache.set(listKey, friends ?? [], TTL.FRIENDS);
  cache.set(countKey, count ?? 0, TTL.FRIENDS);
  res.json({ data: { friends: friends ?? [], count: count ?? 0 } });
});

/** DELETE /api/friends/:userId — unfriend */
router.delete("/:userId", async (req, res) => {
  const { user, supabase } = req;
  const otherId = String(req.params.userId);

  const { error } = await supabase.rpc("remove_friend", {
    p_actor: user.id,
    p_other: otherId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  invalidatePair(user.id, otherId);
  res.json({ data: { status: "none" } });
});

export default router;
