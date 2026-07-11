import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { clampInt } from "../lib/utils";

const router = Router();
router.use(authenticate);

/** GET /api/notifications?limit&offset — own notifications + unread count */
router.get("/", async (req, res) => {
  const { user, supabase } = req;
  const limit = clampInt(req.query.limit, { min: 1, max: 100, fallback: 50 });
  const offset = clampInt(req.query.offset, { min: 0, max: 1_000_000, fallback: 0 });

  // Only the first page (offset 0) is cached — it backs the bell badge/dropdown.
  const cacheKey = `notif:${user.id}`;
  if (offset === 0) {
    const hit = cache.get(cacheKey);
    if (hit) { res.json({ data: hit }); return; }
  }

  const [{ data: notifications, error }, { count, error: countErr }] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, type, actor_id, entity_id, metadata, read_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null),
  ]);

  if (error) { serverError(res, error); return; }
  if (countErr) { serverError(res, countErr); return; }

  const payload = { notifications: notifications ?? [], unread_count: count ?? 0 };
  if (offset === 0) cache.set(cacheKey, payload, TTL.NOTIFICATIONS);
  res.json({ data: payload });
});

/** POST /api/notifications/read — mark all unread as read */
router.post("/read", async (req, res) => {
  const { user, supabase } = req;
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);
  if (error) { serverError(res, error); return; }
  cache.del(`notif:${user.id}`);
  res.json({ data: null });
});

/** POST /api/notifications/:id/read — mark one read */
router.post("/:id/read", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) { serverError(res, error); return; }
  cache.del(`notif:${user.id}`);
  res.json({ data: null });
});

/** DELETE /api/notifications/:id — dismiss one */
router.delete("/:id", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;
  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) { serverError(res, error); return; }
  cache.del(`notif:${user.id}`);
  res.json({ data: null });
});

export default router;
