-- Onboarding schema catch-up for production.
-- The API code (personalization + routine reminders) was deployed ahead of the
-- database. Run this in the Supabase SQL editor for the production project.
-- Every statement is idempotent, so it is safe to re-run.

-- 1) Personalization survey answers ------------------------------------------
-- Read/written exclusively by the API's service-role client (see
-- src/routes/profile.ts -> /personalization), so RLS is enabled with no
-- policies, which locks the table to the service role only.
create table if not exists public.user_personalization (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  survey_version          integer     not null default 3,
  focus_category          text,
  focus_goal              text,
  focus_style             text,
  focus_peak              text,
  weekly_target_days      integer,
  preferred_focus_minutes integer,
  focus_obstacle          text,
  motivation_style        text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
-- The `user_id` primary key doubles as the unique constraint the API's
-- upsert relies on: .upsert(payload, { onConflict: "user_id" }).
alter table public.user_personalization enable row level security;

-- 2) Routine reminder columns on notification_preferences --------------------
-- The onboarding "reminders" step (PATCH /api/notifications/preferences) reads
-- and writes these; without them the endpoint 500s.
alter table public.notification_preferences
  add column if not exists routines         boolean     not null default false,
  add column if not exists routine_weekdays integer[]   not null default '{}',
  add column if not exists routine_time     text,
  add column if not exists routine_timezone text,
  add column if not exists created_at       timestamptz not null default now();
