# App Store & Play Submission Checklist

Covers the BetterPomo Expo app (`betterpomo-mobile`). What the code changes
already handle is marked ✅; what still needs you (accounts, assets, config) is
marked ▢.

## Build configuration (done in code)

- ✅ `eas.json` created with `development` / `preview` / `production` profiles.
- ✅ `app.json`: iOS `buildNumber`, Android `versionCode`, iOS Privacy Manifest
  (`NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1` for the
  SecureStore/AsyncStorage keychain use).
- ✅ Localhost API fallback removed for release builds — a build without
  `EXPO_PUBLIC_API_URL` fails fast instead of shipping a broken app.
- ✅ Auth session stored in the device keychain (expo-secure-store), not plaintext.
- ✅ In-app **account deletion** (Settings → Delete account) — required by Apple
  Guideline 5.1.1(v) and Google's data-deletion policy.
- ✅ **Sign in with Apple** (Guideline 4.8 — mandatory because the app offers
  Google login): native `expo-apple-authentication` button on the iOS login
  screen (Apple's own button component, listed first per HIG), exchanging the
  identity token via `supabase.auth.signInWithIdToken`. `usesAppleSignIn: true`
  in app.json adds the entitlement.
- ✅ `expo-asset` peer dependency installed (was missing — release builds could
  crash); all package versions aligned; `npx expo-doctor` passes 20/20.
- ✅ Paid plans are DORMANT (`EXPO_PUBLIC_BILLING_ENABLED` unset): no purchase
  UI, no subscription mentions, no "buy on the web" text is reachable — so no
  IAP setup is needed for this submission and there is no Guideline 3.1.1
  exposure. `react-native-purchases` is compiled in but never configured, which
  is fine. When payments launch later, revisit `docs/BILLING_SETUP.md`.

## Sign in with Apple — provider config (you must set) ▢

- ▢ Apple Developer portal: the `com.betterpomo.app` App ID needs the
  **Sign In with Apple** capability enabled (EAS usually prompts/handles this
  when it manages your credentials — verify on the first production build).
- ▢ Supabase Dashboard → Authentication → Providers → Apple: enable it and add
  `com.betterpomo.app` to **Authorized Client IDs** (the native id_token flow
  needs no secret for this; the secret/Services ID are only for web OAuth).
- ▢ Post-deletion token revocation: Apple expects Sign in with Apple tokens to
  be revoked when an account is deleted. Supabase's user deletion does not call
  Apple's revoke endpoint. Low review risk at launch, but plan to add a revoke
  call (Apple `auth/revoke` with a generated client secret) to the account
  deletion flow.

## EAS environment variables (you must set) ▢

`.env` is gitignored, so EAS builds won't see it. Set these per build profile
(EAS dashboard → project → Environment variables, or extend the `env` block in
`eas.json`):

- `EXPO_PUBLIC_API_URL` — already in `eas.json` as `https://api.betterpomo.com`
  for preview/production. Change if your API domain differs.
- `EXPO_PUBLIC_SUPABASE_URL` — **not yet set in eas.json**; add it.
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — **not yet set in eas.json**; add it (use the
  post-rotation publishable key from KEY_ROTATION.md).

Verify a `preview` build actually reaches production Supabase + API before doing a
store build:
```
eas build --profile preview --platform ios
```
Install it, sign in, complete a session, and delete a throwaway account end-to-end.

## Store assets ▢

- ▢ App icon 1024×1024 (present at `assets/images/icon.png` — confirm no alpha for iOS).
- ▢ Screenshots for required device sizes (6.7" iPhone, 5.5" iPhone, iPad if
  applicable; Android phone + 7"/10" tablet).
- ▢ App Store Connect + Google Play Console app records (bundle id / package
  `com.betterpomo.app`, already set in `app.json`).

## Launch blockers in the production database ▢

Two shipped features are broken in prod until their SQL is applied (App Review
tests real functionality — a 500 on a visible feature risks a 2.1 "app
completeness" rejection):

- ▢ **Stopwatch laps 500s** — `stopwatch_laps` table missing. Run
  `betterpomo-webapp/supabase/migration_stopwatch_laps.sql` in the SQL editor.
- ▢ **Landing waitlist form errors** — `wishlist` table missing. Run
  `betterpomo-webapp/supabase/wishlist.sql`.
- ▢ (Recommended) offline-history dedup index — run
  `betterpomo-webapp/supabase/migration_history_idempotency.sql` so offline
  session uploads can't duplicate under retries.

## App privacy questionnaire ▢

- **Data collected:** email + username (account), session/focus history.
  The **mobile apps contain no analytics SDK** (PostHog runs only on the web
  app), so the iOS privacy label / Play data safety form should NOT declare
  in-app analytics. Nothing is used for third-party advertising or tracking.
- **Account deletion URL / method:** point to the in-app flow (Settings → Delete
  account). Apple accepts the in-app path. Google Play's Data safety form
  additionally requires a **web link** for deletion requests — use
  `https://betterpomo.com/privacy` (its "Data retention and deletion" section
  now documents both the self-serve Settings path and the email fallback).
- **Privacy policy URL:** `https://betterpomo.com/privacy` (live on the landing
  site). Terms: `https://betterpomo.com/terms`.
- **Tracking:** the app does not use ATT/IDFA. Do not add an
  `NSUserTrackingUsageDescription` unless you add tracking.

## Permissions sanity ▢

The app uses local timer notifications and APNs-backed Expo push notifications.
Before building for TestFlight:

- EAS is linked to `@luciano655/betterpomo`; keep project ID `3acf0f8d-eb85-41bf-bc1f-3aa5ba897935` in `app.json`.
- In Apple Developer → Identifiers → `com.betterpomo.app`, enable **Push Notifications**.
- Run `eas credentials --platform ios`, configure a new Apple Push Notifications key, and regenerate the provisioning profile.
- Enable push access-token security in Expo and set `EXPO_ACCESS_TOKEN` on the production API only.
- Apply `betterpomo-webapp/supabase/migration_push_notifications.sql` before deploying the push-enabled API.

Notification permission does not need an iOS usage-description string. Do not
add camera or microphone permissions unless those features are actually added.

## Pre-submit smoke test ▢

- Fresh install → register → onboarding → create session → run a timer → leave →
  see recap in history.
- Sign out, sign back in (confirms SecureStore session round-trips).
- Airplane mode → complete an offline solo session → reconnect → history syncs
  once (no duplicate).
- Settings → Delete account → confirm the account and its data are gone.
