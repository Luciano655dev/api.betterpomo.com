# ⚙️ BetterPomo API

The REST backend for [BetterPomo](https://github.com/luciano655dev) — a shared,
real-time Pomodoro timer. This Express service is the **single source of truth**:
the [web app](../betterpomo-webapp) and [mobile app](../betterpomo-mobile) read and
write **all** data through it. Neither client queries the database directly.

Built by [Luciano Menezes](https://github.com/luciano655dev).

---

## Responsibilities

- Owns every data read and write — sessions, timers, history, friends, chat,
  notifications, profiles, billing, and feedback.
- Verifies Supabase JWTs and enforces authorization per route (the service-role
  client bypasses Row-Level Security, so ownership is checked in code).
- Server-side in-memory caching with per-endpoint TTLs, invalidated on mutation.
- Emits notifications, handles Stripe & RevenueCat billing webhooks, and applies
  entitlement gates for paid plans.
- Generates signup, resend, and recovery tokens through Supabase Admin, then
  delivers them through Resend with development code logging and provider-level
  delivery errors. A signed hook covers any Auth mail triggered outside the API.

---

## Tech stack

| Concern | Technology |
|---|---|
| Runtime | Node.js 18+ · TypeScript |
| Framework | Express 4 |
| Database & Auth | Supabase (`@supabase/supabase-js`, service-role) |
| Security | Helmet, CORS, `express-rate-limit` (+ Redis via `ioredis` for distributed limits) |
| Passwords | `bcryptjs` (session password hashing) |
| Billing | Stripe (web) · RevenueCat (mobile) |
| Dev | `tsx watch` |

---

## Getting started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (shared with the web & mobile clients)

### 1. Install

```bash
npm install
```

### 2. Environment

Create a `.env` file (see `.env.example`):

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
WEB_URL=http://localhost:3000
RESEND_API_KEY=your-resend-key
RESEND_FROM_EMAIL=no-reply@auth.betterpomo.com
AUTH_FROM_EMAIL=no-reply@auth.betterpomo.com
SAFETY_NOTIFY_EMAIL=you@example.com
SAFETY_FROM_EMAIL="BetterPomo Safety <safety@your-verified-domain.com>"
# Optional for Supabase-triggered Auth emails outside API registration/recovery:
SEND_EMAIL_HOOK_SECRET=v1,whsec_your-supabase-hook-secret
# Optional: REDIS_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BILLING_ENABLED=false
```

See [`docs/AUTH_EMAIL_SETUP.md`](docs/AUTH_EMAIL_SETUP.md) for the one-time
Supabase Send Email hook setup and safe OTP logging controls.

### 3. Database

The SQL migrations live in [`../betterpomo-webapp/supabase`](../betterpomo-webapp/supabase).
Run `migration_apply_all.sql` in the Supabase SQL editor once to create all tables,
policies, and RPCs.

### 4. Run

```bash
npm run dev     # tsx watch — hot reload on :4000
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

---

## API surface

All routes require an `Authorization: Bearer <supabase-jwt>` header unless
explicitly public (Auth, Stripe/RevenueCat webhooks, wishlist, contact, and
status). Responses are wrapped as
`{ data }` or `{ error }`.

| Router | Base path | Purpose |
|---|---|---|
| `sessions` | `/api/sessions` | Create/join sessions, timers, participants, chat, laps |
| `history` | `/api/history` | Session history, summary, CSV export |
| `profile` | `/api/profile` | Own profile, password/email changes, account deletion |
| `users` | `/api/users` | Public profiles, search, public history & friends |
| `friends` | `/api/friends` | Friend requests, accept/decline, unfriend |
| `chat` | `/api/chat` | Direct messages, group chats, session invites |
| `notifications` | `/api/notifications` | Notification feed + read state |
| `billing` | `/api/billing` | Plan status + Stripe/RevenueCat webhooks |
| `templates` | `/api/templates` | Saved session timer templates (Pro) |
| `feedback` | `/api/feedback` | Public feedback board + voting |
| `wishlist` | `/api/wishlist` | Public waitlist signup |
| `auth` | `/api/auth` | Registration, login, verification, recovery, and signed email hook |

---

## Project structure

```
src/
  index.ts              app bootstrap; routers registered here
  middleware/auth.ts    Bearer-token authentication
  lib/
    cache.ts            in-memory TTL cache + TTL constants
    supabase.ts         service-role + anon clients
    plans.ts            paid-plan entitlements (single source of truth)
    notify.ts           server-side notification emitter
  routes/               one file per resource
```

---

## License

Licensed under the **BetterPomo Non-Commercial License** — see [LICENSE](./LICENSE).
Free to read, learn from, and modify **with credit**; **no commercial use**.
Contact [Luciano Menezes](https://github.com/luciano655dev) for a commercial license.
