import { adminDb } from "./supabase";
import { cache } from "./cache";
import { queuePush, type PushCategory, type PushPayload } from "./push";

export type NotificationType =
  | "friend_request"
  | "friend_accept"
  | "session_invite"
  | "group_add"
  | "trial_ending";

interface NotifyOptions {
  actorId: string | null;
  type: NotificationType;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

function copyFor(opts: NotifyOptions): { category: PushCategory; payload: PushPayload } {
  const username = typeof opts.metadata?.username === "string" ? opts.metadata.username : "Someone";
  const title = typeof opts.metadata?.title === "string" ? opts.metadata.title : "a group";
  const name = typeof opts.metadata?.name === "string" ? opts.metadata.name : "a focus session";
  const data = {
    type: opts.type,
    actor_id: opts.actorId,
    entity_id: opts.entityId ?? null,
    ...opts.metadata,
  };

  switch (opts.type) {
    case "friend_request":
      return {
        category: "friends",
        payload: { title: "New friend request", body: `${username} wants to be your friend.`, data },
      };
    case "friend_accept":
      return {
        category: "friends",
        payload: { title: "Friend request accepted", body: `${username} accepted your friend request.`, data },
      };
    case "session_invite":
      return {
        category: "sessions",
        payload: { title: "Focus session invite", body: `${username} invited you to ${name}.`, data },
      };
    case "group_add":
      return {
        category: "messages",
        payload: { title: "Added to a group", body: `${username} added you to ${title}.`, data },
      };
    case "trial_ending":
      return {
        category: "account",
        payload: {
          title: "Your Pro trial ends soon",
          body: "Your subscription starts in 2 days. Manage it anytime in Settings.",
          data,
        },
      };
  }
}

/**
 * Best-effort insert of a single notification row for `recipientId`.
 * - Never notifies the actor about their own action.
 * - Swallows errors so a failed notification never breaks the primary action.
 * - Invalidates the recipient's cached notification list.
 */
export async function notify(recipientId: string, opts: NotifyOptions): Promise<void> {
  try {
    if (!recipientId || recipientId === opts.actorId) return;
    const { data: inserted, error } = await adminDb.from("notifications").insert({
      user_id: recipientId,
      actor_id: opts.actorId,
      type: opts.type,
      entity_id: opts.entityId ?? null,
      metadata: opts.metadata ?? {},
    }).select("id").single();
    if (error) throw error;
    cache.del(`notif:${recipientId}`);
    const { category, payload } = copyFor(opts);
    await queuePush(recipientId, category, `notification:${inserted.id}`, {
      ...payload,
      data: { ...payload.data, notification_id: inserted.id },
    });
  } catch (err) {
    console.error("notify failed:", err);
  }
}

/** Account/system events may target the same user without a social actor. */
export async function notifySystem(
  recipientId: string,
  opts: Omit<NotifyOptions, "actorId">,
): Promise<void> {
  await notify(recipientId, { ...opts, actorId: null });
}
