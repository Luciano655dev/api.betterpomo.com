import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverError } from "../lib/http";
import { authenticate } from "../middleware/auth";
import { perUserLimiter } from "../middleware/rateLimit";
import { cache, TTL, CHAT_TTL_SECONDS } from "../lib/cache";
import { notify } from "../lib/notify";
import { clampInt } from "../lib/utils";
import { getUserEntitlements, upgradeRequired } from "../lib/plans";
import { cancelCoalescedPush, queueCoalescedPush } from "../lib/push";
import { getSessionTimeMetrics } from "../lib/sessionTime";

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

/** Fetch the actor's identity to snapshot into notification metadata. */
async function actorSnapshot(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from("profiles").select("username, display_name, emoji").eq("id", userId).single();
  return {
    username: data?.username ?? "someone",
    display_name: data?.display_name ?? data?.username ?? "Someone",
    emoji: data?.emoji ?? "🍅",
  };
}

type GroupRole = "owner" | "admin" | "member";
type GroupSystemEvent =
  | "member_joined"
  | "member_left"
  | "member_removed"
  | "member_promoted"
  | "member_demoted"
  | "ownership_transferred"
  | "group_renamed";

interface GroupAccess {
  role: GroupRole;
  conversation: { id: string; title: string | null; emoji: string; timezone: string; created_by: string };
}

async function getGroupAccess(
  supabase: SupabaseClient,
  conversationId: string,
  userId: string,
): Promise<GroupAccess | null> {
  const [{ data: conversation }, { data: membership }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, emoji, timezone, created_by, is_group")
      .eq("id", conversationId)
      .maybeSingle(),
    supabase
      .from("conversation_members")
      .select("role")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (!conversation?.is_group || !membership) return null;
  return {
    role: membership.role as GroupRole,
    conversation: {
      id: conversation.id as string,
      title: conversation.title as string | null,
      emoji: (conversation.emoji as string | null) ?? "👥",
      timezone: (conversation.timezone as string | null) ?? "UTC",
      created_by: conversation.created_by as string,
    },
  };
}

function isManager(role: GroupRole): boolean {
  return role === "owner" || role === "admin";
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validGroupEmoji(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 16
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function hashGroupInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validGroupInviteToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,100}$/.test(token);
}

function groupSchemaUnavailable(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST202" || error?.code === "PGRST205";
}

function groupSchemaError(res: Parameters<typeof serverError>[0], error: { code?: string; message?: string }) {
  if (groupSchemaUnavailable(error)) {
    res.status(503).json({ error: "Group features are being updated. Please retry in a moment." });
    return;
  }
  serverError(res, error);
}

/** Store group membership changes in the same short-lived stream as messages.
 *  A metadata discriminator lets every client render a centered divider while
 *  keeping the existing dm_kind enum and expiry/cleanup behavior unchanged. */
async function appendGroupMembershipMessage(
  supabase: SupabaseClient,
  conversationId: string,
  userId: string,
  event: GroupSystemEvent,
  actorId?: string,
  customContent?: string,
): Promise<void> {
  const member = await actorSnapshot(supabase, userId);
  const action: Record<GroupSystemEvent, string> = {
    member_joined: "joined the group",
    member_left: "left the group",
    member_removed: "was removed from the group",
    member_promoted: "is now an admin",
    member_demoted: "is no longer an admin",
    ownership_transferred: "is now the group owner",
    group_renamed: "renamed the group",
  };
  const content = customContent ?? `@${member.username} ${action[event]}`;
  const { error } = await supabase.from("dm_messages").insert({
    conversation_id: conversationId,
    sender_id: actorId ?? userId,
    kind: "text",
    content,
    metadata: {
      system_event: event,
      user_id: userId,
      username: member.username,
      display_name: member.display_name,
      actor_id: actorId ?? userId,
    },
    expires_at: new Date(Date.now() + CHAT_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) {
    // Membership is the source of truth; a cosmetic event must not roll it back.
    // A missing conversation means the last member left and there is nobody to notify.
    if (error.code !== "23503") console.error("group membership message failed", error);
    return;
  }
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
}

async function createGroupInvitation(
  supabase: SupabaseClient,
  conversationId: string,
  invitedBy: string,
  invitedUser: string,
) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  return supabase
    .from("group_invitations")
    .insert({
      conversation_id: conversationId,
      invited_user: invitedUser,
      invited_by: invitedBy,
      expires_at: expiresAt,
    })
    .select("id, conversation_id, invited_user, invited_by, status, created_at, expires_at")
    .single();
}

/** Message alerts are push-only; unread state remains owned by Conversations. */
async function pushNewMessage(
  supabase: SupabaseClient,
  conversationId: string,
  messageId: string,
  senderId: string,
  content: string,
): Promise<void> {
  try {
    const [{ data: members, error: membersError }, { data: conversation }, actor] = await Promise.all([
      supabase.from("conversation_members").select("user_id").eq("conversation_id", conversationId),
      supabase.from("conversations").select("is_group, title, emoji").eq("id", conversationId).single(),
      actorSnapshot(supabase, senderId),
    ]);
    if (membersError) throw membersError;
    const recipients = (members ?? []).map((member) => member.user_id).filter((id) => id !== senderId);
    const groupTitle = conversation?.title?.trim() || "your group";
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 160);
    await Promise.all(recipients.map((recipientId) => queueCoalescedPush(
      recipientId,
      "messages",
      `chat_message:${messageId}`,
      `chat:${recipientId}:${conversationId}`,
      {
        title: conversation?.is_group
          ? `${actor.emoji} ${actor.display_name} · ${groupTitle}`
          : `${actor.emoji} ${actor.display_name}`,
        body: `💬 ${preview}`,
        data: {
          type: "chat_message",
          conversation_id: conversationId,
          sender_id: senderId,
          username: actor.username,
          display_name: actor.display_name,
          emoji: actor.emoji,
          message_count: 1,
        },
        collapseId: `chat:${conversationId}`,
      },
      conversation?.is_group
        ? `${conversation.emoji ?? "👥"} ${groupTitle} · {count} new messages`
        : `${actor.emoji} ${actor.display_name} · {count} new messages`,
    )));
  } catch (err) {
    console.error("chat push failed:", err);
  }
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

/** POST /api/chat/conversations/group
 *  Create a named group. Selected users receive invitations rather than being
 *  silently added. Body: { title, timezone, usernames?: string[] } */
router.post("/conversations/group", async (req, res) => {
  const { user, supabase } = req;
  const body = req.body ?? {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 80) {
    res.status(400).json({ error: "Group name must be 1-80 characters" }); return;
  }
  const timezone = validTimezone(body.timezone) ? body.timezone : "UTC";
  const emoji = validGroupEmoji(body.emoji) ? body.emoji.trim() : "👥";
  const usernames = Array.isArray(body.usernames)
    ? [...new Set(body.usernames.filter((value: unknown): value is string => typeof value === "string" && !!value.trim()).map((value: string) => value.trim()))]
    : [];

  const ent = await getUserEntitlements(user.id);
  if (usernames.length + 1 > ent.maxGroupMembers) { upgradeRequired(res, "group_chat_size"); return; }

  const { data, error } = await supabase.rpc("create_governed_group", {
    p_actor: user.id,
    p_title: title,
    p_timezone: timezone,
    p_emoji: emoji,
    p_usernames: usernames,
  });
  if (error) {
    if (groupSchemaUnavailable(error)) { groupSchemaError(res, error); return; }
    res.status(400).json({ error: error.message }); return;
  }

  const result = data as { id: string; invitations?: Array<{ id: string; invited_user: string }> };
  const conversationId = result.id;
  const invitations = result.invitations ?? [];
  if (invitations.length) {
    const actor = await actorSnapshot(supabase, user.id);
    await Promise.all(invitations.map((invitation) => notify(invitation.invited_user, {
      actorId: user.id,
      type: "group_invite",
      entityId: invitation.id,
      metadata: { ...actor, title, conversation_id: conversationId, invitation_id: invitation.id },
    })));
  }

  cache.del(`conversations:${user.id}`);
  res.status(201).json({ data: { id: conversationId, emoji, invitations } });
});

/** POST /api/chat/conversations/:id/members
 *  Backward-compatible invitation endpoint. It no longer auto-adds users. */
router.post("/conversations/:id/members", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const body = req.body;
  if (!body || typeof body.username !== "string" || !body.username.trim()) {
    res.status(400).json({ error: "username is required" }); return;
  }
  const inviteeId = await resolveUserId(supabase, body.username.trim());
  if (!inviteeId) { res.status(404).json({ error: "User not found" }); return; }
  if (inviteeId === user.id) { res.status(400).json({ error: "You are already in this group" }); return; }

  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can invite people" }); return; }

  const { data: existingMember } = await supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", id)
    .eq("user_id", inviteeId)
    .maybeSingle();
  if (existingMember) { res.status(409).json({ error: "Already a member of this group" }); return; }

  const [{ count: memberCount }, { count: pendingCount }] = await Promise.all([
    supabase.from("conversation_members").select("user_id", { count: "exact", head: true }).eq("conversation_id", id),
    supabase.from("group_invitations").select("id", { count: "exact", head: true })
      .eq("conversation_id", id).eq("status", "pending").gt("expires_at", new Date().toISOString()),
  ]);
  const ent = await getUserEntitlements(access.conversation.created_by);
  if ((memberCount ?? 0) + (pendingCount ?? 0) + 1 > ent.maxGroupMembers) {
    upgradeRequired(res, "group_chat_size"); return;
  }

  const invitation = await createGroupInvitation(supabase, String(id), user.id, inviteeId);
  if (invitation.error?.code === "23505") {
    res.status(409).json({ error: "This user already has a pending invitation" }); return;
  }
  if (invitation.error) { serverError(res, invitation.error); return; }
  const actor = await actorSnapshot(supabase, user.id);
  await notify(inviteeId, {
    actorId: user.id,
    type: "group_invite",
    entityId: invitation.data.id,
    metadata: {
      ...actor,
      title: access.conversation.title,
      conversation_id: id,
      invitation_id: invitation.data.id,
    },
  });

  res.status(201).json({ data: invitation.data });
});

/** GET /api/chat/group-invitations — pending invitations for the Messages inbox. */
router.get("/group-invitations", async (req, res) => {
  const { user, supabase } = req;
  const now = new Date().toISOString();
  const { data: invitations, error } = await supabase
    .from("group_invitations")
    .select("id, conversation_id, invited_by, created_at, expires_at")
    .eq("invited_user", user.id)
    .eq("status", "pending")
    .gt("expires_at", now)
    .order("created_at", { ascending: false });
  if (error) { groupSchemaError(res, error); return; }

  const conversationIds = [...new Set((invitations ?? []).map((row) => row.conversation_id))];
  const inviterIds = [...new Set((invitations ?? []).map((row) => row.invited_by))];
  const [{ data: conversations }, { data: inviters }] = await Promise.all([
    conversationIds.length
      ? supabase.from("conversations").select("id, title, emoji").in("id", conversationIds)
      : Promise.resolve({ data: [] }),
    inviterIds.length
      ? supabase.from("profiles").select("id, username, display_name, emoji").in("id", inviterIds)
      : Promise.resolve({ data: [] }),
  ]);
  const conversationById = new Map((conversations ?? []).map((row) => [row.id, row]));
  const inviterById = new Map((inviters ?? []).map((row) => [row.id, row]));
  res.json({
    data: (invitations ?? []).map((invitation) => ({
      ...invitation,
      group: conversationById.get(invitation.conversation_id) ?? null,
      inviter: inviterById.get(invitation.invited_by) ?? null,
    })),
  });
});

/** POST /api/chat/conversations/:id/invite-links — create a revocable, expiring link.
 *  Only a SHA-256 digest is persisted. The raw bearer token is returned once. */
router.post("/conversations/:id/invite-links", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can create invitation links" }); return; }

  const expiresInMinutes = clampInt(req.body?.expires_in_minutes, { min: 15, max: 10_080, fallback: 1_440 });
  const maxUses = clampInt(req.body?.max_uses, { min: 1, max: 100, fallback: 25 });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from("group_invite_links")
    .insert({
      conversation_id: id,
      token_hash: hashGroupInviteToken(token),
      created_by: user.id,
      expires_at: expiresAt,
      max_uses: maxUses,
    })
    .select("id, conversation_id, created_at, expires_at, max_uses, use_count")
    .single();
  if (error) { groupSchemaError(res, error); return; }
  res.status(201).json({ data: { ...data, token } });
});

/** GET /api/chat/conversations/:id/invite-links — active link metadata. */
router.get("/conversations/:id/invite-links", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can view invitation links" }); return; }
  const { data, error } = await supabase
    .from("group_invite_links")
    .select("id, conversation_id, created_at, expires_at, max_uses, use_count, revoked_at")
    .eq("conversation_id", id)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) { groupSchemaError(res, error); return; }
  res.json({ data: data ?? [] });
});

/** DELETE /api/chat/conversations/:id/invite-links/:linkId — revoke a link immediately. */
router.delete("/conversations/:id/invite-links/:linkId", async (req, res) => {
  const { user, supabase } = req;
  const { id, linkId } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can revoke invitation links" }); return; }
  const { data, error } = await supabase.from("group_invite_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", linkId).eq("conversation_id", id).is("revoked_at", null)
    .select("id").maybeSingle();
  if (error) { groupSchemaError(res, error); return; }
  if (!data) { res.status(404).json({ error: "Invitation link not found" }); return; }
  res.json({ data: null });
});

/** GET /api/chat/group-invite-links/:token — safe preview for the acceptance page. */
router.get("/group-invite-links/:token", async (req, res) => {
  const { user, supabase } = req;
  const { token } = req.params;
  if (!validGroupInviteToken(token)) { res.status(404).json({ error: "Invitation link not found" }); return; }
  const { data: link, error } = await supabase.from("group_invite_links")
    .select("id, conversation_id, expires_at, max_uses, use_count, revoked_at, conversations(title, emoji)")
    .eq("token_hash", hashGroupInviteToken(token)).maybeSingle();
  if (error) { groupSchemaError(res, error); return; }
  if (!link || link.revoked_at || Date.parse(link.expires_at) <= Date.now() || link.use_count >= link.max_uses) {
    res.status(410).json({ error: "This invitation link has expired or been revoked" }); return;
  }
  const { data: membership } = await supabase.from("conversation_members").select("role")
    .eq("conversation_id", link.conversation_id).eq("user_id", user.id).maybeSingle();
  res.json({ data: {
    conversation_id: link.conversation_id,
    group: link.conversations,
    expires_at: link.expires_at,
    uses_remaining: Math.max(0, link.max_uses - link.use_count),
    already_member: !!membership,
  } });
});

/** POST /api/chat/group-invite-links/:token/accept — atomically consume a link. */
router.post("/group-invite-links/:token/accept", async (req, res) => {
  const { user, supabase } = req;
  const { token } = req.params;
  if (!validGroupInviteToken(token)) { res.status(404).json({ error: "Invitation link not found" }); return; }
  const tokenHash = hashGroupInviteToken(token);
  const { data: link } = await supabase.from("group_invite_links")
    .select("conversation_id, conversations(created_by)").eq("token_hash", tokenHash).maybeSingle();
  if (!link) { res.status(404).json({ error: "Invitation link not found" }); return; }
  const { data: existingMembership } = await supabase.from("conversation_members")
    .select("user_id").eq("conversation_id", link.conversation_id).eq("user_id", user.id).maybeSingle();
  if (existingMembership) {
    res.json({ data: { conversation_id: link.conversation_id } });
    return;
  }
  const ownerId = (link.conversations as unknown as { created_by?: string } | null)?.created_by ?? user.id;
  const ent = await getUserEntitlements(ownerId);
  const { data, error } = await supabase.rpc("accept_group_invite_link", {
    p_actor: user.id,
    p_token_hash: tokenHash,
    p_max_members: ent.maxGroupMembers,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }
  const conversationId = String(data ?? link.conversation_id);
  await appendGroupMembershipMessage(supabase, conversationId, user.id, "member_joined");
  await invalidateConversation(supabase, conversationId);
  cache.del(`conversations:${user.id}`);
  res.json({ data: { conversation_id: conversationId } });
});

/** DELETE /api/chat/conversations/:id/members/me — leave a conversation */
router.delete("/conversations/:id/members/me", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;

  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (access.role === "owner") {
    res.status(409).json({ error: "Transfer ownership before leaving this group" }); return;
  }

  await invalidateConversation(supabase, id); // capture members before leaving
  const { error } = await supabase.rpc("leave_conversation", {
    p_actor: user.id,
    p_conversation_id: id,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }

  await appendGroupMembershipMessage(supabase, String(id), user.id, "member_left");
  cache.del(`conversations:${user.id}`);
  res.json({ data: null });
});

/** POST /api/chat/group-invitations/:invitationId/accept */
router.post("/group-invitations/:invitationId/accept", async (req, res) => {
  const { user, supabase } = req;
  const { invitationId } = req.params;
  const { data: invitation } = await supabase
    .from("group_invitations")
    .select("conversation_id")
    .eq("id", invitationId)
    .eq("invited_user", user.id)
    .maybeSingle();
  if (!invitation) { res.status(404).json({ error: "Invitation not found" }); return; }

  const ownerRow = await supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", invitation.conversation_id)
    .eq("role", "owner")
    .maybeSingle();
  const [{ count: memberCount }, ownerEnt] = await Promise.all([
    supabase.from("conversation_members").select("user_id", { count: "exact", head: true })
      .eq("conversation_id", invitation.conversation_id),
    getUserEntitlements(ownerRow.data?.user_id ?? user.id),
  ]);
  if ((memberCount ?? 0) + 1 > ownerEnt.maxGroupMembers) {
    res.status(409).json({ error: "This group is full" }); return;
  }

  const { data, error } = await supabase.rpc("accept_group_invitation", {
    p_actor: user.id,
    p_invitation_id: invitationId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }
  const conversationId = String(data ?? invitation.conversation_id);
  await appendGroupMembershipMessage(supabase, conversationId, user.id, "member_joined");
  await invalidateConversation(supabase, conversationId);
  cache.del(`conversations:${user.id}`);
  cache.del(`notif:${user.id}`);
  res.json({ data: { conversation_id: conversationId } });
});

/** POST /api/chat/group-invitations/:invitationId/decline */
router.post("/group-invitations/:invitationId/decline", async (req, res) => {
  const { user, supabase } = req;
  const { invitationId } = req.params;
  const { data, error } = await supabase
    .from("group_invitations")
    .update({ status: "declined", responded_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("invited_user", user.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) { serverError(res, error); return; }
  if (!data) { res.status(404).json({ error: "Invitation not found" }); return; }
  cache.del(`notif:${user.id}`);
  res.json({ data: null });
});

/** DELETE /api/chat/conversations/:id/invitations/:invitationId */
router.delete("/conversations/:id/invitations/:invitationId", async (req, res) => {
  const { user, supabase } = req;
  const { id, invitationId } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can revoke invitations" }); return; }
  const { data, error } = await supabase
    .from("group_invitations")
    .update({ status: "revoked", responded_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("conversation_id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) { serverError(res, error); return; }
  if (!data) { res.status(404).json({ error: "Invitation not found" }); return; }
  res.json({ data: null });
});

/** POST /api/chat/conversations/:id/activity-consent — one-time consent for legacy members. */
router.post("/conversations/:id/activity-consent", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  const startedAt = new Date().toISOString();
  const { error } = await supabase
    .from("conversation_members")
    .update({ activity_sharing_started_at: startedAt })
    .eq("conversation_id", id)
    .eq("user_id", user.id);
  if (error) { serverError(res, error); return; }
  res.json({ data: { activity_sharing_started_at: startedAt } });
});

/** PATCH /api/chat/conversations/:id — update group identity or reporting timezone. */
router.patch("/conversations/:id", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can edit this group" }); return; }

  const patch: Record<string, string> = {};
  if (req.body?.title !== undefined) {
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title || title.length > 80) { res.status(400).json({ error: "Group name must be 1-80 characters" }); return; }
    patch.title = title;
  }
  if (req.body?.timezone !== undefined) {
    if (!validTimezone(req.body.timezone)) { res.status(400).json({ error: "Invalid timezone" }); return; }
    patch.timezone = req.body.timezone;
  }
  if (req.body?.emoji !== undefined) {
    if (!validGroupEmoji(req.body.emoji)) { res.status(400).json({ error: "Choose one group emoji" }); return; }
    patch.emoji = req.body.emoji.trim();
  }
  if (!Object.keys(patch).length) { res.status(400).json({ error: "Nothing to update" }); return; }

  const { data, error } = await supabase.from("conversations").update(patch).eq("id", id).select("title, emoji, timezone").single();
  if (error) { groupSchemaError(res, error); return; }
  await invalidateConversation(supabase, String(id));
  if (patch.title) {
    await appendGroupMembershipMessage(
      supabase,
      String(id),
      user.id,
      "group_renamed",
      user.id,
      `@${(await actorSnapshot(supabase, user.id)).username} renamed the group to ${patch.title}`,
    );
  }
  res.json({ data });
});

/** PATCH /api/chat/conversations/:id/members/:memberId/role */
router.patch("/conversations/:id/members/:memberId/role", async (req, res) => {
  const { user, supabase } = req;
  const { id, memberId } = req.params;
  const role = req.body?.role;
  if (role !== "admin" && role !== "member") { res.status(400).json({ error: "role must be admin or member" }); return; }
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (access.role !== "owner") { res.status(403).json({ error: "Only the owner can manage admins" }); return; }
  if (memberId === user.id) { res.status(400).json({ error: "Transfer ownership to change your own role" }); return; }

  const { data: target } = await supabase.from("conversation_members")
    .select("role").eq("conversation_id", id).eq("user_id", memberId).maybeSingle();
  if (!target) { res.status(404).json({ error: "Member not found" }); return; }
  if (target.role === "owner") { res.status(400).json({ error: "Cannot change the owner role" }); return; }
  const { error } = await supabase.from("conversation_members").update({ role })
    .eq("conversation_id", id).eq("user_id", memberId);
  if (error) { serverError(res, error); return; }
  await appendGroupMembershipMessage(supabase, String(id), memberId, role === "admin" ? "member_promoted" : "member_demoted", user.id);
  await invalidateConversation(supabase, String(id));
  res.json({ data: { user_id: memberId, role } });
});

/** DELETE /api/chat/conversations/:id/members/:memberId — remove a member. */
router.delete("/conversations/:id/members/:memberId", async (req, res) => {
  const { user, supabase } = req;
  const { id, memberId } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (!isManager(access.role)) { res.status(403).json({ error: "Only owners and admins can remove members" }); return; }
  const { data: target } = await supabase.from("conversation_members")
    .select("role").eq("conversation_id", id).eq("user_id", memberId).maybeSingle();
  if (!target) { res.status(404).json({ error: "Member not found" }); return; }
  if (target.role === "owner") { res.status(403).json({ error: "The owner cannot be removed" }); return; }
  if (access.role === "admin" && target.role !== "member") {
    res.status(403).json({ error: "Admins cannot remove other admins" }); return;
  }
  await invalidateConversation(supabase, String(id));
  const { error } = await supabase.from("conversation_members").delete()
    .eq("conversation_id", id).eq("user_id", memberId);
  if (error) { serverError(res, error); return; }
  await appendGroupMembershipMessage(supabase, String(id), memberId, "member_removed", user.id);
  cache.del(`conversations:${memberId}`);
  res.json({ data: null });
});

/** POST /api/chat/conversations/:id/transfer-ownership */
router.post("/conversations/:id/transfer-ownership", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const memberId = req.body?.user_id;
  if (typeof memberId !== "string") { res.status(400).json({ error: "user_id is required" }); return; }
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (access.role !== "owner") { res.status(403).json({ error: "Only the owner can transfer ownership" }); return; }
  const { error } = await supabase.rpc("transfer_group_ownership", {
    p_actor: user.id,
    p_conversation_id: id,
    p_new_owner: memberId,
  });
  if (error) { res.status(400).json({ error: error.message }); return; }
  await appendGroupMembershipMessage(supabase, String(id), memberId, "ownership_transferred", user.id);
  await invalidateConversation(supabase, String(id));
  res.json({ data: { owner_id: memberId } });
});

/** DELETE /api/chat/conversations/:id — owner-only permanent group deletion. */
router.delete("/conversations/:id", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }
  if (access.role !== "owner") { res.status(403).json({ error: "Only the owner can delete this group" }); return; }
  await invalidateConversation(supabase, String(id));
  const { error } = await supabase.from("conversations").delete().eq("id", id).eq("is_group", true);
  if (error) { serverError(res, error); return; }
  res.json({ data: null });
});

/** GET /api/chat/conversations/:id/details — governed group metadata + live activity. */
router.get("/conversations/:id/details", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }

  const { data: memberRows, error: memberError } = await supabase
    .from("conversation_members")
    .select("user_id, role, joined_at, activity_sharing_started_at, profiles(username, display_name, emoji, is_private)")
    .eq("conversation_id", id)
    .order("joined_at");
  if (memberError) { groupSchemaError(res, memberError); return; }

  type MemberRow = {
    user_id: string;
    role: GroupRole;
    joined_at: string;
    activity_sharing_started_at: string | null;
    profiles: { username: string; display_name: string; emoji: string; is_private: boolean } | null;
  };
  type ActiveRow = {
    user_id: string;
    pomodoro_sessions: {
      id: string;
      name: string;
      code: string;
      status: string;
      is_private: boolean;
      password_hash: string | null;
      session_type: "pomodoro" | "stopwatch";
      timer_state: string;
      focus_started_at: string | null;
    } | null;
  };
  const members = (memberRows ?? []) as unknown as MemberRow[];
  const userIds = members.map((member) => member.user_id);
  const { data: activeRows, error: activeError } = userIds.length
    ? await supabase
        .from("session_participants")
        .select("user_id, pomodoro_sessions!inner(id, name, code, status, is_private, password_hash, session_type, timer_state, focus_started_at)")
        .in("user_id", userIds)
        .is("left_at", null)
        .in("pomodoro_sessions.status", ["waiting", "active"])
    : { data: [], error: null };
  if (activeError) { serverError(res, activeError); return; }

  const activeByUser = new Map<string, ActiveRow>();
  for (const row of (activeRows ?? []) as unknown as ActiveRow[]) activeByUser.set(row.user_id, row);
  const measuredAt = new Date();
  const liveMetrics = new Map<string, Awaited<ReturnType<typeof getSessionTimeMetrics>>>();
  await Promise.all(members.map(async (member) => {
    const session = activeByUser.get(member.user_id)?.pomodoro_sessions;
    if (!session) return;
    liveMetrics.set(
      member.user_id,
      await getSessionTimeMetrics(supabase, session.id, member.user_id, measuredAt),
    );
  }));

  let pendingInvitations: unknown[] = [];
  if (isManager(access.role)) {
    const { data: invitations, error: invitationError } = await supabase
      .from("group_invitations")
      .select("id, invited_user, invited_by, status, created_at, expires_at")
      .eq("conversation_id", id)
      .eq("status", "pending")
      .gt("expires_at", measuredAt.toISOString())
      .order("created_at");
    if (invitationError) { groupSchemaError(res, invitationError); return; }
    const inviteeIds = (invitations ?? []).map((invitation) => invitation.invited_user);
    const { data: profiles } = inviteeIds.length
      ? await supabase.from("profiles").select("id, username, display_name, emoji").in("id", inviteeIds)
      : { data: [] };
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    pendingInvitations = (invitations ?? []).map((invitation) => ({
      ...invitation,
      profile: profileById.get(invitation.invited_user) ?? null,
    }));
  }

  const payload = {
    id: access.conversation.id,
    title: access.conversation.title ?? "Group",
    emoji: access.conversation.emoji,
    timezone: access.conversation.timezone,
    my_role: access.role,
    activity_sharing_started_at:
      members.find((member) => member.user_id === user.id)?.activity_sharing_started_at ?? null,
    members: members.map((member) => {
      const session = activeByUser.get(member.user_id)?.pomodoro_sessions ?? null;
      const mayShareTime = member.user_id === user.id || member.activity_sharing_started_at !== null;
      const mayIdentifySession = !!session && !member.profiles?.is_private && !session.is_private;
      const metrics = mayShareTime ? liveMetrics.get(member.user_id) ?? null : null;
      return {
        id: member.user_id,
        role: member.role,
        joined_at: member.joined_at,
        activity_sharing_started_at: member.activity_sharing_started_at,
        username: member.profiles?.username ?? "unknown",
        display_name: member.profiles?.display_name ?? member.profiles?.username ?? "Unknown",
        emoji: member.profiles?.emoji ?? "🍅",
        activity: session ? {
          in_session: true,
          total_seconds: metrics?.totalSeconds ?? null,
          focus_seconds: metrics?.focusSeconds ?? null,
          measured_at: measuredAt.toISOString(),
          is_focus_running: session.focus_started_at !== null && session.timer_state === "running",
          session: mayIdentifySession ? {
            id: session.id,
            name: session.name,
            code: session.code,
            session_type: session.session_type,
            is_password_protected: !!session.password_hash,
          } : null,
        } : { in_session: false },
      };
    }),
    pending_invitations: pendingInvitations,
  };
  res.json({ data: payload });
});

/** GET /api/chat/conversations/:id/report?from&to
 *  Owners/admins receive current consenting members; regular members receive
 *  only their own rows. Durations remain authoritative history totals. */
router.get("/conversations/:id/report", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const access = await getGroupAccess(supabase, String(id), user.id);
  if (!access) { res.status(404).json({ error: "Group not found" }); return; }

  const toMs = typeof req.query.to === "string" ? Date.parse(req.query.to) : Date.now();
  const fromMs = typeof req.query.from === "string" ? Date.parse(req.query.from) : toMs - 7 * 24 * 60 * 60_000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    res.status(400).json({ error: "Invalid report range" }); return;
  }
  const ent = await getUserEntitlements(access.conversation.created_by);
  const earliest = ent.historyDays === null
    ? fromMs
    : Math.max(fromMs, Date.now() - ent.historyDays * 24 * 60 * 60_000);

  type ReportPeriod = {
    id: string;
    user_id: string;
    role_at_join: GroupRole;
    joined_at: string;
    sharing_started_at: string | null;
    left_at: string | null;
    profiles: { username: string; display_name: string; emoji: string; is_private: boolean } | null;
  };
  type ActivitySegment = {
    id: string;
    user_id: string;
    session_name: string;
    was_private: boolean;
    started_at: string;
    ended_at: string;
    total_seconds: number;
    focus_seconds: number;
  };
  const [{ data: periodRows, error: periodError }, { data: currentRoles, error: roleError }] = await Promise.all([
    supabase
      .from("group_membership_periods")
      .select("id, user_id, role_at_join, joined_at, sharing_started_at, left_at, profiles(username, display_name, emoji, is_private)")
      .eq("conversation_id", id)
      .lt("joined_at", new Date(toMs).toISOString())
      .or(`left_at.is.null,left_at.gt.${new Date(earliest).toISOString()}`),
    supabase.from("conversation_members").select("user_id, role").eq("conversation_id", id),
  ]);
  if (periodError || roleError) { groupSchemaError(res, (periodError ?? roleError)!); return; }
  const allPeriods = (periodRows ?? []) as unknown as ReportPeriod[];
  const visiblePeriods = isManager(access.role)
    ? allPeriods.filter((period) => period.sharing_started_at !== null)
    : allPeriods.filter((period) => period.user_id === user.id);
  const visibleIds = [...new Set(visiblePeriods.map((period) => period.user_id))];
  const currentRoleByUser = new Map((currentRoles ?? []).map((member) => [member.user_id, member.role as GroupRole]));

  const { data: segmentRows, error: segmentError } = visibleIds.length
    ? await supabase
        .from("user_activity_segments")
        .select("id, user_id, session_name, was_private, started_at, ended_at, total_seconds, focus_seconds")
        .in("user_id", visibleIds)
        .lt("started_at", new Date(toMs).toISOString())
        .gt("ended_at", new Date(earliest).toISOString())
        .order("started_at")
    : { data: [], error: null };
  if (segmentError) { groupSchemaError(res, segmentError); return; }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: access.conversation.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  type ReportSession = {
    id: string; name: string; total_seconds: number; focus_seconds: number;
    completed_at: string; is_private: boolean;
  };
  const rowsByUser = new Map<string, ReportSession[]>();
  for (const segment of (segmentRows ?? []) as ActivitySegment[]) {
    const segmentStart = Date.parse(segment.started_at);
    const segmentEnd = Date.parse(segment.ended_at);
    const segmentDuration = Math.max(1, segmentEnd - segmentStart);
    for (const period of visiblePeriods.filter((candidate) => candidate.user_id === segment.user_id)) {
      const sharingStart = period.sharing_started_at ?? (period.user_id === user.id ? period.joined_at : null);
      if (!sharingStart) continue;
      const overlapStart = Math.max(segmentStart, earliest, Date.parse(period.joined_at), Date.parse(sharingStart));
      const overlapEnd = Math.min(segmentEnd, toMs, period.left_at ? Date.parse(period.left_at) : toMs);
      if (overlapEnd <= overlapStart) continue;
      const ratio = (overlapEnd - overlapStart) / segmentDuration;
      const totalSeconds = Math.max(0, Math.round(Number(segment.total_seconds) * ratio));
      const focusSeconds = Math.min(totalSeconds, Math.max(0, Math.round(Number(segment.focus_seconds) * ratio)));
      if (!totalSeconds && !focusSeconds) continue;
      const profile = period.profiles;
      const isPrivate = segment.was_private || !!profile?.is_private;
      rowsByUser.set(segment.user_id, [...(rowsByUser.get(segment.user_id) ?? []), {
        id: `${segment.id}:${period.id}`,
        name: isPrivate ? "Private session" : segment.session_name,
        total_seconds: totalSeconds,
        focus_seconds: focusSeconds,
        completed_at: new Date(overlapEnd).toISOString(),
        is_private: isPrivate,
      }]);
    }
  }

  const reportMembers = visibleIds.map((userId) => {
    const periods = visiblePeriods.filter((period) => period.user_id === userId);
    const member = periods[periods.length - 1];
    const rows = rowsByUser.get(userId) ?? [];
    const daily = new Map<string, { total_seconds: number; focus_seconds: number }>();
    const sessions = rows.map((row) => {
      const totalSeconds = row.total_seconds;
      const focusSeconds = row.focus_seconds;
      const day = formatter.format(new Date(row.completed_at));
      const bucket = daily.get(day) ?? { total_seconds: 0, focus_seconds: 0 };
      bucket.total_seconds += totalSeconds;
      bucket.focus_seconds += focusSeconds;
      daily.set(day, bucket);
      return {
        id: row.id,
        name: row.name,
        total_seconds: totalSeconds,
        focus_seconds: focusSeconds,
        completed_at: row.completed_at,
        is_private: row.is_private,
      };
    });
    const totalSeconds = sessions.reduce((sum, row) => sum + row.total_seconds, 0);
    const focusSeconds = sessions.reduce((sum, row) => sum + row.focus_seconds, 0);
    return {
      id: userId,
      role: currentRoleByUser.get(userId) ?? member.role_at_join,
      username: member.profiles?.username ?? "unknown",
      display_name: member.profiles?.display_name ?? member.profiles?.username ?? "Unknown",
      emoji: member.profiles?.emoji ?? "🍅",
      total_seconds: totalSeconds,
      focus_seconds: focusSeconds,
      focus_ratio: totalSeconds ? focusSeconds / totalSeconds : 0,
      daily: [...daily.entries()].map(([date, totals]) => ({ date, ...totals })),
      sessions,
    };
  });
  res.json({
    data: {
      timezone: access.conversation.timezone,
      from: new Date(earliest).toISOString(),
      to: new Date(toMs).toISOString(),
      members: reportMembers,
      total_seconds: reportMembers.reduce((sum, member) => sum + member.total_seconds, 0),
      focus_seconds: reportMembers.reduce((sum, member) => sum + member.focus_seconds, 0),
    },
  });
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
  if (data?.id) await pushNewMessage(supabase, id, String(data.id), user.id, body.content.trim());
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
  await cancelCoalescedPush(user.id, `chat:${user.id}:${id}`).catch((err) => {
    console.error("queued chat push cancellation failed:", err);
  });
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

  const { data: membership, error: membershipError } = await supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) { serverError(res, membershipError); return; }
  if (!membership) { res.status(404).json({ error: "Conversation not found" }); return; }

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
