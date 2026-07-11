import { adminDb } from "./supabase";
import { cache } from "./cache";

export type NotificationType =
  | "friend_request"
  | "friend_accept"
  | "session_invite"
  | "group_add"
  | "trial_ending";

interface NotifyOptions {
  actorId: string;
  type: NotificationType;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
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
    await adminDb.from("notifications").insert({
      user_id: recipientId,
      actor_id: opts.actorId,
      type: opts.type,
      entity_id: opts.entityId ?? null,
      metadata: opts.metadata ?? {},
    });
    cache.del(`notif:${recipientId}`);
  } catch (err) {
    console.error("notify failed:", err);
  }
}
