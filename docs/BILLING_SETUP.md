# Billing setup & launch checklist

BetterPomo paid plans: **Free / Pro ($4.99/mo · $29.99/yr, 7-day card-required trial) / Lifetime ($69.99 once)**.
Web purchases go through Stripe Checkout; mobile through RevenueCat (App Store / Google Play).
The `profiles` row is the single source of truth — only the webhook handlers in
`src/routes/billing.ts` write plan state.

## 0. Kill switch — the system ships DISABLED

The entire paid-plans system sits behind a flag and is **off by default**. While off:
every gate passes with the legacy limits (`LEGACY_UNLOCKED` in `src/lib/plans.ts` —
10 timers, 10 participants via the old 2-arg RPCs, everything else unrestricted, no
badges, templates hidden), no plan columns are read (the API runs fine before the
migration), billing routes answer 503, the trial sweep never runs, and no pricing or
billing UI renders anywhere.

To activate, set ALL of these and redeploy/rebuild:

| Where | Env var |
|---|---|
| betterpomo-api | `BILLING_ENABLED=true` (also unlocks the REQUIRED_ENV check for the Stripe vars) |
| betterpomo-webapp | `NEXT_PUBLIC_BILLING_ENABLED=true` |
| betterpomo-landing | `NEXT_PUBLIC_BILLING_ENABLED=true` |
| betterpomo-mobile | `EXPO_PUBLIC_BILLING_ENABLED=true` (new build required) |

Steps 1–4 below (migration, Stripe, RevenueCat, env vars) must be completed **before**
flipping the API flag — the migration especially, since the enabled code path selects
the new columns and calls the 3-arg join RPCs.

## 1. Database (once, before deploying the API)

Run `betterpomo-webapp/supabase/migration_billing.sql` in the Supabase SQL editor. It adds:
- billing columns on `profiles` (`plan`, `plan_status`, `plan_provider`, trial fields, Stripe/RC ids)
- `billing_events` (webhook audit + idempotency) and `session_templates` (Pro feature)
- `p_max_participants` parameter on `join_pomo_session` / `accept_session_invite`
  (per-plan cap passed by the API; SQL keeps 25 as the hard ceiling)

Verify: `select plan, plan_status from profiles limit 3;` → `free / none`.

## 2. Stripe dashboard

1. Products/prices (test mode first):
   - **BetterPomo Pro** — $4.99/month and $29.99/year recurring prices
   - **BetterPomo Lifetime** — $69.99 one-time price
2. Customer Portal (Settings → Billing → Customer portal): enable cancel at period end
   and payment-method update. Plan switching can stay off for v1.
3. Webhook endpoint (live): `https://<api-host>/api/billing/webhook` with events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.

## 3. RevenueCat + stores

1. App Store Connect / Play Console products:
   - `pro_monthly`, `pro_yearly` auto-renewing subscriptions, each with a **7-day free
     introductory offer** (this is what delivers the card-required trial on mobile)
   - `lifetime` non-consumable
2. RevenueCat project: entitlement `pro` mapped to all three products; a default
   Offering containing monthly/annual/lifetime packages.
3. RevenueCat webhook: `https://<api-host>/api/billing/revenuecat`, Authorization header
   set to the same value as the API's `REVENUECAT_WEBHOOK_AUTH`.
4. The mobile app configures `Purchases` with `appUserID = Supabase user id`
   (`src/providers/AuthProvider.tsx`) — do not change this, the webhook relies on it.

## 4. API env vars

Required in production (`REQUIRED_ENV` enforces on boot):

```
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_PRO_MONTHLY=price_…
STRIPE_PRICE_PRO_YEARLY=price_…
STRIPE_PRICE_LIFETIME=price_…
WEBAPP_URL=https://app.betterpomo.com
REVENUECAT_WEBHOOK_AUTH=<long random secret>
```

In dev these are optional — billing routes answer 503 until configured.

Mobile env (EAS build profiles): `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`.
RevenueCat's native module requires a dev/EAS build (not Expo Go); the app degrades
gracefully without it.

## 5. Local verification

```bash
# 1. Webhook forwarding (copy the whsec_ into .env)
stripe listen --forward-to localhost:4000/api/billing/webhook

# 2. Checkout round-trip: POST /api/billing/checkout { plan: "pro_monthly" },
#    pay with 4242 4242 4242 4242 → profile flips to trialing, billing_events row created.

# 3. Lifecycle events
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
# Re-deliver an event id twice → second delivery is a no-op (billing_events unique).
```

Gates (free test account — set `plan='free', plan_status='none'` in SQL):
- private session create → 403 `{ error: "upgrade_required", feature: "private_sessions" }`
- 7th timer → 403 `custom_timers` (free cap 6; hard cap 10)
- 6th joiner into a free-owned session → 409 `session_full`
- 4-person group chat → 403 `group_chat_size`
- `GET /api/history` only returns 30 days; `GET /api/history/summary` reports `locked_count`
- `GET /api/templates` → 403 `templates`

Trial reminder: set a trialing user's `trial_ends_at = now() + interval '36 hours'`,
restart the API (sweep runs 30s after boot, then hourly) → Resend email +
`trial_ending` notification + `trial_reminder_sent = true`; second sweep sends nothing.

## 6. Semantics worth remembering

- **Entitlements** come from `src/lib/plans.ts` (`getEntitlements`) — pro when
  `plan='lifetime'`, or `plan='pro'` with status `active`/`trialing`, or `past_due`
  within the period-end grace window. Route gates call `getUserEntitlements(userId)`
  (cached `plan:{userId}`).
- **Participant cap follows the session owner's plan** (joiners get 409, not a paywall).
- **Free history is windowed, never deleted** — older rows stay in `pomodoro_history`
  and unlock instantly on upgrade.
- **Cross-provider guard**: RC expirations never downgrade a Stripe subscriber and
  vice-versa; nothing ever downgrades `lifetime`. A lifetime purchase auto-cancels a
  running Stripe subscription.
- **One trial per account** (`trial_used`, set by the first subscription with a trial).
- Every plan write goes through `applyPlanChange()` (billing.ts) so cache invalidation
  (`profile:`, `plan:`, `billing:`, history + public-profile keys) can't be missed.
