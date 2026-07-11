# betterpomo-api

Express 4 + TypeScript REST API. Runs on port 4000.

```
src/
├── index.ts              — app bootstrap; register routers here
├── middleware/auth.ts    — authenticate middleware
├── lib/
│   ├── cache.ts          — in-memory TTL cache + TTL constants
│   ├── supabase.ts       — adminDb (service-role) + createAuthClient
│   ├── plans.ts          — paid-plan entitlements (single source of truth)
│   ├── stripe.ts         — Stripe client + price↔plan mapping
│   ├── trialReminders.ts — day-5 trial reminder sweep
│   └── utils.ts          — generateSessionCode
└── routes/
    ├── sessions.ts       — /api/sessions  (largest file)
    ├── history.ts        — /api/history
    ├── profile.ts        — /api/profile
    ├── users.ts          — /api/users
    ├── billing.ts        — /api/billing (Stripe + RevenueCat webhooks)
    └── templates.ts      — /api/templates (Pro session templates)
```

## Dev

```bash
npm run dev      # tsx watch — hot reload
npm run build    # tsc → dist/
npm start        # node dist/index.js
```

## Auth middleware

Every route uses `authenticate` from `../middleware/auth`. It:
1. Reads `Authorization: Bearer <token>`
2. Verifies it with an anon Supabase client (`auth.getUser`)
3. Attaches `req.user`, `req.token`, and `req.supabase` (the service-role client)

`req.supabase` is `adminDb` — it **bypasses RLS entirely**. Authorization is the route handler's responsibility (check `user.id`, roles, ownership).

Never create a per-request Supabase client in route handlers. Use `req.supabase`.

## Cache pattern

```typescript
import { cache, TTL } from "../lib/cache";

// Read
const hit = cache.get<MyType>(key);
if (hit) { res.json({ data: hit }); return; }

// Miss → query → cache → respond
const { data, error } = await supabase.from(...).select(...);
if (error) { res.status(500).json({ error: error.message }); return; }
cache.set(key, data, TTL.HISTORY);
res.json({ data });

// Mutation — invalidate before or after writing
cache.delByPrefix(`history:${user.id}:`);
```

Cache keys and TTLs:

| Key pattern | TTL constant | Endpoint |
|---|---|---|
| `profile:{userId}` | `TTL.PROFILE` (60 s) | GET /api/profile |
| `user:{username}` | `TTL.USER` (60 s) | GET /api/users/:username |
| `user-hist:{userId}:{own\|pub}` | `TTL.USER_HISTORY` (60 s) | GET /api/users/:username/history |
| `search:{q}:{page}:{limit}` | `TTL.SEARCH` (30 s) | GET /api/users/search |
| `history:{userId}:{limit}:{offset}` | `TTL.HISTORY` (30 s) | GET /api/history |
| `timers:{sessionId}` | `TTL.TIMERS` (30 s) | GET /api/sessions/:id/timers |
| `friends:{userId}:{limit}:{offset}` | `TTL.FRIENDS` (30 s) | GET /api/friends |
| `friend-count:{userId}` | `TTL.FRIENDS` (30 s) | GET /api/friends |
| `friend-reqs:{userId}` | `TTL.FRIEND_REQUESTS` (15 s) | GET /api/friends/requests |
| `user-friends:{userId}:{own\|pub}` | `TTL.FRIENDS` (30 s) | GET /api/users/:username/friends |
| `conversations:{userId}` | `TTL.CONVERSATIONS` (10 s) | GET /api/chat/conversations |
| `notif:{userId}` | `TTL.NOTIFICATIONS` (10 s) | GET /api/notifications (first page only) |
| `plan:{userId}` | `TTL.PLAN` (60 s) | entitlement gates (`getUserEntitlements` in lib/plans.ts) |
| `billing:{userId}` | `TTL.BILLING` (30 s) | GET /api/billing |
| `templates:{userId}` | `TTL.TEMPLATES` (60 s) | GET /api/templates |
| `history-summary:{userId}` | `TTL.HISTORY` (30 s) | GET /api/history/summary |

Real-time endpoints (active session state, participants, messages; chat messages) and viewer-specific
`GET /api/friends/status/:username` are **never cached**.

## Paid plans (Free / Pro / Lifetime)

**Dormant behind `BILLING_ENABLED=true` (default off).** While off, `getEntitlements`/
`getUserEntitlements` short-circuit to `LEGACY_UNLOCKED` (pre-billing behavior), no plan
columns are selected anywhere (safe before `migration_billing.sql`), the join RPCs are
called with their legacy 2-arg signature, billing routes 503, and the trial sweep is inert.

`src/lib/plans.ts` is the single source of truth for limits; route gates call
`getUserEntitlements(userId)` and reject with `upgradeRequired(res, feature)` →
`403 { error: "upgrade_required", feature, plan_needed: "pro" }` (frontends key their
paywalls off this shape). Plan state lives on `profiles` and is written ONLY by the
webhook handlers in `routes/billing.ts` via `applyPlanChange()` (which owns the cache
invalidation: `profile:`, `plan:`, `billing:`, `history:{id}:*`, `history-summary:`,
`user:*`, `user-hist:*`). The Stripe webhook is mounted with `express.raw()` BEFORE
`express.json()` in `src/index.ts` — moving it below breaks signature verification.
Participant caps follow the session **owner's** plan and are re-checked atomically in
SQL (`p_max_participants` on `join_pomo_session` / `accept_session_invite`; joiners get
`409 session_full`, not a paywall). Free history is windowed (30 days), never deleted.
See `docs/BILLING_SETUP.md` for dashboard setup + verification.

`routes/notifications.ts` + `lib/notify.ts` own the notifications feed. Events are emitted server-side
by calling `notify(recipientId, { actorId, type, entityId, metadata })` from the originating handler
(`friends.ts`: friend_request / friend_accept; `chat.ts`: session_invite / group_add) — best-effort,
never blocks the primary action, and skips self-notifications. One row per recipient (no fan-out);
`metadata` carries a denormalized snapshot (actor username/emoji, session name/code, group title) so
the list query needs no joins. The `notifications` table has an RLS read policy + is in
`supabase_realtime`, so the recipient's browser gets live `postgres_changes` (the bell). `pg_cron`
runs `cleanup_old_notifications`.

`routes/chat.ts` owns temporary DMs/groups + session invites. Messages live in `dm_messages` with an
`expires_at` TTL (default `CHAT_TTL_SECONDS` = 24h); a `pg_cron` job (`cleanup_expired_chat`) deletes
expired rows, and read functions already exclude them. `dm_messages` is in the `supabase_realtime`
publication and has an RLS read policy so the browser client's `postgres_changes` subscription
delivers live — this RLS is **required** (unlike other tables where the service-role API write is
enough). All logic lives in `SECURITY DEFINER` functions in `supabase/chat.sql`. Every chat mutation
invalidates `conversations:{id}` for **all** affected members. `accept_session_invite` (called from
`POST /api/sessions/:id/accept-invite` via a user-scoped client) lets an invited friend join a
session bypassing privacy/password, respecting the 10-participant cap.

`routes/friends.ts` owns the social graph. All friendship logic lives in `SECURITY DEFINER`
SQL functions (`supabase/friends.sql`) called with the authenticated user id as a parameter
via `req.supabase` (service role) — same pattern as `get_user_active_session`. Every mutation
invalidates the friend caches for **both** affected users.

## Response shape

All responses use `{ data: ... }` or `{ error: "..." }`. The frontend `api` client unwraps `data` automatically, so never nest it.

```typescript
res.json({ data });           // success
res.status(400).json({ error: "Bad request" });  // error
```

## Adding a route

1. Add the handler in the relevant `src/routes/*.ts` file.
2. If it's a new resource, create a new router file and register it in `src/index.ts`.
3. **Specific paths before generic ones** — `/by-code/:code` must come before `/:id` or Express will capture it wrong.
4. Add cache logic per the table above; mutations must invalidate.
5. See root `CLAUDE.md` for the full cache invalidation rules per mutation type.

## Supabase RPCs used

- `create_pomo_session()` — creates session + default timers + adds caller as owner
- `join_pomo_session(p_session_id, p_user_id)` — upserts participant (clears left_at on rejoin)
- `get_user_active_session(p_user_id)` — returns active session name for a user

## Sessions route specifics

`sessions.ts` is large. Key sections by line range (approximate):

| Section | What it does |
|---|---|
| GET / | List own sessions (waiting/active only) |
| GET /active | Public active sessions browse |
| POST / | Create session via `create_pomo_session` RPC |
| POST /join | Join by code; bcrypt password check |
| GET /:id | Fetch single session |
| PATCH /:id | Update session fields or `{ action: "end" }` |
| GET /:id/timers | Fetch timer definitions |
| POST/PATCH/DELETE /:id/timers | CRUD timers; invalidates `timers:{id}` |
| GET /:id/participants | List participants |
| PATCH /:id/participants/me | Leave / re-join (set left_at); deletes session when last person leaves and saves history as safety net |
| PATCH /:id/participants/:pid | Kick or change role |
| GET /:id/messages | Chat history |
| POST /:id/messages | Post chat message |
| POST /:id/laps | Record stopwatch lap |
| GET /:id/laps | Fetch laps |
