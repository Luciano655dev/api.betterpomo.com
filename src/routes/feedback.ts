import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { serverError } from "../lib/http";
import { cache, TTL } from "../lib/cache";

const router = Router();
router.use(authenticate);

const CATEGORIES = ["idea", "bug", "other"];
const STATUSES = ["open", "planned", "in_progress", "done", "declined"];

/** Admins (can change post status / delete any post). Comma-separated emails. */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "lucianomenezes655@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdmin(email?: string): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

type PostRow = {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  category: string;
  status: string;
  created_at: string;
  author: { username: string | null; emoji: string | null } | null;
  votes: { count: number }[];
};

/**
 * GET /api/feedback?sort=top|new
 * Posts + vote counts are cached (same for everyone); the viewer's own votes
 * and admin flag are computed fresh per request.
 */
router.get("/", async (req, res) => {
  const sort = req.query.sort === "new" ? "new" : "top";
  const user = req.user!;
  const supabase = req.supabase!;

  const key = `feedback:${sort}`;
  let posts = cache.get<ReturnType<typeof flatten>>(key);
  if (!posts) {
    const { data, error } = await supabase
      .from("feedback_posts")
      // Disambiguate the profiles embed with the explicit FK: profiles is
      // reachable both directly (author via user_id) and through the
      // feedback_votes junction, which otherwise makes the embed ambiguous
      // (PostgREST PGRST201) and 500s the whole feedback board.
      .select("*, author:profiles!feedback_posts_user_id_fkey(username, emoji), votes:feedback_votes(count)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) { serverError(res, error); return; }
    posts = flatten(data as PostRow[]);
    if (sort === "top") posts.sort((a, b) => b.vote_count - a.vote_count || +new Date(b.created_at) - +new Date(a.created_at));
    cache.set(key, posts, TTL.FEEDBACK);
  }

  const { data: myVotes, error: votesError } = await supabase
    .from("feedback_votes")
    .select("post_id")
    .eq("user_id", user.id);
  if (votesError) { serverError(res, votesError); return; }
  const voted = new Set((myVotes ?? []).map((v) => v.post_id));

  res.json({
    data: {
      posts: posts.map((p) => ({ ...p, my_vote: voted.has(p.id) })),
      is_admin: isAdmin(user.email),
    },
  });
});

function flatten(rows: PostRow[]) {
  return rows.map(({ votes, ...p }) => ({ ...p, vote_count: votes?.[0]?.count ?? 0 }));
}

/** POST /api/feedback — create a post. Body: { title, body?, category? } */
router.post("/", async (req, res) => {
  const user = req.user!;
  const body = req.body ?? {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const details = typeof body.body === "string" ? body.body.trim() : "";
  const category = CATEGORIES.includes(body.category) ? body.category : "idea";

  if (!title) { res.status(400).json({ error: "Title is required" }); return; }
  if (title.length > 120) { res.status(400).json({ error: "Title must be 120 characters or less" }); return; }
  if (details.length > 2000) { res.status(400).json({ error: "Details must be 2000 characters or less" }); return; }

  const { data, error } = await req.supabase!
    .from("feedback_posts")
    .insert({ user_id: user.id, title, body: details || null, category })
    .select()
    .single();
  if (error) { serverError(res, error); return; }

  cache.delByPrefix("feedback:");
  res.status(201).json({ data });
});

/** POST /api/feedback/:id/vote — upvote. DELETE — remove upvote. */
router.post("/:id/vote", async (req, res) => {
  const { error } = await req.supabase!
    .from("feedback_votes")
    .upsert({ post_id: req.params.id, user_id: req.user!.id }, { ignoreDuplicates: true });
  if (error) { serverError(res, error); return; }
  cache.delByPrefix("feedback:");
  res.json({ data: { ok: true } });
});

router.delete("/:id/vote", async (req, res) => {
  const { error } = await req.supabase!
    .from("feedback_votes")
    .delete()
    .eq("post_id", req.params.id)
    .eq("user_id", req.user!.id);
  if (error) { serverError(res, error); return; }
  cache.delByPrefix("feedback:");
  res.json({ data: { ok: true } });
});

/** PATCH /api/feedback/:id — admin only. Body: { status } */
router.patch("/:id", async (req, res) => {
  if (!isAdmin(req.user!.email)) { res.status(403).json({ error: "Not allowed" }); return; }
  const status = req.body?.status;
  if (!STATUSES.includes(status)) { res.status(400).json({ error: "Invalid status" }); return; }

  const { data, error } = await req.supabase!
    .from("feedback_posts")
    .update({ status })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) { serverError(res, error); return; }

  cache.delByPrefix("feedback:");
  res.json({ data });
});

/** DELETE /api/feedback/:id — author or admin. */
router.delete("/:id", async (req, res) => {
  const user = req.user!;
  const supabase = req.supabase!;

  const { data: post, error: findError } = await supabase
    .from("feedback_posts")
    .select("user_id")
    .eq("id", req.params.id)
    .single();
  if (findError || !post) { res.status(404).json({ error: "Post not found" }); return; }
  if (post.user_id !== user.id && !isAdmin(user.email)) {
    res.status(403).json({ error: "Not allowed" });
    return;
  }

  const { error } = await supabase.from("feedback_posts").delete().eq("id", req.params.id);
  if (error) { serverError(res, error); return; }

  cache.delByPrefix("feedback:");
  res.json({ data: { ok: true } });
});

export default router;
