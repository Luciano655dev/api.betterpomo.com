import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { clampInt } from "../lib/utils";
import { isExpoPushToken } from "../lib/push";

const router = Router();
router.use(authenticate);

const DEFAULT_CATEGORY_PREFERENCES = {
  timers: true,
  friends: true,
  sessions: true,
  messages: true,
  account: true,
  routines: false,
};
const DEFAULT_PREFERENCES = {
  ...DEFAULT_CATEGORY_PREFERENCES,
  routine_weekdays: [] as number[],
  routine_time: null as string | null,
  routine_timezone: null as string | null,
};

function validWeekdays(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length <= 7
    && value.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    && new Set(value).size === value.length;
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** POST /api/notifications/devices — register or refresh one app installation. */
router.post("/devices", async (req, res) => {
  const { user, supabase } = req;
  const { installation_id: installationId, expo_push_token: token, platform } = req.body ?? {};
  if (typeof installationId !== "string" || installationId.length < 8 || installationId.length > 200) {
    res.status(400).json({ error: "Valid installation_id is required" }); return;
  }
  if (!isExpoPushToken(token)) {
    res.status(400).json({ error: "Valid expo_push_token is required" }); return;
  }
  if (platform !== "ios" && platform !== "android") {
    res.status(400).json({ error: "platform must be ios or android" }); return;
  }

  // Expo tokens identify an installation. If that installation changed accounts,
  // move the token instead of leaving it attached to the previous user.
  const { error: removeError } = await supabase
    .from("push_devices")
    .delete()
    .eq("expo_push_token", token)
    .neq("user_id", user.id);
  if (removeError) { serverError(res, removeError); return; }

  const now = new Date().toISOString();
  const { error } = await supabase.from("push_devices").upsert({
    user_id: user.id,
    installation_id: installationId,
    expo_push_token: token,
    platform,
    disabled_at: null,
    last_seen_at: now,
  }, { onConflict: "user_id,installation_id" });
  if (error) { serverError(res, error); return; }
  res.json({ data: null });
});

/** DELETE /api/notifications/devices/:installationId — unregister on sign-out. */
router.delete("/devices/:installationId", async (req, res) => {
  const { user, supabase } = req;
  const { error } = await supabase
    .from("push_devices")
    .delete()
    .eq("user_id", user.id)
    .eq("installation_id", String(req.params.installationId));
  if (error) { serverError(res, error); return; }
  res.json({ data: null });
});

/** GET /api/notifications/preferences — category-level delivery controls. */
router.get("/preferences", async (req, res) => {
  const { user, supabase } = req;
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("timers, friends, sessions, messages, account, routines, routine_weekdays, routine_time, routine_timezone")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) { serverError(res, error); return; }
  res.json({ data: data ?? DEFAULT_PREFERENCES });
});

/** PATCH /api/notifications/preferences — update one or more category toggles. */
router.patch("/preferences", async (req, res) => {
  const { user, supabase } = req;
  const updates: Record<string, boolean | string | number[] | null> = { user_id: user.id, updated_at: new Date().toISOString() };
  for (const key of Object.keys(DEFAULT_CATEGORY_PREFERENCES) as (keyof typeof DEFAULT_CATEGORY_PREFERENCES)[]) {
    if (req.body?.[key] !== undefined) {
      if (typeof req.body[key] !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean` }); return;
      }
      updates[key] = req.body[key];
    }
  }
  if (req.body?.routine_weekdays !== undefined) {
    if (!validWeekdays(req.body.routine_weekdays)) {
      res.status(400).json({ error: "routine_weekdays must contain unique weekdays from 1 to 7" }); return;
    }
    updates.routine_weekdays = [...req.body.routine_weekdays].sort((a, b) => a - b);
  }
  if (req.body?.routine_time !== undefined) {
    if (req.body.routine_time !== null && (typeof req.body.routine_time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(req.body.routine_time))) {
      res.status(400).json({ error: "routine_time must use HH:mm" }); return;
    }
    updates.routine_time = req.body.routine_time;
  }
  if (req.body?.routine_timezone !== undefined) {
    if (req.body.routine_timezone !== null && !validTimezone(req.body.routine_timezone)) {
      res.status(400).json({ error: "routine_timezone must be a valid IANA timezone" }); return;
    }
    updates.routine_timezone = req.body.routine_timezone;
  }
  if (Object.keys(updates).length === 2) {
    res.status(400).json({ error: "At least one notification preference is required" }); return;
  }
  const { data, error } = await supabase.from("notification_preferences")
    .upsert(updates, { onConflict: "user_id" })
    .select("timers, friends, sessions, messages, account, routines, routine_weekdays, routine_time, routine_timezone")
    .single();
  if (error) { serverError(res, error); return; }
  res.json({ data });
});

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
