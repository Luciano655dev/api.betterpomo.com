// Session templates (Pro): reusable timer configurations. Applied at session
// creation via POST /api/sessions { template_id } (see routes/sessions.ts).
import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";
import { getUserEntitlements, upgradeRequired, TIMERS_HARD_CAP } from "../lib/plans";

const router = Router();
router.use(authenticate);

const MAX_TEMPLATES = 20;

/** GET /api/templates — the caller's saved templates. */
router.get("/", async (req, res) => {
  const { user, supabase } = req;
  const ent = await getUserEntitlements(user.id);
  if (!ent.templates) { upgradeRequired(res, "templates"); return; }

  const cacheKey = `templates:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const { data, error } = await supabase
    .from("session_templates")
    .select("id, name, session_type, timers, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) { serverError(res, error); return; }
  cache.set(cacheKey, data, TTL.TEMPLATES);
  res.json({ data });
});

/** POST /api/templates — save a timer configuration.
 *  Body: { name: string, session_type?: "pomodoro"|"stopwatch", timers: [{ name, duration }] } */
router.post("/", async (req, res) => {
  const { user, supabase } = req;
  const ent = await getUserEntitlements(user.id);
  if (!ent.templates) { upgradeRequired(res, "templates"); return; }

  const body = req.body;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if (body.name.trim().length > 80) {
    res.status(400).json({ error: "Template name must be 80 characters or less" }); return;
  }
  const timers = Array.isArray(body.timers)
    ? (body.timers as unknown[])
        .filter((t): t is { name: string; duration: number } =>
          !!t && typeof t === "object" &&
          typeof (t as { name?: unknown }).name === "string" && !!(t as { name: string }).name.trim() &&
          typeof (t as { duration?: unknown }).duration === "number" && (t as { duration: number }).duration > 0)
        .slice(0, TIMERS_HARD_CAP)
        .map((t) => ({ name: t.name.trim().slice(0, 80), duration: Math.min(Math.floor(t.duration), 86400) }))
    : [];
  if (!timers.length) { res.status(400).json({ error: "timers must contain at least one timer" }); return; }

  const { count } = await supabase
    .from("session_templates")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) >= MAX_TEMPLATES) {
    res.status(400).json({ error: `Maximum ${MAX_TEMPLATES} templates` }); return;
  }

  const { data, error } = await supabase
    .from("session_templates")
    .insert({
      user_id: user.id,
      name: body.name.trim(),
      session_type: body.session_type === "stopwatch" ? "stopwatch" : "pomodoro",
      timers,
    })
    .select("id, name, session_type, timers, created_at")
    .single();
  if (error) {
    if (error.code === "23505") { res.status(409).json({ error: "A template with that name already exists" }); return; }
    serverError(res, error); return;
  }

  cache.del(`templates:${user.id}`);
  res.status(201).json({ data });
});

/** DELETE /api/templates/:id */
router.delete("/:id", async (req, res) => {
  const { user, supabase } = req;
  const { id } = req.params;

  const { error } = await supabase
    .from("session_templates")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) { serverError(res, error); return; }

  cache.del(`templates:${user.id}`);
  res.json({ data: null });
});

export default router;
