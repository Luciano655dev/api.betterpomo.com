# Key Rotation

Rotate these before/at launch. The secrets have been sitting in local `.env`
files (not committed — `.env` is gitignored everywhere — but visible on the dev
machine), so treat them as needing rotation. After rotating, update every place
the key is consumed and redeploy.

## 1. Supabase service-role key (highest priority)

Bypasses RLS — full read/write to all data. Server-only; never shipped to a client.

1. Supabase dashboard → Project Settings → API → **rotate** the `service_role` key.
2. Update `SUPABASE_SERVICE_ROLE_KEY` wherever the **API** runs (Render/Fly/Railway
   env, plus your local `betterpomo-api/.env`).
3. Redeploy the API. Verify `/healthz` and a signed-in request both work.

## 2. Resend API key

Sends transactional/wishlist email.

1. Resend dashboard → API Keys → create a new key, delete the old one.
2. Update `RESEND_API_KEY` in the API environment. Redeploy.

## 3. New secret to set: `UNSUBSCRIBE_SECRET`

Previously this fell back to the service-role key; that coupling is removed. Set a
dedicated random value (e.g. `openssl rand -hex 32`) as `UNSUBSCRIBE_SECRET` in
the API environment. If unset, unsubscribe-link signing uses a weak dev default —
so set it in every deployed environment.

## 4. Supabase anon / publishable keys — safe, optional

`SUPABASE_ANON_KEY` (API), `NEXT_PUBLIC_SUPABASE_ANON_KEY` (web/landing), and
`EXPO_PUBLIC_SUPABASE_ANON_KEY` (mobile) are **publishable by design** — they ship
in client bundles and are protected by RLS, not secrecy. No urgency to rotate, but
you can. If you rotate the anon key, update it in: API env, Vercel (web + landing),
and EAS env for the mobile builds — then rebuild the mobile app.

## 5. Google OAuth

OAuth is configured in the Supabase dashboard (Auth → Providers → Google). The
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `betterpomo-webapp/.env.local` are
vestigial (the app doesn't read them) — you can delete those two lines. Rotate the
actual client secret in Google Cloud Console only if you suspect exposure, and
update it in the Supabase provider config (not in app env).

## Where each secret lives

| Secret | Consumed by | Set in |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | API only | API host env |
| `RESEND_API_KEY` | API only | API host env |
| `UNSUBSCRIBE_SECRET` | API only | API host env |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web + landing (client) | Vercel |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | mobile (client) | EAS env / eas.json |
