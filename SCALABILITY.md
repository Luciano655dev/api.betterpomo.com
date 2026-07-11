# Scalability & lifecycle notes

Audit of the API for thousands of concurrent users / sessions / messages, the
race conditions found, and the inactivity-sweep behaviour. Changes already
applied are marked ✅; open recommendations are marked ▶.

## Deploy step (required)

Run **`betterpomo-webapp/supabase/migration_scale_and_inactivity.sql`** in the
Supabase SQL editor. It is idempotent and adds:

- `session_participants.last_seen_at` + supporting index
- hot-path indexes (chat, timers, laps, session browse, history dedup)
- the `cleanup_inactive_participants()` function + a `*/15 * * * *` pg_cron job

Nothing else requires a schema change; the API changes ship with the code.

---

## 1. Inactivity kick (24h) ✅

Sessions are background jobs — a user stays a member until they explicitly
leave. To stop abandoned memberships from lingering forever:

- **Heartbeat.** `session_participants.last_seen_at` is refreshed from the
  client's normal polling — the "my active session" banner poll, the session
  screen's state poll (`GET /:id`), and the on-mount / on-foreground membership
  assert (`PATCH /:id/participants/me`, `left_at: null`). The write is throttled
  server-side to at most once / 5 min per user (`touchLastSeen`) so a 3–15s poll
  cadence doesn't become thousands of writes/sec — 5-min granularity is
  irrelevant against a 24h window.
- **Sweep.** `cleanup_inactive_participants()` (pg_cron, every 15 min) mirrors
  the API's explicit-leave logic for every membership whose `last_seen_at` is
  >24h old: saves history (deduped), sets `left_at`, transfers ownership when the
  owner is the one leaving, then deletes sessions left with zero active members.

Net effect: keep the app open anywhere within 24h → you stay in. Fully
closed/backgrounded for 24h → you're removed and the session is torn down if
you were the last one.

▶ **Interaction with the existing 72h sweep.** `cleanup_stale_sessions()`
(`migration_background_sessions.sql`) deletes any session older than 72h *by
`created_at`, regardless of activity* — so it will also kill a genuinely-active
session that has run for 3 days. With the inactivity sweep now handling
abandonment, consider raising that cap or re-basing it on activity. Left as-is
here to avoid changing existing behaviour without a call.

## 2. Hot-path indexes ✅

Added covering indexes for the queries that run per session-tick / per poll:
`chat_messages(session_id, created_at desc)`, `timers(session_id, "order")`,
`stopwatch_laps(session_id, lap_number)`, `pomodoro_sessions(status,
created_at desc)`, and a **unique** `pomodoro_history(session_id, user_id)`
(also closes the history race in §5).

## 3. Caching ✅ / ▶

- ✅ `GET /api/sessions/active` (public "browse live sessions", polled by every
  search-screen user, identical for everyone) is now cached ~10s. This collapses
  many concurrent polls into one query pair — a big saving at scale.
- ✅ `lib/cache.ts` hardened: a hard entry cap + a periodic sweep of expired
  keys, so a flood of distinct keys (e.g. unique search terms) can't grow the
  map without bound.
- ▶ **The cache is process-local.** Past one API instance, each has its own copy,
  so a mutation's invalidation on one instance doesn't reach the others; reads
  elsewhere stay stale until the (short, 10–60s) TTL lapses. That bounded
  staleness is acceptable for this data. For strict cross-instance consistency,
  back the cache with **Redis** (drop-in behind the same `cache` interface). The
  auth token-verification cache in `middleware/auth.ts` is process-local too —
  harmless (just more `auth.getUser` calls per instance).

## 4. Rate limiting ✅ / ▶

- ✅ Per-user message limiter (`middleware/rateLimit.ts`, 20 msgs / 10s, keyed by
  user id) on session chat and DMs — realtime fans each message out to every
  member, so this caps the amplification a single account can cause.
- ▶ Both the global and per-user limiters use the default **in-memory store**, so
  with N instances the effective ceiling is N× the configured limit. Fine as an
  abuse backstop; for a precise shared quota use a Redis store (`rate-limit-redis`).

## 5. Race conditions

- ✅ **Timer state transitions** are already guarded with conditional updates
  (`start` requires `timer_state='idle'`, `pause` requires `'running'`, …), so
  two admins acting at once can't corrupt state — the loser's update matches 0
  rows. Good as-is.
- ✅ **Per-leave history save** was a check-then-insert (could double-write under
  concurrent leaves). Now backed by the unique index from §2, so the second
  write is a no-op.
- ▶ **"One session at a time"** (`getActiveSessionId` in create/join/accept) is
  check-then-act: a double-submitted create could slip two sessions past the
  check. Low severity (self-inflicted, cleaned up by leave/sweep). A hard guard
  would be a partial unique index `session_participants(user_id) WHERE left_at IS
  NULL` — enforces one active membership at the DB level, but changes join
  semantics and needs existing duplicates cleaned first, so it's left as a
  recommendation.
- ▶ **Lap number / timer `order`** are computed as `max + 1` from a prior read;
  concurrent inserts could collide. Both are single-admin-driven and low-traffic,
  so impact is negligible — add a `unique(session_id, lap_number)` /
  `unique(session_id, "order")` if it ever matters.
- ▶ **Ownership transfer on leave** is multi-step and not transactional; two
  simultaneous leaves can momentarily orphan a session, which the sweep then
  reaps. Eventually consistent; acceptable.

## 6. Other scale notes

- **Supabase connection limits.** `adminDb` is a single service-role client
  (PostgREST over HTTP, not a raw PG pool), so the API isn't holding PG
  connections directly — scaling is bounded by the Supabase project's PostgREST
  capacity. Watch the Supabase dashboard for saturation and size the plan/pooler
  accordingly before a big launch.
- **Realtime fan-out** (timer state, participants, chat) is handled by Supabase
  Realtime, not this API. Keep the number of tables in the `supabase_realtime`
  publication and per-session channel counts in mind; that's the more likely
  ceiling than the Express layer.
- **Chat history growth** is bounded: session `chat_messages` cascade-delete when
  the session is deleted (last-leave or sweep), and DM `dm_messages` have a 24h
  TTL cleanup. No unbounded table growth there.
