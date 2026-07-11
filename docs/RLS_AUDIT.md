# Supabase RLS Audit

Why this matters: the **Express API uses the service-role client and bypasses
RLS** — authorization for API routes lives in the route handlers (now enforced;
see `routes/sessions.ts` guards). But the **browser and mobile clients** subscribe
to Supabase Realtime directly using the anon key + the user's JWT, and those
subscriptions are governed **only by RLS**. If an RLS read policy is missing or too
broad, a client could subscribe to another user's data. These policies can't be
tested from the API code — verify them in the Supabase dashboard.

## Tables that MUST have a restrictive RLS read policy

Realtime `postgres_changes` subscriptions exist for these (see webapp
`components/**` and mobile `src/**`). Confirm RLS is **enabled** and the SELECT
policy restricts rows to the requesting user.

| Table | Subscribed by | Read policy must limit to |
|---|---|---|
| `notifications` | NotificationBell / NotificationRealtime | `user_id = auth.uid()` (recipient only) |
| `dm_messages` | chat threads | members of the conversation only |
| `chat_messages` | session chat panel | participants of that session only |
| `session_participants` | session participant list | participants of that session |
| `pomodoro_sessions` | session realtime | participants (or public browse fields only) |
| `timers` / `stopwatch_laps` | session realtime | participants of that session |

The chat and friends logic already ships as `SECURITY DEFINER` functions
(`supabase/chat.sql`, `supabase/friends.sql`) — those are fine. The concern is the
**direct table subscriptions** above.

## How to verify each policy

In the Supabase dashboard → Authentication → Policies, for each table confirm:
1. **RLS is enabled** (toggle on the table).
2. There is a `SELECT` (or `ALL`) policy whose `USING` expression references
   `auth.uid()` and constrains rows to the caller.
3. There is no broad `USING (true)` SELECT policy that would expose all rows.

## Negative test (do this once)

With two test accounts A and B:
1. Sign in as B in a browser devtools console with the anon client.
2. Subscribe to A's data, e.g.
   ```js
   supabase.channel("probe")
     .on("postgres_changes",
       { event: "*", schema: "public", table: "notifications",
         filter: `user_id=eq.<A_USER_ID>` },
       (p) => console.log("LEAK", p))
     .subscribe();
   ```
3. As A, trigger a notification (send B… no — send A a friend request from a third
   account, or any action that inserts an A-owned row).
4. **Expected:** B receives nothing. If B logs `LEAK`, the RLS policy on that table
   is missing or too permissive — fix before launch.

Repeat for `dm_messages` and `chat_messages` (subscribe to a conversation/session
the probing user is not a member of).

## Account-deletion cascade check (one-time)

The API's `DELETE /api/profile` relies on FK `ON DELETE CASCADE` from
`public.profiles` (and `profiles → auth.users`). The schema defines these, but
confirm in your environment that deleting a test user removes their `profiles`,
`pomodoro_history`, `session_participants`, `friendships`, `conversation_members`,
`dm_messages`, `notifications`, and `feedback_*` rows. Create a throwaway account,
delete it in-app, and confirm no orphaned rows remain.
